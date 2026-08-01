import { AwsClient } from "aws4fetch";

import type { BlobBody, BlobStorage } from "./storage";

const LIST_BATCH_SIZE = 1000;

export interface S3BlobStorageConfig {
	/** Base endpoint, e.g. `http://minio:9000` or an R2 account endpoint. */
	endpoint: string;
	bucket: string;
	/** SigV4 region. S3-compatible servers that don't care (R2, most MinIO setups) accept "auto". */
	region?: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Retries on 5xx/429 before giving up. aws4fetch defaults to 10 with exponential backoff, which is a long time to hang a live request; default here is lower. */
	retries?: number;
}

/**
 * Path-style S3-compatible blob storage (works against R2, MinIO, or AWS S3
 * itself) for self-hosted deployments that want object storage instead of a
 * local disk. Path-style (`endpoint/bucket/key`) rather than virtual-hosted
 * style, since self-hosted S3-compatible servers usually don't have wildcard
 * DNS/TLS set up for `bucket.endpoint`.
 */
export class S3BlobStorage implements BlobStorage {
	private readonly client: AwsClient;
	private readonly baseUrl: string;

	constructor(config: S3BlobStorageConfig) {
		this.client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			service: "s3",
			region: config.region ?? "auto",
			retries: config.retries ?? 2,
		});
		this.baseUrl = `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}`;
	}

	async upload(key: string, body: BlobBody): Promise<{ size: number }> {
		// Buffered rather than streamed: SigV4 signs a content hash, and a
		// static buffer lets aws4fetch sign normally instead of falling back
		// to unsigned-payload streaming. Blob sizes here are vault notes/
		// attachments, not multi-GB media, so buffering is an acceptable
		// tradeoff for a self-hosted backend.
		const buffer = await new Response(body).arrayBuffer();
		const response = await this.client.fetch(this.objectUrl(key), {
			method: "PUT",
			body: buffer,
		});
		if (!response.ok) {
			throw new Error(
				`s3 blob upload failed for ${key}: ${response.status} ${await response.text()}`,
			);
		}
		return { size: buffer.byteLength };
	}

	async download(key: string): Promise<ReadableStream | null> {
		const response = await this.client.fetch(this.objectUrl(key));
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			throw new Error(`s3 blob download failed for ${key}: ${response.status}`);
		}
		return response.body;
	}

	async delete(key: string): Promise<void> {
		const response = await this.client.fetch(this.objectUrl(key), { method: "DELETE" });
		if (!response.ok && response.status !== 404) {
			throw new Error(`s3 blob delete failed for ${key}: ${response.status}`);
		}
	}

	async deleteByPrefix(prefix: string): Promise<void> {
		let continuationToken: string | undefined;

		do {
			const { keys, nextContinuationToken } = await this.listObjects(prefix, continuationToken);
			if (keys.length > 0) {
				await this.deleteObjects(keys);
			}
			continuationToken = nextContinuationToken;
		} while (continuationToken);
	}

	async exists(key: string): Promise<boolean> {
		const response = await this.client.fetch(this.objectUrl(key), { method: "HEAD" });
		if (response.status === 404) {
			return false;
		}
		if (!response.ok) {
			throw new Error(`s3 blob exists check failed for ${key}: ${response.status}`);
		}
		return true;
	}

	private objectUrl(key: string): string {
		// Reject ".." segments outright: `encodeURIComponent("..")` is `".."`
		// (dots are unreserved), so a key like "vault-1/../vault-2/blob"
		// reaches `new URL()` below with the traversal intact, and the WHATWG
		// URL parser collapses it - `vault-1/../vault-2/blob` resolves to
		// `vault-2/blob`, escaping vault-1's prefix (and, with enough "..", the
		// bucket itself). Same class of bug `LocalDiskBlobStorage` already
		// guards against; S3-compatible keys need the same guard since the URL
		// parser (not a filesystem) is what's doing the collapsing here.
		const segments = key.split("/");
		if (segments.includes("..") || segments.includes(".")) {
			throw new Error(`blob key must not contain "." or ".." segments: ${key}`);
		}
		const encodedKey = segments.map((segment) => encodeURIComponent(segment)).join("/");
		return `${this.baseUrl}/${encodedKey}`;
	}

	private async listObjects(
		prefix: string,
		continuationToken?: string,
	): Promise<{ keys: string[]; nextContinuationToken?: string }> {
		const url = new URL(this.baseUrl + "/");
		url.searchParams.set("list-type", "2");
		url.searchParams.set("prefix", prefix);
		url.searchParams.set("max-keys", String(LIST_BATCH_SIZE));
		if (continuationToken) {
			url.searchParams.set("continuation-token", continuationToken);
		}

		const response = await this.client.fetch(url.toString());
		if (!response.ok) {
			throw new Error(`s3 list-objects failed for prefix ${prefix}: ${response.status}`);
		}
		const xml = await response.text();
		const keys = [...xml.matchAll(/<Key>(.*?)<\/Key>/gs)].map((match) =>
			decodeXmlEntities(match[1]),
		);
		const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
		const tokenMatch = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/s);
		return {
			keys,
			nextContinuationToken: isTruncated ? tokenMatch?.[1] : undefined,
		};
	}

	private async deleteObjects(keys: string[]): Promise<void> {
		const body = `<?xml version="1.0" encoding="UTF-8"?><Delete>${keys
			.map((key) => `<Object><Key>${encodeXmlEntities(key)}</Key></Object>`)
			.join("")}</Delete>`;
		const url = new URL(this.baseUrl + "/");
		url.searchParams.set("delete", "");

		const response = await this.client.fetch(url.toString(), {
			method: "POST",
			body,
			headers: { "content-type": "application/xml" },
		});
		if (!response.ok) {
			throw new Error(`s3 batch delete failed: ${response.status} ${await response.text()}`);
		}
	}
}

function encodeXmlEntities(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function decodeXmlEntities(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}
