import js from "@eslint/js";
import globals from "globals";

/** Globals Foundry v14 and dnd5e provide in the browser. */
const foundryGlobals = {
  foundry: "readonly",
  game: "readonly",
  CONFIG: "readonly",
  CONST: "readonly",
  Hooks: "readonly",
  ui: "readonly",
  canvas: "readonly",
  Actor: "readonly",
  Item: "readonly",
  User: "readonly",
  ChatMessage: "readonly",
  Roll: "readonly",
  dnd5e: "readonly",
  fromUuid: "readonly"
};

export default [
  { ignores: ["node_modules/**", "dist/**", "docs/**"] },
  js.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "quench/**/*.mjs", "spike/**/*.mjs", "dev/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...foundryGlobals }
    }
  },
  {
    files: ["dev/**/*.js"],
    languageOptions: { sourceType: "script" }
  },
  {
    files: ["test/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node
    }
  },
  {
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
      eqeqeq: ["error", "smart"]
    }
  }
];
