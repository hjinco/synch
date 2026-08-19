import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { GetSystemHealthUseCase } from "../../../application/use-cases/get-system-health";
import { registerSystemHealthRoutes } from "./routes";

describe("system health routes", () => {
	it("returns the existing health wire contract", async () => {
		const app = new Hono();
		registerSystemHealthRoutes(app, new GetSystemHealthUseCase());

		const response = await app.request("/health");

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			service: "synch-api",
		});
	});
});
