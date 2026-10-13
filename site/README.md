# Slopbot site

The Slopbot landing page. This is a Next.js 15 static export. The bot serves the built files at `https://slopbot.pmservers.org/`. The configuration console is at `/console` on the same host.

```sh
cd site
npm ci
npm run build   # static files in out/
npm run dev     # http://localhost:3000
```

The Docker build stage runs the same build. The runtime image copies `out/` to `/app/site/out`.

Links (Discord install, docs, console, PMS Cloud pricing) are in `lib/links.ts`.
