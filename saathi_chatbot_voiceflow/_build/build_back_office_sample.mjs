/*
 * build_back_office_sample.mjs: builds 8_back_office/sample_leads.js, the SIMULATED sample the back-office page
 * shows when no Google Sheet is loaded.
 *
 * How it fits: called by _build/gen_kit.py after the function tools are generated. Every case lead
 * (smb_leads.csv, synthetic) becomes one sheet-style row, using the REAL tools, so the sample behaves like the
 * chatbot:
 *   - lead_score / priority: 3_function_tools/register_lead.js (the existing lead-scoring model)
 *   - bundle viewed: 3_function_tools/price_bundle.js, for leads that didn't activate. SIMULATED: what Saathi would
 *     have proposed. Activated leads keep their real monthly bill.
 *   - referral codes: 8_back_office/reach_rules.js. SIMULATED: "Referral" leads get a customer or CA-partner code,
 *     and "Field sales" leads their city rep's code.
 *   - closed_by: field sales → field_rep, channel partner → partner, everything else → saathi. SIMULATED: as if
 *     Saathi had handled the digital leads.
 * Usage: node _build/build_back_office_sample.mjs <case data folder> <kit folder> <as-of date YYYY-MM-DD>
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const [caseDataDir, kitDir, asOfDate] = process.argv.slice(2);
if (!caseDataDir || !kitDir || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate || "")) {
  console.error("usage: node build_back_office_sample.mjs <case data folder> <kit folder> <YYYY-MM-DD>");
  process.exit(2);
}

/** Share of "Referral" leads attributed to a customer micro-agent; the rest go to a CA partner. Design choice. */
const CUSTOMER_SHARE_OF_REFERRALS = 0.6;
/** register_lead treats missing fields as average; pass what the sheet would hold. */
const NEED_BY_PRODUCT = {
  P09: "failover",
  P10: "sdwan",
  P11: "staticip",
  P12: "telephony",
  P13: "tollfree",
  P14: "sms",
  P15: "whatsapp",
  P16: "email",
  P17: "storage",
  P18: "website",
  P19: "pos",
  P20: "security",
  P21: "firewall",
  P22: "wifi",
  P23: "cctv",
  P24: "iot",
  P25: "fleet",
};
const CLOSED_BY_SOURCE = { "Field sales": "field_rep", "Channel partner": "partner" };
const SEGMENT_CODE = {
  "Micro retail & services": "micro",
  "Professional offices": "prof",
  "Small multi-site businesses": "multi",
  "Small manufacturers": "mfg",
};

/** Minimal CSV reader that understands quoted fields with commas and doubled quotes. */
function readCsv(filePath) {
  // Strip a byte-order mark (U+FEFF) if the CSV was saved by Excel.
  const text = fs.readFileSync(filePath, "utf8").replace(new RegExp("^\\uFEFF"), "");
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
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((candidate) => candidate.length > 1);
  return body.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
}

/** Small deterministic hash (FNV-1a), so the simulated referral attribution is the same on every build. */
function stableFraction(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash / 4294967296;
}

function maskGstin(gstin) {
  return gstin && gstin.length === 15 ? gstin.slice(0, 5) + "•".repeat(7) + gstin.slice(-3) : "";
}

const loadTool = async (name) =>
  (await import(pathToFileURL(path.join(kitDir, "3_function_tools", name)).href)).default;
const registerLead = await loadTool("register_lead.js");
const priceBundle = await loadTool("price_bundle.js");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(kitDir, "8_back_office", "reach_rules.js"), "utf8"), sandbox);
const rules = sandbox.window.ReachRules;

const leads = readCsv(path.join(caseDataDir, "smb_leads.csv"));
const gstStatus = Object.fromEntries(
  readCsv(path.join(caseDataDir, "mock_gstin_registry.csv")).map((row) => [row.gstin, row.status]),
);
const territoryByCity = Object.fromEntries(rules.TERRITORIES.map((territory) => [territory.city, territory]));
const customersByTerritory = {};
rules.REFERRER_DIRECTORY.filter((referrer) => referrer.type === "customer").forEach((customer) => {
  (customersByTerritory[customer.territoryId] = customersByTerritory[customer.territoryId] || []).push(customer);
});

/** SIMULATED referral attribution (see header). Returns a referral code or "". */
function simulatedReferralCode(lead) {
  const territory = territoryByCity[lead.city];
  if (!territory) return "";
  if (lead.lead_source === "Field sales") return rules.issueReferralCode("field_rep", territory.repId);
  if (lead.lead_source !== "Referral") return "";
  const fraction = stableFraction(lead.lead_id);
  const customers = (customersByTerritory[territory.id] || []).filter((customer) => customer.id !== lead.lead_id);
  if (fraction < CUSTOMER_SHARE_OF_REFERRALS && customers.length) {
    const customer = customers[Math.floor((fraction / CUSTOMER_SHARE_OF_REFERRALS) * customers.length)];
    return rules.issueReferralCode("customer", customer.id);
  }
  const partnerNumber = fraction < (1 + CUSTOMER_SHARE_OF_REFERRALS) / 2 ? 1 : 2;
  return rules.issueReferralCode("ca_partner", "CA-" + territory.id.slice(2) + "-" + partnerNumber);
}

const sampleRows = [];
for (const lead of leads) {
  const needs = (lead.products_of_interest || "")
    .split(";")
    .map((productId) => NEED_BY_PRODUCT[productId])
    .filter(Boolean)
    .join(", ");
  const score = (
    await registerLead({
      inputVars: {
        segment: lead.segment,
        business_type: lead.business_type,
        city: lead.city,
        language: lead.preferred_language,
        employees: lead.employee_count,
        sites: lead.num_sites,
        has_gstin: lead.has_gstin,
        has_udyam: lead.has_udyam,
        current_internet: lead.current_internet,
        current_provider: lead.current_provider,
        contact_role: lead.contact_role,
        monthly_spend: lead.monthly_telecom_spend_inr,
        needs: lead.products_of_interest,
      },
    })
  ).outputVars;
  const isActivated = lead.outcome === "Activated";
  const quote = (
    await priceBundle({
      inputVars: {
        business_type: lead.business_type,
        city: lead.city,
        employees: lead.employee_count,
        sites: lead.num_sites,
        has_gstin: lead.has_gstin === "Y" ? "yes" : "no",
        needs,
        show_card: "no",
      },
    })
  ).outputVars;
  sampleRows.push({
    created_at: lead.created_date,
    ref_id: lead.lead_id,
    stage: lead.stage_reached,
    priority: score.priority,
    lead_score: score.lead_score,
    contact_name: lead.contact_name,
    language: lead.preferred_language,
    business_name: lead.business_name,
    business_type: lead.business_type,
    segment_code: SEGMENT_CODE[lead.segment],
    city: lead.city,
    state: lead.state,
    has_gstin: lead.has_gstin,
    gstin_masked: maskGstin(lead.gstin),
    gstin_status: gstStatus[lead.gstin] || "",
    bundle_name: quote.bundle_name,
    monthly_total: isActivated ? Number(lead.monthly_bundle_value_inr) : quote.monthly_total,
    reason_not_closed: lead.drop_reason,
    referral_code: simulatedReferralCode(lead),
    closed_by: CLOSED_BY_SOURCE[lead.lead_source] || "saathi",
    activated_date: lead.activated_date,
    churned: lead.churned_within_6_months,
    lead_source: lead.lead_source,
  });
}

const output =
  "/* GENERATED by _build/build_back_office_sample.mjs: do not edit.\n" +
  " * SIMULATED back-office sample: the 5,000 synthetic case leads as sheet rows (see the script header). */\n" +
  "window.SAMPLE_AS_OF = " +
  JSON.stringify(asOfDate) +
  ";\n" +
  "window.SAMPLE_LEADS = " +
  JSON.stringify(sampleRows) +
  ";\n";
fs.writeFileSync(path.join(kitDir, "8_back_office", "sample_leads.js"), output, "utf8");
const unclosed = sampleRows.filter((row) => row.stage !== "Activated").length;
console.log(
  `back-office sample: ${sampleRows.length} rows, ${unclosed} unclosed, ${(output.length / 1024).toFixed(0)} KB`,
);
