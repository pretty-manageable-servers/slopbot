import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The new console. The bot serves the build at /console. In development Vite proxies the API to a running bot.
const bot = process.env.SLOPBOT_URL ?? "http://localhost:3000";

export default defineConfig({
  base: "/console/",
  plugins: [react(), tailwindcss()],
  // The show_ui specs are in the bot (../src/ui) and import the kit from the bot's node_modules. One copy is used.
  resolve: { dedupe: ["agentic-ui-kit", "react", "react-dom"] },
  // No data: URLs: the console CSP allows fonts and images from the bot only.
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets", assetsInlineLimit: 0 },
  server: { port: 5174, strictPort: true, proxy: { "/api": { target: bot, changeOrigin: false }, "/auth": bot } },
});
