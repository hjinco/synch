import { describe, expect, it } from "vitest";

import { GetSystemHealthUseCase } from "./get-system-health";

describe("GetSystemHealthUseCase", () => {
	it("returns the API health status", () => {
		expect(new GetSystemHealthUseCase().execute()).toEqual({
			ok: true,
			service: "synch-api",
		});
	});
});
