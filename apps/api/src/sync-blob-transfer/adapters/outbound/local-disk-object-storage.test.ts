import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
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
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
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

	it("deletes many keys without touching other vault prefixes", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobObjectStorage(dir);
		await storage.upload("vault-1/blob-1", streamOf("one"), 3);
		await storage.upload("vault-1/blob-2", streamOf("two"), 3);
		await storage.upload("vault-2/blob-1", streamOf("keep"), 4);

		await storage.deleteMany(["vault-1/blob-1", "vault-1/blob-2"]);

		expect(await storage.exists("vault-1/blob-1")).toBe(false);
		expect(await storage.exists("vault-1/blob-2")).toBe(false);
		expect(await storage.exists("vault-2/blob-1")).toBe(true);
	});

	it("reports failed keys without rolling back deletes that succeeded", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobObjectStorage(dir);
		await storage.upload("vault-1/blob-1", streamOf("one"), 3);
		await storage.upload("vault-1/blob-2", streamOf("two"), 3);

		await expect(
			storage.deleteMany(["vault-1/blob-1", "vault-1/../escape", "vault-1/blob-2"]),
		).resolves.toEqual({
			failedKeys: ["vault-1/../escape"],
		});
		expect(await storage.exists("vault-1/blob-1")).toBe(false);
		expect(await storage.exists("vault-1/blob-2")).toBe(false);
	});

	it.each(["input_error", "short", "long"])("cleans up a %s upload and permits a subsequent retry", async (failure) => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobObjectStorage(dir);
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const interrupted = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
		const failedAttempt = storage.upload("vault/blob", interrupted, 4);
		const settled = Promise.allSettled([failedAttempt]);
		controller.enqueue(new TextEncoder().encode("x"));
		if (failure === "input_error") controller.error(new Error("connection reset"));
		else {
			if (failure === "long") controller.enqueue(new Uint8Array(4));
			controller.close();
		}
		const [result] = await settled;
		if (failure === "input_error") expect(result.status).toBe("rejected");
		else expect(result).toMatchObject({ status: "fulfilled", value: { sizeMismatch: true } });
		expect(await storage.exists("vault/blob")).toBe(false);
		expect(readdirSync(path.join(dir, "vault"))).toEqual([]);
		await storage.upload("vault/blob", streamOf("good"), 4);
		expect(await new Response(await storage.download("vault/blob")).text()).toBe("good");
		expect(readdirSync(path.join(dir, "vault"))).toEqual(["blob"]);
	});

	it("rejects traversal keys", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-disk-"));
		const storage = new LocalDiskBlobObjectStorage(dir);
		await expect(storage.upload("../escape", streamOf("x"), 1)).rejects.toThrow(
			/must not contain "\.\." segments/,
		);
	});

	it.each(["input_error", "short", "long"])("preserves a completed retry when an overlapping upload fails (%s)", async (failure) => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-race-"));
		const storage = new LocalDiskBlobObjectStorage(dir);
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const first = storage.upload("vault/blob", new ReadableStream({ start(c) { controller = c; } }), 4);
		const settled = Promise.allSettled([first]);
		controller.enqueue(new TextEncoder().encode("x"));
		await expect.poll(() => {
			try {
				const part = readdirSync(path.join(dir, ".uploads")).find(name => name.endsWith(".part"));
				return part ? readFileSync(path.join(dir, ".uploads", part)).length : 0;
			} catch { return 0; }
		}).toBe(1);
		expect(await storage.download("vault/blob")).toBeNull();
		await storage.upload("vault/blob", streamOf("good"), 4);
		if (failure === "input_error") controller.error(new Error("disconnected"));
		else {
			if (failure === "long") controller.enqueue(new Uint8Array(4));
			controller.close();
		}
		await settled;
		expect(await new Response(await storage.download("vault/blob")).text()).toBe("good");
		expect(readdirSync(path.join(dir, ".uploads"))).toEqual([]);
	});

	it("cleans abandoned parts at startup without touching completed blobs", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "synch-blob-startup-"));
		const first = new LocalDiskBlobObjectStorage(dir);
		await first.initialize();
		await first.upload("vault/blob", streamOf("good"), 4);
		writeFileSync(path.join(dir, ".uploads", "abandoned.part"), "partial");
		const next = new LocalDiskBlobObjectStorage(dir);
		await next.initialize();
		expect(readdirSync(path.join(dir, ".uploads"))).toEqual([]);
		expect(await new Response(await next.download("vault/blob")).text()).toBe("good");
	});
	it("keeps temporary files inside a symlinked storage root and reserves their namespace", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "synch-blob-link-"));
		try {
			const target = path.join(root, "target");
			const link = path.join(root, "blobs");
			mkdirSync(target);
			symlinkSync(target, link, "dir");
			const storage = new LocalDiskBlobObjectStorage(link);
			await storage.initialize();
			writeFileSync(path.join(target, ".uploads", "pending.part"), "partial");
			await storage.upload("vault/blob", streamOf("good"), 4);
			for (const key of [".uploads/pending.part", "./.uploads/pending.part", ""]) {
				await expect(storage.download(key)).rejects.toThrow("reserved storage directory");
				await expect(storage.deleteByPrefix(key)).rejects.toThrow("reserved storage directory");
				await expect(storage.upload(key, streamOf("x"), 1)).rejects.toThrow("reserved storage directory");
			}
			await storage.deleteByPrefix("vault/");
			expect(readFileSync(path.join(target, ".uploads", "pending.part"), "utf8")).toBe("partial");
			expect(readdirSync(root).sort()).toEqual(["blobs", "target"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
