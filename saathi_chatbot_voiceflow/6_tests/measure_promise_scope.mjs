/*
 * measure_promise_scope.mjs: measures the activation promise against the case data (STRATEGY.md §11).
 *
 * What it reports:
 *   A1  leads without a GSTIN, per segment, and how many of them have a Udyam number in the mock Udyam registry
 *   A2  the strategy's 72-hour figures, recomputed: share of activated bundles whose SLOWEST item installs in ≤ 3
 *       catalogue days, as sold (1.9%) and with Biz Fibre 100/300 bridged by AirFiber's 2 days (45%)
 *   A3  the unscoped promise ("connected in 72 hours" on every order): share missed and month-one credits per
 *       1,000 confirmed orders
 *   B4  the scoped promise exactly as the generated price_bundle decides it (72 hours inside GUARANTEE_SCOPE, firm
 *       days otherwise): share of orders that get the 72-hour guarantee, share missed, credits per 1,000 orders
 *
 * Definitions (the same for A3 and B4, so the two can be compared):
 *   - An order = a lead that reached KYC complete: the order is confirmed and the promise clock starts.
 *   - Its outcome is what the case data recorded. Activated: days from kyc_complete_date to activated_date (dates
 *     only, so "within 72 hours" = within 3 days). Dropped with an INSTALLATION reason ("Installation delayed beyond
 *     21 days", "Site not feasible for fibre"): never connected, so every promise is missed. Dropped for other
 *     reasons (customer cancelled before install, first payment failed): no installation outcome, left out.
 *   - The credit for a missed promise is month one: the order's monthly bill. Dropped orders have no bill, so they
 *     get the median bill of activated orders in their segment, as if the promise had kept them and they were
 *     connected late (the conservative choice). "Activated only" leaves dropped orders out.
 *   - B4 asks price_bundle for each order's quote from what is known at quote time (business type, city, team size,
 *     sites, GSTIN): the card Saathi would have shown. Its connection can differ from the one the lead bought.
 *
 * How it fits: run after changing GUARANTEE_SCOPE, the firm-date rule in gen_kit.py or the AirFiber coverage;
 * STRATEGY.md §11 quotes its numbers. It only reads the case data and calls the generated 3_function_tools/ files.
 *
 * Usage: node 6_tests/measure_promise_scope.mjs "<path to YTL_TrackA_Udyam_Digital_Data>"
 * Sample data: the case pack is SYNTHETIC (fictional operator and businesses). Nothing personal is printed.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// ================================================================ CONFIG

/** "Within 72 hours" at the case data's resolution (whole days). */
const GUARANTEE_DAYS = 3;
/** Drop reasons after KYC that mean the connection never happened (every promise missed). */
const INSTALLATION_DROP_REASONS = ["Installation delayed beyond 21 days", "Site not feasible for fibre"];
/** The AirFiber bridge in the strategy's 45% figure: these products count as AirFiber's install days. */
const BRIDGED_PRODUCT_IDS = ["P01", "P02"];
const AIRFIBER_PRODUCT_ID = "P04";
const ORDERS_PER_REPORT = 1000;
const PERCENT = 100;
const RUPEES_PER_LAKH = 100000;

// ================================================================ LOGIC

/** Minimal CSV reader: quoted fields may hold commas, quotes ("") and line breaks (same as measure_onboarding). */
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
const lakh = (rupees) => "₹" + (rupees / RUPEES_PER_LAKH).toFixed(1) + " lakh";
const productIdsOf = (bundleProducts) => bundleProducts.split(";").map((item) => item.split("x")[0]);
const daysBetween = (fromDate, toDate) => Math.round((Date.parse(toDate) - Date.parse(fromDate)) / 86400000);

function median(values) {
  const sorted = values.slice().sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A1: leads without a GSTIN per segment, and how many have a Udyam number found in the registry. */
function reportLeadsWithoutGstin(leads, udyamNumbers) {
  console.log("\nA1 · leads without a GSTIN");
  const bySegment = {};
  leads.forEach((lead) => {
    const tally = (bySegment[lead.segment] = bySegment[lead.segment] || { leads: 0, noGstin: 0, withUdyam: 0 });
    tally.leads++;
    if (lead.has_gstin === "Y") return;
    tally.noGstin++;
    if (udyamNumbers.has(lead.udyam_number)) tally.withUdyam++;
  });
  const total = { leads: 0, noGstin: 0, withUdyam: 0 };
  Object.entries(bySegment).forEach(([segment, tally]) => {
    ["leads", "noGstin", "withUdyam"].forEach((key) => (total[key] += tally[key]));
    console.log(
      `  ${segment}: ${tally.noGstin} of ${tally.leads} without GSTIN (${percentOf(tally.noGstin, tally.leads)}),` +
        ` ${tally.withUdyam} of them with a Udyam number in the registry`,
    );
  });
  console.log(
    `  all: ${total.noGstin} of ${total.leads} (${percentOf(total.noGstin, total.leads)}); with Udyam ` +
      `${total.withUdyam} (${percentOf(total.withUdyam, total.noGstin)} of them); neither ` +
      `${total.noGstin - total.withUdyam} (${percentOf(total.noGstin - total.withUdyam, total.leads)} of all leads)`,
  );
}

/** A2: the strategy's catalogue-based figures (slowest item ≤ 3 days, as sold and with the AirFiber bridge). */
function reportCatalogueFigures(activated, installDays) {
  console.log("\nA2 · 72-hour figures from the catalogue (every item live, typical_install_days)");
  const slowest = (productIds, bridged) =>
    Math.max(
      ...productIds.map((productId) =>
        bridged && BRIDGED_PRODUCT_IDS.includes(productId) ? installDays[AIRFIBER_PRODUCT_ID] : installDays[productId],
      ),
    );
  const asSold = activated.filter((lead) => slowest(productIdsOf(lead.bundle_products), false) <= GUARANTEE_DAYS);
  const bridged = activated.filter((lead) => slowest(productIdsOf(lead.bundle_products), true) <= GUARANTEE_DAYS);
  console.log(`  as sold: ${asSold.length} of ${activated.length} = ${percentOf(asSold.length, activated.length)}`);
  console.log(
    `  with ${BRIDGED_PRODUCT_IDS.join("/")} bridged by AirFiber (${installDays[AIRFIBER_PRODUCT_ID]} days): ` +
      `${bridged.length} of ${activated.length} = ${percentOf(bridged.length, activated.length)}`,
  );
  const airFiberOrders = activated.filter((lead) => productIdsOf(lead.bundle_products).includes(AIRFIBER_PRODUCT_ID));
  const airFiberOnTime = airFiberOrders.filter((lead) => lead.daysToActivation <= GUARANTEE_DAYS);
  console.log(
    `  observed AirFiber orders: ${airFiberOnTime.length} of ${airFiberOrders.length} live within ${GUARANTEE_DAYS} ` +
      `days; median ${median(airFiberOrders.map((lead) => lead.daysToActivation))} days (catalogue: ` +
      `${installDays[AIRFIBER_PRODUCT_ID]})`,
  );
}

/** Missed share and month-one credits for a list of { order, promiseDays }. */
function summarise(assessed) {
  const missed = assessed.filter(
    (entry) => entry.order.neverConnected || entry.order.daysToActivation > entry.promiseDays,
  );
  const activated = assessed.filter((entry) => !entry.order.neverConnected);
  const missedActivated = missed.filter((entry) => !entry.order.neverConnected);
  const credits = (entries) => entries.reduce((sum, entry) => sum + entry.order.monthlyBill, 0);
  return {
    orders: assessed.length,
    missedShare: percentOf(missed.length, assessed.length),
    creditsPerThousand: (ORDERS_PER_REPORT * credits(missed)) / Math.max(assessed.length, 1),
    activatedMissedShare: percentOf(missedActivated.length, activated.length),
    activatedCreditsPerThousand: (ORDERS_PER_REPORT * credits(missedActivated)) / Math.max(activated.length, 1),
  };
}

function printSummary(label, summary) {
  console.log(
    `  ${label}: ${summary.orders} orders · missed ${summary.missedShare} · ${lakh(summary.creditsPerThousand)} ` +
      `per ${ORDERS_PER_REPORT} orders · activated only: missed ${summary.activatedMissedShare}, ` +
      `${lakh(summary.activatedCreditsPerThousand)} per ${ORDERS_PER_REPORT}`,
  );
}

/** The confirmed orders with an installation outcome, each with its observed days and the bill used for credits. */
function buildOrders(leads) {
  const activated = leads.filter((lead) => lead.outcome === "Activated");
  const billsBySegment = {};
  activated.forEach((lead) => {
    (billsBySegment[lead.segment] = billsBySegment[lead.segment] || []).push(Number(lead.monthly_bundle_value_inr));
  });
  return leads
    .filter((lead) => lead.kyc_complete_date)
    .filter((lead) => lead.outcome === "Activated" || INSTALLATION_DROP_REASONS.includes(lead.drop_reason))
    .map((lead) => {
      const isActivated = lead.outcome === "Activated";
      return Object.assign({}, lead, {
        neverConnected: !isActivated,
        daysToActivation: isActivated ? daysBetween(lead.kyc_complete_date, lead.activated_date) : null,
        monthlyBill: isActivated ? Number(lead.monthly_bundle_value_inr) : median(billsBySegment[lead.segment]),
      });
    });
}

/** B4: the promise price_bundle shows on each order's quote card. */
async function promiseForOrder(priceBundle, order) {
  const quote = (
    await priceBundle({
      inputVars: {
        business_type: order.business_type,
        city: order.city,
        employees: order.employee_count,
        sites: order.num_sites,
        has_gstin: order.has_gstin === "Y" ? "yes" : "no",
        show_card: "no",
      },
    })
  ).outputVars;
  if (quote.error) throw new Error(quote.error);
  return quote;
}

async function main(dataDirectory) {
  const kitDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const priceBundle = (await import(pathToFileURL(path.join(kitDirectory, "3_function_tools", "price_bundle.js")).href))
    .default;
  const leads = readCsv(path.join(dataDirectory, "smb_leads.csv"));
  const catalogue = readCsv(path.join(dataDirectory, "product_catalogue.csv"));
  const udyamNumbers = new Set(
    readCsv(path.join(dataDirectory, "mock_udyam_registry.csv")).map((row) => row.udyam_number),
  );
  const installDays = Object.fromEntries(catalogue.map((row) => [row.product_id, Number(row.typical_install_days)]));

  reportLeadsWithoutGstin(leads, udyamNumbers);

  const orders = buildOrders(leads);
  reportCatalogueFigures(
    orders.filter((order) => !order.neverConnected),
    installDays,
  );

  console.log(
    `\nA3 · unscoped: "connected in ${GUARANTEE_DAYS * 24} hours" on every confirmed order (observed outcomes)`,
  );
  printSummary("every order", summarise(orders.map((order) => ({ order, promiseDays: GUARANTEE_DAYS }))));
  [1, 2].forEach((tier) =>
    printSummary(
      "tier " + tier,
      summarise(
        orders
          .filter((order) => Number(order.city_tier) === tier)
          .map((order) => ({ order, promiseDays: GUARANTEE_DAYS })),
      ),
    ),
  );

  console.log("\nB4 · scoped: the promise price_bundle puts on each order's quote card");
  const assessed = [];
  for (const order of orders) {
    const quote = await promiseForOrder(priceBundle, order);
    assessed.push({ order, promiseDays: quote.promise_days, promiseType: quote.promise_type });
  }
  const qualifying = assessed.filter((entry) => entry.promiseType === "guaranteed_72h");
  console.log(
    `  orders with the 72-hour guarantee: ${qualifying.length} of ${assessed.length} = ` +
      percentOf(qualifying.length, assessed.length),
  );
  printSummary("every order", summarise(assessed));
  printSummary("72-hour guarantee", summarise(qualifying));
  printSummary("firm date", summarise(assessed.filter((entry) => entry.promiseType !== "guaranteed_72h")));
  const qualifyingBills = qualifying.map((entry) => entry.order.monthlyBill);
  console.log(`  median bill of 72-hour orders: ₹${median(qualifyingBills)}`);
  const daysUsed = {};
  assessed.forEach((entry) => {
    const key = entry.promiseType === "guaranteed_72h" ? "72 h" : entry.promiseDays + " days";
    daysUsed[key] = (daysUsed[key] || 0) + 1;
  });
  console.log("  promises shown:", JSON.stringify(daysUsed));

  let allLeadsQualifying = 0;
  for (const lead of leads) {
    if ((await promiseForOrder(priceBundle, lead)).promise_type === "guaranteed_72h") allLeadsQualifying++;
  }
  console.log(
    `  all ${leads.length} leads, quoted at their true size: ${allLeadsQualifying} would see the 72-hour ` +
      `guarantee (${percentOf(allLeadsQualifying, leads.length)})`,
  );
}

if (!process.argv[2]) {
  console.error('Usage: node 6_tests/measure_promise_scope.mjs "<path to YTL_TrackA_Udyam_Digital_Data>"');
  process.exit(1);
}
await main(process.argv[2]);
