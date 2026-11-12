/**
 * Renders pending events as one digest message: Slack mrkdwn, Discord markdown,
 * GitHub-flavoured markdown (the Actions run summary) or plain text (the console).
 */
import { shortDate } from "./dates.js";

const PLATFORM = { meta: "Meta", google: "Google" };
const SNIPPET = 90;

const STYLES = {
  slack: {
    bold: (s) => `*${s}*`,
    link: (label, url) => (url ? `<${url}|${label}>` : label),
    escape: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  },
  discord: {
    bold: (s) => `**${s}**`,
    // <url> keeps Discord from unfurling a preview card for every link.
    link: (label, url) => (url ? `[${label}](<${url}>)` : label),
    escape: (s) => s.replace(/([\\*_~`|[\]])/g, "\\$1"),
  },
  markdown: {
    bold: (s) => `**${s}**`,
    link: (label, url) => (url ? `[${label}](${url})` : label),
    escape: (s) => s.replace(/([\\*_~`|[\]<>#])/g, "\\$1"),
  },
  plain: {
    bold: (s) => s,
    link: (label, url) => (url ? `${label} (${url})` : label),
    escape: (s) => s,
  },
};

function snippet(event) {
  const source = event.title || event.text;
  if (!source) return null;
  const flat = source.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET - 1).trimEnd()}…` : flat;
}

function adLabel(event) {
  const parts = [PLATFORM[event.platform] ?? event.platform];
  if (event.format) parts.push(event.format);
  let label = parts.join(" ");
  if (event.variants > 1) label += ` (${event.variants} variants)`;
  return label;
}

function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

function adLine(event, s, today) {
  const label = s.link(adLabel(event), event.link);
  const quote = snippet(event);
  const text = quote ? ` · "${s.escape(quote)}"` : "";
  const landing = event.landing ? ` → ${s.escape(event.landing)}` : "";
  switch (event.type) {
    case "new":
      return `• New · ${label} · started ${shortDate(event.started, today)}${text}${landing}`;
    case "long_running":
      return `• ${event.threshold}+ days · ${label} · running since ${shortDate(event.started, today)} (${plural(event.days_running, "day")})${text}`;
    case "stopped": {
      if (event.reason === "unseen") {
        return `• Not seen for ${event.unseen_days}+ days · ${label} · last seen ${shortDate(event.last_seen, today)}${text}`;
      }
      const span = event.started
        ? ` · ran ${shortDate(event.started, today)} to ${shortDate(event.last_seen, today)} (${plural(event.days_running ?? 0, "day")})`
        : "";
      return `• Stopped · ${label}${span}${text}`;
    }
    case "baseline_ad":
      return `• ${label} · started ${shortDate(event.started, today)}${text}${landing}`;
    default:
      return null;
  }
}

function competitorBlock(name, events, s, today, maxItems, moreHint) {
  const lines = [];
  const baseline = events.find((e) => e.type === "baseline");
  if (baseline) {
    const total = baseline.active.meta + baseline.active.google;
    const split = [];
    if (baseline.platforms.includes("meta")) split.push(`Meta ${baseline.active.meta}`);
    if (baseline.platforms.includes("google")) split.push(`Google ${baseline.active.google}`);
    let head = `${s.bold(s.escape(name))} · now tracking ${plural(total, "active ad")}`;
    if (split.length) head += ` (${split.join(", ")})`;
    if (baseline.long_running) {
      head += ` · ${baseline.long_running} running ${baseline.long_running_days}+ days`;
    }
    lines.push(head);
    const newest = baseline.newest.slice(0, maxItems);
    for (const ad of newest) lines.push(adLine({ ...ad, type: "baseline_ad" }, s, today));
    if (baseline.newest.length > newest.length) {
      lines.push(`• …and ${baseline.newest.length - newest.length} more${moreHint}`);
    }
    if (baseline.landings.length) {
      const top = baseline.landings
        .slice(0, 3)
        .map((l) => `${s.escape(l.url)} (${plural(l.ads, "ad")})`)
        .join(", ");
      lines.push(`Top landing pages: ${top}`);
    }
  }

  const items = events.filter((e) => e.type !== "baseline");
  if (items.length) {
    const count = (type) => items.filter((e) => e.type === type).length;
    const unseen = items.filter((e) => e.type === "stopped" && e.reason === "unseen");
    const summary = [];
    if (count("new")) summary.push(`${count("new")} new`);
    if (count("long_running")) {
      const days = items.find((e) => e.type === "long_running").threshold;
      summary.push(`${count("long_running")} running ${days}+ days`);
    }
    if (count("stopped") > unseen.length) summary.push(`${count("stopped") - unseen.length} stopped`);
    if (unseen.length) summary.push(`${unseen.length} not seen for ${unseen[0].unseen_days}+ days`);
    if (count("landing")) summary.push(plural(count("landing"), "new landing page"));
    if (!baseline) lines.push(`${s.bold(s.escape(name))} · ${summary.join(" · ")}`);

    const ads = items.filter((e) => e.type !== "landing");
    const shown = ads.slice(0, maxItems);
    for (const event of shown) lines.push(adLine(event, s, today));
    if (ads.length > shown.length) lines.push(`• …and ${ads.length - shown.length} more${moreHint}`);
    for (const event of items.filter((e) => e.type === "landing")) {
      lines.push(`• New landing page: ${s.escape(event.url)} (${plural(event.ads, "ad")})`);
    }
  }
  return lines;
}

/**
 * One message for every pending event, or null when there is nothing to say.
 * `moreHint` is appended to "...and N more" lines (e.g. " in Notion").
 */
export function buildDigest(events, { style = "plain", date, country, maxItems = 6, moreHint = "" } = {}) {
  if (!events.length) return null;
  const s = STYLES[style] ?? STYLES.plain;
  const lines = [`${s.bold("Competitor ads")} · ${shortDate(date)} ${date.slice(0, 4)} · ${country}`];

  const order = [];
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.competitor)) {
      groups.set(event.competitor, []);
      order.push(event.competitor);
    }
    groups.get(event.competitor).push(event);
  }
  for (const name of order) {
    lines.push("", ...competitorBlock(name, groups.get(name), s, date, maxItems, moreHint));
  }
  return lines.join("\n");
}

/** Drop the state-file key; the competitor's display name is already on every event. */
function withoutKey({ competitorKey: _competitorKey, ...rest }) {
  return rest;
}

/** The machine-readable side of the digest, for the generic webhook. */
export function eventsPayload(events, { date, country, text }) {
  return {
    source: "competitor-ad-tracker",
    date,
    country,
    text,
    events: events.map((event) => {
      const rest = withoutKey(event);
      if (rest.type === "baseline") return { ...rest, newest: rest.newest.slice(0, 20).map(withoutKey) };
      return rest;
    }),
  };
}

/** Split a message into chunks of at most `limit` characters on line breaks. */
export function splitMessage(text, limit) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
    if (current && current.length + 1 + piece.length > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
