import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The new console. The bot serves the build at /console/next. In development Vite proxies the API to a running bot.
const bot = process.env.SLOPBOT_URL ?? "http://localhost:3000";

export default defineConfig({
  base: "/console/next/",
  plugins: [react()],
  // No data: URLs: the console CSP allows fonts and images from the bot only.
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets", assetsInlineLimit: 0 },
  server: { port: 5174, strictPort: true, proxy: { "/api": { target: bot, changeOrigin: false }, "/auth": bot } },
});
