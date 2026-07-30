import { describe, expect, it } from "vitest";

import { VaultLockRegistry } from "./vault-lock";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("VaultLockRegistry", () => {
	it("serializes overlapping calls for the same vault in call order", async () => {
		const lock = new VaultLockRegistry();
		const order: string[] = [];
		const gate = deferred<void>();

		const first = lock.run("vault-a", async () => {
			order.push("first-start");
			await gate.promise;
			order.push("first-end");
		});
		const second = lock.run("vault-a", async () => {
			order.push("second-start");
			order.push("second-end");
		});

		// second must not start until first releases the lock
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["first-start"]);

		gate.resolve();
		await Promise.all([first, second]);

		expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
	});

	it("does not serialize calls for different vaults", async () => {
		const lock = new VaultLockRegistry();
		const order: string[] = [];
		const gate = deferred<void>();

		const a = lock.run("vault-a", async () => {
			order.push("a-start");
			await gate.promise;
			order.push("a-end");
		});
		const b = lock.run("vault-b", async () => {
			order.push("b-start");
			order.push("b-end");
		});

		await b;
		expect(order).toEqual(["a-start", "b-start", "b-end"]);

		gate.resolve();
		await a;
		expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
	});

	it("propagates a rejection without poisoning the queue for later callers", async () => {
		const lock = new VaultLockRegistry();

		await expect(
			lock.run("vault-a", () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		await expect(lock.run("vault-a", () => "ok")).resolves.toBe("ok");
	});

	it("cleans up its internal queue once idle", async () => {
		const lock = new VaultLockRegistry();
		await lock.run("vault-a", () => {});
		// @ts-expect-error accessing private state for the test
		expect(lock.tails.size).toBe(0);
	});
});
