/*
 * order_status.js: Voiceflow function tool "order_status" (TEMPLATE; the build embeds _build/promise_rules.js and
 * the pricing function).
 *
 * What it does: shows an order's timeline and its activation promise. The promise is the one the order's quote card
 * showed: price_bundle's promise_hours for the order's pricing inputs (72 h inside the guarantee's scope, a firm
 * number of days otherwise; STRATEGY.md §11). Deadline = confirmed + that promise. Past the deadline without a
 * connection, the order is "breached" and month one is credited. It also returns the proactive messages Saathi sends at each stage, and counts chases: the second time a
 * customer asks unprompted, the order is flagged for retention.
 *
 * How it fits: the "Order tracker" playbook calls it (is_chase = "yes" when the owner asked without being prompted).
 * The case data showed 3 status chases per customer, and churn rising from 5.9% (1 chase) to 27.9% (5 chases).
 *
 * SIMULATED: the demo orders (built from case leads, times relative to now) and the message delivery. Production
 * would read the order system (BSS/OSS) and send the messages as WhatsApp templates. Every timeline shown to the
 * owner says it's a demo order.
 */

/**
 * Voiceflow entry point.
 *
 * @param {{inputVars?: {order_id?: string, lang?: string, is_chase?: string, previous_chases?: string}}} args
 * @returns {{outputVars: Object, trace?: Array}}  Every declared output, always; `error` on failure.
 * @example
 *   await main({ inputVars: { order_id: "UD-0001", is_chase: "yes", lang: "en" } })
 *   // → promise_type "firm_date", promise_hours 240, guarantee_status "breached", month_one_credit = the monthly
 *   //   bill, chase_count 2, retention_flag true
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const language = detectLanguage(inputVars.lang);
  const text = MESSAGES[language];
  const outputVars = createEmptyOutputs();
  try {
    const orderId = promise.normaliseOrderId(inputVars.order_id);
    const order = promise.DEMO_ORDERS[orderId];
    if (!order) {
      outputVars.tracker_text = text.orderNotFound;
      return { outputVars, trace: [{ type: "text", payload: { message: outputVars.tracker_text } }] };
    }
    const now = new Date();
    const quote = (await priceBundleMain({ inputVars: Object.assign({ show_card: "no" }, order.pricingInputs) }))
      .outputVars;
    if (quote.error) throw new Error(quote.error);
    // The deadline is the promise from this order's own quote card: the same price_bundle call that made the card.
    const guarantee = promise.evaluateGuarantee(order, now, quote.promise_hours);
    const credit = promise.monthOneCredit(guarantee, quote.monthly_total);
    const messages = promise.proactiveMessages(order, orderId, guarantee, credit, now, language);
    const chases = promise.trackChases(order, parseCount(inputVars.previous_chases), isYes(inputVars.is_chase));

    outputVars.order_found = true;
    outputVars.is_demo = true;
    outputVars.promise_type = quote.promise_type;
    outputVars.promise_hours = quote.promise_hours;
    outputVars.order_confirmed_at = guarantee.confirmedAt.toISOString();
    outputVars.guarantee_deadline = guarantee.deadline.toISOString();
    outputVars.hours_to_deadline = guarantee.hoursToDeadline;
    outputVars.guarantee_status = guarantee.status;
    outputVars.connected_at = guarantee.connectedAt ? guarantee.connectedAt.toISOString() : "";
    outputVars.monthly_total = quote.monthly_total;
    outputVars.month_one_credit = credit;
    outputVars.proactive_messages_json = JSON.stringify(
      messages.sent.map((entry) => ({ stage: entry.stage, at: entry.at.toISOString(), message: entry.message })),
    );
    outputVars.next_proactive_message = messages.next ? messages.next.message : "";
    outputVars.chase_count = chases.chaseCount;
    outputVars.retention_flag = chases.retentionFlag;
    const lastSent = messages.sent[messages.sent.length - 1];
    // The order's own stage: the breach notice is a message about the order, not a stage of it.
    const lastStage = messages.sent.filter((entry) => entry.stage !== promise.BREACH_NOTICE_STAGE).pop();
    outputVars.order_stage = lastStage ? text.stageLabels[lastStage.stage] : "";
    outputVars.next_step = messages.next ? messages.next.message : lastSent ? lastSent.message : "";
    outputVars.tracker_text = writeTracker(orderId, order, guarantee, credit, messages, now, language, quote);
    return { outputVars, trace: [{ type: "text", payload: { message: outputVars.tracker_text } }] };
  } catch (error) {
    outputVars.error = MESSAGES.errorPrefix + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG

const STATUS_ICON = { done: "✅", next: "🔴", later: "⚪", missed: "⚠️" };
const MILLISECONDS_PER_HOUR = 3600000;
const YES_WORDS = ["yes", "y", "true", "1", "haan", "हाँ", "ಹೌದು"];

// ================================================================ MESSAGES (all user-facing text)
// Kannada text was written for this prototype; have a native speaker review it before going live.

const MESSAGES = {
  errorPrefix: "order_status failed: ",
  en: {
    orderNotFound:
      "I couldn't find that order. Order numbers look like UD-0068. Could you check it, or shall I book a callback?",
    orderPrefix: "Order ",
    nextPrefix: "Next: ",
    promiseName: { guaranteed_72h: "72-hour guarantee", firm_date: "{days}-day guarantee" },
    promiseOnTrack: "{promise}: connected by {deadline} ({hours} h left).",
    promiseMet: "{promise} kept: connected in {hours} h.",
    promiseBreached: "{promise} missed: month one is free ({credit} credited to your first bill).",
    stageLabels: {
      confirmed: "Order confirmed",
      kyc_verified: "KYC verified",
      bridge_scheduled: "5G AirFiber bridge booked",
      installer_assigned: "Installer visit",
      connected: "Connected",
      fibre_installed: "Fibre installed",
      live: "Installed and live",
      first_bill: "First single bill",
      guarantee_breached: "Promise missed",
    },
  },
  hi: {
    orderNotFound:
      "यह ऑर्डर नहीं मिला। ऑर्डर नंबर कुछ ऐसा होता है: UD-0068. एक बार जाँच लेंगे, या मैं कॉल-बैक बुक कर दूँ?",
    orderPrefix: "ऑर्डर ",
    nextPrefix: "अगला कदम: ",
    promiseName: { guaranteed_72h: "72 घंटे की गारंटी", firm_date: "{days} दिन की गारंटी" },
    promiseOnTrack: "{promise}: {deadline} तक कनेक्शन ({hours} घंटे बाकी)।",
    promiseMet: "{promise} पूरी: {hours} घंटे में कनेक्ट।",
    promiseBreached: "{promise} पूरी नहीं हुई: पहला महीना मुफ़्त ({credit} आपके पहले बिल में क्रेडिट)।",
    stageLabels: {
      confirmed: "ऑर्डर पक्का",
      kyc_verified: "KYC वेरिफ़ाइड",
      bridge_scheduled: "5G AirFiber ब्रिज बुक",
      installer_assigned: "इंस्टॉलर विज़िट",
      connected: "कनेक्ट",
      fibre_installed: "फाइबर लगा",
      live: "इंस्टॉल होकर चालू",
      first_bill: "पहला सिंगल बिल",
      guarantee_breached: "वादा पूरा नहीं हुआ",
    },
  },
  kn: {
    orderNotFound:
      "ಆ ಆರ್ಡರ್ ಸಿಗಲಿಲ್ಲ. ಆರ್ಡರ್ ಸಂಖ್ಯೆ ಹೀಗಿರುತ್ತದೆ: UD-0068. ದಯವಿಟ್ಟು ಪರಿಶೀಲಿಸಿ, ಅಥವಾ ಕಾಲ್‌ಬ್ಯಾಕ್ ಬುಕ್ ಮಾಡಲೇ?",
    orderPrefix: "ಆರ್ಡರ್ ",
    nextPrefix: "ಮುಂದಿನ ಹಂತ: ",
    promiseName: { guaranteed_72h: "72 ಗಂಟೆಗಳ ಗ್ಯಾರಂಟಿ", firm_date: "{days} ದಿನಗಳ ಗ್ಯಾರಂಟಿ" },
    promiseOnTrack: "{promise}: {deadline} ಒಳಗೆ ಸಂಪರ್ಕ ({hours} ಗಂಟೆ ಬಾಕಿ).",
    promiseMet: "{promise} ಪೂರ್ಣ: {hours} ಗಂಟೆಗಳಲ್ಲಿ ಸಂಪರ್ಕ.",
    promiseBreached: "{promise} ಪೂರ್ಣಗೊಳ್ಳಲಿಲ್ಲ: ಮೊದಲ ತಿಂಗಳು ಉಚಿತ ({credit} ಮೊದಲ ಬಿಲ್‌ಗೆ ಕ್ರೆಡಿಟ್).",
    stageLabels: {
      confirmed: "ಆರ್ಡರ್ ಖಚಿತ",
      kyc_verified: "KYC ಪರಿಶೀಲನೆ ಪೂರ್ಣ",
      bridge_scheduled: "5G AirFiber ಸೇತುವೆ ಬುಕ್",
      installer_assigned: "ಇನ್‌ಸ್ಟಾಲರ್ ಭೇಟಿ",
      connected: "ಸಂಪರ್ಕಗೊಂಡಿದೆ",
      fibre_installed: "ಫೈಬರ್ ಅಳವಡಿಸಲಾಗಿದೆ",
      live: "ಅಳವಡಿಸಿ ಚಾಲನೆಯಲ್ಲಿದೆ",
      first_bill: "ಮೊದಲ ಏಕ ಬಿಲ್",
      guarantee_breached: "ಭರವಸೆ ಪೂರ್ಣಗೊಳ್ಳಲಿಲ್ಲ",
    },
  },
};

// ================================================================ LOGIC

function createEmptyOutputs() {
  return {
    order_found: false,
    order_stage: "",
    next_step: "",
    tracker_text: "",
    is_demo: false,
    promise_type: "",
    promise_hours: 0,
    order_confirmed_at: "",
    guarantee_deadline: "",
    hours_to_deadline: 0,
    guarantee_status: "",
    connected_at: "",
    monthly_total: 0,
    month_one_credit: 0,
    proactive_messages_json: "[]",
    next_proactive_message: "",
    chase_count: 0,
    retention_flag: false,
    error: "",
  };
}

function detectLanguage(languageInput) {
  const value = String(languageInput || "").trim();
  if (/^(hi|hindi|हिंदी|hinglish)/i.test(value)) return "hi";
  if (/^(kn|kannada|ಕನ್ನಡ)/i.test(value)) return "kn";
  return "en";
}

function isYes(value) {
  return (
    YES_WORDS.indexOf(
      String(value === undefined || value === null ? "" : value)
        .trim()
        .toLowerCase(),
    ) >= 0
  );
}

function parseCount(value) {
  const number = parseInt(String(value === undefined || value === null ? "" : value).replace(/[^0-9]/g, ""), 10);
  return isFinite(number) ? number : 0;
}

/** "72-hour guarantee" or "7-day guarantee": the promise the order's quote card showed, in the owner's language. */
function promiseName(quote, language) {
  return promise.fillTemplate(MESSAGES[language].promiseName[quote.promise_type], { days: quote.promise_days });
}

/** The timeline: what's done (✅), what's next (🔴), what comes later (⚪); then the promise line and the demo label. */
function writeTracker(orderId, order, guarantee, credit, messages, now, language, quote) {
  const text = MESSAGES[language];
  const name = promiseName(quote, language);
  const labelOf = (stage) => text.stageLabels[stage] || stage;
  const iconOf = (stage) => (stage === promise.BREACH_NOTICE_STAGE ? STATUS_ICON.missed : STATUS_ICON.done);
  const lines = messages.sent.map(
    (entry) => iconOf(entry.stage) + " " + labelOf(entry.stage) + " · " + promise.formatIstDateTime(entry.at, language),
  );
  const sentStages = messages.sent.map((entry) => entry.stage);
  order.events
    .filter((event) => sentStages.indexOf(event.stage) < 0)
    .forEach((event, index) => {
      const at = new Date(guarantee.confirmedAt.getTime() + event.hoursAfterConfirm * MILLISECONDS_PER_HOUR);
      lines.push(
        (index === 0 ? STATUS_ICON.next : STATUS_ICON.later) +
          " " +
          labelOf(event.stage) +
          " · " +
          promise.formatIstDateTime(at, language),
      );
    });
  const promiseLine =
    guarantee.status === promise.GUARANTEE_STATUS.BREACHED
      ? promise.fillTemplate(text.promiseBreached, { promise: name, credit: promise.formatRupees(credit) })
      : guarantee.status === promise.GUARANTEE_STATUS.MET
        ? promise.fillTemplate(text.promiseMet, { promise: name, hours: guarantee.connectedAfterHours })
        : promise.fillTemplate(text.promiseOnTrack, {
            promise: name,
            deadline: promise.formatIstDateTime(guarantee.deadline, language),
            hours: guarantee.hoursToDeadline,
          });
  const nextLine = messages.next ? text.nextPrefix + messages.next.message : "";
  return [
    text.orderPrefix + orderId + " · " + order.bundleName + " · " + order.businessName,
    lines.join("\n"),
    promiseLine,
    nextLine,
    promise.PROMISE_MESSAGES[language].demoLabel,
  ]
    .filter(Boolean)
    .join("\n");
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/** The PROMISE rules (_build/promise_rules.js), embedded unchanged; downtime_credit.js embeds the same code. */
const promise = /*__PROMISE_RULES__*/ null;
/** The real pricing function (price_bundle main), embedded unchanged: the month-one credit is its monthly bill. */
const priceBundleMain = /*__PRICE_BUNDLE_MAIN__*/ null;
