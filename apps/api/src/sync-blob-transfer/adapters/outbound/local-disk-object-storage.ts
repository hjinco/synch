import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BlobObjectStorage } from "../../application/ports/outbound/blob-object-storage";
import { limitBodySize } from "./body-size";

export class LocalDiskBlobObjectStorage implements BlobObjectStorage {
	constructor(private readonly baseDir: string) {}

	async upload(
		key: string,
		body: ReadableStream<Uint8Array>,
		declaredSizeBytes: number,
	): Promise<{ size: number; sizeMismatch: boolean }> {
		const filePath = this.resolveKeyPath(key);
		await mkdir(path.dirname(filePath), { recursive: true });
		const limited = limitBodySize(body, declaredSizeBytes);
		let uploadError: unknown;
		try {
			await pipeline(
				Readable.fromWeb(limited.readable as unknown as import("node:stream/web").ReadableStream),
				createWriteStream(filePath),
			);
		} catch (error) {
			uploadError = error;
		}
		const sizeMismatch = await limited.sizeMismatch;
		if (sizeMismatch) {
			return { size: 0, sizeMismatch: true };
		}
		if (uploadError) {
			throw uploadError;
		}
		const size = (await stat(filePath)).size;
		return { size, sizeMismatch: sizeMismatch || size !== declaredSizeBytes };
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
