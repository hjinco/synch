import tsparser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: true },
    }
  },
  globalIgnores(["**/*.js", "**/*.mjs", "**/*.json", "**/*.test.ts", "src/test-stubs/*.ts", "src/test-support/*.ts", "test/**/*"]),
]);