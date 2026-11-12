import assert from "node:assert/strict";
import { test } from "node:test";

import { NotionError, NotionSink, pageProperties, parseDatabaseId, SCHEMA } from "../src/notion.js";
import { DeliveryError, destinationsFromEnv, DiscordSink, SlackSink, WebhookSink } from "../src/sinks.js";

const noSleep = async () => {};

/** A fetch stand-in: answers from `responses` in order and records each request. */
function fakeFetch(responses = []) {
  const requests = [];
  const queue = [...responses];
  const fn = async (url, init = {}) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const next = queue.shift() ?? { status: 200, body: { ok: true } };
    if (next.throw) throw next.throw;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (h) => (next.headers ?? {})[h.toLowerCase()] ?? null },
      json: async () => next.body ?? {},
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  fn.requests = requests;
  return fn;
}

test("Slack gets mrkdwn text with link unfurling off", async () => {
  const fetchImpl = fakeFetch();
  await new SlackSink("https://hooks.slack.test/x", { fetchImpl, sleep: noSleep }).send("*hi*");
  assert.deepEqual(fetchImpl.requests[0].body, { text: "*hi*", unfurl_links: false, unfurl_media: false });
});

test("Discord messages are split under 2,000 characters, embeds and mentions off", async () => {
  const fetchImpl = fakeFetch();
  const digest = Array.from({ length: 60 }, (_, i) => `• line ${i} ${"x".repeat(50)}`).join("\n");
  await new DiscordSink("https://discord.test/api/webhooks/1/x", { fetchImpl, sleep: noSleep }).send(digest);
  assert.ok(fetchImpl.requests.length >= 2);
  for (const r of fetchImpl.requests) {
    assert.ok(r.body.content.length <= 2000);
    assert.equal(r.body.flags, 4);
    assert.deepEqual(r.body.allowed_mentions, { parse: [] });
  }
});

test("the generic webhook gets the JSON payload, not the text", async () => {
  const fetchImpl = fakeFetch();
  await new WebhookSink("https://example.test/hook", { fetchImpl, sleep: noSleep }).send("text", { events: [1] });
  assert.deepEqual(fetchImpl.requests[0].body, { events: [1] });
});

test("a 5xx is retried, a 4xx is not", async () => {
  const retried = fakeFetch([{ status: 502 }, { status: 200 }]);
  await new SlackSink("https://hooks.slack.test/x", { fetchImpl: retried, sleep: noSleep }).send("x");
  assert.equal(retried.requests.length, 2);

  const rejected = fakeFetch([{ status: 404, body: { error: "no_service" } }]);
  await assert.rejects(
    new SlackSink("https://hooks.slack.test/x", { fetchImpl: rejected, sleep: noSleep }).send("x"),
    (err) => err instanceof DeliveryError && /HTTP 404/.test(err.message),
  );
  assert.equal(rejected.requests.length, 1);
});

test("destinationsFromEnv builds only what has secrets", () => {
  assert.deepEqual(destinationsFromEnv({}), { chat: [], notion: null });
  const d = destinationsFromEnv({
    SLACK_WEBHOOK_URL: "https://hooks.slack.test/x",
    WEBHOOK_URL: "https://example.test/hook",
    NOTION_TOKEN: "ntn_test",
    NOTION_DATABASE_ID: "0123456789abcdef0123456789abcdef",
  });
  assert.deepEqual(
    d.chat.map((s) => s.name),
    ["slack", "webhook"],
  );
  assert.equal(d.notion.databaseId, "01234567-89ab-cdef-0123-456789abcdef");
  assert.throws(() => destinationsFromEnv({ NOTION_TOKEN: "ntn_test" }), /NOTION_DATABASE_ID/);
});

test("parseDatabaseId accepts ids and copied Notion URLs", () => {
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(parseDatabaseId("0123456789abcdef0123456789abcdef"), id);
  assert.equal(parseDatabaseId(id), id);
  assert.equal(
    parseDatabaseId("https://www.notion.so/acme/Ads-0123456789abcdef0123456789abcdef?v=ffffffffffffffffffffffffffffffff"),
    id,
  );
  assert.throws(() => parseDatabaseId("my database"), NotionError);
});

function notion(fetchImpl) {
  return new NotionSink({
    token: "ntn_test",
    database: "0123456789abcdef0123456789abcdef",
    baseUrl: "https://notion.test",
    fetchImpl,
    sleep: noSleep,
    minIntervalMs: 0,
  });
}

const rec = {
  platform: "meta",
  id: "111",
  format: "image",
  title: null,
  text: "Ship faster with Acme",
  cta: "Sign up",
  landing: "acme.com/launch",
  link: "https://www.facebook.com/ads/library/?id=111",
  started: "2026-11-11",
  last_seen: "2026-11-12",
  days_running: 1,
  variants: 2,
  placements: ["facebook", "instagram", "audience_network"],
  status: "active",
  long_running_on: null,
};

test("ensureSchema adds only the missing columns and keeps the title column's name", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { properties: { Ad: { type: "title" }, Competitor: { type: "select" } } } },
    { status: 200, body: {} },
  ]);
  const sink = notion(fetchImpl);
  assert.equal(await sink.ensureSchema(), "Ad");
  const patch = fetchImpl.requests[1];
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url, "https://notion.test/v1/databases/01234567-89ab-cdef-0123-456789abcdef");
  assert.ok(!("Competitor" in patch.body.properties));
  assert.equal(Object.keys(patch.body.properties).length, Object.keys(SCHEMA).length - 1);
  assert.equal(fetchImpl.requests[0].headers["Notion-Version"], "2022-06-28");
  assert.equal(fetchImpl.requests[0].headers.Authorization, "Bearer ntn_test");
});

test("ensureSchema refuses a column of the wrong type", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { properties: { Name: { type: "title" }, Status: { type: "status" } } } }]);
  await assert.rejects(notion(fetchImpl).ensureSchema(), /"Status" is a status column/);
});

test("create writes one page with every column", async () => {
  const full = Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, { type: Object.keys(v)[0] }]));
  const fetchImpl = fakeFetch([
    { status: 200, body: { properties: { Name: { type: "title" }, ...full } } },
    { status: 200, body: { id: "page-1" } },
  ]);
  const id = await notion(fetchImpl).create(rec, "Acme");
  assert.equal(id, "page-1");
  const body = fetchImpl.requests[1].body;
  assert.deepEqual(body.parent, { database_id: "01234567-89ab-cdef-0123-456789abcdef" });
  assert.equal(body.properties.Name.title[0].text.content, "Ship faster with Acme");
  assert.deepEqual(body.properties.Platform, { select: { name: "Meta" } });
  assert.deepEqual(body.properties["Landing page"], { url: "https://acme.com/launch" });
  assert.deepEqual(body.properties.Placements, {
    multi_select: [{ name: "Facebook" }, { name: "Instagram" }, { name: "Audience Network" }],
  });
  assert.deepEqual(Object.keys(body.properties).sort(), ["Name", ...Object.keys(SCHEMA)].sort());
});

test("a 429 waits and retries; a deleted page is skipped, not recreated", async () => {
  const fetchImpl = fakeFetch([
    { status: 429, headers: { "retry-after": "1" } },
    { status: 200, body: {} },
    { status: 404, body: { message: "Could not find page" } },
  ]);
  const sink = notion(fetchImpl);
  assert.equal(await sink.update("page-1", { ...rec, status: "stopped" }), true);
  assert.equal(fetchImpl.requests[1].body.properties.Status.select.name, "Stopped");
  assert.equal(await sink.update("page-2", rec), false);
});

test("a missing share gives an actionable error", async () => {
  const fetchImpl = fakeFetch([{ status: 404, body: { message: "Could not find database with ID: x" } }]);
  await assert.rejects(notion(fetchImpl).ensureSchema(), /Connections/);
});

test("the Status column separates confirmed stops from ads not seen lately", () => {
  assert.equal(pageProperties(rec, "Acme", "Name").Status.select.name, "Active");
  const stopped = { ...rec, status: "stopped", stopped_reason: "gone" };
  assert.equal(pageProperties(stopped, "Acme", "Name").Status.select.name, "Stopped");
  const unseen = { ...rec, status: "stopped", stopped_reason: "unseen" };
  assert.equal(pageProperties(unseen, "Acme", "Name").Status.select.name, "Not seen");
});

test("page titles fall back to competitor, platform and format", () => {
  const props = pageProperties({ ...rec, text: null, platform: "google", format: "video" }, "Acme", "Name");
  assert.equal(props.Name.title[0].text.content, "Acme Google video ad");
  assert.deepEqual(props.CTA.rich_text[0].text.content, "Sign up");
});
