import assert from "node:assert/strict";
import { test } from "node:test";

import { main, parseCli } from "../bin/cli.js";
import { VERSION } from "../src/index.js";
import { fakeClient, fakeSink, metaRow, NOW, tempStatePath } from "./helpers.js";

function capture(fn) {
  return async () => {
    const out = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => out.push(a.join(" "));
    try {
      const code = await fn();
      return { code, out: out.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  };
}

test("parseCli: run is the default command; flags parse", () => {
  assert.deepEqual(parseCli([]), {
    command: "run",
    config: "config.yml",
    state: "state/ads.json",
    dryRun: false,
    only: null,
    version: false,
    help: false,
  });
  const opts = parseCli(["run", "--dry-run", "-c", "my.yml", "--state", "s.json", "--only", "Acme"]);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.config, "my.yml");
  assert.equal(opts.state, "s.json");
  assert.equal(opts.only, "Acme");
  assert.equal(parseCli(["check"]).command, "check");
  assert.equal(parseCli(["-n"]).dryRun, true);
});

test("parseCli rejects unknown commands and options", () => {
  assert.throws(() => parseCli(["scrape"]), /unknown command/);
  assert.throws(() => parseCli(["run", "--bogus"]));
});

test("--version and --help exit 0", async () => {
  const version = await capture(() => main(["--version"]))();
  assert.equal(version.code, 0);
  assert.equal(version.out, VERSION);
  const help = await capture(() => main(["--help"]))();
  assert.equal(help.code, 0);
  assert.match(help.out, /SCRAPEUNBLOCKER_KEY/);
});

test("a bad command exits 2 with the usage", async () => {
  const { code, out } = await capture(() => main(["nope"]))();
  assert.equal(code, 2);
  assert.match(out, /Usage:/);
});

test("run with the shipped config and a fake client exits 0 and delivers", async () => {
  const slack = fakeSink("slack", "slack");
  const { code, out } = await capture(() =>
    main(["run", "--state", tempStatePath()], {
      client: fakeClient({ meta: [metaRow(1)] }),
      destinations: { chat: [slack], notion: null },
      now: NOW,
    }),
  )();
  assert.equal(code, 0, out);
  assert.equal(slack.sent.length, 1);
  assert.match(slack.sent[0].digest, /\*Notion\* · now tracking/);
});

test("check validates the config without an API key", async () => {
  const { code, out } = await capture(() => main(["check"], { destinations: { chat: [], notion: null } }))();
  assert.equal(code, 0);
  assert.match(out, /config\.yml: OK/);
  assert.match(out, /Chat destinations: none/);
});
