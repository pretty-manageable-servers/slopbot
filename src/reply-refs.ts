/**
 * Turns the refs and IDs in a model reply into what the user sees.
 * The model writes refs such as "m3" (or "s2" for a task source); code makes the Discord links.
 * The model never writes message links or user IDs itself, so any link it does write is removed unless it is real.
 * Code blocks (fenced and inline) are left as they are.
 */

const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;
// The last character is not punctuation, so a full stop after a link stays in the text.
const BARE_DISCORD_LINK = /https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/channels\/(?:[^\s)<>\]]*[^\s)<>\].,;:!?])?/g;
const DISCORD_CHANNEL_URL = /^https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/channels\/[^/\s]+\/[^/\s]+(?:\/([^/\s?#]*))?/;
// A ref with optional brackets or parentheses around it. The lookarounds keep words such as "gm3x" or "m3u8" unchanged.
const REF_TOKEN = /\[(#?[ms]\d+)\]|\((#?[ms]\d+)\)|(?<![\w#])(#?[ms]\d+)(?!\w)/g;
// A raw user ID that is not already part of a mention, channel, role or emoji tag, and not a longer number.
const RAW_USER_ID = /(?<![\w<@!&#:])(\d{17,20})(?!\d)/g;
const HAS_REF = /(?<![\w#])#?[ms]\d+(?!\w)/;

/**
 * The message ID of a Discord channel URL, or undefined when the URL is not one or has no message ID.
 * Exported for tests.
 */
export function discordMessageId(url: string): string | undefined {
  const match = DISCORD_CHANNEL_URL.exec(url);
  return match?.[1] && /^\d{17,20}$/.test(match[1]) ? match[1] : undefined;
}

export function messageLinkOf(server: string, channel: string, id: string): string {
  return `https://discord.com/channels/${server}/${channel}/${id}`;
}

/**
 * Makes the final text of a reply.
 * `refs` maps a ref ("m3" or "#m3", "s2") to its real message ID.
 * `place` is the channel of this reply, used for "m" refs.
 * `sourcePlace` is the source channel of a task, used for "s" refs. It defaults to `place`.
 * `knownUsers` are the user IDs that may become mentions.
 */
export function linkRefs(text: string, refs: ReadonlyMap<string, string>, place: { server: string; channel: string }, knownUsers: ReadonlySet<string>, sourcePlace: { server: string; channel: string } = place): string {
  const realIds = new Map<string, string>(); // real message ID -> ref
  for (const [ref, id] of refs) realIds.set(id, ref.replace(/^#/, ""));
  const placeFor = (ref: string) => ref.startsWith("s") ? sourcePlace : place;
  const linkFor = (id: string): string | undefined => {
    const ref = realIds.get(id);
    if (ref === undefined) return undefined;
    const target = placeFor(ref);
    return messageLinkOf(target.server, target.channel, id);
  };

  // Code is cut out first, so nothing inside it changes.
  const pieces = text.split(CODE);
  const codes = text.match(CODE) ?? [];
  const out: string[] = [];
  pieces.forEach((piece, index) => {
    out.push(linkPlain(piece, linkFor, refs, placeFor, knownUsers));
    if (index < codes.length) out.push(codes[index]!);
  });
  return out.join("");
}

function linkPlain(input: string, linkFor: (id: string) => string | undefined, refs: ReadonlyMap<string, string>,
  placeFor: (ref: string) => { server: string; channel: string }, knownUsers: ReadonlySet<string>): string {
  // Markdown links are final once they are made. Their text is kept, but not their URL unless it is real.
  const protectedParts: string[] = [];
  const protect = (value: string): string => `${protectedParts.push(value) - 1}`;

  let text = input.replace(MARKDOWN_LINK, (match, label: string, url: string) => {
    if (!DISCORD_CHANNEL_URL.test(url)) return protect(match);
    const id = discordMessageId(url);
    const link = id === undefined ? undefined : linkFor(id);
    if (link === undefined) return label; // Made-up link: keep the text, drop the URL.
    return protect(HAS_REF.test(label) ? `[↗](${link})` : `[${label}](${link})`);
  });

  text = text.replace(BARE_DISCORD_LINK, url => {
    const id = discordMessageId(url);
    const link = id === undefined ? undefined : linkFor(id);
    return link === undefined ? "" : protect(link);
  });

  text = text.replace(REF_TOKEN, (match, bracketed: string | undefined, parenthesised: string | undefined, bare: string | undefined) => {
    const ref = (bracketed ?? parenthesised ?? bare ?? "").replace(/^#/, "");
    const id = refs.get(ref);
    if (id === undefined) return match; // Unknown ref: leave it as text.
    const target = placeFor(ref);
    return protect(`[↗](${messageLinkOf(target.server, target.channel, id)})`);
  });

  text = text.replace(RAW_USER_ID, (match, id: string) => knownUsers.has(id) ? protect(`<@${id}>`) : match);

  return text.replace(/(\d+)/g, (_, index: string) => protectedParts[Number(index)]!);
}
