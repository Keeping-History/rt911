import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";

// Flat config (ESLint 9+/10). Restores `eslint .`, which previously had no
// config file. Plugins and their rules are wired explicitly rather than via the
// plugins' bundled config objects, which still ship the legacy array-`plugins`
// shape that ESLint 10 rejects.
export default tseslint.config(
	{ ignores: ["dist", "node_modules"] },
	{
		files: ["**/*.{ts,tsx}"],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		languageOptions: {
			ecmaVersion: 2022,
			globals: globals.browser,
		},
		plugins: {
			"react-hooks": reactHooks,
			"react-refresh": reactRefresh,
		},
		rules: {
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
			"react-refresh/only-export-components": [
				"warn",
				{ allowConstantExport: true },
			],
		},
	},
	// Use flatConfigs.recommended (eslint-plugin-jsx-a11y >= 6.10) to ensure
	// every interactive element has an accessible role or label for Playwright
	// locators like getByRole() and getByLabel() to work reliably.
	jsxA11y.flatConfigs?.recommended ?? {
		plugins: { "jsx-a11y": jsxA11y },
		rules: { ...jsxA11y.configs.recommended.rules },
	},
);
