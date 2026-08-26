import { defineMiddleware } from "astro/middleware";
import type { MiddlewareHandler } from "astro";

const canonicalHost = "synch.run";

const localeRedirects = [
	{ path: null, matches: ["en"] },
	{ path: "/ko/", matches: ["ko"] },
	{ path: "/ja/", matches: ["ja"] },
	{ path: "/de/", matches: ["de"] },
	{ path: "/zh-tw/", matches: ["zh-tw", "zh-hk", "zh-mo", "zh-hant"] },
	{ path: "/zh-cn/", matches: ["zh", "zh-cn", "zh-sg", "zh-my", "zh-hans"] },
] as const;

export const onRequest: MiddlewareHandler = defineMiddleware(async (context, next) => {
	const canonicalUrl = canonicalRedirectUrl(context.url);
	if (canonicalUrl) {
		return context.redirect(canonicalUrl.toString(), 301);
	}

	if (context.url.pathname !== "/") {
		return next();
	}

	if (isCrawler(context.request.headers.get("user-agent"))) {
		const response = await next();
		response.headers.append("Vary", "Accept-Language, User-Agent");
		return response;
	}

	const localePath = preferredLocalePath(context.request.headers.get("accept-language"));
	if (!localePath) {
		const response = await next();
		response.headers.append("Vary", "Accept-Language");
		return response;
	}

	const response = context.redirect(`${localePath}${context.url.search}`, 302);
	response.headers.append("Vary", "Accept-Language");
	return response;
});

function canonicalRedirectUrl(url: URL): URL | null {
	const nextUrl = new URL(url);
	let changed = false;

	if (nextUrl.hostname === `www.${canonicalHost}`) {
		nextUrl.hostname = canonicalHost;
		changed = true;
	}

	if (!isLocalHost(nextUrl.hostname) && nextUrl.protocol !== "https:") {
		nextUrl.protocol = "https:";
		changed = true;
	}

	if (shouldHaveTrailingSlash(nextUrl.pathname) && !nextUrl.pathname.endsWith("/")) {
		nextUrl.pathname = `${nextUrl.pathname}/`;
		changed = true;
	}

	return changed ? nextUrl : null;
}

function isLocalHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function shouldHaveTrailingSlash(pathname: string): boolean {
	if (pathname === "/") {
		return false;
	}

	const lastSegment = pathname.split("/").at(-1) ?? "";
	return !lastSegment.includes(".");
}

function preferredLocalePath(acceptLanguage: string | null): string | null {
	for (const language of parseAcceptLanguage(acceptLanguage)) {
		for (const locale of localeRedirects) {
			if (locale.matches.some((match) => language === match || language.startsWith(`${match}-`))) {
				return locale.path;
			}
		}
	}

	return null;
}

function parseAcceptLanguage(header: string | null): string[] {
	return (header ?? "")
		.split(",")
		.map((part, index) => {
			const [tag, ...params] = part.trim().split(";");
			const q = params
				.map((param) => param.trim().match(/^q=([0-9.]+)$/))
				.find(Boolean)?.[1];
			return {
				index,
				tag: tag.trim().toLowerCase(),
				weight: q === undefined ? 1 : Number(q),
			};
		})
		.filter((entry) => entry.tag.length > 0 && Number.isFinite(entry.weight) && entry.weight > 0)
		.sort((a, b) => b.weight - a.weight || a.index - b.index)
		.map((entry) => entry.tag);
}

function isCrawler(userAgent: string | null): boolean {
	return /bot|crawler|spider|slurp|bingpreview|google-inspectiontool/i.test(userAgent ?? "");
}
