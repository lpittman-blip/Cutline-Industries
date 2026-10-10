/** bun examples/sdk-quickstart.ts — start a run, stream it, auto-approve nothing. */
import { Artemis } from "../sdk/index.ts";

const artemis = new Artemis({ baseUrl: process.env.ARTEMIS_URL ?? "http://127.0.0.1:7777", apiKey: process.env.ARTEMIS_API_KEY! });
const run = await artemis.runs.create({ task: "Find where API keys are hashed and explain it", mode: "read_only", model: process.env.ARTEMIS_MODEL });
const final = await artemis.runs.wait(run.id, {
  onEvent: (e) => e.type === "tool_start" && console.log(`→ ${e.name}`, JSON.stringify(e.args)),
  onApproval: () => false,
});
console.log(final.status, final.summary);
