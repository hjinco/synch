"use strict";

/**
 * Shared i18n runtime for the static pages in this directory.
 *
 * English strings stay inline in each page: they are the fallback catalog and
 * double as the initial render, so English users never wait on a network
 * request and other locales degrade gracefully when /i18n/<locale>.json is
 * unreachable. Non-English catalogs live in /i18n/<locale>.json with one
 * section per page.
 */
(() => {
	const SUPPORTED_LOCALES = ["en", "ko", "ja", "zh-cn", "zh-tw", "de"];

	/**
	 * @param {string | null | undefined} candidate
	 * @returns {string}
	 */
	function normalizeLocale(candidate) {
		const locale = candidate?.toLowerCase() || "";
		if (SUPPORTED_LOCALES.includes(locale)) return locale;
		if (locale.startsWith("en-")) return "en";
		if (locale.startsWith("ko-")) return "ko";
		if (locale.startsWith("ja-")) return "ja";
		if (locale.startsWith("de-")) return "de";
		if (locale === "zh-hk" || locale === "zh-hant" || locale.startsWith("zh-hant-")) return "zh-tw";
		if (locale === "zh" || locale === "zh-sg" || locale === "zh-hans" || locale.startsWith("zh-hans-")) return "zh-cn";
		return "";
	}

	/** @returns {string} */
	function getLocale() {
		const params = new URLSearchParams(window.location.search);
		const candidates = [params.get("lang"), navigator.language];
		const selected = candidates.map(normalizeLocale).find(Boolean) || "en";
		document.documentElement.lang = selected;
		return selected;
	}

	const locale = getLocale();

	/**
	 * @typedef {Record<string, string>} MessageCatalog
	 */

	/**
	 * Returns `t` bound to the inline English catalog, plus a `ready` promise
	 * that resolves once the locale catalog has been fetched (or immediately
	 * for English). Callers re-apply translations when `ready` resolves.
	 *
	 * @param {string} page
	 * @param {MessageCatalog} englishMessages
	 */
	function createTranslator(page, englishMessages) {
		/** @type {MessageCatalog} */
		let messages = englishMessages;

		/**
		 * @param {string} key
		 * @param {Record<string, string | number>} [params]
		 * @returns {string}
		 */
		function t(key, params = {}) {
			const template = messages[key] || englishMessages[key] || key;
			return Object.entries(params).reduce(
				(text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
				template,
			);
		}

		async function loadCatalog() {
			if (locale === "en") return;
			try {
				const response = await fetch(`/i18n/${locale}.json`);
				if (!response.ok) return;
				const catalog = /** @type {unknown} */ (await response.json());
				if (!isRecord(catalog)) return;
				const pageMessages = catalog[page];
				if (isStringRecord(pageMessages)) messages = pageMessages;
			} catch {
				// Keep the inline English fallback when the catalog cannot load.
			}
		}

		// Pages gate their first dynamic render on `ready`, so cap how long a
		// stalled catalog fetch can hold the page in its initial state. A
		// catalog that arrives after the timeout still serves later t() calls.
		const timeout = new Promise((resolve) => {
			setTimeout(resolve, 3000);
		});

		return { t, ready: Promise.race([loadCatalog(), timeout]) };
	}

	/**
	 * @param {unknown} value
	 * @returns {value is Record<string, unknown>}
	 */
	function isRecord(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	/**
	 * @param {unknown} value
	 * @returns {value is MessageCatalog}
	 */
	function isStringRecord(value) {
		return (
			isRecord(value) &&
			Object.values(value).every((entry) => typeof entry === "string")
		);
	}

	/**
	 * @typedef {{
	 *   locale: string,
	 *   createTranslator: typeof createTranslator
	 * }} SynchI18n
	 */

	/** @type {Window & { synchI18n: SynchI18n }} */
	const root = window;
	root.synchI18n = { locale, createTranslator };
})();
