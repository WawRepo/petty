import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

// jsx-a11y recommended, but as warnings: rule 10 in CLAUDE.md is enforced by review and axe in e2e;
// these catch regressions without turning CI red on the existing tree (PETTY-212).
const a11yWarn = Object.fromEntries(Object.keys(jsxA11y.flatConfigs.recommended.rules).map((r) => [r, "warn"]));

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/dev-dist/**", "apps/mcp/mcpb/server/**", "apps/web/public/downloads/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // React rules only where React runs.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      ...a11yWarn,
      "jsx-a11y/no-autofocus": "off", // Petty deliberately focuses the first field when a sheet opens
      "jsx-a11y/label-has-for": "off", // deprecated rule; labels here associate by wrapping or htmlFor
    },
  },
);
