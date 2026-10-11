import type { PresentationPolicy } from './policy.js';

// Decide once for the whole reply, before message-length splitting.
export function suppressLinkPreviews(text: string): boolean {
  const visible = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, '');
  return [...visible.matchAll(/https?:\/\/[^\s<>]+/gi)].length > 1;
}

function cells(line: string): string[] | undefined {
  if (!line.includes('|')) return;
  const parts: string[] = []; let part = '', ticks = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '\\' && line[i + 1] === '|') { part += '|'; i++; continue; }
    if (char === '`') { let count = 1; while (line[i + 1] === '`') { count++; i++; } ticks = ticks === count ? 0 : ticks || count; part += '`'.repeat(count); continue; }
    if (char === '|' && !ticks) { parts.push(part.trim()); part = ''; } else part += char;
  }
  parts.push(part.trim());
  if (line.trimStart().startsWith('|')) parts.shift();
  if (line.trimEnd().endsWith('|') && (line.trimStart().startsWith('|') || parts.length > 2)) parts.pop();
  return parts;
}

export function tablesToLists(text: string): string {
  const lines = text.split('\n'), output: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && line.slice(marker[0].length).trim() === '') fence = undefined;
      output.push(line); continue;
    }
    if (fence) { output.push(line); continue; }
    const headers = cells(line), separator = cells(lines[i + 1] ?? '');
    if (!headers || headers.length < 2 || separator?.length !== headers.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) { output.push(line); continue; }
    const rows: string[][] = [];
    let next = i + 2;
    while (next < lines.length) {
      const row = cells(lines[next]!);
      if (row?.length !== headers.length) break;
      rows.push(row); next++;
    }
    if (!rows.length) { output.push(line); continue; }
    output.push(...rows.map(row => '- ' + row.map((cell, column) => `**${headers[column] || `Column ${column + 1}`}:** ${cell || '(empty)'}`).join('; ')));
    i = next - 1;
  }
  return output.join('\n');
}

export const discordPresentation: PresentationPolicy = {
  id: 'discord-v1',
  rules: [{
    id: 'tables-as-lists',
    instruction: 'Replies are displayed in Discord. Markdown tables do not render. Use short paragraphs or bullet lists for comparisons. Use fenced code blocks for actual code, not to simulate tables.',
    apply: tablesToLists,
  }],
};
