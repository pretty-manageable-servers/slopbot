import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { Client } from 'pg';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
const run=promisify(execFile);
export async function startPrivateNetwork(){
  if(!process.env.TAILSCALE_AUTH_KEY) return;
  const socket='/tmp/slopbot-tailscale.sock';
  const state='/tmp/slopbot-tailscale-state';
  const encryptionKey=createHash('sha256').update(process.env.TAILSCALE_AUTH_KEY).digest();
  const db=new Client({connectionString:process.env.DATABASE_URL});
  try {
    await db.connect();
    await db.query('CREATE TABLE IF NOT EXISTS public.slopbot_private_network_state (id text PRIMARY KEY, encrypted bytea NOT NULL)');
    const result=await db.query('SELECT encrypted FROM public.slopbot_private_network_state WHERE id=$1',['tailscale']);
    if(result.rows.length){
      const bytes=result.rows[0].encrypted;
      const decipher=createDecipheriv('aes-256-gcm',encryptionKey,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      await writeFile(state,Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]),{mode:0o600});
    }
  } catch {console.error('Private network state could not be restored.');await db.end().catch(()=>{});return;}
  let previous, saving=false;
  async function save(){
    if(saving)return;saving=true;
    try{
      const bytes=await readFile(state);const hash=createHash('sha256').update(bytes).digest('hex');
      if(hash!==previous){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);const body=Buffer.concat([cipher.update(bytes),cipher.final()]);
        await db.query('INSERT INTO public.slopbot_private_network_state VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted',['tailscale',Buffer.concat([iv,cipher.getAuthTag(),body])]);previous=hash;}
    }catch{console.error('Private network state could not be saved.');}finally{saving=false;}
  }
  const daemon=spawn('/usr/local/bin/tailscaled',['--tun=userspace-networking',`--state=${state}`,`--socket=${socket}`],{stdio:['ignore','ignore','ignore']});
  daemon.on('error',()=>console.error('Private network process failed.'));
  const args=[`--socket=${socket}`];
  const keyFile='/tmp/slopbot-tailscale-key';
  try{
    await writeFile(keyFile,process.env.TAILSCALE_AUTH_KEY,{mode:0o600});
    for(let i=0;i<30;i++){
      try{await run('/usr/local/bin/tailscale',[...args,'status','--json']);break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}
    }
    await run('/usr/local/bin/tailscale',[...args,'up',`--auth-key=file:${keyFile}`,'--hostname=slopbot-services','--accept-dns=false'],{timeout:60000});
    const searchOrigin=new URL(process.env.SEARXNG_URL??'http://127.0.0.1:8080');
    if(searchOrigin.protocol==='http:') await run('/usr/local/bin/tailscale',[...args,'serve','--bg','--tcp=8080',`tcp://${searchOrigin.hostname}:${searchOrigin.port||80}`]);
    if(process.env.DEV_DATABASE_HOST) await run('/usr/local/bin/tailscale',[...args,'serve','--bg','--tcp=5432',`tcp://${process.env.DEV_DATABASE_HOST}:5432`]);
    else await run('/usr/local/bin/tailscale',[...args,'serve','--tcp=5432','off']).catch(()=>console.error('Legacy private database forwarding could not be cleared.'));
    await save();
    const timer=setInterval(()=>void save(),30000);timer.unref();
    const {stdout}=await run('/usr/local/bin/tailscale',[...args,'ip','-4']);
    console.log(`Private development services available at ${stdout.trim()}:8080 and :5432`);
  }catch{console.error('Private development network failed to start; production bot will still run.');daemon.kill();await db.end().catch(()=>{});return;}
  finally{await unlink(keyFile).catch(()=>{});delete process.env.TAILSCALE_AUTH_KEY;}
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{void save().finally(()=>{daemon.kill(signal);void db.end();});});
  return daemon;
}
