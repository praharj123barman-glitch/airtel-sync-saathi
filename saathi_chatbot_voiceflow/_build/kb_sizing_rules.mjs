/*
 * kb_sizing_rules.mjs: writes the "bundle sizing rules and examples" section of the knowledge base
 * (4_knowledge_base/saathi_bundles_and_rules.txt) from the pricing code itself (BUILD SCRIPT).
 *
 * Why: the knowledge base once said "about one line per 5 people" and "Biz Fibre 100 per site" while price_bundle used
 * a minimum of 2 lines and Biz Fibre 300 above 15 people per site. Now the pricing code is the single source of truth:
 * this script loads the GENERATED 3_function_tools/price_bundle.js (the file Voiceflow runs), reads its THRESHOLDS,
 * SIZING, PRODUCT ids and product catalogue, writes every sizing rule from those values, and prices the worked
 * examples by calling its main(). A test (6_tests/run_function_tests.mjs) rebuilds the section and fails if the
 * knowledge base differs.
 *
 * How it fits: _build/gen_kit.py runs it after writing price_bundle.js: node _build/kb_sizing_rules.mjs <kit dir>.
 * Only the text between the BEGIN and END marker lines is replaced; the rest of the file is written by hand.
 * Sample data: the catalogue and prices are the case's synthetic ones (fictional operator).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// ================================================================ CONFIG

export const SECTION_BEGIN = "=== BEGIN GENERATED: BUNDLE SIZING RULES AND EXAMPLES ===";
export const SECTION_END = "=== END GENERATED: BUNDLE SIZING RULES AND EXAMPLES ===";
const KNOWLEDGE_BASE_FILE = path.join("4_knowledge_base", "saathi_bundles_and_rules.txt");
const PRICE_BUNDLE_FILE = path.join("3_function_tools", "price_bundle.js");
/** The generated function's entry line; it is turned into a plain function so the file runs as a script. */
const ENTRY_LINE = "export default async function main(args) {";
const PERCENT = 100;

/** Worked examples, priced by price_bundle itself. The same cases are tested by number in the test suite. */
const WORKED_EXAMPLES = [
  {
    label: "Kirana in Lucknow, 2 people, no GSTIN, no fibre on the street",
    inputs: { business_type: "Kirana store", city: "Lucknow", employees: "2", has_gstin: "no", fibre_available: "no" },
  },
  {
    label: "Kirana, 3 people, wants billing",
    inputs: { business_type: "Kirana store", city: "Lucknow", employees: "3", has_gstin: "no", needs: "billing" },
  },
  {
    label: "Diagnostic lab in Delhi, 16 people",
    inputs: {
      business_type: "Diagnostic lab",
      city: "Delhi",
      employees: "16",
      has_gstin: "yes",
      needs: "failover, email, storage, security",
    },
  },
  {
    label: "8 restaurants in Mumbai, 71 people",
    inputs: { business_type: "Restaurant chain", city: "Mumbai", employees: "71", sites: "8", has_gstin: "yes" },
  },
  {
    label: "Textile unit in Surat, 85 people, machine monitoring",
    inputs: {
      business_type: "Textile unit",
      city: "Surat",
      employees: "85",
      has_gstin: "yes",
      needs: "machine monitoring",
    },
  },
];

// ================================================================ LOGIC

/**
 * Runs the generated price_bundle.js as a script and hands back the objects its pricing uses.
 * @param {string} priceBundleSource text of 3_function_tools/price_bundle.js
 * @returns {{ main, THRESHOLDS, SIZING, PRODUCT, PRODUCTS_BY_ID, BUNDLE_NAME_BY_SEGMENT, formatRupees,
 *   GUARANTEE_SCOPE, PROMISE_TYPE, AIRFIBER_COVERAGE_CITY_NAMES, TIER_1_CITY_NAMES, ACTIVATION_PROMISE_DATA }}
 *   (the promise objects are read by _build/kb_promise_rules.mjs)
 */
export function readPricingCode(priceBundleSource) {
  if (priceBundleSource.indexOf(ENTRY_LINE) < 0) throw new Error("price_bundle.js entry point not found");
  const sandbox = { captured: null };
  const script =
    priceBundleSource.replace(ENTRY_LINE, "async function main(args) {") +
    "\ncaptured = { main, THRESHOLDS, SIZING, PRODUCT, PRODUCTS_BY_ID, BUNDLE_NAME_BY_SEGMENT, formatRupees," +
    " GUARANTEE_SCOPE, PROMISE_TYPE, AIRFIBER_COVERAGE_CITY_NAMES, TIER_1_CITY_NAMES, ACTIVATION_PROMISE_DATA };\n";
  vm.runInNewContext(script, sandbox);
  return sandbox.captured;
}

/** Builds the whole generated section (marker lines included). */
export async function buildSizingSection(priceBundleSource) {
  const pricing = readPricingCode(priceBundleSource);
  const { THRESHOLDS: limits, SIZING: sizing, PRODUCT: id, PRODUCTS_BY_ID: products, formatRupees } = pricing;
  const name = (productId) => products[productId].name;
  const monthly = (productId) => formatRupees(products[productId].monthlyPriceFloorInRupees) + "/month";
  const withSetup = (productId) =>
    products[productId].oneTimeSetupInRupees > 0
      ? monthly(productId) + ", " + formatRupees(products[productId].oneTimeSetupInRupees) + " setup"
      : monthly(productId);
  const priced = (productId) => name(productId) + " (" + withSetup(productId) + ")";
  const each = (productId, unitWord) =>
    name(productId) + " (" + formatRupees(products[productId].monthlyPriceFloorInRupees) + " per " + unitWord + ")";
  const percent = (share) => Math.round(share * PERCENT) + "%";
  /** "an active GSTIN and 10+ people" from the catalogue's requiresGstin and minimumEmployees for that product. */
  const whoCanBuy = (productId) =>
    (products[productId].requiresGstin ? "an active GSTIN and " : "") +
    products[productId].minimumEmployees +
    "+ people";
  const bundle = pricing.BUNDLE_NAME_BY_SEGMENT;

  const lines = [
    SECTION_BEGIN,
    "(Written by _build/gen_kit.py from price_bundle's THRESHOLDS, SIZING and product catalogue. Do not edit here:",
    "change _build/price_bundle.js and rebuild. A test fails if this section and the pricing code differ.)",
    "",
    "BUNDLE SIZING RULES (what price_bundle puts in each bundle; prices are the catalogue's monthly floor price)",
    "",
    `${bundle.micro.toUpperCase()} · micro retail and services`,
    `- Connection: ${priced(id.BIZ_FIBRE_100)}; ${priced(id.AIRFIBER_5G)} where fibre isn't available.`,
    `- Business lines: ${each(id.POSTPAID_299, "line")}: ${sizing.microLinesForTinyShop} for a team of up to ` +
      `${sizing.microMaxEmployeesForOneLine} people, otherwise ${sizing.microLinesOtherwise}.`,
    `- Only when asked: ${priced(id.CLOUD_POS)} per counter (${sizing.defaultCountersPerSite} per site unless told); ` +
      `${priced(id.CLOUD_CCTV)} per camera (${sizing.defaultCameras.other} unless told); ${priced(id.SECURE_WIFI)}; ` +
      `${priced(id.WHATSAPP_API)}; ${priced(id.WEBSITE_DOMAIN)}; ${priced(id.BUSINESS_SMS)}; cloud email (one user per ` +
      `person, at least ${sizing.minimumEmailUsersMicro}); endpoint security (one device per person, up to ` +
      `${sizing.maxSecuredDevicesOtherSegments}); ${priced(id.FAILOVER_4G_5G)}.`,
    "",
    `${bundle.prof.toUpperCase()} · professional offices`,
    `- Connection: ${priced(id.BIZ_FIBRE_100)} for teams of up to ${limits.maxEmployeesForBizFibre100InOffices} ` +
      `people, ${priced(id.BIZ_FIBRE_300)} for bigger teams; ${name(id.BIZ_FIBRE_1G)} when they ask for top speed and ` +
      `qualify; ${name(id.AIRFIBER_5G)} where fibre isn't available.`,
    `- ${priced(id.FAILOVER_4G_5G)}: included for teams of ${limits.officeTeamSizeForDefaultFailover} or more; for ` +
      `smaller teams only when asked.`,
    `- Business lines: ${each(id.POSTPAID_599, "line")}: one per ${sizing.employeesPerLine.prof} people, rounded, at ` +
      `least ${sizing.minLines.prof} and at most ${sizing.maxLines.prof}.`,
    `- ${each(id.CLOUD_EMAIL, "user")}: ${percent(sizing.emailShareOfStaff.prof)} of the team, rounded up, at least ` +
      `${sizing.minimumEmailUsers} users.`,
    `- ${each(id.ENDPOINT_SECURITY, "device")}: ${percent(sizing.securedDeviceShareOfStaff.prof)} of the team, ` +
      `rounded, at least ${sizing.minimumSecuredDevices.prof} devices.`,
    `- ${priced(id.CLOUD_BACKUP_1TB)}: one.`,
    `- When asked: ${priced(id.CLOUD_TELEPHONY)} per channel, one channel per ${sizing.employeesPerTelephonyChannel} ` +
      `people, ${sizing.minTelephonyChannels} to ${sizing.maxTelephonyChannels} channels; ${priced(id.STATIC_IP)}; ` +
      `${priced(id.BUSINESS_SMS)}; ${priced(id.TOLL_FREE_NUMBER)}.`,
    "",
    `${bundle.multi.toUpperCase()} · businesses with ${limits.sitesForMultiSite} or more sites`,
    `- At every site: ${priced(id.BIZ_FIBRE_100)}, or ${priced(id.BIZ_FIBRE_300)} when there are more than ` +
      `${limits.employeesPerSiteNeedingBizFibre300} people per site (${name(id.AIRFIBER_5G)} where fibre isn't ` +
      `available); ${priced(id.FAILOVER_4G_5G)}; ${priced(id.SECURE_WIFI)}; and for retail and food ` +
      `${priced(id.CLOUD_POS)}, ${sizing.defaultCountersPerSite} counter per site unless told.`,
    `- Business lines: ${each(id.POSTPAID_599, "line")}: one per ${sizing.employeesPerLine.multi} people, rounded, at ` +
      `least ${sizing.minLines.multi} and at most ${sizing.maxLines.multi}.`,
    `- One ${priced(id.TOLL_FREE_NUMBER)}` +
      (products[id.TOLL_FREE_NUMBER].requiresGstin ? " (needs an active GSTIN)." : "."),
    `- When asked: ${priced(id.CLOUD_CCTV)} per camera, ${sizing.multiSiteCamerasPerSite} cameras per site, rounded; ` +
      `${priced(id.MANAGED_SD_WAN)} per site; cloud email (${percent(sizing.emailShareOfStaff.multi)} of the team, ` +
      `at least ${sizing.minimumEmailUsers} users); ${priced(id.FLEET_TRACKER)} per vehicle ` +
      `(${sizing.defaultVehicles} unless told).`,
    "",
    `${bundle.mfg.toUpperCase()} · small manufacturers`,
    `- Connection: ${priced(id.LEASED_LINE_20)} for businesses with ${whoCanBuy(id.LEASED_LINE_20)}; ` +
      `otherwise ${name(id.BIZ_FIBRE_1G)} or ` +
      `${name(id.BIZ_FIBRE_300)}, with ${name(id.FAILOVER_4G_5G)}. ${priced(id.LEASED_LINE_100)} when they ask for ` +
      `speed and have ${limits.employeesForLeasedLine100}+ people.`,
    `- ${priced(id.MANAGED_FIREWALL)}: one, where allowed (${whoCanBuy(id.MANAGED_FIREWALL)}).`,
    `- Business lines: ${each(id.POSTPAID_599, "line")}: one per ${sizing.employeesPerLine.mfg} people, rounded, at ` +
      `least ${sizing.minLines.mfg} and at most ${sizing.maxLines.mfg}.`,
    `- Cloud email: ${percent(sizing.emailShareOfStaff.mfg)} of the team, rounded, at least ` +
      `${sizing.minimumEmailUsers} users.`,
    `- When asked: ${priced(id.MACHINE_IOT)} per sensor (${sizing.defaultMachines} unless told); endpoint security ` +
      `(${percent(sizing.securedDeviceShareOfStaff.mfg)} of the team, at least ${sizing.minimumSecuredDevices.mfg} ` +
      `devices); Cloud CCTV (${sizing.defaultCameras.mfg} cameras unless told); fleet trackers; static IP.`,
    "",
    "WHEN NOBODY SAYS HOW BIG THE TEAM IS",
    `- price_bundle assumes ${sizing.defaultEmployeesBySegment.micro} people for a shop, ` +
      `${sizing.defaultEmployeesBySegment.prof} for an office, ${sizing.defaultEmployeesBySegment.multi} for a chain ` +
      `and ${sizing.defaultEmployeesBySegment.mfg} for a factory. (GSTIN-first onboarding instead quotes the smallest ` +
      "team of the segment and says so.)",
    "",
    "WORKED EXAMPLES (priced by price_bundle when this section was written)",
  ];
  for (const example of WORKED_EXAMPLES) {
    const quote = (await pricing.main({ inputVars: Object.assign({ show_card: "no", lang: "en" }, example.inputs) }))
      .outputVars;
    if (quote.error) throw new Error("example failed: " + example.label + ": " + quote.error);
    const items = JSON.parse(quote.items_json)
      .map((item) => item.name + (item.qty > 1 ? " ×" + item.qty : ""))
      .join(", ");
    const setup = quote.setup_total > 0 ? ", " + formatRupees(quote.setup_total) + " one-time" : "";
    lines.push(
      `- ${example.label}: ${quote.bundle_name}, ${formatRupees(quote.monthly_total)}/month${setup}, ` +
        `${quote.contract_months}-month plan, live in about ${quote.install_days} days. Items: ${items}.`,
    );
  }
  lines.push(SECTION_END);
  return lines.join("\n");
}

/**
 * A generated section as it stands in a knowledge-base text (marker lines included); "" if the markers are missing.
 * The markers default to this file's sizing section; kb_promise_rules.mjs passes its own.
 */
export function readSection(knowledgeBaseText, begin = SECTION_BEGIN, end = SECTION_END) {
  const text = knowledgeBaseText.replace(/\r\n/g, "\n");
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if (start < 0 || finish < start) return "";
  return text.slice(start, finish + end.length);
}

/** Replaces the section between the markers; throws if the markers are missing, so nothing is written by mistake. */
export function replaceSection(knowledgeBaseText, section, begin = SECTION_BEGIN, end = SECTION_END) {
  const text = knowledgeBaseText.replace(/\r\n/g, "\n");
  const current = readSection(text, begin, end);
  if (!current) throw new Error("knowledge-base markers not found: " + begin);
  return text.replace(current, section);
}

/** CLI: node _build/kb_sizing_rules.mjs <kit dir> */
async function writeKnowledgeBase(kitDirectory) {
  const knowledgeBasePath = path.join(kitDirectory, KNOWLEDGE_BASE_FILE);
  const section = await buildSizingSection(fs.readFileSync(path.join(kitDirectory, PRICE_BUNDLE_FILE), "utf8"));
  fs.writeFileSync(knowledgeBasePath, replaceSection(fs.readFileSync(knowledgeBasePath, "utf8"), section), "utf8");
  console.log("knowledge base: sizing rules written from price_bundle (" + section.split("\n").length + " lines)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error("Usage: node _build/kb_sizing_rules.mjs <kit dir>");
    process.exit(1);
  }
  await writeKnowledgeBase(process.argv[2]);
}
