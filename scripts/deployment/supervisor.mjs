import {startPrivateNetwork} from './private-network.mjs';
import {spawn} from 'node:child_process';
const searchEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|HOME|SSL_CERT_DIR|SSL_CERT_FILE|__SEARXNG.*|GRANIAN_.*|SEARXNG_.*)$/.test(key)));
const search=spawn('/usr/local/searxng/entrypoint.sh',[],{cwd:'/usr/local/searxng',env:searchEnv,stdio:'inherit'});
let bot,stopping=false;
function stop(signal='SIGTERM'){if(stopping)return;stopping=true;bot?.kill(signal);search.kill(signal);}
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop('SIGINT'));
search.on('error',()=>{console.error('Search process failed to start');stop();process.exitCode=1;});
search.on('exit',code=>{if(!stopping){console.error('Search process exited unexpectedly');stop();process.exitCode=code||1;}});
for(let i=0;i<120&&!stopping;i++){
  try{const r=await fetch('http://127.0.0.1:8080/',{signal:AbortSignal.timeout(1000)});await r.body?.cancel();if(r.ok)break;}catch{}
  if(i===119){console.error('Search startup timed out');stop();process.exitCode=1;}
  await new Promise(resolve=>setTimeout(resolve,1000));
}
if(!stopping){
  await startPrivateNetwork();
  try { const r=await fetch('http://127.0.0.1:8080/search?q=OpenClaw&format=json',{signal:AbortSignal.timeout(20000)});const result=await r.json();console.log(`Search startup check: HTTP ${r.status}, ${result.results?.length??0} results`); }
  catch {console.error('Search startup check unavailable; bot will still start.');}
  bot=spawn(process.execPath,['/app/scripts/deployment/bootstrap.mjs'],{env:process.env,stdio:'inherit'});
  bot.on('error',()=>{console.error('Bot process failed to start');stop();process.exitCode=1;});
  bot.on('exit',code=>{process.exitCode=code||0;stop();});
}
