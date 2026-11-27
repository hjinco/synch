# API web UI

The six existing routes (`/signin`, `/signup`, `/device`, `/vaults`,
`/organizations`, `/invitations`) are a Vite + React + TypeScript multi-page app.
Each HTML entry mounts its page; shared components, API helpers, styles, and
translation catalogs live under `src/`. There is no SPA fallback: missing API
routes must keep returning API errors on both Cloudflare and Node.

## Build and deployment

From the repository root:

```sh
pnpm -C apps/api build:public
pnpm -C apps/api check:vault-crypto
pnpm -C apps/api typecheck:web
pnpm -C apps/api test:web
```

Edit `web/`, not `public/`. `build:public` replaces `apps/api/public` with the
complete production output, including hashed JS/CSS and copied `static/` files.
`public/` is ignored by Git. Commit `web/` source, static assets, and generated
`web/vendor/` changes. `check:vault-crypto` verifies the committed crypto bundle
and declarations against the shared source without rewriting them. CI runs this
check before any build so a stale vendor artifact cannot be silently refreshed.
The unit and Node E2E test commands build the UI before testing its generated
assets. CI also checks locale keys and runs React interaction tests.

Cloudflare build/deploy scripts explicitly build the UI before invoking Wrangler.
This also supports older self-host clones whose preserved `wrangler.jsonc` lacks
the custom build hook. Current configurations retain the hook for direct Wrangler
invocations and development; package-script deployments therefore run the build
again through that hook. `build:node` builds the UI before copying `public/` into
the Node artifact, including Docker builds; `dev:node` also builds first.
Neither runtime needs Vite or React running in production.

For an older self-host clone using a direct `wrangler deploy` command, change the
deployment command to `pnpm run deploy` or add the current custom build hook.
Do not replace resource bindings in its existing `wrangler.jsonc`.

### Standalone templates and encryption

Deploy to Cloudflare copies only `apps/api`, and the Docker build also has no
shared package source. `web/vendor/vault-crypto.js` and its TypeScript declarations
are therefore committed generated artifacts of `packages/vault-crypto/src`.
In a workspace, `build:public` regenerates them and `check:vault-crypto` verifies them.
Without that package, the same commands use the committed artifacts. Do not edit
vendor files or create a separate encryption implementation here.

Vite bundles this module as a lazy, same-origin chunk. Vault password validation,
key generation, and production-strength Argon2id wrapping stay in the browser.
Only the encrypted key envelope is sent to the API. No password or unencrypted
vault key is persisted in browser storage or transmitted.

## Local development

Use two terminals after setting up the usual API local secrets and migrations:

```sh
pnpm -C apps/api dev:web:api
pnpm -C apps/api dev:web
```

Open `http://127.0.0.1:5173/signin`. Vite provides React fast refresh and proxies
`/api/*` and `/v1/*` to `http://127.0.0.1:8787`. The dedicated `dev:web:api` command
sets Better Auth's public URL to the Vite origin, keeping callback URLs and
trusted-origin checks consistent. Use `127.0.0.1`, not `localhost`, for this flow.
The ordinary `dev` command still serves the compiled UI on the API port.

For a Node backend, run it on port 8787 with
`PUBLIC_URL=http://127.0.0.1:5173` (and the normal Node configuration), then run
`dev:web`. Run `build:public` after changing shared vault crypto source so the
vendored module is refreshed before using the Vite dev server.

## Optional Google and GitHub sign-in

Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the API server to enable
Google on `/signin` and `/signup`. Set `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` to enable GitHub independently. Missing, blank, or partial
configuration keeps that provider and its button disabled; email/password login remains available.
The web build needs no credentials: `/api/auth/providers` reports availability at
runtime and never returns either credential.

Create a GitHub **OAuth App** with the authorization callback URL
`<public API origin>/v1/auth/callback/github`.

Create a Google OAuth **Web application** and register the exact redirect URI
`<public API origin>/v1/auth/callback/google`. For Node, use the `PUBLIC_URL`
origin; for Cloudflare, use the `BETTER_AUTH_URL` origin (set it explicitly for a
stable public callback). With the Vite development setup above, the URI is
`http://127.0.0.1:5173/v1/auth/callback/google`.

For Node/Docker, set the credential pair for each provider you want to enable in `apps/api/.env` and restart the server.
For Cloudflare, configure them as Worker secrets, using the same environment as
your deployment (omit `--env managed` for community):

```sh
pnpm -C apps/api exec wrangler secret put GOOGLE_CLIENT_ID --env managed
pnpm -C apps/api exec wrangler secret put GOOGLE_CLIENT_SECRET --env managed
pnpm -C apps/api exec wrangler secret put GITHUB_CLIENT_ID --env managed
pnpm -C apps/api exec wrangler secret put GITHUB_CLIENT_SECRET --env managed
```

Social sign-up uses the existing account creation hooks, including the self-hosted
email allowlist and personal organization setup. Better Auth handles OAuth state,
provider verification, and account linking. A verified
provider email is required for every social login, including returning users;
unverified provider emails are rejected before creating accounts or sessions.
On self-hosted servers, a verified
provider email can link to an existing email/password account with the same
address without local email verification. Managed deployments still require the
existing account's email to be verified. The
post-login destination is preserved, including device approval for Obsidian and
CLI clients. Vault passwords and encryption keys remain separate from social login.

Email/password sign-up rejects an already registered email, including accounts
created through Google or GitHub. It does not add a password to a social account
or show a verification-email success message for duplicate registrations.

Authentication buttons mark the last successful login method used in this browser.
Better Auth stores this hint in a readable cookie for 30 days, without adding a
database field. Failed or canceled attempts do not replace the hint, and signing
out preserves it. Clearing browser cookies removes it.

## Auth route compatibility

Both `/api/auth/*` and `/v1/auth/*` reach the same authentication handler, sessions,
and policies. The versioned route is an internal alias, not an HTTP redirect:
request methods, bodies, query parameters, and cookies are preserved. Device
client and bearer-token normalization apply equally to both routes.

Google and GitHub authorization requests and token exchanges use
`/v1/auth/callback/google` and `/v1/auth/callback/github`. Register those exact URLs
with the providers, regardless of which route starts sign-in. When upgrading from
`/api/auth/callback/...`, update the provider's registered callback URL as well.
The legacy routes, existing clients, and email verification links remain available.

## Storybook: manual visual review

```sh
pnpm -C apps/api storybook             # http://localhost:6006
pnpm -C apps/api build:storybook       # apps/api/storybook-static
pnpm -C apps/api typecheck:storybook
```

The six English pages use the production React components and stylesheet.
Choose a state in the sidebar (loading, error, empty, verification, device
approval, invitations, organization roles, or vault dialogs). The viewport
menu offers Desktop (1440 × 900) and Mobile (390 × 844). Open the addon panel
from the toolbar to inspect story interactions.

Stories live in `web/stories`; config and the generated MSW worker live in
`.storybook`. MSW intercepts API requests before rendering, including a fallback
that rejects unmocked API actions. No API process, database, account, or secrets
are needed. Form errors and verification states use `play` to exercise the real
form; vault dialogs retain the production browser-only crypto implementation.
Use example credentials only. Navigation links still represent the real app
routes; select another story through the sidebar rather than navigating through
the preview. Use Reload story to reset a scenario.

This is a manual preview catalog, not a screenshot regression suite. The mock
worker is served only by Storybook and is not copied to the API's public build.
When upgrading MSW, regenerate it with
`pnpm -C apps/api exec msw init .storybook/public --save`.
