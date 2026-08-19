import { Hono } from "hono";

import type { AuthHttpHandler } from "./handler";
import {
	normalizeBearerSessionRequest,
	normalizeDeviceAuthorizationRequest,
} from "./request-normalization";

export function registerAuthRoutes(
	app: Hono,
	authHttpHandler: AuthHttpHandler,
): void {
	app.get("/verify-email", (c) => {
		const url = new URL(c.req.url);
		url.pathname = "/api/auth/verify-email";
		return authHttpHandler.handle(new Request(url.toString(), c.req.raw));
	});
	app.all("/api/auth/*", (c) =>
		authHttpHandler.handle(
			normalizeDeviceAuthorizationRequest(
				normalizeBearerSessionRequest(c.req.raw),
			),
		),
	);
}
