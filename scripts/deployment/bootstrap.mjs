import {readFileSync,existsSync} from 'node:fs';
import {createDecipheriv,createHash} from 'node:crypto';
import {Client} from 'pg';
export async function migrate(url,keyHex,file='/app/seed.enc') {
  const bytes=readFileSync(file),decipher=createDecipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
  const plaintext=Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]),fingerprint=createHash('sha256').update(plaintext).digest('hex');
  const data=JSON.parse(plaintext.toString('utf8'));const client=new Client({connectionString:url});await client.connect();
  try {
    await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(519496)");
    await client.query(readFileSync(new URL('../../dist/src/adapters/postgres-schema.sql',import.meta.url),'utf8'));
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (fingerprint TEXT PRIMARY KEY,completed_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    if((await client.query('SELECT 1 FROM schema_migrations WHERE fingerprint=$1',[fingerprint])).rowCount){await client.query('COMMIT');console.log('Existing migration verified.');return;}
    const allowed=new Set((await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row=>row.tablename));
    const counts={};
    for(const [table,rows] of Object.entries(data)) {
      if(!/^[a-z_]+$/.test(table)||!allowed.has(table))throw new Error('Unexpected migration table');
      if(Number((await client.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n))throw new Error(`Migration requires an empty ${table} table`);
      for(let offset=0;offset<rows.length;offset+=100) {
        const batch=rows.slice(offset,offset+100),columns=Object.keys(batch[0]);
        if(!columns.every(column=>/^[a-z_]+$/.test(column)) || !batch.every(row=>JSON.stringify(Object.keys(row))===JSON.stringify(columns)))throw new Error('Invalid migration columns');
        const values=batch.flatMap(row=>columns.map(column=>row[column]));
        const tuples=batch.map((_,i)=>`(${columns.map((_,j)=>`$${i*columns.length+j+1}`).join(',')})`).join(',');
        await client.query(`INSERT INTO "${table}" (${columns.map(column=>`"${column}"`).join(',')}) VALUES ${tuples}`,values);
      }
      if(rows.some(row=>'sequence' in row))await client.query(`SELECT setval(pg_get_serial_sequence($1,'sequence'),coalesce((SELECT max(sequence) FROM "${table}"),1),EXISTS(SELECT 1 FROM "${table}"))`,[table]);
      counts[table]=Number((await client.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n);
      if(counts[table]!==rows.length)throw new Error(`Migration count mismatch for ${table}`);
    }
    await client.query('INSERT INTO schema_migrations(fingerprint) VALUES($1)',[fingerprint]);await client.query('COMMIT');console.log('Migration verified:',JSON.stringify(counts));
  } catch(error) {await client.query('ROLLBACK');throw error;}finally{await client.end();}
}
if(process.env.MIGRATION_KEY) {
  if(!process.env.DATABASE_URL||!existsSync('/app/seed.enc'))throw new Error('Missing migration database or encrypted seed');
  await migrate(process.env.DATABASE_URL,process.env.MIGRATION_KEY);delete process.env.MIGRATION_KEY;
}
if(!process.env.MIGRATION_ONLY)await import('../../dist/src/discord-main.js');
