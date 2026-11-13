import "../src/app.css";
import type { Preview } from "@storybook/react-vite";
import { mswLoader } from "msw-storybook-addon/csf3";
import { handlers } from "../src/mocks/handlers";
import { withConsole, withTheme } from "./decorators";

const preview: Preview = {
  tags: ["autodocs"],
  // A story's parameters.msw.handlers replace the base handlers of the same name (src/mocks/handlers.ts).
  loaders: [mswLoader()],
  decorators: [withConsole, withTheme],
  globalTypes: {
    theme: {
      description: "Console theme",
      toolbar: { title: "Theme", icon: "mirror", items: [{ value: "dark", title: "Dark" }, { value: "light", title: "Light" }], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: "dark" },
  parameters: {
    layout: "fullscreen",
    msw: { handlers },
    // a11y violations fail the Vitest run. Two rules are off for agentic-ui-kit 0.9.1 bugs the console cannot fix:
    // ChatHeader renders an empty <h1> on a new chat, and ModelPicker's aria-label ("Model: Pangaea") leaves out
    // the effort its button shows. Turn them back on when the kit fixes them.
    a11y: {
      test: "error",
      config: { rules: [{ id: "empty-heading", enabled: false }, { id: "label-content-name-mismatch", enabled: false }] },
    },
    options: { storySort: { order: ["Foundations", ["Introduction", "Colors", "Typography", "Theme"], "Components", "Pages", "App"] } },
  },
};
export default preview;
