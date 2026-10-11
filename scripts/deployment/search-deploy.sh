#!/usr/bin/env bash
set -euo pipefail
: "${PMS_TOKEN:?}"
: "${IMAGE:?}"
mkdir -p "$RUNNER_TEMP/pms-bin"
cd "$RUNNER_TEMP/pms-bin"
gh release download v0.7.0 --repo pretty-manageable-servers/pmservers-cli --pattern 'pms-v0.7.0-x86_64-unknown-linux-gnu.tar.gz' --pattern SHA256SUMS
grep 'pms-v0.7.0-x86_64-unknown-linux-gnu.tar.gz$' SHA256SUMS | sha256sum --check -
tar -xzf pms-v0.7.0-x86_64-unknown-linux-gnu.tar.gz --strip-components=1
# Distinguish a missing container from authentication or service failures.
./pms --project slop --output json container list > containers.json
if python3 -c 'import json,sys; sys.exit(0 if any(x["name"]=="slopbot-search" for x in json.load(open("containers.json"))) else 1)'; then
  ./pms --project slop container edit slopbot-search --image "$IMAGE" --wait --timeout 600
else
  echo 'Search image published. The search container has not been created yet.'
fi
