import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig, normalizeConfig, slugify } from "../src/config.js";

const base = { competitors: [{ name: "Acme", meta_page_id: "1234567890" }] };

test("the shipped config.yml loads with every default filled in", () => {
  const config = loadConfig("config.yml");
  assert.equal(config.country, "US");
  assert.ok(config.competitors.length >= 1);
  for (const c of config.competitors) assert.ok(c.metaPageId || c.googleDomain || c.googleAdvertiser);
  assert.equal(config.meta.max_ads, 200);
  assert.equal(config.signals.long_running_days, 30);
});

test("defaults apply when sections are left out", () => {
  const config = normalizeConfig(base);
  assert.equal(config.country, "US");
  assert.equal(config.google.max_results, 100);
  assert.equal(config.signals.new_within_days, 7);
  assert.equal(config.delivery.max_items_per_competitor, 6);
  assert.deepEqual(config.competitors[0], {
    name: "Acme",
    key: "acme",
    metaPageId: "1234567890",
    googleDomain: "",
    googleAdvertiser: "",
  });
});

test("google_domain is reduced to a bare host", () => {
  const config = normalizeConfig({ competitors: [{ name: "Acme", google_domain: "https://Acme.com/pricing" }] });
  assert.equal(config.competitors[0].googleDomain, "acme.com");
});

test("a numeric meta_page_id written as a YAML number still works", () => {
  const config = normalizeConfig({ competitors: [{ name: "Acme", meta_page_id: 1234567890 }] });
  assert.equal(config.competitors[0].metaPageId, "1234567890");
});

test("bad values are rejected with a readable message", () => {
  const cases = [
    [{ competitors: [] }, /at least one/],
    [{ competitors: [{ name: "Acme" }] }, /meta_page_id, google_domain or google_advertiser/],
    [{ competitors: [{ name: "Acme", meta_page_id: "acme-page" }] }, /numeric Page ID/],
    [{ competitors: [{ name: "A", google_domain: "a.com", google_advertiser: "A" }] }, /not both/],
    [{ ...base, country: "USA" }, /2-letter/],
    [{ ...base, meta: { max_ads: 900 } }, /meta.max_ads/],
    [{ ...base, meta: { media_type: "gif" } }, /media_type/],
    [{ ...base, google: { platform: "search,tv" } }, /"tv"/],
    [{ ...base, signals: { stopped: "yes" } }, /true or false/],
    [{ competitors: [{ name: "Acme", meta_page_id: "123456" }, { name: "ACME", meta_page_id: "654321" }] }, /share the name/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => normalizeConfig(raw), (err) => err instanceof ConfigError && message.test(err.message));
  }
});

test("slugify gives stable state keys", () => {
  assert.equal(slugify("Wispr Flow"), "wispr-flow");
  assert.equal(slugify("  monday.com "), "monday-com");
  assert.equal(slugify("Café Été"), "cafe-ete");
});
