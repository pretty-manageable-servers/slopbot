#!/usr/bin/env bash
set -euo pipefail
: "${GH_TOKEN:?Missing GitHub release download token}"
: "${PMS_TOKEN:?Missing PMS_TOKEN project deployment secret}"
: "${IMAGE:?}"
umask 077
mkdir -p "$RUNNER_TEMP/pms-bin"
cd "$RUNNER_TEMP/pms-bin"
gh release download v0.7.0 --repo pretty-manageable-servers/pmservers-cli --pattern 'pms-v0.7.0-x86_64-unknown-linux-gnu.tar.gz' --pattern SHA256SUMS
grep 'pms-v0.7.0-x86_64-unknown-linux-gnu.tar.gz$' SHA256SUMS | sha256sum --check -
tar -xzf pms-v0.7.0-x86_64-unknown-linux-gnu.tar.gz --strip-components=1
./pms --project slop container edit "${CONTAINER:-slopbot}" --image "$IMAGE" --set-env "OUTPUT_TOKENS=${OUTPUT_TOKENS:-65536}" --set-env "CONTEXT_TOKENS=${CONTEXT_TOKENS:-131072}" --wait --timeout 600
./pms --project slop container show "${CONTAINER:-slopbot}"
