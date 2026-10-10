/**
 * Slack notification for a pre-flight run.
 *
 * Quiet on success. A bot that posts "all clear" on every push trains the channel
 * to filter it, and then the one message that mattered is filtered too.
 *
 * The webhook URL is a credential: anyone holding it can post as this app. It is
 * read from the environment, never logged, and never echoed back in an error.
 */

export interface SlackNotice {
  repo: string;
  findings: number;
  topRule?: string;
  file?: string;
  url?: string;
  actor?: string;
  sha?: string;
  durationMs: number;
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: { type: string; text: string }[];
  accessory?: { type: string; text: { type: string; text: string; emoji: boolean }; url: string; action_id: string };
}

export function buildBlocks(notice: SlackNotice): { text: string; blocks: SlackBlock[] } {
  const short = (notice.sha ?? "").slice(0, 7);
  const lines = [
    `*Repository:* \`${notice.repo}\``,
    notice.file ? `*File:* \`${notice.file}\`` : "",
    notice.topRule ? `*Finding:* \`${notice.topRule}\`` : "",
    notice.actor ? `*Pushed by:* ${notice.actor}` : "",
  ].filter(Boolean);

  const section: SlackBlock = { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } };
  if (notice.url) {
    section.accessory = {
      type: "button",
      text: { type: "plain_text", text: "Open", emoji: true },
      url: notice.url,
      action_id: "artemis-open",
    };
  }
  const headline = `Artemis pre-flight found ${notice.findings} issue${notice.findings === 1 ? "" : "s"} in ${notice.repo}`;
  return {
    text: headline,   // the fallback a phone notification shows
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `:mag: *${headline}*` } },
      section,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Checked in ${(notice.durationMs / 1000).toFixed(1)}s${short ? ` · \`${short}\`` : ""} · reported only, nothing was pushed` }],
      },
    ],
  };
}

export async function notifySlack(
  notice: SlackNotice,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean; detail: string }> {
  const webhook = env.ARTEMIS_SLACK_WEBHOOK_URL;
  if (!webhook) return { sent: false, detail: "no ARTEMIS_SLACK_WEBHOOK_URL set" };
  if (notice.findings === 0) return { sent: false, detail: "clean run; staying quiet" };

  try {
    const response = await fetchImpl(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBlocks(notice)),
      signal: AbortSignal.timeout(10_000),
    });
    // Never include the response URL or the webhook in the message: both leak it.
    return response.ok
      ? { sent: true, detail: "notified" }
      : { sent: false, detail: `Slack returned HTTP ${response.status}` };
  } catch (error) {
    return { sent: false, detail: `Slack unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
