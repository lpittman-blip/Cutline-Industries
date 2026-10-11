// Shared by the browser and Node's built-in tests. Handles split UTF-8 and SSE lines.
(function (root) {
  async function readEvents(stream, onEvent) {
    const reader = stream.getReader(), decoder = new TextDecoder();
    let buffer = "", data = [];
    const line = value => {
      if (value.endsWith("\r")) value = value.slice(0, -1);
      if (value === "") {
        if (data.length) { const event = JSON.parse(data.join("\n")); data = []; onEvent(event); }
      } else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    };
    try {
      for (;;) {
        const part = await reader.read();
        buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        }
        if (part.done) { if (buffer) line(buffer); line(""); break; }
      }
    } finally { reader.releaseLock(); }
  }
  if (typeof module !== "undefined") module.exports = { readEvents };
  else root.ArtemisStream = { readEvents };
})(globalThis);
