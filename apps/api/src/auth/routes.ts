import { Hono } from "hono";

export type AuthHttpHandler = (request: Request) => Promise<Response>;

export function registerAuthRoutes(
	app: Hono,
	authHttpHandler: AuthHttpHandler,
	authBaseUrl: string,
): void {
	const authOrigin = new URL(authBaseUrl).origin;
	app.get("/verify-email", (c) => {
		const url = new URL(c.req.url);
		url.pathname = "/api/auth/verify-email";
		return authHttpHandler(new Request(url.toString(), c.req.raw));
	});
	app.all("/api/auth/*", (c) =>
		authHttpHandler(
			normalizeDeviceAuthorizationRequest(
				normalizeBearerSessionRequest(c.req.raw),
				authOrigin,
			),
		),
	);
}

export function normalizeDeviceAuthorizationRequest(
	request: Request,
	authOrigin: string,
): Request {
	if (!isDeviceAuthorizationClientRequest(request)) {
		return request;
	}

	const headers = new Headers(request.headers);
	// Native Obsidian mobile can send "null" or app-scheme origins for device flow
	// requests. Pin to the configured auth origin rather than the request's own:
	// behind a TLS-terminating proxy the request URL arrives on http, which never
	// matches the trusted origins built from PUBLIC_URL.
	headers.set("origin", authOrigin);
	headers.set("referer", `${authOrigin}/device`);
	// The device endpoints are unauthenticated by design, and Obsidian's mobile HTTP
	// stack shares a cookie jar with its in-app browser: a cookie left over from
	// visiting this host rides along and Better Auth then rejects the request as
	// INVALID_ORIGIN no matter what the origin header says.
	headers.delete("cookie");

	return new Request(request, {
		headers,
	});
}

export function normalizeBearerSessionRequest(request: Request): Request {
	const headers = new Headers(request.headers);
	if (!isBearerSessionHeaders(headers)) {
		return request;
	}

	headers.delete("cookie");
	return new Request(request, {
		headers,
	});
}

function isDeviceAuthorizationClientRequest(request: Request): boolean {
	if (request.method !== "POST") {
		return false;
	}

	const pathname = new URL(request.url).pathname;
	return pathname === "/api/auth/device/code" || pathname === "/api/auth/device/token";
}

function isBearerSessionHeaders(headers: Headers): boolean {
	return headers.get("authorization")?.trim().toLowerCase().startsWith("bearer ") ?? false;
}
