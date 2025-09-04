import eslint from "@eslint/js";
import prettierPlugin from "eslint-plugin-prettier";
import unusedImportsPlugin from "eslint-plugin-unused-imports";
import prettierExtends from "eslint-config-prettier";
import { fixupPluginRules } from "@eslint/compat";
import globals from "globals";
import tseslint from "typescript-eslint";
import promisePlugin from "eslint-plugin-promise";

const globalToUse = {
  ...globals.browser,
  ...globals.es2021,
  ...globals.node,
};

export default tseslint.config({
  ignores: ["dist/**/*", ".yarn/js/*", "coverage/**/*"],

  extends: [
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    promisePlugin.configs["flat/recommended"],
    prettierExtends,
  ],
  plugins: {
    promise: promisePlugin,
    prettierPlugin,
    "unused-imports": fixupPluginRules(unusedImportsPlugin),
  },
  rules: {
    "no-constant-condition": ["error", { checkLoops: false }],
    "@typescript-eslint/ban-types": "off",
    "no-prototype-builtins": "off",
    "no-html-link-for-pages": "off",
    "@typescript-eslint/no-use-before-define": "off",
    "prefer-const": "error",
    curly: ["error", "all"],
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-empty": "off",
    "no-case-declarations": "off",
    "@typescript-eslint/no-unused-expressions": "off",
    "no-control-regex": "off",
    "promise/always-return": "off",
    "promise/catch-or-return": "off",
    "promise/param-names": "off",
    "@typescript-eslint/no-namespace": "off",
    "@typescript-eslint/no-empty-interface": "off",
    "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
    "@typescript-eslint/consistent-type-imports": [
      "error",
      {
        prefer: "type-imports",
      },
    ],
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "unused-imports/no-unused-imports": "error",
    "object-shorthand": "error",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { varsIgnorePattern: "^_", argsIgnorePattern: "^_", ignoreRestSiblings: true },
    ],
  },
  languageOptions: {
    globals: globalToUse,
    parserOptions: {
      ecmaFeatures: {
        jsx: true,
      },
    },
  },
  settings: {
    react: { version: "detect" },
  },
});
