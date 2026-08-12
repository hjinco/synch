import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const apiPublicPages = ["device.html", "signin.html", "signup.html", "vaults.html"] as const;

const publicDir = new URL("../public/", import.meta.url);

async function readPage(page: string): Promise<string> {
	return readFile(fileURLToPath(new URL(page, publicDir).href), "utf8");
}

type Catalog = Record<string, Record<string, string>>;

async function loadCatalogs(): Promise<Map<string, Catalog>> {
	const i18nDir = new URL("i18n/", publicDir);
	const files = await readdir(fileURLToPath(i18nDir.href));
	const catalogs = new Map<string, Catalog>();
	for (const file of files) {
		const json = await readFile(fileURLToPath(new URL(file, i18nDir).href), "utf8");
		catalogs.set(file, JSON.parse(json) as Catalog);
	}
	return catalogs;
}

/**
 * Keys of the inline English catalog a page passes to createTranslator.
 * The object literals only use simple `key: "value",` entries, which keeps
 * this extraction reliable without a JS parser.
 */
function collectInlineEnglishKeys(html: string): Set<string> {
	const block = html.match(/createTranslator\("[^"]+", \{([\s\S]*?)\n\t{3}\}\);/);
	if (!block) return new Set();
	return new Set([...block[1].matchAll(/^\t{4}(\w+): "/gm)].map((match) => match[1]));
}

/** Keys a page references, via data-i18n markup or literal t("...") calls. */
function collectReferencedKeys(html: string): Set<string> {
	const keys = new Set<string>();
	for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
		keys.add(match[1]);
	}
	for (const match of html.matchAll(/\bt\("([^"]+)"/g)) {
		keys.add(match[1]);
	}
	return keys;
}

describe("API public pages", () => {
	it.each(apiPublicPages)("links the Synch logo on %s to the marketing site", async (page) => {
		const html = await readPage(page);

		expect(html).toContain('<a href="https://synch.run/"');
		expect(html).not.toContain('<a href="/"');
	});

	it.each(apiPublicPages)("loads the shared i18n runtime on %s", async (page) => {
		const html = await readPage(page);

		expect(html).toContain('<script src="/i18n.js"></script>');
	});
});

describe("API public page i18n catalogs", () => {
	it("translates every key the pages reference, in every locale", async () => {
		const catalogs = await loadCatalogs();
		expect(catalogs.size).toBeGreaterThan(0);

		for (const page of apiPublicPages) {
			const section = page.replace(".html", "");
			const referencedKeys = collectReferencedKeys(await readPage(page));
			expect(referencedKeys.size).toBeGreaterThan(0);

			for (const [file, catalog] of catalogs) {
				for (const key of referencedKeys) {
					expect(catalog[section], `${file} is missing "${key}" in "${section}"`).toHaveProperty(
						key,
					);
				}
			}
		}
	});

	it("keeps every locale catalog in sync with the inline English catalogs", async () => {
		const catalogs = await loadCatalogs();

		for (const page of apiPublicPages) {
			const section = page.replace(".html", "");
			const englishKeys = [...collectInlineEnglishKeys(await readPage(page))].sort();
			expect(englishKeys.length, `failed to extract inline English keys from ${page}`).toBeGreaterThan(0);

			for (const [file, catalog] of catalogs) {
				expect(
					Object.keys(catalog[section] ?? {}).sort(),
					`${file} "${section}" diverges from the inline English catalog in ${page}`,
				).toEqual(englishKeys);
			}
		}
	});

	it("keeps every locale catalog structurally identical", async () => {
		const catalogs = await loadCatalogs();
		const [reference, ...rest] = [...catalogs.entries()];

		const shapeOf = (catalog: Catalog) =>
			Object.fromEntries(
				Object.entries(catalog).map(([section, entries]) => [
					section,
					Object.keys(entries).sort(),
				]),
			);

		const referenceShape = shapeOf(reference[1]);
		expect(Object.keys(referenceShape).sort()).toEqual(
			apiPublicPages.map((page) => page.replace(".html", "")).sort(),
		);
		for (const [file, catalog] of rest) {
			expect(shapeOf(catalog), `${file} diverges from ${reference[0]}`).toEqual(referenceShape);
		}
	});
});
