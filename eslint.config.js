import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "state/", "coverage/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
    },
  },
];
