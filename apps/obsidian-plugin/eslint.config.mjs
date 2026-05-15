import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: true },
    }
  },
  globalIgnores(["**/*.js", "**/*.mjs", "**/*.json", "**/*.test.ts", "src/test-stubs/*.ts", "src/test-support/*.ts", "test/**/*"]),
]);