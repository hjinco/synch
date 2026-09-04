import type { Context, Hono } from "hono";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function registerRedirectRoutes(app: Hono): void {
	app.get("/redirect", handleRedirect);
	app.get("/redirect/", handleRedirect);
}

function handleRedirect(c: Context) {
	const target = getLoopbackTarget(c.req.query("url"));
	if (!target) {
		return c.json(
			{
				error: "invalid_redirect_target",
				message: "A localhost HTTP(S) URL is required.",
			},
			400,
		);
	}

	c.header("Cache-Control", "no-store");
	return c.redirect(target.toString(), 302);
}

export function getLoopbackTarget(value: string | undefined): URL | null {
	if (!value) {
		return null;
	}

	try {
		const target = new URL(value);
		if (
			(target.protocol !== "http:" && target.protocol !== "https:") ||
			target.username ||
			target.password ||
			(target.pathname !== "/device" && target.pathname !== "/device/") ||
			!LOOPBACK_HOSTS.has(target.hostname)
		) {
			return null;
		}

		return target;
	} catch {
		return null;
	}
}
