/**
 * Better Auth endpoints that require an external provider, rather than just a
 * local session/account. Keep provider selection here so password, device and
 * session routes never initialize discovery. Better Auth still validates the
 * original request, including its origin, body, OAuth state and credentials.
 */
export async function isOidcRequest(
	request: Request,
	pathname: string,
	resolveAccountProvider: (accountId: string) => Promise<string | undefined>,
): Promise<boolean> {
	const path = pathname.replace(/\/$/, "");
	if (path === "/api/auth/callback/oidc") return true;
	const isAccountRequest = path === "/api/auth/account-info"
		|| path === "/api/auth/get-access-token" || path === "/api/auth/refresh-token";
	const isSocialRequest = path === "/api/auth/sign-in/social" || path === "/api/auth/link-social";
	if (!isAccountRequest && !isSocialRequest) return false;
	if (request.method !== (path === "/api/auth/account-info" ? "GET" : "POST")) return false;
	try {
		const copy = request.clone();
		const contentType = request.headers.get("content-type") ?? "";
		const body: unknown = request.method === "GET"
			? Object.fromEntries(new URL(request.url).searchParams)
			: contentType.includes("application/x-www-form-urlencoded")
				? Object.fromEntries(new URLSearchParams(await copy.text()))
				: await copy.json();
		if (!body || typeof body !== "object") return false;
		const selection = body as Record<string, unknown>;
		if (isSocialRequest) return selection.provider === "oidc";
		// Better Auth selects tokens/profile by the database row ID, not providerId.
		// Synch does not enable account.storeAccountCookie, so cookie selection
		// cannot resolve an account and should fail in the ordinary handler.
		if (typeof selection.accountId !== "string") return false;
		return await resolveAccountProvider(selection.accountId) === "oidc";
	} catch {
		return false;
	}
}
