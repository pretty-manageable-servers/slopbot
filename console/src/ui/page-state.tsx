// The two states a page shows in place of its content: the spinner while it loads, and a note with words when it cannot.
import type { ReactNode } from "react";
import { Loader } from "../logo";

/** A page that is still loading: a spinner in place of its content. */
export function PageLoading() {
  return <div className="page-note" aria-busy="true"><Loader size={56} /></div>;
}

/** A page that cannot show its content: the reason, in place of it. */
export function PageNote({ children }: { children: ReactNode }) {
  return <div className="page-note"><p>{children}</p></div>;
}
