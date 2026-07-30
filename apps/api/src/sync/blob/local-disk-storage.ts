import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BlobBody, BlobStorage } from "./storage";

/**
 * Filesystem-backed blob storage for a self-hosted, no-Cloudflare deployment.
 * Keys are `${vaultId}/${blobId}` (see `blobObjectKey`), so they map directly
 * onto `${baseDir}/${vaultId}/${blobId}` — which also makes `deleteByPrefix`
 * (called with the vault's `${vaultId}/` prefix on vault deletion) a plain
 * recursive directory removal rather than a prefix scan.
 */
export class LocalDiskBlobStorage implements BlobStorage {
	constructor(private readonly baseDir: string) {}

	async upload(key: string, body: BlobBody): Promise<{ size: number }> {
		const filePath = this.resolveKeyPath(key);
		await mkdir(path.dirname(filePath), { recursive: true });
		// See the matching cast in `download()`: `body`'s ambient Workers-types
		// ReadableStream and Node's `stream/web` one are nominally distinct
		// but structurally compatible for what `Readable.fromWeb` needs here.
		await pipeline(
			Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream),
			createWriteStream(filePath),
		);
		const stats = await stat(filePath);
		return { size: stats.size };
	}

	async download(key: string): Promise<ReadableStream | null> {
		const filePath = this.resolveKeyPath(key);
		if (!(await pathExists(filePath))) {
			return null;
		}
		// Node's `stream/web` ReadableStream and the ambient Workers-types
		// `ReadableStream` this project's types are built on are structurally
		// almost identical (they differ only in the BYOB reader's
		// `readAtLeast`, which this codebase never calls) but are nominally
		// distinct, hence the double cast.
		return Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
	}

	async delete(key: string): Promise<void> {
		await rm(this.resolveKeyPath(key), { force: true });
	}

	async deleteByPrefix(prefix: string): Promise<void> {
		await rm(this.resolveKeyPath(prefix), { recursive: true, force: true });
	}

	async exists(key: string): Promise<boolean> {
		return pathExists(this.resolveKeyPath(key));
	}

	private resolveKeyPath(key: string): string {
		// Reject `..` segments outright rather than relying on the resolved-path
		// check below alone: `path.resolve` collapses a key like
		// "vault-1/../vault-2/blob" down to a path that's still inside baseDir,
		// which would let one vault reach another's blobs. On R2, that same
		// key is a distinct, literal object key with no such collapse.
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
