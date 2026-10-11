(() => {
const node = (tag, cls, text) => {const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
const button = (text,fn,cls) => {const el=node("button",cls,text);el.type="button";el.addEventListener("click",fn);return el;};
  function safeURL(value) {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
  }
  function anchor(url, label) {
    const href = safeURL(url); if (!href) return node("span", "", label);
    const a = node("a", "", label); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer nofollow"; return a;
  }
  function inline(el, text) {
    const pattern = /(`[^`\n]+`)|\[([^\]]+)\]\((https?:\/\/[^\s]+)\)|(https?:\/\/[^\s<>]+)/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      el.append(document.createTextNode(text.slice(last, match.index)));
      if (match[1]) el.append(node("code", "", match[1].slice(1, -1)));
      else el.append(anchor(match[3] || match[4], match[2] || match[4]));
      last = match.index + match[0].length;
    }
    el.append(document.createTextNode(text.slice(last)));
  }
  function codeBlock(code, lang) {
    const wrap = node("div", "codeblock"), bar = node("div", "code-bar"), pre = node("pre"), content = node("code", "", code);
    const copy = button("Copy", async () => {
      try { await navigator.clipboard.writeText(code); copy.textContent = "Copied"; } catch { copy.textContent = "Select and copy"; }
      setTimeout(() => copy.textContent = "Copy", 1600);
    });
    bar.append(node("span", "", lang || "code"), copy); pre.append(content); wrap.append(bar, pre); return wrap;
  }
  function renderText(el, text) {
    el.replaceChildren();
    text.split("```").forEach((part, i) => {
      if (i % 2) { const newline = part.indexOf("\n"); el.append(codeBlock(newline < 0 ? part : part.slice(newline + 1).replace(/\n$/, ""), newline < 0 ? "code" : part.slice(0, newline))); return; }
      let listElement = null;
      for (const line of part.split("\n")) {
        if (!line.trim()) { listElement = null; continue; }
        const heading = /^(#{1,3})\s+(.+)$/.exec(line), bullet = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
        if (bullet) {
          const tag = /^\s*\d/.test(line) ? "ol" : "ul";
          if (!listElement || listElement.tagName.toLowerCase() !== tag) { listElement = node(tag); el.append(listElement); }
          const item = node("li"); inline(item, bullet[1]); listElement.append(item);
        } else { listElement = null; const paragraph = node(heading ? (heading[1].length < 3 ? "h2" : "h3") : "p"); inline(paragraph, heading ? heading[2] : line); el.append(paragraph); }
      }
    });
  }
  function renderTools(container, events) {
    container.replaceChildren();
    for (const event of events) {
      const row = node("li", event.pending ? "pending" : event.ok ? "ok" : "failed", event.summary || event.name || "Tool activity");
      if (Array.isArray(event.sources)) {
        const sources = node("ul", "sources");
        for (const source of event.sources.slice(0, 5)) if (source && safeURL(source.url)) {
          const item = node("li"); item.append(anchor(source.url, source.title || source.url)); sources.append(item);
        }
        row.append(sources);
      }
      if (typeof event.code === "string") {
        const details = node("details"); details.append(node("summary", "", "Code and output"), codeBlock(event.code, "python"));
        if (event.output) details.append(codeBlock(String(event.output), "output")); row.append(details);
      }
      container.append(row);
    }
    container.hidden = !events.length;
  }

window.ArtemisUI={node,button,renderText,renderTools,codeBlock};
})();
