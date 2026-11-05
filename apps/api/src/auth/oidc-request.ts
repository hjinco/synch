/**
 * Better Auth endpoints that require an external provider, rather than just a
 * local session/account. Keep provider selection here so password, device and
 * session routes never initialize discovery. Better Auth still validates the
 * original request, including its origin, body, OAuth state and credentials.
 */
export async function isOidcRequest(request: Request, pathname: string): Promise<boolean> {
	const path = pathname.replace(/\/$/, "");
	if (path === "/api/auth/callback/oidc") return true;
	if (path === "/api/auth/account-info") {
		const provider = new URL(request.url).searchParams.get("providerId");
		return provider === null || provider === "oidc";
	}
	const field = path === "/api/auth/sign-in/social" || path === "/api/auth/link-social"
		? "provider"
		: path === "/api/auth/get-access-token" || path === "/api/auth/refresh-token"
			? "providerId"
			: undefined;
	if (!field || request.method !== "POST") return false;
	try {
		const copy = request.clone();
		const contentType = request.headers.get("content-type") ?? "";
		const body: unknown = contentType.includes("application/x-www-form-urlencoded")
			? Object.fromEntries(new URLSearchParams(await copy.text()))
			: await copy.json();
		if (!body || typeof body !== "object") return false;
		const provider = (body as Record<string, unknown>)[field];
		// Token/account endpoints can select an account by its database ID
		// without naming its provider; that selection needs the full context.
		return provider === "oidc" || (field === "providerId" && provider === undefined);
	} catch {
		return false;
	}
}
