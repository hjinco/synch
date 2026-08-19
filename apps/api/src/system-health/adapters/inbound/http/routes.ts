import { Hono } from "hono";

import type { GetSystemHealth } from "../../../application";

export function registerSystemHealthRoutes(
	app: Hono,
	getSystemHealth: GetSystemHealth,
): void {
	app.get("/health", (c) => c.json(getSystemHealth.execute()));
}
