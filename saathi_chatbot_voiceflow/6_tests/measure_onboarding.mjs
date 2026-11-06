/*
 * measure_onboarding.mjs: measures zero-question onboarding on every GSTIN in the case's mock registry.
 *
 * What it reports:
 *   - zero-question share: GSTINs whose first onboard_from_gstin call ends in a proposal (next_action = show_proposal)
 *   - how often the proposed segment and category are right (truth = the lead's business_type and segment)
 *   - overshoot: proposals whose first monthly total is HIGHER than price_bundle's total for the same bundle at the
 *     business's TRUE team size and site count, with no extras. A first quote should never be above that.
 *   - the same, for proposals made after the owner answers the one question truthfully (simulated from the lead)
 *   - extras in the total: proposals whose first total holds anything beyond the base bundle (should be 0)
 *   - Udyam entry (STRATEGY.md §12): for every lead WITHOUT a GSTIN, onboarding called with its Udyam number (if it has
 *     one): the share that gets a zero-question proposal, of the GSTIN-less leads and of those with a Udyam number,
 *     the share after one truthful answer, and how often the segment is right
 *
 * The zero-question share depends only on onboarding's confidence rules (threshold 0.7, unchanged by the sizing rule).
 * Truth comes from smb_leads.csv, joined to the registry by GSTIN: employee_count, num_sites, business_type, segment.
 *
 * How it fits: run after any change to onboarding sizing or inference; STRATEGY.md quotes its numbers. It only reads
 * the case data and calls the generated functions in 3_function_tools/ (the same files Voiceflow runs).
 *
 * Usage: node 6_tests/measure_onboarding.mjs "<path to YTL_TrackA_Udyam_Digital_Data>"
 * Sample data: the case pack is SYNTHETIC (fictional operator and businesses). Nothing personal is printed.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// ================================================================ CONFIG

/** The case's "today" (data README), so registration ages are the same on every run. */
const CASE_AS_OF_DATE = "2026-07-15";
const SEGMENT_CODE_BY_NAME = {
  "Micro retail & services": "micro",
  "Professional offices": "prof",
  "Small multi-site businesses": "multi",
  "Small manufacturers": "mfg",
};
/** The lead's business type → onboarding's category (for "category right"). */
const CATEGORY_BY_BUSINESS_TYPE = {
  "Kirana store": "kirana_retail",
  Bakery: "kirana_retail",
  "Bakery chain": "kirana_retail",
  Boutique: "kirana_retail",
  "Apparel retail chain": "kirana_retail",
  "Electronics retail chain": "kirana_retail",
  "Hardware store": "kirana_retail",
  "Mobile repair shop": "kirana_retail",
  Optician: "kirana_retail",
  Pharmacy: "kirana_retail",
  "Pharmacy chain": "kirana_retail",
  "Stationery shop": "kirana_retail",
  "Sweet shop": "kirana_retail",
  Salon: "other",
  "Restaurant chain": "restaurant",
  "Gym chain": "other",
  "Budget hotel group": "other",
  "Pre-school chain": "other",
  "Dental clinic": "clinic",
  "Diagnostic lab": "clinic",
  "Physiotherapy clinic": "clinic",
  "CA firm": "ca_firm",
  "Coaching centre": "coaching_centre",
  "Law office": "other",
  "Architecture studio": "other",
  "Insurance agency": "other",
  "Real estate agency": "other",
  "Travel agency": "other",
  "Auto-parts unit": "small_factory",
  "Food processing unit": "small_factory",
  "Furniture workshop": "small_factory",
  "Packaging unit": "small_factory",
  "Plastic moulding unit": "small_factory",
  "Printing press": "small_factory",
  "Textile unit": "small_factory",
};
/** The business-type buttons the owner would tap (English labels of onboarding's question). */
const BUSINESS_TYPE_BUTTON = {
  kirana_retail: "Shop / kirana",
  clinic: "Clinic or lab",
  ca_firm: "CA firm",
  coaching_centre: "Coaching centre",
  restaurant: "Restaurant",
  small_factory: "Small factory",
  other: "Other",
};
/** The locations buttons; the owner taps the one that contains their true site count. */
const SITES_BUTTON_LIMITS = [
  { max: 1, label: "1" },
  { max: 2, label: "2" },
  { max: 5, label: "3–5" },
  { max: 10, label: "6–10" },
  { max: Infinity, label: "10+" },
];
const MAX_TRUTHFUL_ANSWERS = 2;
const PERCENT = 100;

// ================================================================ LOGIC

/** Minimal CSV reader: quoted fields may hold commas, quotes ("") and line breaks. */
function readCsv(file) {
  const text = fs.readFileSync(file, "utf8");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (inQuotes) {
      if (character === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (character === '"') inQuotes = false;
      else field += character;
    } else if (character === '"') inQuotes = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) rows.push(row.concat(field));
  const header = rows.shift();
  return rows
    .filter((cells) => cells.length === header.length)
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]])));
}

const percentOf = (part, whole) => (whole ? ((PERCENT * part) / whole).toFixed(1) + "%" : "n/a");
const sitesButton = (siteCount) => SITES_BUTTON_LIMITS.find((limit) => siteCount <= limit.max).label;

/** price_bundle's total for the proposed bundle at the business's true size, with no extras. */
async function trueSizeTotal(priceBundle, proposal, truth) {
  const inputs = Object.assign(JSON.parse(proposal.pricing_inputs_json), {
    employees: truth.employee_count,
    sites: truth.num_sites,
    needs: "",
    show_card: "no",
  });
  return (await priceBundle({ inputVars: inputs })).outputVars.monthly_total;
}

function emptyOvershootTally() {
  return { proposals: 0, overshoots: 0, withExtras: 0, firstTotal: 0, trueTotal: 0, worst: null };
}

/** True when the first total holds anything beyond the base bundle (a need, or an add-on switched on). */
async function includesExtras(priceBundle, proposal) {
  const inputs = JSON.parse(proposal.pricing_inputs_json);
  const addons = JSON.parse(proposal.suggested_addons_json || "[]");
  const baseTotal = (await priceBundle({ inputVars: Object.assign({}, inputs, { needs: "" }) })).outputVars
    .monthly_total;
  return inputs.needs !== "" || addons.some((addon) => addon.included) || proposal.monthly_total !== baseTotal;
}

async function tallyOvershoot(tally, priceBundle, proposal, truth) {
  const atTrueSize = await trueSizeTotal(priceBundle, proposal, truth);
  if (await includesExtras(priceBundle, proposal)) tally.withExtras++;
  tally.proposals++;
  tally.firstTotal += proposal.monthly_total;
  tally.trueTotal += atTrueSize;
  if (proposal.monthly_total > atTrueSize) {
    tally.overshoots++;
    const excess = proposal.monthly_total - atTrueSize;
    if (!tally.worst || excess > tally.worst.excess) {
      tally.worst = { excess, first: proposal.monthly_total, atTrueSize, type: truth.business_type };
    }
  }
}

function printOvershoot(label, tally) {
  console.log(
    `${label}: ${tally.proposals} proposals · above the true-size price: ${tally.overshoots} (${percentOf(tally.overshoots, tally.proposals)})` +
      ` · with an extra in the total: ${tally.withExtras}` +
      ` · average first quote ₹${Math.round(tally.firstTotal / Math.max(tally.proposals, 1))}` +
      ` vs ₹${Math.round(tally.trueTotal / Math.max(tally.proposals, 1))} at true size`,
  );
  if (tally.worst) console.log("   largest overshoot:", JSON.stringify(tally.worst));
}

/**
 * Runs the measurement and prints the figures.
 * @param {string} dataDirectory the case data pack (smb_leads.csv, mock_gstin_registry.csv)
 */
async function main(dataDirectory) {
  const kitDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const load = async (name) =>
    (await import(pathToFileURL(path.join(kitDirectory, "3_function_tools", name)).href)).default;
  const onboard = await load("onboard_from_gstin.js");
  const priceBundle = await load("price_bundle.js");
  const leadByGstin = {};
  readCsv(path.join(dataDirectory, "smb_leads.csv")).forEach((lead) => {
    if (lead.gstin) leadByGstin[lead.gstin] = lead;
  });
  const registry = readCsv(path.join(dataDirectory, "mock_gstin_registry.csv"));

  const firstActions = {};
  let zeroQuestion = 0;
  let segmentRight = 0;
  let categoryRight = 0;
  let errors = 0;
  const firstQuotes = emptyOvershootTally();
  const quotesAfterAnswers = emptyOvershootTally();
  for (const record of registry) {
    const truth = leadByGstin[record.gstin];
    const baseInputs = {
      gstin: record.gstin,
      consent_given: "yes",
      lang: "en",
      as_of_date: CASE_AS_OF_DATE,
      show_card: "no",
    };
    let result = (await onboard({ inputVars: baseInputs })).outputVars;
    if (result.error) errors++;
    const actionKey = result.next_action + (result.question_type ? ":" + result.question_type : "");
    firstActions[actionKey] = (firstActions[actionKey] || 0) + 1;
    if (result.next_action === "show_proposal") {
      zeroQuestion++;
      if (result.segment_code === SEGMENT_CODE_BY_NAME[truth.segment]) segmentRight++;
      if (result.business_category === CATEGORY_BY_BUSINESS_TYPE[truth.business_type]) categoryRight++;
      await tallyOvershoot(firstQuotes, priceBundle, result, truth);
      continue;
    }
    const answers = {};
    for (let round = 0; round < MAX_TRUTHFUL_ANSWERS && result.next_action === "ask_question"; round++) {
      if (result.question_type === "business_type") {
        answers.answer_business_type = BUSINESS_TYPE_BUTTON[CATEGORY_BY_BUSINESS_TYPE[truth.business_type]];
      } else answers.answer_sites = sitesButton(Number(truth.num_sites));
      result = (await onboard({ inputVars: Object.assign({}, baseInputs, answers) })).outputVars;
    }
    if (result.next_action === "show_proposal") await tallyOvershoot(quotesAfterAnswers, priceBundle, result, truth);
  }

  console.log("GSTINs in the registry:", registry.length, "· errors:", errors);
  console.log("first call:", JSON.stringify(firstActions));
  console.log(
    `zero-question proposals: ${zeroQuestion} of ${registry.length} = ${percentOf(zeroQuestion, registry.length)}` +
      ` · segment right ${percentOf(segmentRight, zeroQuestion)} · category right ${percentOf(categoryRight, zeroQuestion)}`,
  );
  printOvershoot("first quotes (zero questions)", firstQuotes);
  printOvershoot("first quotes after one truthful answer", quotesAfterAnswers);
  await measureUdyamEntry(onboard, readCsv(path.join(dataDirectory, "smb_leads.csv")));
}

/**
 * Udyam entry for the leads without a GSTIN: onboarding with the lead's Udyam number (when it has one), first call and,
 * if a question comes back, the owner's truthful answer (simulated from the lead). Prints the shares.
 */
async function measureUdyamEntry(onboard, leads) {
  const withoutGstin = leads.filter((lead) => lead.has_gstin !== "Y");
  const withUdyam = withoutGstin.filter((lead) => lead.udyam_number);
  const firstActions = {};
  let zeroQuestion = 0;
  let segmentRight = 0;
  let afterOneAnswer = 0;
  let errors = 0;
  for (const lead of withUdyam) {
    const baseInputs = {
      udyam_number: lead.udyam_number,
      consent_given: "yes",
      lang: "en",
      as_of_date: CASE_AS_OF_DATE,
      show_card: "no",
    };
    let result = (await onboard({ inputVars: baseInputs })).outputVars;
    if (result.error) errors++;
    const actionKey = result.next_action + (result.question_type ? ":" + result.question_type : "");
    firstActions[actionKey] = (firstActions[actionKey] || 0) + 1;
    if (result.next_action === "show_proposal") {
      zeroQuestion++;
      if (result.segment_code === SEGMENT_CODE_BY_NAME[lead.segment]) segmentRight++;
      continue;
    }
    if (result.next_action !== "ask_question") continue;
    const answer =
      result.question_type === "business_type"
        ? { answer_business_type: BUSINESS_TYPE_BUTTON[CATEGORY_BY_BUSINESS_TYPE[lead.business_type]] }
        : { answer_sites: sitesButton(Number(lead.num_sites)) };
    result = (await onboard({ inputVars: Object.assign({}, baseInputs, answer) })).outputVars;
    if (result.next_action === "show_proposal") afterOneAnswer++;
  }
  console.log("\nUdyam entry (leads without a GSTIN)");
  console.log(
    `  leads without a GSTIN: ${withoutGstin.length} · with a Udyam number: ${withUdyam.length} ` +
      `(${percentOf(withUdyam.length, withoutGstin.length)}) · errors: ${errors}`,
  );
  console.log("  first call:", JSON.stringify(firstActions));
  console.log(
    `  zero-question proposals: ${zeroQuestion} = ${percentOf(zeroQuestion, withoutGstin.length)} of GSTIN-less leads, ` +
      `${percentOf(zeroQuestion, withUdyam.length)} of those with Udyam · segment right ` +
      percentOf(segmentRight, zeroQuestion),
  );
  console.log(
    `  proposal within one question: ${zeroQuestion + afterOneAnswer} = ` +
      `${percentOf(zeroQuestion + afterOneAnswer, withoutGstin.length)} of GSTIN-less leads`,
  );
}

if (!process.argv[2]) {
  console.error('Usage: node 6_tests/measure_onboarding.mjs "<path to YTL_TrackA_Udyam_Digital_Data>"');
  process.exit(1);
}
await main(process.argv[2]);
