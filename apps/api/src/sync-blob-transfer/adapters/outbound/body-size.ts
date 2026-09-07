export interface SizeLimitedBody {
	readable: ReadableStream<Uint8Array>;
	/** Observe concurrently with the consumer: either side can fail first. */
	sizeMismatch: Promise<boolean>;
}

class BlobBodySizeMismatchError extends Error {
	constructor() {
		super("blob body size did not match declared X-Blob-Size");
	}
}

/** Enforces length while propagating input errors and downstream cancellation. */
export function limitBodySize(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): SizeLimitedBody {
	let received = 0;
	const limited = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			received += chunk.byteLength;
			if (received > maxBytes) throw new BlobBodySizeMismatchError();
			controller.enqueue(chunk);
		},
		flush() {
			if (received !== maxBytes) throw new BlobBodySizeMismatchError();
		},
	});
	const sizeMismatch = body.pipeTo(limited.writable).then(
		() => false,
		(error: unknown) => {
			if (error instanceof BlobBodySizeMismatchError) return true;
			throw error;
		},
	);
	return { readable: limited.readable, sizeMismatch };
}
