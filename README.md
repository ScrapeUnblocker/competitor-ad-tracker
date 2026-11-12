# competitor-ad-tracker

[![CI](https://github.com/ScrapeUnblocker/competitor-ad-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/ScrapeUnblocker/competitor-ad-tracker/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Powered by ScrapeUnblocker](https://img.shields.io/badge/powered%20by-ScrapeUnblocker-6c47ff)](https://scrapeunblocker.com/?utm_source=github&utm_medium=integration&utm_campaign=example-repos)

**For marketers and founders: every new Facebook, Instagram and Google ad your competitors launch lands in a Notion database, with a morning digest in Slack or Discord that also flags their long-running ads, the ads they stopped and the new landing pages they send traffic to.**

It runs on a GitHub Actions schedule. You edit one YAML file. There is no server to host.

## What actually arrives

The first run is a summary per competitor (real output, 12 Nov 2026, as it reads in Slack):

```text
Competitor ads · 12 Nov 2026 · US

Notion · now tracking 93 active ads (Meta 41, Google 52) · 66 running 30+ days
• Google image · started 9 Nov
• Meta video (4 variants) · started 7 Nov · "Meet Your AI-Powered Workspace" → notion.com/enterprise
• Meta dynamic (4 variants) · started 7 Nov · "Knowledge and work. Connected." → notion.com/enterprise
• Meta dynamic (5 variants) · started 7 Nov · "Knowledge and work. Connected." → notion.com/enterprise
• Meta dynamic (7 variants) · started 7 Nov · "Knowledge and work. Connected." → notion.com/enterprise
• Meta dynamic (5 variants) · started 7 Nov · "Knowledge and work. Connected." → notion.com/enterprise
• …and 87 more in Notion
Top landing pages: notion.com/enterprise (5 ads)

Perplexity · now tracking 142 active ads (Meta 68, Google 74) · 75 running 30+ days
• Meta dynamic (2 variants) · started 10 Nov · "Stop paying for AI separately." → perplexity.sng.link/A6awk/lplb
• Google text · started 10 Nov
...
```

After that, a message arrives only when something changed. A normal day looks like this (built from the same real ads):

```text
Competitor ads · 12 Nov 2026 · US

Notion · 1 stopped
• Stopped · Google text · ran 30 Apr to 5 Nov (189 days)

Perplexity · 4 new · 12 stopped
• New · Meta dynamic (2 variants) · started 10 Nov · "Stop paying for AI separately." → perplexity.sng.link/A6awk/lplb
• New · Google text · started 10 Nov
• New · Google text · started 10 Nov
• …and 13 more in Notion

Wispr Flow · 4 running 30+ days
• 30+ days · Google video · running since 13 Oct (30 days)
• 30+ days · Google video · running since 13 Oct (30 days)
• 30+ days · Google video · running since 13 Oct (30 days)
• …and 1 more in Notion
```

Every ad label (`Meta video`, `Google text` ...) links to the ad in the Meta Ad Library or the Google Ads Transparency Center. Nothing new means no message.

In **Notion**, every ad is one page in a database you own, so it becomes a swipe file you can filter, sort and comment on:

| Column | Example |
| --- | --- |
| Name (the title) | Meet Your AI-Powered Workspace |
| Competitor / Platform / Format | Notion / Meta / Video |
| Status | Active, Stopped, or Not seen (see [How it works](#how-it-works)) |
| Started / Last seen / Days running | 2026-11-07 / 2026-11-12 / 5 |
| Long-running | checked once the ad passes 30 days |
| Landing page / CTA | https://notion.com/enterprise / Learn more |
| Ad text | the full ad copy |
| Variants / Placements | 4 / Facebook, Instagram, Audience Network, WhatsApp, Threads |
| Ad link / Ad ID | the ad in the public library / its id |

## Setup in three steps

1. **Use this template.** Click **Use this template > Create a new repository** at the top of this page. A private repository works the same way.
2. **Add secrets.** In your new repository, open **Settings > Secrets and variables > Actions > New repository secret**:

   | Secret | Needed | Where to get it |
   | --- | --- | --- |
   | `SCRAPEUNBLOCKER_KEY` | yes | your API key from [ScrapeUnblocker](https://scrapeunblocker.com/?utm_source=github&utm_medium=integration&utm_campaign=example-repos) |
   | `SLACK_WEBHOOK_URL` | one or more of these | a Slack [incoming webhook](https://api.slack.com/messaging/webhooks) for your channel |
   | `DISCORD_WEBHOOK_URL` | | Discord channel > Edit Channel > Integrations > Webhooks > New Webhook > Copy URL |
   | `WEBHOOK_URL` | | any URL that takes a JSON POST (Zapier, Make, n8n, your own endpoint) |
   | `NOTION_TOKEN` + `NOTION_DATABASE_ID` | | see [Notion](#notion) below |

   Without any destination the digest still shows up on each run's summary page in the **Actions** tab.
3. **Edit `config.yml`.** Replace the three example competitors with yours. For each one, add the Facebook Page ID and the website domain their Google ads point to:

   ```yaml
   country: US
   competitors:
     - name: Notion
       meta_page_id: "825120160874613"
       google_domain: notion.com
   ```

   To find a Page ID, search the advertiser at [facebook.com/ads/library](https://www.facebook.com/ads/library/), pick their Page from the suggestions, and copy the number after `view_all_page_id=` in the address bar.

Then open **Actions > Track competitor ads > Run workflow** for the first run, or wait for the daily schedule (07:17 UTC). Tick **Dry run** to see the digest in the run log without sending anything.

### Notion

1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations), create an **internal** integration and copy its secret. That is `NOTION_TOKEN`.
2. Create an empty full-page database (for example "Competitor ads"). Open its **...** menu > **Connections** and add your integration.
3. Copy the database link (**...** > **Copy link**). The whole link works as `NOTION_DATABASE_ID`.

The first run adds the columns it needs. Columns you add yourself (Notes, Owner, Tags) are left alone.

## How it works

```text
config.yml ──► collect ──────────────► process ──────────────► deliver
               Meta Ad Library          merge into state         Notion database (one page per ad)
               Google Ads Transparency  new / 30+ days /         Slack, Discord, webhook (one digest)
               (1 request each)         stopped / landing pages  Actions run summary
                                              │
                                     state/ads.json (committed)
```

- **Collect.** For each competitor, one call to the ScrapeUnblocker [Meta Ad Library](https://docs.scrapeunblocker.com/plugins/meta-ad-library?utm_source=github&utm_medium=integration&utm_campaign=example-repos) endpoint (the Page's active ads in your country) and one to the [Google Ads Transparency](https://docs.scrapeunblocker.com/plugins/google-ads-transparency?utm_source=github&utm_medium=integration&utm_campaign=example-repos) endpoint (ads pointing at their domain, shown in the last `lookback_days`). Both go through the official [`scrapeunblocker`](https://www.npmjs.com/package/scrapeunblocker) Node SDK, which retries temporary failures. If one call fails, the other competitors and platforms still run, and nothing is marked stopped because of the error.
- **Process.**
  - Meta lists every variant of an ad as its own row. Rows of one collation group become one ad with a `Variants` count, so a 7-variant test is one line, not seven.
  - **New:** an ad that was not there on earlier runs and started within `new_within_days`. An older ad seen for the first time (it was beyond `max_ads` before) goes to Notion quietly.
  - **30+ days:** an ad still running after `long_running_days`. Advertisers rarely keep paying for an ad that does not work, so these are the ones worth studying.
  - **Stopped:** a Google ad not shown for `stopped_after_days`, or a Meta ad missing from a complete answer. When an advertiser has more active ads than one answer holds (the API says `has_more`), a missing ad proves nothing. It is reported as **Not seen** after `unseen_days` instead, never as stopped.
  - **New landing page:** a page on a recently started Meta ad that none of their earlier ads used. Tracking parameters are stripped, so `?utm_source=fb` variants are one page.
  - **First run:** one "now tracking" summary per competitor instead of hundreds of "new" lines.
- **Deliver.** Notion mirrors the state: missing pages are created, and a page is updated when its ad stops or passes the long-running mark. Chat destinations get one digest per run. Each event is remembered per destination: if Slack is down, Slack gets it on the next run, and Discord is not sent it twice. A failed delivery turns the run red and is retried for `retry_days`.
- **State.** Everything lives in `state/ads.json`. The workflow commits it after each run, so the next run knows what was already delivered, and the git history doubles as a timeline of your competitors' ads. A second run with nothing new sends nothing. `--dry-run` prints what would be sent and saves nothing.

### Running it yourself

You need Node.js 22 or newer.

```bash
git clone https://github.com/<you>/competitor-ad-tracker && cd competitor-ad-tracker
npm ci --omit=dev
cp .env.example .env            # then fill in your key and destinations
node --env-file=.env bin/cli.js check            # validates config.yml, prepares Notion
node --env-file=.env bin/cli.js run --dry-run    # prints the digest, sends nothing
node --env-file=.env bin/cli.js run
```

Cron, every morning at 07:17:

```cron
17 7 * * * cd /opt/competitor-ad-tracker && /usr/bin/node --env-file=.env bin/cli.js run >> tracker.log 2>&1
```

Docker, with the state kept in the mounted folder:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-slim \
  sh -c "npm ci --omit=dev && node --env-file=.env bin/cli.js run"
```

CLI options: `run` (default) or `check`; `--config <file>`, `--state <file>`, `--dry-run`, `--only <competitor>`, `--version`, `--help`.

## Config reference

Everything is in `config.yml`. Secrets never go there.

| Key | Default | What it does |
| --- | --- | --- |
| `country` | `US` | Meta Ad Library country and Google Ads Transparency region (2 letters). |
| `competitors[].name` | | Shown in messages and Notion. Also the key in the state file, so renaming starts that competitor fresh. |
| `competitors[].meta_page_id` | | Numeric Facebook Page ID. Leave out to skip Meta. |
| `competitors[].google_domain` | | Website their Google ads point to, e.g. `notion.com`. |
| `competitors[].google_advertiser` | | Instead of the domain: an advertiser name or id (`AR...`) from adstransparency.google.com. |
| `meta.max_ads` | `200` | Active ads read per advertiser (1-500), in one request. |
| `meta.media_type` | `all` | `all`, `image`, `video` or `meme`. |
| `google.max_results` | `100` | Ads read per advertiser (1-1000). Each block of up to 100 is one request. |
| `google.lookback_days` | `30` | Only ads shown in the last N days. |
| `google.stopped_after_days` | `3` | A Google ad not shown for N days counts as stopped. |
| `google.platform` | all | Optional comma list: `search`, `youtube`, `maps`, `play`, `shopping`. |
| `signals.new_within_days` | `7` | An ad counts as new when it started within N days. |
| `signals.long_running_days` | `30` | Flag ads still running after N days. `0` turns it off. |
| `signals.stopped` | `true` | Report stopped (and not seen) ads. |
| `signals.landing_pages` | `true` | Report new landing pages. |
| `signals.unseen_days` | `14` | Capped answers: report an ad as not seen after N days. `0` turns it off. |
| `signals.retry_days` | `3` | How long a failed delivery is retried. |
| `delivery.max_items_per_competitor` | `6` | Ads listed per competitor in the digest; the rest are counted. |
| `delivery.notion_max_writes` | `150` | Notion writes per run. A big first run finishes over the next runs. |

## Cost

ScrapeUnblocker requests per run = for each competitor, **1** Meta Ad Library request plus **1** Google Ads Transparency request per 100 ads in `google.max_results`.

With the default `config.yml` (3 competitors, `google.max_results: 100`): **6 requests per run**. The schedule runs once a day, so that is about 180 requests a month. Each run prints its request count. Notion, Slack and Discord calls go to their own APIs and cost nothing here.

With no `SCRAPEUNBLOCKER_KEY` secret, the workflow prints a notice and exits green without calling anything. That is why this template's own Actions runs do nothing.

## Adding another destination

A chat destination is an object with a `name` (the key in the state file for what it already received), a `style` (`plain`, `markdown`, `slack` or `discord`) and an async `send(digest, payload)` that throws on failure. For example, Google Chat in `src/sinks.js`:

```js
export class GoogleChatSink {
  constructor(url, { fetchImpl = fetch } = {}) {
    this.name = "google_chat";
    this.style = "plain";
    this.url = url;
    this.fetch = fetchImpl;
  }

  async send(digest) {
    const res = await this.fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: digest }),
    });
    if (!res.ok) throw new DeliveryError(`HTTP ${res.status}`);
  }
}
```

Register it in `destinationsFromEnv()` (`if (env.GOOGLE_CHAT_WEBHOOK_URL) chat.push(new GoogleChatSink(env.GOOGLE_CHAT_WEBHOOK_URL));`), then pass the secret in `.github/workflows/run.yml`. `payload` holds the same events as JSON (`type`, `competitor`, `platform`, `format`, `started`, `days_running`, `text`, `landing`, `link`). The webhook destination sends exactly that, if you would rather do the formatting in Zapier, Make or n8n.

## Links

- [ScrapeUnblocker](https://scrapeunblocker.com/?utm_source=github&utm_medium=integration&utm_campaign=example-repos): the API this runs on
- [Documentation](https://docs.scrapeunblocker.com/?utm_source=github&utm_medium=integration&utm_campaign=example-repos)
- [Meta Ad Library endpoint](https://docs.scrapeunblocker.com/plugins/meta-ad-library?utm_source=github&utm_medium=integration&utm_campaign=example-repos) and [Google Ads Transparency endpoint](https://docs.scrapeunblocker.com/plugins/google-ads-transparency?utm_source=github&utm_medium=integration&utm_campaign=example-repos)
- [Node.js SDK](https://docs.scrapeunblocker.com/sdks/nodejs?utm_source=github&utm_medium=integration&utm_campaign=example-repos)
- Related: [website-change-monitor](https://github.com/ScrapeUnblocker/website-change-monitor) (watch competitors' pricing and changelog pages) and [google-rank-tracker](https://github.com/ScrapeUnblocker/google-rank-tracker) (your Google positions against theirs)

The Meta Ad Library and the Google Ads Transparency Center are public transparency tools. This project reads that public ad data and is not affiliated with Meta or Google.

## Development

```bash
npm ci
npm run lint     # ESLint
npm test         # node:test, offline: the SDK, Slack, Discord and Notion are all faked
npm run dry-run  # a real run that sends and saves nothing (needs SCRAPEUNBLOCKER_KEY)
```

The code is small and split by job: `src/collect.js` (API calls and shaping), `src/process.js` (state merge and events), `src/format.js` (the digest), `src/sinks.js` and `src/notion.js` (destinations), `src/state.js`, `src/run.js` and `bin/cli.js`.

## License

MIT. See [LICENSE](LICENSE).
