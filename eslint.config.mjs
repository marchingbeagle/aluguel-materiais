import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/renderer/vendor/**",
    ],
  },
  js.configs.recommended,
  {
    files: [
      "src/main/**/*.js",
      "src/preload/**/*.js",
      "src/shared/**/*.js",
      "test/**/*.js",
      "jest.config.cjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
      },
    },
  },
  {
    files: ["src/renderer/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        Chart: "readonly",
        DateUtils: "readonly",
        FormState: "readonly",
      },
    },
  },
];
