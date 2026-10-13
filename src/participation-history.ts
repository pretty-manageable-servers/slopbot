import type { Message } from './domain.js';
import type { ParticipationDecision } from './participation.js';

export interface DecisionThresholds { addressed: number; respond: number; unsolicited: number; funny: number }
export const defaultDecisionThresholds: DecisionThresholds = { addressed: 0.65, respond: 0.5, unsolicited: 0.9, funny: 0.9 };
export interface DecisionScores { addressed: number; respond: number; funny?: number }
export interface ParticipationRecord {
  messageId: string; channel: string; author: string; text: string; timestamp: number;
  decision: ParticipationDecision; thresholds: DecisionThresholds; detail: string;
}
export interface ParticipationHistoryQuery {
  count: number; after?: number; before?: number; messageId?: string; author?: string; text?: string;
}
export interface ParticipationHistoryStore {
  participationHistory(server: string, channel: string, query: ParticipationHistoryQuery): Promise<ParticipationRecord[]>;
}
export function decisionThresholds(value: unknown, fallback = defaultDecisionThresholds): DecisionThresholds {
  const raw = value && typeof value === 'object' ? value as Partial<DecisionThresholds> : {};
  const result = { ...fallback };
  for (const key of Object.keys(result) as (keyof DecisionThresholds)[]) {
    const number = raw[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1) result[key] = number;
  }
  return result;
}
export function scoredDecision(scores: DecisionScores, thresholds: DecisionThresholds): ParticipationDecision {
  const addressed = scores.addressed >= thresholds.addressed;
  return { addressed, respond: scores.respond >= (addressed ? thresholds.respond : thresholds.unsolicited),
    ...(scores.funny !== undefined && scores.funny >= thresholds.funny ? { emoji: '😂' } : {}), scores,
    reason: `addressed=${scores.addressed.toFixed(3)},respond=${scores.respond.toFixed(3)}` };
}

type Row = Record<string, unknown>;
type ReadRows = (sql: string, values: (string | number)[]) => Promise<Row[]>;
/** Both stores query bounded channel-scoped rows. Original classifier runs remain usable after upgrading. */
export async function readParticipationHistory(read: ReadRows, server: string, channel: string, query: ParticipationHistoryQuery): Promise<ParticipationRecord[]> {
  const fetch = async (legacy: boolean) => {
    const column = legacy ? 'r.message' : 'a.value';
    const time = `json_extract(${column},'$.timestamp')`;
    const id = `json_extract(${column},'$.${legacy ? 'id' : 'messageId'}')`;
    const conditions = [`${legacy ? "json_extract(r.message,'$.server')" : 'a.server'}=?`, `json_extract(${column},'$.channel')=?`];
    const values: (string | number)[] = [server, channel];
    if (query.after !== undefined) { conditions.push(`${time}>=?`); values.push(query.after); }
    if (query.before !== undefined) { conditions.push(`${time}<?`); values.push(query.before); }
    if (query.messageId) { conditions.push(`${id}=?`); values.push(query.messageId); }
    if (query.author) { conditions.push(`json_extract(${column},'$.author')=?`); values.push(query.author); }
    if (query.text) { conditions.push("lower(json_extract(m.body,'$.text')) LIKE ? ESCAPE '\\'"); values.push(`%${query.text.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`); }
    if (legacy) {
      conditions.push("(json_extract(r.prompt,'$.prefixVersion') LIKE 'systemone%' OR json_extract(r.prompt,'$.prefixVersion') LIKE 'participation%')");
      conditions.push(`NOT EXISTS (SELECT 1 FROM app_records a WHERE a.server=? AND a.kind='participation_decision' AND a.id=${id})`); values.push(server);
    } else conditions.push("a.kind='participation_decision'");
    values.push(query.count);
    const sourceServer = legacy ? "json_extract(r.message,'$.server')" : 'a.server';
    return read(`SELECT m.body AS current_message,${legacy ? "r.message,r.result,r.status,(SELECT payload FROM events WHERE run_id=r.id AND kind='opaque' ORDER BY sequence LIMIT 1) AS provider" : 'a.value'} FROM ${legacy ? 'runs r' : 'app_records a'} JOIN messages m ON m.server=${sourceServer} AND m.id=${id} AND m.channel=json_extract(${column},'$.channel') WHERE ${conditions.join(' AND ')} ORDER BY ${time} DESC,${legacy ? 'r.rowid' : 'a.id'} DESC LIMIT ?`, values);
  };
  const [saved, old] = await Promise.all([fetch(false), fetch(true)]);
  const records = saved.map(row => ({ ...JSON.parse(String(row.value)) as ParticipationRecord, text: (JSON.parse(String(row.current_message)) as Message).text.slice(0, 240) }));
  for (const row of old) {
    const message = JSON.parse(String(row.message)) as Message;
    let decision: ParticipationDecision = { respond: false, addressed: false, reason: String(row.result ?? row.status) };
    if (row.status === 'completed') {
      try { decision = JSON.parse(String(row.result)) as ParticipationDecision; } catch { /* Older failures may have plain text results. */ }
    }
    if (row.provider) {
      const raw = JSON.parse(String(row.provider)) as { answers?: Record<string, { probabilities?: { yes?: number } }> };
      const addressed = raw.answers?.addressed?.probabilities?.yes, respond = raw.answers?.respond?.probabilities?.yes;
      const funny = raw.answers?.funny?.probabilities?.yes;
      if (addressed !== undefined && respond !== undefined) decision.scores = { addressed, respond, ...(funny !== undefined ? { funny } : {}) };
    }
    records.push({ messageId: message.id, channel: message.channel, author: message.author, text: (JSON.parse(String(row.current_message)) as Message).text.slice(0, 240), timestamp: message.timestamp ?? 0,
      decision, thresholds: defaultDecisionThresholds, detail: 'Legacy classifier result. Gate outcome and delivery were not recorded; thresholds use the original fixed defaults.' });
  }
  return records.sort((a, b) => b.timestamp - a.timestamp || b.messageId.localeCompare(a.messageId)).slice(0, query.count);
}
