import { defineConfig } from "vite-plus";

// written by scripts/index.ts and `bogey plugins schema`
const GENERATED = ["/index.json", "/schema/**"];

export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/dist/**", "plugins/.parked/**"] },
  staged: { "*": "vp check --fix" },
  fmt: { ignorePatterns: [...GENERATED, "**/dist/**"] },
  lint: {
    ignorePatterns: [...GENERATED, "**/dist/**"],
    plugins: ["react"],
    categories: { correctness: "error" },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error", "no-unused-vars": "warn" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    tasks: {
      index: {
        command: "node scripts/index.ts",
        cache: { input: ["plugins/*/manifest.ts", "scripts/*.ts"], output: ["index.json"] },
      },
      "index:check": {
        command: "node scripts/index.ts --check",
        cache: { input: ["plugins/*/manifest.ts", "scripts/*.ts", "index.json"] },
      },
      ready: { command: ["vp check", "vp test", "vp run index:check"], cache: false },
    },
  },
});
