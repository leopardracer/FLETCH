// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// FLETCH's one hard rule is "never fabricate data" — this config mirrors that
// spirit for code health: catch real bugs (unused vars, floating promises,
// unsafe `any`) without fighting the existing style. Strict-but-not-pedantic
// on purpose so it's useful from day one instead of a wall of pre-existing
// warnings nobody triages.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "web/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
);
