import { formatReply, type PresentationPolicy } from './presentation/policy.js';
import type { ProfileStore } from './profiles.js';

// Internal IDs remain in prompts and logs. Presentation belongs here, not in storage.
export class ReplyRenderer {
  constructor(private readonly profiles?: Pick<ProfileStore, 'findPeople'>, private readonly presentation?: PresentationPolicy) {}
  async render(server: string, text: string, verbatim = false): Promise<string> {
    if (verbatim) return text;
    text = formatReply(text, this.presentation);
    if (!this.profiles) return text;
    const tokens = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s]+|<[@#][^>]*>|"(?:\\.|[^"\\])*"|(?<![\w/@])(\d{17,20})(?!\w)/g;
    const names = new Map<string, string>();
    for (const match of text.matchAll(tokens)) {
      const id = match[1];
      if (!id || names.has(id)) continue;
      const people = await this.profiles.findPeople(server, `<@${id}>`);
      const person = people.find(person => person.id === id);
      if (person) names.set(id, person.name);
    }
    return text.replace(tokens, (whole, id: string | undefined) => id ? names.get(id) ?? whole : whole);
  }
}
