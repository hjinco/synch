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

## Package Manager

Use `pnpm`. Do not use `npm` or `yarn`.

## Common Commands

From the repository root:

```sh
pnpm -C apps/api test:unit
pnpm -C apps/api test:integration:cloudflare
pnpm -C apps/api test:e2e:node
pnpm -C apps/api test:smoke
pnpm -C apps/api typecheck

pnpm -C apps/obsidian-plugin test
pnpm -C apps/obsidian-plugin typecheck
pnpm -C apps/obsidian-plugin build

pnpm -C apps/www build
```
