/*
 * run_function_tests.mjs: tests for the Voiceflow function tools in 3_function_tools/.
 *
 * How it fits: runs each generated function exactly the way Voiceflow does (main({ inputVars })) and checks the
 * results against the numbers in the submission deck and the case rules. Run with `npm test` (Node 18+).
 *
 * Sample data: every business, GSTIN, Udyam number and order here is SYNTHETIC, taken from the case's data pack
 * (fictional operator, identifiers that cannot match real taxpayers). Phone numbers are never used.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
/** Name of each loaded function tool, so a failing call can say which tool it was. */
const TOOL_NAME = new Map();
const loadFunctionTool = async (fileName) => {
  const tool = (await import(pathToFileURL(path.join(testDirectory, "..", "3_function_tools", fileName)).href)).default;
  TOOL_NAME.set(tool, fileName.replace(/\.js$/, ""));
  return tool;
};
/**
 * --mutation-run is set by Stryker (stryker.config.mjs): stop at the first failure (a killed mutant needs no more
 * tests), and skip the few checks that read generated SOURCE TEXT, which Stryker rewrites while instrumenting.
 */
const IS_MUTATION_RUN = process.argv.includes("--mutation-run");

const priceBundle = await loadFunctionTool("price_bundle.js");
const verifyGstin = await loadFunctionTool("verify_gstin.js");
const verifyGstinLite = await loadFunctionTool("verify_gstin_lite.js");
const verifyUdyam = await loadFunctionTool("verify_udyam.js");
const registerLead = await loadFunctionTool("register_lead.js");
const orderStatus = await loadFunctionTool("order_status.js");
const onboardFromGstin = await loadFunctionTool("onboard_from_gstin.js");
const billSwap = await loadFunctionTool("bill_swap.js");
const readinessScore = await loadFunctionTool("readiness_score.js");
const reachTagLead = await loadFunctionTool("reach_tag_lead.js");
/** price_bundle's own THRESHOLDS, SIZING and catalogue, read from the generated file (see _build/kb_sizing_rules.mjs). */
const kbSizing = await import(pathToFileURL(path.join(testDirectory, "..", "_build", "kb_sizing_rules.mjs")).href);
const priceBundleSource = fs.readFileSync(
  path.join(testDirectory, "..", "3_function_tools", "price_bundle.js"),
  "utf8",
);
const pricingCode = kbSizing.readPricingCode(priceBundleSource);

let passedCount = 0;
let failedCount = 0;

/** Records one test. `detail` is printed only when the test fails. */
function test(name, passed, detail) {
  if (passed) {
    passedCount++;
    console.log("  ✔ " + name);
  } else {
    failedCount++;
    console.log("  ✘ " + name + (detail ? "  →  " + detail : ""));
    if (IS_MUTATION_RUN) process.exit(1);
  }
}

/** A check that reads generated source text: skipped in mutation runs (see IS_MUTATION_RUN), run everywhere else. */
function sourceTextTest(name, passed, detail) {
  if (IS_MUTATION_RUN) {
    console.log("  - skipped in a mutation run: " + name);
    return;
  }
  test(name, passed, detail);
}

let checkedCalls = 0;
let callsThatErrored = 0;
let callsExpectedToError = 0;
/** Fails the suite when a call that should succeed returned an error, naming the tool and its inputs. */
function expectNoError(toolName, inputVars, outputVars) {
  checkedCalls++;
  if (outputVars && outputVars.error === "") return;
  callsThatErrored++;
  test(
    `${toolName} returns no error for ${JSON.stringify(inputVars).slice(0, 140)}`,
    false,
    outputVars ? outputVars.error : "no outputVars at all",
  );
}
/**
 * Runs a function tool the way Voiceflow does. Every call here is a call that should succeed, so its `error` output
 * must be empty: a crash (which returns empty defaults plus an error) can never pass a test by accident.
 */
const runTool = async (functionTool, inputVars) => {
  const result = await functionTool({ inputVars });
  expectNoError(TOOL_NAME.get(functionTool), inputVars, result.outputVars);
  return result;
};
/** For the few tests about bad input, where an error IS the right answer (the test then asserts it). */
const runToolExpectingError = async (functionTool, inputVars) => {
  callsExpectedToError++;
  return functionTool({ inputVars });
};
/** Parsed JSON output, or null when a broken tool returned none: the test then fails instead of stopping the run. */
function parseOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
/** A readable certificate photo: big enough to read, and printed text (some dark pixels, mostly page). */
const READABLE_CERTIFICATE = { minWidth: 800, minHeight: 500, minInkShare: 0.005, maxInkShare: 0.3 };
/** Pixels darker than this (0–255) count as ink; the SAMPLE watermark (238) is not ink. */
const INK_LEVEL = 128;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BYTES_PER_PIXEL = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decodes an 8-bit PNG into greyscale pixels (Node's zlib, no extra packages): checks the signature, inflates the
 * image data and undoes the per-row filters. Returns { width, height, pixels } or null if it isn't a usable PNG.
 */
function readPngGreyscale(bytes) {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    return null;
  let offset = PNG_SIGNATURE.length;
  let header = null;
  const imageData = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR")
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colour: data[9] };
    if (type === "IDAT") imageData.push(data);
    offset += 12 + length;
  }
  if (!header || header.depth !== 8 || !PNG_BYTES_PER_PIXEL[header.colour] || !imageData.length) return null;
  const raw = zlib.inflateSync(Buffer.concat(imageData));
  const step = PNG_BYTES_PER_PIXEL[header.colour];
  const stride = header.width * step;
  const rows = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row++) {
    const filter = raw[row * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[row * (stride + 1) + 1 + i];
      const left = i >= step ? rows[row * stride + i - step] : 0;
      const up = row > 0 ? rows[(row - 1) * stride + i] : 0;
      const upLeft = row > 0 && i >= step ? rows[(row - 1) * stride + i - step] : 0;
      const estimate = left + up - upLeft;
      const paeth =
        Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - upLeft)
          ? left
          : Math.abs(estimate - up) <= Math.abs(estimate - upLeft)
            ? up
            : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      rows[row * stride + i] = (value + predictor) & 0xff;
    }
  }
  const pixels = new Uint8Array(header.width * header.height);
  for (let p = 0; p < pixels.length; p++) pixels[p] = rows[p * step];
  return { width: header.width, height: header.height, pixels };
}

/** Share of pixels darker than INK_LEVEL. */
function inkShare(image) {
  let dark = 0;
  for (const pixel of image.pixels) if (pixel < INK_LEVEL) dark++;
  return dark / image.pixels.length;
}

const indent = (text) =>
  String(text)
    .split("\n")
    .map((line) => "      " + line)
    .join("\n");

// ---------------------------------------------------------------- price_bundle
console.log("\nprice_bundle");
let result = await runTool(priceBundle, {
  business_type: "Diagnostic lab",
  city: "Delhi",
  employees: "16",
  sites: "1",
  has_gstin: "yes",
  needs: "failover, email, storage, security",
  lang: "hi",
});
test(
  "recommends Office Pro at ₹6,138 a month for a 16-person diagnostic lab in Delhi",
  result.outputVars.bundle_name === "Office Pro" && result.outputVars.monthly_total === 6138,
  result.outputVars.quote_text,
);
test(
  "quotes ₹1,500 setup, a 12-month plan and about 5 days to go live for that lab",
  result.outputVars.setup_total === 1500 &&
    result.outputVars.contract_months === 12 &&
    result.outputVars.install_days === 5,
  JSON.stringify(result.outputVars),
);
test(
  "shows the quote card in Hindi when the conversation is in Hindi",
  result.trace.length === 1 && result.trace[0].payload.message.includes("/माह"),
);
console.log(indent(result.outputVars.quote_text) + "\n" + indent(result.outputVars.why_text));

result = await runTool(priceBundle, {
  business_type: "Kirana store",
  city: "Lucknow",
  employees: "2",
  has_gstin: "no",
  fibre_available: "no",
  lang: "en",
});
test(
  "offers 5G AirFiber plus one line at ₹1,198 on a 6-month plan when a small kirana has no fibre",
  result.outputVars.monthly_total === 1198 && result.outputVars.contract_months === 6,
  result.outputVars.quote_text,
);

result = await runTool(priceBundle, {
  business_type: "Kirana store",
  city: "Lucknow",
  employees: "2",
  has_gstin: "no",
  fibre_available: "no",
  budget: "1000",
  lang: "en",
});
test(
  "says the lowest possible price is ₹1,198 instead of inventing a discount when the budget is below the essentials",
  result.outputVars.monthly_total === 1198 && /Lowest possible: ₹1,198/.test(result.outputVars.budget_note),
  result.outputVars.budget_note,
);

result = await runTool(priceBundle, {
  business_type: "Kirana store",
  city: "Lucknow",
  employees: "3",
  has_gstin: "no",
  needs: "billing",
  lang: "en",
});
test(
  "quotes fibre, two lines and Cloud POS at ₹2,196 for a 3-person kirana that needs billing",
  result.outputVars.monthly_total === 2196,
  result.outputVars.quote_text,
);

result = await runTool(priceBundle, {
  business_type: "Salon",
  city: "Pune",
  employees: "4",
  has_gstin: "no",
  needs: "whatsapp catalogue, cctv",
  lang: "en",
});
test(
  "blocks the WhatsApp Business API and says why when the business has no GSTIN",
  /WhatsApp Business API Starter \(needs an active GSTIN\)/.test(result.outputVars.blocked_text),
  result.outputVars.blocked_text,
);
const salonItems = JSON.parse(result.outputVars.items_json);
const salonCctv = salonItems.find((item) => item.id === pricingCode.PRODUCT.CLOUD_CCTV);
const cctvProduct = pricingCode.PRODUCTS_BY_ID[pricingCode.PRODUCT.CLOUD_CCTV];
const salonCameras = pricingCode.SIZING.defaultCameras.other;
test(
  "still adds CCTV for that salon: the default camera count, priced at the catalogue floor, and counted in the totals",
  result.outputVars.error === "" &&
    !!salonCctv &&
    salonCctv.qty === salonCameras &&
    salonCctv.monthly === salonCameras * cctvProduct.monthlyPriceFloorInRupees &&
    result.outputVars.monthly_total === salonItems.reduce((sum, item) => sum + item.monthly, 0) &&
    result.outputVars.setup_total >= salonCameras * cctvProduct.oneTimeSetupInRupees,
  result.outputVars.items_json,
);

result = await runTool(priceBundle, {
  business_type: "Restaurant chain",
  city: "Mumbai",
  employees: "71",
  sites: "8",
  has_gstin: "yes",
  lang: "en",
});
test(
  "recommends Chain Connect at ₹23,864 a month for 8 restaurants",
  result.outputVars.bundle_name === "Chain Connect" && result.outputVars.monthly_total === 23864,
  result.outputVars.quote_text,
);

result = await runTool(priceBundle, {
  business_type: "Textile unit",
  city: "Surat",
  employees: "85",
  has_gstin: "yes",
  needs: "machine monitoring",
  lang: "en",
});
test(
  "recommends Factory Assured at ₹15,260 with a leased line, firewall and 10 machine sensors",
  result.outputVars.monthly_total === 15260 && result.outputVars.items_json.includes("P05"),
  result.outputVars.quote_text,
);
test(
  "takes the install time from the leased line (21 days) and uses a 24-month plan",
  result.outputVars.install_days === 21 && result.outputVars.contract_months === 24,
  JSON.stringify(result.outputVars),
);

result = await runTool(priceBundle, {
  business_type: "Textile unit",
  city: "Surat",
  employees: "85",
  has_gstin: "no",
  lang: "en",
});
test(
  "falls back to Biz Fibre 300 with failover, without leased line or firewall, when a factory has no GSTIN",
  result.outputVars.items_json.includes("P02") &&
    !result.outputVars.items_json.includes("P05") &&
    /Managed Firewall/.test(result.outputVars.blocked_text),
  result.outputVars.quote_text,
);

result = await runTool(priceBundle, {
  business_type: "CA firm",
  city: "Jaipur",
  employees: "10",
  has_gstin: "yes",
  budget: "4000",
  lang: "en",
});
test(
  "trims the bundle to fit a ₹4,000 budget and says what was removed",
  result.outputVars.monthly_total <= 4000 && /removed/.test(result.outputVars.budget_note),
  result.outputVars.quote_text,
);

result = await runTool(priceBundle, {
  business_type: "CA firm",
  city: "Jaipur",
  employees: "10",
  has_gstin: "yes",
  add: "static ip, cloud telephony 3",
  remove: "cloud backup",
  lang: "en",
});
test(
  "adds a static IP and 3 telephony channels and removes cloud backup when the owner asks",
  result.outputVars.items_json.includes("P11") &&
    /"P12","name":"Cloud Telephony \/ SIP","qty":3/.test(result.outputVars.items_json) &&
    !result.outputVars.items_json.includes("P17"),
  result.outputVars.items_json,
);

result = await runTool(priceBundle, {
  business_type: "Architecture studio",
  city: "Jaipur",
  employees: "8",
  has_gstin: "yes",
  needs: "1 gbps",
  lang: "en",
});
test(
  "offers Biz Fibre 300 instead of 1 Gbps fibre in a tier-2 city like Jaipur",
  result.outputVars.items_json.includes("P02") && !result.outputVars.items_json.includes("P03"),
  result.outputVars.items_json,
);

result = await runTool(priceBundle, {});
test(
  "returns a safe default quote instead of crashing when no input is given",
  result.outputVars.error === "" && result.outputVars.monthly_total > 0,
  JSON.stringify(result.outputVars),
);

// ---------------------------------------------------------------- verify_gstin
console.log("\nverify_gstin");
result = await runTool(verifyGstin, {
  consent_given: "yes",
  gstin: "07PUTXM1153M1Z9",
  business_name: "Metro Diagnostics",
  lang: "en",
});
test(
  "verifies an active GSTIN, masks it and matches the business name",
  result.outputVars.gstin_ok === true &&
    result.outputVars.gstin_masked === "07PUT•••••••1Z9" &&
    result.outputVars.name_match === "match",
  JSON.stringify(result.outputVars),
);
result = await runTool(verifyGstin, {
  consent_given: "yes",
  gstin: "29OKAXP4077P1ZL",
  business_name: "Prime General Store",
  lang: "hi",
});
test(
  "blocks activation when the GSTIN is cancelled, explaining in Hindi",
  result.outputVars.gstin_ok === false &&
    result.outputVars.gstin_status === "Cancelled" &&
    /रद्द/.test(result.outputVars.kyc_message),
  result.outputVars.kyc_message,
);
result = await runTool(verifyGstin, { consent_given: "yes", gstin: "23QYBXS1811Q1ZD", lang: "en" });
test(
  "blocks activation when the GSTIN is suspended",
  result.outputVars.gstin_status === "Suspended" && !result.outputVars.gstin_ok,
  result.outputVars.kyc_message,
);
result = await runTool(verifyGstin, { consent_given: "yes", gstin: "07PUTXM1153M1Z8", lang: "en" });
test(
  "catches a typo with the checksum",
  result.outputVars.gstin_status === "CHECKSUM_FAILED",
  result.outputVars.kyc_message,
);
result = await runTool(verifyGstin, { consent_given: "yes", gstin: "07PUTXM1153", lang: "en" });
test("asks the owner to re-check a GSTIN that is too short", result.outputVars.gstin_status === "INVALID_FORMAT");
result = await runTool(verifyGstin, { consent_given: "yes", gstin: "07 putxm 1153 m1z9", lang: "en" });
test("accepts a GSTIN typed with spaces and lower-case letters", result.outputVars.gstin_ok === true);
result = await runTool(verifyGstinLite, { consent_given: "yes", gstin: "29OKAXP4077P1ZL", lang: "en" });
test(
  "still blocks the cancelled GSTIN in the lite build",
  result.outputVars.gstin_status === "Cancelled" && !result.outputVars.gstin_ok,
  JSON.stringify(result.outputVars),
);
result = await runTool(verifyGstinLite, { consent_given: "yes", gstin: "07PUTXM1153M1Z9", lang: "en" });
test(
  "passes a valid active GSTIN on format and checksum in the lite build",
  result.outputVars.gstin_ok === true && result.outputVars.gstin_status === "FORMAT_OK",
  JSON.stringify(result.outputVars),
);

// ---------------------------------------------------------------- verify_udyam
console.log("\nverify_udyam");
result = await runTool(verifyUdyam, {
  udyam_number: "UDYAM-DL-00-7084760",
  business_name: "Metro Diagnostics Pvt Ltd",
  lang: "en",
});
test(
  "verifies a Udyam number and masks it",
  result.outputVars.udyam_ok === true && result.outputVars.udyam_masked === "UDYAM-DL-••-•••4760",
  JSON.stringify(result.outputVars),
);
result = await runTool(verifyUdyam, { udyam_number: "udyam dl 00 7084760", lang: "en" });
test("accepts a Udyam number typed without dashes", result.outputVars.udyam_ok === true);
result = await runTool(verifyUdyam, { udyam_number: "UDYAM-DL-00-0000001", lang: "en" });
test(
  "lets the owner continue when the Udyam number isn't in the registry, because it's optional",
  result.outputVars.udyam_ok === false && /optional/.test(result.outputVars.kyc_message),
);

// ---------------------------------------------------------------- register_lead
console.log("\nregister_lead");
const officeLead = await runTool(registerLead, {
  segment: "prof",
  business_type: "Diagnostic lab",
  city: "Delhi",
  language: "hi",
  employees: "16",
  sites: "1",
  has_gstin: "yes",
  has_udyam: "yes",
  current_provider: "Accel mobile",
  install_days: "5",
});
const kiranaLead = await runTool(registerLead, {
  segment: "micro",
  business_type: "Kirana store",
  city: "Patna",
  language: "ta",
  employees: "2",
  has_gstin: "no",
  has_udyam: "no",
  current_internet: "mobile hotspot",
  install_days: "2",
});
test(
  "scores a GST-registered office higher than a non-GST micro shop",
  officeLead.outputVars.lead_score > kiranaLead.outputVars.lead_score,
  officeLead.outputVars.lead_score + " vs " + kiranaLead.outputVars.lead_score,
);
test(
  "fills the priority, reference ID and go-live date",
  /^(Hot|Warm|Cold)$/.test(officeLead.outputVars.priority) &&
    /^SA-/.test(officeLead.outputVars.ref_id) &&
    officeLead.outputVars.expected_live_date.length > 8,
  JSON.stringify(officeLead.outputVars),
);
console.log("  office:", JSON.stringify(officeLead.outputVars), "\n  kirana:", JSON.stringify(kiranaLead.outputVars));

// ---------------------------------------------------------------- order_status
console.log("\norder_status");
result = await runTool(orderStatus, { order_id: "ud0068", lang: "en" });
test(
  "finds a demo order and shows its timeline",
  result.outputVars.order_found && result.trace[0].payload.message.includes("Installer visit"),
);
console.log(indent(result.outputVars.tracker_text));
result = await runTool(orderStatus, { order_id: "UD-9999", lang: "hi" });
test(
  "explains in Hindi when an order number is unknown",
  !result.outputVars.order_found && /नहीं मिला/.test(result.outputVars.tracker_text),
);

// ---------------------------------------------------------------- onboard_from_gstin
// as_of_date is fixed to the case's "today" (2026-07-15, data README) so registration ages are reproducible.
console.log("\nonboard_from_gstin");
const CASE_TODAY = "2026-07-15";
const onboard = (inputVars) =>
  runTool(onboardFromGstin, { consent_given: "yes", lang: "en", as_of_date: CASE_TODAY, ...inputVars });

// Valid, active GSTIN with a Udyam business type: zero questions, proposal first.
result = await onboard({ gstin: "07PUTXM1153M1Z9" });
let outputs = result.outputVars;
test(
  "proposes a bundle straight from a valid active GSTIN without asking anything",
  outputs.gstin_valid &&
    outputs.gstin_status === "Active" &&
    outputs.next_action === "show_proposal" &&
    outputs.clarifying_question === "",
  JSON.stringify(outputs),
);
test(
  "reads the business name, location and registration age from the registry",
  outputs.business_name === "Metro Diagnostics Pvt Ltd" &&
    outputs.gst_city === "Delhi" &&
    outputs.gst_state === "Delhi" &&
    outputs.city_tier === 1 &&
    outputs.registration_age_years > 0,
  JSON.stringify(outputs),
);
test(
  "infers a clinic with high confidence and names the registry fields it used",
  outputs.business_category === "clinic" &&
    outputs.segment_code === "prof" &&
    outputs.segment_confidence >= 0.9 &&
    /udyam\.nic_description/.test(outputs.evidence_fields) &&
    /gst\.trade_name/.test(outputs.evidence_fields),
  outputs.evidence_fields,
);
const pricedDirectly = await runTool(priceBundle, JSON.parse(outputs.pricing_inputs_json));
test(
  "takes the bundle and price from price_bundle itself (same inputs give the same quote)",
  outputs.bundle_name === "Office Pro" &&
    outputs.monthly_total === pricedDirectly.outputVars.monthly_total &&
    outputs.quote_text === pricedDirectly.outputVars.quote_text,
  outputs.monthly_total + " vs " + pricedDirectly.outputVars.monthly_total,
);
test(
  "pre-approves an active registration that is years old, with a one-line reason",
  outputs.pre_approved === true &&
    /^Pre-approved: /.test(outputs.pre_approval_reason) &&
    !/\n/.test(outputs.pre_approval_reason),
  outputs.pre_approval_reason,
);
test(
  "greets with the proposal and the stated assumptions, showing the quote card after it",
  /Namaste! I found Metro Diagnostics Pvt Ltd, Delhi/.test(outputs.greeting) &&
    outputs.greeting.includes("Office Pro: ₹" + outputs.monthly_total.toLocaleString("en-IN")) &&
    /Tell me if you're bigger or anything is different/.test(outputs.greeting) &&
    result.trace.length === 2 &&
    result.trace[1].payload.message === outputs.quote_text,
  outputs.greeting,
);

result = await onboard({ gstin: "07PUTXM1153M1Z9", lang: "hi" });
test(
  "greets in Hindi when the owner writes in Hindi",
  /^नमस्ते! GST रजिस्ट्री में आपका बिज़नेस मिल गया/.test(result.outputVars.greeting) &&
    /\/माह/.test(result.outputVars.quote_text),
  result.outputVars.greeting,
);
result = await onboard({ gstin: "07PUTXM1153M1Z9", lang: "kn" });
test(
  "greets in Kannada when the owner writes in Kannada",
  /^ನಮಸ್ಕಾರ! GST ನೋಂದಣಿಯಲ್ಲಿ ನಿಮ್ಮ ವ್ಯಾಪಾರ ಸಿಕ್ಕಿದೆ/.test(result.outputVars.greeting) &&
    /ತಿಂಗಳಿಗೆ ₹/.test(result.outputVars.greeting),
  result.outputVars.greeting,
);

result = await onboard({ gstin: "03PJNXS4821G1ZB" });
test(
  "proposes the shop bundle for a proprietor bakery found only by its trade name",
  result.outputVars.next_action === "show_proposal" &&
    result.outputVars.business_category === "kirana_retail" &&
    result.outputVars.segment_code === "micro" &&
    result.outputVars.bundle_name === "Dukaan Digital" &&
    /gst\.constitution/.test(result.outputVars.evidence_fields),
  JSON.stringify(result.outputVars),
);

// Cancelled and suspended GSTINs: blocked, human review, never quoted.
result = await onboard({ gstin: "29OKAXP4077P1ZL" });
outputs = result.outputVars;
test(
  "blocks a cancelled GSTIN, routes it to human review and quotes nothing",
  outputs.gstin_status === "Cancelled" &&
    outputs.is_blocked === true &&
    outputs.next_action === "human_review" &&
    outputs.bundle_name === "" &&
    outputs.monthly_total === 0 &&
    outputs.pre_approved === false &&
    /CANCELLED/.test(outputs.greeting),
  JSON.stringify(outputs),
);
result = await onboard({ gstin: "23QYBXS1811Q1ZD", lang: "kn" });
outputs = result.outputVars;
test(
  "blocks a suspended GSTIN, routes it to human review and explains in Kannada",
  outputs.gstin_status === "Suspended" &&
    outputs.is_blocked === true &&
    outputs.next_action === "human_review" &&
    outputs.monthly_total === 0 &&
    /ಅಮಾನತು/.test(outputs.greeting),
  JSON.stringify(outputs),
);

// Malformed input.
result = await onboard({ gstin: "07PUTXM1153" });
test(
  "asks the owner to fix a GSTIN that is too short",
  !result.outputVars.gstin_valid &&
    result.outputVars.gstin_status === "INVALID_FORMAT" &&
    result.outputVars.next_action === "fix_gstin" &&
    result.outputVars.business_name === "",
  JSON.stringify(result.outputVars),
);
result = await onboard({ gstin: "07PUTXM1153M1Z8" });
test(
  "catches a mistyped GSTIN with the checksum",
  result.outputVars.gstin_status === "CHECKSUM_FAILED" && result.outputVars.next_action === "fix_gstin",
);
result = await onboard({ gstin: "" });
test(
  "handles an empty GSTIN without crashing",
  result.outputVars.gstin_status === "INVALID_FORMAT" && result.outputVars.error === "",
);
result = await onboard({ gstin: "27ABCXE9999F1ZR" });
test(
  "hands a well-formed GSTIN that isn't in the registry to the question-based advisor",
  result.outputVars.gstin_valid &&
    result.outputVars.gstin_status === "NOT_FOUND" &&
    result.outputVars.next_action === "use_advisor",
  JSON.stringify(result.outputVars),
);

// Low confidence: one clarifying question instead of a guess.
result = await onboard({ gstin: "07BSWXR0494W1ZP" });
outputs = result.outputVars;
test(
  "asks what kind of business it is when the name could be a CA firm or a law office",
  outputs.next_action === "ask_question" &&
    outputs.question_type === "business_type" &&
    outputs.segment_confidence < 0.7 &&
    outputs.bundle_name === "" &&
    outputs.monthly_total === 0 &&
    /What kind of business is Riddhi & Associates\?/.test(outputs.greeting) &&
    outputs.question_options.split(" | ").length === 7,
  JSON.stringify(outputs),
);
result = await onboard({ gstin: "07BSWXR0494W1ZP", answer_business_type: "CA firm" });
test(
  "proposes once the owner says it is a CA firm",
  result.outputVars.next_action === "show_proposal" &&
    result.outputVars.business_category === "ca_firm" &&
    result.outputVars.bundle_name === "Office Pro" &&
    /owner answer/.test(result.outputVars.evidence_fields),
  JSON.stringify(result.outputVars),
);
result = await onboard({ gstin: "27LRRXS3617L1ZA" });
test(
  "asks how many locations a restaurant has instead of guessing single shop or chain",
  result.outputVars.next_action === "ask_question" &&
    result.outputVars.question_type === "locations" &&
    result.outputVars.business_category === "restaurant",
  JSON.stringify(result.outputVars),
);
result = await onboard({ gstin: "27LRRXS3617L1ZA", answer_sites: "6–10" });
test(
  "prices a restaurant chain for 6 locations (the smallest in the range) when the owner answers 6–10",
  result.outputVars.next_action === "show_proposal" &&
    result.outputVars.segment_code === "multi" &&
    result.outputVars.bundle_name === "Chain Connect" &&
    JSON.parse(result.outputVars.pricing_inputs_json).sites === "6",
  JSON.stringify(result.outputVars),
);

// Privacy and pre-approval edge cases.
result = await runTool(onboardFromGstin, { gstin: "07PUTXM1153M1Z9", lang: "en" });
test(
  "does not look anything up before the owner agrees to the consent notice",
  result.outputVars.next_action === "ask_consent" &&
    result.outputVars.business_name === "" &&
    !result.outputVars.gstin_valid,
  JSON.stringify(result.outputVars),
);
result = await onboard({ gstin: "03PJNXS4821G1ZB", as_of_date: "2019-07-15" });
test(
  "does not pre-approve a registration younger than 6 months, but still proposes",
  result.outputVars.pre_approved === false &&
    /only 3 months old/.test(result.outputVars.pre_approval_reason) &&
    result.outputVars.next_action === "show_proposal",
  result.outputVars.pre_approval_reason,
);

// ---------------------------------------------------------------- bill_swap
console.log("\nbill_swap");
const clinicContext = { segment: "prof", business_type: "Clinic", city: "Delhi", employees: "14", has_gstin: "yes" };
const clinicBills =
  "Broadband | Local ISP | ₹2,500\nMobile | Competitor A | 3 x 799\n" +
  "Google Workspace | Google | 10 users ₹136 per user\nElectricity | BESCOM | ₹4,000";
result = await runTool(billSwap, { bills: clinicBills, ...clinicContext });
outputs = result.outputVars;
test(
  "shows monthly and yearly savings when Accel is cheaper than today's bills",
  outputs.next_action === "show_comparison" &&
    outputs.current_monthly_total === 6257 &&
    outputs.is_accel_cheaper === true &&
    outputs.monthly_saving === outputs.current_monthly_total - outputs.accel_monthly_total &&
    outputs.yearly_saving === outputs.monthly_saving * 12 &&
    /You save ₹/.test(outputs.message),
  JSON.stringify(outputs),
);
const billSwapPricedDirectly = await runTool(priceBundle, JSON.parse(outputs.pricing_inputs_json));
test(
  "takes the Accel price from price_bundle itself (same inputs give the same total)",
  outputs.accel_monthly_total === billSwapPricedDirectly.outputVars.monthly_total &&
    outputs.accel_items_json === billSwapPricedDirectly.outputVars.items_json,
  outputs.accel_monthly_total + " vs " + billSwapPricedDirectly.outputVars.monthly_total,
);
test(
  "compares like for like: no backup, security or failover the owner doesn't pay for today",
  !/"P09"|"P17"|"P20"/.test(outputs.accel_items_json) && /"P16"/.test(outputs.accel_items_json),
  outputs.accel_items_json,
);
test(
  "reads 3 SIMs from '3 x 799' and 10 email users from '₹136 per user'",
  JSON.parse(outputs.pricing_inputs_json).lines === "3" && JSON.parse(outputs.pricing_inputs_json).email_users === "10",
  outputs.pricing_inputs_json,
);
test(
  "keeps bills Accel doesn't sell (electricity) out of the totals and says so",
  outputs.not_compared_monthly_total === 4000 && /Electricity \(BESCOM\) ₹4,000/.test(outputs.not_compared_text),
  outputs.not_compared_text,
);

result = await runTool(billSwap, {
  bills: "Mobile hotspot recharge | Jio | ₹399",
  segment: "micro",
  business_type: "Kirana store",
  city: "Lucknow",
  employees: "2",
  has_gstin: "no",
});
outputs = result.outputVars;
test(
  "says honestly when Accel costs more, by how much, and what the extra buys",
  outputs.is_accel_cheaper === false &&
    outputs.monthly_saving < 0 &&
    /^To be honest: Accel Dukaan Digital costs ₹999\/month, which is ₹600 more/.test(outputs.message) &&
    /Biz Fibre 100: Business fibre broadband/.test(outputs.message) &&
    /One bill and one support number/.test(outputs.message),
  outputs.message,
);
test(
  "treats a mobile-hotspot bill as the shop's internet connection",
  /"P01"/.test(outputs.accel_items_json) && !/"P07"/.test(outputs.accel_items_json),
  outputs.accel_items_json,
);

result = await runTool(billSwap, {
  bills: "Broadband | Local ISP | ₹1,200\nCCTV | Local vendor | 4 cameras ₹1,200",
  segment: "micro",
  business_type: "Pharmacy",
  city: "Pune",
  employees: "3",
  has_gstin: "yes",
});
outputs = result.outputVars;
test(
  "counts the one-time setup fee against the first year's saving",
  outputs.accel_setup_total > 0 &&
    outputs.first_year_saving === outputs.yearly_saving - outputs.accel_setup_total &&
    /one-time setup/.test(outputs.message),
  JSON.stringify(outputs),
);

result = await runTool(billSwap, {
  bills: JSON.stringify([
    { category: "Broadband", vendor: "Hathway", amount: 1199 },
    { category: "Website hosting", vendor: "GoDaddy", amount: "₹6,000 per year" },
  ]),
  segment: "micro",
  city: "Mumbai",
});
outputs = result.outputVars;
test(
  "reads bills sent as JSON and turns a yearly amount into a monthly one, saying so",
  outputs.bills_read === 2 &&
    outputs.current_monthly_total === 1199 + 500 &&
    /yearly amount ÷ 12/.test(outputs.assumptions),
  JSON.stringify(outputs),
);

result = await runTool(billSwap, {
  bills: "Broadband | Airtel | ₹999\nCCTV | Local vendor | monthly fee\nMobile | Jio | ₹5,00,000",
  segment: "micro",
});
outputs = result.outputVars;
test(
  "never guesses unreadable or implausible amounts: lists them for the owner to confirm",
  outputs.needs_confirmation === true &&
    /monthly fee \(no amount found\)/.test(outputs.unreadable_lines) &&
    /please confirm/.test(outputs.unreadable_lines) &&
    outputs.current_monthly_total === 999,
  JSON.stringify(outputs),
);

result = await runTool(billSwap, {
  bills: "WhatsApp Business | Interakt | ₹1,500\nBroadband | Local ISP | ₹900",
  segment: "micro",
  has_gstin: "no",
});
outputs = result.outputVars;
test(
  "moves a bill Accel can't replace for this business (WhatsApp API without GSTIN) out of the comparison, with the reason",
  /WhatsApp Business \(Interakt\) ₹1,500 \(needs an active GSTIN\)/.test(outputs.not_compared_text) &&
    outputs.current_monthly_total === 900,
  outputs.not_compared_text,
);

result = await runTool(billSwap, { bills: "" });
test(
  "asks for the bills when none are given",
  result.outputVars.next_action === "ask_bills" && /one bill per line/.test(result.outputVars.message),
);
result = await runTool(billSwap, { bills: "Rent | Landlord | ₹25,000\nElectricity | BESCOM | ₹3,000" });
test(
  "says there's nothing to compare when no bill is something Accel sells",
  result.outputVars.next_action === "ask_bills" &&
    result.outputVars.accel_monthly_total === 0 &&
    /nothing to compare/.test(result.outputVars.message),
  JSON.stringify(result.outputVars),
);
result = await runTool(billSwap, { bills: clinicBills, ...clinicContext, lang: "hi" });
test(
  "compares in Hindi when the owner writes in Hindi",
  /आपकी बचत ₹1,711\/माह/.test(result.outputVars.message),
  result.outputVars.message,
);

// How amounts and quantities are written on a bill line. Outside review (2026-11-05): "₹799 x 3" was read as 799 lines.
const shopContext = { business_type: "Kirana store", city: "Delhi", employees: "3", has_gstin: "yes" };
/** bill_swap's reading of one bill line: the monthly total, the mobile lines it priced, and any question it asks. */
const readBillLine = async (line) => {
  const outputVars = (await runTool(billSwap, { bills: line, ...shopContext })).outputVars;
  const pricing = parseOrNull(outputVars.pricing_inputs_json) || {};
  return { total: outputVars.current_monthly_total, lines: pricing.lines, question: outputVars.unreadable_lines };
};
/** Every reading of `lines` is ₹2,397 for 3 mobile lines, with no question asked. */
const allThreeLinesAt799 = async (lines) => {
  const readings = [];
  for (const line of lines) readings.push(await readBillLine(line));
  return {
    passed: readings.every((reading) => reading.total === 2397 && reading.lines === "3" && reading.question === ""),
    detail: JSON.stringify(readings),
  };
};
let lineCheck = await allThreeLinesAt799(["Mobile | Jio | ₹799 x 3"]);
test("'₹799 x 3' is 3 lines at ₹799 (₹2,397), not 799 lines", lineCheck.passed, lineCheck.detail);
lineCheck = await allThreeLinesAt799(["Mobile | Jio | ₹799 ×3", "Mobile | Jio | ₹799×3"]);
test("'₹799 ×3' (multiplication sign, with or without a space) is 3 lines at ₹799", lineCheck.passed, lineCheck.detail);
lineCheck = await allThreeLinesAt799(["Mobile | Jio | 3 x ₹799", "Mobile | Jio | 3 SIMs x ₹799"]);
test("'3 x ₹799' and '3 SIMs x ₹799' (quantity first) are 3 lines at ₹799", lineCheck.passed, lineCheck.detail);
lineCheck = await allThreeLinesAt799(["Mobile | Jio | 3 lines at 799", "Mobile | Jio | 3 SIMs @ ₹799"]);
test("'3 lines at 799' and '3 SIMs @ ₹799' are 3 lines at ₹799", lineCheck.passed, lineCheck.detail);
lineCheck = await allThreeLinesAt799(["Mobile | Jio | 3 SIMs, ₹799 each", "3 SIMs | Jio | ₹799 each"]);
test("'₹799 each' with the quantity on the same line is 3 lines at ₹799", lineCheck.passed, lineCheck.detail);
let lineReading = await readBillLine("Mobile | Jio | ₹799 each");
test(
  "'₹799 each' with no quantity asks how many instead of guessing one",
  lineReading.total === 0 && /how many\?/.test(lineReading.question),
  JSON.stringify(lineReading),
);
lineCheck = await allThreeLinesAt799(["Mobile | Jio | 799 x 3", "Mobile | Jio | 3 x 799", "Mobile | Jio | 3x799"]);
test(
  "with no ₹ or unit word, the number under ₹50 is the quantity, on either side of the x",
  lineCheck.passed,
  lineCheck.detail,
);
const commaReadings = [await readBillLine("Broadband | ACT | ₹1,299"), await readBillLine("Broadband | ACT | ₹12,999")];
test(
  "amounts with commas are read whole: '₹1,299' and '₹12,999'",
  commaReadings[0].total === 1299 && commaReadings[1].total === 12999,
  JSON.stringify(commaReadings),
);
const currencyWritings = ["Rs 1299", "Rs. 1,299/-", "Rs1299", "INR 1299", "1299 INR", "1299 rupees", "1,299/-", "1299"];
const currencyReadings = [];
for (const writing of currencyWritings) currencyReadings.push(await readBillLine("Broadband | ACT | " + writing));
test(
  "every way of writing rupees (Rs, Rs., /-, INR, rupees, or no symbol at all) reads ₹1,299",
  currencyReadings.every((reading) => reading.total === 1299 && reading.question === ""),
  JSON.stringify(currencyWritings.map((writing, index) => [writing, currencyReadings[index].total])),
);
/** Every quantity word bill_swap knows (COUNT_UNIT_SOURCE). */
const quantityWords = [
  "users",
  "seats",
  "lines",
  "sims",
  "connections",
  "cameras",
  "counters",
  "vehicles",
  "machines",
  "sensors",
  "channels",
];
const quantityReadings = [];
for (const word of quantityWords)
  quantityReadings.push([word, (await readBillLine("Mobile | Jio | 3 " + word + " at 799")).total]);
test(
  "every quantity word marks the quantity: '3 <word> at 799' is ₹2,397",
  quantityReadings.every(([, total]) => total === 2397),
  JSON.stringify(quantityReadings),
);
const notMoneyUnits = [
  "%",
  "percent",
  "mbps",
  "Mbps",
  "gbps",
  "kbps",
  "MB",
  "GB",
  "TB",
  "months",
  "days",
  "years",
  "hours",
];
const notMoneyReadings = [];
for (const unit of notMoneyUnits)
  notMoneyReadings.push([unit, (await readBillLine("Broadband | ACT | ₹999 for 100 " + unit)).total]);
test(
  "speeds, data sizes, shares and times after a number are not money: '₹999 for 100 <unit>' is ₹999",
  notMoneyReadings.every(([, total]) => total === 999),
  JSON.stringify(notMoneyReadings),
);
const notMoneyCases = [
  ["Internet | ACT | ₹1,000 + 18% GST", 1000],
  ["Mobile | Jio 5G | ₹399", 399],
  ["Biz Fibre 100 | Local ISP | 999", 999],
  ["Mobile | Jio | 3 x 799 = ₹2,397", 2397],
];
const notMoneyCaseReadings = [];
for (const [line] of notMoneyCases) notMoneyCaseReadings.push((await readBillLine(line)).total);
test(
  "a GST share, a plan name ('5G', 'Biz Fibre 100') or a matching total don't change the amount",
  notMoneyCases.every(([, expected], index) => notMoneyCaseReadings[index] === expected),
  JSON.stringify(notMoneyCaseReadings),
);
const unclearLines = [
  ["Mobile | Jio | 120 x 100", /which number is the quantity\?/],
  ["Mobile | Jio | ₹799 x 300", /which number is the quantity\?/],
  ["Broadband | ACT | ₹500 + ₹300", /more than one amount/],
  ["Broadband | ACT | 999 100", /more than one amount/],
  ["Mobile | Jio | 2 x 399 + 1 x 599", /more than one amount/],
];
const unclearReadings = [];
for (const [line] of unclearLines) unclearReadings.push(await readBillLine(line));
test(
  "unclear lines (either number could be the quantity, a quantity over 150, two amounts) ask instead of guessing",
  unclearLines.every(
    ([, question], index) => unclearReadings[index].total === 0 && question.test(unclearReadings[index].question),
  ),
  JSON.stringify(unclearReadings),
);
result = await runTool(billSwap, { bills: "Mobile | Jio | ₹799 x 3\nMobile | Jio | ₹799 each", ...shopContext });
test(
  "a line that needs an answer is left out of the totals, the rest is still compared",
  result.outputVars.current_monthly_total === 2397 &&
    result.outputVars.needs_confirmation === true &&
    result.outputVars.next_action === "show_comparison",
  JSON.stringify(result.outputVars),
);

// ---------------------------------------------------------------- readiness_score
console.log("\nreadiness_score");
const everything =
  "leased line, business broadband, failover, business postpaid, whatsapp api, pos, website, google workspace, " +
  "cloud backup, antivirus, cctv, sd-wan, machine monitoring, cloud telephony";
let allSegmentsScore100 = true;
for (const segment of ["micro", "prof", "multi", "mfg", "unknown business"]) {
  const scored = await runTool(readinessScore, { current_products: everything, segment, has_gstin: "yes" });
  if (scored.outputVars.readiness_score !== 100 || scored.outputVars.top_gaps !== "") allSegmentsScore100 = false;
}
test(
  "gives exactly 100 to a business that has everything, in every segment (weights add up to 100)",
  allSegmentsScore100,
);

result = await runTool(readinessScore, {
  current_products: "home broadband, 2 jio sims, gmail",
  segment: "prof",
  staff_count: "12",
  has_gstin: "yes",
});
outputs = result.outputVars;
const officePath = JSON.parse(outputs.add_ons_json);
test(
  "scores a professional office with consumer tools at 19 and names its top 3 gaps",
  outputs.readiness_score === 19 &&
    outputs.top_gaps === "data security | backup internet | business email" &&
    officePath.length === 3,
  JSON.stringify(outputs),
);
test(
  "shows the new score after each add-on, rising step by step",
  officePath.every(
    (step, index) =>
      step.available && step.new_score > (index ? officePath[index - 1].new_score : outputs.readiness_score),
  ) &&
    outputs.score_after_add_ons === officePath[2].new_score &&
    /Add Endpoint Security → 39\/100/.test(outputs.message),
  outputs.add_on_path_text,
);
const officeRequote = await runTool(priceBundle, {
  business_type: "Clinic",
  employees: "12",
  has_gstin: "yes",
  needs: outputs.suggested_needs,
  show_card: "no",
});
test(
  "hands its add-ons to the pricing function as need keywords, and the re-quote contains them",
  outputs.suggested_needs === "security, failover, email" &&
    ["P20", "P09", "P16"].every((productId) => officeRequote.outputVars.items_json.includes('"' + productId + '"')),
  outputs.suggested_needs + " → " + officeRequote.outputVars.items_json,
);
test(
  "gives partial credit for consumer products and shows it (home broadband = 50%)",
  /home broadband → reliable_internet 50%/.test(outputs.recognised_products) &&
    /gmail → cloud_email 25%/.test(outputs.recognised_products),
  outputs.recognised_products,
);

result = await runTool(readinessScore, {
  current_products: "mobile hotspot, UPI QR, whatsapp business",
  segment: "kirana_retail",
  has_gstin: "no",
});
outputs = result.outputVars;
test(
  "says which gap can't be closed without a GSTIN instead of suggesting it",
  /WhatsApp\/SMS to customers: needs an active GSTIN/.test(outputs.message) &&
    JSON.parse(outputs.add_ons_json).some((step) => !step.available) &&
    outputs.segment_used === "micro",
  outputs.message,
);
test(
  "counts a mobile hotspot as weak internet, not as a business SIM",
  /mobile hotspot → reliable_internet 25%/.test(outputs.recognised_products) &&
    !/mobile hotspot → business_lines/.test(outputs.recognised_products),
  outputs.recognised_products,
);

result = await runTool(readinessScore, { current_products: "backup internet", segment: "prof" });
test(
  "doesn't mistake a backup internet line for cloud data backup",
  /backup internet → backup_internet 100%/.test(result.outputVars.recognised_products) &&
    !/cloud_backup/.test(result.outputVars.recognised_products),
  result.outputVars.recognised_products,
);

result = await runTool(readinessScore, { current_products: "business broadband", segment: "small_factory" });
outputs = result.outputVars;
const factoryPath = JSON.parse(outputs.add_ons_json);
test(
  "flags unknown facts as conditions (GSTIN, staff) rather than assuming them",
  factoryPath.some((step) => step.available && step.conditions.some((condition) => condition.key === "staff")) &&
    /needs an active GSTIN/.test(outputs.add_on_path_text),
  outputs.add_on_path_text,
);
result = await runTool(readinessScore, {
  current_products: "business broadband",
  segment: "mfg",
  staff_count: "6",
  has_gstin: "yes",
});
test(
  "falls back to a product the business can buy when the first choice needs more staff (firewall → endpoint security)",
  JSON.parse(result.outputVars.add_ons_json).some(
    (step) => step.capability === "data_security" && step.product_id === "P20",
  ),
  result.outputVars.add_ons_json,
);

result = await runTool(readinessScore, { current_products: "none", segment: "micro" });
test(
  "scores 0 when the business uses nothing digital yet",
  result.outputVars.readiness_score === 0 && result.outputVars.next_action === "show_score",
);
result = await runTool(readinessScore, { current_products: "", segment: "micro" });
test(
  "asks what the business uses instead of scoring an empty answer",
  result.outputVars.next_action === "ask_products" && result.outputVars.readiness_score === 0,
);
result = await runTool(readinessScore, { current_products: "home broadband, tally software", segment: "" });
outputs = result.outputVars;
test(
  "says when it had to assume a general business, and lists what it didn't recognise",
  outputs.segment_used === "general" &&
    outputs.segment_assumed === true &&
    outputs.unrecognised_items === "tally software" &&
    /Scored as a general small business/.test(outputs.message),
  JSON.stringify(outputs),
);
result = await runTool(readinessScore, {
  current_products: "home broadband, 2 jio sims, gmail",
  segment: "clinic",
  lang: "kn",
});
test(
  "accepts an onboarding category (clinic) and answers in Kannada",
  result.outputVars.segment_used === "prof" && /^ನಿಮ್ಮ ಡಿಜಿಟಲ್-ಸಿದ್ಧತೆ ಸ್ಕೋರ್: 19\/100/.test(result.outputVars.message),
  result.outputVars.message,
);

// ---------------------------------------------------------------- reach layer (reach_tag_lead + shared rules)
// The rules are loaded from the back-office copy exactly as the browser loads it; the Voiceflow function embeds the
// same code (checked below).
console.log("\nreach (referral codes, territory, handoff, rewards)");
const reachSandbox = { window: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(testDirectory, "..", "8_back_office", "reach_rules.js"), "utf8"),
  reachSandbox,
);
const reachRules = reachSandbox.window.ReachRules;
const codeFor = (type, id) => reachRules.issueReferralCode(type, id);
const CASE_DAY = new Date("2026-07-15T00:00:00Z");
const delhi = reachRules.findTerritory({ city: "Delhi" });
const activatedLead = (overrides) =>
  Object.assign(
    {
      stage: "Activated",
      monthly_total: 6138,
      activated_date: "2026-06-01",
      churned: "N",
      closed_by: "saathi",
      referral: reachRules.validateReferralCode(""),
      territory: delhi,
    },
    overrides,
  );

const directoryCodes = reachRules.REFERRER_DIRECTORY.map((referrer) => codeFor(referrer.type, referrer.id));
test(
  "gives every CA partner, customer and field rep a unique referral code",
  new Set(directoryCodes).size === directoryCodes.length &&
    ["ca_partner", "customer", "field_rep"].every((type) =>
      reachRules.REFERRER_DIRECTORY.some((referrer) => referrer.type === type),
    ),
  directoryCodes.length + " codes",
);
test(
  "keeps every rate and timing rule in one REACH_RATES object",
  ["ca_partner", "customer", "field_rep"].every((type) => reachRules.REACH_RATES.referral[type].capInRupees > 0) &&
    reachRules.REACH_RATES.territoryCredit.capInRupees > 0 &&
    reachRules.REACH_RATES.payoutHoldDays === 90 &&
    reachRules.REACH_RATES.earnOn === "Activated",
);

const caCode = codeFor("ca_partner", "CA-DEL-1");
const reachLead = {
  referral_code: caCode,
  city: "Delhi",
  state: "Delhi",
  lead_score: "92",
  priority: "Hot",
  stage: "proposal_shown",
  business_name: "Metro Diagnostics Pvt Ltd",
  segment_code: "prof",
  bundle_name: "Office Pro",
  monthly_total: "6013",
  reason_not_closed: "wants to compare",
  gstin_status: "Active",
};
result = await runTool(reachTagLead, reachLead);
outputs = result.outputVars;
test(
  "stores the referral code and referrer type on a lead created via a CA partner's link",
  outputs.referral_valid === true &&
    outputs.referral_code === caCode &&
    outputs.referrer_type === "ca_partner" &&
    outputs.referrer_id === "CA-DEL-1" &&
    outputs.owner_message === "Thanks for coming through a referral from your CA.",
  JSON.stringify(outputs),
);
test(
  "flags a Hot lead Saathi couldn't close for a rep callback, with business, segment, bundle and drop-off in the summary",
  outputs.handoff_flag === true &&
    outputs.handoff_owner_id === "REP-DEL" &&
    /Metro Diagnostics Pvt Ltd \(Professional offices, Delhi\)/.test(outputs.handoff_summary) &&
    /viewed Office Pro ₹6,013\/mo/.test(outputs.handoff_summary) &&
    /dropped at Needs assessed: wants to compare/.test(outputs.handoff_summary) &&
    /referred by CA partner 1 · Delhi/.test(outputs.handoff_summary) &&
    result.trace.every((entry) => !/Hot|score|REP-/.test(entry.payload.message)),
  outputs.handoff_summary,
);
test(
  "maps the lead to the field rep who owns its district",
  outputs.territory_id === "T-DEL" && outputs.territory_rep_id === "REP-DEL" && outputs.territory_matched_by === "city",
  JSON.stringify(outputs),
);

const mistyped = caCode.slice(0, 4) + (caCode[4] === "A" ? "B" : "A") + caCode.slice(5);
result = await runTool(reachTagLead, { ...reachLead, referral_code: mistyped.toLowerCase().replace(/-/g, " ") });
test(
  "catches a mistyped referral code with its check character and asks once",
  result.outputVars.referral_valid === false &&
    result.outputVars.referral_problem === "checksum" &&
    /looks mistyped/.test(result.outputVars.owner_message),
  JSON.stringify(result.outputVars),
);
result = await runTool(reachTagLead, { ...reachLead, referral_code: codeFor("ca_partner", "CA-NOT-LISTED") });
test(
  "saves a well-formed code it can't match, without crediting anyone",
  result.outputVars.referral_problem === "unknown_referrer" &&
    result.outputVars.referrer_id === "" &&
    reachRules
      .computeRewards(
        activatedLead({ referral: reachRules.validateReferralCode(result.outputVars.referral_code) }),
        CASE_DAY,
      )
      .every((reward) => reward.rewardKind === "territory_credit"),
  JSON.stringify(result.outputVars),
);
result = await runTool(reachTagLead, { ...reachLead, referral_code: codeFor("field_rep", "REP-PUN") });
test(
  "gives the callback to the field rep who referred the lead, even outside their territory",
  result.outputVars.handoff_owner_id === "REP-PUN" && result.outputVars.territory_rep_id === "REP-DEL",
  JSON.stringify(result.outputVars),
);
result = await runTool(reachTagLead, { ...reachLead, priority: "Warm", lead_score: "60" });
const warmFlag = result.outputVars.handoff_flag;
result = await runTool(reachTagLead, { ...reachLead, stage: "activated" });
const activatedFlag = result.outputVars.handoff_flag;
result = await runTool(reachTagLead, { ...reachLead, gstin_status: "Cancelled" });
test(
  "doesn't flag Warm leads, activated leads or cancelled GSTINs (those go to human review)",
  warmFlag === false && activatedFlag === false && result.outputVars.handoff_flag === false,
);

test(
  "falls back to the state's rep when the city isn't a territory",
  reachRules.findTerritory({ city: "Hubballi", state: "Karnataka" }).matchedBy === "state" &&
    reachRules.findTerritory({ city: "Hubballi", state: "Karnataka" }).repId === "REP-BEN",
  JSON.stringify(reachRules.findTerritory({ city: "Hubballi", state: "Karnataka" })),
);
test(
  "uses the state code in a masked GSTIN when no city or state is known",
  reachRules.findTerritory({ gstin: "29OKA•••••••1ZL" }).matchedBy === "gstin_state_code" &&
    reachRules.findTerritory({ gstin: "29OKA•••••••1ZL" }).territoryLabel.endsWith("Karnataka"),
);
test(
  "sends leads from a state with no territory to the central desk",
  reachRules.findTerritory({ city: "Panaji", state: "Goa" }).repId === "CENTRAL-DESK",
);

const caReferral = reachRules.validateReferralCode(caCode);
test(
  "earns nothing before activation, even with a valid referral",
  reachRules.computeRewards(activatedLead({ stage: "Quote accepted", referral: caReferral }), CASE_DAY).length === 0,
);
let rewards = reachRules.computeRewards(activatedLead({ referral: caReferral }), CASE_DAY);
const bigRewards = reachRules.computeRewards(activatedLead({ referral: caReferral, monthly_total: 23864 }), CASE_DAY);
test(
  "pays the CA partner a commission of the first monthly bill on activation, capped at ₹10,000",
  rewards[0].rewardKind === "commission" &&
    rewards[0].amountInRupees === 6138 &&
    rewards[0].beneficiaryId === "CA-DEL-1" &&
    bigRewards[0].amountInRupees === 10000,
  JSON.stringify(rewards),
);
test(
  "also credits the territory rep, because Saathi closed the sale digitally",
  rewards.some(
    (reward) =>
      reward.rewardKind === "territory_credit" && reward.beneficiaryId === "REP-DEL" && reward.amountInRupees === 614,
  ),
  JSON.stringify(rewards),
);
rewards = reachRules.computeRewards(
  activatedLead({ referral: reachRules.validateReferralCode(codeFor("customer", "L00002")), monthly_total: 9000 }),
  CASE_DAY,
);
test(
  "gives a customer micro-agent a bill credit of half the first bill, capped at ₹3,000",
  rewards[0].rewardKind === "bill_credit" &&
    rewards[0].amountInRupees === 3000 &&
    rewards[0].beneficiaryId === "L00002",
  JSON.stringify(rewards),
);
const statusOn = (overrides, date) => reachRules.computeRewards(activatedLead(overrides), new Date(date))[0].status;
test(
  "holds rewards for 90 days, then makes them payable, and voids them if the customer leaves",
  statusOn({ activated_date: "2026-06-01" }, "2026-07-15") === "held" &&
    statusOn({ activated_date: "2026-04-01" }, "2026-07-15") === "payable" &&
    statusOn({ activated_date: "2026-04-01", churned: "Y" }, "2026-07-15") === "void",
);
test(
  "credits the territory rep for a digital activation even when there is no referral",
  reachRules.computeRewards(activatedLead({}), CASE_DAY).length === 1 &&
    reachRules.computeRewards(activatedLead({}), CASE_DAY)[0].rewardKind === "territory_credit",
);
const repReferral = reachRules.validateReferralCode(codeFor("field_rep", "REP-DEL"));
test(
  "pays a field rep nothing extra for a sale they closed in person (no referral incentive, no territory credit)",
  reachRules.computeRewards(activatedLead({ referral: repReferral, closed_by: "field_rep" }), CASE_DAY).length === 0,
);
rewards = reachRules.computeRewards(activatedLead({ referral: repReferral }), CASE_DAY);
test(
  "doesn't pay the same rep twice when their own referral in their own territory is closed by Saathi",
  rewards.length === 1 && rewards[0].rewardKind === "incentive" && rewards[0].amountInRupees === 1535,
  JSON.stringify(rewards),
);

result = await runTool(reachTagLead, { mode: "issue_code", order_id: "UD-0002", lang: "en" });
test(
  "gives a live customer their own referral code from the order number, with terms taken from the rates",
  result.outputVars.referral_code === codeFor("customer", "L00002") &&
    reachRules.validateReferralCode(result.outputVars.referral_code).referrerId === "L00002" &&
    /50% of their first monthly bill \(up to ₹3,000\), once they've stayed 90 days/.test(result.outputVars.share_text),
  result.outputVars.share_text,
);
result = await runTool(reachTagLead, { mode: "issue_code", order_id: "UD-9999" });
test(
  "doesn't invent a code for an order it can't match",
  result.outputVars.referral_code === "" && /couldn't find/.test(result.outputVars.share_text),
);
result = await runTool(reachTagLead, { ...reachLead, lang: "kn" });
test("thanks the referred owner in Kannada", /ರೆಫರಲ್ ಮೂಲಕ ಬಂದದ್ದಕ್ಕೆ ಧನ್ಯವಾದ/.test(result.outputVars.owner_message));

const embeddedInChatbot = fs.readFileSync(
  path.join(testDirectory, "..", "3_function_tools", "reach_tag_lead.js"),
  "utf8",
);
const backOfficeRules = fs.readFileSync(path.join(testDirectory, "..", "8_back_office", "reach_rules.js"), "utf8");
const embeddedBody = backOfficeRules.slice(
  backOfficeRules.indexOf("(function embeddedReachRules()"),
  backOfficeRules.lastIndexOf(";"),
);
sourceTextTest(
  "uses exactly the same REACH rules in the chatbot and the back office",
  embeddedBody.length > 1000 && embeddedInChatbot.includes(embeddedBody),
);

vm.runInNewContext(
  fs.readFileSync(path.join(testDirectory, "..", "8_back_office", "sample_leads.js"), "utf8"),
  reachSandbox,
);
const sampleRows = reachSandbox.window.SAMPLE_LEADS;
const sampleTags = sampleRows.map((row) => ({ row, tags: reachRules.tagLead(row, CASE_DAY) }));
const sampleUnclosed = sampleTags.filter((entry) => entry.tags.dropOffStage !== "Activated");
test(
  "builds a back-office sample where only unclosed Hot leads get callbacks and only activations earn rewards",
  sampleRows.length === 5000 &&
    sampleUnclosed.length === 4632 &&
    sampleTags.every(
      (entry) =>
        !entry.tags.handoff.isHandoff || (entry.row.priority === "Hot" && entry.tags.dropOffStage !== "Activated"),
    ) &&
    sampleUnclosed.every((entry) => entry.tags.rewards.length === 0) &&
    sampleTags.some((entry) => entry.tags.rewards.length > 0),
  sampleUnclosed.length + " unclosed",
);

// ---------------------------------------------------------------- PROMISE: activation guarantee (order_status)
// Demo orders are SIMULATED and timed relative to "now", so their guarantee states are the same on every run. Each
// order's deadline is the promise its own quote card showed (price_bundle's promise_hours; STRATEGY.md §11).
console.log("\npromise: activation guarantee from the quote, proactive messages, chases (order_status)");
const promiseRules = (await import(pathToFileURL(path.join(testDirectory, "..", "_build", "promise_rules.js")).href))
  .PROMISE_RULES_API;
const HOUR_IN_MS = 3600000;
const HOURS_PER_DAY = 24;
const DEMO_LABEL_EN = promiseRules.PROMISE_MESSAGES.en.demoLabel;
const demoQuoteOf = async (orderId) =>
  (await runTool(priceBundle, Object.assign({ show_card: "no" }, promiseRules.DEMO_ORDERS[orderId].pricingInputs)))
    .outputVars;
const monthlyBillOf = async (orderId) => (await demoQuoteOf(orderId)).monthly_total;
/** The 72-hour wording in English, Hindi and Kannada: a firm-date order must never show it. */
const SEVENTY_TWO_HOUR_WORDING = /72[- ]hour|72 घंटे|72 ಗಂಟೆ/;

const demoOrderIds = Object.keys(promiseRules.DEMO_ORDERS);
const deadlineMismatches = [];
for (const orderId of demoOrderIds) {
  const quote = await demoQuoteOf(orderId);
  const tracked = (await runTool(orderStatus, { order_id: orderId, lang: "en" })).outputVars;
  const promisedMs = new Date(tracked.guarantee_deadline) - new Date(tracked.order_confirmed_at);
  if (
    promisedMs !== quote.promise_hours * HOUR_IN_MS ||
    tracked.promise_type !== quote.promise_type ||
    tracked.promise_hours !== quote.promise_hours
  ) {
    deadlineMismatches.push(
      orderId + ": tracker " + tracked.promise_hours + " h vs quote " + quote.promise_hours + " h",
    );
  }
}
test(
  `every demo order is tracked against exactly the promise its own quote card showed (${demoOrderIds.length} orders)`,
  demoOrderIds.length >= 5 && deadlineMismatches.length === 0,
  deadlineMismatches.join("; "),
);
test(
  "the tracker never guesses a deadline: without the quote's promise_hours the guarantee can't be evaluated",
  (() => {
    try {
      promiseRules.evaluateGuarantee(promiseRules.DEMO_ORDERS["UD-0068"], new Date());
      return false;
    } catch (error) {
      return /promise_hours/.test(error.message);
    }
  })(),
);

const inScope = (await runTool(orderStatus, { order_id: "UD-0782", lang: "en" })).outputVars;
test(
  "an order in the 72-hour scope is tracked against 72 hours, and kept when AirFiber connects it in 40 hours",
  inScope.promise_type === "guaranteed_72h" &&
    inScope.promise_hours === 72 &&
    inScope.guarantee_status === "met" &&
    inScope.month_one_credit === 0 &&
    inScope.tracker_text.includes("72-hour guarantee kept"),
  JSON.stringify(inScope),
);

const onTrack = (await runTool(orderStatus, { order_id: "UD-0068", lang: "en" })).outputVars;
test(
  "a firm-date order inside its promised days is on track, with the deadline that many days after confirmation",
  onTrack.promise_type === "firm_date" &&
    onTrack.guarantee_status === "on_track" &&
    new Date(onTrack.guarantee_deadline) - new Date(onTrack.order_confirmed_at) ===
      onTrack.promise_hours * HOUR_IN_MS &&
    onTrack.hours_to_deadline > 0 &&
    onTrack.hours_to_deadline <= onTrack.promise_hours &&
    onTrack.month_one_credit === 0 &&
    onTrack.tracker_text.includes(onTrack.promise_hours / HOURS_PER_DAY + "-day guarantee"),
  JSON.stringify(onTrack),
);
const firmDateProblems = [];
for (const orderId of demoOrderIds.filter((id) => id !== "UD-0782")) {
  for (const language of ["en", "hi", "kn"]) {
    const tracked = (await runTool(orderStatus, { order_id: orderId, lang: language })).outputVars;
    if (tracked.promise_type !== "firm_date") firmDateProblems.push(orderId + " is not a firm-date order");
    const shown = tracked.tracker_text + tracked.proactive_messages_json + tracked.next_proactive_message;
    if (SEVENTY_TWO_HOUR_WORDING.test(shown)) firmDateProblems.push(orderId + " (" + language + ") mentions 72 hours");
  }
}
test(
  "a firm-date order never mentions 72 hours in its tracker or its messages, in any language",
  firmDateProblems.length === 0,
  firmDateProblems.join("; "),
);
test(
  "the on-track tracker counts down to the deadline and is labelled as a demo order",
  onTrack.tracker_text.includes(String(onTrack.hours_to_deadline)) && onTrack.tracker_text.includes(DEMO_LABEL_EN),
  onTrack.tracker_text,
);
test(
  "an on-track order already has its next proactive message ready",
  onTrack.next_proactive_message.length > 0 && JSON.parse(onTrack.proactive_messages_json).length >= 1,
);

const kept = (await runTool(orderStatus, { order_id: "UD-0002", lang: "en" })).outputVars;
test(
  "an order connected inside its promised days keeps the promise and gets no credit",
  kept.guarantee_status === "met" &&
    new Date(kept.connected_at) - new Date(kept.order_confirmed_at) <= kept.promise_hours * HOUR_IN_MS &&
    kept.month_one_credit === 0,
  JSON.stringify(kept),
);
const keptMessages = JSON.parse(kept.proactive_messages_json);
// Stages whose time has come, worked out here from the demo order itself (not from the function's output).
const keptPastStages = promiseRules.DEMO_ORDERS["UD-0002"].events
  .filter((event) => Date.parse(kept.order_confirmed_at) + event.hoursAfterConfirm * HOUR_IN_MS <= Date.now())
  .map((event) => event.stage);
test(
  "Saathi sends one proactive message for every stage that has happened, so the owner never needs to chase",
  keptPastStages.length >= 3 &&
    keptMessages.length === keptPastStages.length &&
    keptPastStages.every((stage) =>
      keptMessages.some((message) => message.stage === stage && message.message.length > 0),
    ),
  kept.proactive_messages_json,
);

const breached = (await runTool(orderStatus, { order_id: "UD-0001", lang: "en" })).outputVars;
const breachedBill = await monthlyBillOf("UD-0001");
test(
  "an order not connected by its promised deadline is marked guarantee breached",
  breached.guarantee_status === "breached" && breached.connected_at === "" && breached.hours_to_deadline < 0,
  JSON.stringify(breached),
);
test(
  "a breached guarantee credits month one: exactly the monthly bill from price_bundle",
  breached.month_one_credit === breachedBill && breached.monthly_total === breachedBill && breachedBill > 0,
  breached.month_one_credit + " vs " + breachedBill,
);
test(
  "the breach is announced proactively with the credit, and shown as missed (not ticked) in the tracker",
  JSON.parse(breached.proactive_messages_json).some(
    (message) =>
      message.stage === promiseRules.BREACH_NOTICE_STAGE &&
      message.message.includes(promiseRules.formatRupees(breachedBill)),
  ) &&
    breached.tracker_text.includes("⚠️") &&
    !/kept/i.test(breached.tracker_text),
  breached.tracker_text,
);
test(
  "the order stage stays the real stage of the order, not the breach notice",
  breached.order_stage === "KYC verified",
  breached.order_stage,
);

const lateConnected = (await runTool(orderStatus, { order_id: "UD-1460", lang: "en" })).outputVars;
test(
  "an order connected after the deadline is still breached and still credited",
  lateConnected.guarantee_status === "breached" &&
    new Date(lateConnected.connected_at) > new Date(lateConnected.guarantee_deadline) &&
    lateConnected.month_one_credit === (await monthlyBillOf("UD-1460")),
  JSON.stringify(lateConnected),
);
// Move the clock past UD-0001's late connection: its "connected" message must not claim the promise was kept.
// The order is stored the way a real one is (an absolute confirmation time), so the clock can move on.
const delayedOrder = Object.assign({}, promiseRules.DEMO_ORDERS["UD-0001"], {
  confirmedAt: new Date(Date.now() - promiseRules.DEMO_ORDERS["UD-0001"].confirmedHoursAgo * HOUR_IN_MS).toISOString(),
});
const afterLateConnection = new Date(Date.now() + 100 * HOUR_IN_MS);
const lateGuarantee = promiseRules.evaluateGuarantee(delayedOrder, afterLateConnection, breached.promise_hours);
const lateMessages = ["en", "hi", "kn"].map(
  (language) =>
    promiseRules
      .proactiveMessages(delayedOrder, "UD-0001", lateGuarantee, breachedBill, afterLateConnection, language)
      .sent.find((entry) => entry.stage === "connected").message,
);
test(
  "a late connection never says the promise was kept, in any language",
  lateGuarantee.status === "breached" &&
    !/promise kept/i.test(lateMessages[0]) &&
    !lateMessages[1].includes("वादा पूरा") &&
    !lateMessages[2].includes("ಭರವಸೆ ಪೂರ್ಣ"),
  JSON.stringify(lateMessages),
);
const onTimeConnection = (await runTool(orderStatus, { order_id: "UD-0068" })).outputVars;
test(
  "an on-time connection does say the promise was kept",
  /promise kept/i.test(onTimeConnection.next_proactive_message),
  onTimeConnection.next_proactive_message,
);

const firstChase = (await runTool(orderStatus, { order_id: "UD-0068", is_chase: "yes", previous_chases: "0" }))
  .outputVars;
const notAChase = (await runTool(orderStatus, { order_id: "UD-0068", is_chase: "no", previous_chases: "1" }))
  .outputVars;
const secondChase = (await runTool(orderStatus, { order_id: "UD-0001", is_chase: "yes", previous_chases: "1" }))
  .outputVars;
test(
  "a customer asking unprompted is logged as a chase; the first chase is not yet flagged",
  firstChase.chase_count === 1 && firstChase.retention_flag === false,
  JSON.stringify([firstChase.chase_count, firstChase.retention_flag]),
);
test(
  "a status check Saathi started is not counted as a chase",
  notAChase.chase_count === 1 && notAChase.retention_flag === false,
);
test(
  "the second chase is flagged for retention",
  secondChase.chase_count === 2 && secondChase.retention_flag === true,
  JSON.stringify([secondChase.chase_count, secondChase.retention_flag]),
);

const breachedHindi = (await runTool(orderStatus, { order_id: "UD-0001", lang: "hi" })).outputVars;
const breachedKannada = (await runTool(orderStatus, { order_id: "UD-0001", lang: "kn" })).outputVars;
test(
  "the guarantee and its credit are explained in Hindi and Kannada too",
  breachedHindi.tracker_text.includes(promiseRules.PROMISE_MESSAGES.hi.demoLabel) &&
    /[ऀ-ॿ]/.test(breachedHindi.next_proactive_message) &&
    /[ಀ-೿]/.test(breachedKannada.tracker_text) &&
    breachedKannada.tracker_text.includes(promiseRules.formatRupees(breachedBill)),
);
const stageNames = Object.keys(promiseRules.PROMISE_MESSAGES.en.stages);
test(
  "every stage has a proactive message in English, Hindi and Kannada",
  ["en", "hi", "kn"].every((language) =>
    stageNames.every((stage) => (promiseRules.PROMISE_MESSAGES[language].stages[stage] || "").length > 0),
  ),
);
console.log(indent(breached.tracker_text));

// ---------------------------------------------------------------- PROMISE: downtime auto-credit
console.log("\npromise: downtime auto-credit (downtime_credit)");
const downtimeCredit = await loadFunctionTool("downtime_credit.js");
const downtimeRule = promiseRules.PROMISE_RULES.downtime;
const dailyBillOf = (monthlyTotal) => Math.round(monthlyTotal / downtimeRule.daysPerMonth);
const liveBill = await monthlyBillOf("UD-0002");

const shortOutage = (await runTool(downtimeCredit, { order_id: "UD-0002", outage_duration: "45 min" })).outputVars;
test(
  "an outage under the minimum gets no credit but still a proactive apology",
  shortOutage.credit_amount === 0 && shortOutage.outage_minutes === 45 && shortOutage.message.length > 0,
  JSON.stringify(shortOutage),
);
const oneBlock = (await runTool(downtimeCredit, { order_id: "UD-0002", outage_duration: "3h 20m", lang: "en" }))
  .outputVars;
test(
  "each started 4-hour block of downtime credits one day's bill",
  oneBlock.outage_minutes === 200 && oneBlock.credit_amount === dailyBillOf(liveBill),
  JSON.stringify(oneBlock),
);
test(
  "the credit message arrives before the customer complains, with the amount and the demo label",
  oneBlock.message.includes(promiseRules.formatRupees(dailyBillOf(liveBill))) &&
    oneBlock.message.includes(DEMO_LABEL_EN),
  oneBlock.message,
);
const twoBlocks = (await runTool(downtimeCredit, { order_id: "UD-0002", outage_duration: "5 hours" })).outputVars;
test("a 5-hour outage is two blocks", twoBlocks.credit_amount === 2 * dailyBillOf(liveBill), JSON.stringify(twoBlocks));
const withFailover = (await runTool(downtimeCredit, { order_id: "UD-1460", outage_duration: "5 hours" })).outputVars;
test(
  "with 4G failover in the bundle the credit is halved, and the rule says why",
  withFailover.has_failover === true &&
    withFailover.credit_amount ===
      Math.round(2 * dailyBillOf(await monthlyBillOf("UD-1460")) * downtimeRule.failoverFactor) &&
    withFailover.credit_rule.includes("failover"),
  JSON.stringify(withFailover),
);
const longOutage = (await runTool(downtimeCredit, { order_id: "UD-0002", outage_duration: "100 hours" })).outputVars;
test(
  "the credit is capped at half the monthly bill",
  longOutage.credit_amount === Math.round(downtimeRule.maxShareOfMonthlyBill * liveBill) &&
    longOutage.credit_rule.includes("capped"),
  JSON.stringify(longOutage),
);
const notLiveYet = (await runTool(downtimeCredit, { order_id: "UD-0068", outage_duration: "2h" })).outputVars;
test(
  "an order that isn't live yet gets no downtime credit (the activation guarantee covers it)",
  notLiveYet.is_live === false && notLiveYet.credit_amount === 0 && notLiveYet.error === "",
  JSON.stringify(notLiveYet),
);
const unreadable = (
  await runToolExpectingError(downtimeCredit, { order_id: "UD-0002", outage_duration: "a long time" })
).outputVars;
test(
  "an unreadable duration is an error, never a guessed credit",
  unreadable.error !== "" && unreadable.credit_amount === 0,
);
const unknownOrder = (await runToolExpectingError(downtimeCredit, { order_id: "UD-7777", outage_duration: "2h" }))
  .outputVars;
test("an unknown order is an error", unknownOrder.error !== "" && unknownOrder.order_found === false);
const hindiOutage = (
  await runTool(downtimeCredit, { order_id: "UD-0002", outage_duration: "2 घंटे 15 मिनट", lang: "hi" })
).outputVars;
const kannadaOutage = (await runTool(downtimeCredit, { order_id: "UD-0002", outage_duration: "90 ನಿಮಿಷ", lang: "kn" }))
  .outputVars;
test(
  "durations and messages work in Hindi and Kannada",
  hindiOutage.outage_minutes === 135 &&
    /[ऀ-ॿ]/.test(hindiOutage.message) &&
    kannadaOutage.outage_minutes === 90 &&
    /[ಀ-೿]/.test(kannadaOutage.message),
  JSON.stringify([hindiOutage.outage_minutes, kannadaOutage.outage_minutes]),
);
test(
  "durations are read in every common form and negative ones are refused",
  promiseRules.parseDurationMinutes("1:30") === 90 &&
    promiseRules.parseDurationMinutes("2.5 hours") === 150 &&
    promiseRules.parseDurationMinutes("1 hour 5 mins") === 65 &&
    promiseRules.parseDurationMinutes("-2h") === null &&
    promiseRules.parseDurationMinutes("") === null,
);
console.log("      " + oneBlock.message + "\n      rule: " + withFailover.credit_rule);

// ---------------------------------------------------------------- consent (consent_manager)
console.log("\nconsent: three separate purposes, withdrawable (consent_manager)");
const consentManager = await loadFunctionTool("consent_manager.js");
const consentPurposes = ["registry_lookup", "kyc_verification", "marketing"];
const consentScreens = {};
for (const language of ["en", "hi", "kn"]) {
  consentScreens[language] = (await runTool(consentManager, { mode: "show", lang: language })).outputVars;
}
test(
  "the consent screen asks separately for registry lookup, KYC verification and marketing",
  JSON.stringify((parseOrNull(consentScreens.en.consent_options_json) || []).map((option) => option.id)) ===
    JSON.stringify(consentPurposes),
  consentScreens.en.consent_options_json,
);
test(
  "the consent screen is in the customer's language (English, Hindi, Kannada) and says how to withdraw",
  /withdraw/i.test(consentScreens.en.consent_screen_text) &&
    /[ऀ-ॿ]/.test(consentScreens.hi.consent_screen_text) &&
    consentScreens.hi.consent_screen_text.includes("वापस") &&
    /[ಀ-೿]/.test(consentScreens.kn.consent_screen_text) &&
    consentScreens.kn.consent_screen_text.includes("ಹಿಂಪಡೆ"),
);
const nothingAnswered = (await runTool(consentManager, { mode: "check" })).outputVars;
const emptyRecordShown = parseOrNull(nothingAnswered.consent_record_json);
test(
  "nothing is granted by default: a real, empty consent record (not a crash returning empty defaults)",
  nothingAnswered.error === "" &&
    !nothingAnswered.consent_registry_lookup &&
    !nothingAnswered.consent_kyc_verification &&
    !nothingAnswered.consent_marketing &&
    !!emptyRecordShown &&
    nothingAnswered.consent_version !== "" &&
    emptyRecordShown.version === nothingAnswered.consent_version &&
    consentPurposes.every((purpose) => emptyRecordShown.purposes[purpose].granted === false) &&
    emptyRecordShown.history.length === 0,
  JSON.stringify(nothingAnswered),
);
const onlyRegistry = (await runTool(consentManager, { mode: "record", registry_lookup: "yes", marketing: "maybe" }))
  .outputVars;
test(
  "each purpose is granted only by its own explicit yes (unclear answers change nothing)",
  onlyRegistry.consent_registry_lookup === true &&
    onlyRegistry.consent_kyc_verification === false &&
    onlyRegistry.consent_marketing === false &&
    parseOrNull(onlyRegistry.consent_record_json)?.history?.length === 1,
  onlyRegistry.consent_record_json,
);
const allThree = (
  await runTool(consentManager, {
    mode: "record",
    consent_record_json: onlyRegistry.consent_record_json,
    kyc_verification: "हाँ",
    marketing: "ಹೌದು",
    lang: "hi",
  })
).outputVars;
test(
  "answers are recorded with a timestamp and the consent version, in any of the three languages",
  allThree.consent_kyc_verification === true &&
    allThree.consent_marketing === true &&
    allThree.consent_version !== "" &&
    !Number.isNaN(Date.parse(allThree.consent_updated_at)) &&
    /[ऀ-ॿ]/.test(allThree.message),
  allThree.message,
);
const marketingWithdrawn = (
  await runTool(consentManager, {
    mode: "withdraw",
    purpose: "stop the whatsapp offers",
    consent_record_json: allThree.consent_record_json,
  })
).outputVars;
const marketingHistory = parseOrNull(marketingWithdrawn.consent_record_json)?.history || [];
test(
  "withdrawing one purpose stops only that purpose and keeps the history",
  marketingWithdrawn.consent_marketing === false &&
    marketingWithdrawn.consent_registry_lookup === true &&
    marketingWithdrawn.consent_kyc_verification === true &&
    marketingHistory.length === 4 &&
    marketingHistory[3].purpose === "marketing" &&
    marketingHistory[3].granted === false,
  marketingWithdrawn.consent_record_json,
);
const kycWithdrawnKannada = (
  await runTool(consentManager, {
    mode: "withdraw",
    purpose: "kyc",
    consent_record_json: marketingWithdrawn.consent_record_json,
    lang: "kn",
  })
).outputVars;
test(
  "withdrawing KYC verification is confirmed in Kannada and says what it changes",
  kycWithdrawnKannada.consent_kyc_verification === false && /[ಀ-೿]/.test(kycWithdrawnKannada.message),
  kycWithdrawnKannada.message,
);
const unclearWithdraw = (await runTool(consentManager, { mode: "withdraw", purpose: "everything?" })).outputVars;
test(
  "an unclear withdrawal asks which purpose instead of guessing",
  unclearWithdraw.message.includes("registry lookup") && unclearWithdraw.error === "",
  unclearWithdraw.message,
);
const unknownMode = (await runToolExpectingError(consentManager, { mode: "delete-all" })).outputVars;
test("an unknown mode is an error", unknownMode.error !== "");

// ---------------------------------------------------------------- Smart KYC fallback (demo page scripts)
// The page's generated scripts are loaded exactly as the browser loads them (classic scripts setting window.*).
console.log("\nsmart KYC fallback: certificate reader, onboarding wrapper, samples (7_demo_site)");
const demoSiteDirectory = path.join(testDirectory, "..", "7_demo_site");
const demoSandbox = { window: {} };
for (const script of ["consent_rules.js", "certificate_reader.js", "onboard_from_gstin.js", "sample_certificates.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(demoSiteDirectory, script), "utf8"), demoSandbox);
}
const reader = demoSandbox.window.CertificateReader;
/** The demo page's copy of onboarding; its calls are checked for errors like every other call. */
const pageOnboard = async (args) => {
  const pageResult = await demoSandbox.window.SaathiOnboard(args);
  expectNoError("onboard_from_gstin (demo page copy)", args.inputVars, pageResult.outputVars);
  return pageResult;
};
const certificateText = (gstin, legalName, tradeName, address) =>
  [
    "GST REGISTRATION CERTIFICATE (SAMPLE)",
    "Registration Number: " + gstin,
    "1. Legal Name: " + legalName,
    "2. Trade Name, if any: " + tradeName,
    "3. Constitution of Business: Private Limited Company",
    "4. Address of Principal Place of Business:",
    "    " + address,
    "5. Date of Liability: 2018-06-30",
  ].join("\n");
const metroText = certificateText(
  "07PUTXM1153M1Z9",
  "Metro Diagnostics Pvt Ltd",
  "Metro Diagnostics Pvt Ltd",
  "Shop/Unit 171, Market Yard, Delhi, Delhi - 291610",
);

const cleanRead = reader.parseCertificateText(metroText);
test(
  "a clean certificate gives the GSTIN, legal name, trade name and address",
  cleanRead.gstin === "07PUTXM1153M1Z9" &&
    cleanRead.checksumOk &&
    cleanRead.legalName === "Metro Diagnostics Pvt Ltd" &&
    cleanRead.tradeName === "Metro Diagnostics Pvt Ltd" &&
    cleanRead.address.includes("Delhi") &&
    cleanRead.isComplete &&
    cleanRead.corrections.length === 0,
  JSON.stringify(cleanRead),
);
const misread = reader.parseCertificateText(
  certificateText("O7PUTXM1I53M1Z9", "Metro Diagnostics Pvt Ltd", "", "Market Yard, Delhi"),
);
test(
  "OCR look-alikes (O for 0, I for 1) are fixed by position, checked by the checksum and listed for the owner",
  misread.gstin === "07PUTXM1153M1Z9" && misread.checksumOk && misread.corrections.length === 2,
  JSON.stringify(misread.corrections),
);
const letterMisread = reader.parseCertificateText("Registration Number: 290KAXP4077P1ZL");
test(
  "a 0 read where the PAN needs a letter becomes O (the misread seen in the browser run)",
  letterMisread.gstin === "29OKAXP4077P1ZL" && reader.describeCorrections(letterMisread.corrections) === "#3 0 → O",
  JSON.stringify(letterMisread),
);
const spaced = reader.parseCertificateText("GSTIN: 07 PUTXM 1153 M1Z9");
test("a GSTIN split by spaces is still found", spaced.gstin === "07PUTXM1153M1Z9" && spaced.checksumOk);
const wrongCheck = reader.parseCertificateText(certificateText("07PUTXM1153M1Z8", "A", "B", "C"));
test(
  "a GSTIN that fails its checksum is reported, not silently 'fixed'",
  wrongCheck.problems.includes("gstin_checksum_failed") && !wrongCheck.checksumOk && !wrongCheck.isComplete,
  JSON.stringify(wrongCheck),
);
const partialRead = reader.parseCertificateText("Some blurry text\nnothing useful");
test(
  "a photo with no readable fields lists every missing field",
  ["gstin_not_found", "legal_name_not_found", "address_not_found"].every((problem) =>
    partialRead.problems.includes(problem),
  ),
  JSON.stringify(partialRead.problems),
);
test(
  "names are compared ignoring Pvt/Ltd/Prop., and a proprietor's legal name matches the shop name",
  reader.compareNames("Metro Diagnostics Private Limited", "Metro Diagnostics Pvt Ltd") === "match" &&
    reader.compareNames("Sneha Rao (Prop. Saffron Bakers)", "Saffron Bakers") === "match" &&
    reader.compareNames("Sunrise Traders", "Saffron Bakers") === "no_match",
);
test(
  "the address must mention the registry city",
  reader.addressMentionsCity("Market Yard, Ludhiana, Punjab", "Ludhiana") &&
    !reader.addressMentionsCity("Market Yard, Delhi", "Ludhiana"),
);

// Checksum-guided correction (outside review, 2026-11-05: GSTIN right on 8 of 12 case certificates).
const GSTIN_CHARACTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The one check character that makes these 14 characters a valid GSTIN (found through the reader's own check). */
const checkCharacterFor = (firstFourteen) =>
  Array.from(GSTIN_CHARACTERS).find((character) => reader.isValidGstin(firstFourteen + character)) || "";
/** Synthetic first 14 characters ("27AAAXA" + 4 digits + "A1Z") whose check character is `wanted`. */
const firstFourteenWithCheck = (wanted) => {
  for (let serial = 0; serial < 10000; serial++) {
    const firstFourteen = "27AAAXA" + String(serial).padStart(4, "0") + "A1Z";
    if (checkCharacterFor(firstFourteen) === wanted) return firstFourteen;
  }
  return "";
};
const checkCharacterMisread = reader.parseCertificateText("GSTIN 36KGNXV2255R1Z0");
test(
  "a check character misread as its look-alike (0 for O) is fixed when exactly one reading passes, and listed",
  checkCharacterMisread.gstin === "36KGNXV2255R1ZO" &&
    checkCharacterMisread.checksumOk &&
    reader.describeCorrections(checkCharacterMisread.corrections) === "#15 0 → O",
  JSON.stringify(checkCharacterMisread),
);
const pairResults = [];
for (const [first, second] of reader.OCR_CONFUSION_PAIRS) {
  for (const [printed, misread] of [
    [first, second],
    [second, first],
  ]) {
    const firstFourteen = firstFourteenWithCheck(printed);
    const read = reader.parseCertificateText("GSTIN: " + firstFourteen + misread);
    pairResults.push([printed + " read as " + misread, read.gstin === firstFourteen + printed && read.checksumOk]);
  }
}
test(
  "every OCR confusion pair is tried both ways at the check character, and the checksum picks the printed one",
  pairResults.every(([, fixed]) => fixed),
  JSON.stringify(pairResults.filter(([, fixed]) => !fixed)),
);
/** "27AA?XA" + serial + "A1Z" with ? = I and = L: a case where only the L reading has a check character to match. */
const letterOneCase = (() => {
  for (let serial = 0; serial < 10000; serial++) {
    const digits = String(serial).padStart(4, "0");
    const withL = "27AALXA" + digits + "A1Z";
    const check = checkCharacterFor(withL);
    const withI = "27AAIXA" + digits + "A1Z";
    if (checkCharacterFor(withI) !== check && !/[O0IL1S5B8Z2G6]/.test(check)) return { withL, check, digits };
  }
  return null;
})();
const letterOneRead = reader.parseCertificateText(
  "GSTIN " + letterOneCase.withL.replace("AAL", "AA1") + letterOneCase.check,
);
test(
  "a 1 read where the PAN needs a letter tries both I and L, and the checksum picks L",
  letterOneRead.gstin === letterOneCase.withL + letterOneCase.check && letterOneRead.checksumOk,
  JSON.stringify(letterOneRead),
);
/**
 * A case where both the I and the L reading of a "1" pass: their check characters are an OCR confusion pair, so the
 * check character as read fits both (L is 3 places after I, which moves the check character 3 places: B and 8).
 */
const isConfusionPair = (first, second) =>
  reader.OCR_CONFUSION_PAIRS.some(
    ([one, other]) => (one === first && other === second) || (one === second && other === first),
  );
const twoReadingsCase = (() => {
  for (let serial = 0; serial < 10000; serial++) {
    const digits = String(serial).padStart(4, "0");
    const checkI = checkCharacterFor("27AAIXA" + digits + "A1Z");
    const checkL = checkCharacterFor("27AALXA" + digits + "A1Z");
    if (isConfusionPair(checkI, checkL)) return { digits, checkI };
  }
  return null;
})();
const twoReadings = twoReadingsCase
  ? reader.parseCertificateText("GSTIN 27AA1XA" + twoReadingsCase.digits + "A1Z" + twoReadingsCase.checkI)
  : null;
test(
  "when two readings pass the checksum, nothing is filled in and the owner is asked to choose between them",
  twoReadings !== null &&
    twoReadings.gstin === "" &&
    !twoReadings.checksumOk &&
    twoReadings.gstinCandidates.length === 2 &&
    twoReadings.problems.includes("gstin_ambiguous") &&
    reader.readerText("en").problems.gstin_ambiguous.includes("{candidates}"),
  JSON.stringify(twoReadings),
);
const tamperedRead = reader.parseCertificateText("GSTIN 08YKZXS8189L1Z0");
test(
  "a GSTIN no reading can fix (a changed digit, as on case certificate K06) is shown as read, and the owner is asked",
  tamperedRead.gstin === "08YKZXS8189L1Z0" &&
    !tamperedRead.checksumOk &&
    tamperedRead.problems.includes("gstin_checksum_failed") &&
    /type it/.test(reader.readerText("en").problems.gstin_checksum_failed),
  JSON.stringify(tamperedRead),
);
const electricityBill = reader.parseCertificateText(
  "Specimen: Electricity Bill\nConsumer no. 9485717625\nBill date 2026-06-26\nUnits consumed 2203",
);
test(
  "corrections are tried only on the GSTIN line: a bill date is never bent into a GSTIN (case bills K01, K02, K04, K08)",
  electricityBill.gstin === "" && electricityBill.problems.includes("gstin_not_found"),
  JSON.stringify(electricityBill),
);
const unlabelledExact = reader.parseCertificateText("Supplier: Metro Diagnostics 07PUTXM1153M1Z9");
const unlabelledMisread = reader.parseCertificateText("Supplier: Metro Diagnostics O7PUTXM1I53M1Z9");
test(
  "a GSTIN written exactly is found on any line, but one that needs corrections only on the GSTIN line",
  unlabelledExact.gstin === "07PUTXM1153M1Z9" && unlabelledMisread.gstin === "",
  JSON.stringify([unlabelledExact.gstin, unlabelledMisread.gstin]),
);
const labelAbove = reader.parseCertificateText("GSTIN\nO7PUTXM1I53M1Z9\nLegal name Metro Diagnostics Pvt Ltd");
test(
  "a GSTIN on the line under a label that stands alone is read and corrected",
  labelAbove.gstin === "07PUTXM1153M1Z9" && labelAbove.checksumOk,
  JSON.stringify(labelAbove),
);
const garbled = reader.gstinReadings("271111112345" + "1Z1");
test(
  "a line with too many possible readings (here 192) is never trusted to the checksum",
  garbled.tooMany === true && garbled.valid.length === 0,
  JSON.stringify(garbled),
);

const AS_OF = "2026-07-15";
const onboardInputs = (gstin, language) => ({
  inputVars: { gstin, consent_given: "yes", lang: language || "en", show_card: "no", as_of_date: AS_OF },
});
const sameAsChat = [];
for (const gstin of ["07PUTXM1153M1Z9", "03PJNXS4821G1ZB", "29OKAXP4077P1ZL", "07PUTXM1153M1Z8"]) {
  const fromPage = JSON.stringify((await pageOnboard(onboardInputs(gstin))).outputVars);
  const fromFunction = JSON.stringify((await runTool(onboardFromGstin, onboardInputs(gstin).inputVars)).outputVars);
  sameAsChat.push(fromPage === fromFunction);
}
test(
  "the page checks a read GSTIN with exactly the same onboarding code as the chat",
  sameAsChat.every(Boolean),
  JSON.stringify(sameAsChat),
);
const verdictFor = async (text, language) =>
  reader.kycVerdict(
    reader.parseCertificateText(text),
    (await pageOnboard(onboardInputs(reader.parseCertificateText(text).gstin, language))).outputVars,
    language || "en",
  );
const verifiedVerdict = await verdictFor(metroText);
test(
  "a certificate that matches an active registration is verified",
  verifiedVerdict.verdict === "verified" && verifiedVerdict.nameResult === "match" && verifiedVerdict.cityMatches,
  JSON.stringify(verifiedVerdict),
);
const proprietorVerdict = await verdictFor(
  certificateText(
    "03PJNXS4821G1ZB",
    "Sneha Rao (Prop. Saffron Bakers)",
    "Saffron Bakers",
    "Shop/Unit 83, Market Yard, Ludhiana, Punjab - 416059",
  ),
);
test("a proprietorship certificate is verified by its trade name", proprietorVerdict.verdict === "verified");
const cancelledVerdict = await verdictFor(
  certificateText("29OKAXP4077P1ZL", "Ishita Menon", "Prime General Store", "Civil Lines, Bengaluru"),
  "hi",
);
test(
  "a cancelled registration read from a certificate is blocked, with the message in the owner's language",
  cancelledVerdict.verdict === "blocked" &&
    cancelledVerdict.message.includes("Cancelled") &&
    /[ऀ-ॿ]/.test(cancelledVerdict.message),
  JSON.stringify(cancelledVerdict),
);
const mismatchVerdict = await verdictFor(
  certificateText("07PUTXM1153M1Z9", "Sunrise Traders", "Sunrise Traders", "MG Road, Pune"),
);
test(
  "a certificate whose name and city don't match the registry goes to an advisor",
  mismatchVerdict.verdict === "review" &&
    mismatchVerdict.reasons.includes("name_no_match") &&
    mismatchVerdict.reasons.includes("city_mismatch"),
  JSON.stringify(mismatchVerdict),
);
const typoVerdict = await verdictFor(certificateText("07PUTXM1153M1Z8", "Metro Diagnostics", "", "Delhi"));
test("a GSTIN that fails the check is sent back to be corrected", typoVerdict.verdict === "fix_gstin");
const unregisteredGstin = Array.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
  .map((character) => "27AAAXA0000A1Z" + character)
  .find((candidate) => reader.isValidGstin(candidate));
const unregisteredVerdict = reader.kycVerdict(
  reader.parseCertificateText(certificateText(unregisteredGstin, "Ghost Traders", "", "Pune")),
  (await pageOnboard(onboardInputs(unregisteredGstin))).outputVars,
  "en",
);
test(
  "a valid GSTIN that isn't in the registry is never verified",
  unregisteredVerdict.verdict !== "verified",
  JSON.stringify(unregisteredVerdict),
);
const englishKeys = (object, prefix) =>
  Object.keys(object).flatMap((key) =>
    typeof object[key] === "object" ? englishKeys(object[key], prefix + key + ".") : [prefix + key],
  );
const valueAt = (object, keyPath) => keyPath.split(".").reduce((value, key) => (value || {})[key], object);
test(
  "every reader, consent and promise text exists in English, Hindi and Kannada",
  ["hi", "kn"].every(
    (language) =>
      englishKeys(reader.READER_TEXT.en, "").every((key) => valueAt(reader.READER_TEXT[language], key)) &&
      englishKeys(demoSandbox.window.ConsentRules.CONSENT_TEXT.en, "").every((key) =>
        valueAt(demoSandbox.window.ConsentRules.CONSENT_TEXT[language], key),
      ) &&
      englishKeys(promiseRules.PROMISE_MESSAGES.en, "").every((key) =>
        valueAt(promiseRules.PROMISE_MESSAGES[language], key),
      ),
  ),
);
test(
  "the page's consent screen is the same code and text as the chat's consent_manager",
  demoSandbox.window.ConsentRules.consentScreen("kn").chatText === consentScreens.kn.consent_screen_text,
);
const samples = demoSandbox.window.SAMPLE_CERTIFICATES;
test(
  "2–3 sample certificates are offered, each labelled SAMPLE and tied to a valid registry GSTIN",
  samples.length >= 2 &&
    samples.length <= 3 &&
    samples.every((sample) => sample.label.includes("SAMPLE") && reader.isValidGstin(sample.gstin)),
  JSON.stringify(samples.map((sample) => [sample.label, sample.gstin])),
);
const imageProblems = [];
for (const sample of samples) {
  const fileBytes = fs.existsSync(path.join(demoSiteDirectory, sample.file))
    ? fs.readFileSync(path.join(demoSiteDirectory, sample.file))
    : Buffer.alloc(0);
  const image = readPngGreyscale(fileBytes);
  const embeddedBytes = Buffer.from(sample.dataUrl.replace("data:image/png;base64,", ""), "base64");
  if (!image) imageProblems.push(`${sample.file}: not a readable PNG`);
  else {
    if (image.width < READABLE_CERTIFICATE.minWidth || image.height < READABLE_CERTIFICATE.minHeight)
      imageProblems.push(`${sample.file}: ${image.width}×${image.height} is too small to read`);
    const ink = inkShare(image);
    if (ink < READABLE_CERTIFICATE.minInkShare || ink > READABLE_CERTIFICATE.maxInkShare)
      imageProblems.push(`${sample.file}: ${(ink * 100).toFixed(2)}% dark pixels, not a printed page`);
  }
  if (!embeddedBytes.equals(fileBytes)) imageProblems.push(`${sample.file}: the page's copy differs from the file`);
}
test(
  "the sample certificate files are real, readable images with printed text, and the page shows the same images",
  samples.length > 0 && imageProblems.length === 0,
  imageProblems.join(" | "),
);

// ---------------------------------------------------------------- reading a GSTIN from the owner's message
// One shared reader (_build/gstin_input.js) is embedded in onboard_from_gstin, verify_gstin, verify_gstin_lite and the
// demo page. The owner's whole message may be passed in. Sample GSTINs are SYNTHETIC (case registry).
console.log("\nreading a GSTIN from the owner's message (shared gstin_input)");
const ACTIVE_SAMPLE = "07PUTXM1153M1Z9";
const CANCELLED_SAMPLE = "29OKAXP4077P1ZL";
const STATUS_CODE_PATTERN =
  /\b(INVALID_FORMAT|INVALID_STATE|CHECKSUM_FAILED|NOT_FOUND|MULTIPLE_GSTINS|FORMAT_OK|CONSENT_NEEDED)\b/;
const onboardWith = (gstin, language) =>
  runTool(onboardFromGstin, { gstin, consent_given: "yes", lang: language || "en", as_of_date: "2026-07-15" });
const gstinReaders = {
  onboard_from_gstin: async (gstin, language) => (await onboardWith(gstin, language)).outputVars,
  verify_gstin: async (gstin, language) =>
    (await runTool(verifyGstin, { consent_given: "yes", gstin, lang: language || "en" })).outputVars,
  verify_gstin_lite: async (gstin, language) =>
    (await runTool(verifyGstinLite, { consent_given: "yes", gstin, lang: language || "en" })).outputVars,
};
/** The GSTIN each tool reports having read, in the same form for all three (lite has no registry: FORMAT_OK). */
const readStatus = (outputs) => outputs.gstin_status;
const isUsable = (name, outputs) =>
  outputs.error === "" &&
  outputs.gstin_masked === "07PUT•••••••1Z9" &&
  (name === "verify_gstin_lite" ? outputs.gstin_status === "FORMAT_OK" : outputs.gstin_status === "Active");

for (const [form, typed] of [
  ["in a sentence", "my gstin is " + ACTIVE_SAMPLE],
  ["after a label", "GSTIN: " + ACTIVE_SAMPLE],
  ["in lowercase", ACTIVE_SAMPLE.toLowerCase()],
  ["with spaces", "07 PUTXM 1153 M1Z9"],
  ["with dashes", "07-PUTXM-1153-M1Z9"],
  ["inside a Hindi sentence", "मेरा GSTIN " + ACTIVE_SAMPLE + " है"],
]) {
  const results = {};
  for (const [name, reader] of Object.entries(gstinReaders)) results[name] = await reader(typed);
  test(
    `reads a GSTIN typed ${form} in all three tools`,
    Object.entries(results).every(([name, outputs]) => isUsable(name, outputs)),
    JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, o]) => [name, [readStatus(o), o.error]]))),
  );
}
const sentenceProposal = (await onboardWith("My GSTIN is " + ACTIVE_SAMPLE + ", please send a plan")).outputVars;
test(
  "a GSTIN in a sentence gets the same proposal as the GSTIN alone",
  sentenceProposal.next_action === "show_proposal" &&
    sentenceProposal.monthly_total === (await onboardWith(ACTIVE_SAMPLE)).outputVars.monthly_total &&
    sentenceProposal.business_name === "Metro Diagnostics Pvt Ltd",
  JSON.stringify([sentenceProposal.next_action, sentenceProposal.monthly_total, sentenceProposal.error]),
);

const twoGstins = "Shop GSTIN " + ACTIVE_SAMPLE + ", old one " + CANCELLED_SAMPLE;
const twoResults = {};
for (const [name, reader] of Object.entries(gstinReaders)) twoResults[name] = await reader(twoGstins);
test(
  "two different GSTINs in one message are reported, not guessed, by all three tools",
  Object.values(twoResults).every(
    (outputs) =>
      outputs.gstin_status === "MULTIPLE_GSTINS" &&
      outputs.gstin_masked === "" &&
      outputs.error === "" &&
      !outputs.gstin_ok &&
      !outputs.gstin_valid,
  ) && twoResults.onboard_from_gstin.next_action === "fix_gstin",
  JSON.stringify(Object.fromEntries(Object.entries(twoResults).map(([name, o]) => [name, o.gstin_status]))),
);
const twoMessage = twoResults.onboard_from_gstin.greeting;
test(
  "the two-GSTIN message lists both masked and asks which one, without showing either in full",
  twoMessage.includes("07PUT•••••••1Z9") &&
    twoMessage.includes("29OKA•••••••1ZL") &&
    /which one/i.test(twoMessage) &&
    !twoMessage.includes(ACTIVE_SAMPLE) &&
    !twoMessage.includes(CANCELLED_SAMPLE),
  twoMessage,
);
const sameTwice = (await onboardWith(ACTIVE_SAMPLE + " (yes, " + ACTIVE_SAMPLE + ")")).outputVars;
test("the same GSTIN typed twice counts as one", sameTwice.gstin_status === "Active", sameTwice.gstin_status);

for (const [form, typed] of [
  ["no GSTIN at all", "I run a bakery in Ludhiana"],
  ["an empty message", ""],
  ["only part of a GSTIN", "07PUTXM1153"],
]) {
  const results = {};
  for (const [name, reader] of Object.entries(gstinReaders)) results[name] = await reader(typed);
  test(
    `says clearly that no GSTIN was found for ${form}`,
    Object.values(results).every(
      (outputs) => outputs.gstin_status === "INVALID_FORMAT" && outputs.error === "" && outputs.gstin_masked === "",
    ) &&
      /couldn't find a complete GSTIN/.test(results.onboard_from_gstin.greeting) &&
      /couldn't find a complete GSTIN/.test(results.verify_gstin.kyc_message) &&
      !/doesn't look complete/.test(results.verify_gstin.kyc_message),
    results.onboard_from_gstin.greeting,
  );
}
const typoInSentence = (await onboardWith("gstin: 07PUTXM1153M1Z8 thanks")).outputVars;
test(
  "a GSTIN with a typo inside a sentence is found and its typo reported (not 'no GSTIN')",
  typoInSentence.gstin_status === "CHECKSUM_FAILED" && /typo/.test(typoInSentence.greeting),
  typoInSentence.greeting,
);

// No raw status code may reach anything the owner reads: every tool, every language, every kind of input.
const ownerFacingFields = ["greeting", "kyc_message", "clarifying_question", "quote_text", "why_text", "blocked_text"];
const leakedCodes = [];
const leakProbeInputs = [
  "",
  "hello",
  "my gstin is " + ACTIVE_SAMPLE,
  twoGstins,
  "07PUTXM1153M1Z8",
  "00FGDXG0862F1ZL",
  "27AAAXA0000A1Z5",
  CANCELLED_SAMPLE,
  "23QYBXS1811Q1ZD",
];
for (const language of ["en", "hi", "kn"]) {
  for (const typed of leakProbeInputs) {
    const runs = {
      onboard_from_gstin: await onboardWith(typed, language),
      verify_gstin: await runTool(verifyGstin, { consent_given: "yes", gstin: typed, lang: language }),
      verify_gstin_lite: await runTool(verifyGstinLite, { consent_given: "yes", gstin: typed, lang: language }),
    };
    for (const [name, result] of Object.entries(runs)) {
      const shown = ownerFacingFields
        .map((field) => result.outputVars[field] || "")
        .concat((result.trace || []).map((entry) => JSON.stringify(entry.payload || "")));
      if (shown.some((text) => STATUS_CODE_PATTERN.test(text))) leakedCodes.push(`${name}/${language}/${typed}`);
    }
  }
}
test(
  "no raw status code reaches the owner from any GSTIN tool, in any language",
  leakedCodes.length === 0,
  leakedCodes.join(" | "),
);

const gstinSandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(demoSiteDirectory, "gstin_input.js"), "utf8"), gstinSandbox);
const pageGstin = gstinSandbox.window.GstinInput;
const everyStatus = ["Active", "Cancelled", "Suspended", "NOT_FOUND", "FORMAT_OK"].concat(
  Object.values(pageGstin.GSTIN_PROBLEM),
  ["SOME_FUTURE_CODE"],
);
test(
  "every status (and an unknown future code) has friendly text in English, Hindi and Kannada",
  ["en", "hi", "kn"].every((language) =>
    everyStatus.every((status) => {
      const label = pageGstin.statusLabel(status, language);
      return label.length > 0 && !STATUS_CODE_PATTERN.test(label) && label.indexOf("SOME_FUTURE_CODE") < 0;
    }),
  ),
);
test(
  "the demo page's reader gives the same answer as the tools",
  pageGstin.readGstin("GSTIN: " + ACTIVE_SAMPLE.toLowerCase()).gstin === ACTIVE_SAMPLE &&
    pageGstin.readGstin(twoGstins).problem === "MULTIPLE_GSTINS" &&
    pageGstin.readGstin("hello").problem === "INVALID_FORMAT",
);
const blockedVerdict = demoSandbox.window.CertificateReader.kycVerdict(
  { legalName: "Ishita Menon", tradeName: "Prime General Store", address: "Bengaluru" },
  (await onboardWith(CANCELLED_SAMPLE, "kn")).outputVars,
  "kn",
);
test(
  "the page's blocked verdict names the registry status in the owner's language",
  blockedVerdict.verdict === "blocked" && blockedVerdict.message.includes("ರದ್ದು (Cancelled)"),
  blockedVerdict.message,
);

// One implementation: every generated copy carries exactly the code in _build/gstin_input.js. Line endings are
// ignored (the build writes Windows CRLF; the template is LF).
const withUnixLineEndings = (text) => text.replace(/\r\n/g, "\n");
const sharedReaderBody = withUnixLineEndings(
  fs.readFileSync(path.join(testDirectory, "..", "_build", "gstin_input.js"), "utf8"),
).replace("export const GSTIN_INPUT_API = {", "const GSTIN_INPUT_API = {");
const embedsSharedReader = (file) => withUnixLineEndings(fs.readFileSync(file, "utf8")).includes(sharedReaderBody);
const readerCopies = [
  path.join(testDirectory, "..", "3_function_tools", "onboard_from_gstin.js"),
  path.join(testDirectory, "..", "3_function_tools", "verify_gstin.js"),
  path.join(testDirectory, "..", "3_function_tools", "verify_gstin_lite.js"),
  path.join(demoSiteDirectory, "gstin_input.js"),
  path.join(demoSiteDirectory, "certificate_reader.js"),
  path.join(demoSiteDirectory, "onboard_from_gstin.js"),
];
sourceTextTest(
  "the GSTIN reader is one implementation, embedded unchanged in every tool and the demo page",
  readerCopies.every(embedsSharedReader),
  readerCopies.filter((file) => !embedsSharedReader(file)).join(", "),
);

// ---------------------------------------------------------------- first quote never overshoots (onboarding sizing)
// The first quote is the BASE bundle for the smallest sensible business in the segment; extras are add-ons that start
// switched off. Cases from the outside review; GSTINs are SYNTHETIC (case registry).
console.log("\nfirst quote never overshoots: smallest sensible business, extras as add-ons (onboard_from_gstin)");
const KIRANA_ONE_PERSON = "27VBLXG7653G1ZE";
const INSURANCE_FIVE_PEOPLE = "10FLCXE2345M1ZZ";
const firstQuote = async (gstin, extraInputs) =>
  (await runTool(onboardFromGstin, { gstin, consent_given: "yes", lang: "en", as_of_date: CASE_TODAY, ...extraInputs }))
    .outputVars;
const formatRupeesForTest = (amount) => "₹" + amount.toLocaleString("en-IN");
const quoteAt = async (proposal, changes) =>
  (await runTool(priceBundle, Object.assign(JSON.parse(proposal.pricing_inputs_json), changes))).outputVars;

const kirana = await firstQuote(KIRANA_ONE_PERSON);
const kiranaAtTrueSize = await quoteAt(kirana, { employees: "1", needs: "" });
test(
  "quotes the 1-person kirana from the review at its true-size price (₹999 fibre + ₹299 line = ₹1,298), not ₹2,196",
  kirana.next_action === "show_proposal" &&
    kirana.monthly_total === 1298 &&
    kirana.monthly_total === kiranaAtTrueSize.monthly_total &&
    kirana.error === "",
  JSON.stringify([kirana.monthly_total, kiranaAtTrueSize.monthly_total, kirana.pricing_inputs_json]),
);
const insurance = await firstQuote(INSURANCE_FIVE_PEOPLE);
const insuranceAtTrueSize = await quoteAt(insurance, { employees: "5", needs: "" });
test(
  "quotes the 5-person insurance agency from the review at its true-size price (₹3,269), not ₹5,789",
  insurance.monthly_total === 3269 &&
    insurance.monthly_total === insuranceAtTrueSize.monthly_total &&
    insurance.error === "",
  JSON.stringify([insurance.monthly_total, insuranceAtTrueSize.monthly_total]),
);

const factory = await firstQuote("29NIQXC0858S1ZK");
const chainAnswered = await firstQuote("27LRRXS3617L1ZA", { answer_sites: "3–5" });
const teamOf = (proposal) => JSON.parse(proposal.pricing_inputs_json).employees;
test(
  "sizes the first quote for the smallest team in the segment: shop 1, office 3, factory 12, chain 15",
  teamOf(kirana) === "1" && teamOf(insurance) === "3" && teamOf(factory) === "12" && teamOf(chainAnswered) === "15",
  JSON.stringify([teamOf(kirana), teamOf(insurance), teamOf(factory), teamOf(chainAnswered)]),
);
test(
  "prices the answer 3–5 locations as 3, the smallest in the range",
  JSON.parse(chainAnswered.pricing_inputs_json).sites === "3" && chainAnswered.bundle_name === "Chain Connect",
  chainAnswered.pricing_inputs_json,
);

// Every active GSTIN in the registry the tool carries: the first total must be the base bundle and nothing else.
// The registry list is read from the demo page's copy of onboarding: the same build, and never instrumented by
// mutation testing (which rewrites the source text of 3_function_tools).
const generatedOnboarding = fs.readFileSync(path.join(demoSiteDirectory, "onboard_from_gstin.js"), "utf8");
const registryStart = generatedOnboarding.indexOf('"', generatedOnboarding.indexOf("const REGISTRY_TEXT = "));
const registryEnd = generatedOnboarding.indexOf('";', registryStart);
const ACTIVE_STATUS_CODE = "A";
const activeGstins = JSON.parse(generatedOnboarding.slice(registryStart, registryEnd + 1))
  .split("\n")
  .map((line) => line.split("|"))
  .filter((fields) => fields[2] === ACTIVE_STATUS_CODE)
  .map((fields) => fields[0]);
/** The segment extras the review named (POS, failover, CCTV, machine sensors): never in a first total. */
const EXTRA_PRODUCTS_BY_SEGMENT = { micro: ["P19"], prof: ["P09"], multi: ["P23"], mfg: ["P24"] };
const extrasInFirstTotal = [];
let registryProposals = 0;
for (const gstin of activeGstins) {
  const proposal = await firstQuote(gstin, { show_card: "no" });
  if (proposal.next_action !== "show_proposal") continue;
  registryProposals++;
  const inputs = JSON.parse(proposal.pricing_inputs_json);
  const baseTotal = (await quoteAt(proposal, { needs: "" })).monthly_total;
  const extraProducts = EXTRA_PRODUCTS_BY_SEGMENT[inputs.segment] || [];
  if (
    inputs.needs !== "" ||
    proposal.monthly_total !== baseTotal ||
    JSON.parse(proposal.suggested_addons_json).some((addon) => addon.included) ||
    JSON.parse(proposal.items_json).some((item) => extraProducts.includes(item.id))
  ) {
    extrasInFirstTotal.push(gstin);
  }
}
test(
  `never includes an extra in the first total, for any of the ${activeGstins.length} active GSTINs in the registry`,
  registryProposals > 2000 && extrasInFirstTotal.length === 0,
  `${registryProposals} proposals; with extras: ${extrasInFirstTotal.slice(0, 5).join(", ")}`,
);

const kiranaAddons = JSON.parse(kirana.suggested_addons_json);
const kiranaWithPos = await quoteAt(kirana, { needs: "pos" });
test(
  "offers the shop's POS as an add-on that starts switched off, with a reason and its price from price_bundle",
  kiranaAddons.length === 1 &&
    kiranaAddons[0].need === "pos" &&
    kiranaAddons[0].included === false &&
    kiranaAddons[0].reason.length > 0 &&
    kiranaAddons[0].monthly_price === kiranaWithPos.monthly_total - kirana.monthly_total &&
    kiranaAddons[0].setup_price === kiranaWithPos.setup_total - kirana.setup_total &&
    kiranaAddons[0].items[0].name === "Cloud POS & Billing",
  kirana.suggested_addons_json,
);
const factoryAddons = JSON.parse(factory.suggested_addons_json);
test(
  "offers a factory's machine sensors as an add-on, not in the first total",
  factoryAddons.some((addon) => addon.need === "iot" && !addon.included) &&
    !JSON.parse(factory.items_json).some((item) => item.id === "P24"),
  factory.suggested_addons_json,
);
test(
  "the greeting names every suggested add-on with its price and says it is not in the price",
  [kirana, insurance, factory, chainAnswered].every((proposal) =>
    JSON.parse(proposal.suggested_addons_json).every(
      (addon) =>
        proposal.greeting.includes(addon.items[0].name) &&
        proposal.greeting.includes(formatRupeesForTest(addon.monthly_price)) &&
        /not in the price above/.test(proposal.greeting),
    ),
  ),
  kirana.greeting,
);

const assumptionProblems = [];
for (const gstin of [KIRANA_ONE_PERSON, INSURANCE_FIVE_PEOPLE, "29NIQXC0858S1ZK", "07PUTXM1153M1Z9"]) {
  for (const language of ["en", "hi", "kn"]) {
    const proposal = await firstQuote(gstin, { lang: language });
    const assumptions = JSON.parse(proposal.assumptions_json);
    const keys = assumptions.map((assumption) => assumption.key);
    const inputs = JSON.parse(proposal.pricing_inputs_json);
    const team = assumptions.find((assumption) => assumption.key === "team_size");
    const locations = assumptions.find((assumption) => assumption.key === "locations");
    const hasConnectionItem = JSON.parse(proposal.items_json).some((item) =>
      ["P01", "P02", "P03", "P05", "P06"].includes(item.id),
    );
    const ok =
      ["business_type", "team_size", "locations"].every((key) => keys.includes(key)) &&
      keys.includes("connection") === hasConnectionItem &&
      team.value.split("–")[0] === inputs.employees &&
      locations.value === inputs.sites &&
      assumptions.every((assumption) => proposal.greeting.includes(assumption.text)) &&
      proposal.greeting.includes(team.value);
    if (!ok) assumptionProblems.push(`${gstin}/${language}`);
  }
}
test(
  "the greeting states every assumption (business type, team size, locations, connection) in English, Hindi and Kannada",
  assumptionProblems.length === 0,
  assumptionProblems.join(", "),
);
test(
  "says the assumed team in plain words, like the review asked",
  /I've assumed a shop, a team of 1–2, 1 location and business fibre reaching your address\. Tell me if you're bigger/.test(
    kirana.greeting,
  ),
  kirana.greeting,
);

const insuranceTeam = JSON.parse(insurance.assumptions_json).find((assumption) => assumption.key === "team_size").value;
const insuranceTopOfRange = Number(insuranceTeam.split("–")[1]);
const atTopOfRange = await quoteAt(insurance, { employees: String(insuranceTopOfRange) });
const justAboveRange = await quoteAt(insurance, { employees: String(insuranceTopOfRange + 1) });
test(
  "the team range in the greeting is exactly what the same quote covers; a bigger team only costs more",
  atTopOfRange.monthly_total === insurance.monthly_total && justAboveRange.monthly_total > insurance.monthly_total,
  JSON.stringify([insuranceTeam, atTopOfRange.monthly_total, justAboveRange.monthly_total]),
);

// ---------------------------------------------------------------- knowledge base = pricing code (sizing rules)
// The sizing-rules section of the knowledge base is written by _build/kb_sizing_rules.mjs from the generated
// price_bundle.js. These tests rebuild it and compare, and spot-check the stated rules against price_bundle's behaviour.
console.log("\nknowledge base sizing rules come from the pricing code (kb_sizing_rules)");
const knowledgeBaseText = fs.readFileSync(
  path.join(testDirectory, "..", "4_knowledge_base", "saathi_bundles_and_rules.txt"),
  "utf8",
);
const expectedSection = await kbSizing.buildSizingSection(priceBundleSource);
const sectionInFile = kbSizing.readSection(knowledgeBaseText);
const firstDifference = (left, right) => {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const index = leftLines.findIndex((line, i) => line !== rightLines[i]);
  return index < 0 ? "" : `line ${index + 1}: file "${leftLines[index]}" vs code "${rightLines[index]}"`;
};
sourceTextTest(
  "the knowledge base's sizing rules are exactly what the pricing code writes today (rebuild if this fails)",
  sectionInFile !== "" && sectionInFile === expectedSection,
  sectionInFile ? firstDifference(sectionInFile, expectedSection) : "markers not found",
);
// Line endings are ignored: the file may be saved with Windows CRLF; readSection returns LF text.
const handWrittenPart = knowledgeBaseText.replace(/\r\n/g, "\n").replace(sectionInFile, "");
test(
  "no hand-written sizing claims are left outside the generated section",
  !/about one per 5 people|one per \d+ people|Fibre 100 \+ failover|\b1–2 Business Postpaid|teams of 8\+|₹\d/.test(
    handWrittenPart,
  ),
  (handWrittenPart.match(/about one per 5 people|one per \d+ people|Fibre 100 \+ failover|₹\d[\d,]*/) || [""])[0],
);

// The rules the knowledge base states hold in price_bundle's behaviour (numbers read from the same code, not typed).
const itemsFor = async (inputs) =>
  JSON.parse(
    (await runTool(priceBundle, Object.assign({ has_gstin: "yes", city: "Delhi" }, inputs))).outputVars.items_json,
  );
const quantityOf = (items, productId) => (items.find((item) => item.id === productId) || { qty: 0 }).qty;
const { THRESHOLDS: pricingLimits, SIZING: pricingSizing, PRODUCT: productId } = pricingCode;
const smallOffice = await itemsFor({
  business_type: "Clinic",
  employees: String(pricingLimits.maxEmployeesForBizFibre100InOffices),
});
const biggerOffice = await itemsFor({
  business_type: "Clinic",
  employees: String(pricingLimits.maxEmployeesForBizFibre100InOffices + 1),
});
test(
  "as the knowledge base says: offices up to the limit get Biz Fibre 100, one more person gets Biz Fibre 300",
  quantityOf(smallOffice, productId.BIZ_FIBRE_100) === 1 && quantityOf(biggerOffice, productId.BIZ_FIBRE_300) === 1,
);
const tinyOffice = await itemsFor({ business_type: "Clinic", employees: "3" });
test(
  "as the knowledge base says: a 3-person office still gets the minimum number of lines",
  quantityOf(tinyOffice, productId.POSTPAID_599) === pricingSizing.minLines.prof,
  JSON.stringify(tinyOffice),
);
const failoverTeam = pricingLimits.officeTeamSizeForDefaultFailover;
test(
  "as the knowledge base says: failover is included from the stated team size, not below it",
  quantityOf(await itemsFor({ business_type: "Clinic", employees: String(failoverTeam) }), productId.FAILOVER_4G_5G) ===
    1 &&
    quantityOf(
      await itemsFor({ business_type: "Clinic", employees: String(failoverTeam - 1) }),
      productId.FAILOVER_4G_5G,
    ) === 0,
);
const chainSites = 4;
const perSiteLimit = pricingLimits.employeesPerSiteNeedingBizFibre300;
test(
  "as the knowledge base says: a chain gets Biz Fibre 300 per site only above the stated people per site",
  quantityOf(
    await itemsFor({
      business_type: "Restaurant chain",
      sites: String(chainSites),
      employees: String(perSiteLimit * chainSites),
    }),
    productId.BIZ_FIBRE_100,
  ) === chainSites &&
    quantityOf(
      await itemsFor({
        business_type: "Restaurant chain",
        sites: String(chainSites),
        employees: String((perSiteLimit + 1) * chainSites),
      }),
      productId.BIZ_FIBRE_300,
    ) === chainSites,
);

// ---------------------------------------------------------------- verify_gstin enforces consent in code
console.log("\nverify_gstin enforces registry-lookup consent in code");
const CONSENT_SAMPLE = "07PUTXM1153M1Z9";
const verifyWithConsent = async (tool, consentGiven, language) =>
  (
    await runTool(tool, {
      gstin: CONSENT_SAMPLE,
      business_name: "Metro Diagnostics",
      lang: language || "en",
      ...consentGiven,
    })
  ).outputVars;
const lookedUpNothing = (outputs) =>
  outputs.gstin_status === "CONSENT_NEEDED" &&
  !outputs.gstin_ok &&
  outputs.trade_name === "" &&
  outputs.legal_name === "" &&
  outputs.gst_state === "" &&
  outputs.gstin_masked === "" &&
  outputs.error === "" &&
  !outputs.kyc_message.includes("Metro");
const missingConsent = await verifyWithConsent(verifyGstin, {});
test(
  "looks nothing up when consent is missing, and asks for it in plain words",
  lookedUpNothing(missingConsent) && /need your OK to look it up/.test(missingConsent.kyc_message),
  JSON.stringify(missingConsent),
);
const withdrawnResults = [];
for (const withdrawn of ["no", "false", "withdrawn", "maybe", " "]) {
  withdrawnResults.push(lookedUpNothing(await verifyWithConsent(verifyGstin, { consent_given: withdrawn })));
  withdrawnResults.push(lookedUpNothing(await verifyWithConsent(verifyGstinLite, { consent_given: withdrawn })));
}
test(
  "looks nothing up when consent was withdrawn or is unclear (no, false, withdrawn, maybe), in both builds",
  withdrawnResults.every(Boolean),
  JSON.stringify(withdrawnResults),
);
const grantedFull = await verifyWithConsent(verifyGstin, { consent_given: "yes" });
const grantedAsTrue = await verifyWithConsent(verifyGstin, { consent_given: "true" });
const grantedLite = await verifyWithConsent(verifyGstinLite, { consent_given: "yes" });
test(
  "verifies normally once consent is granted (yes, or true as consent_manager reports it)",
  grantedFull.gstin_ok &&
    grantedFull.trade_name === "Metro Diagnostics Pvt Ltd" &&
    grantedAsTrue.gstin_ok &&
    grantedAsTrue.gstin_status === "Active" &&
    grantedLite.gstin_ok &&
    grantedLite.gstin_status === "FORMAT_OK",
  JSON.stringify([grantedFull.gstin_status, grantedAsTrue.gstin_status, grantedLite.gstin_status]),
);
const missingConsentHindi = await verifyWithConsent(verifyGstin, {}, "hi");
test(
  "asks for consent in Hindi, without showing a status code",
  lookedUpNothing(missingConsentHindi) &&
    /अनुमति/.test(missingConsentHindi.kyc_message) &&
    !/CONSENT_NEEDED/.test(missingConsentHindi.kyc_message),
  missingConsentHindi.kyc_message,
);

// ---------------------------------------------------------------- mutation-testing follow-up: rules no test pinned
// Stryker (npm run test:mutation) showed these business rules could be changed without any test failing. Each test
// below states the rule and checks it through the real tool. Rule tables (keywords, profiles) are read from the
// generated tool in a sandbox and every entry is checked one by one.
console.log("\nmutation-testing follow-up: rules no test pinned down before");
/** Named constants of a generated tool, read by running the file in a sandbox (same technique as kb_sizing_rules). */
function readInternals(fileName, names) {
  const source = fs.readFileSync(path.join(testDirectory, "..", "3_function_tools", fileName), "utf8");
  const sandbox = { captured: null };
  vm.runInNewContext(
    source.replace("export default async function main(args) {", "async function main(args) {") +
      `\ncaptured = { ${names.join(", ")} };\n`,
    sandbox,
  );
  return sandbox.captured;
}
const pricingTables = readInternals("price_bundle.js", ["NEED_KEYWORDS", "SEGMENT_KEYWORDS", "MESSAGES"]);
const product = pricingCode.PRODUCT;
const catalogue = pricingCode.PRODUCTS_BY_ID;
const quoteFor = async (inputs) => (await runTool(priceBundle, { lang: "en", show_card: "no", ...inputs })).outputVars;
const quantityIn = (quote, productCode) =>
  ((parseOrNull(quote.items_json) || []).find((item) => item.id === productCode) || { qty: 0 }).qty;
const hasItem = (quote, productCode) => quantityIn(quote, productCode) > 0;

// price_bundle: eligibility rules from the catalogue.
const leasedLineMinimum = catalogue[product.LEASED_LINE_20].minimumEmployees;
const factoryJustBelow = await quoteFor({
  business_type: "Textile unit",
  city: "Surat",
  employees: String(leasedLineMinimum - 1),
  has_gstin: "yes",
});
const factoryAtMinimum = await quoteFor({
  business_type: "Textile unit",
  city: "Surat",
  employees: String(leasedLineMinimum),
  has_gstin: "yes",
});
test(
  "a leased line needs its catalogue minimum team: one person fewer gets fibre with failover instead",
  !hasItem(factoryJustBelow, product.LEASED_LINE_20) &&
    hasItem(factoryJustBelow, product.BIZ_FIBRE_300) &&
    hasItem(factoryJustBelow, product.FAILOVER_4G_5G) &&
    hasItem(factoryAtMinimum, product.LEASED_LINE_20),
  JSON.stringify([factoryJustBelow.items_json, factoryAtMinimum.items_json]),
);
test(
  "a managed firewall below its minimum team is left out and the quote says why",
  !hasItem(factoryJustBelow, product.MANAGED_FIREWALL) &&
    factoryJustBelow.blocked_text.includes(catalogue[product.MANAGED_FIREWALL].name) &&
    factoryJustBelow.blocked_text.includes(String(catalogue[product.MANAGED_FIREWALL].minimumEmployees)),
  factoryJustBelow.blocked_text,
);
const sdwanMinimumSites = catalogue[product.MANAGED_SD_WAN].minimumSites;
const twoSiteChain = await quoteFor({
  segment: "chain",
  business_type: "Pharmacy chain",
  city: "Pune",
  employees: "20",
  sites: String(sdwanMinimumSites - 1),
  has_gstin: "yes",
  needs: "sd-wan",
});
const threeSiteChain = await quoteFor({
  segment: "chain",
  business_type: "Pharmacy chain",
  city: "Pune",
  employees: "20",
  sites: String(sdwanMinimumSites),
  has_gstin: "yes",
  needs: "sd-wan",
});
test(
  "SD-WAN needs its minimum number of sites: refused (with the reason) below it, one per site at it",
  !hasItem(twoSiteChain, product.MANAGED_SD_WAN) &&
    twoSiteChain.blocked_text.includes(catalogue[product.MANAGED_SD_WAN].name) &&
    twoSiteChain.blocked_text.includes(String(sdwanMinimumSites)) &&
    quantityIn(threeSiteChain, product.MANAGED_SD_WAN) === sdwanMinimumSites,
  JSON.stringify([twoSiteChain.blocked_text, threeSiteChain.items_json]),
);
const officeWithoutFibre = await quoteFor({
  business_type: "Clinic",
  city: "Delhi",
  employees: "4",
  has_gstin: "yes",
  fibre_available: "no",
  needs: "failover, static ip",
});
test(
  "failover and a static IP need a fibre or leased-line connection: with 5G AirFiber they are refused, with the reason",
  hasItem(officeWithoutFibre, product.AIRFIBER_5G) &&
    !hasItem(officeWithoutFibre, product.FAILOVER_4G_5G) &&
    !hasItem(officeWithoutFibre, product.STATIC_IP) &&
    officeWithoutFibre.blocked_text.includes(catalogue[product.FAILOVER_4G_5G].name) &&
    officeWithoutFibre.blocked_text.includes(catalogue[product.STATIC_IP].name),
  JSON.stringify([officeWithoutFibre.items_json, officeWithoutFibre.blocked_text]),
);
const fastOfficeTier2 = await quoteFor({
  business_type: "Clinic",
  city: "Lucknow",
  employees: "10",
  has_gstin: "yes",
  needs: "high speed",
});
const fastOfficeTier1 = await quoteFor({
  business_type: "Clinic",
  city: "Delhi",
  employees: "10",
  has_gstin: "yes",
  needs: "high speed",
});
test(
  "top-speed fibre (1 Gbps) is sold only in tier-1 cities; elsewhere the office gets 300 Mbps",
  hasItem(fastOfficeTier1, product.BIZ_FIBRE_1G) &&
    !hasItem(fastOfficeTier2, product.BIZ_FIBRE_1G) &&
    hasItem(fastOfficeTier2, product.BIZ_FIBRE_300),
  JSON.stringify([fastOfficeTier1.items_json, fastOfficeTier2.items_json]),
);

// price_bundle: the connection when fibre doesn't reach, per segment, and the leased-line-100 boundary.
const chainWithoutFibre = await quoteFor({
  business_type: "Restaurant chain",
  city: "Mumbai",
  employees: "30",
  sites: "3",
  has_gstin: "yes",
  fibre_available: "no",
});
const factoryWithoutFibre = await quoteFor({
  business_type: "Textile unit",
  city: "Surat",
  employees: "30",
  has_gstin: "yes",
  fibre_available: "no",
});
const factoryWithoutFibreOrGstin = await quoteFor({
  business_type: "Textile unit",
  city: "Surat",
  employees: "30",
  has_gstin: "no",
  fibre_available: "no",
});
test(
  "without fibre: an office and every site of a chain get 5G AirFiber; a factory gets a leased line, or AirFiber without GSTIN",
  hasItem(officeWithoutFibre, product.AIRFIBER_5G) &&
    quantityIn(chainWithoutFibre, product.AIRFIBER_5G) === 3 &&
    !hasItem(chainWithoutFibre, product.BIZ_FIBRE_100) &&
    hasItem(factoryWithoutFibre, product.LEASED_LINE_20) &&
    hasItem(factoryWithoutFibreOrGstin, product.AIRFIBER_5G) &&
    !hasItem(factoryWithoutFibreOrGstin, product.LEASED_LINE_20),
  JSON.stringify([chainWithoutFibre.items_json, factoryWithoutFibre.items_json, factoryWithoutFibreOrGstin.items_json]),
);
const leased100Minimum = pricingCode.THRESHOLDS.employeesForLeasedLine100;
const askedForLeasedAt = async (employees) =>
  quoteFor({
    business_type: "Textile unit",
    city: "Surat",
    employees: String(employees),
    has_gstin: "yes",
    needs: "leased",
  });
const leasedAtMinimum = await askedForLeasedAt(leased100Minimum);
const leasedJustBelow = await askedForLeasedAt(leased100Minimum - 1);
test(
  "a factory asking for a leased line gets the 100 Mbps line from the stated team size, the 20 Mbps line below it",
  hasItem(leasedAtMinimum, product.LEASED_LINE_100) &&
    !hasItem(leasedJustBelow, product.LEASED_LINE_100) &&
    hasItem(leasedJustBelow, product.LEASED_LINE_20),
  JSON.stringify([leasedAtMinimum.items_json, leasedJustBelow.items_json]),
);

// price_bundle: segment rules and their boundaries.
const bundleOf = async (inputs) => (await quoteFor({ city: "Delhi", has_gstin: "yes", ...inputs })).bundle_name;
const segmentBundle = pricingCode.BUNDLE_NAME_BY_SEGMENT;
const sitesForChain = pricingCode.THRESHOLDS.sitesForMultiSite;
const peopleForOffice = pricingCode.THRESHOLDS.employeesForProfessionalWhenTypeUnknown;
test(
  "a shop with the stated number of sites becomes a chain, one site fewer stays a shop",
  (await bundleOf({ business_type: "Kirana store", employees: "20", sites: String(sitesForChain) })) ===
    segmentBundle.multi &&
    (await bundleOf({ business_type: "Kirana store", employees: "20", sites: String(sitesForChain - 1) })) ===
      segmentBundle.micro,
);
test(
  "an unrecognised business is an office from the stated team size, a shop below it",
  (await bundleOf({ business_type: "Something else", employees: String(peopleForOffice) })) === segmentBundle.prof &&
    (await bundleOf({ business_type: "Something else", employees: String(peopleForOffice - 1) })) ===
      segmentBundle.micro,
);
const segmentInputCases = [
  ["segmentInputMicro", segmentBundle.micro],
  ["segmentInputProfessional", segmentBundle.prof],
  ["segmentInputMultiSite", segmentBundle.multi],
  ["segmentInputManufacturer", segmentBundle.mfg],
];
const segmentInputMisses = [];
for (const [listName, expectedBundle] of segmentInputCases) {
  for (const word of pricingTables.SEGMENT_KEYWORDS[listName]) {
    const bundle = await bundleOf({ segment: word, business_type: "Textile unit", employees: "20", sites: "3" });
    if (bundle !== expectedBundle) segmentInputMisses.push(`${word} → ${bundle}`);
  }
}
test(
  "every segment name the agent may pass overrides the business type, as the segment table says",
  segmentInputMisses.length === 0,
  segmentInputMisses.join(", "),
);
const businessTypeCases = [
  ["multiSite", segmentBundle.multi],
  ["manufacturer", segmentBundle.mfg],
  ["professional", segmentBundle.prof],
  ["micro", segmentBundle.micro],
];
const businessTypeMisses = [];
for (const [listName, expectedBundle] of businessTypeCases) {
  for (const word of pricingTables.SEGMENT_KEYWORDS[listName]) {
    const bundle = await bundleOf({ business_type: word, employees: "4", sites: "1" });
    if (bundle !== expectedBundle) businessTypeMisses.push(`${word} → ${bundle}`);
  }
}
test(
  "every business-type word in the segment table leads to its bundle",
  businessTypeMisses.length === 0,
  businessTypeMisses.join(", "),
);

// price_bundle: every word an owner may use for a need adds that need's product (in a business that can buy it).
const NEED_CONTEXTS = {
  micro: { business_type: "Kirana store", city: "Lucknow", employees: "3", has_gstin: "yes" },
  office: { business_type: "Clinic", city: "Delhi", employees: "12", has_gstin: "yes" },
  chain: { business_type: "Restaurant chain", city: "Mumbai", employees: "30", sites: "3", has_gstin: "yes" },
  factory: { business_type: "Textile unit", city: "Surat", employees: "30", has_gstin: "yes" },
};
const NEED_PRODUCT = {
  failover: ["micro", product.FAILOVER_4G_5G],
  email: ["micro", product.CLOUD_EMAIL],
  security: ["micro", product.ENDPOINT_SECURITY],
  pos: ["micro", product.CLOUD_POS],
  cctv: ["micro", product.CLOUD_CCTV],
  wifi: ["micro", product.SECURE_WIFI],
  whatsapp: ["micro", product.WHATSAPP_API],
  sms: ["micro", product.BUSINESS_SMS],
  website: ["micro", product.WEBSITE_DOMAIN],
  telephony: ["office", product.CLOUD_TELEPHONY],
  tollfree: ["office", product.TOLL_FREE_NUMBER],
  staticip: ["office", product.STATIC_IP],
  firewall: ["office", product.MANAGED_FIREWALL],
  highspeed: ["office", product.BIZ_FIBRE_1G],
  sdwan: ["chain", product.MANAGED_SD_WAN],
  fleet: ["chain", product.FLEET_TRACKER],
  iot: ["factory", product.MACHINE_IOT],
  leased: ["factory", product.LEASED_LINE_100],
};
const needMisses = [];
for (const [need, [context, expectedProduct]] of Object.entries(NEED_PRODUCT)) {
  for (const word of pricingTables.NEED_KEYWORDS[need]) {
    const quote = await quoteFor({ ...NEED_CONTEXTS[context], needs: word });
    if (!hasItem(quote, expectedProduct)) needMisses.push(`"${word}" (${need})`);
  }
}
test(
  "every word in the needs table adds its product, for a business allowed to buy it",
  needMisses.length === 0 && Object.keys(NEED_PRODUCT).length === Object.keys(pricingTables.NEED_KEYWORDS).length - 1,
  needMisses.join(", "),
);
// Storage (cloud backup) is always in Office Pro; asking for it moves its reason into the quote's "Why" line.
const backupReason = pricingTables.MESSAGES.reasonByProductId[product.CLOUD_BACKUP_1TB][0];
const threePersonOffice = { business_type: "Clinic", city: "Delhi", employees: "3", has_gstin: "yes" };
const storageMisses = [];
if ((await quoteFor(threePersonOffice)).why_text.includes(backupReason))
  storageMisses.push("shown without being asked");
for (const word of pricingTables.NEED_KEYWORDS.storage) {
  if (!(await quoteFor({ ...threePersonOffice, needs: word })).why_text.includes(backupReason))
    storageMisses.push(`"${word}"`);
}
test(
  "every storage word puts cloud backup among the reasons the owner sees first",
  storageMisses.length === 0,
  storageMisses.join(", "),
);

// price_bundle: sizing rules the knowledge base states, for the segments no earlier test sized.
const chainEmail = await quoteFor({ ...NEED_CONTEXTS.chain, employees: "71", sites: "8", needs: "email" });
const factorySecurity = await quoteFor({ ...NEED_CONTEXTS.factory, employees: "85", needs: "security" });
const shopOfThree = await quoteFor({ ...NEED_CONTEXTS.micro, employees: "3", needs: "email, security" });
const shopOfFive = await quoteFor({ ...NEED_CONTEXTS.micro, employees: "5", needs: "security" });
test(
  "email and security are sized per segment: chain 15% of 71 = 11 users, factory 10% of 85 = 9 devices, shop one each up to 3",
  quantityIn(chainEmail, product.CLOUD_EMAIL) === 11 &&
    quantityIn(factorySecurity, product.ENDPOINT_SECURITY) === 9 &&
    quantityIn(shopOfThree, product.CLOUD_EMAIL) === 3 &&
    quantityIn(shopOfThree, product.ENDPOINT_SECURITY) === 3 &&
    quantityIn(shopOfFive, product.ENDPOINT_SECURITY) === 3,
  JSON.stringify([chainEmail.items_json, factorySecurity.items_json, shopOfThree.items_json, shopOfFive.items_json]),
);
const officeWithZero = await quoteFor({ business_type: "Clinic", city: "Delhi", employees: "0", has_gstin: "yes" });
const officeWithoutCount = await quoteFor({ business_type: "Clinic", city: "Delhi", has_gstin: "yes" });
test(
  "a team size of 0 is treated as unknown, exactly like no team size at all",
  officeWithZero.items_json === officeWithoutCount.items_json &&
    officeWithZero.monthly_total === officeWithoutCount.monthly_total,
  JSON.stringify([officeWithZero.items_json, officeWithoutCount.items_json]),
);

// onboard_from_gstin: every business-name word is understood when the owner types it as their answer.
const onboardingTables = readInternals("onboard_from_gstin.js", ["NAME_RULES", "PROFILES"]);
const ASKS_BUSINESS_TYPE = "07BSWXR0494W1ZP";
const nameRuleMisses = [];
for (const rule of onboardingTables.NAME_RULES) {
  for (const word of rule.words) {
    const answered = (await onboard({ gstin: ASKS_BUSINESS_TYPE, show_card: "no", answer_business_type: word }))
      .outputVars;
    if (answered.business_category !== onboardingTables.PROFILES[rule.profileId].category) {
      nameRuleMisses.push(`"${word}" → ${answered.business_category || answered.next_action}`);
    }
  }
}
test(
  "every business-name word in the onboarding rules is understood when the owner types it",
  nameRuleMisses.length === 0,
  nameRuleMisses.join(", "),
);
const answeredOther = (await onboard({ gstin: ASKS_BUSINESS_TYPE, answer_business_type: "Other" })).outputVars;
test(
  'answering "Other" sends the owner to the advisor with a request to describe the business, and no price',
  answeredOther.next_action === "use_advisor" &&
    /Tell me a little about what Riddhi & Associates does/.test(answeredOther.greeting) &&
    answeredOther.monthly_total === 0,
  answeredOther.greeting,
);
const RESTAURANT_ASKS_LOCATIONS = "27LRRXS3617L1ZA";
const sitesFromAnswer = async (answer) =>
  JSON.parse(
    (await onboard({ gstin: RESTAURANT_ASKS_LOCATIONS, show_card: "no", answer_sites: answer })).outputVars
      .pricing_inputs_json || "{}",
  ).sites;
test(
  "locations answers are read however they are typed: '3-5' with a plain hyphen, 'we have 4 outlets', ' 2 ', '0'",
  (await sitesFromAnswer("3-5")) === "3" &&
    (await sitesFromAnswer("we have 4 outlets")) === "4" &&
    (await sitesFromAnswer(" 2 ")) === "2" &&
    (await sitesFromAnswer("0")) === "1",
);
const udyamChain = (await onboard({ gstin: "33MFTXS9954Q1Z9" })).outputVars;
const companyChain = (await onboard({ gstin: "24RZGXM9709E1ZD" })).outputVars;
test(
  "a business the Udyam record calls a chain, or a company-owned restaurant, is asked how many locations it has",
  udyamChain.next_action === "ask_question" &&
    udyamChain.question_type === "locations" &&
    udyamChain.segment_code === "multi" &&
    companyChain.next_action === "ask_question" &&
    companyChain.question_type === "locations",
  JSON.stringify([udyamChain.evidence_fields, companyChain.evidence_fields]),
);
const sixMonthsOld = (await onboard({ gstin: "03PJNXS4821G1ZB", as_of_date: "2019-10-15" })).outputVars;
const dayShort = (await onboard({ gstin: "03PJNXS4821G1ZB", as_of_date: "2019-10-14" })).outputVars;
test(
  "pre-approval starts on the day the registration is 6 calendar months old, not a day earlier",
  sixMonthsOld.pre_approved === true &&
    dayShort.pre_approved === false &&
    /only 5 months old/.test(dayShort.pre_approval_reason),
  JSON.stringify([sixMonthsOld.pre_approval_reason, dayShort.pre_approval_reason]),
);
const factoryProposal = (await onboard({ gstin: "29NIQXC0858S1ZK", show_card: "no" })).outputVars;
const factorySensors = (parseOrNull(factoryProposal.suggested_addons_json) || []).find((addon) => addon.need === "iot");
const factoryWithSensors = await quoteFor({ ...parseOrNull(factoryProposal.pricing_inputs_json), needs: "iot" });
test(
  "an add-on's one-time price is what it adds to the setup, even when the base bundle has a setup fee of its own",
  factoryProposal.setup_total > 0 &&
    !!factorySensors &&
    factorySensors.setup_price === factoryWithSensors.setup_total - factoryProposal.setup_total,
  JSON.stringify([factoryProposal.setup_total, factorySensors, factoryWithSensors.setup_total]),
);
const chainProposal = (await onboard({ gstin: RESTAURANT_ASKS_LOCATIONS, answer_sites: "3–5" })).outputVars;
test(
  "the greeting says '3 locations' (plural) for a chain and '1 location' for a single site",
  /3 locations/.test(chainProposal.greeting) &&
    /1 location\b/.test((await onboard({ gstin: KIRANA_ONE_PERSON })).outputVars.greeting),
  chainProposal.greeting,
);

// consent_manager and consent_rules.
const recordedOnce = (await runTool(consentManager, { mode: "record", registry_lookup: "yes" })).outputVars;
const recordedAgain = (
  await runTool(consentManager, {
    mode: "record",
    registry_lookup: "yes",
    consent_record_json: recordedOnce.consent_record_json,
  })
).outputVars;
test(
  "giving the same answer again adds nothing to the consent history",
  parseOrNull(recordedAgain.consent_record_json)?.history?.length === 1 &&
    recordedAgain.consent_registry_lookup === true,
  recordedAgain.consent_record_json,
);
const damagedRecords = [];
for (const damaged of ["not json", "{}", "[1,2]", '{"purposes":null}']) {
  const checked = (await runTool(consentManager, { mode: "check", consent_record_json: damaged })).outputVars;
  const record = parseOrNull(checked.consent_record_json);
  if (checked.consent_registry_lookup || !record?.purposes || record.history?.length !== 0)
    damagedRecords.push(damaged);
}
test(
  "a damaged consent record is treated as empty: nothing granted, no error",
  damagedRecords.length === 0,
  damagedRecords.join(", "),
);
const shownByDefault = await runTool(consentManager, { mode: "show" });
const hiddenCard = await runTool(consentManager, { mode: "show", show_card: "no" });
test(
  "the consent screen is shown in the chat by default and not when show_card is no",
  shownByDefault.trace.length === 1 &&
    shownByDefault.trace[0].payload.message === shownByDefault.outputVars.consent_screen_text &&
    hiddenCard.trace.length === 0 &&
    hiddenCard.outputVars.consent_screen_text !== "",
);
test(
  "an unknown mode says which modes exist",
  /^consent_manager failed: unknown mode delete-all \(use show, record, withdraw or check\)$/.test(unknownMode.error),
  unknownMode.error,
);
const spacedAnswers = (await runTool(consentManager, { mode: "record", registry_lookup: "  yes ", lang: "  hi " }))
  .outputVars;
test(
  "answers and the language are read with stray spaces around them",
  spacedAnswers.consent_registry_lookup === true && /[ऀ-ॿ]/.test(spacedAnswers.message),
  spacedAnswers.message,
);
const partlyGranted = (
  await runTool(consentManager, { mode: "record", registry_lookup: "yes", kyc_verification: "no" })
).outputVars;
test(
  "the saved-consent message states each purpose's own answer",
  partlyGranted.message === "Saved. Registry lookup: yes · KYC verification: no · Offers: no.",
  partlyGranted.message,
);

// verify_gstin and the shared GSTIN reader.
/** Official GSTIN check character (mod 36), written out here as an independent oracle for building test GSTINs. */
function gstinWithCheckCharacter(firstFourteen) {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = alphabet.indexOf(firstFourteen[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(value / 36) + (value % 36);
  }
  return firstFourteen + alphabet[(36 - (sum % 36)) % 36];
}
const verifyIt = async (inputs) =>
  (await runTool(verifyGstin, { consent_given: "yes", lang: "en", ...inputs })).outputVars;
const unregistered = await verifyIt({ gstin: gstinWithCheckCharacter("27AAAXA0000A1Z") });
test(
  "a well-formed GSTIN that isn't in the registry is reported as not found, masked, and not verified",
  unregistered.gstin_status === "NOT_FOUND" &&
    !unregistered.gstin_ok &&
    unregistered.gstin_masked === "27AAA•••••••1Z" + unregistered.gstin_masked.slice(-1) &&
    /can't find this GSTIN/.test(unregistered.kyc_message),
  JSON.stringify(unregistered),
);
const stateStatus = async (stateCode) =>
  (await verifyIt({ gstin: gstinWithCheckCharacter(stateCode + "AAAXA0000A1Z") })).gstin_status;
test(
  "state codes 01 and 38 are valid; 00 and 39 are not",
  (await stateStatus("01")) === "NOT_FOUND" &&
    (await stateStatus("38")) === "NOT_FOUND" &&
    (await stateStatus("00")) === "INVALID_STATE" &&
    (await stateStatus("39")) === "INVALID_STATE",
);
const mismatchedName = await verifyIt({ gstin: "07PUTXM1153M1Z9", business_name: "Sunrise Traders" });
const matchedName = await verifyIt({ gstin: "07PUTXM1153M1Z9", business_name: "Metro Diagnostics" });
test(
  "when the owner's name doesn't match, the message shows the registered name and asks them to confirm it",
  mismatchedName.name_match === "no_match" &&
    mismatchedName.kyc_message.includes('The registered name is "Metro Diagnostics Pvt Ltd"') &&
    matchedName.name_match === "match" &&
    !matchedName.kyc_message.includes("Please confirm"),
  mismatchedName.kyc_message,
);
const EVERGREEN = "10FLCXE2345M1ZZ";
const matchFor = async (name) => (await verifyIt({ gstin: EVERGREEN, business_name: name })).name_match;
test(
  "name matching thresholds: 3 of 5 words is a match (60%), 3 of 10 a partial match (30%), 2 of 10 no match",
  (await matchFor("Evergreen Insurance Advisors Patna Branch")) === "match" &&
    (await matchFor("Evergreen Insurance Advisors a b c d e f g")) === "partial" &&
    (await matchFor("Evergreen Insurance b c d e f g h i")) === "no_match",
);
const messrsNames = [];
for (const name of ["M/S Metro Diagnostics", "M/s. Metro Diagnostics Pvt. Ltd.", "METRO DIAGNOSTICS (P) LTD"]) {
  const result = await verifyIt({ gstin: "07PUTXM1153M1Z9", business_name: name });
  if (result.name_match !== "match") messrsNames.push(`${name} → ${result.name_match}`);
}
test(
  'names written with "M/S", capitals or "Pvt. Ltd." still match the registered name',
  messrsNames.length === 0,
  messrsNames.join(", "),
);
const typedTwice = await verifyIt({ gstin: "07PUTXM1153M1Z9 (again: 07PUTXM1153M1Z9)" });
const twoInVerify = await verifyIt({ gstin: "07PUTXM1153M1Z9 and 29OKAXP4077P1ZL" });
test(
  "verify_gstin: the same GSTIN typed twice counts once; two different ones are both listed, masked, with their count",
  typedTwice.gstin_status === "Active" &&
    twoInVerify.gstin_status === "MULTIPLE_GSTINS" &&
    /I can see 2 GSTINs/.test(twoInVerify.kyc_message) &&
    twoInVerify.kyc_message.includes("07PUT•••••••1Z9 and 29OKA•••••••1ZL"),
  twoInVerify.kyc_message,
);
const cancelledInEnglish = await verifyIt({ gstin: "29OKAXP4077P1ZL" });
test(
  "a blocked GSTIN's status is written in capitals in English so it stands out",
  /as CANCELLED\./.test(cancelledInEnglish.kyc_message),
  cancelledInEnglish.kyc_message,
);

// price_bundle: fitting a budget. Rules (price_bundle CONFIG and fitToBudget): drop extras one at a time in the
// published trim order, only until the bundle fits; never the connection or the mobile lines; then (shops and
// offices only) switch fibre to 5G AirFiber; then cut mobile lines down to one, only as far as needed.
const budgetRules = readInternals("price_bundle.js", ["BUDGET_TRIM_ORDER", "MAX_REASONS_SHOWN"]);
const rupees = (amount) => "₹" + amount.toLocaleString("en-IN");
const itemsOf = (quote) => parseOrNull(quote.items_json) || [];
const monthlyPriceOf = (item) => item.qty * catalogue[item.id].monthlyPriceFloorInRupees;
const EVERY_NEED = {
  micro: "pos, cctv, wifi, whatsapp, website, sms, email, security, failover",
  office:
    "failover, email, security, backup, telephony, static ip, sms, toll free, website, whatsapp, wifi, cctv, firewall",
  chain: "failover, wifi, pos, cctv, toll free, sd-wan, whatsapp, email, fleet, security",
  factory: "failover, firewall, email, iot, fleet, security, static ip, cctv",
};
const trimOrderMisses = [];
for (const [context, needs] of Object.entries(EVERY_NEED)) {
  const full = await quoteFor({ ...NEED_CONTEXTS[context], needs });
  const fullItems = itemsOf(full);
  const trimmable = budgetRules.BUDGET_TRIM_ORDER.map((id) => fullItems.find((item) => item.id === id)).filter(Boolean);
  let removedPrice = 0;
  for (let removed = 1; removed <= trimmable.length; removed++) {
    removedPrice += monthlyPriceOf(trimmable[removed - 1]);
    const budget = full.monthly_total - removedPrice;
    const fitted = await quoteFor({ ...NEED_CONTEXTS[context], needs, budget: String(budget) });
    const expectedIds = fullItems
      .map((item) => item.id)
      .filter((id) => !trimmable.slice(0, removed).some((t) => t.id === id));
    const expectedNote =
      "To fit " +
      rupees(budget) +
      " we removed/changed: " +
      trimmable
        .slice(0, removed)
        .map((item) => item.name)
        .join(", ");
    if (
      JSON.stringify(itemsOf(fitted).map((item) => item.id)) !== JSON.stringify(expectedIds) ||
      fitted.monthly_total !== budget ||
      fitted.budget_note !== expectedNote
    ) {
      trimOrderMisses.push(`${context}, ${removed} removed: ${fitted.budget_note}`);
    }
  }
  if (trimmable.length < 5) trimOrderMisses.push(`${context}: only ${trimmable.length} extras to trim`);
}
test(
  "a budget drops extras one at a time in the published trim order, only until the bundle fits, and the note names exactly those",
  trimOrderMisses.length === 0,
  trimOrderMisses.join(" | "),
);
const lowestPossible = {};
for (const context of Object.keys(EVERY_NEED)) {
  lowestPossible[context] = await quoteFor({ ...NEED_CONTEXTS[context], needs: EVERY_NEED[context], budget: "1" });
}
const essentialsOf = (quote) =>
  itemsOf(quote)
    .map((item) => `${item.id}×${item.qty}`)
    .join(" ");
test(
  "below the essentials: a shop or office keeps only 5G AirFiber and one mobile line, and the note gives that lowest price",
  essentialsOf(lowestPossible.micro) === `${product.AIRFIBER_5G}×1 ${product.POSTPAID_299}×1` &&
    essentialsOf(lowestPossible.office) === `${product.AIRFIBER_5G}×1 ${product.POSTPAID_599}×1` &&
    lowestPossible.office.budget_note ===
      `Lowest possible: ${rupees(lowestPossible.office.monthly_total)}/month (essentials only)` &&
    lowestPossible.office.monthly_total ===
      catalogue[product.AIRFIBER_5G].monthlyPriceFloorInRupees +
        catalogue[product.POSTPAID_599].monthlyPriceFloorInRupees,
  JSON.stringify([
    essentialsOf(lowestPossible.micro),
    essentialsOf(lowestPossible.office),
    lowestPossible.office.budget_note,
  ]),
);
test(
  "below the essentials: a chain keeps its fibre at every site and a factory its leased line; only the mobile lines go down to one",
  essentialsOf(lowestPossible.chain) === `${product.BIZ_FIBRE_100}×3 ${product.POSTPAID_599}×1` &&
    essentialsOf(lowestPossible.factory) === `${product.LEASED_LINE_20}×1 ${product.POSTPAID_599}×1`,
  JSON.stringify([essentialsOf(lowestPossible.chain), essentialsOf(lowestPossible.factory)]),
);
const largeOffice = { ...NEED_CONTEXTS.office, employees: "30" };
const officeLines = itemsOf(await quoteFor(largeOffice)).find((item) => item.id === product.POSTPAID_599);
const oneLineShort =
  catalogue[product.AIRFIBER_5G].monthlyPriceFloorInRupees +
  (officeLines.qty - 1) * catalogue[product.POSTPAID_599].monthlyPriceFloorInRupees;
const linesCut = await quoteFor({ ...largeOffice, budget: String(oneLineShort) });
test(
  "mobile lines are cut only as far as the budget needs, after fibre was switched to AirFiber (and the note says so)",
  officeLines.qty > 2 &&
    itemsOf(linesCut).find((item) => item.id === product.POSTPAID_599).qty === officeLines.qty - 1 &&
    linesCut.monthly_total === oneLineShort &&
    linesCut.budget_note.includes(catalogue[product.BIZ_FIBRE_300].name + " → 5G AirFiber"),
  JSON.stringify([officeLines.qty, linesCut.items_json, linesCut.budget_note]),
);
const fullOffice = await quoteFor(NEED_CONTEXTS.office);
const budgetIgnored = [];
for (const budget of [String(fullOffice.monthly_total), "0", "", "plenty"]) {
  const quote = await quoteFor({ ...NEED_CONTEXTS.office, budget });
  if (quote.items_json !== fullOffice.items_json || quote.budget_note !== "")
    budgetIgnored.push(JSON.stringify(budget));
}
test(
  "a budget the bundle already fits, or no usable budget, changes nothing and adds no note",
  budgetIgnored.length === 0,
  budgetIgnored.join(", "),
);

// price_bundle: the "Why" line shows the connection first, then what the owner asked for.
const reasonFor = (quote, productCode) => {
  const item = itemsOf(quote).find((entry) => entry.id === productCode);
  return pricingTables.MESSAGES.reasonByProductId[productCode][0].replace("{quantity}", item ? item.qty : "?");
};
const whyOrderMisses = [];
for (const [need, [context, expectedProduct]] of Object.entries(NEED_PRODUCT)) {
  const quote = await quoteFor({ ...NEED_CONTEXTS[context], needs: pricingTables.NEED_KEYWORDS[need][0] });
  const reasons = quote.why_text.replace(/^Why: /, "").split("; ");
  const connection = itemsOf(quote)[0].id;
  if (reasons.length !== Math.min(budgetRules.MAX_REASONS_SHOWN, itemsOf(quote).length)) {
    whyOrderMisses.push(`${need}: ${reasons.length} reasons`);
  }
  if (reasons[0] !== reasonFor(quote, connection)) whyOrderMisses.push(`${need}: connection not first`);
  if (expectedProduct !== connection && reasons[1] !== reasonFor(quote, expectedProduct)) {
    whyOrderMisses.push(`${need}: asked-for ${expectedProduct} not second (${reasons[1]})`);
  }
}
test(
  "the Why line gives the connection's reason first, then the reason for what the owner asked for, at most 3 reasons",
  whyOrderMisses.length === 0,
  whyOrderMisses.join(" | "),
);

// price_bundle: the owner's own edits ("remove …", "add …").
const officeDefault = itemsOf(fullOffice);
const removedSeveral = await quoteFor({
  ...NEED_CONTEXTS.office,
  remove: "cloud backup; endpoint security, " + catalogue[officeDefault[0].id].name,
});
const removedById = await quoteFor({ ...NEED_CONTEXTS.office, remove: product.CLOUD_BACKUP_1TB });
const removedByShortestName = await quoteFor({ ...NEED_CONTEXTS.office, remove: "backup" });
test(
  "the owner can remove several items (by name or catalogue ID, split by commas or semicolons) but never the connection",
  officeDefault.some((item) => item.id === product.ENDPOINT_SECURITY) &&
    !hasItem(removedSeveral, product.CLOUD_BACKUP_1TB) &&
    !hasItem(removedSeveral, product.ENDPOINT_SECURITY) &&
    itemsOf(removedSeveral)[0].id === officeDefault[0].id &&
    !hasItem(removedById, product.CLOUD_BACKUP_1TB) &&
    hasItem(removedById, product.ENDPOINT_SECURITY),
  JSON.stringify([removedSeveral.items_json, removedById.items_json]),
);
test(
  'when a word fits several products the shortest name wins: "backup" removes Cloud Backup, not the backup internet',
  !hasItem(removedByShortestName, product.CLOUD_BACKUP_1TB) && hasItem(removedByShortestName, product.FAILOVER_4G_5G),
  removedByShortestName.items_json,
);
const officeEmailUsers = quantityIn(fullOffice, product.CLOUD_EMAIL);
const camerasAfter = await quoteFor({ ...NEED_CONTEXTS.office, add: "cctv 6" });
const camerasBefore = await quoteFor({ ...NEED_CONTEXTS.office, add: "4 cctv" });
const emailAgain = await quoteFor({ ...NEED_CONTEXTS.office, add: "email" });
const emailSeven = await quoteFor({ ...NEED_CONTEXTS.office, add: "email 7" });
const moreSims = await quoteFor({ ...NEED_CONTEXTS.micro, add: "3 sim" });
const unknownAdd = await quoteFor({ ...NEED_CONTEXTS.office, add: "a unicorn" });
test(
  "a number before or after an added item is its quantity; adding an item already there without a number keeps its quantity",
  quantityIn(camerasAfter, product.CLOUD_CCTV) === 6 &&
    quantityIn(camerasBefore, product.CLOUD_CCTV) === 4 &&
    officeEmailUsers > 0 &&
    quantityIn(emailAgain, product.CLOUD_EMAIL) === officeEmailUsers &&
    quantityIn(emailSeven, product.CLOUD_EMAIL) === 7 &&
    quantityIn(moreSims, product.POSTPAID_299) === 3 &&
    unknownAdd.items_json === fullOffice.items_json,
  JSON.stringify([camerasAfter.items_json, emailSeven.items_json, moreSims.items_json]),
);
const addedByIdWithQuantity = await quoteFor({ ...NEED_CONTEXTS.office, add: "P20 5" });
const addedByIdOnly = await quoteFor({ ...NEED_CONTEXTS.office, add: "P23" });
const addedByShortId = await quoteFor({ ...NEED_CONTEXTS.office, add: "p-9" });
const addedByUnknownId = await quoteFor({ ...NEED_CONTEXTS.office, add: "P26 3" });
const addedByIdQuantityFirst = await quoteFor({ ...NEED_CONTEXTS.office, add: "6 P23" });
test(
  'adding by catalogue ID picks that product: "P20 5" is Endpoint Security ×5 (not Static IP), "P23" one camera, an unknown ID nothing',
  quantityIn(addedByIdWithQuantity, product.ENDPOINT_SECURITY) === 5 &&
    !hasItem(addedByIdWithQuantity, product.STATIC_IP) &&
    quantityIn(addedByIdOnly, product.CLOUD_CCTV) === 1 &&
    !hasItem(addedByIdOnly, product.STATIC_IP) &&
    hasItem(addedByShortId, product.FAILOVER_4G_5G) &&
    !hasItem(addedByShortId, product.STATIC_IP) &&
    addedByUnknownId.items_json === fullOffice.items_json &&
    quantityIn(addedByIdQuantityFirst, product.CLOUD_CCTV) === 6,
  JSON.stringify([addedByIdWithQuantity.items_json, addedByIdOnly.items_json, addedByUnknownId.items_json]),
);
const fullMicro = await quoteFor(NEED_CONTEXTS.micro);
const addedNameWithNumber = await quoteFor({ ...NEED_CONTEXTS.micro, add: "Business Postpaid 599" });
const addedNameWithNumberAndQuantity = await quoteFor({ ...NEED_CONTEXTS.micro, add: "Business Postpaid 599 3" });
test(
  'a number inside a product name is not a quantity: "Business Postpaid 599" adds one 599 line, "… 599 3" three',
  quantityIn(addedNameWithNumber, product.POSTPAID_599) === 1 &&
    quantityIn(addedNameWithNumber, product.POSTPAID_299) === quantityIn(fullMicro, product.POSTPAID_299) &&
    quantityIn(addedNameWithNumberAndQuantity, product.POSTPAID_599) === 3,
  JSON.stringify([addedNameWithNumber.items_json, addedNameWithNumberAndQuantity.items_json]),
);
const camerasTimesSix = await quoteFor({ ...NEED_CONTEXTS.office, add: "cctv x6" });
const camerasSixTimes = await quoteFor({ ...NEED_CONTEXTS.office, add: "6x cctv" });
const camerasMultiplySign = await quoteFor({ ...NEED_CONTEXTS.office, add: "cctv ×6" });
test(
  'a quantity written as "x6", "6x" or "×6" is read as 6',
  quantityIn(camerasTimesSix, product.CLOUD_CCTV) === 6 &&
    quantityIn(camerasSixTimes, product.CLOUD_CCTV) === 6 &&
    quantityIn(camerasMultiplySign, product.CLOUD_CCTV) === 6,
  JSON.stringify([camerasTimesSix.items_json, camerasSixTimes.items_json, camerasMultiplySign.items_json]),
);
const addedTollFree = await quoteFor({ ...NEED_CONTEXTS.micro, add: "toll free" });
const addedThenBudget = await quoteFor({ ...NEED_CONTEXTS.micro, add: "toll free", budget: "1" });
test(
  "an item the owner adds counts as asked for (its reason comes right after the connection's) and can still go for a budget",
  hasItem(addedTollFree, product.TOLL_FREE_NUMBER) &&
    addedTollFree.why_text.replace(/^Why: /, "").split("; ")[1] ===
      reasonFor(addedTollFree, product.TOLL_FREE_NUMBER) &&
    !hasItem(addedThenBudget, product.TOLL_FREE_NUMBER),
  JSON.stringify([addedTollFree.why_text, addedThenBudget.items_json]),
);

// onboard_from_gstin: what the chat shows, and the evidence for an answered question.
const shownProposal = await onboard({ gstin: "32TTNXB7384T1ZW" });
const hiddenProposal = await onboard({ gstin: "32TTNXB7384T1ZW", show_card: "NO" });
test(
  "a proposal shows the greeting and then the quote card in the chat by default, and nothing when show_card is no (any case)",
  shownProposal.outputVars.next_action === "show_proposal" &&
    shownProposal.trace.length === 2 &&
    shownProposal.trace[0].payload.message === shownProposal.outputVars.greeting &&
    shownProposal.trace[1].payload.message === shownProposal.outputVars.quote_text &&
    hiddenProposal.trace.length === 0 &&
    hiddenProposal.outputVars.greeting === shownProposal.outputVars.greeting,
);
const locationsAnswered = (await onboard({ gstin: RESTAURANT_ASKS_LOCATIONS, answer_sites: "2" })).outputVars;
test(
  "the owner's answer is listed in the evidence the proposal was based on",
  /owner answer \(locations\)/.test(locationsAnswered.evidence_fields) &&
    !/owner answer/.test((await onboard({ gstin: RESTAURANT_ASKS_LOCATIONS })).outputVars.evidence_fields),
  locationsAnswered.evidence_fields,
);

// ---------------------------------------------------------------- activation promise at quote time (STRATEGY §11)
// price_bundle decides the promise on the quote card from GUARANTEE_SCOPE (read from the generated file, so a changed
// threshold is tested as it stands) and the firm days injected from the case data.
console.log("\nactivation promise: 72-hour scope and firm dates (price_bundle)");
const scope = pricingCode.GUARANTEE_SCOPE;
const firmDays = pricingCode.ACTIVATION_PROMISE_DATA.firmDays;
const connectionTypeOf = pricingCode.ACTIVATION_PROMISE_DATA.connectionTypeByProduct;
const QUALIFYING_SHOP = { business_type: "Kirana store", city: "Delhi", employees: "3", sites: "1", has_gstin: "yes" };
const qualifyingQuote = await quoteFor(QUALIFYING_SHOP);
test(
  "a single-site shop of 3 people in a tier-1 city on business fibre gets 'Connected in 72 hours, guaranteed'",
  qualifyingQuote.promise_type === "guaranteed_72h" &&
    qualifyingQuote.promise_hours === scope.hours &&
    qualifyingQuote.promise_reasons === "" &&
    qualifyingQuote.quote_text.split("\n").includes(pricingTables.MESSAGES.en.promiseGuaranteed72h),
  JSON.stringify([qualifyingQuote.promise_type, qualifyingQuote.promise_reasons, qualifyingQuote.quote_text]),
);
const atTeamLimit = await quoteFor({ ...QUALIFYING_SHOP, employees: String(scope.maxEmployees) });
const onAirFiber = await quoteFor({ ...QUALIFYING_SHOP, fibre_available: "no" });
test(
  `the 72-hour scope includes exactly ${scope.maxEmployees} people, and 5G AirFiber as the connection`,
  atTeamLimit.promise_type === "guaranteed_72h" &&
    onAirFiber.promise_type === "guaranteed_72h" &&
    hasItem(onAirFiber, product.AIRFIBER_5G),
  JSON.stringify([atTeamLimit.promise_reasons, onAirFiber.promise_reasons, onAirFiber.items_json]),
);
// Each condition of the scope on its own: change one thing about the qualifying shop, and only that reason appears.
const SCOPE_BREAKERS = [
  { reason: "city_tier", tier: "2", change: { city: "Lucknow" } },
  { reason: "team_size", tier: "1", change: { employees: String(scope.maxEmployees + 1) } },
  { reason: "sites", tier: "1", change: { sites: String(scope.maxSites + 1) } },
  { reason: "airfiber_coverage", tier: "1", change: { airfiber_available: "no" } },
];
const scopeBreakFailures = [];
for (const breaker of SCOPE_BREAKERS) {
  const quote = await quoteFor({ ...QUALIFYING_SHOP, ...breaker.change });
  const connection = JSON.parse(quote.items_json).find((item) => connectionTypeOf[item.id]);
  const expectedDays = Math.max(
    firmDays[breaker.tier][connectionTypeOf[connection.id]].days,
    scope.hours / HOURS_PER_DAY,
  );
  const isRight =
    quote.promise_type === "firm_date" &&
    quote.promise_reasons.length > 0 &&
    quote.promise_reasons ===
      pricingTables.MESSAGES.promiseScopeReasons[breaker.reason].replace("{count}", scope.maxEmployees) &&
    quote.promise_days === expectedDays &&
    quote.promise_hours === expectedDays * HOURS_PER_DAY &&
    !SEVENTY_TWO_HOUR_WORDING.test(quote.quote_text.split("\n").slice(-1)[0]) &&
    quote.quote_text.includes("within " + expectedDays + " days");
  if (!isRight)
    scopeBreakFailures.push(
      JSON.stringify(breaker.change) +
        " → " +
        quote.promise_type +
        " " +
        quote.promise_reasons +
        " " +
        quote.promise_days,
    );
}
test(
  "breaking any ONE scope condition (tier-2 city, 11 people, 2 sites, no AirFiber coverage) gives a firm date with that reason",
  scopeBreakFailures.length === 0,
  scopeBreakFailures.join(" | "),
);
// A 12-person factory gets a leased line; an 8-person one gets 1 Gbps fibre (its ONLY scope problem is the survey).
const bigFactoryLeasedLine = await quoteFor({
  business_type: "Textile unit",
  city: "Delhi",
  employees: "12",
  has_gstin: "yes",
  needs: "leased",
});
const smallFactoryOneGig = await quoteFor({
  business_type: "Textile unit",
  city: "Delhi",
  employees: "8",
  has_gstin: "yes",
  needs: "leased",
});
test(
  "a connection that needs a site survey (leased line, 1 Gbps fibre) never gets the 72-hour guarantee",
  [bigFactoryLeasedLine, smallFactoryOneGig].every((quote) => {
    const connection = JSON.parse(quote.items_json).find((item) => connectionTypeOf[item.id]);
    return (
      scope.connectionProductIds.indexOf(connection.id) < 0 &&
      quote.promise_type === "firm_date" &&
      /site survey/.test(quote.promise_reasons)
    );
  }),
  JSON.stringify([
    bigFactoryLeasedLine.items_json,
    bigFactoryLeasedLine.promise_reasons,
    smallFactoryOneGig.items_json,
    smallFactoryOneGig.promise_reasons,
  ]),
);
const hindiPromise = await quoteFor({ ...QUALIFYING_SHOP, city: "Lucknow", lang: "hi" });
test(
  "the guarantee line is in Hindi on a Hindi quote card",
  hindiPromise.quote_text.includes(
    pricingTables.MESSAGES.hi.promiseFirmDate.replace("{days}", String(hindiPromise.promise_days)),
  ),
  hindiPromise.quote_text,
);
const firmDayProblems = [];
Object.keys(firmDays).forEach((tier) =>
  Object.keys(firmDays[tier]).forEach((connectionType) => {
    const entry = firmDays[tier][connectionType];
    if (!(entry.days >= entry.observedDays && entry.days >= entry.catalogueDays && entry.orders > 0)) {
      firmDayProblems.push(tier + "/" + connectionType + " " + JSON.stringify(entry));
    }
  }),
);
test(
  "every firm date is at least what 9 in 10 past orders took and at least the catalogue's install time",
  Object.keys(firmDays).length === 2 && firmDayProblems.length === 0,
  firmDayProblems.join(" | "),
);

// The knowledge base's promise section is written from the pricing code, like the sizing rules.
const kbPromise = await import(pathToFileURL(path.join(testDirectory, "..", "_build", "kb_promise_rules.mjs")).href);
const expectedPromiseSection = await kbPromise.buildPromiseSection(priceBundleSource);
const promiseSectionInFile = kbPromise.readPromiseSection(knowledgeBaseText);
sourceTextTest(
  "the knowledge base's activation-promise rules are exactly what the pricing code writes today (rebuild if this fails)",
  promiseSectionInFile !== "" && promiseSectionInFile === expectedPromiseSection,
  promiseSectionInFile ? firstDifference(promiseSectionInFile, expectedPromiseSection) : "markers not found",
);
// Nothing written by hand may promise 72 hours to everyone again (the wording before STRATEGY §11).
const UNCONDITIONAL_PROMISE = /connected within 72 hours|72-hour promise|get connected within 72/i;
const handWrittenTexts = [
  "1_agent_global_prompt.txt",
  "2_playbooks/0_gstin_first_onboarding.txt",
  "2_playbooks/A_bundle_advisor.txt",
  "2_playbooks/B_business_verification.txt",
  "2_playbooks/C_callback_lead_capture.txt",
  "2_playbooks/D_order_tracker.txt",
  "4_knowledge_base/saathi_faq.txt",
  "4_knowledge_base/saathi_bundles_and_rules.txt",
  "3_function_tools/TOOL_SETUP.md",
  "7_demo_site/index.html",
].filter((file) => UNCONDITIONAL_PROMISE.test(fs.readFileSync(path.join(testDirectory, "..", file), "utf8")));
test(
  "no prompt, playbook, knowledge-base text or demo page promises 72 hours to every order",
  handWrittenTexts.length === 0,
  handWrittenTexts.join(", "),
);
test(
  "the global prompt tells Saathi to say 72 hours only when the quote's promise_type is guaranteed_72h",
  /promise_type\s+is guaranteed_72h/.test(
    fs.readFileSync(path.join(testDirectory, "..", "1_agent_global_prompt.txt"), "utf8"),
  ),
);

// Onboarding's greeting states the same guarantee as its quote card (never 72 hours on a firm-date quote).
const ONBOARDING_SAMPLE_SIZE = 150;
const onboardingRegistry = fs
  .readFileSync(path.join(testDirectory, "..", "3_function_tools", "onboard_from_gstin.js"), "utf8")
  .match(/\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\|/g)
  .map((match) => match.slice(0, -1));
const greetingMismatches = [];
let greetingProposals = 0;
let greetings72h = 0;
for (let i = 0; i < onboardingRegistry.length; i += Math.ceil(onboardingRegistry.length / ONBOARDING_SAMPLE_SIZE)) {
  const proposal = (await onboard({ gstin: onboardingRegistry[i], show_card: "no" })).outputVars;
  if (proposal.next_action !== "show_proposal") continue;
  greetingProposals++;
  const says72h = SEVENTY_TWO_HOUR_WORDING.test(proposal.greeting);
  if (proposal.promise_type === "guaranteed_72h") greetings72h++;
  if (
    says72h !== (proposal.promise_type === "guaranteed_72h") ||
    !proposal.quote_text.includes(proposal.promise_text)
  ) {
    greetingMismatches.push(proposal.gstin_masked + " " + proposal.promise_type);
  }
}
test(
  `onboarding's greeting gives the quote card's guarantee: 72 hours only when the card does (${greetingProposals} proposals, ${greetings72h} with 72 h)`,
  greetingProposals > 50 && greetings72h > 0 && greetingMismatches.length === 0,
  greetingMismatches.join(", "),
);

// ---------------------------------------------------------------- Udyam entry (STRATEGY §12)
console.log("\nUdyam entry: owners without a GSTIN start with their Udyam number (onboard_from_gstin)");
const udyamInputMessages = (
  await import(pathToFileURL(path.join(testDirectory, "..", "_build", "udyam_input.js")).href)
).UDYAM_INPUT_API.UDYAM_MESSAGES;
const UDYAM_CLINIC = "UDYAM-KL-00-3078801"; // Balaji Dental Care LLP, Kochi (also has a GSTIN in the case data)
const UDYAM_DELHI_SHOP = "UDYAM-DL-00-0779845"; // Green Leaf General Store, Delhi
const UDYAM_CHAIN = "UDYAM-TN-00-3866196"; // Star Electronics, Chennai: "Electronics retail chain"
const UDYAM_NEW = "UDYAM-MH-00-5098440"; // Krishna Bakers, registered 2026-01-30 (< 6 months before the case's today)
const gstOnlyProductIds = Object.values(catalogue)
  .filter((entry) => entry.requiresGstin)
  .map((entry) => entry.id);

const udyamProposal = (await onboard({ udyam_number: UDYAM_CLINIC, show_card: "no" })).outputVars;
const udyamPricing = JSON.parse(udyamProposal.pricing_inputs_json || "{}");
test(
  "a valid Udyam number gives a zero-question proposal: segment and city from the Udyam registry, priced without a GSTIN",
  udyamProposal.entry_type === "udyam" &&
    udyamProposal.next_action === "show_proposal" &&
    udyamProposal.udyam_status === "FOUND" &&
    udyamProposal.udyam_valid === true &&
    udyamProposal.gstin_status === "" &&
    udyamProposal.business_category === "clinic" &&
    udyamProposal.segment_code === "prof" &&
    udyamProposal.gst_city === "Kochi" &&
    udyamPricing.has_gstin === "no" &&
    /looked up by Udyam number/.test(udyamProposal.evidence_fields),
  JSON.stringify(udyamProposal),
);
const repricedUdyam = (await runTool(priceBundle, { ...udyamPricing, show_card: "no" })).outputVars;
test(
  "the Udyam proposal's prices are price_bundle's, and no GST-only product is in it",
  udyamProposal.monthly_total === repricedUdyam.monthly_total &&
    udyamProposal.items_json === repricedUdyam.items_json &&
    udyamProposal.monthly_total > 0 &&
    JSON.parse(udyamProposal.items_json).every((item) => gstOnlyProductIds.indexOf(item.id) < 0),
  JSON.stringify([udyamProposal.monthly_total, repricedUdyam.monthly_total, udyamProposal.items_json]),
);
test(
  "the Udyam number is shown masked, and the greeting says it was found on the Udyam registry",
  udyamProposal.udyam_masked === "UDYAM-KL-••-•••8801" &&
    !udyamProposal.greeting.includes("3078801") &&
    /Udyam registry/.test(udyamProposal.greeting) &&
    /Udyam/.test(udyamProposal.pre_approval_reason),
  udyamProposal.greeting,
);
const udyamShop = (await onboard({ udyam_number: UDYAM_DELHI_SHOP, show_card: "no" })).outputVars;
test(
  "a Udyam proposal carries the same activation guarantee as its quote card (a Delhi shop: 72 hours)",
  udyamShop.next_action === "show_proposal" &&
    udyamShop.promise_type === "guaranteed_72h" &&
    udyamShop.quote_text.includes(udyamShop.promise_text) &&
    SEVENTY_TWO_HOUR_WORDING.test(udyamShop.greeting) &&
    udyamProposal.promise_type === "firm_date" &&
    !SEVENTY_TWO_HOUR_WORDING.test(udyamProposal.greeting),
  JSON.stringify([udyamShop.promise_type, udyamShop.greeting, udyamProposal.promise_type]),
);
const udyamInGstinField = (await onboard({ gstin: "my udyam no is udyam kl 00 3078801", lang: "hi", show_card: "no" }))
  .outputVars;
test(
  "a Udyam number typed where the GSTIN goes is recognised, in any spelling, and the reply is in Hindi",
  udyamInGstinField.entry_type === "udyam" &&
    udyamInGstinField.next_action === "show_proposal" &&
    udyamInGstinField.monthly_total === udyamProposal.monthly_total &&
    /[ऀ-ॿ]/.test(udyamInGstinField.greeting),
  JSON.stringify([udyamInGstinField.entry_type, udyamInGstinField.next_action]),
);
const bothNumbers = (await onboard({ gstin: "32TTNXB7384T1ZW", udyam_number: UDYAM_CLINIC, show_card: "no" }))
  .outputVars;
test(
  "when the owner gives both, the GSTIN wins (the GST registry also has the status)",
  bothNumbers.entry_type === "gstin" && bothNumbers.gstin_status === "Active" && bothNumbers.udyam_status === "",
  JSON.stringify([bothNumbers.entry_type, bothNumbers.gstin_status]),
);
const udyamBadFormat = (await onboard({ udyam_number: "UDYAM-KL-3078801" })).outputVars;
const udyamTwoNumbers = (await onboard({ udyam_number: UDYAM_CLINIC + " or " + UDYAM_CHAIN })).outputVars;
test(
  "an invalid Udyam number asks the owner to fix it (no lookup); two different numbers ask which one",
  udyamBadFormat.next_action === "fix_udyam" &&
    udyamBadFormat.udyam_status === "INVALID_FORMAT" &&
    udyamBadFormat.udyam_masked === "" &&
    udyamBadFormat.business_name === "" &&
    udyamBadFormat.greeting === udyamInputMessages.en.INVALID_FORMAT &&
    udyamTwoNumbers.next_action === "fix_udyam" &&
    udyamTwoNumbers.udyam_status === "MULTIPLE_UDYAM" &&
    udyamTwoNumbers.greeting.includes("2"),
  JSON.stringify([udyamBadFormat, udyamTwoNumbers.greeting]),
);
const udyamExtraDigit = (await onboard({ udyam_number: UDYAM_CLINIC + "1" })).outputVars;
const verifiedExtraDigit = (await runTool(verifyUdyam, { udyam_number: UDYAM_CLINIC + "1" })).outputVars;
test(
  "a Udyam number with one digit too many is a typo to fix, never read as the shorter registered number",
  udyamExtraDigit.next_action === "fix_udyam" &&
    udyamExtraDigit.business_name === "" &&
    verifiedExtraDigit.udyam_ok === false &&
    verifiedExtraDigit.enterprise_name === "",
  JSON.stringify([udyamExtraDigit.next_action, verifiedExtraDigit.udyam_ok]),
);
const udyamUnknown = (await onboard({ udyam_number: "UDYAM-KL-00-0000001" })).outputVars;
test(
  "a well-formed Udyam number that isn't registered goes to the question-based advisor, not pre-approved",
  udyamUnknown.next_action === "use_advisor" &&
    udyamUnknown.udyam_status === "NOT_FOUND" &&
    udyamUnknown.udyam_valid === true &&
    udyamUnknown.pre_approved === false &&
    udyamUnknown.monthly_total === 0,
  JSON.stringify(udyamUnknown),
);
const udyamNoConsent = (
  await runTool(onboardFromGstin, { udyam_number: UDYAM_CLINIC, lang: "en", as_of_date: CASE_TODAY })
).outputVars;
const udyamConsentNo = (await onboard({ udyam_number: UDYAM_CLINIC, consent_given: "no" })).outputVars;
test(
  "Udyam entry has the same consent gate: no lookup at all without consent_given = yes",
  [udyamNoConsent, udyamConsentNo].every(
    (outputs) =>
      outputs.next_action === "ask_consent" &&
      outputs.udyam_status === "" &&
      outputs.udyam_masked === "" &&
      outputs.business_name === "" &&
      /Udyam/.test(outputs.greeting),
  ),
  JSON.stringify([udyamNoConsent.next_action, udyamConsentNo.next_action]),
);
const udyamEntryChain = (await onboard({ udyam_number: UDYAM_CHAIN, show_card: "no" })).outputVars;
const udyamEntryChainAnswered = (await onboard({ udyam_number: UDYAM_CHAIN, answer_sites: "3–5", show_card: "no" }))
  .outputVars;
test(
  "a Udyam chain gets the one locations question, then a multi-site proposal",
  udyamEntryChain.next_action === "ask_question" &&
    udyamEntryChain.question_type === "locations" &&
    /Udyam registry/.test(udyamEntryChain.greeting) &&
    udyamEntryChainAnswered.next_action === "show_proposal" &&
    udyamEntryChainAnswered.segment_code === "multi",
  JSON.stringify([udyamEntryChain.next_action, udyamEntryChain.greeting, udyamEntryChainAnswered.next_action]),
);
const udyamNew = (await onboard({ udyam_number: UDYAM_NEW, show_card: "no" })).outputVars;
test(
  "a Udyam registration under 6 months old is not pre-approved; an older one is",
  udyamNew.next_action === "show_proposal" &&
    udyamNew.pre_approved === false &&
    /only \d+ months old/.test(udyamNew.pre_approval_reason) &&
    udyamProposal.pre_approved === true,
  JSON.stringify([udyamNew.pre_approved, udyamNew.pre_approval_reason]),
);
test(
  "every Udyam problem has a friendly message in English, Hindi and Kannada, and none shows a code",
  ["en", "hi", "kn"].every((language) =>
    ["INVALID_FORMAT", "MULTIPLE_UDYAM"].every(
      (code) =>
        (udyamInputMessages[language][code] || "").length > 0 &&
        !STATUS_CODE_PATTERN.test(udyamInputMessages[language][code]),
    ),
  ),
);
// One implementation: verify_udyam and onboarding carry exactly the code in _build/udyam_input.js.
const sharedUdyamReaderBody = withUnixLineEndings(
  fs.readFileSync(path.join(testDirectory, "..", "_build", "udyam_input.js"), "utf8"),
).replace("export const UDYAM_INPUT_API = {", "const UDYAM_INPUT_API = {");
sourceTextTest(
  "verify_udyam and onboard_from_gstin embed the same Udyam reader (_build/udyam_input.js), unchanged",
  ["verify_udyam.js", "onboard_from_gstin.js"].every((name) =>
    withUnixLineEndings(fs.readFileSync(path.join(testDirectory, "..", "3_function_tools", name), "utf8")).includes(
      sharedUdyamReaderBody,
    ),
  ),
);
const verifiedSameNumber = (await runTool(verifyUdyam, { udyam_number: "my udyam is " + UDYAM_CLINIC })).outputVars;
test(
  "verify_udyam now also finds the number inside the owner's whole message, and masks it the same way",
  verifiedSameNumber.udyam_ok === true && verifiedSameNumber.udyam_masked === udyamProposal.udyam_masked,
  JSON.stringify(verifiedSameNumber),
);

// ---------------------------------------------------------------- START_HERE.md's tool reference = the code
// The person building in Voiceflow types these names by hand, so the guide must list exactly the inputs each tool
// reads (inputVars.<name> in its _build/ source, plus bill_swap's override fields) and exactly the outputs it returns.
console.log("\nbuild guide: START_HERE.md lists exactly each tool's inputs and outputs");
const startHere = fs.readFileSync(path.join(testDirectory, "..", "START_HERE.md"), "utf8").replace(/\r\n/g, "\n");
const GUIDE_TOOLS = [
  "price_bundle",
  "verify_gstin",
  "verify_udyam",
  "register_lead",
  "order_status",
  "onboard_from_gstin",
  "bill_swap",
  "readiness_score",
  "reach_tag_lead",
  "downtime_credit",
  "consent_manager",
];
/** Input names a tool's source reads: inputVars.<name>, plus a ["a", "b"].forEach((field) list (bill_swap). */
function inputsReadBy(toolName) {
  const source = fs.readFileSync(path.join(testDirectory, "..", "_build", toolName + ".js"), "utf8");
  const names = new Set([...source.matchAll(/inputVars\.([a-z_]+)/g)].map((match) => match[1]));
  const fieldList = source.match(/\[([^\]]+)\]\.forEach\(\(field\) =>/);
  if (fieldList) [...fieldList[1].matchAll(/"([a-z_]+)"/g)].forEach((match) => names.add(match[1]));
  return names;
}
const sameNames = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const guideProblems = [];
for (const toolName of GUIDE_TOOLS) {
  const sectionStart = startHere.indexOf("`" + toolName + "`\n\n- **Voiceflow tool name:**");
  if (sectionStart < 0) {
    guideProblems.push(toolName + ": no section");
    continue;
  }
  const sectionEnd = startHere.indexOf("\n#### ", sectionStart);
  const section = startHere.slice(sectionStart, sectionEnd < 0 ? startHere.indexOf("\n---", sectionStart) : sectionEnd);
  const guideInputs = new Set([...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]));
  const outputsLine = (section.match(/^- \*\*Outputs \(\d+\):\*\* (.*)$/m) || ["", ""])[1];
  const guideOutputs = new Set([...outputsLine.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]));
  const tool = await loadFunctionTool(toolName + ".js");
  const actualOutputs = new Set(Object.keys((await tool({ inputVars: {} })).outputVars));
  if (!sameNames(guideInputs, inputsReadBy(toolName))) {
    guideProblems.push(toolName + " inputs: guide " + [...guideInputs] + " vs code " + [...inputsReadBy(toolName)]);
  }
  if (!sameNames(guideOutputs, actualOutputs)) {
    guideProblems.push(toolName + " outputs: guide " + [...guideOutputs] + " vs code " + [...actualOutputs]);
  }
}
sourceTextTest(
  `START_HERE.md lists exactly the inputs and outputs of all ${GUIDE_TOOLS.length} tools (rebuild the guide if this fails)`,
  guideProblems.length === 0,
  guideProblems.join(" | "),
);
sourceTextTest(
  "the lite GSTIN checker has the same outputs as verify_gstin, so it can stand in under the same name",
  sameNames(
    Object.keys((await verifyGstinLite({ inputVars: {} })).outputVars),
    Object.keys((await verifyGstin({ inputVars: {} })).outputVars),
  ) && sameNames(inputsReadBy("verify_gstin"), new Set(["gstin", "consent_given", "business_name", "lang"])),
);

// ---------------------------------------------------------------- hand-run conversation tests: list and results sheet
// 6_tests/conversation_results.csv is filled in by hand while testing in Voiceflow; it must list exactly the
// conversations in test_conversations.md. Result and Notes are never checked (they are the tester's).
console.log("\nhand-run conversation tests: the results sheet matches the list");
const conversationMarkdown = fs.readFileSync(path.join(testDirectory, "test_conversations.md"), "utf8");
const markdownConversationIds = [...conversationMarkdown.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((match) =>
  Number(match[1]),
);
/** CSV text → rows of fields; quoted fields may hold commas, quotes ("") and line breaks (Excel's format). */
function parseCsvRows(text) {
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
  return rows;
}
const resultsSheetRows = parseCsvRows(
  fs
    .readFileSync(path.join(testDirectory, "conversation_results.csv"), "utf8")
    .replace(new RegExp("^" + String.fromCharCode(0xfeff)), ""),
);
const sheetIds = resultsSheetRows.slice(1).map((row) => Number(row[1]));
const sortedNumbers = (numbers) => numbers.slice().sort((first, second) => first - second);
test(
  `conversation_results.csv has one row per conversation in test_conversations.md (${markdownConversationIds.length})`,
  markdownConversationIds.length > 0 &&
    JSON.stringify(sortedNumbers(sheetIds)) === JSON.stringify(sortedNumbers(markdownConversationIds)) &&
    new Set(sheetIds).size === sheetIds.length,
  JSON.stringify([sortedNumbers(markdownConversationIds), sortedNumbers(sheetIds)]),
);
test(
  "every results-sheet row says what to type and what must happen, and the five most important come first",
  resultsSheetRows.slice(1).every((row) => row.length === 8 && row[4].trim() && row[5].trim()) &&
    JSON.stringify(sheetIds.slice(0, 5)) === JSON.stringify([17, 51, 20, 18, 46]),
  JSON.stringify(sheetIds.slice(0, 5)),
);

// ---------------------------------------------------------------- every successful call returned no error
test(
  `every tool call that should succeed returned no error (${checkedCalls} calls checked; ${callsExpectedToError} bad-input calls expected an error)`,
  callsThatErrored === 0 && checkedCalls > 0,
  `${callsThatErrored} calls returned an error`,
);

console.log(`\n${passedCount} passed, ${failedCount} failed\n`);
process.exit(failedCount ? 1 : 0);
