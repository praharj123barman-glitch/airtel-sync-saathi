/*
 * scope.mjs: which lines of the generated function tools mutation testing changes, and how results are grouped.
 *
 * What it does: reads each file in 3_function_tools/ and finds its section markers ("// ===== CONFIG", "MESSAGES",
 * "LOGIC", "DATA") and the shared modules the build embeds ("(function embeddedX() {" … "return X;"). It returns
 * line ranges for Stryker (stryker.config.mjs) and region labels for the score report (summarise.mjs).
 *
 * The rules (why):
 *   - Each tool's own code is mutated: main(), CONFIG and LOGIC. MESSAGES sections are left alone: they are
 *     translations, checked for completeness by their own tests, not logic. DATA (the case registry, catalogue,
 *     model) is left alone: it is data from the case pack, not code.
 *   - A shared module is mutated once, in the tool whose tests exercise it most directly: the GSTIN reader in
 *     verify_gstin, consent_rules in consent_manager, promise_rules in order_status, reach_rules in reach_tag_lead.
 *   - price_bundle is mutated in price_bundle.js only, not in the copies embedded in other tools.
 *   - verify_gstin_lite.js is skipped: it is built from the same template as verify_gstin.js.
 */
import fs from "node:fs";
import path from "node:path";

// ================================================================ CONFIG

export const FUNCTION_TOOLS_DIRECTORY = "3_function_tools";
const SECTION_MARKER = /^\/\/ =+ (CONFIG|MESSAGES|LOGIC|DATA)/;
const SECTIONS_LEFT_ALONE = ["MESSAGES", "DATA"];

/** The tools mutated, and the shared modules each carries: the API name the build returns and the wrapper function. */
export const MUTATED_TOOLS = [
  { file: "price_bundle.js", sharedModules: [] },
  { file: "onboard_from_gstin.js", sharedModules: [] },
  {
    file: "verify_gstin.js",
    sharedModules: [
      { api: "GSTIN_INPUT_API", wrapper: "embeddedGSTIN_INPUT_API", label: "gstin_input (shared GSTIN reader)" },
    ],
  },
  {
    file: "consent_manager.js",
    sharedModules: [
      { api: "CONSENT_RULES_API", wrapper: "embeddedCONSENT_RULES_API", label: "consent_rules (shared)" },
    ],
  },
  {
    file: "order_status.js",
    sharedModules: [
      { api: "PROMISE_RULES_API", wrapper: "embeddedPROMISE_RULES_API", label: "promise_rules (shared)" },
    ],
  },
  { file: "downtime_credit.js", sharedModules: [] },
  { file: "bill_swap.js", sharedModules: [] },
  { file: "readiness_score.js", sharedModules: [] },
  {
    file: "reach_tag_lead.js",
    sharedModules: [{ api: "REACH_RULES_API", wrapper: "embeddedReachRules", label: "reach_rules (shared)" }],
  },
  { file: "register_lead.js", sharedModules: [] },
  { file: "verify_udyam.js", sharedModules: [] },
];

/** The core tools the review named: their worst surviving mutants get tests first. */
export const CORE_REGIONS = [
  "onboard_from_gstin",
  "price_bundle",
  "verify_gstin",
  "gstin_input (shared GSTIN reader)",
  "consent_manager",
  "consent_rules (shared)",
];

// ================================================================ LOGIC

/** Lines of [first, last] (1-based) that are code to mutate: everything except MESSAGES and DATA sections. */
function codeSpans(lines, first, last) {
  const spans = [];
  let spanStart = first;
  let leftAlone = false;
  for (let lineNumber = first; lineNumber <= last; lineNumber++) {
    const marker = lines[lineNumber - 1].match(SECTION_MARKER);
    if (!marker) continue;
    if (!leftAlone && lineNumber > spanStart) spans.push([spanStart, lineNumber - 1]);
    leftAlone = SECTIONS_LEFT_ALONE.includes(marker[1]);
    spanStart = lineNumber;
  }
  if (!leftAlone && last >= spanStart) spans.push([spanStart, last]);
  return spans;
}

/** Where an embedded shared module starts and ends in a generated file: the lines strictly inside its wrapper. */
function moduleBounds(lines, api, wrapper) {
  const start = lines.findIndex((line) => line.includes("(function " + wrapper + "() {"));
  const end = lines.findIndex((line, index) => index > start && line.trim() === `return ${api};`);
  if (start < 0 || end < 0) throw new Error(`embedded module ${api} not found`);
  return [start + 2, end];
}

/**
 * Regions of one tool file: [{ label, spans: [[startLine, endLine], …] }]. The tool's own code ends at its first
 * DATA marker; each shared module it carries is a region of its own.
 */
export function regionsOf(kitDirectory, tool) {
  const lines = fs.readFileSync(path.join(kitDirectory, FUNCTION_TOOLS_DIRECTORY, tool.file), "utf8").split(/\r?\n/);
  const firstData = lines.findIndex((line) => /^\/\/ =+ DATA/.test(line));
  const regions = [{ label: tool.file.replace(/\.js$/, ""), spans: codeSpans(lines, 1, firstData) }];
  for (const shared of tool.sharedModules) {
    const [first, last] = moduleBounds(lines, shared.api, shared.wrapper);
    regions.push({ label: shared.label, spans: codeSpans(lines, first, last) });
  }
  return regions;
}

/** Stryker "mutate" entries: one "file:start-end" per span. */
export function strykerMutateEntries(kitDirectory) {
  return MUTATED_TOOLS.flatMap((tool) =>
    regionsOf(kitDirectory, tool).flatMap((region) =>
      region.spans.map(([start, end]) => `${FUNCTION_TOOLS_DIRECTORY}/${tool.file}:${start}-${end}`),
    ),
  );
}
