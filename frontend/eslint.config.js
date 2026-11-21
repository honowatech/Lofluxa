import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "public/mockServiceWorker.js", "test-results", "playwright-report"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Les textes d'interface vivent dans src/i18n/fr.ts ; les types de ressources dans src/lib/types.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../features/*", "@/features/*/*"],
              message:
                "Un écran n'importe pas l'intérieur d'un autre écran : passer par src/components ou src/lib.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "src/mocks/**", "**/*.test.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
  prettier,
);
