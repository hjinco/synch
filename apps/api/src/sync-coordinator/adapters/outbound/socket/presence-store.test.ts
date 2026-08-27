import { describe, expect, it } from "vitest";

import {
	MIN_PRESENCE_UPDATE_INTERVAL_MS,
	PresenceStore,
} from "./presence-store";

describe("PresenceStore", () => {
	it("stores and lists active files for the same entry", () => {
		const store = new PresenceStore();
		const selection = {
			anchor: { line: 1, ch: 2 },
			head: { line: 1, ch: 2 },
		};

		expect(store.tryStore("a", "entry-1", selection, 1_000)).toBe("ok");
		expect(store.tryStore("b", "entry-1", {
			anchor: { line: 3, ch: 4 },
			head: { line: 3, ch: 4 },
		}, 1_000)).toBe("ok");
		expect(store.tryStore("c", "entry-2", {
			anchor: { line: 5, ch: 6 },
			head: { line: 5, ch: 6 },
		}, 1_000)).toBe("ok");

		expect(store.listByEntryId("entry-1", "a")).toEqual([
			{ presenceId: "b", entryId: "entry-1", selection: {
				anchor: { line: 3, ch: 4 },
				head: { line: 3, ch: 4 },
			} },
		]);
		expect(store.listByEntryId("entry-2", "a")).toEqual([
			{ presenceId: "c", entryId: "entry-2", selection: {
				anchor: { line: 5, ch: 6 },
				head: { line: 5, ch: 6 },
			} },
		]);
	});

	it("throttles updates from the same connection", () => {
		const store = new PresenceStore();

		expect(store.tryStore("a", "entry-1", {
			anchor: { line: 1, ch: 2 },
			head: { line: 1, ch: 2 },
		}, 1_000)).toBe("ok");
		expect(
			store.tryStore(
				"a",
				"entry-1",
				{ anchor: { line: 3, ch: 4 }, head: { line: 3, ch: 4 } },
				1_000 + MIN_PRESENCE_UPDATE_INTERVAL_MS - 1,
			),
		).toBe("throttled");
		expect(store.listByEntryId("entry-1", "b")).toEqual([
			{ presenceId: "a", entryId: "entry-1", selection: {
				anchor: { line: 1, ch: 2 },
				head: { line: 1, ch: 2 },
			} },
		]);
		expect(
			store.tryStore(
				"a",
				"entry-1",
				{ anchor: { line: 5, ch: 6 }, head: { line: 5, ch: 6 } },
				1_000 + MIN_PRESENCE_UPDATE_INTERVAL_MS,
			),
		).toBe("ok");
		expect(store.listByEntryId("entry-1", "b")).toEqual([
			{ presenceId: "a", entryId: "entry-1", selection: {
				anchor: { line: 5, ch: 6 },
				head: { line: 5, ch: 6 },
			} },
		]);
	});

	it("forgets a connection so later snapshots omit it", () => {
		const store = new PresenceStore();
		store.tryStore("a", "entry-1", {
			anchor: { line: 1, ch: 2 },
			head: { line: 1, ch: 2 },
		}, 1_000);

		expect(store.clear("a")).toEqual({
			presenceId: "a",
			entryId: "entry-1",
			selection: {
				anchor: { line: 1, ch: 2 },
				head: { line: 1, ch: 2 },
			},
		});
		expect(store.listByEntryId("entry-1")).toEqual([]);
		expect(store.clear("a")).toBeNull();
	});
});
