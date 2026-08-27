import { describe, expect, it } from "vitest";

import { displayNameFromAuthenticatedUser } from "./session";

describe("displayNameFromAuthenticatedUser", () => {
	it("prefers a trimmed account name over email", () => {
		expect(
			displayNameFromAuthenticatedUser({
				id: "user-1",
				email: "ada@example.com",
				name: "  Ada  ",
			}),
		).toBe("Ada");
	});

	it("falls back to email when the account has no name", () => {
		expect(
			displayNameFromAuthenticatedUser({
				id: "user-1",
				email: "ada@example.com",
				name: "  ",
			}),
		).toBe("ada@example.com");
	});
});
