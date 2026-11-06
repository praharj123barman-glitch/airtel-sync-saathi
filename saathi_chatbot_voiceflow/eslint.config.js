/*
 * eslint.config.js: lint rules for this project's JavaScript.
 * - _build/*.js        → Voiceflow function templates: ES2020 modules, no imports, only `fetch` is available.
 * - 6_tests/*.mjs, _build/*.mjs → Node.js (test runner, back-office sample builder).
 * Generated files in 3_function_tools/ are skipped; they are rebuilt from _build/ by _build/gen_kit.py.
 */
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "3_function_tools/"] },
  js.configs.recommended,
  {
    files: ["_build/**/*.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      // Voiceflow's function runtime exposes `fetch` (and console for its test panel) and nothing else.
      globals: { fetch: "readonly", console: "readonly" },
    },
    rules: {
      // Imports are not supported by Voiceflow function tools.
      "no-restricted-syntax": [
        "error",
        { selector: "ImportDeclaration", message: "Voiceflow functions cannot import modules." },
      ],
    },
  },
  {
    files: ["6_tests/**/*.mjs", "_build/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.node },
  },
];
