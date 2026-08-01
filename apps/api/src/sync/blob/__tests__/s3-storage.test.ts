import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { S3BlobStorage } from "../s3-storage";

/**
 * Minimal fake S3-compatible server: enough of PUT/GET/HEAD/DELETE plus
 * ListObjectsV2 and the multi-object Delete API to exercise
 * `S3BlobStorage`'s request construction and XML parsing without a real
 * MinIO/S3 endpoint. Doesn't validate SigV4 signatures - that's aws4fetch's
 * concern, not this backend's.
 */
function createFakeS3Server(bucket: string) {
	const objects = new Map<string, Buffer>();
	const server: Server = createServer((req, res) => {
		void handle(req, res).catch((error) => {
			res.writeHead(500);
			res.end(String(error));
		});
	});

	async function readBody(req: IncomingMessage): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks);
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const prefix = `/${bucket}/`;
		if (!url.pathname.startsWith(prefix) && url.pathname !== `/${bucket}`) {
			res.writeHead(404);
			res.end();
			return;
		}
		const key = decodeURIComponent(url.pathname.slice(prefix.length));

		if (req.method === "PUT") {
			objects.set(key, await readBody(req));
			res.writeHead(200);
			res.end();
			return;
		}
		if (req.method === "HEAD") {
			if (key === "trigger-server-error") {
				res.writeHead(500);
				res.end();
				return;
			}
			res.writeHead(objects.has(key) ? 200 : 404);
			res.end();
			return;
		}
		if (req.method === "DELETE") {
			objects.delete(key);
			res.writeHead(204);
			res.end();
			return;
		}
		if (req.method === "GET" && url.searchParams.has("list-type")) {
			const listPrefix = url.searchParams.get("prefix") ?? "";
			const matches = [...objects.keys()].filter((k) => k.startsWith(listPrefix));
			const body = `<?xml version="1.0"?><ListBucketResult>${matches
				.map((k) => `<Contents><Key>${k}</Key></Contents>`)
				.join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`;
			res.writeHead(200, { "content-type": "application/xml" });
			res.end(body);
			return;
		}
		if (req.method === "POST" && url.searchParams.has("delete")) {
			const body = (await readBody(req)).toString("utf8");
			const keys = [...body.matchAll(/<Key>(.*?)<\/Key>/g)].map((m) => m[1]);
			for (const k of keys) {
				objects.delete(k);
			}
			res.writeHead(200, { "content-type": "application/xml" });
			res.end("<DeleteResult/>");
			return;
		}
		if (req.method === "GET") {
			const object = objects.get(key);
			if (!object) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200);
			res.end(object);
			return;
		}
		res.writeHead(405);
		res.end();
	}

	return { server, objects };
}

function streamOf(text: string): ReadableStream {
	return new Response(text).body as unknown as ReadableStream;
}

async function textOf(stream: ReadableStream): Promise<string> {
	return new Response(stream as unknown as BodyInit).text();
}

describe("S3BlobStorage", () => {
	const bucket = "test-bucket";
	let fake: ReturnType<typeof createFakeS3Server>;
	let endpoint: string;
	let storage: S3BlobStorage;

	beforeAll(async () => {
		fake = createFakeS3Server(bucket);
		await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
		const address = fake.server.address();
		if (!address || typeof address === "string") {
			throw new Error("failed to bind fake S3 server");
		}
		endpoint = `http://127.0.0.1:${address.port}`;
	});

	afterAll(() => {
		fake.server.close();
	});

	beforeEach(() => {
		fake.objects.clear();
		storage = new S3BlobStorage({
			endpoint,
			bucket,
			accessKeyId: "test",
			secretAccessKey: "test",
		});
	});

	it("round-trips an upload through download", async () => {
		const { size } = await storage.upload("vault-1/blob-1", streamOf("hello world"));
		expect(size).toBe("hello world".length);

		const downloaded = await storage.download("vault-1/blob-1");
		expect(downloaded).not.toBeNull();
		expect(await textOf(downloaded!)).toBe("hello world");
	});

	it("returns null for a missing key and false for exists", async () => {
		expect(await storage.download("vault-1/missing")).toBeNull();
		expect(await storage.exists("vault-1/missing")).toBe(false);
	});

	it("throws from exists() on a non-404 error instead of reporting the blob as missing", async () => {
		await expect(storage.exists("trigger-server-error")).rejects.toThrow(
			/exists check failed/,
		);
	});

	it("deletes a single key without touching siblings", async () => {
		await storage.upload("vault-1/blob-a", streamOf("a"));
		await storage.upload("vault-1/blob-b", streamOf("b"));

		await storage.delete("vault-1/blob-a");

		expect(await storage.exists("vault-1/blob-a")).toBe(false);
		expect(await storage.exists("vault-1/blob-b")).toBe(true);
	});

	it("deleteByPrefix removes every blob under a vault and leaves others intact", async () => {
		await storage.upload("vault-1/blob-a", streamOf("a"));
		await storage.upload("vault-1/blob-b", streamOf("b"));
		await storage.upload("vault-2/blob-c", streamOf("c"));

		await storage.deleteByPrefix("vault-1/");

		expect(await storage.exists("vault-1/blob-a")).toBe(false);
		expect(await storage.exists("vault-1/blob-b")).toBe(false);
		expect(await storage.exists("vault-2/blob-c")).toBe(true);
	});

	it("rejects a same-vault-looking key that traverses into a different vault", async () => {
		await storage.upload("vault-2/blob-secret", streamOf("secret"));

		// `encodeURIComponent("..")` doesn't escape the dots, so ".." segments
		// reach `new URL()` intact - which then collapses
		// "vault-1/../vault-2/blob-secret" down to "vault-2/blob-secret",
		// silently reaching across vaults if not rejected first.
		await expect(
			storage.download("vault-1/../vault-2/blob-secret"),
		).rejects.toThrow(/must not contain "\." or "\.\." segments/);
	});

	it("rejects a key with a bare . segment", async () => {
		await expect(storage.upload("vault-1/./blob", streamOf("x"))).rejects.toThrow(
			/must not contain "\." or "\.\." segments/,
		);
	});
});
