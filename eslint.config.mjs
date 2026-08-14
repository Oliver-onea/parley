import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.nodeBuiltin,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    files: ["src/browser/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: globals.browser,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    ignores: ["exports/", "outputs/", "node_modules/"],
  },
];
