export const BLOB_SIZE_HEADER = "x-blob-size";

export interface SizeLimitedBody {
	readable: ReadableStream<Uint8Array>;
	/** Resolves once the body has been fully read: true if it didn't come to exactly `maxBytes`. */
	sizeMismatch: Promise<boolean>;
}

/**
 * Caps a blob upload body at exactly `maxBytes`, stopping as soon as the
 * body over-shoots that length rather than after the whole body has been
 * received. Without this, a client can send `X-Blob-Size: 1` (trivially
 * within quota) and then stream an arbitrarily large body - the
 * declared-size check in the PUT route used to only run *after*
 * `blobRepository.upload()` resolved, by which point R2 (or a backend that
 * buffers uploads in memory) may have already received the entire oversized
 * body: a resource-exhaustion DoS from any authenticated user.
 *
 * Pumps chunks through manually (rather than a plain `pipeTo`) for two
 * reasons: it lets a too-large body be caught and stopped *before* handing
 * a single byte past `maxBytes` to the sink, and it reports a definite
 * `sizeMismatch` the caller can trust regardless of how a given backend's
 * consumer reacts to an aborted stream - rather than needing to parse
 * backend-specific rejection errors to tell "declared size didn't match"
 * apart from "something else went wrong". `await`ing each `writer.write()`
 * naturally respects backpressure, so this never buffers more than one
 * chunk ahead of whatever's consuming `readable`.
 *
 * Built on `FixedLengthStream` where available rather than a plain
 * `TransformStream`: R2's `bucket.put()` refuses to stream a body it can't
 * determine the length of upfront (it throws "Provided readable stream must
 * have a known length") unless it's either the original request/response
 * body or - as here - the readable half of a `FixedLengthStream`, the
 * Workers-native way to give it a stream of a declared length without
 * buffering it first. `FixedLengthStream` is a workerd global and doesn't
 * exist under plain Node, so the self-hosted runtime (disk/S3 backends, which
 * don't need a declared length) falls back to a plain `TransformStream`.
 */
export function limitBodySize(body: ReadableStream<Uint8Array>, maxBytes: number): SizeLimitedBody {
	const { readable, writable } =
		typeof FixedLengthStream !== "undefined"
			? new FixedLengthStream(maxBytes)
			: new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const reader = body.getReader();

	const sizeMismatch = (async () => {
		let received = 0;
		let mismatch = false;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			received += value.byteLength;
			if (received > maxBytes) {
				mismatch = true;
				await reader.cancel().catch(() => {});
				break;
			}
			await writer.write(value);
		}
		if (received !== maxBytes) {
			mismatch = true;
		}
		if (mismatch) {
			await writer.abort(new Error("blob body size did not match declared X-Blob-Size")).catch(() => {});
		} else {
			await writer.close().catch(() => {});
		}
		return mismatch;
	})();

	return { readable, sizeMismatch };
}

export function parseBlobSizeHeader(value: string | null): number | null {
	if (value === null) {
		return null;
	}

	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		return null;
	}

	const size = Number(trimmed);
	if (!Number.isSafeInteger(size) || size < 0) {
		return null;
	}

	return size;
}
