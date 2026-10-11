resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "slopbot_console" {
  account_id    = var.account_id
  name          = "slopbot-console"
  config_src    = "cloudflare"
  tunnel_secret = random_id.tunnel_secret.b64_std
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "slopbot_console" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.slopbot_console.id

  config = {
    ingress = [
      {
        hostname = var.origin_hostname
        service  = var.origin_service
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

resource "cloudflare_dns_record" "slopbot_console_origin" {
  zone_id = var.zone_id
  name    = var.origin_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.slopbot_console.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "slopbot_console" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.slopbot_console.id
}

output "tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.slopbot_console.id
}

output "tunnel_token" {
  value     = data.cloudflare_zero_trust_tunnel_cloudflared_token.slopbot_console.token
  sensitive = true
}

output "console_origin" {
  value = "https://${var.origin_hostname}"
}
