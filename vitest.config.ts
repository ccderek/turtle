import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@turtle/protocol": pkg("protocol"),
      "@turtle/core": pkg("core"),
      "@turtle/runner-claude": pkg("runner-claude"),
      "@turtle/server": pkg("server"),
      "@turtle/cli": pkg("cli"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
