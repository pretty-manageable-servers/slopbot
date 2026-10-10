import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
const path=process.argv[2];if(!path)throw new Error('Pass the SQLite database path');
const db=new DatabaseSync(path,{readOnly:true});
db.exec('BEGIN');
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_search%' ORDER BY name").all();
const data={};for(const {name} of tables)data[name]=db.prepare(`SELECT * FROM "${name}"`).all();
db.exec('COMMIT');db.close();
// Worker ownership must be acquired afresh on the remote host.
data.worker_leases=[];
const plaintext=Buffer.from(JSON.stringify(data));const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
mkdirSync('.deployment-build',{recursive:true,mode:0o700});mkdirSync('data/deployment',{recursive:true,mode:0o700});
writeFileSync('.deployment-build/seed.enc',Buffer.concat([iv,cipher.getAuthTag(),ciphertext]),{mode:0o600});
writeFileSync('data/deployment/migration-key',key.toString('hex'),{mode:0o600});
console.log(JSON.stringify({fingerprint:createHash('sha256').update(plaintext).digest('hex'),tables:Object.fromEntries(Object.entries(data).map(([name,rows])=>[name,rows.length]))}));
