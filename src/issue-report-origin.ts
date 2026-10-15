import { createHash } from 'node:crypto';
import { decodeToolResult } from './tools.js';

export interface IssueReportOrigin { author: string; channel: string; operationId: string }
export function findIssueReportOrigin(rows: Record<string, unknown>[], url: string, body: string): IssueReportOrigin | undefined {
  for (const row of rows) {
    const operationId = String(row.id);
    const marker = `<!-- slopbot-operation:${createHash('sha256').update(operationId).digest('hex').slice(0, 32)} -->`;
    if (!body.includes(marker)) continue;
    try {
      const result = decodeToolResult(String(row.result));
      if (result.data && typeof result.data === 'object' && !Array.isArray(result.data) && result.data.url === url) return { author: String(row.author), channel: String(row.channel), operationId };
    } catch { /* A legacy non-JSON result cannot establish ownership. */ }
  }
  return undefined;
}
