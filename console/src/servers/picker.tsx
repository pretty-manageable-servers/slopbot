// The server picker at the top of the Servers view. It sets the picked server for the whole console.
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, defaultIcons } from "agentic-ui-kit";
import { pickServer, sessionQuery, useServer } from "../data";
import { DropdownMenu } from "../ui/menu";
import { ServerMark } from "../ui/layout";

export function ServerPicker() {
  const { data: session } = useSuspenseQuery(sessionQuery);
  const server = useServer();
  const navigate = useNavigate();
  if (session.servers.length < 2) {
    return <div className="flex items-center gap-2 px-2 py-1.5 text-sm"><ServerMark server={server} /><span className="truncate">{server.name}</span></div>;
  }
  return (
    <DropdownMenu label="Server" selected={server.id} width="trigger"
      items={session.servers.map((s) => ({ id: s.id, label: s.name, icon: <ServerMark server={s} /> }))}
      onSelect={(id) => { pickServer(id); void navigate({ to: "/server/$serverId", params: { serverId: id } }); }}
      trigger={
        <Button variant="ghost" className="w-full justify-start gap-2" aria-label={`Server: ${server.name}`}>
          <ServerMark server={server} />
          <span className="min-w-0 flex-1 truncate text-left">{server.name}</span>
          {defaultIcons.dropdown}
        </Button>
      } />
  );
}
