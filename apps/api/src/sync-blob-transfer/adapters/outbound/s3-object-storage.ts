import { createHash } from "node:crypto";

import { AwsClient } from "aws4fetch";

import type { BlobObjectStorage } from "../../application/ports/outbound/blob-object-storage";
import { limitBodySize } from "./body-size";

const LIST_BATCH_SIZE = 1000;

export interface S3BlobObjectStorageConfig {
	endpoint: string;
	bucket: string;
	region?: string;
	accessKeyId: string;
	secretAccessKey: string;
	retries?: number;
}

export class S3BlobObjectStorage implements BlobObjectStorage {
	private readonly client: AwsClient;
	private readonly baseUrl: string;

	constructor(config: S3BlobObjectStorageConfig) {
		this.client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			service: "s3",
			region: config.region ?? "auto",
			retries: config.retries ?? 2,
		});
		this.baseUrl = `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}`;
	}

	async upload(
		key: string,
		body: ReadableStream<Uint8Array>,
		declaredSizeBytes: number,
	): Promise<{ size: number; sizeMismatch: boolean }> {
		const limited = limitBodySize(body, declaredSizeBytes);
		let buffer: ArrayBuffer;
		let readError: unknown;
		try {
			buffer = await new Response(limited.readable).arrayBuffer();
		} catch (error) {
			readError = error;
			buffer = new ArrayBuffer(0);
		}
		const sizeMismatch = await limited.sizeMismatch;
		if (sizeMismatch) {
			return { size: buffer.byteLength, sizeMismatch: true };
		}
		if (readError) {
			throw readError;
		}
		const response = await this.client.fetch(this.objectUrl(key), {
			method: "PUT",
			body: buffer,
		});
		if (!response.ok) {
			throw new Error(
				`s3 blob upload failed for ${key}: ${response.status} ${await response.text()}`,
			);
		}
		return { size: buffer.byteLength, sizeMismatch: sizeMismatch || buffer.byteLength !== declaredSizeBytes };
	}

	async download(key: string): Promise<ReadableStream<Uint8Array> | null> {
		const response = await this.client.fetch(this.objectUrl(key));
		if (response.status === 404) {
			return null;
		}
		if (!response.ok) {
			throw new Error(`s3 blob download failed for ${key}: ${response.status}`);
		}
		return response.body as ReadableStream<Uint8Array> | null;
	}

	async delete(key: string): Promise<void> {
		const response = await this.client.fetch(this.objectUrl(key), { method: "DELETE" });
		if (!response.ok && response.status !== 404) {
			throw new Error(`s3 blob delete failed for ${key}: ${response.status}`);
		}
	}

	async deleteMany(keys: readonly string[]): Promise<{ failedKeys: readonly string[] }> {
		const failedKeys: string[] = [];
		for (let index = 0; index < keys.length; index += LIST_BATCH_SIZE) {
			const chunk = keys.slice(index, index + LIST_BATCH_SIZE);
			if (chunk.length === 0) {
				continue;
			}
			try {
				failedKeys.push(...(await this.deleteObjects([...chunk])));
			} catch (error) {
				if (index === 0 && failedKeys.length === 0) {
					throw error;
				}
				failedKeys.push(...keys.slice(index));
				break;
			}
		}
		return { failedKeys };
	}

	async deleteByPrefix(prefix: string): Promise<void> {
		let continuationToken: string | undefined;
		do {
			const { keys, nextContinuationToken } = await this.listObjects(prefix, continuationToken);
			const { failedKeys } = await this.deleteMany(keys);
			if (failedKeys.length > 0) {
				throw new Error(`s3 batch delete failed for ${failedKeys.length} key(s)`);
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

	private async deleteObjects(keys: string[]): Promise<string[]> {
		const body = `<?xml version="1.0" encoding="UTF-8"?><Delete>${keys
			.map((key) => `<Object><Key>${encodeXmlEntities(key)}</Key></Object>`)
			.join("")}</Delete>`;
		const url = new URL(this.baseUrl + "/");
		url.searchParams.set("delete", "");
		const response = await this.client.fetch(url.toString(), {
			method: "POST",
			body,
			headers: {
				"content-type": "application/xml",
				"content-md5": createHash("md5").update(body).digest("base64"),
			},
		});
		if (!response.ok) {
			throw new Error(`s3 batch delete failed: ${response.status} ${await response.text()}`);
		}

		return s3DeleteResultErrorKeys(await response.text());
	}
}

export function s3DeleteResultErrorKeys(xml: string): string[] {
	return [...xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g)].flatMap((match) => {
		const key = match[1].match(/<Key>([\s\S]*?)<\/Key>/);
		return key ? [decodeXmlEntities(key[1])] : [];
	});
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
