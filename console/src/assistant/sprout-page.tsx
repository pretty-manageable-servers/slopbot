// /assistant/task/<id>: one sprout. Its chat with Bud is on the left; its goal, status and editor are on the right.
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "slop-ui-components";
import { ChatPage } from "../chat-page";
import { PageNote } from "../ui/page-state";
import { PAUSE_LABEL, STATUS_LABEL, STATUS_TONE } from "./format";
import { assistantQuery, sproutChatId } from "./queries";
import { SproutEditor } from "./sprout-editor";
import { SproutActions } from "./sprouts";

export function SproutPage({ id }: { id: string }) {
  const { data } = useSuspenseQuery(assistantQuery);
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return <PageNote action={<Link to="/assistant">Back to Bud</Link>}>This sprout is not here any more.</PageNote>;
  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatPage id={sproutChatId(task.id)} />
      </div>
      <aside className="flex max-h-[60dvh] shrink-0 flex-col gap-4 overflow-y-auto border-t border-border p-4 lg:max-h-none lg:w-96 lg:border-t-0 lg:border-l">
        <Link to="/assistant" className="text-ui-sm text-muted">Back to Bud</Link>
        <div className="flex flex-col gap-2">
          <h2 className="m-0 font-serif text-lg font-normal">{task.goal}</h2>
          <div className="flex flex-wrap items-center gap-2 text-ui-sm">
            <Badge tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Badge>
            {task.status === "paused" && task.pause && <span className="text-muted">{PAUSE_LABEL[task.pause]}</span>}
            {task.status === "active" && task.pause === "usage" && <span className="text-muted">Waiting for usage reset</span>}
          </div>
          <SproutActions task={task} />
          {task.instructions && <p className="m-0 whitespace-pre-wrap text-ui-sm text-muted">{task.instructions}</p>}
        </div>
        {/* Keyed by revision: a saved or changed sprout starts the form over from the bot's copy. */}
        <SproutEditor key={task.revision} task={task} timezone={data.settings.timezone} />
      </aside>
    </div>
  );
}
