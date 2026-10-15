import type { Json } from './domain.js';
import type { ProfileField, UserProfile } from './profiles.js';
import type { RecordStore } from './records.js';
import { ToolError } from './errors.js';
import { GLOBAL_SETTINGS_SCOPE } from './usage-cost.js';

interface GlobalRevision extends ProfileField { previous: Json }
interface SavedProfile { fields: ProfileField[]; history: GlobalRevision[] }
type Storage = Pick<RecordStore, 'record' | 'putRecord'>;

/** Explicitly published account facts. No server identity or source-channel metadata crosses servers. */
export class GlobalProfiles {
  constructor(private readonly store: Storage) {}
  private async load(user: string) {
    const record = await this.store.record(GLOBAL_SETTINGS_SCOPE, 'global_profile', user);
    return { record, value: (record?.value ?? { fields: [], history: [] }) as unknown as SavedProfile };
  }
  private owner(user: string, actor: string): void {
    if (user !== actor) throw new ToolError('Only the profile owner may edit a global profile or inspect its history. Server admins cannot override this.');
  }
  async get(user: string): Promise<UserProfile> {
    const { value } = await this.load(user);
    return { userId: user, name: user, identity: {}, allowEdits: false, fields: value.fields.filter(field => field.value !== null) };
  }
  async history(user: string, actor: string): Promise<ProfileField[]> {
    this.owner(user, actor); return (await this.load(user)).value.history.slice().reverse();
  }
  async edit(user: string, actor: string, field: string, value: Json, operation: string, expectedRevision?: string): Promise<string> {
    this.owner(user, actor);
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(field) || field.startsWith('discord_') || ['server_name', 'server_nickname', 'display_name'].includes(field)) throw new ToolError('Use a custom field name; automatic Discord identity is read-only.');
    if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw new ToolError('Global profile field values must fit 4 KiB.');
    const old = await this.load(user);
    if (old.value.history.some(event => event.revision === operation)) return 'Global profile change already recorded.';
    if (expectedRevision && old.value.fields.find(item => item.field === field)?.revision !== expectedRevision) throw new ToolError('A newer global edit exists. Undo the current revision first.');
    if (value !== null && !old.value.fields.some(item => item.field === field && item.value !== null) && old.value.fields.filter(item => item.value !== null).length >= 50) throw new ToolError('A global profile can contain at most 50 fields. Remove a field before adding another.');
    const event: ProfileField = { field, value, editor: user, sourceIds: [], revision: operation };
    const history = [...old.value.history, { ...event, previous: old.value.fields.find(item => item.field === field)?.value ?? null }].slice(-200), retained = new Set(history.map(event => event.revision));
    const next: SavedProfile = { fields: [...old.value.fields.filter(item => item.field !== field && (item.value !== null || retained.has(item.revision))), event], history };
    if (!await this.store.putRecord(GLOBAL_SETTINGS_SCOPE, 'global_profile', user, next as unknown as Json, old.record?.revision ?? 0)) throw new ToolError('Global profile changed in another request. Read it again before retrying.');
    return `Global profile ${field} ${value === null ? 'removed' : 'updated'}; revision ${operation}. These fields are shared across servers and only you may edit them.`;
  }
  async undo(user: string, actor: string, revision: string, operation: string): Promise<string> {
    this.owner(user, actor);
    const { value } = await this.load(user);
    if (value.history.some(event => event.revision === operation)) return 'Global profile undo already recorded.';
    const index = value.history.findIndex(event => event.revision === revision), event = value.history[index];
    if (!event) throw new ToolError('Unknown global profile revision. Choose a retained revision from your global profile history.');
    if (value.fields.find(field => field.field === event.field)?.revision !== revision) throw new ToolError('A newer global edit exists. Undo the current revision first.');
    return this.edit(user, actor, event.field, event.previous, operation, revision);
  }
}

export function globalProfiles(store: object): GlobalProfiles | undefined {
  const storage = store as Partial<Storage>;
  return typeof storage.record === 'function' && typeof storage.putRecord === 'function' ? new GlobalProfiles(storage as Storage) : undefined;
}
