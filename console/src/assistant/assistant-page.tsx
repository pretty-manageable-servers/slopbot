// /assistant: Bud. The home chat is the main area. The right column has what waits for the user (approvals), the
// sprouts and the activity. While Bud is off, the page says so and offers to turn it on.
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ChatHeader, SidebarToggle } from "agentic-ui-kit";
import { Button, EmptyState } from "slop-ui-components";
import { api } from "../api";
import { ChatPage } from "../chat-page";
import { notifyError } from "../ui/feedback";
import { ActivityFeed } from "./activity";
import { Approvals } from "./approvals";
import { Sprouts } from "./sprouts";
import { assistantKey, assistantQuery } from "./queries";

export function AssistantPage() {
  const { data } = useSuspenseQuery(assistantQuery);
  const { settings, tasks, pending, homeChat } = data;
  if (!settings.enabled) return <OffPage />;
  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatPage id={homeChat} />
      </div>
      <aside className="flex max-h-[60dvh] shrink-0 flex-col gap-6 overflow-y-auto border-t border-border p-4 lg:max-h-none lg:w-96 lg:border-t-0 lg:border-l">
        <section aria-labelledby="bud-waiting">
          <h2 id="bud-waiting" className="m-0 mb-2 text-ui font-medium">Waiting for you</h2>
          <Approvals approvals={pending} />
        </section>
        <section aria-labelledby="bud-sprouts">
          <h2 id="bud-sprouts" className="m-0 mb-2 text-ui font-medium">Sprouts</h2>
          <Sprouts tasks={tasks} />
        </section>
        <ActivityFeed />
      </aside>
    </div>
  );
}

/** Bud is off: nothing runs and the home chat is not shown. Turning it on writes the setting and shows the page. */
function OffPage() {
  const client = useQueryClient();
  const turnOn = useMutation({
    mutationFn: () => api.updateAssistantSettings({ enabled: true }),
    onSuccess: () => void client.invalidateQueries({ queryKey: assistantKey }),
    onError: notifyError,
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader leading={<SidebarToggle drawerOnly />} title="Bud" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyState
          headingLevel={2}
          title="Bud is off"
          description="Bud is an assistant that works on goals for you in the background. It asks before it uses a tool you have not allowed, and it reports what it did here. Nothing runs until you turn it on."
          actions={<Button variant="primary" size="sm" isDisabled={turnOn.isPending} onPress={() => turnOn.mutate()}>Turn on Bud</Button>}
        />
      </div>
    </div>
  );
}
