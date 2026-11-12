/** Shared fixtures for the offline tests: API-shaped ads, a fake SDK client, fake sinks. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeConfig } from "../src/config.js";

export const TODAY = "2026-11-12";
export const NOW = new Date(`${TODAY}T07:00:00Z`);

export function config(overrides = {}) {
  return normalizeConfig({
    country: "US",
    competitors: [{ name: "Acme", meta_page_id: "1234567890", google_domain: "acme.com" }],
    ...overrides,
  });
}

/** One Meta Ad Library row, shaped like the API answer. */
export function metaRow(id, overrides = {}) {
  return {
    ad_archive_id: String(id),
    collation_id: null,
    collation_count: null,
    page_id: "1234567890",
    page_name: "Acme",
    is_active: true,
    started_running: "2026-11-01",
    ended: TODAY,
    platforms: ["FACEBOOK", "INSTAGRAM"],
    display_format: "IMAGE",
    ad_text: `Ad copy ${id}`,
    title: null,
    cta_text: "Sign up",
    link_url: "https://www.acme.com/pricing?utm_source=fb",
    ad_library_url: `https://www.facebook.com/ads/library/?id=${id}`,
    ...overrides,
  };
}

/** One Google Ads Transparency creative, shaped like the API answer. */
export function googleRow(id, overrides = {}) {
  return {
    creativeId: `CR${id}`,
    advertiserId: "AR111",
    advertiserName: "Acme Inc",
    format: "video",
    firstShown: "2026-10-01T10:00:00Z",
    lastShown: `${TODAY}T05:00:00Z`,
    daysShown: 40,
    matchedDomain: "acme.com",
    adUrl: `https://adstransparency.google.com/advertiser/AR111/creative/CR${id}?region=US`,
    ...overrides,
  };
}

/** A stand-in for ScrapeUnblockerClient that answers from fixed rows and records calls. */
export function fakeClient({ meta = [], google = [], metaHasMore = false, googleHasMore = false, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async metaAdLibrary(advertiser, options) {
      calls.push({ method: "metaAdLibrary", advertiser, options });
      if (fail.meta) throw fail.meta;
      return { advertiser, results: typeof meta === "function" ? meta() : meta, has_more: metaHasMore };
    },
    async googleAdsTransparency(options) {
      calls.push({ method: "googleAdsTransparency", options });
      if (fail.google) throw fail.google;
      return { creatives: typeof google === "function" ? google() : google, hasMore: googleHasMore, callUnits: 1 };
    },
  };
}

export function fakeSink(name, style = "plain", { failTimes = 0 } = {}) {
  const sent = [];
  let failures = failTimes;
  return {
    name,
    style,
    sent,
    async send(digest, payload) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("HTTP 500 boom");
      }
      sent.push({ digest, payload });
    },
  };
}

export function fakeNotion() {
  let n = 0;
  return {
    name: "notion",
    created: [],
    updated: [],
    addedColumns: [],
    async ensureSchema() {
      return "Name";
    },
    async create(rec, competitor) {
      n += 1;
      this.created.push({ rec: structuredClone(rec), competitor });
      return `page-${n}`;
    },
    async update(pageId, rec) {
      this.updated.push({ pageId, rec: structuredClone(rec) });
      return true;
    },
  };
}

export function tempStatePath() {
  return join(mkdtempSync(join(tmpdir(), "ad-tracker-")), "state", "ads.json");
}

export const quiet = () => {};
