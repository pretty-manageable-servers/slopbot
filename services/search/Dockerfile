# Pinned to SearXNG 2026.10.11-ad46ebd7d. Digest checked with docker buildx imagetools inspect on 2026-10-13.
FROM docker.io/searxng/searxng:2026.10.11-ad46ebd7d@sha256:ddd642cae6eac75412938fd846ddbf440a2df029cfeae8a562b8b205f4e35e25
COPY settings.yml /etc/searxng/settings.yml
COPY require-secret.sh /usr/local/bin/require-secret.sh
# Fail with a clear message when SEARXNG_SECRET is missing. Then start the image's own entrypoint.
ENTRYPOINT ["/bin/sh", "/usr/local/bin/require-secret.sh"]
