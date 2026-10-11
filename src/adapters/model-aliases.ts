import { requestTimings } from '../request-timing.js';
const legacy: Readonly<Record<string, string>> = { nimbus: 'qwen3.8-flash-next', stratus: 'embeddinggemma2', vane: 'kev' };
// Only known renames on the PMServers gateway. Other providers/errors never retry.
export class ModelAliases {
  private readonly resolved = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}
  async request(model: string, send: (wireModel: string) => Promise<Response>): Promise<Response> {
    const wire = this.resolved.get(model) ?? model;
    const response = await send(wire);
    if (new URL(this.baseUrl).hostname !== 'api.pmservers.org' || !legacy[model] || ![403, 404].includes(response.status)) return response;
    let code: unknown;
    try { code = (await requestTimings.wait('model alias response body', () => response.json()) as { error?: { code?: unknown } }).error?.code; } catch { return response; }
    if (code !== 'model_not_allowed' && code !== 'model_not_found') return response;
    const alternate = wire === model ? legacy[model]! : model;
    const retry = await send(alternate);
    if (retry.ok) this.resolved.set(model, alternate);
    return retry;
  }
}
