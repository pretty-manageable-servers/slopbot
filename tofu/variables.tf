variable "cloudflare_api_token" {
  description = "Cloudflare API token with tunnel read/write and pmservers.org DNS read/write permissions."
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID for pmservers.org."
  type        = string
}

variable "origin_hostname" {
  description = "Public hostname for the Slopbot configuration console."
  type        = string
  default     = "slopbot.pmservers.org"
}

variable "origin_service" {
  description = "PMS project service confirmed from the live container API, such as http://slopbot:3000."
  type        = string

  validation {
    condition     = can(regex("^https?://[^/]+:[0-9]+$", var.origin_service))
    error_message = "origin_service must be an HTTP(S) service URL with a port and no path."
  }
}
