/**
 * One tracker run: collect every competitor, merge into the state, deliver what is new,
 * save the state. Everything external (API client, destinations, clock) is passed in,
 * so tests run the real flow with fakes.
 */
import { appendFileSync } from "node:fs";

import { collectCompetitor } from "./collect.js";
import { ConfigError, slugify } from "./config.js";
import { todayUTC } from "./dates.js";
import { buildDigest, eventsPayload } from "./format.js";
import { markNotionSynced, markSent, mergeCompetitor, notionOps, pendingEvents } from "./process.js";
import { loadState, saveState } from "./state.js";

/**
 * @returns {Promise<{calls:number, collected:number, failures:string[], deliveryErrors:string[], sent:object, notion:object|null}>}
 */
export async function run({
  config,
  statePath,
  client,
  destinations,
  dryRun = false,
  only = null,
  now = new Date(),
  env = process.env,
  log = console.log,
}) {
  const today = todayUTC(now);
  const competitors = only ? config.competitors.filter((c) => c.key === slugify(only)) : config.competitors;
  if (only && !competitors.length) throw new ConfigError(`no competitor named "${only}" in the config`);
  const scoped = { ...config, competitors };
  const state = loadState(statePath);

  const report = { calls: 0, collected: 0, failures: [], deliveryErrors: [], sent: {}, notion: null };

  log(`Checking ${competitors.length} competitor(s), ads shown in ${config.country}, ${today}${dryRun ? " (dry run)" : ""}`);
  for (const competitor of competitors) {
    const results = await collectCompetitor(client, competitor, config, today, log);
    for (const r of results) {
      report.calls += r.calls;
      if (r.ok) report.collected += 1;
      else report.failures.push(`${competitor.name} (${r.platform}): ${r.error}`);
    }
    mergeCompetitor(state, competitor, results, today, config);
  }
  state.updated = today;

  const { chat, notion } = destinations;
  const digestOptions = {
    date: today,
    country: config.country,
    maxItems: config.delivery.max_items_per_competitor,
    moreHint: notion ? " in Notion" : "",
  };

  // With no chat destination the console is the destination: print each event once.
  const targets = chat.length ? chat : [{ name: "console", style: "plain", console: true }];
  let summaryEvents = null;
  for (const sink of targets) {
    const events = pendingEvents(state, sink.name, today, scoped);
    summaryEvents ??= events;
    const digest = buildDigest(events, { ...digestOptions, style: sink.style });
    if (!digest) {
      log(`${sink.console ? "Nothing new to report." : `${sink.name}: nothing new`}`);
      continue;
    }
    if (sink.console || dryRun) {
      const what = sink.console ? "No chat destination is set; the digest" : `[dry run] ${sink.name} would get`;
      const body =
        sink.name === "webhook"
          ? JSON.stringify(eventsPayload(events, { ...digestOptions, text: buildDigest(events, { ...digestOptions, style: "plain" }) }), null, 2)
          : digest;
      log(`\n${what}:\n\n${body}\n`);
      if (sink.console && !dryRun) markSent(state, sink.name, events);
      continue;
    }
    try {
      const plain = buildDigest(events, { ...digestOptions, style: "plain" });
      await sink.send(digest, eventsPayload(events, { ...digestOptions, text: plain }));
      markSent(state, sink.name, events);
      report.sent[sink.name] = events.length;
      log(`${sink.name}: sent ${events.length} update(s)`);
    } catch (err) {
      report.deliveryErrors.push(`${sink.name}: ${err.message}`);
      log(`${sink.name}: FAILED ${err.message} (kept for the next run)`);
    }
  }

  if (notion) {
    const { ops, deferred } = notionOps(state, scoped);
    const creates = ops.filter((op) => op.action === "create").length;
    const updates = ops.length - creates;
    report.notion = { created: 0, updated: 0, deferred };
    const later = deferred ? `; ${deferred} more next run (delivery.notion_max_writes)` : "";
    if (dryRun) {
      log(`[dry run] Notion would get ${creates} new page(s) and ${updates} update(s)${later}`);
    } else if (ops.length) {
      try {
        await notion.ensureSchema();
        if (notion.addedColumns?.length) log(`notion: added columns ${notion.addedColumns.join(", ")}`);
        for (const op of ops) {
          if (op.action === "create") {
            markNotionSynced(op.rec, await notion.create(op.rec, op.competitor));
            report.notion.created += 1;
          } else {
            await notion.update(op.pageId, op.rec);
            markNotionSynced(op.rec, op.pageId);
            report.notion.updated += 1;
          }
        }
        log(`notion: ${report.notion.created} new page(s), ${report.notion.updated} update(s)${later}`);
      } catch (err) {
        report.deliveryErrors.push(`notion: ${err.message}`);
        log(`notion: FAILED after ${report.notion.created + report.notion.updated} write(s): ${err.message}`);
      }
    } else {
      log("notion: up to date");
    }
  }

  if (env.GITHUB_STEP_SUMMARY && summaryEvents?.length) {
    const markdown = buildDigest(summaryEvents, { ...digestOptions, style: "markdown" });
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${dryRun ? "_Dry run: nothing was sent._\n\n" : ""}${markdown}\n`);
    } catch (err) {
      log(`could not write the run summary: ${err.message}`);
    }
  }

  if (!dryRun) saveState(state, statePath);
  log(`API requests this run: ${report.calls}${dryRun ? " (state not saved)" : ""}`);
  return report;
}
