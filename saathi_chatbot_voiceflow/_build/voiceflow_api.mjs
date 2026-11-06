/*
 * voiceflow_api.mjs: a minimal client for Voiceflow's API (BUILD SCRIPT HELPER).
 *
 * What it does: reads the API key and project ID ONLY from the kit's .env file (never from the command line, never
 * printed, never written anywhere else) and sends authenticated requests to Voiceflow's realtime API. Errors carry the
 * method, path and Voiceflow's message, never the key.
 *
 * How it fits: _build/voiceflow_deploy.mjs (builds the agent from the project files) and
 * 6_tests/run_voiceflow_conversations.mjs (runs the test conversations) import it.
 * API reference: https://www.voiceflow.com/docs/llms.txt (checked 2026-11-07).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ================================================================ CONFIG

const KIT_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(KIT_DIRECTORY, ".env");
const API_BASE_URL = "https://realtime-api.voiceflow.com";
/** The environment the build writes to and the tests run against (every project has "main"). */
export const ENVIRONMENT_ALIAS = "main";
/** Keys .env must define. */
const REQUIRED_SETTINGS = ["VF_API_KEY", "VF_PROJECT_ID"];
/** Voiceflow rate-limits bursts; on HTTP 429 the client waits and retries this many times. */
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_WAIT_MS = 3000;
const HTTP_TOO_MANY_REQUESTS = 429;

// ================================================================ LOGIC

/** Reads KEY=value lines from .env. Throws (without values) if the file or a required key is missing. */
function readSettings() {
  if (!fs.existsSync(ENV_FILE)) throw new Error(".env not found in " + KIT_DIRECTORY);
  const settings = {};
  fs.readFileSync(ENV_FILE, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (match) settings[match[1]] = match[2];
    });
  const missing = REQUIRED_SETTINGS.filter((name) => !settings[name]);
  if (missing.length) throw new Error(".env is missing: " + missing.join(", "));
  return settings;
}

const SETTINGS = readSettings();
export const PROJECT_ID = SETTINGS.VF_PROJECT_ID;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Sends one request. path is like "/v2/stable/playbook"; projectID and environmentAlias are added as query
 * parameters unless query.noProject is set. Returns the parsed JSON body; throws on any non-2xx status.
 * @example await request("GET", "/v2/stable/agent")
 */
export async function request(method, apiPath, body, query = {}) {
  const url = new URL(API_BASE_URL + apiPath);
  const { noProject, ...extraQuery } = query;
  if (!noProject) {
    url.searchParams.set("projectID", PROJECT_ID);
    url.searchParams.set("environmentAlias", ENVIRONMENT_ALIAS);
  }
  Object.entries(extraQuery).forEach(([key, value]) => url.searchParams.set(key, value));
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: "Bearer " + SETTINGS.VF_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === HTTP_TOO_MANY_REQUESTS && attempt < RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_WAIT_MS * (attempt + 1));
      continue;
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      const error = new Error(`${method} ${apiPath} → HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 800)}`);
      error.status = response.status;
      error.body = parsed;
      throw error;
    }
    return parsed;
  }
}
