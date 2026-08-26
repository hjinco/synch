export interface SizeLimitedBody {
	readable: ReadableStream<Uint8Array>;
	sizeMismatch: Promise<boolean>;
}

/**
 * Stops consuming an upload as soon as it exceeds the declared size while
 * preserving backpressure. FixedLengthStream lets R2 retain a known length;
 * Node/S3 uses the standard TransformStream fallback.
 */
export function limitBodySize(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): SizeLimitedBody {
	const { readable, writable } = createLimitedStream(maxBytes);
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
			await writer.abort(new Error("blob body size did not match declared X-Blob-Size")).catch(
				() => {},
			);
		} else {
			await writer.close().catch(() => {});
		}
		return mismatch;
	})();

	return { readable, sizeMismatch };
}

function createLimitedStream(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
	if (typeof FixedLengthStream === "undefined") {
		return new TransformStream<Uint8Array, Uint8Array>();
	}
	return new FixedLengthStream(maxBytes);
}
