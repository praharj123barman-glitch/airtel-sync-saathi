/*
 * kb_promise_rules.mjs: writes the "activation promise" section of the knowledge base
 * (4_knowledge_base/saathi_bundles_and_rules.txt) from the pricing code itself (BUILD SCRIPT).
 *
 * Why: Saathi must never promise 72 hours to an order that doesn't qualify (STRATEGY.md §11). The rule lives in ONE
 * place, price_bundle's GUARANTEE_SCOPE and its injected firm activation days. This script loads the GENERATED
 * 3_function_tools/price_bundle.js (the file Voiceflow runs), writes the rule and the firm days from those values, and
 * decides the worked examples by calling its main(). A test (6_tests/run_function_tests.mjs) rebuilds the section and
 * fails if the knowledge base differs.
 *
 * How it fits: _build/gen_kit.py runs it after writing price_bundle.js: node _build/kb_promise_rules.mjs <kit dir>.
 * Only the text between the BEGIN and END marker lines is replaced; the rest of the file is written by hand.
 * Sample data: the firm days come from the case's synthetic leads (fictional operator).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPricingCode, readSection, replaceSection } from "./kb_sizing_rules.mjs";

// ================================================================ CONFIG

export const SECTION_BEGIN = "=== BEGIN GENERATED: ACTIVATION PROMISE ===";
export const SECTION_END = "=== END GENERATED: ACTIVATION PROMISE ===";
const KNOWLEDGE_BASE_FILE = path.join("4_knowledge_base", "saathi_bundles_and_rules.txt");
const PRICE_BUNDLE_FILE = path.join("3_function_tools", "price_bundle.js");
/** Owner-facing names of the connection types in the firm-days table (the "any" fallback is not listed). */
const CONNECTION_TYPE_LABEL = {
  fibre: "business fibre up to 300 Mbps",
  fibre_1g: "1 Gbps fibre",
  airfiber: "5G AirFiber",
  leased_line: "leased line",
};
const QUANTILE_IN_WORDS = "9 in 10";

/** Worked examples, decided by price_bundle itself. The same cases are tested in the test suite. */
const WORKED_EXAMPLES = [
  {
    label: "Kirana in Delhi, 3 people",
    inputs: { business_type: "Kirana store", city: "Delhi", employees: "3", has_gstin: "yes" },
  },
  {
    label: "Kirana in Delhi, 3 people, where a check shows no AirFiber coverage",
    inputs: {
      business_type: "Kirana store",
      city: "Delhi",
      employees: "3",
      has_gstin: "yes",
      airfiber_available: "no",
    },
  },
  {
    label: "Kirana in Lucknow, 3 people",
    inputs: { business_type: "Kirana store", city: "Lucknow", employees: "3", has_gstin: "no" },
  },
  {
    label: "Diagnostic lab in Delhi, 16 people",
    inputs: { business_type: "Diagnostic lab", city: "Delhi", employees: "16", has_gstin: "yes" },
  },
  {
    label: "8 restaurants in Mumbai, 71 people",
    inputs: { business_type: "Restaurant chain", city: "Mumbai", employees: "71", sites: "8", has_gstin: "yes" },
  },
  {
    label: "Textile unit in Surat, 85 people",
    inputs: { business_type: "Textile unit", city: "Surat", employees: "85", has_gstin: "yes" },
  },
];

// ================================================================ LOGIC

/** "a, b and c" (or "a, b or c" with lastWord "or"). */
function joinWords(words, lastWord) {
  return words.length < 2 ? words.join("") : words.slice(0, -1).join(", ") + " " + lastWord + " " + words.at(-1);
}

/** "Delhi, New Delhi and Mumbai": city names as written in the pricing code, capitalised. */
function listCities(cityNames) {
  return joinWords(
    cityNames.map((name) => name.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())),
    "and",
  );
}

/** "7 days for business fibre up to 300 Mbps; …" for one city tier. */
function describeFirmDays(firmDaysByType) {
  return Object.keys(CONNECTION_TYPE_LABEL)
    .filter((connectionType) => firmDaysByType[connectionType])
    .map((connectionType) => firmDaysByType[connectionType].days + " days on " + CONNECTION_TYPE_LABEL[connectionType])
    .join("; ");
}

/** Builds the whole generated section (marker lines included). */
export async function buildPromiseSection(priceBundleSource) {
  const pricing = readPricingCode(priceBundleSource);
  const scope = pricing.GUARANTEE_SCOPE;
  const products = pricing.PRODUCTS_BY_ID;
  const firmDays = pricing.ACTIVATION_PROMISE_DATA.firmDays;
  const tierCities = { 1: listCities(pricing.TIER_1_CITY_NAMES) };
  const lines = [
    SECTION_BEGIN,
    "(Written by _build/gen_kit.py from price_bundle's GUARANTEE_SCOPE and its firm activation days. Do not edit",
    "here: change _build/price_bundle.js or the firm-date rule in _build/gen_kit.py and rebuild. A test fails if this",
    "section and the pricing code differ.)",
    "",
    "ACTIVATION GUARANTEE (every quote shows exactly one; Saathi repeats the quote's promise and never another)",
    "- Connected means the internet connection and the business SIMs work. Other items (CCTV, a leased line, software)",
    "  follow the install time shown on the quote.",
    "- If we miss the promised time, month one is free: the whole first monthly bill is credited automatically.",
    "- The guarantee is fixed when the quote is made, and the order tracker counts down to exactly that promise.",
    "",
    `WHO GETS "CONNECTED IN ${scope.hours} HOURS, GUARANTEED" (all of these, checked when the quote is made)`,
    `- A tier-${scope.cityTiers.join("/")} city: ${tierCities[scope.cityTiers[0]]}.`,
    `- Up to ${scope.maxEmployees} people, on ${scope.maxSites === 1 ? "one site" : "up to " + scope.maxSites + " sites"}.`,
    `- The connection is ${joinWords(
      scope.connectionProductIds.map((productId) => products[productId].name),
      "or",
    )}.`,
    scope.requiresAirFiberCoverage
      ? `- 5G AirFiber covers the address: it connects the business first if the fibre install takes longer.`
      : "",
    "",
    `EVERYONE ELSE: A FIRM NUMBER OF DAYS, WITH THE SAME GUARANTEE`,
    `- The day by which ${QUANTILE_IN_WORDS} past orders with the same city tier and connection were live, never`,
    "  sooner than the catalogue's install time.",
    ...Object.keys(firmDays).map((tier) => `- Tier-${tier} city: ${describeFirmDays(firmDays[tier])}.`),
    "",
    "WORKED EXAMPLES (decided by price_bundle when this section was written)",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
  for (const example of WORKED_EXAMPLES) {
    const quote = (await pricing.main({ inputVars: Object.assign({ show_card: "no", lang: "en" }, example.inputs) }))
      .outputVars;
    if (quote.error) throw new Error("example failed: " + example.label + ": " + quote.error);
    const why = quote.promise_reasons ? " (" + quote.promise_reasons + ")" : "";
    lines.push(`- ${example.label}: ${quote.promise_text.replace(/^✅ /, "")}${why}.`);
  }
  lines.push(SECTION_END);
  return lines.join("\n");
}

/** The section as it stands in a knowledge-base text; "" if its markers are missing. */
export function readPromiseSection(knowledgeBaseText) {
  return readSection(knowledgeBaseText, SECTION_BEGIN, SECTION_END);
}

/** CLI: node _build/kb_promise_rules.mjs <kit dir> */
async function writeKnowledgeBase(kitDirectory) {
  const knowledgeBasePath = path.join(kitDirectory, KNOWLEDGE_BASE_FILE);
  const section = await buildPromiseSection(fs.readFileSync(path.join(kitDirectory, PRICE_BUNDLE_FILE), "utf8"));
  const updated = replaceSection(fs.readFileSync(knowledgeBasePath, "utf8"), section, SECTION_BEGIN, SECTION_END);
  fs.writeFileSync(knowledgeBasePath, updated, "utf8");
  console.log(
    "knowledge base: activation promise written from price_bundle (" + section.split("\n").length + " lines)",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error("Usage: node _build/kb_promise_rules.mjs <kit dir>");
    process.exit(1);
  }
  await writeKnowledgeBase(process.argv[2]);
}
