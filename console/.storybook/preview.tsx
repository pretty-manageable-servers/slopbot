import "../src/app.css";
import "../src/prefs";
import "../src/stories/mock-api";
import type { Preview } from "@storybook/react-vite";
import { withConsole } from "../src/stories/console";

const preview: Preview = {
  decorators: [withConsole],
  parameters: { layout: "fullscreen" },
};
export default preview;
