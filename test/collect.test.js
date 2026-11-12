import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthenticationError, ServerError } from "scrapeunblocker";

import { collectCompetitor, landingPage, normalizeGoogleAds, normalizeMetaAds } from "../src/collect.js";
import { config, fakeClient, googleRow, metaRow, TODAY } from "./helpers.js";

test("landingPage keeps host and path, drops tracking and Meta redirects", () => {
  assert.equal(landingPage("https://www.acme.com/pricing/?utm_source=fb&fbclid=x"), "acme.com/pricing");
  assert.equal(landingPage("https://acme.com/"), "acme.com");
  assert.equal(landingPage("http://fb.me/"), null);
  assert.equal(landingPage("https://api.whatsapp.com/send?phone=1"), null);
  assert.equal(landingPage("https://l.facebook.com/l.php?u=https%3A%2F%2Facme.com%2Fdemo%3Fa%3D1"), "acme.com/demo");
  assert.equal(
    landingPage("https://play.google.com/store/apps/details?id=com.acme.app&utm_campaign=x"),
    "play.google.com/store/apps/details?id=com.acme.app",
  );
  assert.equal(landingPage("not a url"), null);
  assert.equal(landingPage(null), null);
});

test("Meta variants of one collation group become one ad", () => {
  const rows = [
    metaRow(1, { collation_id: "g1", collation_count: 3, started_running: "2026-11-05" }),
    metaRow(2, { collation_id: "g1", collation_count: 3, started_running: "2026-11-03" }),
    metaRow(3),
  ];
  const ads = normalizeMetaAds(rows, "Acme", TODAY);
  assert.equal(ads.length, 2);
  const group = ads.find((a) => a.key === "meta:g1");
  assert.equal(group.id, "1");
  assert.equal(group.variants, 3);
  assert.equal(group.started, "2026-11-03", "the earliest variant start");
  assert.equal(group.daysRunning, 9);
  assert.equal(group.landing, "acme.com/pricing");
  assert.deepEqual(group.placements, ["facebook", "instagram"]);
  assert.equal(ads.find((a) => a.key === "meta:3").variants, 1);
});

test("catalog template copy is treated as no copy; formats are friendly", () => {
  const [ad] = normalizeMetaAds(
    [metaRow(9, { ad_text: "{{product.brand}}", title: "{{product.name}}", display_format: "DCO" })],
    "Acme",
    TODAY,
  );
  assert.equal(ad.text, null);
  assert.equal(ad.title, null);
  assert.equal(ad.format, "dynamic");
});

test("Google ads count as stopped once not shown for stopped_after_days", () => {
  const ads = normalizeGoogleAds(
    [googleRow(1), googleRow(2, { lastShown: "2026-11-01T00:00:00Z" })],
    "Acme",
    TODAY,
    3,
  );
  assert.deepEqual(
    ads.map((a) => [a.key, a.active, a.daysRunning]),
    [
      ["google:CR1", true, 42],
      ["google:CR2", false, 31],
    ],
  );
});

test("Google rows last shown before the lookback window are dropped", () => {
  const ads = normalizeGoogleAds(
    [googleRow(1), googleRow(2, { lastShown: "2026-08-11T00:00:00Z" }), googleRow(3, { lastShown: null })],
    "Acme",
    TODAY,
    3,
    "2026-10-13",
  );
  assert.deepEqual(
    ads.map((a) => a.key),
    ["google:CR1"],
  );
});

test("collectCompetitor sends the configured options and reports completeness", async () => {
  const client = fakeClient({ meta: [metaRow(1)], google: [googleRow(1)], googleHasMore: true });
  const results = await collectCompetitor(client, config().competitors[0], config(), TODAY);
  assert.deepEqual(client.calls[0], {
    method: "metaAdLibrary",
    advertiser: "1234567890",
    options: { country: "US", activeStatus: "active", mediaType: "all", maxAds: 200 },
  });
  assert.deepEqual(client.calls[1].options, {
    region: "US",
    sort: "last_shown",
    maxResults: 100,
    dateFrom: "2026-10-13",
    domain: "acme.com",
  });
  assert.deepEqual(
    results.map((r) => [r.platform, r.ok, r.ads.length, r.complete, r.calls]),
    [
      ["meta", true, 1, true, 1],
      ["google", true, 1, false, 1],
    ],
  );
});

test("a failed platform is reported, the other still collected", async () => {
  const client = fakeClient({ google: [googleRow(1)], fail: { meta: new ServerError("blocked", 502) } });
  const results = await collectCompetitor(client, config().competitors[0], config(), TODAY);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /HTTP 502/);
  assert.equal(results[1].ok, true);
});

test("a rejected API key stops the run", async () => {
  const client = fakeClient({ fail: { meta: new AuthenticationError("Unauthorized", 401) } });
  await assert.rejects(collectCompetitor(client, config().competitors[0], config(), TODAY), AuthenticationError);
});
