import type { BlobLifecycleState } from "./blob-policy";

export type BlobCollectionFacts = {
	state: BlobLifecycleState;
	deleteAfter: number | null;
	hasCurrentReference: boolean;
	hasRetainedHistory: boolean;
};

export type BlobReferenceFacts = Pick<
	BlobCollectionFacts,
	"hasCurrentReference" | "hasRetainedHistory"
> & {
	hasActiveStaging: boolean;
};

export type BlobCollectionDecision =
	| { kind: "collectible" }
	| {
			kind: "retained";
			reason:
				| "live"
				| "grace_period"
				| "current_reference"
				| "retained_history"
				| "missing_deadline";
		};

export type PendingDeleteDecision =
	| { kind: "mark_pending_delete"; deleteAfter: number }
	| {
			kind: "retain";
			reason: "staged" | "current_reference" | "retained_history";
		};

export function decideBlobCollection(
	facts: BlobCollectionFacts,
	now: number,
): BlobCollectionDecision {
	if (facts.state === "live") {
		return { kind: "retained", reason: "live" };
	}
	if (facts.deleteAfter === null) {
		return { kind: "retained", reason: "missing_deadline" };
	}
	if (facts.deleteAfter > now) {
		return { kind: "retained", reason: "grace_period" };
	}
	if (facts.hasCurrentReference) {
		return { kind: "retained", reason: "current_reference" };
	}
	if (facts.hasRetainedHistory) {
		return { kind: "retained", reason: "retained_history" };
	}
	return { kind: "collectible" };
}

export function decidePendingDelete(
	facts: BlobCollectionFacts,
	now: number,
): PendingDeleteDecision {
	if (facts.state === "staged") {
		return { kind: "retain", reason: "staged" };
	}
	if (facts.hasCurrentReference) {
		return { kind: "retain", reason: "current_reference" };
	}
	if (facts.hasRetainedHistory) {
		return { kind: "retain", reason: "retained_history" };
	}

	return {
		kind: "mark_pending_delete",
		deleteAfter:
			facts.deleteAfter === null
				? now
				: Math.min(facts.deleteAfter, now),
	};
}

export function isBlobPinned(
	facts: BlobReferenceFacts,
	includeStaging = true,
): boolean {
	return (
		facts.hasCurrentReference ||
		facts.hasRetainedHistory ||
		(includeStaging && facts.hasActiveStaging)
	);
}

export function earliestGcDeadline(
	deadlines: readonly number[],
	now: number,
): number | null {
	if (deadlines.length === 0) {
		return null;
	}

	const earliest = Math.min(...deadlines);
	// Keep already-due work schedulable so callers can arm an immediate GC run.
	return earliest <= now ? now : earliest;
}
