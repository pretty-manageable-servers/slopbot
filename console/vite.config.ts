import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The new console. The bot serves the build at /console. In development Vite proxies the API to a running bot.
const bot = process.env.SLOPBOT_URL ?? "http://localhost:3000";

export default defineConfig({
  base: "/console/",
  plugins: [react(), tailwindcss()],
  // `pnpm dev:mock` (VITE_MOCK_API=1) serves the MSW worker; the build never ships it.
  publicDir: process.env.VITE_MOCK_API ? "src/mocks/public" : false,
  // No data: URLs: the console CSP allows fonts and images from the bot only.
  // Two pages: the console (index.html) and the public share page (share.html), which the bot fills with its copy.
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets", assetsInlineLimit: 0, rolldownOptions: { input: { main: "index.html", share: "share.html" } } },
  server: { port: 5174, strictPort: true, proxy: { "/api": { target: bot, changeOrigin: false }, "/auth": bot } },
});
