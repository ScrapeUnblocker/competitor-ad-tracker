/**
 * Turns collected ads into what is worth telling someone about:
 *
 * - new: an ad that appeared since the last run and started recently
 * - long_running: an ad that has now run for `signals.long_running_days`
 * - stopped: an ad that is no longer running
 * - landing: a page the competitor starts sending ad traffic to
 * - baseline: the first run for a competitor ("now tracking N ads"), so day one
 *   is a summary rather than a wall of "new" ads
 *
 * Every event is remembered per destination in the state, so a failed Slack post is
 * retried next run while Discord, which got it, is not sent it twice.
 */
import { daysBetween } from "./dates.js";

const TEXT_LIMIT = 1900; // Notion caps one rich-text value at 2,000 characters
const PRUNE_AFTER_DAYS = 365;

export function emptyState() {
  return { version: 1, updated: null, competitors: {} };
}

function within(date, today, days) {
  return Boolean(date) && daysBetween(date, today) <= days && daysBetween(date, today) >= 0;
}

function clip(text, limit = TEXT_LIMIT) {
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function competitorEntry(state, competitor) {
  let entry = state.competitors[competitor.key];
  if (!entry) {
    entry = {
      name: competitor.name,
      tracking_since: null, // set by the first successful collection
      baseline_sent: [],
      platforms: {},
      landings: {},
      ads: {},
    };
    state.competitors[competitor.key] = entry;
  }
  entry.name = competitor.name;
  return entry;
}

function newRecord(ad, today, baseline) {
  return {
    platform: ad.platform,
    id: ad.id,
    format: ad.format,
    title: clip(ad.title, 300),
    text: clip(ad.text),
    cta: ad.cta,
    landing: ad.landing,
    link: ad.link,
    started: ad.started,
    last_seen: ad.lastShown,
    days_running: ad.daysRunning,
    variants: ad.variants,
    placements: ad.placements,
    status: ad.active ? "active" : "stopped",
    first_seen: today,
    baseline,
    long_running_on: null,
    long_running_at_first_sight: false,
    stopped_on: null,
    stopped_reason: ad.active ? null : "ended",
    sent: {},
    notion: null,
  };
}

/** reason: "ended" (the API says so), "gone" (missing from a complete answer), "unseen". */
function stop(rec, today, reason) {
  rec.status = "stopped";
  rec.stopped_on = today;
  rec.stopped_reason = reason;
}

/**
 * Merge one competitor's collection results into `state`. Returns counts for the log.
 * A platform whose call failed is left untouched: nothing is marked stopped because of
 * an error.
 */
export function mergeCompetitor(state, competitor, results, today, config) {
  const entry = competitorEntry(state, competitor);
  const longDays = config.signals.long_running_days;
  const counts = { seen: 0, added: 0, stopped: 0 };

  for (const result of results) {
    if (!result.ok) continue;
    entry.tracking_since ??= today;
    const platform = result.platform;
    const platformState = entry.platforms[platform] ?? {};
    const baseline = !platformState.since;
    const seen = new Set();

    for (const ad of result.ads) {
      seen.add(ad.key);
      counts.seen += 1;
      let rec = entry.ads[ad.key];
      if (!rec) {
        rec = newRecord(ad, today, baseline);
        entry.ads[ad.key] = rec;
        counts.added += 1;
      } else {
        // Refresh what can change; keep the first copy of the creative itself.
        rec.last_seen = ad.lastShown ?? rec.last_seen;
        rec.days_running = ad.daysRunning ?? rec.days_running;
        rec.variants = Math.max(rec.variants ?? 1, ad.variants ?? 1);
        rec.placements = ad.placements?.length ? ad.placements : rec.placements;
        rec.started = rec.started ?? ad.started;
        rec.landing = rec.landing ?? ad.landing;
        rec.text = rec.text ?? clip(ad.text);
        rec.title = rec.title ?? clip(ad.title, 300);
      }

      if (ad.active) {
        if (rec.status !== "active") {
          rec.status = "active";
          rec.stopped_on = null;
          rec.stopped_reason = null;
          // A restarted ad can be reported as stopped again later.
          for (const sink of Object.keys(rec.sent)) {
            rec.sent[sink] = rec.sent[sink].filter((t) => t !== "stopped");
          }
        }
        if (!rec.long_running_on && longDays > 0 && (rec.days_running ?? 0) >= longDays) {
          rec.long_running_on = today;
          rec.long_running_at_first_sight = rec.first_seen === today;
        }
      } else if (rec.status === "active") {
        stop(rec, today, "ended");
        counts.stopped += 1;
      }

      // A landing page is news only when a recently started ad brings it. One seen first
      // on an older ad (e.g. one that was outside max_ads before) is recorded silently.
      if (platform === "meta" && rec.status === "active" && rec.landing && !entry.landings[rec.landing]) {
        const fresh = Boolean(rec.started) && daysBetween(rec.started, today) <= config.signals.new_within_days;
        entry.landings[rec.landing] = { first_seen: today, baseline: baseline || !fresh, sent: [] };
      }
    }

    // Only a complete answer proves a missing ad stopped. A capped one (the API said
    // has_more) does not, so there an ad is only reported once it has not been seen for
    // `signals.unseen_days`, and worded as "not seen", not "stopped".
    const unseenDays = config.signals.unseen_days;
    for (const [key, rec] of Object.entries(entry.ads)) {
      if (rec.platform !== platform || rec.status !== "active" || seen.has(key)) continue;
      if (result.complete) {
        stop(rec, today, "gone");
        counts.stopped += 1;
      } else if (unseenDays > 0 && rec.last_seen && daysBetween(rec.last_seen, today) >= unseenDays) {
        stop(rec, today, "unseen");
        counts.stopped += 1;
      }
    }

    entry.platforms[platform] = {
      since: platformState.since ?? today,
      last_ok: today,
      active: result.ads.filter((a) => a.active).length,
      complete: result.complete,
    };
  }

  // Forget ads that stopped a long time ago, so the state file does not grow forever.
  for (const [key, rec] of Object.entries(entry.ads)) {
    if (rec.status === "stopped" && rec.stopped_on && daysBetween(rec.stopped_on, today) > PRUNE_AFTER_DAYS) {
      delete entry.ads[key];
    }
  }
  return counts;
}

function adSummary(competitor, key, rec) {
  return {
    competitor: competitor.name,
    competitorKey: competitor.key,
    key,
    platform: rec.platform,
    format: rec.format,
    title: rec.title,
    text: rec.text,
    cta: rec.cta,
    landing: rec.landing,
    link: rec.link,
    started: rec.started,
    last_seen: rec.last_seen,
    days_running: rec.days_running,
    variants: rec.variants,
  };
}

function byStartedDesc(a, b) {
  return String(b.started ?? "").localeCompare(String(a.started ?? ""));
}

/**
 * Everything not yet delivered to destination `sink`, in config order. Events older
 * than `signals.retry_days` are dropped, so a destination added later does not get a
 * backlog of old news.
 */
export function pendingEvents(state, sink, today, config) {
  const { signals } = config;
  const events = [];

  for (const competitor of config.competitors) {
    const entry = state.competitors[competitor.key];
    if (!entry) continue;
    const ads = Object.entries(entry.ads);
    const sent = (rec, type) => (rec.sent[sink] ?? []).includes(type);

    if (within(entry.tracking_since, today, signals.retry_days) && !entry.baseline_sent.includes(sink)) {
      const active = ads.filter(([, r]) => r.status === "active");
      const landings = new Map();
      for (const [, r] of active) {
        if (r.landing) landings.set(r.landing, (landings.get(r.landing) ?? 0) + 1);
      }
      events.push({
        type: "baseline",
        competitor: competitor.name,
        competitorKey: competitor.key,
        active: {
          meta: active.filter(([, r]) => r.platform === "meta").length,
          google: active.filter(([, r]) => r.platform === "google").length,
        },
        long_running: active.filter(([, r]) => r.long_running_on).length,
        long_running_days: signals.long_running_days,
        platforms: Object.keys(entry.platforms),
        newest: active
          .map(([key, r]) => adSummary(competitor, key, r))
          .sort(byStartedDesc),
        landings: [...landings.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([url, ads]) => ({ url, ads })),
      });
    }

    const newAds = [];
    const longRunning = [];
    const stopped = [];
    for (const [key, rec] of ads) {
      const summary = () => adSummary(competitor, key, rec);
      if (
        !rec.baseline &&
        within(rec.first_seen, today, signals.retry_days) &&
        rec.started &&
        daysBetween(rec.started, rec.first_seen) <= signals.new_within_days &&
        !sent(rec, "new")
      ) {
        newAds.push({ type: "new", ...summary() });
      }
      if (
        rec.long_running_on &&
        !rec.long_running_at_first_sight &&
        rec.status === "active" &&
        within(rec.long_running_on, today, signals.retry_days) &&
        !sent(rec, "long_running")
      ) {
        longRunning.push({ type: "long_running", ...summary(), threshold: signals.long_running_days });
      }
      if (
        signals.stopped &&
        rec.status === "stopped" &&
        within(rec.stopped_on, today, signals.retry_days) &&
        !sent(rec, "stopped")
      ) {
        stopped.push({
          type: "stopped",
          ...summary(),
          stopped_on: rec.stopped_on,
          reason: rec.stopped_reason ?? "gone",
          unseen_days: signals.unseen_days,
        });
      }
    }
    events.push(...newAds.sort(byStartedDesc), ...longRunning.sort(byStartedDesc), ...stopped.sort(byStartedDesc));

    if (signals.landing_pages) {
      for (const [url, landing] of Object.entries(entry.landings)) {
        if (!landing.baseline && within(landing.first_seen, today, signals.retry_days) && !landing.sent.includes(sink)) {
          const using = ads.filter(([, r]) => r.landing === url && r.status === "active").length;
          events.push({ type: "landing", competitor: competitor.name, competitorKey: competitor.key, url, ads: using });
        }
      }
    }
  }
  return events;
}

/** Record that `events` reached destination `sink`. */
export function markSent(state, sink, events) {
  for (const event of events) {
    const entry = state.competitors[event.competitorKey];
    if (!entry) continue;
    if (event.type === "baseline") {
      if (!entry.baseline_sent.includes(sink)) entry.baseline_sent.push(sink);
    } else if (event.type === "landing") {
      const landing = entry.landings[event.url];
      if (landing && !landing.sent.includes(sink)) landing.sent.push(sink);
    } else {
      const rec = entry.ads[event.key];
      if (!rec) continue;
      const list = (rec.sent[sink] ??= []);
      if (!list.includes(event.type)) list.push(event.type);
    }
  }
}

/** What the Notion Status column should say: "active", "stopped" or "unseen". */
function syncStatus(rec) {
  if (rec.status === "active") return "active";
  return rec.stopped_reason === "unseen" ? "unseen" : "stopped";
}

/**
 * The Notion database mirrors the state: one page per ad. Returns the creates and
 * updates still needed, active and newest ads first, capped at `notion_max_writes`.
 */
export function notionOps(state, config) {
  const creates = [];
  const updates = [];
  for (const competitor of config.competitors) {
    const entry = state.competitors[competitor.key];
    if (!entry) continue;
    for (const [key, rec] of Object.entries(entry.ads)) {
      const op = { competitor: competitor.name, competitorKey: competitor.key, key, rec };
      if (!rec.notion?.page_id) {
        creates.push(op);
      } else if (rec.notion.status !== syncStatus(rec) || rec.notion.long_running !== Boolean(rec.long_running_on)) {
        updates.push({ ...op, pageId: rec.notion.page_id });
      }
    }
  }
  creates.sort((a, b) => {
    if (a.rec.status !== b.rec.status) return a.rec.status === "active" ? -1 : 1;
    return byStartedDesc(a.rec, b.rec);
  });
  const all = [...updates.map((op) => ({ ...op, action: "update" })), ...creates.map((op) => ({ ...op, action: "create" }))];
  const limit = config.delivery.notion_max_writes;
  return { ops: all.slice(0, limit), deferred: Math.max(0, all.length - limit) };
}

/** Record a Notion write in the state so the next run does not repeat it. */
export function markNotionSynced(rec, pageId) {
  rec.notion = { page_id: pageId, status: syncStatus(rec), long_running: Boolean(rec.long_running_on) };
}
