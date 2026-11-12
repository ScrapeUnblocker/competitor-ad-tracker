/**
 * Notion destination: every tracked ad is one page in a database you own, so the
 * database is your searchable, filterable swipe file. New ads become new pages; when
 * an ad stops or passes the long-running mark, its page is updated.
 *
 * Missing columns are added on the first run, so an empty database is enough.
 */
const DEFAULT_BASE = "https://api.notion.com";
export const NOTION_VERSION = "2022-06-28";

/** The columns this tracker writes, with their Notion property types. */
export const SCHEMA = {
  Competitor: { select: {} },
  Platform: { select: {} },
  Format: { select: {} },
  Status: { select: {} },
  Started: { date: {} },
  "Last seen": { date: {} },
  "Days running": { number: { format: "number" } },
  "Long-running": { checkbox: {} },
  "Landing page": { url: {} },
  CTA: { rich_text: {} },
  "Ad text": { rich_text: {} },
  Variants: { number: { format: "number" } },
  "Ad link": { url: {} },
  "Ad ID": { rich_text: {} },
  Placements: { multi_select: {} },
};

const PLATFORM = { meta: "Meta", google: "Google" };
const PLACEMENT = {
  facebook: "Facebook",
  instagram: "Instagram",
  audience_network: "Audience Network",
  messenger: "Messenger",
  whatsapp: "WhatsApp",
  threads: "Threads",
};

export class NotionError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Accepts the bare id, a dashed id or the database URL you copy from Notion. */
export function parseDatabaseId(input) {
  const path = String(input ?? "").split("?")[0];
  const matches = path.replace(/-/g, "").match(/[0-9a-f]{32}/gi);
  if (!matches) throw new NotionError(`NOTION_DATABASE_ID does not contain a database id: "${input}"`);
  const id = matches[matches.length - 1].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Select option names may not contain commas and are capped at 100 characters. */
function option(name) {
  return String(name).replace(/,/g, " ").slice(0, 100);
}

function richText(value) {
  if (!value) return [];
  const text = String(value);
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 2; i += 2000) {
    chunks.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  }
  return chunks;
}

export function pageTitle(rec, competitorName) {
  const source = rec.title || rec.text;
  if (source) {
    const flat = source.replace(/\s+/g, " ").trim();
    return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
  }
  const format = rec.format ? `${rec.format} ` : "";
  return `${competitorName} ${PLATFORM[rec.platform] ?? rec.platform} ${format}ad`;
}

/** The full property set for a page; `titleProperty` is whatever the database calls its title. */
export function pageProperties(rec, competitorName, titleProperty) {
  return {
    [titleProperty]: { title: [{ type: "text", text: { content: pageTitle(rec, competitorName) } }] },
    Competitor: { select: { name: option(competitorName) } },
    Platform: { select: { name: PLATFORM[rec.platform] ?? option(rec.platform) } },
    Format: { select: rec.format ? { name: option(capitalize(rec.format)) } : null },
    Status: { select: { name: statusName(rec) } },
    Started: { date: rec.started ? { start: rec.started } : null },
    "Last seen": { date: rec.last_seen ? { start: rec.last_seen } : null },
    "Days running": { number: rec.days_running ?? null },
    "Long-running": { checkbox: Boolean(rec.long_running_on) },
    "Landing page": { url: rec.landing ? `https://${rec.landing}` : null },
    CTA: { rich_text: richText(rec.cta) },
    "Ad text": { rich_text: richText(rec.text) },
    Variants: { number: rec.variants ?? 1 },
    "Ad link": { url: rec.link ?? null },
    "Ad ID": { rich_text: richText(rec.id) },
    Placements: {
      multi_select: (rec.placements ?? []).map((p) => ({ name: option(PLACEMENT[p] ?? capitalize(p.replace(/_/g, " "))) })),
    },
  };
}

/** "Not seen" = missing from capped answers for signals.unseen_days, not confirmed stopped. */
function statusName(rec) {
  if (rec.status === "active") return "Active";
  return rec.stopped_reason === "unseen" ? "Not seen" : "Stopped";
}

/** The properties that change after a page exists. */
export function updateProperties(rec) {
  return {
    Status: { select: { name: statusName(rec) } },
    "Last seen": { date: rec.last_seen ? { start: rec.last_seen } : null },
    "Days running": { number: rec.days_running ?? null },
    "Long-running": { checkbox: Boolean(rec.long_running_on) },
  };
}

export class NotionSink {
  /**
   * @param {object} o
   * @param {string} o.token     internal integration secret (NOTION_TOKEN)
   * @param {string} o.database  database id or URL (NOTION_DATABASE_ID)
   * @param {string} [o.baseUrl] API base; NOTION_API_URL overrides it for tests or a proxy
   */
  constructor({ token, database, baseUrl, fetchImpl, sleep, minIntervalMs = 350 }) {
    this.name = "notion";
    this.token = token;
    this.databaseId = parseDatabaseId(database);
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    this.fetch = fetchImpl ?? fetch;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minIntervalMs = minIntervalMs; // Notion allows about 3 requests a second
    this.lastRequest = 0;
    this.titleProperty = null;
  }

  async request(method, path, body) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const waitFor = this.lastRequest + this.minIntervalMs - Date.now();
      if (waitFor > 0) await this.sleep(waitFor);
      this.lastRequest = Date.now();

      let res;
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt === 4) throw new NotionError(`network error: ${err.message}`, 0);
        await this.sleep(1000 * attempt);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;

      const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
      if (retryable && attempt < 4) {
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * attempt);
        continue;
      }
      throw new NotionError(this.explain(res.status, data), res.status);
    }
    throw new NotionError("Notion request failed", 0);
  }

  explain(status, data) {
    const message = data?.message ?? "";
    if (status === 401) return "Notion rejected NOTION_TOKEN (401). Copy the integration secret again.";
    if (status === 404 && /database/i.test(message)) {
      return "Notion database not found (404). Open the database, ... > Connections, and add your integration.";
    }
    return `Notion API ${status}: ${message || data?.code || "error"}`;
  }

  /** Read the database and add any missing columns. Returns the title column's name. */
  async ensureSchema() {
    if (this.titleProperty) return this.titleProperty;
    const db = await this.request("GET", `/v1/databases/${this.databaseId}`);
    const existing = db.properties ?? {};
    const title = Object.entries(existing).find(([, p]) => p.type === "title");
    if (!title) throw new NotionError("the Notion database has no title column");

    const missing = {};
    for (const [name, spec] of Object.entries(SCHEMA)) {
      const want = Object.keys(spec)[0];
      if (!existing[name]) {
        missing[name] = spec;
      } else if (existing[name].type !== want) {
        throw new NotionError(
          `Notion column "${name}" is a ${existing[name].type} column; this tracker writes a ${want} there. Rename or delete it.`,
        );
      }
    }
    if (Object.keys(missing).length) {
      await this.request("PATCH", `/v1/databases/${this.databaseId}`, { properties: missing });
    }
    this.titleProperty = title[0];
    this.addedColumns = Object.keys(missing);
    return this.titleProperty;
  }

  async create(rec, competitorName) {
    const title = await this.ensureSchema();
    const page = await this.request("POST", "/v1/pages", {
      parent: { database_id: this.databaseId },
      properties: pageProperties(rec, competitorName, title),
    });
    return page.id;
  }

  /** Returns false when the page was deleted in Notion (it is not recreated). */
  async update(pageId, rec) {
    try {
      await this.request("PATCH", `/v1/pages/${pageId}`, { properties: updateProperties(rec) });
      return true;
    } catch (err) {
      if (err instanceof NotionError && (err.status === 404 || /archived/i.test(err.message))) return false;
      throw err;
    }
  }
}
