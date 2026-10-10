/** Self-contained, Artemis-branded API reference rendered from the OpenAPI document. */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function docsHtml(spec: any): string {
  const sections = new Map<string, string[]>();
  for (const [p, methods] of Object.entries<any>(spec.paths)) {
    for (const [m, o] of Object.entries<any>(methods)) {
      const tag = o.tags?.[0] ?? "Other";
      const scope = o["x-artemis-scope"] ? `<span class="scope">${esc(o["x-artemis-scope"])}</span>` : o.security?.length === 0 ? `<span class="scope pub">public</span>` : "";
      const row = `<div class="op"><span class="m m-${m}">${m.toUpperCase()}</span><code>${esc(p)}</code>${scope}<div class="sum">${esc(o.summary ?? "")}</div>${o.description ? `<div class="desc">${esc(o.description)}</div>` : ""}</div>`;
      if (!sections.has(tag)) sections.set(tag, []);
      sections.get(tag)!.push(row);
    }
  }
  const body = [...sections].map(([t, rows]) => `<section><h2>${esc(t)}</h2>${rows.join("")}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Artemis API reference</title>
<style>
:root{--blue:#2f6fed;--sky:#4c8dff;--green:#3dbe78;--orange:#f08a3c;--bg:#070b16;--card:#0e1526;--text:#e8edf7;--muted:#8a94a6}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,rgba(47,111,237,.25),transparent),var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Inter,sans-serif}
header{padding:48px 24px 24px;max-width:980px;margin:auto}h1{margin:0;font-size:34px;letter-spacing:-.02em}h1 b{background:linear-gradient(90deg,var(--blue),var(--sky),var(--green));-webkit-background-clip:text;color:transparent}
.lead{color:var(--muted);max-width:720px}.pill{display:inline-block;margin:12px 8px 0 0;padding:6px 14px;border-radius:999px;border:1px solid #24304a;color:var(--text);text-decoration:none;font-size:13px}.pill:hover{border-color:var(--sky)}
main{max-width:980px;margin:auto;padding:0 24px 64px}h2{margin:32px 0 10px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--sky)}
.op{background:var(--card);border:1px solid #1b2540;border-radius:14px;padding:12px 16px;margin:8px 0}.op code{font-size:14px;color:var(--text)}
.m{display:inline-block;min-width:62px;font:600 12px ui-monospace,monospace;padding:3px 8px;border-radius:8px;margin-right:10px;text-align:center}
.m-get{background:rgba(61,190,120,.15);color:var(--green)}.m-post{background:rgba(76,141,255,.15);color:var(--sky)}.m-delete{background:rgba(240,138,60,.15);color:var(--orange)}
.scope{float:right;font-size:12px;color:var(--muted);border:1px solid #24304a;border-radius:999px;padding:2px 10px}.scope.pub{color:var(--green)}
.sum{margin-top:6px}.desc{margin-top:4px;color:var(--muted);font-size:13.5px}
pre{background:#0a1020;border:1px solid #1b2540;border-radius:12px;padding:14px;overflow:auto;font-size:13px}
</style></head><body>
<header><h1>◆ <b>Artemis</b> API</h1>
<p class="lead">${esc(spec.info.description)}</p>
<a class="pill" href="/v1/openapi.json">OpenAPI 3.1 JSON</a><a class="pill" href="/v1/health">Health</a>
<pre>curl -s ${esc(spec.servers[0].url)}/v1/agent/runs \\
  -H "Authorization: Bearer $ARTEMIS_API_KEY" -H "content-type: application/json" \\
  -d '{"task":"Find where auth tokens are validated","mode":"read_only"}'</pre>
</header><main>${body}</main></body></html>`;
}
