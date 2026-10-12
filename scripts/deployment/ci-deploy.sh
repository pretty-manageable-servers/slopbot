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
./pms --project slop container show "${CONTAINER:-slopbot}" --output json > "$RUNNER_TEMP/slopbot-before-deployment.json"
python3 - <<'PYVARS' > "$RUNNER_TEMP/slopbot-token-overrides"
import json, os
with open(os.environ["RUNNER_TEMP"] + "/slopbot-before-deployment.json") as handle:
    container = json.load(handle)
for name in ("OUTPUT_TOKENS", "CONTEXT_TOKENS"):
    if name in container.get("env_names", []):
        print(name)
PYVARS
edit_args=(--project slop container edit "${CONTAINER:-slopbot}" --image "$IMAGE")
while IFS= read -r name; do
  edit_args+=(--unset-env "$name")
done < "$RUNNER_TEMP/slopbot-token-overrides"
./pms "${edit_args[@]}" --wait --timeout 600
./pms --project slop container show "${CONTAINER:-slopbot}" --output json > "$RUNNER_TEMP/slopbot-deployment.json"
python3 - <<'PYREADY'
import json, os
with open(os.environ["RUNNER_TEMP"] + "/slopbot-deployment.json") as handle:
    container = json.load(handle)
if container.get("status") != "running" or container.get("image") != os.environ["IMAGE"]:
    raise SystemExit("Deployment verification failed: target image is not running; no changelog will be posted")
print("Verified deployed image is running")
PYREADY
