/* ESLint — flat config. Type-aware rules read tsconfig.json, so the lint
   pass sees real types, not just syntax. The generated API client is
   excluded: it is machine-written and committed as-is (see README). */
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "coverage", "src/api/schema.d.ts"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],

      // Async functions as event handlers are an accepted React idiom;
      // floating ones (the cases that actually swallow rejections) are
      // caught by no-floating-promises.
      "@typescript-eslint/no-misused-promises": "off",
      // `async` without `await` keeps call-site signatures uniform.
      "@typescript-eslint/require-await": "off",
      // `||` on strings (e.g. `id || ""`) is often deliberate; this rule
      // reads intent where there is none.
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      // No-op arrows and mock objects (IntersectionObserver stubs, …) are
      // normal in a UI codebase.
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/unbound-method": "off",

      // React Compiler set (react-hooks v7). Real findings, but each wants
      // a dedicated refactor; tracked for a follow-up pass, not silently
      // dropped. exhaustive-deps stays on — as a warning while the
      // windowing callbacks settle.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/incompatible-library": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
