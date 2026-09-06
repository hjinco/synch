## Project Overview

Synch is an end-to-end encrypted Obsidian Sync alternative. The repository is a pnpm workspace with:

- `apps/api`: Cloudflare Workers API, Hono, Drizzle, Better Auth.
- `apps/obsidian-plugin`: Obsidian plugin client.
- `apps/www`: Astro website.
- `packages/*`: shared workspace packages.

Prioritize preserving end-to-end encryption guarantees, vault safety, and compatibility with Obsidian plugin behavior.

## Engineering Approach

Favor long-term maintainability over quick patches. Do not paper over symptoms with narrow, brittle fixes when the surrounding design needs adjustment.

- Understand the relevant module boundaries, data flow, and existing abstractions before changing code.
- Prefer cohesive fixes that address the underlying cause while preserving the current architecture and user-facing behavior.
- Keep changes scoped, but make the scope large enough to avoid duplicating logic, bypassing invariants, or adding special cases that future work will have to unwind.
- When a short-term workaround is unavoidable, document the reason, the tradeoff, and the follow-up needed to remove it.

## Testing Guidelines

Tests must verify behavior and contracts, not mirror the implementation. Avoid change-detector tests that break on harmless edits without catching real bugs.

- Assert stable identifiers (`code`, `status`, error class), not user-facing text. Do not re-type UI copy, email subjects, or config tables (plan limits, pricing) into tests — derive expectations from the source (`t(key, params)`, `getSubscriptionPlanPolicy(...)`) instead. If a failure has no stable identifier, assert the behavior (rejects, no side effect) rather than locking the wording.
- Never encode expected behavior in a test double that production code does not implement; the test then verifies the mock. Keep fakes as thin pass-throughs.
- Exact-value assertions are correct where the value is the contract: wire formats, HTTP status and error codes, header/cookie names, crypto parameters, security-relevant redaction, i18n fallback/interpolation logic, and accessibility labels.

## Package Manager

Use `pnpm`. Do not use `npm` or `yarn`.

## Common Commands

From the repository root:

```sh
pnpm -C apps/api test:unit
pnpm -C apps/api test:integration:cloudflare
pnpm -C apps/api test:e2e:node
pnpm -C apps/api typecheck

pnpm -C apps/obsidian-plugin test
pnpm -C apps/obsidian-plugin typecheck
pnpm -C apps/obsidian-plugin build

pnpm -C apps/www build
```
