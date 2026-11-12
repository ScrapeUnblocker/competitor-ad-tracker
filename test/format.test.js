import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDigest, eventsPayload, splitMessage } from "../src/format.js";
import { TODAY } from "./helpers.js";

const ad = {
  competitor: "Acme",
  competitorKey: "acme",
  platform: "meta",
  format: "image",
  title: null,
  text: "Ship <faster> & cheaper with *Acme*",
  landing: "acme.com/launch",
  link: "https://www.facebook.com/ads/library/?id=1",
  started: "2026-11-11",
  last_seen: TODAY,
  days_running: 1,
  variants: 3,
};

const events = [
  { type: "new", key: "meta:1", ...ad },
  {
    type: "long_running",
    key: "google:CR9",
    ...ad,
    platform: "google",
    format: "video",
    text: null,
    landing: null,
    variants: 1,
    started: "2026-10-01",
    days_running: 42,
    threshold: 30,
    link: "https://adstransparency.google.com/x",
  },
  { type: "stopped", key: "meta:2", ...ad, started: "2026-10-20", last_seen: "2026-11-11", days_running: 22, variants: 1 },
  { type: "landing", competitor: "Acme", competitorKey: "acme", url: "acme.com/launch", ads: 1 },
];

test("Slack digest: summary line, one line per ad, escaped copy, Slack links", () => {
  const text = buildDigest(events, { style: "slack", date: TODAY, country: "US" });
  assert.equal(
    text,
    [
      "*Competitor ads* · 12 Nov 2026 · US",
      "",
      "*Acme* · 1 new · 1 running 30+ days · 1 stopped · 1 new landing page",
      '• New · <https://www.facebook.com/ads/library/?id=1|Meta image (3 variants)> · started 11 Nov · "Ship &lt;faster&gt; &amp; cheaper with *Acme*" → acme.com/launch',
      "• 30+ days · <https://adstransparency.google.com/x|Google video> · running since 1 Oct (42 days)",
      '• Stopped · <https://www.facebook.com/ads/library/?id=1|Meta image> · ran 20 Oct to 11 Nov (22 days) · "Ship &lt;faster&gt; &amp; cheaper with *Acme*"',
      "• New landing page: acme.com/launch (1 ad)",
    ].join("\n"),
  );
});

test("Discord digest uses markdown links that do not unfurl and escapes markdown", () => {
  const text = buildDigest(events.slice(0, 1), { style: "discord", date: TODAY, country: "US" });
  assert.match(text, /^\*\*Competitor ads\*\*/);
  assert.match(text, /\[Meta image \(3 variants\)\]\(<https:\/\/www\.facebook\.com\/ads\/library\/\?id=1>\)/);
  assert.match(text, /with \\\*Acme\\\*/);
});

test("baseline digest lists the newest ads and top landing pages, capped", () => {
  const baseline = {
    type: "baseline",
    competitor: "Acme",
    competitorKey: "acme",
    active: { meta: 2, google: 1 },
    long_running: 1,
    long_running_days: 30,
    platforms: ["meta", "google"],
    newest: [
      { ...ad, key: "meta:1" },
      { ...ad, key: "meta:2", text: "Second ad", started: "2026-11-02", variants: 1 },
      { ...ad, key: "google:CR1", platform: "google", format: "text", text: null, landing: null, variants: 1 },
    ],
    landings: [{ url: "acme.com/launch", ads: 2 }],
  };
  const text = buildDigest([baseline], { style: "plain", date: TODAY, country: "US", maxItems: 2, moreHint: " in Notion" });
  assert.equal(
    text,
    [
      "Competitor ads · 12 Nov 2026 · US",
      "",
      "Acme · now tracking 3 active ads (Meta 2, Google 1) · 1 running 30+ days",
      '• Meta image (3 variants) (https://www.facebook.com/ads/library/?id=1) · started 11 Nov · "Ship <faster> & cheaper with *Acme*" → acme.com/launch',
      '• Meta image (https://www.facebook.com/ads/library/?id=1) · started 2 Nov · "Second ad" → acme.com/launch',
      "• …and 1 more in Notion",
      "Top landing pages: acme.com/launch (2 ads)",
    ].join("\n"),
  );
});

test("long copy is cut to one readable line", () => {
  const long = { type: "new", key: "meta:1", ...ad, text: `${"word ".repeat(40)}\nsecond line` };
  const line = buildDigest([long], { style: "plain", date: TODAY, country: "US" }).split("\n")[3];
  assert.ok(line.includes("…"));
  assert.ok(!line.includes("second line"));
});

test("an ad missing from capped answers is worded as not seen, not stopped", () => {
  const unseen = { type: "stopped", key: "meta:7", ...ad, variants: 1, last_seen: "2026-10-20", reason: "unseen", unseen_days: 14 };
  const text = buildDigest([unseen], { style: "plain", date: TODAY, country: "US" });
  assert.match(text, /Acme · 1 not seen for 14\+ days\n/);
  assert.match(text, /• Not seen for 14\+ days · Meta image \(https:[^)]+\) · last seen 20 Oct · "Ship/);
  assert.doesNotMatch(text, /Stopped/);
});

test("no events means no message", () => {
  assert.equal(buildDigest([], { style: "slack", date: TODAY, country: "US" }), null);
});

test("webhook payload carries the events without internal keys", () => {
  const payload = eventsPayload(events, { date: TODAY, country: "US", text: "x" });
  assert.equal(payload.source, "competitor-ad-tracker");
  assert.equal(payload.events.length, 4);
  assert.ok(payload.events.every((e) => !("competitorKey" in e)));
  assert.equal(payload.events[0].landing, "acme.com/launch");

  const baseline = { type: "baseline", competitor: "Acme", competitorKey: "acme", newest: [{ ...ad, key: "meta:1" }] };
  const [first] = eventsPayload([baseline], { date: TODAY, country: "US", text: "x" }).events;
  assert.ok(!("competitorKey" in first) && !("competitorKey" in first.newest[0]));
});

test("splitMessage keeps every chunk under the limit and breaks on lines", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  const chunks = splitMessage(text, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 500));
  assert.equal(chunks.join("\n"), text);
});
