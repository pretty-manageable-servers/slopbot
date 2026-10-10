# Local development

Production runs on PMServers. Development runs locally with its own Discord application, AI key and `slopbot_dev` Postgres schema. Both use the managed Postgres service and the production SearXNG service over Tailscale.

1. Put the development Discord token in `.env.development`, along with the test server ID and optional allowed channel IDs.
2. Connect Tailscale.
3. Run `npm run dev`. TypeScript recompiles and Node restarts when code changes.

The launcher rejects the production token and requires the development schema. Database isolation separates history, settings, jobs, memory and worker leases. It is schema isolation, not a database permission boundary; the shared database credential can access production. Never copy a production configuration into development.

The production container exposes search on private Tailscale port 8080 and Postgres on private port 5432. It uses userspace networking and a reusable auth key. No public listener is opened. Production can run if the private connection fails; development cannot reach its services until that connection is restored. Auth-key expiration requires replacement.

Secrets stay in `.env.development` and `data/deployment/`, both ignored by Git. Pushes to main still deploy production. A development token is never added to PMServers or GitHub Actions.
