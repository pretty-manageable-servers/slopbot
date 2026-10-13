import {DatabaseSync} from 'node:sqlite';
import {Client} from 'pg';
// Healthy while the worker of any server holds a current lease.
try {
  let row;
  if(process.env.DATABASE_URL){const db=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:4000});await db.connect();row=(await db.query('SELECT MAX(expires) AS expires FROM worker_leases')).rows[0];await db.end();}
  else{const db=new DatabaseSync(process.env.DATABASE_PATH??'/data/slopbot.sqlite3',{readOnly:true});row=db.prepare('SELECT MAX(expires) AS expires FROM worker_leases').get();db.close();}
  process.exit(row&&Number(row.expires)>Date.now()?0:1);
}catch{process.exit(1);}
