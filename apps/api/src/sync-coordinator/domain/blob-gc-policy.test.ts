import { describe, expect, it } from "vitest";

import {
	decideBlobCollection,
	decidePendingDelete,
	earliestGcDeadline,
	isBlobPinned,
} from "./blob-gc-policy";

describe("blob GC policy", () => {
	it("retains live blobs even when they have no references", () => {
		expect(
			decideBlobCollection(
				{
					state: "live",
					deleteAfter: 1,
					hasCurrentReference: false,
					hasRetainedHistory: false,
				},
				2,
			),
		).toEqual({ kind: "retained", reason: "live" });
	});

	it("retains a staged blob until its grace period expires", () => {
		expect(
			decideBlobCollection(
				{
					state: "staged",
					deleteAfter: 3,
					hasCurrentReference: false,
					hasRetainedHistory: false,
				},
				2,
			),
		).toEqual({ kind: "retained", reason: "grace_period" });
	});

	it("retains expired blobs referenced by current state or history", () => {
		const base = {
			state: "pending_delete" as const,
			deleteAfter: 1,
			hasCurrentReference: false,
			hasRetainedHistory: false,
		};

		expect(decideBlobCollection({ ...base, hasCurrentReference: true }, 2)).toEqual({
			kind: "retained",
			reason: "current_reference",
		});
		expect(decideBlobCollection({ ...base, hasRetainedHistory: true }, 2)).toEqual({
			kind: "retained",
			reason: "retained_history",
		});
	});

	it("marks an unreferenced live blob pending delete immediately", () => {
		expect(
			decidePendingDelete(
				{
					state: "live",
					deleteAfter: 10,
					hasCurrentReference: false,
					hasRetainedHistory: false,
				},
				5,
			),
		).toEqual({ kind: "mark_pending_delete", deleteAfter: 5 });
	});

	it("does not mark staged or referenced blobs pending delete", () => {
		expect(
			decidePendingDelete(
				{
					state: "staged",
					deleteAfter: 10,
					hasCurrentReference: false,
					hasRetainedHistory: false,
				},
				5,
			),
		).toEqual({ kind: "retain", reason: "staged" });
		expect(
			decidePendingDelete(
				{
					state: "live",
					deleteAfter: null,
					hasCurrentReference: true,
					hasRetainedHistory: false,
				},
				5,
			),
		).toEqual({ kind: "retain", reason: "current_reference" });
	});

	it("selects the earliest deadline and keeps due work schedulable", () => {
		expect(earliestGcDeadline([2, 8, 4], 3)).toBe(3);
		expect(earliestGcDeadline([4, 8], 3)).toBe(4);
		expect(earliestGcDeadline([1, 2], 3)).toBe(3);
		expect(earliestGcDeadline([], 3)).toBeNull();
	});

	it("pins a blob when current state, retained history, or active staging references it", () => {
		const facts = {
			hasCurrentReference: false,
			hasRetainedHistory: false,
			hasActiveStaging: true,
		};

		expect(isBlobPinned(facts)).toBe(true);
		expect(isBlobPinned(facts, false)).toBe(false);
		expect(isBlobPinned({ ...facts, hasRetainedHistory: true }, false)).toBe(true);
	});
});
