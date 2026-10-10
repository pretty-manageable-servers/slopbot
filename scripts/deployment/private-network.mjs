import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
const run=promisify(execFile);
export async function startPrivateNetwork(){
  if(!process.env.TAILSCALE_AUTH_KEY) return;
  const socket='/tmp/slopbot-tailscale.sock';
  const daemon=spawn('/usr/local/bin/tailscaled',['--tun=userspace-networking','--state=mem:',`--socket=${socket}`],{stdio:['ignore','ignore','ignore']});
  daemon.on('error',()=>console.error('Private network process failed.'));
  const args=[`--socket=${socket}`];
  const keyFile='/tmp/slopbot-tailscale-key';
  try{
    await writeFile(keyFile,process.env.TAILSCALE_AUTH_KEY,{mode:0o600});
    for(let i=0;i<30;i++){
      try{await run('/usr/local/bin/tailscale',[...args,'status','--json']);break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}
    }
    await run('/usr/local/bin/tailscale',[...args,'up',`--auth-key=file:${keyFile}`,'--hostname=slopbot-services','--accept-dns=false'],{timeout:60000});
    await run('/usr/local/bin/tailscale',[...args,'serve','--bg','--tcp=8080','tcp://127.0.0.1:8080']);
    if(process.env.DEV_DATABASE_HOST) await run('/usr/local/bin/tailscale',[...args,'serve','--bg','--tcp=5432',`tcp://${process.env.DEV_DATABASE_HOST}:5432`]);
    const {stdout}=await run('/usr/local/bin/tailscale',[...args,'ip','-4']);
    console.log(`Private development services available at ${stdout.trim()}:8080 and :5432`);
  }catch{console.error('Private development network failed to start; production bot will still run.');daemon.kill();return;}
  finally{await unlink(keyFile).catch(()=>{});delete process.env.TAILSCALE_AUTH_KEY;}
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>daemon.kill(signal));
  return daemon;
}
