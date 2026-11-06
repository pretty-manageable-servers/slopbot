// Local development only: a stand-in for Discord OAuth so the console can be signed into without a Discord login.
// Any Discord user id signs in (DEV_OAUTH_USER, or typed into the form). The bot still checks server membership after sign-in.
// With LOCAL_WORLD set (the local console), the page lists the fixture's users to pick from instead.
// Set WEB_OAUTH_BASE=http://127.0.0.1:9091 in .env.development to use it. The console refuses that setting in production.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const port = Number(process.env.DEV_OAUTH_PORT || 9091);
const defaultUser = process.env.DEV_OAUTH_USER || '';
const auto = process.env.DEV_OAUTH_AUTO === '1';
const snowflake = /^\d{17,20}$/;
const attr = value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const localWorld = process.env.LOCAL_WORLD ? JSON.parse(readFileSync(process.env.LOCAL_WORLD, 'utf8')) : null;

function localRedirect(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) ? url : null;
}

async function form(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

const json = (res, status, body) => send(res, status, JSON.stringify(body), 'application/json');

function signInFields(defaultUser) {
  if (localWorld) return `<p>Local development only. Pick a user. Slopbot still checks that the user is in one of its servers.</p>
${localWorld.users.map(user => `<button name="user" value="${attr(user.id)}">${attr(user.name)} <small>${attr(user.id)}</small></button>`).join('\n')}`;
  return `<p>Local development only. Enter any Discord user id. Slopbot still checks that the user is in one of its servers.</p>
<label>Discord user id <input name="user" value="${attr(defaultUser)}" inputmode="numeric" required></label>
<button id="sign-in" type="submit">Sign in</button>`;
}

function signIn(res, redirect, user, state) {
  const back = new URL(redirect);
  back.searchParams.set('code', user);
  back.searchParams.set('state', state);
  res.writeHead(302, { Location: back.href });
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
      const redirect = localRedirect(url.searchParams.get('redirect_uri'));
      if (!redirect) return send(res, 400, 'redirect_uri must be a localhost URL');
      const state = url.searchParams.get('state') ?? '';
      if (auto && snowflake.test(defaultUser)) return signIn(res, redirect, defaultUser, state);
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Dev sign-in</title><h1>Slopbot dev sign-in</h1>
<form method="POST" action="/oauth2/authorize">
${signInFields(defaultUser)}
<input type="hidden" name="redirect_uri" value="${attr(url.searchParams.get('redirect_uri'))}">
<input type="hidden" name="state" value="${attr(state)}">
</form>`, 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/oauth2/authorize') {
      const params = await form(req);
      const redirect = localRedirect(params.get('redirect_uri'));
      const user = params.get('user') ?? '';
      if (!redirect || !snowflake.test(user)) return send(res, 400, 'Enter a Discord user id (17-20 digits) and use a localhost redirect_uri.');
      return signIn(res, redirect, user, params.get('state') ?? '');
    }
    if (req.method === 'POST' && url.pathname === '/api/oauth2/token') {
      const code = (await form(req)).get('code') ?? '';
      if (!snowflake.test(code)) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, { access_token: code, token_type: 'Bearer' });
    }
    if (req.method === 'GET' && url.pathname === '/api/users/@me') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!snowflake.test(token)) return json(res, 401, { message: '401: Unauthorized' });
      return json(res, 200, { id: token, username: `dev-${token.slice(-4)}` });
    }
    return send(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    send(res, 500, 'Dev OAuth failed');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Dev Discord OAuth on http://127.0.0.1:${port}`));
