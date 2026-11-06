/*
 * downtime_credit.js: Voiceflow function tool "downtime_credit" (TEMPLATE; the build embeds _build/promise_rules.js
 * and the pricing function).
 *
 * What it does: takes an outage on a live order (order ID + duration), applies the documented credit rule in
 * PROMISE_RULES.downtime, and writes the message Saathi sends BEFORE the customer complains.
 *   Rule: from 60 minutes, one day's bill (monthly ÷ 30) per started 4-hour block; half if the bundle has 4G/5G
 *   failover (the business stayed online); at most 50% of the monthly bill per outage.
 *
 * How it fits: STRATEGY.md, PROMISE ("Outcomes, not products"). In production a network-monitoring event would call
 * it; in the demo the order tracker playbook calls it when you simulate an outage.
 *
 * SIMULATED: the outage itself and the demo orders. The monthly bill comes from price_bundle (embedded), never typed in.
 */

/**
 * Voiceflow entry point.
 *
 * @param {{inputVars?: {order_id?: string, outage_duration?: string, lang?: string, show_card?: string}}} args
 *   outage_duration: "3h 20m", "200 minutes", "2.5 hours", "1:30" or a number of minutes.
 * @returns {{outputVars: Object, trace: Array}}  Every declared output, always; `error` on failure.
 * @example
 *   await main({ inputVars: { order_id: "UD-0002", outage_duration: "5h" } })
 *   // → credit_amount = 2 × one day's bill, message "We know your internet was down for 5 h today…"
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const language = detectLanguage(inputVars.lang);
  const text = promise.PROMISE_MESSAGES[language];
  const outputVars = createEmptyOutputs();
  try {
    const orderId = promise.normaliseOrderId(inputVars.order_id);
    const order = promise.DEMO_ORDERS[orderId];
    const outageMinutes = promise.parseDurationMinutes(inputVars.outage_duration);
    if (!order) {
      outputVars.error = ERRORS.unknownOrder + (inputVars.order_id || "(empty)");
      return { outputVars, trace: [] };
    }
    if (outageMinutes === null || outageMinutes <= 0) {
      outputVars.error = ERRORS.unreadableDuration + (inputVars.outage_duration || "(empty)");
      return { outputVars, trace: [] };
    }
    outputVars.order_found = true;
    outputVars.is_demo = true;
    outputVars.outage_minutes = outageMinutes;
    const quote = (await priceBundleMain({ inputVars: Object.assign({ show_card: "no" }, order.pricingInputs) }))
      .outputVars;
    if (quote.error) throw new Error(quote.error);
    const guarantee = promise.evaluateGuarantee(order, new Date(), quote.promise_hours);
    outputVars.is_live = guarantee.connectedAt !== null;
    if (!outputVars.is_live) {
      // Not connected yet: there is no service to credit. The activation guarantee covers this period instead.
      outputVars.credit_rule = NOT_LIVE_RULE;
      return { outputVars, trace: [] };
    }
    const credit = promise.computeDowntimeCredit(
      outageMinutes,
      quote.monthly_total,
      JSON.parse(quote.items_json || "[]"),
    );
    outputVars.monthly_total = quote.monthly_total;
    outputVars.credit_amount = credit.creditInRupees;
    outputVars.has_failover = credit.hasFailover;
    outputVars.credit_rule = credit.ruleText;
    const values = {
      duration: promise.formatDuration(outageMinutes),
      credit: promise.formatRupees(credit.creditInRupees),
      minimum: promise.PROMISE_RULES.downtime.minimumMinutesForCredit,
    };
    const template = credit.isBelowThreshold
      ? text.downtimeBelowThreshold
      : credit.hasFailover
        ? text.downtimeCreditFailover
        : text.downtimeCredit;
    outputVars.message = promise.fillTemplate(template, values) + " " + text.demoLabel;
    const shouldShow = String(inputVars.show_card || "yes").toLowerCase() !== "no";
    return { outputVars, trace: shouldShow ? [{ type: "text", payload: { message: outputVars.message } }] : [] };
  } catch (error) {
    outputVars.error = ERRORS.prefix + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG

const NOT_LIVE_RULE =
  "order not live yet: no downtime credit (the activation guarantee on the quote covers this period)";
const ERRORS = {
  prefix: "downtime_credit failed: ",
  unknownOrder: "downtime_credit: unknown order ",
  unreadableDuration: "downtime_credit: can't read the outage duration ",
};

// ================================================================ LOGIC

function createEmptyOutputs() {
  return {
    order_found: false,
    is_demo: false,
    is_live: false,
    outage_minutes: 0,
    monthly_total: 0,
    has_failover: false,
    credit_amount: 0,
    credit_rule: "",
    message: "",
    error: "",
  };
}

function detectLanguage(languageInput) {
  const value = String(languageInput || "").trim();
  if (/^(hi|hindi|हिंदी|hinglish)/i.test(value)) return "hi";
  if (/^(kn|kannada|ಕನ್ನಡ)/i.test(value)) return "kn";
  return "en";
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/** The PROMISE rules (_build/promise_rules.js), embedded unchanged; order_status.js embeds the same code. */
const promise = /*__PROMISE_RULES__*/ null;
/** The real pricing function (price_bundle main), embedded unchanged: credits are shares of its monthly bill. */
const priceBundleMain = /*__PRICE_BUNDLE_MAIN__*/ null;
