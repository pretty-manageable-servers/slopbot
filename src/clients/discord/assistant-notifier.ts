import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { AssistantStore } from '../../assistant/store.js';
import { MAX_NOTIFY_CHARS, type ActivityItem, type ApprovalRequest, type AssistantSettings, type Notifier } from '../../assistant/types.js';
import { logError, ToolError } from '../../errors.js';

const BUTTON_PREFIX = 'assistant:';

export interface DmPayload { content: string; components?: unknown[]; allowedMentions: { parse: [] } }

export interface AssistantNotifierDeps {
  store: Pick<AssistantStore, 'settings' | 'approval'>;
  send(user: string, payload: DmPayload): Promise<{ edit(content: string): Promise<void> } | void>;
  consoleUrl: string;
  gate: { execute(id: string, user: string, always: boolean): Promise<unknown>; deny(id: string, user: string): Promise<unknown> };
  now?: () => number;
  log?: (event: string, error: unknown) => void;
}

/** What the clicker sees: the message is edited with `update`, and a refusal is an ephemeral reply. */
export interface ApprovalButtonReply {
  update(content: string): Promise<void>;
  ephemeral(content: string): Promise<void>;
}

/** Sends activity updates to the owner as Discord DMs, with Approve / Deny / Always allow buttons for approvals. */
export class DiscordAssistantNotifier implements Notifier {
  private readonly now: () => number;
  private readonly log: (event: string, error: unknown) => void;
  private readonly dmFailureDay = new Map<string, string>();   // user → UTC day of the last logged DM failure

  constructor(private readonly deps: AssistantNotifierDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((event, error) => logError(event, error, {}, true));
  }

  async notify(item: ActivityItem, approval?: ApprovalRequest): Promise<void> {
    const settings = await this.deps.store.settings(item.owner);
    if (!settings?.dmUpdates || inQuietHours(settings, this.now())) return;
    const link = `${this.deps.consoleUrl}/assistant${item.task ? `/task/${item.task}` : ''}`;
    const payload: DmPayload = { content: `${item.text.slice(0, MAX_NOTIFY_CHARS)}\n${link}`, allowedMentions: { parse: [] } };
    if (approval) payload.components = [approvalButtons(approval.id)];
    try { await this.deps.send(item.owner, payload); }
    catch (error) { this.logDmFailure(item.owner, error); }
  }

  /** Handles a click on one of the approval buttons. Returns false for ids that are not ours. */
  async handleButton(customId: string, clickerId: string, reply: ApprovalButtonReply): Promise<boolean> {
    if (!customId.startsWith(BUTTON_PREFIX)) return false;
    const [, action = '', id = ''] = customId.split(':');
    const approval = await this.deps.store.approval(id);
    if (!approval) { await reply.ephemeral('This approval is no longer open.'); return true; }
    if (approval.owner !== clickerId) { await reply.ephemeral('Only the owner can decide.'); return true; }
    try {
      if (action === 'deny') {
        await this.deps.gate.deny(id, clickerId);
        await reply.update('Denied');
      } else if (action === 'approve' || action === 'always') {
        await this.deps.gate.execute(id, clickerId, action === 'always');
        await reply.update('Approved');
      }
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      await reply.update(error.message);
    }
    return true;
  }

  /** DMs are closed for many users, so log a failure once per user per UTC day and keep going. */
  private logDmFailure(user: string, error: unknown): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.dmFailureDay.get(user) === day) return;
    this.dmFailureDay.set(user, day);
    this.log('assistant_dm_failed', error);
  }
}

function approvalButtons(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}deny:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}always:${id}`).setLabel('Always allow').setStyle(ButtonStyle.Secondary),
  );
}

/**
 * True when `now` falls in the user's quiet hours. quietStart and quietEnd are "HH:MM" in the user's timezone.
 * A window may wrap past midnight (22:00 to 07:00). Equal start and end means no quiet hours.
 */
export function inQuietHours(settings: Pick<AssistantSettings, 'timezone' | 'quietStart' | 'quietEnd'>, now: number): boolean {
  if (!settings.quietStart || !settings.quietEnd) return false;
  const start = minutesOfDay(settings.quietStart), end = minutesOfDay(settings.quietEnd);
  if (start === end) return false;
  const current = localMinutesOfDay(settings.timezone, now);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function minutesOfDay(hhmm: string): number {
  const [hours = 0, minutes = 0] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

function localMinutesOfDay(timeZone: string, now: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return part('hour') * 60 + part('minute');
}
