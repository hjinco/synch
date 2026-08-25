import { Hono } from "hono";

export type AuthHttpHandler = (request: Request) => Promise<Response>;

export function registerAuthRoutes(
	app: Hono,
	authHttpHandler: AuthHttpHandler,
): void {
	app.get("/verify-email", (c) => {
		const url = new URL(c.req.url);
		url.pathname = "/api/auth/verify-email";
		return authHttpHandler(new Request(url.toString(), c.req.raw));
	});
	app.all("/api/auth/*", (c) =>
		authHttpHandler(
			normalizeDeviceAuthorizationRequest(
				normalizeBearerSessionRequest(c.req.raw),
			),
		),
	);
}

export function normalizeDeviceAuthorizationRequest(request: Request): Request {
	if (!isDeviceAuthorizationClientRequest(request)) {
		return request;
	}

	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	// Native Obsidian mobile can send "null" or app-scheme origins for device flow requests.
	headers.set("origin", url.origin);
	headers.set("referer", `${url.origin}/device`);

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
