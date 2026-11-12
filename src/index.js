/**
 * competitor-ad-tracker: new Facebook, Instagram and Google ads from your competitors,
 * in a Notion database and a Slack or Discord digest. Collects through the
 * ScrapeUnblocker Meta Ad Library and Google Ads Transparency APIs.
 *
 * https://scrapeunblocker.com/?utm_source=github&utm_medium=integration&utm_campaign=example-repos
 */
export const VERSION = "1.0.0";

export { collectCompetitor, landingPage, makeClient, normalizeGoogleAds, normalizeMetaAds } from "./collect.js";
export { ConfigError, loadConfig, normalizeConfig } from "./config.js";
export { buildDigest, eventsPayload } from "./format.js";
export { NotionSink } from "./notion.js";
export { markSent, mergeCompetitor, notionOps, pendingEvents } from "./process.js";
export { run } from "./run.js";
export { destinationsFromEnv, DiscordSink, SlackSink, WebhookSink } from "./sinks.js";
export { loadState, saveState } from "./state.js";
