import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const apiPublicPages = ["device.html", "signin.html", "signup.html", "vaults.html"] as const;

describe("API public pages", () => {
	it.each(apiPublicPages)("links the Synch logo on %s to the marketing site", async (page) => {
		const html = await readFile(new URL(`../public/${page}`, import.meta.url).pathname, "utf8");

		expect(html).toContain('<a href="https://synch.run/"');
		expect(html).not.toContain('<a href="/"');
	});
});
