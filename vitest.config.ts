import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Written by the localbase/test-infrastructure work. Integration tests need it; until it exists
// the project still loads so unit and db suites can run.
const integrationGlobalSetup = "tests/helpers/global-setup.ts";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${fromRoot("./src")}/` },
      { find: /^server-only$/, replacement: fromRoot("./tests/helpers/empty-module.ts") },
    ],
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts", "tests/routes/**/*.test.ts", "tests/localbase/**/*.test.ts"],
          globalSetup: existsSync(fromRoot(`./${integrationGlobalSetup}`)) ? [integrationGlobalSetup] : [],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
