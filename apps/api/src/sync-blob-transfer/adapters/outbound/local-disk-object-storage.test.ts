import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalDiskBlobObjectStorage } from "./local-disk-object-storage";

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body as ReadableStream<Uint8Array>;
}

describe("LocalDiskBlobObjectStorage", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips and isolates vault prefixes", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobObjectStorage(dir);
		await expect(storage.upload("vault-1/blob-1", streamOf("hello"), 5)).resolves.toEqual({
			size: 5,
			sizeMismatch: false,
		});
		expect(await storage.exists("vault-1/blob-1")).toBe(true);
		expect(await storage.download("vault-1/missing")).toBeNull();
		await storage.deleteByPrefix("vault-1/");
		expect(await storage.exists("vault-1/blob-1")).toBe(false);
	});

	it("rejects traversal keys", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobObjectStorage(dir);
		await expect(storage.upload("../escape", streamOf("x"), 1)).rejects.toThrow(
			/must not contain "\.\." segments/,
		);
	});
});
