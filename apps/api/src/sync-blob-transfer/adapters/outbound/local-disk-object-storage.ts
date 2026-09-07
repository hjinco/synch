import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BlobObjectStorage } from "../../application/ports/outbound/blob-object-storage";
import { limitBodySize } from "./body-size";

export class LocalDiskBlobObjectStorage implements BlobObjectStorage {
	private get uploadsDir(): string {
		return path.join(path.resolve(this.baseDir), ".uploads");
	}

	constructor(private readonly baseDir: string) {}

	/** Single-server storage: call before accepting requests, never during uploads.
	 * Keep parts inside the blob directory so mount points and symlinks also
	 * keep the final rename on the same filesystem. */
	async initialize(): Promise<void> {
		await mkdir(this.uploadsDir, { recursive: true });
		for (const entry of await readdir(this.uploadsDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".part")) {
				await rm(path.join(this.uploadsDir, entry.name));
			}
		}
	}

	async upload(
		key: string,
		body: ReadableStream<Uint8Array>,
		declaredSizeBytes: number,
	): Promise<{ size: number; sizeMismatch: boolean }> {
		const filePath = this.resolveKeyPath(key);
		await mkdir(path.dirname(filePath), { recursive: true });
		await mkdir(this.uploadsDir, { recursive: true });
		const temporaryPath = path.join(this.uploadsDir, `${randomUUID()}.part`);
		let completed = false;
		try {
			const limited = limitBodySize(body, declaredSizeBytes);
			const [writeResult, sizeResult] = await Promise.allSettled([
				pipeline(
					Readable.fromWeb(limited.readable as unknown as import("node:stream/web").ReadableStream),
					createWriteStream(temporaryPath, { flags: "wx" }),
				),
				limited.sizeMismatch,
			]);
			if (sizeResult.status === "rejected") throw sizeResult.reason;
			if (sizeResult.value) return { size: 0, sizeMismatch: true };
			if (writeResult.status === "rejected") throw writeResult.reason;
			await rename(temporaryPath, filePath);
			completed = true;
			return { size: declaredSizeBytes, sizeMismatch: false };
		} finally {
			if (!completed) {
				await rm(temporaryPath, { force: true }).catch(() => {
					console.warn("[blob-storage] incomplete upload cleanup failed", { key, temporaryPath });
				});
			}
		}
	}

	async download(key: string): Promise<ReadableStream<Uint8Array> | null> {
		const filePath = this.resolveKeyPath(key);
		if (!(await pathExists(filePath))) {
			return null;
		}
		return Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
	}

	async delete(key: string): Promise<void> {
		await rm(this.resolveKeyPath(key), { force: true });
	}

	async deleteMany(keys: readonly string[]): Promise<{ failedKeys: readonly string[] }> {
		const results = await Promise.allSettled(keys.map((key) => this.delete(key)));
		return {
			failedKeys: results.flatMap((result, index) =>
				result.status === "rejected" ? [keys[index]] : [],
			),
		};
	}

	async deleteByPrefix(prefix: string): Promise<void> {
		await rm(this.resolveKeyPath(prefix), { recursive: true, force: true });
	}

	async exists(key: string): Promise<boolean> {
		return pathExists(this.resolveKeyPath(key));
	}

	private resolveKeyPath(key: string): string {
		if (key.split("/").includes("..")) {
			throw new Error(`blob key must not contain ".." segments: ${key}`);
		}
		const resolvedBase = path.resolve(this.baseDir);
		const resolved = path.resolve(resolvedBase, key);
		if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
			throw new Error(`blob key escapes storage base directory: ${key}`);
		}
		if (resolved === resolvedBase || path.relative(resolvedBase, resolved).split(path.sep)[0] === ".uploads") {
			throw new Error("blob key targets reserved storage directory");
		}
		return resolved;
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}
