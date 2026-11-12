#!/usr/bin/env node
/**
 * competitor-ad-tracker CLI.
 *
 *   competitor-ad-tracker run [--dry-run] [--only NAME] [--config config.yml] [--state state/ads.json]
 *   competitor-ad-tracker check [--config config.yml]
 */
import { realpathSync } from "node:fs";
import { argv, env, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { isFatal, makeClient } from "../src/collect.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { VERSION } from "../src/index.js";
import { NotionError } from "../src/notion.js";
import { run } from "../src/run.js";
import { DeliveryError, destinationsFromEnv } from "../src/sinks.js";
import { DEFAULT_STATE_PATH, StateError } from "../src/state.js";

const HELP = `competitor-ad-tracker ${VERSION}
New Facebook, Instagram and Google ads from your competitors, in Notion and Slack/Discord.

Usage:
  competitor-ad-tracker run     collect, deliver what is new, save the state
  competitor-ad-tracker check   validate config.yml, list destinations, prepare the Notion database

Options:
  -c, --config <file>   config file (default: config.yml)
  -s, --state <file>    state file (default: ${DEFAULT_STATE_PATH})
  -n, --dry-run         print what would be delivered; send nothing, save nothing
      --only <name>     run for one competitor from the config
  -v, --version         print the version
  -h, --help            show this help

Environment:
  SCRAPEUNBLOCKER_KEY   your ScrapeUnblocker API key (required for run)
  SLACK_WEBHOOK_URL     Slack incoming webhook
  DISCORD_WEBHOOK_URL   Discord channel webhook
  WEBHOOK_URL           any URL that takes a JSON POST (Zapier, Make, n8n, ...)
  NOTION_TOKEN          Notion internal integration secret
  NOTION_DATABASE_ID    the Notion database (id or URL) shared with that integration
`;

export function parseCli(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "config.yml" },
      state: { type: "string", short: "s", default: DEFAULT_STATE_PATH },
      "dry-run": { type: "boolean", short: "n", default: false },
      only: { type: "string" },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0] ?? (values.help || values.version ? null : "run");
  if (command && !["run", "check"].includes(command)) {
    throw new ConfigError(`unknown command "${command}" (use run or check)`);
  }
  if (positionals.length > 1) throw new ConfigError(`unexpected argument "${positionals[1]}"`);
  return {
    command,
    config: values.config,
    state: values.state,
    dryRun: values["dry-run"],
    only: values.only ?? null,
    version: values.version,
    help: values.help,
  };
}

function annotate(level, message) {
  if (env.GITHUB_ACTIONS === "true") console.log(`::${level}::${message.replace(/\r?\n/g, " ")}`);
}

async function check(opts, deps) {
  const config = loadConfig(opts.config);
  const destinations = deps.destinations ?? destinationsFromEnv(env);
  console.log(`${opts.config}: OK, ${config.competitors.length} competitor(s), country ${config.country}`);
  for (const c of config.competitors) {
    const parts = [];
    if (c.metaPageId) parts.push(`Meta page ${c.metaPageId}`);
    if (c.googleDomain) parts.push(`Google ads for ${c.googleDomain}`);
    if (c.googleAdvertiser) parts.push(`Google advertiser ${c.googleAdvertiser}`);
    console.log(`  - ${c.name}: ${parts.join(", ")}`);
  }
  const chat = destinations.chat.map((s) => s.name);
  console.log(`Chat destinations: ${chat.length ? chat.join(", ") : "none (the digest is printed)"}`);
  if (destinations.notion) {
    await destinations.notion.ensureSchema();
    const added = destinations.notion.addedColumns ?? [];
    console.log(`Notion: database reachable${added.length ? `, added columns ${added.join(", ")}` : ", columns OK"}`);
  } else {
    console.log("Notion: not set (NOTION_TOKEN + NOTION_DATABASE_ID)");
  }
  console.log(`API key: ${env.SCRAPEUNBLOCKER_KEY ? "set" : "NOT set (SCRAPEUNBLOCKER_KEY)"}`);
  return 0;
}

export async function main(args = argv.slice(2), deps = {}) {
  let opts;
  try {
    opts = parseCli(args);
  } catch (err) {
    console.error(`error: ${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }

  try {
    if (opts.command === "check") return await check(opts, deps);

    const config = loadConfig(opts.config);
    if (!deps.client && !env.SCRAPEUNBLOCKER_KEY) {
      console.error(
        "error: SCRAPEUNBLOCKER_KEY is not set. Get a key at https://scrapeunblocker.com/?utm_source=github&utm_medium=integration&utm_campaign=example-repos",
      );
      return 2;
    }
    const report = await run({
      config,
      statePath: opts.state,
      dryRun: opts.dryRun,
      only: opts.only,
      client: deps.client ?? makeClient(),
      destinations: deps.destinations ?? destinationsFromEnv(env),
      now: deps.now,
      env,
    });
    for (const failure of report.failures) annotate("warning", `Collection failed: ${failure}`);
    for (const failure of report.deliveryErrors) annotate("error", `Delivery failed: ${failure}`);
    if (report.collected === 0 && report.failures.length) {
      console.error("error: every API call failed; nothing new was collected");
      return 1;
    }
    return report.deliveryErrors.length ? 1 : 0;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof StateError || err instanceof DeliveryError || err instanceof NotionError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    if (isFatal(err)) {
      console.error(`error: the API refused the key or the account has no credit left: ${err.message}`);
      annotate("error", `ScrapeUnblocker: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/** True when run as a program (also through the npm bin symlink), false when imported by tests. */
function invokedDirectly() {
  try {
    return Boolean(argv[1]) && import.meta.url === pathToFileURL(realpathSync(argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  exit(await main());
}
