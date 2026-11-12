/**
 * The API calls: one Meta Ad Library request and one Google Ads Transparency request
 * per competitor, shaped into one flat ad record per creative.
 */
import { AuthenticationError, PaymentRequiredError, ScrapeUnblockerClient } from "scrapeunblocker";

import { addDays, daysBetween, isoDate } from "./dates.js";

/** Landing hosts that are Meta's own redirects or chat links, not a page on the advertiser's site. */
const NOT_A_LANDING_PAGE = new Set([
  "fb.me",
  "facebook.com",
  "m.facebook.com",
  "l.facebook.com",
  "instagram.com",
  "l.instagram.com",
  "m.me",
  "wa.me",
  "api.whatsapp.com",
]);

/** Hosts where a query parameter, not the path, says which page it is. */
const PAGE_PARAMS = {
  "play.google.com": ["id"],
  "youtube.com": ["v"],
  "m.youtube.com": ["v"],
};

const META_FORMATS = { dco: "dynamic", dpa: "catalog", multi_images: "carousel" };

/** An error that makes every further call pointless (bad key, no credit). */
export function isFatal(err) {
  return err instanceof AuthenticationError || err instanceof PaymentRequiredError;
}

export function makeClient(apiKey = process.env.SCRAPEUNBLOCKER_KEY) {
  return new ScrapeUnblockerClient({
    apiKey,
    maxRetries: 3,
    timeout: 240_000,
    userAgent: "competitor-ad-tracker/1.0",
  });
}

/**
 * "https://www.notion.com/enterprise/?utm_source=fb" -> "notion.com/enterprise".
 * Query strings are dropped (they are mostly campaign tracking), except the few that
 * name the page, like the app id of a Google Play link.
 */
export function landingPage(url) {
  if (!url || typeof url !== "string") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "l.facebook.com" && u.searchParams.get("u")) return landingPage(u.searchParams.get("u"));
  if (!host.includes(".") || NOT_A_LANDING_PAGE.has(host)) return null;
  const path = u.pathname.replace(/\/+$/, "");
  const keep = (PAGE_PARAMS[host] ?? []).filter((p) => u.searchParams.get(p));
  const query = keep.map((p) => `${p}=${u.searchParams.get(p)}`).join("&");
  return host + path + (query ? `?${query}` : "");
}

/** Ad copy with the catalog template tokens ("{{product.name}}") treated as no copy. */
function cleanText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").trim();
  if (!text || /\{\{[^}]+\}\}/.test(text)) return null;
  return text;
}

/**
 * Meta returns each creative of a collation group (the variants of one ad) as its own row.
 * Keep one record per group so a 9-variant test is one ad, not nine.
 */
export function normalizeMetaAds(results, competitorName, today) {
  const groups = new Map();
  for (const ad of results ?? []) {
    if (!ad || !ad.ad_archive_id) continue;
    const groupId = ad.collation_id || ad.ad_archive_id;
    const group = groups.get(groupId);
    if (group) {
      group.rows.push(ad);
    } else {
      groups.set(groupId, { groupId, rows: [ad] });
    }
  }

  const ads = [];
  for (const { groupId, rows } of groups.values()) {
    const ad = rows[0];
    const started = rows.map((r) => isoDate(r.started_running)).filter(Boolean).sort()[0] ?? null;
    const lastShown = ad.is_active === false ? (isoDate(ad.ended) ?? today) : today;
    const text = cleanText(ad.ad_text);
    const title = cleanText(ad.title);
    const format = String(ad.display_format ?? "").toLowerCase() || null;
    const collation = Math.max(rows.length, ...rows.map((r) => Number(r.collation_count) || 0));
    ads.push({
      key: `meta:${groupId}`,
      platform: "meta",
      id: String(ad.ad_archive_id),
      competitor: competitorName,
      format: META_FORMATS[format] ?? format,
      title,
      text,
      cta: ad.cta_text ?? null,
      landing: landingPage(ad.link_url),
      link: ad.ad_library_url ?? `https://www.facebook.com/ads/library/?id=${ad.ad_archive_id}`,
      started,
      lastShown,
      daysRunning: started ? Math.max(0, daysBetween(started, lastShown)) : null,
      variants: collation,
      placements: Array.isArray(ad.platforms) ? ad.platforms.map((p) => String(p).toLowerCase()) : [],
      active: ad.is_active !== false,
    });
  }
  return ads;
}

/**
 * Google returns one row per creative, most recently shown first. Rows last shown before
 * `since` (the lookback window) are dropped: the API can include them, and an ad that
 * ended months ago is history, not news.
 */
export function normalizeGoogleAds(creatives, competitorName, today, stoppedAfterDays, since = null) {
  const cutoff = addDays(today, -stoppedAfterDays);
  const ads = [];
  for (const c of creatives ?? []) {
    if (!c || !c.creativeId) continue;
    const started = isoDate(c.firstShown);
    const lastShown = isoDate(c.lastShown);
    if (since && (!lastShown || lastShown < since)) continue;
    ads.push({
      key: `google:${c.creativeId}`,
      platform: "google",
      id: String(c.creativeId),
      competitor: competitorName,
      format: c.format ? String(c.format).toLowerCase() : null,
      title: null,
      text: null,
      cta: null,
      landing: null,
      link: c.adUrl ?? null,
      started,
      lastShown,
      daysRunning: started && lastShown ? Math.max(0, daysBetween(started, lastShown)) : null,
      variants: 1,
      placements: [],
      active: Boolean(lastShown && lastShown >= cutoff),
    });
  }
  return ads;
}

/**
 * Collect one competitor. Returns one result per platform:
 * `{ platform, ok, ads, complete, calls, error }`. `complete` is true when the API said
 * there are no more ads, which is what lets the tracker call a missing ad "stopped".
 * A fatal error (bad key, no credit) is thrown; anything else is returned as `error`.
 */
export async function collectCompetitor(client, competitor, config, today, log = () => {}) {
  const results = [];

  if (competitor.metaPageId) {
    const started = Date.now();
    try {
      const res = await client.metaAdLibrary(competitor.metaPageId, {
        country: config.country,
        activeStatus: "active",
        mediaType: config.meta.media_type,
        maxAds: config.meta.max_ads,
      });
      const ads = normalizeMetaAds(res?.results, competitor.name, today);
      results.push({ platform: "meta", ok: true, ads, complete: res?.has_more === false, calls: 1, error: null });
      log(`  meta    ${competitor.name}: ${res?.results?.length ?? 0} active ads in ${ads.length} groups (${secs(started)})`);
    } catch (err) {
      if (isFatal(err)) throw err;
      results.push({ platform: "meta", ok: false, ads: [], complete: false, calls: 1, error: errorText(err) });
      log(`  meta    ${competitor.name}: FAILED ${errorText(err)}`);
    }
  }

  if (competitor.googleDomain || competitor.googleAdvertiser) {
    const started = Date.now();
    const options = {
      region: config.country,
      sort: "last_shown",
      maxResults: config.google.max_results,
      dateFrom: addDays(today, -config.google.lookback_days),
    };
    if (competitor.googleDomain) options.domain = competitor.googleDomain;
    else options.advertiser = competitor.googleAdvertiser;
    if (config.google.platform) options.platform = config.google.platform;
    try {
      const res = await client.googleAdsTransparency(options);
      const ads = normalizeGoogleAds(
        res?.creatives,
        competitor.name,
        today,
        config.google.stopped_after_days,
        options.dateFrom,
      );
      const calls = Number(res?.callUnits) || Number(res?.pagesFetched) || 1;
      results.push({ platform: "google", ok: true, ads, complete: res?.hasMore === false, calls, error: null });
      const active = ads.filter((a) => a.active).length;
      log(`  google  ${competitor.name}: ${ads.length} ads shown since ${options.dateFrom}, ${active} still running (${secs(started)})`);
    } catch (err) {
      if (isFatal(err)) throw err;
      results.push({ platform: "google", ok: false, ads: [], complete: false, calls: 1, error: errorText(err) });
      log(`  google  ${competitor.name}: FAILED ${errorText(err)}`);
    }
  }

  return results;
}

function secs(started) {
  return `${((Date.now() - started) / 1000).toFixed(1)} s`;
}

function errorText(err) {
  const status = err?.statusCode ? ` (HTTP ${err.statusCode})` : "";
  return `${err?.name ?? "Error"}${status}: ${String(err?.message ?? err).slice(0, 200)}`;
}
