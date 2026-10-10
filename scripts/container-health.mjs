import {DatabaseSync} from 'node:sqlite';
import {Client} from 'pg';
try {
  let row;
  if(process.env.DATABASE_URL){const db=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:4000});await db.connect();row=(await db.query('SELECT expires FROM worker_leases WHERE server=$1',[process.env.DISCORD_GUILD_ID??''])).rows[0];await db.end();}
  else{const db=new DatabaseSync(process.env.DATABASE_PATH??'/data/slopbot.sqlite3',{readOnly:true});row=db.prepare('SELECT expires FROM worker_leases WHERE server=?').get(process.env.DISCORD_GUILD_ID??'');db.close();}
  process.exit(row&&Number(row.expires)>Date.now()?0:1);
}catch{process.exit(1);}
