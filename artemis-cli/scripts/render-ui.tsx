/**
 * Renders the real Ink UI (mock provider, against this repo) and writes:
 *   docs/ui-confirm.ansi / docs/ui-final.ansi  (raw frames)
 *   docs/demo.html                              (ANSI → HTML, for the PNG screenshot)
 * Usage: FORCE_COLOR=3 bun scripts/render-ui.tsx
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { render } from "ink-testing-library";
import { MockProvider } from "../src/agent/mock.ts";
import { App } from "../src/ui/App.tsx";

const root = path.resolve(import.meta.dir, "..");
const docs = path.join(root, "docs");
const strip = (s = "") => s.replace(/\x1b\[[0-9;]*m/g, "");
const until = async (f: () => boolean) => { const t = Date.now(); while (!f()) { if (Date.now() - t > 10_000) throw new Error("timeout"); await Bun.sleep(20); } };

const ui = render(<App provider={new MockProvider()} connection="mock" target="offline" root={root} mode="confirm" maxSteps={25} initialTask="Survey the Artemis CLI tools and write notes" />);
await until(() => strip(ui.lastFrame()).includes("Approve write_file?"));
const confirm = ui.lastFrame()!;
await Bun.sleep(30);
ui.stdin.write("a"); // allow all for this session
await until(() => strip(ui.lastFrame()).includes("Done in"));
await Bun.sleep(80);
const final = ui.lastFrame()!;
ui.unmount();

writeFileSync(path.join(docs, "ui-confirm.ansi"), confirm + "\n");
writeFileSync(path.join(docs, "ui-final.ansi"), final + "\n");

function ansiToHtml(s: string): string {
  let out = "", open = false;
  const st = { fg: "", bg: "", bold: false, dim: false };
  const flush = () => { if (open) out += "</span>"; const fg = inverse ? st.bg || "#0b1020" : st.fg, bg = inverse ? st.fg || "#e8edf7" : st.bg; const css = [fg && `color:${fg}`, bg && `background:${bg}`, st.bold && "font-weight:700", st.dim && "opacity:.6"].filter(Boolean).join(";"); out += `<span style="${css}">`; open = true; };
  const rgb = (r: string, g: string, b: string) => `rgb(${r},${g},${b})`;
  const basic = ["#0b1020", "#ef5b5b", "#3dbe78", "#f0c43c", "#2f6fed", "#c678dd", "#4c8dff", "#e8edf7"];
  const bright = ["#6b7488", "#ff7a7a", "#5fd896", "#ffd66b", "#4c8dff", "#d79cf0", "#7fb0ff", "#ffffff"];
  let inverse = false;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m: RegExpExecArray | null;
  flush();
  while ((m = re.exec(s))) {
    out += s.slice(last, m.index).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    last = re.lastIndex;
    const codes = m[1]!.split(";").filter(Boolean);
    if (!codes.length) codes.push("0");
    for (let i = 0; i < codes.length; i++) {
      const c = Number(codes[i]);
      if (c === 0) { Object.assign(st, { fg: "", bg: "", bold: false, dim: false }); inverse = false; }
      else if (c === 7) inverse = true;
      else if (c === 27) inverse = false;
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 39) st.fg = "";
      else if (c === 49) st.bg = "";
      else if (c >= 30 && c <= 37) st.fg = basic[c - 30]!;
      else if (c >= 90 && c <= 97) st.fg = bright[c - 90]!;
      else if (c >= 40 && c <= 47) st.bg = basic[c - 40]!;
      else if ((c === 38 || c === 48) && codes[i + 1] === "2") { const v = rgb(codes[i + 2]!, codes[i + 3]!, codes[i + 4]!); if (c === 38) st.fg = v; else st.bg = v; i += 4; }
      else if ((c === 38 || c === 48) && codes[i + 1] === "5") { i += 2; }
    }
    flush();
  }
  out += s.slice(last).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return out + "</span>";
}

const panel = (title: string, ansi: string) => `<div class="win"><div class="bar"><i></i><i></i><i></i><span>${title}</span></div><pre>${ansiToHtml(ansi)}</pre></div>`;
writeFileSync(path.join(docs, "demo.html"), `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:28px;background:radial-gradient(900px 500px at 85% -10%,rgba(47,111,237,.35),transparent),#05080f;font-family:'Geist Mono','DejaVu Sans Mono',monospace;display:flex;gap:24px;align-items:flex-start}
.win{background:#0b1020;border:1px solid #1d2742;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden}
.bar{display:flex;gap:7px;align-items:center;padding:10px 14px;background:#0e1526;border-bottom:1px solid #1d2742;color:#8a94a6;font-size:12px}
.bar i{width:11px;height:11px;border-radius:50%;background:#2a3350;display:inline-block}.bar i:nth-child(1){background:#f08a3c}.bar i:nth-child(2){background:#4c8dff}.bar i:nth-child(3){background:#3dbe78}.bar span{margin-left:8px}
pre{margin:0;padding:14px 18px;color:#e8edf7;font-size:13px;line-height:1.38;font-family:inherit;white-space:pre}
</style>${panel("artemis — approval prompt (confirm mode)", confirm)}${panel("artemis — run finished (approved with [a])", final)}`);
console.log("wrote docs/ui-confirm.ansi, docs/ui-final.ansi, docs/demo.html");
