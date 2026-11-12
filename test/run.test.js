import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { run } from "../src/run.js";
import { config, fakeClient, fakeNotion, fakeSink, googleRow, metaRow, NOW, quiet, tempStatePath } from "./helpers.js";

const cfg = config();

test("first run delivers the baseline everywhere; a second run delivers nothing", async () => {
  const statePath = tempStatePath();
  const client = fakeClient({ meta: [metaRow(1), metaRow(2, { started_running: "2026-11-11" })], google: [googleRow(1)] });
  const slack = fakeSink("slack", "slack");
  const discord = fakeSink("discord", "discord");
  const notion = fakeNotion();
  const destinations = { chat: [slack, discord], notion };

  const first = await run({ config: cfg, statePath, client, destinations, now: NOW, env: {}, log: quiet });
  assert.equal(first.calls, 2);
  assert.equal(slack.sent.length, 1);
  assert.match(slack.sent[0].digest, /^\*Competitor ads\* · 12 Nov 2026 · US/);
  assert.match(slack.sent[0].digest, /\*Acme\* · now tracking 3 active ads \(Meta 2, Google 1\)/);
  assert.match(slack.sent[0].digest, /\|Meta image> · started 11 Nov · "Ad copy 2" → acme\.com\/pricing\n/);
  assert.match(discord.sent[0].digest, /^\*\*Competitor ads\*\*/);
  assert.equal(notion.created.length, 3);
  assert.deepEqual(first.notion, { created: 3, updated: 0, deferred: 0 });
  assert.ok(existsSync(statePath));

  const second = await run({ config: cfg, statePath, client, destinations, now: NOW, env: {}, log: quiet });
  assert.equal(second.calls, 2);
  assert.equal(slack.sent.length, 1, "nothing new for Slack");
  assert.equal(discord.sent.length, 1, "nothing new for Discord");
  assert.equal(notion.created.length, 3);
  assert.equal(notion.updated.length, 0);
});

test("the next day a new ad and a stopped ad arrive once, and Notion is updated", async () => {
  const statePath = tempStatePath();
  const slack = fakeSink("slack", "slack");
  const notion = fakeNotion();
  const destinations = { chat: [slack], notion };
  const day1 = new Date("2026-11-11T07:00:00Z");
  await run({
    config: cfg,
    statePath,
    client: fakeClient({ meta: [metaRow(1, { ended: "2026-11-11" }), metaRow(2, { ended: "2026-11-11" })] }),
    destinations,
    now: day1,
    env: {},
    log: quiet,
  });

  const client = fakeClient({ meta: [metaRow(1), metaRow(3, { started_running: "2026-11-12", ad_text: "Black Friday: 50% off" })] });
  await run({ config: cfg, statePath, client, destinations, now: NOW, env: {}, log: quiet });
  assert.equal(slack.sent.length, 2);
  const digest = slack.sent[1].digest;
  assert.match(digest, /\*Acme\* · 1 new · 1 stopped/);
  assert.match(digest, /• New · <https:\/\/www\.facebook\.com\/ads\/library\/\?id=3\|Meta image> · started 12 Nov · "Black Friday: 50% off"/);
  assert.match(digest, /• Stopped · /);
  assert.equal(notion.created.length, 3);
  assert.equal(notion.updated.length, 1);
  assert.equal(notion.updated[0].rec.status, "stopped");

  await run({ config: cfg, statePath, client, destinations, now: NOW, env: {}, log: quiet });
  assert.equal(slack.sent.length, 2, "already delivered");
});

test("--dry-run sends nothing and saves nothing", async () => {
  const statePath = tempStatePath();
  const slack = fakeSink("slack", "slack");
  const notion = fakeNotion();
  const lines = [];
  await run({
    config: cfg,
    statePath,
    client: fakeClient({ meta: [metaRow(1)] }),
    destinations: { chat: [slack], notion },
    dryRun: true,
    now: NOW,
    env: {},
    log: (l) => lines.push(l),
  });
  assert.equal(slack.sent.length, 0);
  assert.equal(notion.created.length, 0);
  assert.equal(existsSync(statePath), false);
  const out = lines.join("\n");
  assert.match(out, /\[dry run\] slack would get:/);
  assert.match(out, /\*Acme\* · now tracking 1 active ad/);
  assert.match(out, /\[dry run\] Notion would get 1 new page\(s\) and 0 update\(s\)/);
});

test("a failed destination keeps its events for the next run; the others are not re-sent", async () => {
  const statePath = tempStatePath();
  const slack = fakeSink("slack", "slack", { failTimes: 1 });
  const discord = fakeSink("discord", "discord");
  const destinations = { chat: [slack, discord], notion: null };
  const client = fakeClient({ meta: [metaRow(1)] });

  const first = await run({ config: cfg, statePath, client, destinations, now: NOW, env: {}, log: quiet });
  assert.deepEqual(first.deliveryErrors, ["slack: HTTP 500 boom"]);
  assert.equal(discord.sent.length, 1);

  const second = await run({ config: cfg, statePath, client, destinations, now: NOW, env: {}, log: quiet });
  assert.deepEqual(second.deliveryErrors, []);
  assert.equal(slack.sent.length, 1, "Slack got the baseline on the retry");
  assert.equal(discord.sent.length, 1, "Discord was not sent it twice");
});

test("with no destination the digest is printed once", async () => {
  const statePath = tempStatePath();
  const lines = [];
  const opts = { config: cfg, statePath, client: fakeClient({ meta: [metaRow(1)] }), destinations: { chat: [], notion: null }, now: NOW, env: {} };
  await run({ ...opts, log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /No chat destination is set; the digest:/);
  lines.length = 0;
  await run({ ...opts, log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /Nothing new to report\./);
});

test("the Actions run summary gets the digest as markdown", async () => {
  const statePath = tempStatePath();
  const summary = join(dirname(dirname(statePath)), "summary.md");
  await run({
    config: cfg,
    statePath,
    client: fakeClient({ meta: [metaRow(1)] }),
    destinations: { chat: [fakeSink("slack", "slack")], notion: null },
    now: NOW,
    env: { GITHUB_STEP_SUMMARY: summary },
    log: quiet,
  });
  assert.match(readFileSync(summary, "utf8"), /^\*\*Competitor ads\*\* · 12 Nov 2026 · US/);
});

test("--only runs one competitor and rejects unknown names", async () => {
  const two = config({
    competitors: [
      { name: "Acme", meta_page_id: "1234567890" },
      { name: "Globex", google_domain: "globex.com" },
    ],
  });
  const client = fakeClient({ google: [googleRow(1)] });
  await run({ config: two, statePath: tempStatePath(), client, destinations: { chat: [], notion: null }, only: "globex", now: NOW, env: {}, log: quiet });
  assert.deepEqual(
    client.calls.map((c) => c.method),
    ["googleAdsTransparency"],
  );
  await assert.rejects(
    run({ config: two, statePath: tempStatePath(), client, destinations: { chat: [], notion: null }, only: "Initech", now: NOW, env: {}, log: quiet }),
    /no competitor named "Initech"/,
  );
});
