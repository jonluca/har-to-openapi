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
  ...globals.serviceworker,
  ...globals.es2021,
  ...globals.worker,
  ...globals.node,
};

export default tseslint.config({
  ignores: [
    "client/cypress/plugins/index.js",
    ".lintstagedrc.js",
    ".next/**/*",
    "public/js/*",
    ".yarn/js/*",
    "ui/out/**/*",
    "apps/expo/ios/**/*",
    "apps/expo/android/**/*",
    "electron/build/**/*",
    "public/*.js",
    "public/*.map",
  ],

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
    "import-x/resolver": {
      typescript: {
        alwaysTryTypes: true, // always try to resolve types under `<root>@types` directory even it doesn't contain any source code, like `@types/unist`

        // Choose from one of the "project" configs below or omit to use <root>/tsconfig.json by default

        // // use <root>/path/to/folder/tsconfig.json
        // project: "path/to/folder",
        //
        // // Multiple tsconfigs (Useful for monorepos)
        //
        // // use a glob pattern
        // project: "packages/*/tsconfig.json",
        //
        // // use an array
        // project: ["packages/module-a/tsconfig.json", "packages/module-b/tsconfig.json"],
        //
        // // use an array of glob patterns
        // project: ["packages/*/tsconfig.json", "other-packages/*/tsconfig.json"],
      },
    },
  },
});
