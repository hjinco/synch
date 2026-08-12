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
  // *.mts: obsidianmd's recommended config applies type-checked rules to
  // *.mts, but only *.ts files are covered by the parserOptions project above.
  globalIgnores(["**/*.js", "**/*.mjs", "**/*.mts", "**/*.json", "**/*.test.ts", "src/test-stubs/*.ts", "src/test-support/*.ts", "test/**/*"]),
]);