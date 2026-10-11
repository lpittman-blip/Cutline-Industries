# Data Detective

Upload a CSV, ask questions about it. An OpenAI agent inspects the data, writes
and runs Python in a hosted sandbox, draws charts, and says what it is not sure
about. Follow-ups stay in the same session; the whole session downloads as one
self-contained HTML report.

## Run it

```bash
npm install
export OPENAI_API_KEY=...      # in the shell; never in the client or a commit
npm start                      # http://localhost:3000
```

Then press **Try the sample** — no file needed to see it work.

```bash
npm run check       # 40 checks, no API key, no spend
npm run typecheck
```

`PORT` and `DATA_DETECTIVE_MODEL` override the defaults (3000, `gpt-5.1`).

## Where the credentials live

The key is read once, server-side, at startup, and the process exits if it is
missing. The browser never receives it, never sees an OpenAI URL, and cannot
reach the model except through this app's own routes. Charts are **proxied**
through `/api/chart` rather than linked, for the same reason.

Upstream errors are rewritten before they reach the browser: a 401 echoes part
of the key back (`sk-dummy**********test`), so auth failures become "check the
server logs" and the detail goes to the server console instead.

## How it works

| | |
| --- | --- |
| `POST /api/upload` | parses a preview locally, then sends the file to the Files API |
| `POST /api/sample` | same, with the bundled dataset |
| `GET /api/ask` | server-sent events: progress, then the answer |
| `GET /api/chart` | proxies one PNG out of the sandbox container |
| `GET /api/report` | self-contained HTML, charts inlined as data URIs |

The CSV is parsed locally **before** any API call, so a file that is not a CSV
is rejected in milliseconds instead of after an upload and a model call.

**Progress** comes from the SDK's run-item stream events — `reasoning_item_created`,
`tool_called`, `tool_output`, `message_output_created` — mapped to plain
language. When the tool call carries its Python, the code itself is shown. Text
deltas stream into the answer as it is written.

**Charts** are produced by matplotlib inside the container and referenced back
as container file ids. `collectCharts` walks the response structure looking for
`container_id` and `file_id` rather than asserting a fixed path, because that
nesting has moved between API versions; anything that will not download is
dropped rather than left as a broken image.

**The report** inlines its charts as data URIs, so it still renders after the
container expires and after it has been emailed on. A report that only works
while the server is up is not a report.

## Sandbox and data handling

The container runs with **no network access** (`network_policy: disabled`) and a
1 GB memory limit. It analyses the file it was given and cannot send it
anywhere.

Sessions live in process memory for one hour and are then dropped. Nothing is
written to disk. A restart loses sessions, which is the right trade for data
someone uploaded to try an app.

## The sample dataset

`sample-data/coffee-shop-sales.csv` — 2,232 rows, three stores, six products,
July–October 2026. It has real structure to find, verified before shipping:

- a strong weekday pattern (Fri ≈ 5.4 units/row vs Sun ≈ 2.1);
- one store that looks fine on revenue but converts at less than half the
  others once you divide by foot traffic;
- a 1 September price rise on drinks only, followed by an 8–10% volume drop in
  exactly those products while the unchanged pastries hold flat.

It is also deliberately messy, so the caveats have something to bite on: 24
blank revenues, 9 blank foot-traffic values, one negative quantity, 15
case-inconsistent store names and 18 duplicated rows. A careful agent should
mention these; one that reports clean totals without comment is not reading
the file.

One honest wrinkle: flat white got the same 10% rise but barely moved. The
elasticity story is real for three of four products and noisy for the fourth,
which is what actual data looks like.

## Verified

- `npm run check` — **40/40**, covering quoted/multiline CSV fields, CRLF,
  non-CSV rejection, session expiry and sweeping, stream-event mapping,
  chart collection across two response shapes, deduplication, and HTML
  escaping in the report.
- `tsc --noEmit` — clean under `strict`.
- Boots and serves: `/api/health`, the page and both static assets return 200.
- Error paths exercised with a deliberately bad key: unknown session → 404 on
  ask, report and chart; non-CSV upload → a useful message; auth failure → a
  generic message with no key fragment, detail in the server log.

**Not verified: a real model call.** No valid API key was available in the build
environment, so the sandbox run, chart generation and report embedding are
untested against the live API. The first thing to try with a real key is
**Try the sample** → *"What data-quality problems should I know about before
trusting this?"*, which exercises upload, sandbox, charts and report in one go.

## Note for this repo

This app calls an OpenAI model. Blueprint Decisions 5 and 12 keep external
models out of Artemis's product code, reasoning and training data — this is a
standalone demo app under `apps/`, imports nothing from `gateway/`, and nothing
it produces goes near a training corpus.
