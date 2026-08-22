import { describe, expect, it } from "vitest";

import { shouldReplaceSocketSession } from "./socket-policy";

describe("shouldReplaceSocketSession", () => {
	it("replaces a session for the same user and local vault", () => {
		expect(
			shouldReplaceSocketSession(
				{ userId: "user-1", localVaultId: "local-1" },
				{ userId: "user-1", localVaultId: "local-1" },
			),
		).toBe(true);
	});

	it("keeps sessions for different identities", () => {
		expect(
			shouldReplaceSocketSession(
				{ userId: "user-1", localVaultId: "local-1" },
				{ userId: "user-2", localVaultId: "local-1" },
			),
		).toBe(false);
		expect(
			shouldReplaceSocketSession(
				{ userId: "user-1", localVaultId: "local-1" },
				{ userId: "user-1", localVaultId: "local-2" },
			),
		).toBe(false);
	});
});
