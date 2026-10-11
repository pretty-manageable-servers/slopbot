import { startDatabaseTunnel } from './database-tunnel.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
const file='.env.development';
if(!existsSync(file)) throw new Error('Create .env.development from .env.development.example.');
const env=parseEnv(readFileSync(file,'utf8'));
for(const key of ['DISCORD_BOT_TOKEN','DISCORD_GUILD_ID','DATABASE_URL','SEARXNG_URL']) {
  if(!env[key]?.trim()) throw new Error(`Set ${key} in .env.development.`);
}
const production=existsSync('data/deployment/bot.env') ? parseEnv(readFileSync('data/deployment/bot.env','utf8')) : {};
if(env.DISCORD_BOT_TOKEN===production.DISCORD_BOT_TOKEN) throw new Error('Development must use a separate Discord bot token.');
if(env.DATABASE_SCHEMA!=='slopbot_dev') throw new Error('Development must use DATABASE_SCHEMA=slopbot_dev.');
if(spawnSync('npm',['run','build'],{stdio:'inherit'}).status!==0) process.exit(1);
const tunnel=await startDatabaseTunnel(env);
const options={stdio:'inherit',env:{...process.env,...env,NODE_ENV:'development'}};
const compiler=spawn(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json','--watch','--preserveWatchOutput'],options);
const bot=spawn(process.execPath,['--watch','dist/src/discord-main.js'],options);
let stopping=false;
function stop(){if(stopping)return;stopping=true;compiler.kill('SIGTERM');bot.kill('SIGTERM');tunnel.stop();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const child of [compiler,bot]) {child.on('error',error=>{console.error(error.message);process.exitCode=1;stop();});child.on('exit',code=>{if(!stopping){process.exitCode=code||0;stop();}});}

if(tunnel.child) tunnel.child.on('exit',()=>{if(!stopping){console.error('Database tunnel closed; stopping development bot.');process.exitCode=1;stop();}});
