import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { consoleOptions, createConsole } from '../src/web-console.js';
import { ToolError } from '../src/tools.js';

test('web console is opt-in and rejects insecure public origins', () => {
  assert.equal(consoleOptions({}), undefined);
  assert.throws(() => consoleOptions({WEB_ENABLED:'true',WEB_ORIGIN:'http://example.com'}), /HTTPS/);
  assert.throws(() => consoleOptions({WEB_ENABLED:'true'}), /CLIENT_ID/);
});
test('Discord login binds state to browser, protects writes, and destroys logout sessions', async t => {
  let user = '', name = '', deny = false;
  const server = createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret'}, {
    async snapshot(id) { if (deny) throw new ToolError('Membership revoked'); return {user:id}; },
    async invoke(id, _channel, tool) { if (deny) throw new ToolError('Permission revoked'); user=id;name=tool;return {text:'Saved'}; },
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise<void>(resolve => server.close(()=>resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, originalFetch = globalThis.fetch;
  const call = (path:string, options?: RequestInit) => originalFetch(base+path, options);
  t.mock.method(globalThis,'fetch',async (url: string | URL | Request, init?:RequestInit) => {
    if (String(url) === 'https://discord.com/api/oauth2/token') return Response.json({access_token:'oauth-secret'});
    if (String(url) === 'https://discord.com/api/users/@me') return Response.json({id:'123456789012345678'});
    return originalFetch(url,init);
  });
  assert.equal((await call('/api/settings')).status,401);
  const login = await call('/auth/login',{redirect:'manual'});
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
  assert.equal((await call(`/auth/callback?state=${state}&code=x`,{redirect:'manual'})).status,400);
  const callback = await call(`/auth/callback?state=${state}&code=x`,{redirect:'manual',headers:{Cookie:`slopbot_state=${state}`}});
  assert.equal(callback.status,302);
  const cookie = callback.headers.getSetCookie()[0]!.split(';')[0]!;
  assert.ok(cookie.includes('slopbot_session='));
  assert.equal((await call(`/auth/callback?state=${state}&code=x`,{headers:{Cookie:`slopbot_state=${state}`}})).status,400);
  const snapshot = await call('/api/settings',{headers:{Cookie:cookie}});
  const data = await snapshot.json() as {csrf:string};
  assert.ok(data.csrf);
  const body = JSON.stringify({channel:'123456789012345679',name:'monitoring',args:{enabled:true}});
  assert.equal((await call('/api/settings',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body})).status,403);
  const headers = {Cookie:cookie,'Content-Type':'application/json',Origin:'http://localhost:3000','X-CSRF-Token':data.csrf};
  assert.equal((await call('/api/settings',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body})).status,403);
  assert.equal((await call('/api/settings',{method:'POST',headers,body})).status,200);
  assert.equal(user,'123456789012345678');assert.equal(name,'monitoring');
  assert.equal((await call('/api/settings',{method:'POST',headers,body:JSON.stringify({channel:'x',name:'task_start',args:{}})})).status,400);
  assert.equal((await call('/api/settings',{method:'POST',headers,body:'null'})).status,400);
  deny=true;
  assert.equal((await call('/api/settings',{headers:{Cookie:cookie}})).status,403);
  assert.equal((await call('/api/settings',{method:'POST',headers,body})).status,403);
  assert.equal((await call('/api/logout',{method:'POST',headers,body:'{}'})).status,200);
  assert.equal((await call('/api/settings',{headers:{Cookie:cookie}})).status,401);
});
test('static console serves branding and blocks path traversal',async t=>{
  const server=createConsole({origin:'http://localhost:3000',host:'127.0.0.1',port:3000,clientId:'id',clientSecret:'secret'},{async snapshot(){return {};},async invoke(){return {};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  const page=await fetch(base);assert.match(await page.text(),/Your team\. Your Slopbot/);
  assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  assert.equal((await fetch(base+'/assets/logo-light.svg')).status,200);
  assert.equal((await fetch(base+'/.env')).status,404);
  assert.equal((await fetch(base+'/assets/%2e%2e%2f.env')).status,404);
});
