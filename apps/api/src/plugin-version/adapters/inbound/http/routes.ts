import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { CheckPluginVersion } from "../../../application";
import { isStrictSemver } from "../../../domain/policy";

const versionCheckQuerySchema = z.object({
	version: z.string().refine(isStrictSemver, {
		message: "version must be a strict x.y.z version",
	}),
});

export function registerPluginVersionRoutes(
	app: Hono,
	checkPluginVersion: CheckPluginVersion,
): void {
	app.get(
		"/v1/obsidian-plugin/version-check",
		zValidator("query", versionCheckQuerySchema),
		(c) => {
			const { version } = c.req.valid("query");

			return c.json(checkPluginVersion.execute(version));
		},
	);
}
