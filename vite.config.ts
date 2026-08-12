import { defineConfig } from "vite-plus";

const ignored = [
  "reference/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/release/**",
  "apps/windows/Sources/T4CodeWindowsLib/Resources/xterm*.js",
];

export default defineConfig({
  lint: {
    ignorePatterns: ignored,
    rules: {
      "no-unused-vars": "error",
      "no-control-regex": "error",
      "unicorn/no-useless-spread": "error",
      "unicorn/no-useless-fallback-in-spread": "error",
      "unicorn/no-thenable": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
});
