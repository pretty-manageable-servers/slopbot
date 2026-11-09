// Two kinds of tests: unit tests (src/**/*.test.ts, Node) and every story as a browser test (Playwright, Chrome),
// once per theme. `pnpm test` runs the unit tests; `pnpm test:stories` runs the stories.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const stories = (theme: "dark" | "light") => ({
  extends: true,
  plugins: [storybookTest({ configDir: path.join(dirname, ".storybook"), storybookScript: "pnpm storybook", storybookUrl: "http://localhost:6106", initialGlobals: { theme } })],
  test: {
    name: `storybook-${theme}`,
    browser: { enabled: true, headless: true, provider: playwright({ launchOptions: { channel: "chrome" } }), instances: [{ browser: "chromium" as const }] },
  },
});

export default mergeConfig(viteConfig, defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.{ts,tsx}"] } },
      stories("dark"),
      stories("light"),
    ],
  },
}));
