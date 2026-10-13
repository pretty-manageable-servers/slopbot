#!/bin/sh
# Stop before SearXNG starts when SEARXNG_SECRET is missing or still the default.
# SearXNG exits on the default secret too, but the container restart loop hides why.
set -eu

if [ -z "${SEARXNG_SECRET:-}" ]; then
    echo "ERROR: SEARXNG_SECRET is not set. Set it to a random value, for example: openssl rand -hex 32" >&2
    exit 1
fi

if [ "$SEARXNG_SECRET" = "ultrasecretkey" ]; then
    echo "ERROR: SEARXNG_SECRET is the SearXNG default. Set a random value." >&2
    exit 1
fi

exec /usr/local/searxng/entrypoint.sh "$@"
