import { createMiddleware } from "hono/factory";

import type {
	AuthenticatedUser,
	SessionReader,
} from "../../auth/session";
import { apiError } from "../../errors";

export type AuthenticatedSessionVariables = {
	user: AuthenticatedUser;
};

/** Technical Hono adapter shared by HTTP features requiring a session. */
export function createEnsureAuthenticatedSession(sessionReader: SessionReader) {
	return createMiddleware<{
		Variables: AuthenticatedSessionVariables;
	}>(async (c, next) => {
		const request = c.req.raw;
		const data = await sessionReader.readSession({
			url: new URL(request.url),
			authorization: request.headers.get("authorization") ?? undefined,
			cookie: request.headers.get("cookie") ?? undefined,
		});
		if (!data) {
			throw apiError(401, "unauthorized", "authentication required");
		}
		c.set("user", data.user);
		await next();
	});
}
