/**
 * What has been seen and delivered, in one JSON file (state/ads.json by default).
 * The scheduled workflow commits it after each run, so the next run picks up where
 * this one stopped and the git history doubles as an ad timeline.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { emptyState } from "./process.js";

export const DEFAULT_STATE_PATH = "state/ads.json";

export class StateError extends Error {}

export function loadState(path = DEFAULT_STATE_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyState();
    throw new StateError(`cannot read ${path}: ${err.message}`);
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch (err) {
    throw new StateError(`${path} is not valid JSON (${err.message}). Fix it or delete it to start over.`);
  }
  if (!state || state.version !== 1 || typeof state.competitors !== "object") {
    throw new StateError(`${path} is not a competitor-ad-tracker state file (version 1)`);
  }
  return state;
}

/** Write atomically: a crash mid-write leaves the previous file intact. */
export function saveState(state, path = DEFAULT_STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
