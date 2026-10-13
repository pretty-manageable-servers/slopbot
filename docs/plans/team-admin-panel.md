# Plan: separate team admin panel

Status: plan only. Written for an agent that starts with no context.

## Goal

The team admin panel is for the Slopbot team (members of the Discord Developer Portal team that owns the bot). Today it is one tab ("Team admin") inside the per-server Settings sidebar. Server admins and the Slopbot team are different groups, so move the panel out of Settings into its own top-level view.

## Where things are now (branch `ui/redesign`)

- Top bar (`web/index.html`): "Chat" and "Settings" tabs (`.top-tab`, `data-view="chat" | "settings"`), Docs link, theme button, account menu.
- View switching: `setView`, `chooseView` and `fallbackToSettings` in `web/app.js`. The view is kept in localStorage and the URL hash (`#chat`, `#settings`).
- Settings sidebar (`web/index.html`, `#console aside nav`): buttons with `data-tab` = `server`, `channels`, `mcp`, `profile`, and `admin` (`id="admin-tab"`, hidden unless the user is in the team).
- `web/app.js`:
  - `render()` line ~154: `if (tab === 'admin' && admin) { renderAdmin(); return; }`
  - line ~230: `let admin = null, adminServer = '', adminUser = '';`
  - line ~237: `admin = await request('/api/admin/me')` sets `$('admin-tab').hidden`.
  - `renderAdmin()` (~line 304) and helpers `adminPrices`, `adminUsage`, `adminPerson`, `wireAdminSearch`, `adminTranscripts`. They draw into `#content` and use their own server picker `#admin-pick` (now a custom dropdown from `web/dropdown.js`).
- Server routes (`src/web-console.ts`, `adminRoute`): `GET /api/admin/me | limits | prices | usage | members | servers`; `POST /api/admin/limits | prices | usage/reset | usage/grant | transcripts | webhook/rotate`. Access: `ConsoleAdmin.role(user)` and `canEdit(user)` (`src/admin-team.ts` or the `discord.team` object in `src/discord-main.ts`). Read-only role can view, not change.
- Styles: `web/style.css`, `web/chat.css`, `web/console.css`.

The server side does not change. This is a web UI change only.

## Target

1. **Top bar:** a third tab "Admin", with a shield icon (16px lucide-style inline SVG, `currentColor`), shown only when `/api/admin/me` succeeds. `data-view="admin"`, hash `#admin`. On mobile it shows the icon only, like the other tabs.
2. **Settings:** remove the "Team admin" button from the sidebar. Settings stays per server, for server admins and members.
3. **Admin view layout:** its own page, not inside `#console`'s Settings layout.
   - Left nav (same look as the Settings sidebar) with sections: **Overview**, **Usage**, **Limits & prices**, **Web transcripts**.
   - **Overview:** role badge (Owner, Admin, Developer, Read-only), the servers Slopbot is in (name and icon), and a short line on each section.
   - **Usage:** the server picker (custom dropdown) plus the existing usage list, member search, reset and grant buttons.
   - **Limits & prices:** the existing limits form (global and per server) and the model prices table.
   - **Web transcripts:** the existing per-channel switches and "Rotate webhook" for all servers.
   - A Read-only member sees all sections with disabled controls and a note at the top: "Read-only role. You can view, not change."
   - Remember the section in the hash: `#admin/usage`, `#admin/limits`, `#admin/transcripts`.
4. **Code layout:** move all admin UI code out of `web/app.js` into a new `web/admin.js` (classic script, no modules). Expose only what app.js needs (for example `renderAdminView()` and `loadAdminRole()`).
   - Add `/admin.js` to `staticAssets` in `src/web-console.ts`.
   - Add a `<script src="/admin.js" defer>` tag in `web/index.html` before `app.js`.
   - Add `admin.js` to the file list in `tests/web-globals.test.ts`. That test fails if two scripts declare the same top-level name.
   - Admin styles go in a new `web/admin.css` (add to `staticAssets` and a `<link>`), or in `console.css`.
5. **Access:** if a user opens `#admin` without team access, show Settings or Chat instead (use `chooseView`). The server already refuses admin API calls for non-members, so the UI check is only for comfort.

## Rules

- CSP is `'self'`: no inline styles, no inline scripts, no `on*` attributes, no CDN.
- Brand: bg `#161615`, surface `#1F1E1D`, pill `#2B2A28`, lines `#33322F`, text `#F5F4EF` / `#E2E0D9`, muted `#9A978F`, accent `#7EA6FF`. Fonts: Inter, Source Serif 4 for titles, JetBrains Mono for code. Light theme via `html.light`.
- Never write team emails anywhere. Admins are found by Discord user ID only.
- Never show user IDs as the main label. Use avatar, display name and @username (`adminPerson`), with the ID only in a tooltip.

## Tests and checks

- `npm run check`, `npm run build`, `node --test dist/tests/*.test.js`. The GIF reader test fails on macOS only. That is known.
- `node --check web/*.js`.
- Browser (local stack, see below): as a team member, see the Admin tab and every section. As a non-member (another Discord account, or temporarily make `/api/admin/me` fail), see no Admin tab, and `#admin` falls back.
- A Read-only role: every control is disabled.

## Local stack

- `npm run dev` in `~/jokes/pmservers/slopbot` (console at http://localhost:3000, staging bot). Postgres container `slopbot-devdb` on `localhost:15432`.
- Restart: `pkill -f scripts/development/start.mjs; pkill -f dist/src/discord-main.js; (npm run dev > ../scratchpad/dev.log 2>&1 &)`.
- Sessions are saved in the database, so a restart does not sign you out.

## Coordination

- Other work in progress may touch `web/app.js`, `web/conversations.js` and `web/index.html`: private web chats (branches `ui/chats-server` and `ui/chats-ui`, plan `docs/plans/web-private-chats.md`). Branch from `ui/redesign` after those merge, or expect small conflicts in `index.html` and `app.js`.
- Commit on a new branch, for example `ui/admin-panel`. Check the branch before each commit.
- Push through `ssh://git@ssh.github.com:443/pretty-manageable-servers/slopbot.git` if port 22 fails.
- After the change, run the `pmservers-handoff` skill (wiki: `~/jokes/pmservers/agent-wiki`).
