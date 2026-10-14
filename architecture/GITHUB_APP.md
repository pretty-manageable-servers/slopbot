# GitHub App setup

Slopbot files reports as the App's bot account and includes the Discord reporter ID in the body. Discord members in dynamically discovered servers can search issues and publish reports backed by interaction evidence they can access. Repository files, CI, infrastructure diagnostics and fix watches require Manage Server and an explicit server allowlist. Members cannot publish saved infrastructure evidence.

## Create and install the App

1. Open your organization's Settings → Developer settings → GitHub Apps → New GitHub App. An organization owner may need to register/install it.
2. Choose a unique name, such as `Slopbot issue reporter`, and use `https://github.com/pretty-manageable-servers/slopbot` as the homepage URL.
3. Leave callback/setup URLs empty, leave user authorization and device flow disabled, and uncheck **Active** under Webhook. This integration needs no inbound endpoint, webhook secret, client secret or per-user GitHub login.
4. Set repository permissions: **Issues: Read and write**, **Contents: Read-only**, **Actions: Read-only**, **Pull requests: Read-only**. Metadata read is automatic. Leave organization/account permissions unset.
5. Select installation on **Only on this account**, then create the App.
6. Copy the numeric **App ID** from its settings page. Generate and download a **private key**.
7. Under **Install App**, install on `pretty-manageable-servers`, selecting only `slopbot`. Copy the installation ID from the installation settings URL, whose path ends in `/installations/NUMBER`. This is different from the App ID.

## Configure Slopbot

Add these values to the Slopbot container's runtime environment in PMServers, or the local `.env` / `.env.development` used to run the bot:

```dotenv
SLOPBOT_GITHUB_REPOSITORY=pretty-manageable-servers/slopbot
SLOPBOT_GITHUB_APP_ID=5319780
SLOPBOT_GITHUB_APP_INSTALLATION_ID=YOUR_INSTALLATION_ID
SLOPBOT_GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nYOUR_KEY_CONTENTS\n-----END RSA PRIVATE KEY-----"
```

Use the complete contents of the downloaded PEM for the private-key secret. Actual multiline PEM and literal `\n` escapes are both supported. Leave `SLOPBOT_GITHUB_TOKEN` empty or unset. Never commit the key or paste it into Discord. The App ID and installation ID are not secrets.

No guild ID is needed for issue reporting. Slopbot discovers servers dynamically and respects configured bot channels and task permissions. Optionally set `SLOPBOT_OPERATIONS_GUILD_IDS` to comma-separated trusted Discord server IDs to enable admin repository/CI diagnostics and fix watches there. Restart/redeploy Slopbot after setting the environment. Slopbot generates and refreshes its own installation tokens; do not manually supply an hourly token. Startup validates complete credentials and RSA key format. GitHub installation access is checked on the first API request.

PMServers diagnostic credentials are optional for issue filing. Set `SLOPBOT_PMS_TOKEN`, `SLOPBOT_PMS_PROJECT_ID` and `SLOPBOT_PMS_CONTAINERS` separately to enable live diagnostics for admins. Deployment credentials are not reused.

## Verify

In a Discord server where Slopbot is active, use an ordinary member account in a configured bot channel or task thread. Ask Slopbot to search for existing issues. Then reply to a failed interaction with “Collect evidence and file a GitHub issue.” Confirm the issue author is the App bot and its body identifies the Discord reporter. Admin diagnostic tools should remain unavailable to ordinary members.

A 403/404 usually indicates installation/repository access or missing permissions. A failed token request can indicate an incorrect App ID, installation ID or private key. After changing App permissions, approve the installation's updated permissions in GitHub. Rotate a compromised key in GitHub and replace the runtime secret.

References: [Registering an App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [App JWTs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
