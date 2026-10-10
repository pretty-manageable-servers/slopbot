import {randomBytes} from 'node:crypto';
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=new URL('../data/searxng/',import.meta.url);
mkdirSync(directory,{recursive:true});
const settings=new URL('settings.yml',directory);
if(!existsSync(settings))writeFileSync(settings,`use_default_settings: true\nserver:\n  secret_key: "${randomBytes(32).toString('hex')}"\n  limiter: false\n  public_instance: false\nsearch:\n  formats:\n    - html\n    - json\n`,{mode:0o600});
if(process.argv.includes('--setup-only')) {console.log('Local SearXNG settings prepared.');process.exit(0);}
const result=spawnSync('docker',['compose','-f','compose.search.yaml','up','-d'],{cwd:root,stdio:'inherit'});
if(result.error){console.error('Docker is required. Install and start Docker Desktop, then retry npm run search:start.');process.exit(1);}
if(result.status!==0){console.error('Start Docker Desktop, then retry npm run search:start.');process.exit(result.status??1);}
console.log('SearXNG started. Set SEARXNG_URL=http://127.0.0.1:8080 in .env, then restart Slopbot.');
