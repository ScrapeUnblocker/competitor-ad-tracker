/**
 * Loads config.yml, fills in defaults and rejects values that would only fail later.
 *
 * Secrets never live here: the API key, the Notion token and webhook URLs come from
 * environment variables (see `destinationsFromEnv` in sinks.js).
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export const DEFAULTS = Object.freeze({
  country: "US",
  meta: { max_ads: 200, media_type: "all" },
  google: { max_results: 100, lookback_days: 30, stopped_after_days: 3, platform: "" },
  signals: {
    new_within_days: 7,
    long_running_days: 30,
    stopped: true,
    landing_pages: true,
    unseen_days: 14,
    retry_days: 3,
  },
  delivery: { max_items_per_competitor: 6, notion_max_writes: 150 },
});

const MEDIA_TYPES = new Set(["all", "image", "video", "meme"]);
const GOOGLE_PLATFORMS = new Set(["search", "youtube", "maps", "play", "shopping"]);

export class ConfigError extends Error {}

/** "Wispr Flow" -> "wispr-flow": the stable key a competitor is stored under. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function intIn(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got ${value}`);
  }
  return n;
}

function bool(value, name) {
  if (typeof value !== "boolean") throw new ConfigError(`${name} must be true or false`);
  return value;
}

function section(raw, key) {
  const value = raw[key] ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${key} must be a mapping`);
  }
  return { ...DEFAULTS[key], ...value };
}

function competitor(raw, i) {
  const where = `competitors[${i}]`;
  if (!raw || typeof raw !== "object") throw new ConfigError(`${where} must be a mapping`);
  const name = String(raw.name ?? "").trim();
  if (!name) throw new ConfigError(`${where} needs a name`);
  const key = slugify(name);
  if (!key) throw new ConfigError(`${where}: the name must contain a letter or digit`);

  const metaPageId = raw.meta_page_id == null ? "" : String(raw.meta_page_id).trim();
  if (metaPageId && !/^\d{5,20}$/.test(metaPageId)) {
    throw new ConfigError(
      `${name}: meta_page_id must be the numeric Page ID (view_all_page_id=... in the Ad Library URL), got "${metaPageId}"`,
    );
  }
  const googleDomain = String(raw.google_domain ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  const googleAdvertiser = String(raw.google_advertiser ?? "").trim();
  if (googleDomain && googleAdvertiser) {
    throw new ConfigError(`${name}: use google_domain or google_advertiser, not both`);
  }
  if (!metaPageId && !googleDomain && !googleAdvertiser) {
    throw new ConfigError(`${name}: set meta_page_id, google_domain or google_advertiser`);
  }
  return { name, key, metaPageId, googleDomain, googleAdvertiser };
}

/** Validate a parsed config object and return it with every default filled in. */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("the config must be a YAML mapping");
  }
  const country = String(raw.country ?? DEFAULTS.country).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new ConfigError(`country must be a 2-letter code such as US or GB, got "${country}"`);
  }

  if (!Array.isArray(raw.competitors) || raw.competitors.length === 0) {
    throw new ConfigError("competitors must list at least one advertiser");
  }
  const competitors = raw.competitors.map(competitor);
  const seen = new Set();
  for (const c of competitors) {
    if (seen.has(c.key)) throw new ConfigError(`two competitors share the name "${c.name}"`);
    seen.add(c.key);
  }

  const meta = section(raw, "meta");
  meta.max_ads = intIn(meta.max_ads, "meta.max_ads", 1, 500);
  meta.media_type = String(meta.media_type).toLowerCase();
  if (!MEDIA_TYPES.has(meta.media_type)) {
    throw new ConfigError(`meta.media_type must be one of ${[...MEDIA_TYPES].join(", ")}`);
  }

  const google = section(raw, "google");
  google.max_results = intIn(google.max_results, "google.max_results", 1, 1000);
  google.lookback_days = intIn(google.lookback_days, "google.lookback_days", 1, 365);
  google.stopped_after_days = intIn(google.stopped_after_days, "google.stopped_after_days", 1, 60);
  google.platform = String(google.platform ?? "").toLowerCase().replace(/\s+/g, "");
  for (const p of google.platform ? google.platform.split(",") : []) {
    if (!GOOGLE_PLATFORMS.has(p)) {
      throw new ConfigError(`google.platform: "${p}" is not one of ${[...GOOGLE_PLATFORMS].join(", ")}`);
    }
  }

  const signals = section(raw, "signals");
  signals.new_within_days = intIn(signals.new_within_days, "signals.new_within_days", 1, 90);
  signals.long_running_days = intIn(signals.long_running_days, "signals.long_running_days", 0, 3650);
  signals.unseen_days = intIn(signals.unseen_days, "signals.unseen_days", 0, 90);
  signals.retry_days = intIn(signals.retry_days, "signals.retry_days", 1, 30);
  signals.stopped = bool(signals.stopped, "signals.stopped");
  signals.landing_pages = bool(signals.landing_pages, "signals.landing_pages");

  const delivery = section(raw, "delivery");
  delivery.max_items_per_competitor = intIn(
    delivery.max_items_per_competitor,
    "delivery.max_items_per_competitor",
    1,
    50,
  );
  delivery.notion_max_writes = intIn(delivery.notion_max_writes, "delivery.notion_max_writes", 1, 1000);

  return { country, competitors, meta, google, signals, delivery };
}

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${err.message}`);
  }
  let raw;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${err.message}`);
  }
  return normalizeConfig(raw);
}
