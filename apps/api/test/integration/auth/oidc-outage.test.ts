import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as oidcDiagnostics from "../../../src/auth/oidc-diagnostics";
import { installFailingFetch } from "./fake-idp-fetch";
import { requestWithEnv, type RuntimeTestEnv } from "./helpers";

const FAKE_IDP_ISSUER = "https://fake-idp.test";
const DISCOVERY_URL = `${FAKE_IDP_ISSUER}/.well-known/openid-configuration`;
const OIDC_CLIENT_ID = "synch-test-client";
const OIDC_CLIENT_SECRET = "test-oidc-client-secret";
const REQUEST_COUNT = 25;
// Generous upper bound on emissions: proves boundedness (does not scale with
// request count) without pinning to the exact constant the GREEN
// implementation picks.
const MAX_EXPECTED_DIAGNOSTIC_EMISSIONS = 3;

function outageTestEnv(overrides: Partial<RuntimeTestEnv> = {}): RuntimeTestEnv {
	return {
		...env,
		SELF_HOSTED: false,
		// Bypasses the managed-edition email-verification requirement so these
		// requests don't also need an EMAIL binding to construct Better Auth.
		DEV_MODE: true,
		OIDC_DISCOVERY_URL: DISCOVERY_URL,
		OIDC_CLIENT_ID,
		OIDC_CLIENT_SECRET,
		...overrides,
	};
}

async function issueBlobRequests(testEnv: RuntimeTestEnv, count: number): Promise<Response[]> {
	// The blob-transfer routes never await the Better Auth session context --
	// they authenticate via a separate sync token -- so they are the
	// real-world high-volume path that still triggers a per-request Better
	// Auth (and therefore OIDC plugin) construction without ever consuming
	// its result.
	const responses: Response[] = [];
	for (let i = 0; i < count; i++) {
		responses.push(
			await requestWithEnv(`/v1/vaults/outage-vault/blobs/outage-blob-${i}`, testEnv, {
				method: "GET",
			}),
		);
	}
	return responses;
}

async function flushMicrotasksAndTimers(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("OIDC init diagnostics during an IdP outage", () => {
	let recordSpy: ReturnType<typeof vi.spyOn> | undefined;
	let rejections: PromiseRejectionEvent[];
	let onUnhandledRejection: (event: PromiseRejectionEvent) => void;

	beforeEach(() => {
		oidcDiagnostics.resetOidcDiagnosticsStateForTests();
		recordSpy = vi.spyOn(oidcDiagnostics, "recordOidcDiagnostic");

		rejections = [];
		onUnhandledRejection = (event) => {
			rejections.push(event);
		};
		addEventListener("unhandledrejection", onUnhandledRejection);
	});

	afterEach(() => {
		removeEventListener("unhandledrejection", onUnhandledRejection);
		recordSpy?.mockRestore();
	});

	it("does not produce a diagnostic per request when the IdP discovery endpoint is unreachable", async () => {
		installFailingFetch({ discoveryUrl: DISCOVERY_URL });
		const testEnv = outageTestEnv();

		await issueBlobRequests(testEnv, REQUEST_COUNT);
		await requestWithEnv("/health", testEnv);
		await flushMicrotasksAndTimers();

		// The eager init promise is created on EVERY request because
		// createRuntimeApp constructs Better Auth unconditionally, including
		// for blob transfer -- the highest-volume route in a sync product.
		// Requests that never await the auth context still initiate the
		// discovery fetch, so without a de-duplicated diagnostic this count
		// would scale with REQUEST_COUNT instead of staying bounded.
		expect(recordSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(recordSpy.mock.calls.length).toBeLessThanOrEqual(MAX_EXPECTED_DIAGNOSTIC_EMISSIONS);
	});

	it("does not turn a discovery failure into an unhandled rejection", async () => {
		installFailingFetch({ discoveryUrl: DISCOVERY_URL });
		const testEnv = outageTestEnv();

		await issueBlobRequests(testEnv, REQUEST_COUNT);
		await flushMicrotasksAndTimers();

		// Without the .catch() attached at construction, the eager init
		// promise's rejection is never observed and surfaces as an unhandled
		// rejection instead of the swallow-and-count path.
		expect(rejections).toHaveLength(0);
	});

	it("/health and static assets still respond while discovery is failing", async () => {
		installFailingFetch({ discoveryUrl: DISCOVERY_URL });
		const testEnv = outageTestEnv();

		const response = await requestWithEnv("/health", testEnv);

		// The throw happens inside plugin init, which only session-context
		// consumers await. A partial-config throw is different: it happens
		// before /health is even registered, and so takes /health down too.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true });
	});
});
