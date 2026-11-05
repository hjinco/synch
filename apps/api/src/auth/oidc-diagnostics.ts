/**
 * Bounds how often an OIDC-init failure (a discovery fetch that rejects, an
 * incomplete discovery document, and similar construction-time failures) is
 * surfaced to logs. `createBetterAuth` runs on every request -- including
 * routes such as blob transfer that never await a session -- so an
 * unreachable identity provider would otherwise produce one log entry per
 * request at full traffic volume rather than once per outage.
 *
 * The decision of whether a given failure should be emitted is kept pure and
 * side-effect-free: it takes the current time as a parameter instead of
 * calling `Date.now()` internally, so the de-duplication window can be
 * exercised deterministically without real timers.
 */

/** Last-allowed timestamp (ms) per key. */
export type TimeWindowGateState = ReadonlyMap<string, number>;

export type TimeWindowGateDecision = {
	readonly allowed: boolean;
	readonly nextState: TimeWindowGateState;
};

/**
 * Pure decision shared by every "at most once per window, per key" policy in
 * the OIDC integration: given the prior state, a key, and the current time,
 * decides whether this occurrence is allowed and returns the state to carry
 * forward. Never mutates `state`. Callers -- diagnostic de-duplication here,
 * and the rebuild cooldown in `createAuthFeature` -- keep their own state and
 * their own window, so unrelated policies never throttle each other.
 */
export function decideTimeWindowedAction(
	state: TimeWindowGateState,
	key: string,
	now: number,
	windowMs: number,
): TimeWindowGateDecision {
	const lastAllowedAt = state.get(key);
	if (lastAllowedAt !== undefined && now - lastAllowedAt < windowMs) {
		return { allowed: false, nextState: state };
	}

	const nextState = new Map(state);
	nextState.set(key, now);
	return { allowed: true, nextState };
}

/** Last-emitted timestamp (ms) per failure key. */
export type OidcDiagnosticDedupState = TimeWindowGateState;

export type OidcDiagnosticDecision = {
	readonly shouldEmit: boolean;
	readonly nextState: OidcDiagnosticDedupState;
};

/** One line per outage, not one per request: a generous window that still surfaces a persistent outage. */
export const OIDC_DIAGNOSTIC_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Pure decision: given the prior emission state, a failure key, and the
 * current time, decides whether this occurrence should be emitted and
 * returns the state to carry forward. Never mutates `state`.
 */
export function decideOidcDiagnosticEmission(
	state: OidcDiagnosticDedupState,
	key: string,
	now: number,
	windowMs: number = OIDC_DIAGNOSTIC_DEDUP_WINDOW_MS,
): OidcDiagnosticDecision {
	const decision = decideTimeWindowedAction(state, key, now, windowMs);
	return { shouldEmit: decision.allowed, nextState: decision.nextState };
}

export type OidcDiagnosticDetail = Record<string, unknown>;

/** Module-scoped: outlives any single request, since the whole point is to bound emissions across requests. */
let dedupState: OidcDiagnosticDedupState = new Map();

/**
 * Thin emit wrapper: unconditionally writes one diagnostic entry. Kept
 * gate-free on purpose -- callers must consult `shouldEmitOidcDiagnostic`
 * first and only invoke this when it returns `true`. This is the exact
 * boundary integration tests spy on to assert that emissions stay bounded;
 * gating has to live in the caller (a separate module) rather than in here,
 * because a spy on this export only observes calls made through the module
 * boundary, not calls this module might make to itself internally.
 */
export function recordOidcDiagnostic(
	key: string,
	detail: OidcDiagnosticDetail,
	now: number = Date.now(),
): void {
	console.error("[api] oidc init diagnostic", { key, ...detail, at: now });
}

/**
 * Applies `decideOidcDiagnosticEmission` against module-scoped state and
 * reports whether this occurrence is worth emitting. Callers -- the explicit
 * `.catch()` attached to the OIDC plugin's init promise at construction --
 * must call `recordOidcDiagnostic` themselves when (and only when) this
 * returns `true`. Because the eager init promise is recreated on every
 * request, this is consulted once per failing request; the module-scoped
 * state is what keeps the resulting `recordOidcDiagnostic` calls (and
 * therefore log volume) bounded regardless of request count.
 */
export function shouldEmitOidcDiagnostic(key: string, now: number = Date.now()): boolean {
	const decision = decideOidcDiagnosticEmission(dedupState, key, now);
	dedupState = decision.nextState;
	return decision.shouldEmit;
}

/** Test-only: clears module-scoped dedup state so cases don't leak across tests sharing an isolate. */
export function resetOidcDiagnosticsStateForTests(): void {
	dedupState = new Map();
}
