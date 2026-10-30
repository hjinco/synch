// wrangler.jsonc is JSONC (comments allowed) and this repo commits to zero new
// dependencies, so this test avoids a JSONC parser and instead extracts the
// two `secrets.required` array spans as raw text, mirroring the technique
// src/public-pages.test.ts uses for its own no-new-dependency constraint.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url).href);
const wranglerPath = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url).href);

const oidcVariables = ["OIDC_DISCOVERY_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const;

/**
 * Extracts each `"secrets": { "required": [...] }` array body from the raw
 * wrangler.jsonc text. There are exactly two: the default self-hosted env
 * and the `managed` env.
 */
function extractRequiredSecretsSpans(text: string): string[] {
	const matches = [...text.matchAll(/"secrets":\s*\{\s*"required":\s*\[([\s\S]*?)\]/g)];
	return matches.map((match) => match[1]);
}

describe("wrangler.jsonc secrets.required", () => {
	it("never lists the OIDC variables as required secrets in either wrangler environment", () => {
		const text = readFileSync(wranglerPath, "utf8");
		const spans = extractRequiredSecretsSpans(text);

		expect(spans).toHaveLength(2);

		for (const span of spans) {
			for (const variable of oidcVariables) {
				expect(span).not.toContain(variable);
			}
		}
	});

	it("keeps AUTH_ALLOWED_EMAILS required in the default self-hosted environment", () => {
		const text = readFileSync(wranglerPath, "utf8");
		const [defaultSpan] = extractRequiredSecretsSpans(text);

		expect(defaultSpan).toContain("AUTH_ALLOWED_EMAILS");
	});

	it("documents each new OIDC variable in package.json's cloudflare.bindings", () => {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			cloudflare?: { bindings?: Record<string, unknown> };
		};
		const bindings = packageJson.cloudflare?.bindings ?? {};

		for (const variable of [...oidcVariables, "OIDC_PROVIDER_NAME", "OIDC_SCOPES", "OIDC_ACCOUNT_ISSUER", "AUTH_EMAIL_PASSWORD"]) {
			expect(bindings, `cloudflare.bindings is missing "${variable}"`).toHaveProperty(variable);
		}
	});
});
