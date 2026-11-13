// The two states a page shows in place of its content: the brand loader while it loads, and a note with words when it cannot.
import type { ReactNode } from "react";
import { EmptyState } from "slop-ui-components";
import { Loader } from "../logo";

/** A page that is still loading: the Slopbot loader in place of its content. */
export function PageLoading() {
  return <div className="page-note" aria-busy="true"><Loader size={56} /></div>;
}

/** A page that cannot show its content: the reason, in place of it. `action` is a link under it, e.g. to sign in. */
export function PageNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <EmptyState className="h-full justify-center" title={children} actions={action} />;
}
