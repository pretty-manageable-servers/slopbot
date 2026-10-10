#!/usr/bin/env bash
set -euo pipefail
: "${GH_TOKEN:?Missing DEPLOY_GITHUB_TOKEN repository secret}"
: "${PMS_SESSION:?Missing dedicated PMS_SESSION repository secret}"
: "${PMS_CONFIG_DIR:?}"
: "${IMAGE:?}"
umask 077
mkdir -p "$PMS_CONFIG_DIR" "$RUNNER_TEMP/pms-bin"
printf '%s' "$PMS_SESSION" > "$PMS_CONFIG_DIR/credentials.json"
unset PMS_SESSION
# Refresh tokens rotate. Persist the new session even if rollout fails.
save_session() {
  gh secret set PMS_SESSION --repo "$GITHUB_REPOSITORY" < "$PMS_CONFIG_DIR/credentials.json"
  rm -rf "$PMS_CONFIG_DIR"
}
trap save_session EXIT
cd "$RUNNER_TEMP/pms-bin"
gh release download v0.1.1 --repo pretty-manageable-servers/pmservers-cli --pattern 'pms-v0.1.1-x86_64-unknown-linux-gnu.tar.gz' --pattern SHA256SUMS
rg 'pms-v0.1.1-x86_64-unknown-linux-gnu.tar.gz$' SHA256SUMS | sha256sum --check -
tar -xzf pms-v0.1.1-x86_64-unknown-linux-gnu.tar.gz
./pms --project slop container edit slopbot --image "$IMAGE" --wait --timeout 600
./pms --project slop container show slopbot
