import { describe, expect, it, vi } from "vitest";
import { limitBodySize } from "./body-size";

describe("upload body length and lifecycle", () => {
	it.each([2, 4])("rejects a body of %i bytes when 3 are declared", async (size) => {
		const limited = limitBodySize(new Response(new Uint8Array(size)).body!, 3);
		const [consumer, sizeResult] = await Promise.allSettled([
			new Response(limited.readable).arrayBuffer(), limited.sizeMismatch,
		]);
		expect(consumer.status).toBe("rejected");
		expect(sizeResult).toEqual({ status: "fulfilled", value: true });
	});

	it("propagates an input failure to the consumer and completion", async () => {
		const error = new Error("connection aborted");
		const limited = limitBodySize(new ReadableStream({
			start(controller) { controller.enqueue(new Uint8Array([1])); },
			pull(controller) { controller.error(error); },
		}), 3);
		const results = await Promise.allSettled([
			new Response(limited.readable).arrayBuffer(), limited.sizeMismatch,
		]);
		expect(results).toEqual([
			{ status: "rejected", reason: error }, { status: "rejected", reason: error },
		]);
	});

	it("cancels the input when the destination fails", async () => {
		const error = new Error("disk full");
		const cancel = vi.fn();
		const limited = limitBodySize(new ReadableStream({
			pull(controller) { controller.enqueue(new Uint8Array([1])); }, cancel,
		}), 100);
		const results = await Promise.allSettled([
			limited.readable.pipeTo(new WritableStream({ write() { throw error; } })),
			limited.sizeMismatch,
		]);
		expect(results.every((result) => result.status === "rejected")).toBe(true);
		expect(cancel).toHaveBeenCalledWith(error);
	});
});
