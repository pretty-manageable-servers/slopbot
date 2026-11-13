// Two kinds of tests: unit tests (src/**/*.test.ts, Node) and every story as a browser test (Playwright, Chrome),
// once per theme. `pnpm test` runs the unit tests; `pnpm test:stories` runs the stories.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Each theme runs its own browser; they start together, so each gets its own port.
const stories = (theme: "dark" | "light", port: number) => ({
  extends: true,
  plugins: [storybookTest({ configDir: path.join(dirname, ".storybook"), storybookScript: "pnpm storybook", storybookUrl: "http://localhost:6106", initialGlobals: { theme } })],
  test: {
    name: `storybook-${theme}`,
    setupFiles: [path.join(dirname, ".storybook/vitest.setup.ts")],
    browser: { enabled: true, headless: true, api: { port, strictPort: true }, provider: playwright({ launchOptions: { channel: "chrome" } }), instances: [{ browser: "chromium" as const }] },
  },
});

export default mergeConfig(viteConfig, defineConfig({
  // Found late, Vite re-bundles these mid-run and reloads the browser, which fails the run. Bundle them up front.
  optimizeDeps: { include: ["lucide-react", "@phosphor-icons/react", "msw", "msw/browser", "msw/sse", "msw-storybook-addon/csf3", "storybook/test", "agentic-ui-kit", "react-aria-components", "@tanstack/react-query", "@tanstack/react-router"] },
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.{ts,tsx}"] } },
      stories("dark", 23315),
      stories("light", 23316),
    ],
  },
}));
