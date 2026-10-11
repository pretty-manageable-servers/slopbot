# Slopbot console tunnel

This OpenTofu root owns the dedicated remotely managed Cloudflare Tunnel and the `slopbot.pmservers.org` DNS route for Slopbot's configuration console. The marketing copy remains at `https://pmservers.org/slopbot`. The tunnel token is a sensitive output and must be sent to PMS through the protected container edit flow.

The state uses a separate R2 key (`slopbot/console/terraform.tfstate`). Supply the existing R2 bucket and account in a private `backend.hcl`, Cloudflare account/zone IDs in a private `terraform.tfvars`, and `TF_VAR_cloudflare_api_token` through a secure environment manager. Do not commit those files or raw plan/state output.

Before importing or creating resources, inspect Cloudflare for an existing Slopbot tunnel and the `slopbot.pmservers.org` DNS record. Public DNS currently returns NXDOMAIN for this hostname, so no public record is active; still inspect the Cloudflare zone and Pages custom-domain configuration before applying. Import any matching resources rather than duplicating them. Then confirm the Slopbot container's project, declared port and Service name through the PMS API and set `origin_service` to that verified `http://<service>:<port>` value.

```sh
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan -out=slopbot-console.tfplan
tofu show slopbot-console.tfplan
```

Review the redacted plan before applying it. Never share the raw plan file or state: they contain the connector token. Confirm the plan only creates the missing `slopbot.pmservers.org` CNAME and tunnel resources; do not remove any Pages domain or existing DNS record. After approval and apply, send `tofu output -raw tunnel_token` directly to PMS through the protected tunnel token field, and register `https://slopbot.pmservers.org/auth/callback` in the Discord application's OAuth2 settings.
