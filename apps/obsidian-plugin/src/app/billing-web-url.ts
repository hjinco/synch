export type BillingWebPage = "pricing" | "billing";
export type BillingWebLocale = "en" | "ko" | "ja" | "zh-cn" | "zh-tw";

export function buildBillingWebPageUrl(
  apiBaseUrl: string,
  page: BillingWebPage,
  locale: BillingWebLocale,
): string {
  const path = locale === "en" ? `/${page}` : `/${locale}/${page}`;
  return new URL(path, inferWebBaseUrl(apiBaseUrl)).toString();
}

function inferWebBaseUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  const host = url.hostname.toLowerCase();

  if (host === "api.synch.run" || host.endsWith(".api.synch.run")) {
    return "https://synch.run";
  }

  if (
    (host === "127.0.0.1" || host === "localhost") &&
    url.port === "8787"
  ) {
    return "http://localhost:4321";
  }

  return "https://synch.run";
}
