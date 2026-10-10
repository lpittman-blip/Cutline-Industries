# Artemis API with curl

```bash
export ARTEMIS_URL=http://127.0.0.1:7777
export ARTEMIS_API_KEY=art_...            # from `artemis serve` first run, or POST /v1/keys
H=(-H "Authorization: Bearer $ARTEMIS_API_KEY" -H "content-type: application/json")

# Health (no auth) and status
curl -s $ARTEMIS_URL/v1/health
curl -s "${H[@]}" $ARTEMIS_URL/v1/status

# OpenAI-compatible chat (streaming). model "artemis" = server's provider, "artemis-mock" = offline
curl -sN "${H[@]}" $ARTEMIS_URL/v1/chat/completions \
  -d '{"model":"artemis","stream":true,"messages":[{"role":"user","content":"Hello Artemis"}]}'

# Agentic search primitives
curl -s "${H[@]}" $ARTEMIS_URL/v1/search -d '{"type":"glob","pattern":"src/**/*.ts"}'
curl -s "${H[@]}" $ARTEMIS_URL/v1/search -d '{"type":"grep","pattern":"export function","glob":"*.ts"}'

# Start an autonomous run (confirm mode: writes/edits/shell wait for approval)
RUN=$(curl -s "${H[@]}" $ARTEMIS_URL/v1/agent/runs \
  -d '{"task":"Add a --verbose flag to the CLI","workspace":".","mode":"confirm"}' | jq -r .id)

# Watch it live (SSE). Resume with -H "Last-Event-ID: 12"
curl -sN "${H[@]}" $ARTEMIS_URL/v1/agent/runs/$RUN/events

# Approve / deny the pending action, or cancel
curl -s "${H[@]}" -X POST $ARTEMIS_URL/v1/agent/runs/$RUN/approve -d '{"approved":true}'
curl -s "${H[@]}" -X POST $ARTEMIS_URL/v1/agent/runs/$RUN/approve -d '{"approved":false}'
curl -s "${H[@]}" -X POST $ARTEMIS_URL/v1/agent/runs/$RUN/cancel

# Sessions + memory notes (notes are injected into runs that pass session_id)
SES=$(curl -s "${H[@]}" $ARTEMIS_URL/v1/sessions -d '{"title":"Billing service"}' | jq -r .id)
curl -s "${H[@]}" $ARTEMIS_URL/v1/sessions/$SES/notes -d '{"content":"We use Bun and bun:sqlite; never touch migrations/"}'

# Webhooks (secret is returned once)
curl -s "${H[@]}" $ARTEMIS_URL/v1/webhooks -d '{"url":"https://example.com/artemis","events":["run.completed","run.needs_approval"]}'

# API keys (admin scope)
curl -s "${H[@]}" $ARTEMIS_URL/v1/keys -d '{"name":"slack-bot","scopes":["agent","sessions"]}'
curl -s "${H[@]}" $ARTEMIS_URL/v1/keys
curl -s "${H[@]}" -X DELETE $ARTEMIS_URL/v1/keys/key_...
```
