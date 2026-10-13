// Team keys for Tavily and Firecrawl. Keys are sealed with WEB_KEYS_SECRET before they reach the store.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KEYED_PROVIDERS, type KeyedProvider, type ProviderKeyRow } from './web-providers.js';

const SECRET_PATTERN = /^[\x21-\x7e]{8,200}$/;
const LABEL_LIMIT = 60;

/** Seals and opens key secrets with AES-256-GCM. The row id is the AAD, so a sealed value cannot move to another row. */
export class WebKeySecrets {
  private readonly key: Buffer | undefined;
  constructor(encoded: string | undefined = process.env.WEB_KEYS_SECRET) {
    if (encoded) {
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('WEB_KEYS_SECRET must be a base64-encoded 32-byte key');
      this.key = key;
    }
  }
  get enabled(): boolean { return Boolean(this.key); }
  seal(secret: string, id: string): string {
    if (!this.key) throw new Error('The operator must configure WEB_KEYS_SECRET before saving provider keys.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id));
    return Buffer.concat([iv, cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  open(sealed: string, id: string): string {
    if (!this.key) throw new Error('Provider key secret unavailable: WEB_KEYS_SECRET is not configured');
    const data = Buffer.from(sealed, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8');
  }
}

function isKeyedProvider(value: string): value is KeyedProvider {
  return (KEYED_PROVIDERS as readonly string[]).includes(value);
}

/** Validates a new key and returns its row, with the secret sealed. The plain secret is not kept on the row. */
export function newProviderKeyRow(secrets: WebKeySecrets, provider: string, owner: string, label: string, secret: string, now: number): ProviderKeyRow {
  if (!isKeyedProvider(provider)) throw new Error(`Provider must be one of: ${KEYED_PROVIDERS.join(', ')}`);
  if (!owner) throw new Error('Key owner is required');
  if (!SECRET_PATTERN.test(secret)) throw new Error('Key must be 8 to 200 printable characters with no spaces');
  if (Array.from(label).length > LABEL_LIMIT) throw new Error(`Key label must be ${LABEL_LIMIT} characters or fewer`);
  const id = randomBytes(8).toString('hex');
  return { id, provider, owner, label, last4: secret.slice(-4), secretEncrypted: secrets.seal(secret, id), createdAt: now };
}
