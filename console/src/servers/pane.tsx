// The drawer in the Servers view: the server picker, then the server's Inbox, channels and threads.
// Not built yet beyond the picker: see the console port plan (Servers drawer package).
import { ServerPicker } from "./picker";

export function ServersPane() {
  return <div className="px-2"><ServerPicker /></div>;
}
