import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeGoogleAds, normalizeMetaAds } from "../src/collect.js";
import { addDays } from "../src/dates.js";
import { emptyState, markNotionSynced, markSent, mergeCompetitor, notionOps, pendingEvents } from "../src/process.js";
import { config, googleRow, metaRow, TODAY } from "./helpers.js";

const cfg = config();
const acme = cfg.competitors[0];

function results(metaRows, googleRows = [], { complete = true, today = TODAY } = {}) {
  return [
    { platform: "meta", ok: true, ads: normalizeMetaAds(metaRows, "Acme", today), complete, calls: 1 },
    { platform: "google", ok: true, ads: normalizeGoogleAds(googleRows, "Acme", today, 3), complete, calls: 1 },
  ];
}

function types(events) {
  return events.map((e) => e.type);
}

test("the first run is one baseline summary, not a wall of new ads", () => {
  const state = emptyState();
  mergeCompetitor(
    state,
    acme,
    results([metaRow(1, { started_running: "2026-11-10" }), metaRow(2, { started_running: "2026-09-01" })], [googleRow(1)]),
    TODAY,
    cfg,
  );
  const events = pendingEvents(state, "slack", TODAY, cfg);
  assert.deepEqual(types(events), ["baseline"]);
  const [baseline] = events;
  assert.deepEqual(baseline.active, { meta: 2, google: 1 });
  assert.equal(baseline.long_running, 2, "the 72-day Meta ad and the 42-day Google ad");
  assert.deepEqual(
    baseline.newest.map((a) => a.key),
    ["meta:1", "google:CR1", "meta:2"],
  );
  assert.deepEqual(baseline.landings, [{ url: "acme.com/pricing", ads: 2 }]);
});

test("a second run with nothing changed has nothing to deliver", () => {
  const state = emptyState();
  const rows = [metaRow(1), metaRow(2)];
  mergeCompetitor(state, acme, results(rows, [googleRow(1)]), TODAY, cfg);
  markSent(state, "slack", pendingEvents(state, "slack", TODAY, cfg));
  mergeCompetitor(state, acme, results(rows, [googleRow(1)]), TODAY, cfg);
  assert.deepEqual(pendingEvents(state, "slack", TODAY, cfg), []);
  // A destination that never got the baseline still gets it.
  assert.deepEqual(types(pendingEvents(state, "discord", TODAY, cfg)), ["baseline"]);
});

test("new ads, long-running ads, stopped ads and new landing pages are reported once", () => {
  const day1 = "2026-11-01";
  const state = emptyState();
  mergeCompetitor(
    state,
    acme,
    results([metaRow(1, { started_running: "2026-10-05", ended: day1 }), metaRow(2, { ended: day1 })], [], {
      today: day1,
    }),
    day1,
    cfg,
  );
  markSent(state, "slack", pendingEvents(state, "slack", day1, cfg));

  // Day 12: ad 1 passed 30 days, ad 2 is gone from a complete answer, ad 3 is new
  // and points at a page Acme never used before.
  mergeCompetitor(
    state,
    acme,
    results([
      metaRow(1, { started_running: "2026-10-05" }),
      metaRow(3, { started_running: "2026-11-11", link_url: "https://acme.com/launch" }),
    ]),
    TODAY,
    cfg,
  );
  const events = pendingEvents(state, "slack", TODAY, cfg);
  assert.deepEqual(types(events), ["new", "long_running", "stopped", "landing"]);
  assert.equal(events[0].key, "meta:3");
  assert.equal(events[1].key, "meta:1");
  assert.equal(events[1].days_running, 38);
  assert.equal(events[2].key, "meta:2");
  assert.equal(events[2].stopped_on, TODAY);
  assert.deepEqual(events[3], { type: "landing", competitor: "Acme", competitorKey: "acme", url: "acme.com/launch", ads: 1 });

  markSent(state, "slack", events);
  assert.deepEqual(pendingEvents(state, "slack", TODAY, cfg), []);
  assert.deepEqual(state.competitors.acme.ads["meta:3"].sent.slack, ["new"]);
});

test("a capped answer never marks missing ads as stopped", () => {
  const state = emptyState();
  mergeCompetitor(state, acme, results([metaRow(1), metaRow(2)]), TODAY, cfg);
  mergeCompetitor(state, acme, results([metaRow(1)], [], { complete: false }), TODAY, cfg);
  assert.equal(state.competitors.acme.ads["meta:2"].status, "active");
  mergeCompetitor(state, acme, results([metaRow(1)], [], { complete: true }), TODAY, cfg);
  assert.equal(state.competitors.acme.ads["meta:2"].status, "stopped");
});

test("in capped answers an ad is reported as not seen only after unseen_days", () => {
  const state = emptyState();
  const day1 = "2026-10-20";
  mergeCompetitor(state, acme, results([metaRow(1), metaRow(2)], [], { complete: false, today: day1 }), day1, cfg);
  mergeCompetitor(state, acme, results([metaRow(1)], [], { complete: false, today: "2026-11-02" }), "2026-11-02", cfg);
  assert.equal(state.competitors.acme.ads["meta:2"].status, "active", "13 days unseen is not enough");
  mergeCompetitor(state, acme, results([metaRow(1)], [], { complete: false }), TODAY, cfg);
  const rec = state.competitors.acme.ads["meta:2"];
  assert.equal(rec.status, "stopped");
  assert.equal(rec.stopped_reason, "unseen");
  const [event] = pendingEvents(state, "slack", TODAY, cfg).filter((e) => e.type === "stopped");
  assert.equal(event.reason, "unseen");
  assert.equal(event.last_seen, day1);
  assert.equal(event.unseen_days, 14);
  const { ops } = notionOps(state, cfg);
  assert.ok(ops.every((op) => op.action === "create"));
});

test("a first run where every call failed sends no empty 'now tracking' message", () => {
  const state = emptyState();
  const failed = [
    { platform: "meta", ok: false, ads: [], complete: false },
    { platform: "google", ok: false, ads: [], complete: false },
  ];
  mergeCompetitor(state, acme, failed, TODAY, cfg);
  assert.deepEqual(pendingEvents(state, "slack", TODAY, cfg), []);
  mergeCompetitor(state, acme, results([metaRow(1)]), addDays(TODAY, 1), cfg);
  assert.deepEqual(types(pendingEvents(state, "slack", addDays(TODAY, 1), cfg)), ["baseline"]);
});

test("a failed platform changes nothing", () => {
  const state = emptyState();
  mergeCompetitor(state, acme, results([metaRow(1)]), TODAY, cfg);
  mergeCompetitor(state, acme, [{ platform: "meta", ok: false, ads: [], complete: false }], TODAY, cfg);
  assert.equal(state.competitors.acme.ads["meta:1"].status, "active");
});

test("an older ad seen for the first time is archived without a ping", () => {
  const state = emptyState();
  mergeCompetitor(state, acme, results([metaRow(1)], [], { complete: false }), TODAY, cfg);
  markSent(state, "slack", pendingEvents(state, "slack", TODAY, cfg));
  // Ad 2 started 6 weeks ago but was outside max_ads on the first run.
  mergeCompetitor(
    state,
    acme,
    results([metaRow(1), metaRow(2, { started_running: "2026-09-30", link_url: "https://acme.com/old" })], [], {
      complete: false,
    }),
    TODAY,
    cfg,
  );
  assert.deepEqual(pendingEvents(state, "slack", TODAY, cfg), []);
  assert.ok(state.competitors.acme.ads["meta:2"], "still recorded for Notion");
  assert.equal(state.competitors.acme.landings["acme.com/old"].baseline, true);
});

test("events older than retry_days are not sent to a destination added later", () => {
  const state = emptyState();
  mergeCompetitor(state, acme, results([metaRow(1)]), TODAY, cfg);
  assert.deepEqual(pendingEvents(state, "slack", addDays(TODAY, 4), cfg), []);
  assert.equal(pendingEvents(state, "slack", addDays(TODAY, 3), cfg).length, 1);
});

test("a restarted ad can be reported as stopped again", () => {
  const state = emptyState();
  mergeCompetitor(state, acme, results([metaRow(1)]), TODAY, cfg);
  mergeCompetitor(state, acme, results([]), TODAY, cfg);
  markSent(state, "slack", pendingEvents(state, "slack", TODAY, cfg));
  assert.deepEqual(state.competitors.acme.ads["meta:1"].sent.slack, ["stopped"]);
  mergeCompetitor(state, acme, results([metaRow(1)]), TODAY, cfg);
  assert.equal(state.competitors.acme.ads["meta:1"].status, "active");
  assert.deepEqual(state.competitors.acme.ads["meta:1"].sent.slack, []);
});

test("notionOps creates every unsynced ad, then only updates what changed", () => {
  const state = emptyState();
  mergeCompetitor(state, acme, results([metaRow(1), metaRow(2)], [googleRow(1)]), TODAY, cfg);
  const first = notionOps(state, cfg);
  let ops = first.ops;
  assert.equal(first.deferred, 0);
  assert.deepEqual(
    ops.map((op) => op.action),
    ["create", "create", "create"],
  );
  for (const op of ops) markNotionSynced(op.rec, `page-${op.key}`);
  assert.deepEqual(notionOps(state, cfg).ops, []);

  mergeCompetitor(state, acme, results([metaRow(1)], [googleRow(1)]), TODAY, cfg);
  ({ ops } = notionOps(state, cfg));
  assert.deepEqual(
    ops.map((op) => [op.action, op.key, op.pageId]),
    [["update", "meta:2", "page-meta:2"]],
  );
});

test("notionOps respects notion_max_writes and defers the rest", () => {
  const small = config({ delivery: { notion_max_writes: 2 } });
  const state = emptyState();
  mergeCompetitor(state, small.competitors[0], results([metaRow(1), metaRow(2), metaRow(3)]), TODAY, small);
  const { ops, deferred } = notionOps(state, small);
  assert.equal(ops.length, 2);
  assert.equal(deferred, 1);
});
