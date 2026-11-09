import type { StorybookConfig } from "@storybook/react-vite";

// The console's components and pages on a fake bot (MSW, src/mocks). The kit's own parts have their own Storybook
// in agentic-ui-kit.
const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: { name: "@storybook/react-vite", options: {} },
  // The MSW worker (mockServiceWorker.js) is served from here.
  staticDirs: ["../src/mocks/public"],
  // The app's Vite config serves under /console/ and proxies the bot; Storybook needs neither.
  viteFinal: (vite) => ({ ...vite, base: "/", server: { ...vite.server, proxy: {} } }),
};
export default config;
