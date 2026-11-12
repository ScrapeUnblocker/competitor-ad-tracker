/**
 * Destinations. Each chat destination is a tiny object with one method:
 *
 *   { name, style, send(digest, payload) }
 *
 * `name` keys what was already delivered in the state, `style` picks the digest
 * markup (see format.js), and `send` throws on failure so the events stay pending
 * and are retried on the next run. Notion is different (it mirrors every ad as a
 * database page) and lives in notion.js.
 */
import { splitMessage } from "./format.js";
import { NotionSink } from "./notion.js";

export class DeliveryError extends Error {}

const DISCORD_LIMIT = 2000;
const SLACK_LIMIT = 3500;

async function postJson(fetchImpl, url, body, { attempts = 3, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      last = new DeliveryError(`network error: ${err.message}`);
      if (attempt < attempts) await wait(2000 * attempt);
      continue;
    }
    if (res.ok) return res;
    const text = (await res.text().catch(() => "")).slice(0, 200);
    last = new DeliveryError(`HTTP ${res.status} ${text}`.trim());
    if (res.status !== 429 && res.status < 500) break;
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    if (attempt < attempts) await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt);
  }
  throw last;
}

export class SlackSink {
  constructor(url, { fetchImpl = fetch, sleep } = {}) {
    this.name = "slack";
    this.style = "slack";
    this.url = url;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async send(digest) {
    for (const text of splitMessage(digest, SLACK_LIMIT)) {
      await postJson(this.fetch, this.url, { text, unfurl_links: false, unfurl_media: false }, { sleep: this.sleep });
    }
  }
}

export class DiscordSink {
  constructor(url, { fetchImpl = fetch, sleep } = {}) {
    this.name = "discord";
    this.style = "discord";
    this.url = url;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async send(digest) {
    for (const content of splitMessage(digest, DISCORD_LIMIT)) {
      // flags 4 = SUPPRESS_EMBEDS; allowed_mentions keeps ad copy from pinging anyone.
      await postJson(this.fetch, this.url, { content, flags: 4, allowed_mentions: { parse: [] } }, { sleep: this.sleep });
    }
  }
}

/** Any URL that accepts a JSON POST: Zapier, Make, n8n, your own endpoint. */
export class WebhookSink {
  constructor(url, { fetchImpl = fetch, sleep } = {}) {
    this.name = "webhook";
    this.style = "plain";
    this.url = url;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async send(_digest, payload) {
    await postJson(this.fetch, this.url, payload, { sleep: this.sleep });
  }
}

/** Build the destinations whose secrets are set. Nothing set = print only. */
export function destinationsFromEnv(env = process.env, options = {}) {
  const chat = [];
  if (env.SLACK_WEBHOOK_URL) chat.push(new SlackSink(env.SLACK_WEBHOOK_URL.trim(), options));
  if (env.DISCORD_WEBHOOK_URL) chat.push(new DiscordSink(env.DISCORD_WEBHOOK_URL.trim(), options));
  if (env.WEBHOOK_URL) chat.push(new WebhookSink(env.WEBHOOK_URL.trim(), options));

  let notion = null;
  if (env.NOTION_TOKEN && env.NOTION_DATABASE_ID) {
    notion = new NotionSink({
      token: env.NOTION_TOKEN.trim(),
      database: env.NOTION_DATABASE_ID.trim(),
      baseUrl: env.NOTION_API_URL || undefined,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    });
  } else if (env.NOTION_TOKEN || env.NOTION_DATABASE_ID) {
    throw new DeliveryError("Notion needs both NOTION_TOKEN and NOTION_DATABASE_ID");
  }
  return { chat, notion };
}
