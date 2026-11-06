// Money, number and range helpers for Usage & limits. The bot keeps money in micro-dollars (a millionth of a
// dollar) and prices per million tokens; the form shows dollars. The ranges are the bot's (src/admin-panel.ts).

export const MICROS_PER_DOLLAR = 1_000_000;

/** Micro-dollars as dollars for a number field. Rounded to six decimals, so 300000 shows 0.3, not 0.30000000000000004. */
export const dollarsOf = (micros: number) => Number((micros / MICROS_PER_DOLLAR).toFixed(6));

/** Dollars from a number field to micro-dollars. */
export const toMicros = (dollars: number) => Math.round(dollars * MICROS_PER_DOLLAR);

/** A limit or a total with its dollar sign: $1.50. */
export const money = (micros: number) => `$${(micros / MICROS_PER_DOLLAR).toFixed(2)}`;

/** A cost in a table column that already says $: two decimals and the reader's thousands separators. */
export const costText = (micros: number) => (micros / MICROS_PER_DOLLAR).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A price per 1 million tokens: two decimals at least, more only when needed ($0.15, $1.234567). */
export const priceLabel = (micros: number) => {
  const value = dollarsOf(micros);
  const decimals = (String(value).split(".")[1] ?? "").length;
  return `$${value.toFixed(Math.max(2, decimals))}`;
};

/** A count with the reader's thousands separators. */
export const count = (value: number) => value.toLocaleString();

/** A part as a whole percent of the total, capped at 100. Zero when there is no total yet. */
export const sharePercent = (part: number, total: number) => (total > 0 ? Math.min(100, Math.round((part * 100) / total)) : 0);

const DISCORD_CDN = "https://cdn.discordapp.com/";
/** A server icon from Discord's CDN only, as the old console allowed. Anything else gives the letter tile. */
export const iconUrl = (icon: string | null | undefined) => (icon?.startsWith(DISCORD_CDN) ? icon : null);

// ----- Ranges. A field is checked before Save; an empty number field is NaN and fails. -----

export interface Rule { min: number; max: number; whole?: boolean }
export type Issues<F extends string> = Partial<Record<F, string>>;

/** Why a value breaks its rule, or null when it is fine. */
export function rangeError(value: number, { min, max, whole }: Rule): string | null {
  if (!Number.isFinite(value)) return "Enter a number.";
  if (value < min || value > max) return `Enter a number from ${count(min)} to ${count(max)}.`;
  if (whole && !Number.isInteger(value)) return `Enter a whole number from ${count(min)} to ${count(max)}.`;
  return null;
}

/** The problem with each field that has a rule. Fields without a rule are not checked. */
export function checkFields<F extends string>(values: Record<F, number>, rules: Partial<Record<F, Rule>>): Issues<F> {
  const issues: Issues<F> = {};
  for (const field of Object.keys(rules) as F[]) {
    const rule = rules[field];
    const error = rule && rangeError(values[field], rule);
    if (error) issues[field] = error;
  }
  return issues;
}

/** A model ID: one word, up to 200 characters, as the old console checked. */
export function modelError(model: string): string | null {
  const id = model.trim();
  if (!id) return "Enter a model ID.";
  if (/\s/.test(id) || id.length > 200) return "A model ID is one word up to 200 characters.";
  return null;
}

// ----- Usage limits: dollars for each window, a whole percent of grace. -----

export interface LimitsForm { five: number; week: number; grace: number }
const COST_RULE: Rule = { min: 0, max: 1_000_000 };
export const LIMITS_RULES: Record<keyof LimitsForm, Rule> = { five: COST_RULE, week: COST_RULE, grace: { min: 0, max: 1000, whole: true } };
export const limitsBody = (form: LimitsForm) => ({
  five_hour_cost_micros: toMicros(form.five),
  week_cost_micros: toMicros(form.week),
  grace_percent: form.grace,
});

// ----- Model prices: dollars per 1 million tokens. -----

export interface PriceForm { input: number; cached_input: number; output: number }
const PRICE_RULE: Rule = { min: 0, max: 1000 };
export const PRICE_RULES: Record<keyof PriceForm, Rule> = { input: PRICE_RULE, cached_input: PRICE_RULE, output: PRICE_RULE };
export const priceBody = (model: string, form: PriceForm) => ({
  model,
  input: toMicros(form.input),
  cached_input: toMicros(form.cached_input),
  output: toMicros(form.output),
});

// ----- Replies to other bots: the limit, and an optional temporary one with its own length. -----

export interface BotRepliesForm { replies: number; minutes: number; tempReplies: number; tempMinutes: number; tempFor: number }
export const BOT_REPLY_RULES: Record<"replies" | "minutes", Rule> = { replies: { min: 0, max: 1000, whole: true }, minutes: { min: 1, max: 1440, whole: true } };
const TEMPORARY_RULES: Record<"tempReplies" | "tempMinutes" | "tempFor", Rule> = {
  tempReplies: { min: 0, max: 1000, whole: true },
  tempMinutes: { min: 1, max: 1440, whole: true },
  tempFor: { min: 1, max: 10080, whole: true },
};

/** A temporary limit is set only when its "Lasts" field has a value, as the old console did. */
export const hasTemporary = (form: BotRepliesForm) => !Number.isNaN(form.tempFor);

export function botRepliesIssues(form: BotRepliesForm): Issues<keyof BotRepliesForm> {
  return { ...checkFields(form, BOT_REPLY_RULES), ...(hasTemporary(form) && checkFields(form, TEMPORARY_RULES)) };
}

/** The POST body. Without a temporary part the bot keeps the current temporary limit. */
export function botRepliesBody(form: BotRepliesForm) {
  const limit = { replies: form.replies, minutes: form.minutes };
  return hasTemporary(form) ? { ...limit, temporary: { for_minutes: form.tempFor, replies: form.tempReplies, minutes: form.tempMinutes } } : limit;
}

/** The form after a save or a load: the saved limit, its temporary part if any, and an empty "Lasts". */
export function botRepliesForm(view: { replies: number; minutes: number; temporary?: { replies: number; minutes: number; until: number } }): BotRepliesForm {
  return {
    replies: view.replies,
    minutes: view.minutes,
    tempReplies: view.temporary?.replies ?? Number.NaN,
    tempMinutes: view.temporary?.minutes ?? Number.NaN,
    tempFor: Number.NaN,
  };
}

// ----- Scheduled tasks: caps per server and per user, and the shortest interval for each run kind. -----

export interface ScheduleForm { perServer: number; perUser: number; minMessage: number; minPrompt: number; minTool: number }
const SCHEDULE_CAP: Rule = { min: 1, max: 1000, whole: true };
const SCHEDULE_MINUTES: Rule = { min: 1, max: 10080, whole: true };
export const SCHEDULE_RULES: Record<keyof ScheduleForm, Rule> = {
  perServer: SCHEDULE_CAP,
  perUser: SCHEDULE_CAP,
  minMessage: SCHEDULE_MINUTES,
  minPrompt: SCHEDULE_MINUTES,
  minTool: SCHEDULE_MINUTES,
};
export const scheduleBody = (form: ScheduleForm) => ({
  perServer: form.perServer,
  perUser: form.perUser,
  minMinutes: { message: form.minMessage, prompt: form.minPrompt, tool: form.minTool },
});
