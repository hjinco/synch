import english from "../locales/en.json";

export type Page = keyof typeof english;
export type MessageKey<P extends Page> = P extends Page
  ? keyof (typeof english)[P] & string
  : never;
export type Translator<P extends Page> = (
  key: MessageKey<P>,
  params?: Record<string, string | number>,
) => string;
export interface PageProps<P extends Page> {
  t: Translator<P>;
  locale: string;
}
const loaders = import.meta.glob<{
  default: Record<string, Record<string, string>>;
}>(["../locales/*.json", "!../locales/en.json"]);

export function normalizeLocale(candidate: string | null | undefined): string {
  const locale = candidate?.toLowerCase() || "";
  if (["en", "ko", "ja", "zh-cn", "zh-tw", "de"].includes(locale))
    return locale;
  for (const base of ["en", "ko", "ja", "de"])
    if (locale.startsWith(`${base}-`)) return base;
  if (
    locale === "zh-hk" ||
    locale === "zh-hant" ||
    locale.startsWith("zh-hant-")
  )
    return "zh-tw";
  if (
    locale === "zh" ||
    locale === "zh-sg" ||
    locale === "zh-hans" ||
    locale.startsWith("zh-hans-")
  )
    return "zh-cn";
  return "";
}

export function getLocale(): string {
  return (
    normalizeLocale(new URLSearchParams(location.search).get("lang")) ||
    normalizeLocale(navigator.language) ||
    "en"
  );
}

export async function translator<P extends Page>(
  page: P,
  locale: string,
): Promise<Translator<P>> {
  const fallback: Record<string, string> = english[page];
  let messages = fallback;
  const loader = locale !== "en" && loaders[`../locales/${locale}.json`];
  if (loader) {
    let timer: number | undefined;
    try {
      const loaded = await Promise.race([
        loader(),
        new Promise<null>((resolve) => {
          timer = window.setTimeout(() => resolve(null), 3000);
        }),
      ]);
      if (loaded) messages = loaded.default[page] ?? fallback;
    } catch {
      // A failed locale chunk must never block authentication or key setup.
    } finally {
      window.clearTimeout(timer);
    }
  }
  return (key, params = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      messages[key] || fallback[key] || key,
    );
}
