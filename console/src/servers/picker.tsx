// The server picker at the top of the Servers view. It sets the picked server for the whole console.
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";
import { Button, Menu, MenuItem, MenuTrigger } from "slop-ui-components";
import { pickServer, sessionQuery, useServer } from "../data";
import { ServerMark } from "../ui/layout";

export function ServerPicker() {
  const { data: session } = useSuspenseQuery(sessionQuery);
  const server = useServer();
  const navigate = useNavigate();
  if (session.servers.length < 2) {
    return <div className="flex items-center gap-2 px-2 py-1.5 text-sm"><ServerMark server={server} /><span className="truncate">{server.name}</span></div>;
  }
  return (
    <MenuTrigger>
      <Button variant="ghost" className="w-full justify-start" aria-label={`Server: ${server.name}`}>
        <ServerMark server={server} />
        <span className="min-w-0 flex-1 truncate text-left">{server.name}</span>
        <ChevronsUpDown className="text-muted" />
      </Button>
      <Menu aria-label="Server" selectionMode="single" selectedKeys={[server.id]} disallowEmptySelection
        onAction={(id) => { pickServer(String(id)); void navigate({ to: "/server/$serverId", params: { serverId: String(id) } }); }}>
        {session.servers.map((s) => <MenuItem key={s.id} id={s.id} icon={<ServerMark server={s} />}>{s.name}</MenuItem>)}
      </Menu>
    </MenuTrigger>
  );
}
