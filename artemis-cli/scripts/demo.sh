#!/usr/bin/env bash
# End-to-end demo: start the Artemis server (mock model), log the CLI in, run the agent
# through the server, exercise the API with curl, and try a live read-only task if a key exists.
# Writes docs/demo.txt. Uses a throwaway ARTEMIS_HOME so your real ~/.artemis is untouched.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=docs/demo.txt
PORT=${PORT:-7799}
export ARTEMIS_HOME=$(mktemp -d /tmp/artemis-demo-home.XXXX)
export NO_COLOR=1
URL=http://127.0.0.1:$PORT
: > "$OUT"
say() { printf '\n$ %s\n' "$*" | tee -a "$OUT"; }
run() { say "$*"; eval "$@" 2>&1 | tee -a "$OUT"; }

echo "# Artemis CLI demo transcript — $(date '+%Y-%m-%d %H:%M %Z')" | tee -a "$OUT"
echo "# bun $(bun --version), $(uname -sm). Server uses the offline mock model (ARTEMIS_PROVIDER=mock)." | tee -a "$OUT"

say "ARTEMIS_PROVIDER=mock ARTEMIS_WORKSPACES_ROOT=$ROOT bun src/cli.tsx serve --port $PORT &"
ARTEMIS_PROVIDER=mock ARTEMIS_WORKSPACES_ROOT=$ROOT bun src/cli.tsx serve --port "$PORT" > /tmp/artemis-demo-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 50); do curl -sf "$URL/v1/health" >/dev/null && break; sleep 0.1; done
KEY=$(grep -o 'art_[0-9a-f]\{48\}' /tmp/artemis-demo-server.log | head -1)
sed -r "s/$KEY/art_••••(redacted)/g; s/\x1b\[[0-9;]*m//g" /tmp/artemis-demo-server.log | tee -a "$OUT"

run "bun src/cli.tsx login --url $URL --key \$KEY | sed 's#$ARTEMIS_HOME#~/.artemis#'"
run "bun src/cli.tsx status | head -20"
run "bun src/cli.tsx -p -y 'Survey the Artemis CLI tools and write notes'"
run "head -12 docs/MOCK_NOTES.md"

H="-H 'Authorization: Bearer '\$KEY -H 'content-type: application/json'"
run "curl -s $URL/v1/health"
run "curl -s $H $URL/v1/search -d '{\"type\":\"grep\",\"pattern\":\"export class\",\"glob\":\"*.ts\"}' | jq -c '.count, .results[0:3][]'"
say "RUN=\$(curl -s $H $URL/v1/agent/runs -d '{\"task\":\"Survey the code\",\"mode\":\"confirm\"}' | jq -r .id)"
RUN=$(eval curl -s $H $URL/v1/agent/runs -d "'{\"task\":\"Survey the code\",\"mode\":\"confirm\"}'" | jq -r .id)
echo "$RUN" | tee -a "$OUT"
sleep 1
run "curl -s $H $URL/v1/agent/runs/\$RUN | jq -c '{status, steps, pending: .pending_approval.tool}'"
run "curl -s $H -X POST $URL/v1/agent/runs/\$RUN/approve -d '{\"approved\":true,\"always\":true}' | jq -c '{status}'"
sleep 1
run "curl -sN $H $URL/v1/agent/runs/\$RUN/events | grep '^event:' | sort | uniq -c"
run "curl -s $H $URL/v1/agent/runs/\$RUN | jq -c '{status, steps, summary}'"
run "curl -s $H $URL/v1/chat/completions -d '{\"model\":\"artemis\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"glob\",\"parameters\":{}}}]}' | jq -c '.choices[0].message.tool_calls[0].function'"
run "curl -s -o /dev/null -w '%{http_code}\n' $URL/v1/status"

say "# Live model check (read-only, --direct, uses XAI_API_KEY / OPENAI_API_KEY if set)"
if [ -n "${XAI_API_KEY:-}${OPENAI_API_KEY:-}${ARTEMIS_PROVIDER_KEY:-}" ]; then
  run "timeout 120 bun src/cli.tsx --direct -p --read-only --max-steps 8 'Where is the agent loop implemented? Answer with file:line.'"
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    run "ARTEMIS_PROVIDER_KEY=\$OPENAI_API_KEY ARTEMIS_PROVIDER_BASE_URL=https://api.openai.com/v1 timeout 120 bun src/cli.tsx --direct -p --read-only --max-steps 8 'Where is the agent loop implemented? Answer with file:line.'"
  fi
else
  echo "(no provider key in env: live model untested)" | tee -a "$OUT"
fi

say "# TUI (React + Ink) final frame from a mock run — FORCE_COLOR=3 bun scripts/render-ui.tsx"
FORCE_COLOR=3 bun scripts/render-ui.tsx >/dev/null 2>&1
sed -r 's/\x1b\[[0-9;]*m//g' docs/ui-final.ansi | tee -a "$OUT"

# Never leave key fragments in the transcript (provider errors echo masked keys).
sed -i -E 's/(sk-|xai-)[A-Za-z0-9*_-]{6,}/\1••••(redacted)/g' "$OUT"
rm -rf "$ARTEMIS_HOME"
