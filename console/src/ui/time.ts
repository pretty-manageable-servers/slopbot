// Times as the console words them.
import { formatRelativeTime } from "agentic-ui-kit";

/** "4 days ago" for a time in milliseconds since the epoch. */
export const ago = (ms: number) => formatRelativeTime(new Date(ms).toISOString());
