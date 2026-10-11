export interface FormattingRule {
  readonly id: string;
  readonly instruction?: string;
  readonly apply: (text: string) => string;
}
export interface PresentationPolicy {
  readonly id: string;
  readonly rules: readonly FormattingRule[];
}
export function presentationInstructions(policy?: PresentationPolicy): string {
  return policy?.rules.map(rule => rule.instruction).filter(Boolean).join('\n') ?? '';
}
export function formatReply(text: string, policy?: PresentationPolicy): string {
  return policy?.rules.reduce((output, rule) => rule.apply(output), text) ?? text;
}
