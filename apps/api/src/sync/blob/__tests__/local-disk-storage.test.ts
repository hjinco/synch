import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalDiskBlobStorage } from "../local-disk-storage";

function streamOf(text: string): ReadableStream {
	return new Response(text).body as unknown as ReadableStream;
}

async function textOf(stream: ReadableStream): Promise<string> {
	return new Response(stream as unknown as BodyInit).text();
}

describe("LocalDiskBlobStorage", () => {
	let dir: string;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips an upload through download", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobStorage(dir);

		const { size } = await storage.upload("vault-1/blob-1", streamOf("hello world"));
		expect(size).toBe("hello world".length);

		const downloaded = await storage.download("vault-1/blob-1");
		expect(downloaded).not.toBeNull();
		expect(await textOf(downloaded!)).toBe("hello world");
	});

	it("returns null for a missing key and false for exists", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobStorage(dir);

		expect(await storage.download("vault-1/missing")).toBeNull();
		expect(await storage.exists("vault-1/missing")).toBe(false);
	});

	it("deletes a single key without touching siblings", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobStorage(dir);
		await storage.upload("vault-1/blob-a", streamOf("a"));
		await storage.upload("vault-1/blob-b", streamOf("b"));

		await storage.delete("vault-1/blob-a");

		expect(await storage.exists("vault-1/blob-a")).toBe(false);
		expect(await storage.exists("vault-1/blob-b")).toBe(true);
	});

	it("deleteByPrefix removes every blob under a vault and leaves others intact", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobStorage(dir);
		await storage.upload("vault-1/blob-a", streamOf("a"));
		await storage.upload("vault-1/blob-b", streamOf("b"));
		await storage.upload("vault-2/blob-c", streamOf("c"));

		await storage.deleteByPrefix("vault-1/");

		expect(await storage.exists("vault-1/blob-a")).toBe(false);
		expect(await storage.exists("vault-1/blob-b")).toBe(false);
		expect(await storage.exists("vault-2/blob-c")).toBe(true);
	});

	it("is a no-op deleting a prefix that was never written", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobStorage(dir);
		await expect(storage.deleteByPrefix("never-existed/")).resolves.toBeUndefined();
	});

	it("rejects a key with a .. segment", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobStorage(dir);

		await expect(storage.upload("../escape", streamOf("x"))).rejects.toThrow(
			/must not contain "\.\." segments/,
		);
	});

	it("rejects an absolute-path key that would escape the base directory", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobStorage(dir);

		await expect(storage.upload("/etc/passwd", streamOf("x"))).rejects.toThrow(
			/escapes storage base directory/,
		);
	});

	it("rejects a same-vault-looking key that traverses into a different vault", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobStorage(dir);
		await storage.upload("vault-2/blob-secret", streamOf("secret"));

		// `path.resolve` alone would collapse this to "vault-2/blob-secret",
		// silently reaching across vaults - must be rejected before that.
		await expect(
			storage.download("vault-1/../vault-2/blob-secret"),
		).rejects.toThrow(/must not contain "\.\." segments/);
	});
});
