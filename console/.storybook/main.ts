import type { StorybookConfig } from "@storybook/react-vite";

// Stories for the console's own parts, drawn with a fake bot API (src/stories/mock-api.ts). The kit's parts have
// their own Storybook in agentic-ui-kit.
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: {} },
  // The app's Vite config serves under /console/ and proxies the bot; Storybook needs neither.
  viteFinal: (vite) => ({ ...vite, base: "/", server: { ...vite.server, proxy: {} } }),
};
export default config;
