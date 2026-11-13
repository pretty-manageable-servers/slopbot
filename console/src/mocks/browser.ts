// The fake bot for `pnpm dev:mock`: the console in a browser with no bot running. main.tsx starts it when
// VITE_MOCK_API is set.
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...Object.values(handlers));
