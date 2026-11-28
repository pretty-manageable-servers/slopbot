import type { Notifier } from './types.js';

/** For web-only runs, where there is no Discord client to send DMs. */
export const noopNotifier: Notifier = { notify: async () => {} };
