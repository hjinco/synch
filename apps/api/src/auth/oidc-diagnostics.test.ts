import { describe, expect, it } from "vitest";

import {
	decideOidcDiagnosticEmission,
	decideTimeWindowedAction,
	OIDC_DIAGNOSTIC_DEDUP_WINDOW_MS,
	type OidcDiagnosticDedupState,
	type TimeWindowGateState,
} from "./oidc-diagnostics";

const DISCOVERY_FAILURE_KEY = "discovery-fetch-failure:oidc";
const OTHER_PROVIDER_KEY = "discovery-fetch-failure:other-provider";
const INCOMPLETE_DOCUMENT_KEY = "discovery-document-incomplete:oidc";

function emptyState(): OidcDiagnosticDedupState {
	return new Map();
}

describe("decideOidcDiagnosticEmission", () => {
	it("emits a diagnostic the first time a failure key is seen", () => {
		const decision = decideOidcDiagnosticEmission(emptyState(), DISCOVERY_FAILURE_KEY, 1_000);

		expect(decision.shouldEmit).toBe(true);
	});

	it("suppresses repeat diagnostics for the same failure key within the window", () => {
		const first = decideOidcDiagnosticEmission(emptyState(), DISCOVERY_FAILURE_KEY, 1_000);
		const second = decideOidcDiagnosticEmission(first.nextState, DISCOVERY_FAILURE_KEY, 1_500);
		const third = decideOidcDiagnosticEmission(
			second.nextState,
			DISCOVERY_FAILURE_KEY,
			OIDC_DIAGNOSTIC_DEDUP_WINDOW_MS - 1,
		);

		expect(second.shouldEmit).toBe(false);
		expect(third.shouldEmit).toBe(false);
	});

	// Two distinct discovery URLs, or a discovery failure versus an
	// incomplete-document failure, must not suppress each other --
	// over-aggressive de-duplication would hide a second, unrelated
	// misconfiguration behind the first.
	it("emits again for a different failure key", () => {
		const first = decideOidcDiagnosticEmission(emptyState(), DISCOVERY_FAILURE_KEY, 1_000);

		const differentProvider = decideOidcDiagnosticEmission(
			first.nextState,
			OTHER_PROVIDER_KEY,
			1_050,
		);
		const differentCategory = decideOidcDiagnosticEmission(
			differentProvider.nextState,
			INCOMPLETE_DOCUMENT_KEY,
			1_100,
		);

		expect(differentProvider.shouldEmit).toBe(true);
		expect(differentCategory.shouldEmit).toBe(true);
	});

	// An outage that lasts hours must still be visible, just bounded -- one
	// line per window, not one per request.
	it("emits again for the same key after the window elapses", () => {
		const first = decideOidcDiagnosticEmission(emptyState(), DISCOVERY_FAILURE_KEY, 0);
		const stillWithinWindow = decideOidcDiagnosticEmission(
			first.nextState,
			DISCOVERY_FAILURE_KEY,
			OIDC_DIAGNOSTIC_DEDUP_WINDOW_MS - 1,
		);
		const afterWindow = decideOidcDiagnosticEmission(
			stillWithinWindow.nextState,
			DISCOVERY_FAILURE_KEY,
			OIDC_DIAGNOSTIC_DEDUP_WINDOW_MS + 1,
		);

		expect(stillWithinWindow.shouldEmit).toBe(false);
		expect(afterWindow.shouldEmit).toBe(true);
	});

	// The property that matters: log volume must not scale with request
	// count. A test that only calls the decision twice would not
	// demonstrate this.
	it("bounds total emissions under a high call volume for one failure key inside one window", () => {
		const CALL_COUNT = 10_000;
		let state = emptyState();
		let emitCount = 0;

		for (let i = 0; i < CALL_COUNT; i++) {
			const now = i; // spread across ~10s of wall-clock time, still inside one window
			const decision = decideOidcDiagnosticEmission(state, DISCOVERY_FAILURE_KEY, now);
			state = decision.nextState;
			if (decision.shouldEmit) {
				emitCount++;
			}
		}

		expect(emitCount).toBeLessThanOrEqual(1);
	});

	it("is deterministic and does not mutate the state it is given", () => {
		const state = emptyState();

		const first = decideOidcDiagnosticEmission(state, DISCOVERY_FAILURE_KEY, 1_000);
		const second = decideOidcDiagnosticEmission(state, DISCOVERY_FAILURE_KEY, 1_000);

		expect(second).toEqual(first);
		expect(state.size).toBe(0);
	});
});

// The shared primitive behind decideOidcDiagnosticEmission, exercised
// directly under the name the OIDC rebuild cooldown (createAuthFeature)
// consumes it under -- proving the cooldown gate's math without needing a
// full betterAuth()/AppDb instance to observe it through.
describe("decideTimeWindowedAction", () => {
	const REBUILD_KEY = "oidc-rebuild";
	const COOLDOWN_MS = 2_000;

	function emptyGateState(): TimeWindowGateState {
		return new Map();
	}

	it("allows the first attempt for a key", () => {
		const decision = decideTimeWindowedAction(emptyGateState(), REBUILD_KEY, 0, COOLDOWN_MS);

		expect(decision.allowed).toBe(true);
	});

	it("blocks a repeat attempt for the same key inside the window", () => {
		const first = decideTimeWindowedAction(emptyGateState(), REBUILD_KEY, 0, COOLDOWN_MS);
		const second = decideTimeWindowedAction(first.nextState, REBUILD_KEY, COOLDOWN_MS - 1, COOLDOWN_MS);

		expect(second.allowed).toBe(false);
	});

	it("allows the next attempt once the window elapses", () => {
		const first = decideTimeWindowedAction(emptyGateState(), REBUILD_KEY, 0, COOLDOWN_MS);
		const second = decideTimeWindowedAction(first.nextState, REBUILD_KEY, COOLDOWN_MS, COOLDOWN_MS);

		expect(second.allowed).toBe(true);
	});

	// The actual property under test: attempts must not scale with request
	// count while sustained failures keep asking for a rebuild every time.
	it("bounds total allowed attempts under high call volume inside one window", () => {
		const CALL_COUNT = 10_000;
		let state = emptyGateState();
		let allowedCount = 0;

		for (let i = 0; i < CALL_COUNT; i++) {
			const now = i / 10; // spread across ~1s of wall-clock time, still inside one window
			const decision = decideTimeWindowedAction(state, REBUILD_KEY, now, COOLDOWN_MS);
			state = decision.nextState;
			if (decision.allowed) {
				allowedCount++;
			}
		}

		expect(allowedCount).toBeLessThanOrEqual(1);
	});

	it("keeps independent keys from throttling each other", () => {
		const first = decideTimeWindowedAction(emptyGateState(), "key-a", 0, COOLDOWN_MS);
		const second = decideTimeWindowedAction(first.nextState, "key-b", 1, COOLDOWN_MS);

		expect(second.allowed).toBe(true);
	});
});
