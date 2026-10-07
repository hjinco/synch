import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sharedSources = [
  "packages/sync-client/src/**/*.ts",
  "packages/vault-crypto/src/**/*.ts",
];

export default defineConfig([
  {
    name: "synch/obsidian-plugin-and-shared-runtime",
    basePath: repositoryRoot,
    files: ["apps/obsidian-plugin/src/**/*.ts", ...sharedSources],
    extends: [obsidianmd.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: true, tsconfigRootDir: repositoryRoot },
    },
  },
  {
    name: "synch/host-independent-runtime",
    basePath: repositoryRoot,
    files: sharedSources,
    rules: {
      // The shared runtime also runs in the Node CLI. It owns no popout UI and
      // must use host-neutral globals and timers instead of requiring window.
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-window-timers": "off",
    },
  },
  {
    name: "synch/legacy-host-compatibility",
    basePath: repositoryRoot,
    files: [
      "packages/sync-client/src/sync/engine/push-service.ts",
      "packages/sync-client/src/sync/runtime/sync-engine.ts",
    ],
    rules: {
      // Only the compatibility implementations may use/re-export these names.
      // New callers must use the current API; other deprecations still warn.
      "@typescript-eslint/no-deprecated": ["warn", {
        allow: [{
          from: "file",
          name: ["SyncFileSizeBlockedFile", "listFileSizeBlockedFiles", "onFileSizeBlockedFilesChange"],
        }],
      }],
    },
  },
  globalIgnores([
    "**/*.js", "**/*.mjs", "**/*.mts", "**/*.json", "**/*.test.ts",
    "**/test-stubs/**", "**/test-support/**", "**/__tests__/**", "**/test/**",
  ]),
]);
