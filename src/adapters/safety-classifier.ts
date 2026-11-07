// The vane safety check. WP1 of the user instructions plan fills this in.
import type { SafetyClassifier, SafetySource, SafetyVerdict } from "../safety.js";
import type { Attribution, UsageMeter } from "../usage-meter.js";

export interface VaneSafetyOptions { baseUrl: string; apiKey: string; model: string; usage?: UsageMeter; threshold?: () => number }

export class VaneSafetyClassifier implements SafetyClassifier {
  constructor(private readonly options: VaneSafetyOptions, private readonly fetcher: typeof fetch = fetch) {}
  async check(_who: Attribution | undefined, _source: SafetySource, _text: string, _signal?: AbortSignal): Promise<SafetyVerdict> {
    void this.options; void this.fetcher; throw new Error("not implemented");
  }
}
