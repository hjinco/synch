export const SYNCH_DEVICE_LOGIN_RETURN_URI = "obsidian://synch-device-login";
export const SYNCH_LOCALHOST_REDIRECT_URL = "https://api.synch.run/redirect/";

export function openExternalUrl(
	url: string,
	options: { redirectLocalhost?: boolean } = {},
): void {
	window.open(
		options.redirectLocalhost ? redirectLocalhostUrl(url) : url,
		"_external",
		"noopener,noreferrer",
	);
}

function redirectLocalhostUrl(url: string): string {
	try {
		const target = new URL(url);
		if (!isLoopbackHost(target.hostname)) {
			return url;
		}

		const redirect = new URL(SYNCH_LOCALHOST_REDIRECT_URL);
		redirect.searchParams.set("url", target.toString());
		return redirect.toString();
	} catch {
		return url;
	}
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
