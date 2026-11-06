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
const promise = (function embeddedPROMISE_RULES_API() {
/*
 * promise_rules.js: PROMISE layer rules (TEMPLATE; embedded unchanged in order_status.js and downtime_credit.js).
 *
 * What it does (STRATEGY.md, PROMISE: "Outcomes, not products"):
 *   - Activation promise: every order stores when it was confirmed and its deadline = confirmed + the promise shown on
 *     its quote card (price_bundle's promise_hours: 72 h for orders in the guarantee's scope, a firm number of days
 *     for the rest; STRATEGY.md §11). If it isn't connected by then, it's "breached" and month one is credited.
 *   - Proactive messages: one message per order stage, so the customer never needs to chase.
 *   - Chases: counts how often the customer asks anyway; the second chase is flagged for retention.
 *   - Downtime auto-credit: a documented rule turns an outage into a bill credit, announced before they complain.
 *
 * All thresholds live in ONE object, PROMISE_RULES. Money amounts are always shares of the order's monthly bill,
 * which the calling function gets from price_bundle; nothing here invents a price.
 *
 * SIMULATED: the demo orders below (built from leads in the case data), their timelines and the outage events.
 * Production would read orders from the order system (BSS/OSS), outages from network monitoring, and send the
 * proactive messages through WhatsApp templates.
 */

// ================================================================ CONFIG: the rules (one object)

/**
 * PROMISE_RULES: every threshold of the promise layer.
 * - guarantee: "connected" = the internet connection plus business SIMs are live, with 5G AirFiber allowed as a
 *   bridge while fibre is installed. HOW LONG is not decided here: price_bundle decides it at quote time
 *   (GUARANTEE_SCOPE: 72 hours for qualifying orders, a firm number of days from the case data for the rest) and
 *   the tracker enforces the promise the quote card showed. A breach credits month one: 100% of the first bill.
 * - chases: in smb_leads.csv, customers who chased once churned at 5.9%; five times, 27.9%. The second chase is the
 *   earliest point where a pattern starts, so it goes to retention.
 * - downtime: one day's bill (monthly ÷ 30) for every started 4-hour block of outage, from 60 minutes up; half if
 *   the bundle has 4G/5G failover (the business stayed online, just slower); at most 50% of the monthly bill per
 *   outage. Design choices, simple enough for an owner to check on their own bill.
 */
const PROMISE_RULES = {
  guarantee: { breachCreditShareOfMonthlyBill: 1.0 },
  chases: { retentionFlagAtChase: 2 },
  downtime: {
    minimumMinutesForCredit: 60,
    blockHours: 4,
    daysPerMonth: 30,
    failoverProductId: "P09",
    failoverFactor: 0.5,
    maxShareOfMonthlyBill: 0.5,
  },
};

/** Timeline entry added when the deadline passes unconnected (not an order stage: the order carries on). */
const BREACH_NOTICE_STAGE = "guarantee_breached";
const GUARANTEE_STATUS = { ON_TRACK: "on_track", MET: "met", BREACHED: "breached" };
/** Stages that count as "connected" for the guarantee (AirFiber bridge or fibre/leased line live). */
const CONNECTED_STAGES = ["connected", "live"];
const MILLISECONDS_PER_HOUR = 3600000;
const MINUTES_PER_HOUR = 60;
const IST_OFFSET_MINUTES = 330;
const MILLISECONDS_PER_MINUTE = 60000;

// ================================================================ MESSAGES (proactive messages, all languages)
// Kannada text was written for this prototype; have a native speaker review it before going live.

const PROMISE_MESSAGES = {
  en: {
    stages: {
      confirmed:
        "Order {orderId} confirmed. Our promise starts now: you'll be connected by {deadline}, or month one is free.",
      kyc_verified: "Your business is verified. No paperwork needed.",
      bridge_scheduled:
        "Fibre at your address takes a few more days, so we'll connect you on 5G AirFiber first, before {deadline}.",
      installer_assigned: "An installer is booked for {when}. You'll get a reminder the evening before.",
      connected: "You're live! Connected {hours} hours after your order. Promise kept.",
      fibre_installed: "Fibre is now installed and we've switched you over from AirFiber. Nothing for you to do.",
      live: "You're live! Connected {hours} hours after your order.",
      first_bill: "Your first single bill is due on {when}. UPI Autopay is on.",
    },
    breached:
      "We missed our promise to connect order {orderId} by {deadline}. We're sorry. Month one ({credit}) is free: it's credited to your first bill automatically.",
    downtimeCredit:
      "We know your internet was down for {duration} today. Sorry about that. {credit} has been credited to your next bill automatically. You don't need to call.",
    downtimeCreditFailover:
      "Your internet was down for {duration} today; your 4G/5G backup kept you online. Sorry for the slower service. {credit} has been credited to your next bill automatically.",
    downtimeBelowThreshold:
      "There was a short outage today ({duration}). It's fixed. Outages under {minimum} minutes don't get a credit, but we wanted you to know.",
    demoLabel: "(Demo order: simulated data.)",
  },
  hi: {
    stages: {
      confirmed:
        "ऑर्डर {orderId} पक्का हो गया। हमारा वादा अभी शुरू: {deadline} तक आप कनेक्ट होंगे, वरना पहला महीना मुफ़्त।",
      kyc_verified: "आपका बिज़नेस वेरिफ़ाई हो गया। कोई कागज़ी काम नहीं।",
      bridge_scheduled:
        "आपके पते पर फाइबर में कुछ दिन और लगेंगे, इसलिए {deadline} से पहले हम आपको 5G AirFiber से जोड़ देंगे।",
      installer_assigned: "इंस्टॉलर {when} के लिए बुक है। एक दिन पहले शाम को रिमाइंडर मिलेगा।",
      connected: "आप चालू हैं! ऑर्डर के {hours} घंटे में कनेक्ट। वादा पूरा।",
      fibre_installed: "फाइबर लग गया है और हमने आपको AirFiber से फाइबर पर शिफ़्ट कर दिया है। आपको कुछ नहीं करना।",
      live: "आप चालू हैं! ऑर्डर के {hours} घंटे में कनेक्ट।",
      first_bill: "आपका पहला सिंगल बिल {when} को है। UPI Autopay चालू है।",
    },
    breached:
      "ऑर्डर {orderId} को {deadline} तक कनेक्ट करने का हमारा वादा पूरा नहीं हुआ। माफ़ कीजिए। पहला महीना ({credit}) मुफ़्त है: यह आपके पहले बिल में अपने-आप क्रेडिट हो गया है।",
    downtimeCredit:
      "हमें पता है कि आज आपका इंटरनेट {duration} बंद रहा। माफ़ कीजिए। आपके अगले बिल में {credit} अपने-आप क्रेडिट हो गया है। कॉल करने की ज़रूरत नहीं।",
    downtimeCreditFailover:
      "आज आपका इंटरनेट {duration} बंद रहा; आपके 4G/5G बैकअप ने आपको ऑनलाइन रखा। धीमी सर्विस के लिए माफ़ी। आपके अगले बिल में {credit} अपने-आप क्रेडिट हो गया है।",
    downtimeBelowThreshold:
      "आज थोड़ी देर ({duration}) सर्विस रुकी थी, अब ठीक है। {minimum} मिनट से कम की रुकावट पर क्रेडिट नहीं मिलता, पर हम आपको बताना चाहते थे।",
    demoLabel: "(डेमो ऑर्डर: सिम्युलेटेड डेटा।)",
  },
  kn: {
    stages: {
      confirmed:
        "ಆರ್ಡರ್ {orderId} ಖಚಿತವಾಗಿದೆ. ನಮ್ಮ ಭರವಸೆ ಈಗ ಆರಂಭ: {deadline} ಒಳಗೆ ನಿಮಗೆ ಸಂಪರ್ಕ, ಇಲ್ಲದಿದ್ದರೆ ಮೊದಲ ತಿಂಗಳು ಉಚಿತ.",
      kyc_verified: "ನಿಮ್ಮ ವ್ಯಾಪಾರ ಪರಿಶೀಲನೆಯಾಗಿದೆ. ಯಾವುದೇ ದಾಖಲೆ ಕೆಲಸ ಬೇಕಿಲ್ಲ.",
      bridge_scheduled:
        "ನಿಮ್ಮ ವಿಳಾಸಕ್ಕೆ ಫೈಬರ್‌ಗೆ ಇನ್ನೂ ಕೆಲವು ದಿನ ಬೇಕು, ಆದ್ದರಿಂದ {deadline} ಮೊದಲು 5G AirFiber ಮೂಲಕ ಸಂಪರ್ಕ ನೀಡುತ್ತೇವೆ.",
      installer_assigned: "ಇನ್‌ಸ್ಟಾಲರ್ {when} ಗೆ ಬುಕ್ ಆಗಿದ್ದಾರೆ. ಹಿಂದಿನ ದಿನ ಸಂಜೆ ಜ್ಞಾಪನೆ ಬರುತ್ತದೆ.",
      connected: "ನೀವು ಈಗ ಆನ್‌ಲೈನ್! ಆರ್ಡರ್ ಮಾಡಿದ {hours} ಗಂಟೆಗಳಲ್ಲಿ ಸಂಪರ್ಕ. ಭರವಸೆ ಪೂರ್ಣ.",
      fibre_installed: "ಫೈಬರ್ ಅಳವಡಿಸಲಾಗಿದೆ, AirFiber ನಿಂದ ಫೈಬರ್‌ಗೆ ಬದಲಿಸಿದ್ದೇವೆ. ನೀವು ಏನೂ ಮಾಡಬೇಕಿಲ್ಲ.",
      live: "ನೀವು ಈಗ ಆನ್‌ಲೈನ್! ಆರ್ಡರ್ ಮಾಡಿದ {hours} ಗಂಟೆಗಳಲ್ಲಿ ಸಂಪರ್ಕ.",
      first_bill: "ನಿಮ್ಮ ಮೊದಲ ಏಕ ಬಿಲ್ {when} ರಂದು. UPI Autopay ಚಾಲನೆಯಲ್ಲಿದೆ.",
    },
    breached:
      "ಆರ್ಡರ್ {orderId} ಅನ್ನು {deadline} ಒಳಗೆ ಸಂಪರ್ಕಿಸುವ ನಮ್ಮ ಭರವಸೆ ಪೂರ್ಣಗೊಳ್ಳಲಿಲ್ಲ. ಕ್ಷಮಿಸಿ. ಮೊದಲ ತಿಂಗಳು ({credit}) ಉಚಿತ: ನಿಮ್ಮ ಮೊದಲ ಬಿಲ್‌ಗೆ ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಕ್ರೆಡಿಟ್ ಆಗಿದೆ.",
    downtimeCredit:
      "ಇಂದು ನಿಮ್ಮ ಇಂಟರ್ನೆಟ್ {duration} ಸ್ಥಗಿತಗೊಂಡಿತ್ತು ಎಂದು ನಮಗೆ ತಿಳಿದಿದೆ. ಕ್ಷಮಿಸಿ. ನಿಮ್ಮ ಮುಂದಿನ ಬಿಲ್‌ಗೆ {credit} ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಕ್ರೆಡಿಟ್ ಆಗಿದೆ. ಕರೆ ಮಾಡುವ ಅಗತ್ಯವಿಲ್ಲ.",
    downtimeCreditFailover:
      "ಇಂದು ನಿಮ್ಮ ಇಂಟರ್ನೆಟ್ {duration} ಸ್ಥಗಿತಗೊಂಡಿತ್ತು; ನಿಮ್ಮ 4G/5G ಬ್ಯಾಕಪ್ ನಿಮ್ಮನ್ನು ಆನ್‌ಲೈನ್‌ನಲ್ಲಿ ಇರಿಸಿತು. ನಿಧಾನ ಸೇವೆಗೆ ಕ್ಷಮಿಸಿ. ನಿಮ್ಮ ಮುಂದಿನ ಬಿಲ್‌ಗೆ {credit} ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಕ್ರೆಡಿಟ್ ಆಗಿದೆ.",
    downtimeBelowThreshold:
      "ಇಂದು ಸ್ವಲ್ಪ ಹೊತ್ತು ({duration}) ಸೇವೆ ಸ್ಥಗಿತಗೊಂಡಿತ್ತು, ಈಗ ಸರಿಯಾಗಿದೆ. {minimum} ನಿಮಿಷಕ್ಕಿಂತ ಕಡಿಮೆ ಸ್ಥಗಿತಕ್ಕೆ ಕ್ರೆಡಿಟ್ ಇಲ್ಲ, ಆದರೆ ನಿಮಗೆ ತಿಳಿಸಬೇಕೆಂದುಕೊಂಡೆವು.",
    demoLabel: "(ಡೆಮೊ ಆರ್ಡರ್: ಸಿಮ್ಯುಲೇಟೆಡ್ ಡೇಟಾ.)",
  },
};

// ================================================================ LOGIC

function fillTemplate(template, values) {
  return Object.keys(values).reduce((text, key) => text.split("{" + key + "}").join(values[key]), template);
}

function formatRupees(amount) {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return "₹" + digits;
  return "₹" + digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + digits.slice(-3);
}

const DAY_NAMES = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  hi: ["रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"],
  kn: ["ಭಾನು", "ಸೋಮ", "ಮಂಗಳ", "ಬುಧ", "ಗುರು", "ಶುಕ್ರ", "ಶನಿ"],
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri 6 Nov, 14:00" in IST, whatever the server's time zone. */
function formatIstDateTime(date, language) {
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE);
  const hours = String(ist.getUTCHours()).padStart(2, "0");
  const minutes = String(ist.getUTCMinutes()).padStart(2, "0");
  return (
    (DAY_NAMES[language] || DAY_NAMES.en)[ist.getUTCDay()] +
    " " +
    ist.getUTCDate() +
    " " +
    MONTH_NAMES[ist.getUTCMonth()] +
    ", " +
    hours +
    ":" +
    minutes
  );
}

/** Hours rounded to one decimal, for messages and outputs. */
function roundHours(hours) {
  return Math.round(hours * 10) / 10;
}

/**
 * Guarantee status of an order at `now`. confirmedAt = when the order was confirmed (quote accepted + KYC),
 * deadline = confirmedAt + promiseHours, the promise on the order's quote card (price_bundle's promise_hours: 72 in
 * the guarantee's scope, a firm number of days × 24 otherwise). Connected by the deadline → met; past the deadline
 * without a connection, or connected late → breached (month one credited); otherwise on track.
 * Example: confirmed 30 h ago, promiseHours 168, not connected yet → { status: "on_track", hoursToDeadline: 138 }.
 */
function evaluateGuarantee(order, now, promiseHours) {
  if (!(promiseHours > 0)) throw new Error("evaluateGuarantee needs the quote's promise_hours, got " + promiseHours);
  // A real order stores confirmedAt (ISO time). Demo orders store confirmedHoursAgo instead, so they always look
  // current; both end up as the same absolute confirmation time.
  const confirmedAt = order.confirmedAt
    ? new Date(order.confirmedAt)
    : new Date(now.getTime() - order.confirmedHoursAgo * MILLISECONDS_PER_HOUR);
  const deadline = new Date(confirmedAt.getTime() + promiseHours * MILLISECONDS_PER_HOUR);
  const elapsedHours = (now.getTime() - confirmedAt.getTime()) / MILLISECONDS_PER_HOUR;
  const connectEvent = order.events.find((event) => CONNECTED_STAGES.indexOf(event.stage) >= 0);
  const connectedHours =
    connectEvent && connectEvent.hoursAfterConfirm <= elapsedHours ? connectEvent.hoursAfterConfirm : null;
  let status = GUARANTEE_STATUS.ON_TRACK;
  if (connectedHours !== null)
    status = connectedHours <= promiseHours ? GUARANTEE_STATUS.MET : GUARANTEE_STATUS.BREACHED;
  else if (elapsedHours > promiseHours) status = GUARANTEE_STATUS.BREACHED;
  return {
    confirmedAt,
    deadline,
    promiseHours,
    status,
    hoursToDeadline: roundHours(promiseHours - elapsedHours),
    connectedAt:
      connectedHours === null ? null : new Date(confirmedAt.getTime() + connectedHours * MILLISECONDS_PER_HOUR),
    connectedAfterHours: connectedHours,
  };
}

/** Month-one credit for a breached guarantee: a share of the monthly bill (from price_bundle). 0 otherwise. */
function monthOneCredit(guarantee, monthlyTotal) {
  if (guarantee.status !== GUARANTEE_STATUS.BREACHED) return 0;
  return Math.round(PROMISE_RULES.guarantee.breachCreditShareOfMonthlyBill * monthlyTotal);
}

/**
 * The proactive messages for an order: one per stage already reached (sent), plus the next one (scheduled), plus the
 * breach apology at the deadline if the promise was missed. Returns { sent: [{stage, at, message}], next }.
 */
function proactiveMessages(order, orderId, guarantee, credit, now, language) {
  const text = PROMISE_MESSAGES[language] || PROMISE_MESSAGES.en;
  const values = (event) => ({
    orderId,
    deadline: formatIstDateTime(guarantee.deadline, language),
    when: formatIstDateTime(
      new Date(guarantee.confirmedAt.getTime() + event.hoursAfterConfirm * MILLISECONDS_PER_HOUR),
      language,
    ),
    hours: roundHours(event.hoursAfterConfirm),
  });
  // A connection after the deadline must never say "Promise kept": it gets the neutral "You're live" text (the
  // breach apology with the credit has already gone out at the deadline).
  const templateFor = (event) =>
    CONNECTED_STAGES.indexOf(event.stage) >= 0 && event.hoursAfterConfirm > guarantee.promiseHours
      ? text.stages.live
      : text.stages[event.stage];
  const timeline = order.events.map((event) => ({
    stage: event.stage,
    at: new Date(guarantee.confirmedAt.getTime() + event.hoursAfterConfirm * MILLISECONDS_PER_HOUR),
    message: fillTemplate(templateFor(event), values(event)),
  }));
  if (guarantee.status === GUARANTEE_STATUS.BREACHED) {
    timeline.push({
      stage: BREACH_NOTICE_STAGE,
      at: guarantee.deadline,
      message: fillTemplate(text.breached, {
        orderId,
        deadline: formatIstDateTime(guarantee.deadline, language),
        credit: formatRupees(credit),
      }),
    });
  }
  timeline.sort((first, second) => first.at - second.at);
  const sent = timeline.filter((entry) => entry.at <= now);
  const upcoming = timeline.filter((entry) => entry.at > now);
  return { sent, next: upcoming[0] || null };
}

/** Chases so far (stored history + this one if the owner asked unprompted) and whether retention should call. */
function trackChases(order, previousChases, isChase) {
  const chaseCount = Math.max(order.chasesBefore || 0, previousChases || 0) + (isChase ? 1 : 0);
  return { chaseCount, retentionFlag: chaseCount >= PROMISE_RULES.chases.retentionFlagAtChase };
}

/**
 * Downtime credit by the documented rule. items = price_bundle items (to see whether the bundle has failover).
 * Returns { creditInRupees, blocks, hasFailover, isBelowThreshold, ruleText }.
 */
function computeDowntimeCredit(outageMinutes, monthlyTotal, items) {
  const rule = PROMISE_RULES.downtime;
  const hasFailover = (items || []).some((item) => item.id === rule.failoverProductId);
  if (outageMinutes < rule.minimumMinutesForCredit) {
    return {
      creditInRupees: 0,
      blocks: 0,
      hasFailover,
      isBelowThreshold: true,
      ruleText: "under " + rule.minimumMinutesForCredit + " minutes: no credit",
    };
  }
  const blocks = Math.ceil(outageMinutes / (rule.blockHours * MINUTES_PER_HOUR));
  // Rounded to the rupee first, so the rule text the owner sees ("2 × one day's bill (₹240)") adds up exactly.
  const dailyBill = Math.round(monthlyTotal / rule.daysPerMonth);
  const uncapped = blocks * dailyBill * (hasFailover ? rule.failoverFactor : 1);
  const creditInRupees = Math.round(Math.min(uncapped, rule.maxShareOfMonthlyBill * monthlyTotal));
  return {
    creditInRupees,
    blocks,
    hasFailover,
    isBelowThreshold: false,
    ruleText:
      blocks +
      " × one day's bill (" +
      formatRupees(dailyBill) +
      ")" +
      (hasFailover ? " × " + rule.failoverFactor + " (failover kept you online)" : "") +
      (uncapped > rule.maxShareOfMonthlyBill * monthlyTotal
        ? ", capped at " + Math.round(rule.maxShareOfMonthlyBill * 100) + "% of the monthly bill"
        : ""),
  };
}

/**
 * "3h 20m", "200 minutes", "2.5 hours", "45 min", "1:30", "2 घंटे 15 मिनट", "45 ನಿಮಿಷ" → minutes; null if it can't be
 * read (including negative durations). Never guesses: unreadable input goes back to the playbook as an error.
 */
function parseDurationMinutes(durationInput) {
  const text = String(durationInput === undefined || durationInput === null ? "" : durationInput)
    .trim()
    .toLowerCase();
  if (!text || text.indexOf("-") >= 0) return null;
  const clock = text.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) return Number(clock[1]) * MINUTES_PER_HOUR + Number(clock[2]);
  // Unit words end at the next non-letter. Not \b: in JavaScript \b only knows ASCII letters, so it never matches
  // after Hindi or Kannada words ("15 मिनट" would be silently dropped).
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|घंटे|घंटा|ಗಂಟೆ)(?![a-z])/);
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*(minutes|minute|mins|min|m|मिनट|ನಿಮಿಷ)(?![a-z])/);
  if (hours || minutes)
    return Math.round((hours ? Number(hours[1]) * MINUTES_PER_HOUR : 0) + (minutes ? Number(minutes[1]) : 0));
  const bare = text.match(/^(\d+(?:\.\d+)?)$/);
  return bare ? Math.round(Number(bare[1])) : null;
}

/** "200" minutes → "3 h 20 min". */
function formatDuration(minutes) {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  return (hours ? hours + " h" : "") + (hours && rest ? " " : "") + (rest || !hours ? rest + " min" : "");
}

// ================================================================ DATA: SIMULATED demo orders

/**
 * SIMULATED demo orders, each built from a lead in smb_leads.csv (UD-0068 ↔ L00068, and so on). Times are relative to
 * "now" (hours), so the demo always looks current. pricingInputs are sent to price_bundle, which returns the monthly
 * bill AND the promise the order's quote card showed (promise_hours): no price or deadline is stored here.
 * One order per tracker state:
 *   UD-0782 72-hour guarantee (Delhi kirana, 3 people), connected on AirFiber in 40 h: kept
 *   UD-0068 firm date 7 days (Delhi lab, 16 people), on track
 *   UD-0002 firm date 10 days (Ludhiana bakery, tier 2), live in 50 h: kept
 *   UD-0001 firm date 10 days (Kochi clinic, tier 2), 250 h and not connected: breached, month one credited
 *   UD-1460 firm date 7 days (Bengaluru clinic, 19 people), live after 190 h: breached although live now
 */
const DEMO_ORDERS = {
  "UD-0068": {
    businessName: "Metro Diagnostics Pvt Ltd",
    bundleName: "Office Pro",
    pricingInputs: {
      business_type: "Diagnostic lab",
      city: "Delhi",
      employees: "16",
      sites: "1",
      has_gstin: "yes",
      needs: "failover, email, storage, security",
    },
    confirmedHoursAgo: 30,
    chasesBefore: 0,
    events: [
      { stage: "confirmed", hoursAfterConfirm: 0 },
      { stage: "kyc_verified", hoursAfterConfirm: 0.2 },
      { stage: "bridge_scheduled", hoursAfterConfirm: 1 },
      { stage: "installer_assigned", hoursAfterConfirm: 20 },
      { stage: "connected", hoursAfterConfirm: 46 },
      { stage: "fibre_installed", hoursAfterConfirm: 120 },
    ],
  },
  "UD-0002": {
    businessName: "Saffron Bakers",
    bundleName: "Dukaan Digital",
    pricingInputs: {
      business_type: "Bakery",
      city: "Ludhiana",
      employees: "3",
      sites: "1",
      has_gstin: "yes",
      needs: "pos",
    },
    confirmedHoursAgo: 288,
    chasesBefore: 0,
    events: [
      { stage: "confirmed", hoursAfterConfirm: 0 },
      { stage: "kyc_verified", hoursAfterConfirm: 0.5 },
      { stage: "installer_assigned", hoursAfterConfirm: 24 },
      { stage: "live", hoursAfterConfirm: 50 },
      { stage: "first_bill", hoursAfterConfirm: 360 },
    ],
  },
  "UD-0001": {
    businessName: "Balaji Dental Care LLP",
    bundleName: "Office Pro",
    pricingInputs: {
      business_type: "Dental clinic",
      city: "Kochi",
      employees: "20",
      sites: "1",
      has_gstin: "yes",
      needs: "failover, email, storage, security",
    },
    confirmedHoursAgo: 250,
    chasesBefore: 1,
    events: [
      { stage: "confirmed", hoursAfterConfirm: 0 },
      { stage: "kyc_verified", hoursAfterConfirm: 24 },
      { stage: "installer_assigned", hoursAfterConfirm: 260 },
      { stage: "connected", hoursAfterConfirm: 262 },
    ],
  },
  "UD-1460": {
    businessName: "Moonlight Dental Care Pvt Ltd",
    bundleName: "Office Pro",
    pricingInputs: {
      business_type: "Dental clinic",
      city: "Bengaluru",
      employees: "19",
      sites: "1",
      has_gstin: "yes",
      needs: "failover, email, storage, security",
    },
    confirmedHoursAgo: 240,
    chasesBefore: 0,
    events: [
      { stage: "confirmed", hoursAfterConfirm: 0 },
      { stage: "kyc_verified", hoursAfterConfirm: 0.3 },
      { stage: "installer_assigned", hoursAfterConfirm: 186 },
      { stage: "live", hoursAfterConfirm: 190 },
    ],
  },
  "UD-0782": {
    businessName: "Green Leaf General Store",
    bundleName: "Dukaan Digital",
    pricingInputs: {
      business_type: "Kirana store",
      city: "Delhi",
      employees: "3",
      sites: "1",
      has_gstin: "yes",
      needs: "cctv",
    },
    confirmedHoursAgo: 60,
    chasesBefore: 0,
    events: [
      { stage: "confirmed", hoursAfterConfirm: 0 },
      { stage: "kyc_verified", hoursAfterConfirm: 0.2 },
      { stage: "bridge_scheduled", hoursAfterConfirm: 1 },
      { stage: "installer_assigned", hoursAfterConfirm: 18 },
      { stage: "connected", hoursAfterConfirm: 40 },
      { stage: "fibre_installed", hoursAfterConfirm: 118 },
    ],
  },
};

/** "ud0068", "UD 0068", "UD-0068" → "UD-0068". */
function normaliseOrderId(orderIdInput) {
  return String(orderIdInput || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/^UD/, "UD-")
    .replace(/^SA/, "SA-");
}

const PROMISE_RULES_API = {
  PROMISE_RULES,
  PROMISE_MESSAGES,
  GUARANTEE_STATUS,
  BREACH_NOTICE_STAGE,
  DEMO_ORDERS,
  normaliseOrderId,
  evaluateGuarantee,
  monthOneCredit,
  proactiveMessages,
  trackChases,
  computeDowntimeCredit,
  parseDurationMinutes,
  formatDuration,
  formatRupees,
  formatIstDateTime,
  fillTemplate,
};

  return PROMISE_RULES_API;
})();
/** The real pricing function (price_bundle main), embedded unchanged: the month-one credit is its monthly bill. */
const priceBundleMain = (function embeddedPriceBundle() {
/*
 * price_bundle.js: Voiceflow function tool "price_bundle" (TEMPLATE; the build injects the catalogue).
 *
 * What it does: turns what Saathi learned about a business (type, size, city, needs, GST status) into ONE
 * recommended bundle with exact quantities, monthly price, setup fee, plan length and install time.
 *
 * How it fits: the "Bundle advisor" playbook calls it for every recommendation and every change (cheaper,
 * add, remove). It is the ONLY source of prices in the chatbot ("rules decide, GenAI explains"), so the AI can
 * never invent a number. _build/gen_kit.py injects the 25-product catalogue from the case pack
 * (product_catalogue.csv, synthetic data) and writes the finished file to 3_function_tools/.
 *
 * Pricing rules (from the deck and the case data):
 *  - Price = catalogue floor price (price_min) for the committed term.
 *  - Plan length = the longest minimum term among the items (or longer if the owner asks).
 *  - Install time = the slowest item's typical install days.
 *  - Activation promise (STRATEGY.md §11), decided here at quote time and shown on the card: "Connected in 72 hours,
 *    guaranteed" only for orders inside GUARANTEE_SCOPE; every other order gets a firm number of days from the case
 *    data (ACTIVATION_PROMISE_DATA, injected by the build). Missing either one makes month one free. order_status
 *    reads the promise from this quote, so the tracker always enforces what the card showed.
 */

/**
 * Voiceflow entry point: builds the quote and shows it as a chat card.
 *
 * @param {{inputVars?: Object<string, string>}} args  Voiceflow passes every input as text. All are optional;
 *   the useful ones are business_type, city, employees, sites, has_gstin and needs. See 3_function_tools/TOOL_SETUP.md.
 * @returns {{outputVars: Object, trace: Array}}  Always returns every declared output; `error` is filled on failure.
 * @example
 *   await main({ inputVars: { business_type: "Diagnostic lab", city: "Delhi", employees: "16", has_gstin: "yes",
 *     needs: "failover, email, storage, security", lang: "hi" } })
 *   // → outputVars.bundle_name "Office Pro", outputVars.monthly_total 6138, promise_type "firm_date" (16 people is
 *   //   above the 72-hour scope), promise_days 7
 */
async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const outputVars = {
    bundle_name: "",
    monthly_total: 0,
    setup_total: 0,
    contract_months: 0,
    install_days: 0,
    quote_text: "",
    why_text: "",
    blocked_text: "",
    budget_note: "",
    items_json: "[]",
    segment_code: "",
    promise_type: "",
    promise_hours: 0,
    promise_days: 0,
    promise_text: "",
    promise_reasons: "",
    error: "",
  };
  try {
    const quote = buildQuote(inputVars);
    outputVars.promise_type = quote.promise.type;
    outputVars.promise_hours = quote.promise.hours;
    outputVars.promise_days = quote.promise.days;
    outputVars.promise_text = quote.promise.text;
    outputVars.promise_reasons = quote.promise.reasonsText;
    outputVars.bundle_name = quote.bundleName;
    outputVars.monthly_total = quote.monthlyTotalInRupees;
    outputVars.setup_total = quote.setupTotalInRupees;
    outputVars.contract_months = quote.contractMonths;
    outputVars.install_days = quote.installDays;
    outputVars.quote_text = quote.quoteText;
    outputVars.why_text = quote.whyText;
    outputVars.blocked_text = quote.blockedText;
    outputVars.budget_note = quote.budgetNote;
    outputVars.items_json = JSON.stringify(
      quote.items.map((item) => ({
        id: item.productId,
        name: item.product.name,
        qty: item.quantity,
        monthly: item.quantity * item.product.monthlyPriceFloorInRupees,
      })),
    );
    outputVars.segment_code = quote.segment;
    const shouldShowCard = String(inputVars.show_card || "yes").toLowerCase() !== "no";
    return {
      outputVars,
      trace: shouldShowCard ? [{ type: "text", payload: { message: quote.quoteText } }] : [],
    };
  } catch (error) {
    outputVars.error = MESSAGES.errorPrefix + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG

/** Catalogue product IDs (product_catalogue.csv). Named so the rules below read as words, not codes. */
const PRODUCT = {
  BIZ_FIBRE_100: "P01",
  BIZ_FIBRE_300: "P02",
  BIZ_FIBRE_1G: "P03",
  AIRFIBER_5G: "P04",
  LEASED_LINE_20: "P05",
  LEASED_LINE_100: "P06",
  POSTPAID_299: "P07",
  POSTPAID_599: "P08",
  FAILOVER_4G_5G: "P09",
  MANAGED_SD_WAN: "P10",
  STATIC_IP: "P11",
  CLOUD_TELEPHONY: "P12",
  TOLL_FREE_NUMBER: "P13",
  BUSINESS_SMS: "P14",
  WHATSAPP_API: "P15",
  CLOUD_EMAIL: "P16",
  CLOUD_BACKUP_1TB: "P17",
  WEBSITE_DOMAIN: "P18",
  CLOUD_POS: "P19",
  ENDPOINT_SECURITY: "P20",
  MANAGED_FIREWALL: "P21",
  SECURE_WIFI: "P22",
  CLOUD_CCTV: "P23",
  MACHINE_IOT: "P24",
  FLEET_TRACKER: "P25",
};

/** Segment codes used across the kit (match the case's four segments, Appendix A2). */
const SEGMENT = { MICRO: "micro", PROFESSIONAL: "prof", MULTI_SITE: "multi", MANUFACTURER: "mfg" };

/** Bundle names shown to owners; defined in the submission deck (slide "Who we win first"). */
const BUNDLE_NAME_BY_SEGMENT = {
  micro: "Dukaan Digital",
  prof: "Office Pro",
  multi: "Chain Connect",
  mfg: "Factory Assured",
};

/** Tier-1 cities in smb_leads.csv (city_tier = 1) plus their common alternative spellings. */
const TIER_1_CITY_NAMES = [
  "delhi",
  "new delhi",
  "mumbai",
  "bombay",
  "bengaluru",
  "bangalore",
  "chennai",
  "madras",
  "hyderabad",
  "kolkata",
  "calcutta",
  "pune",
  "ahmedabad",
];

/**
 * Scope of "Connected in 72 hours, guaranteed" (STRATEGY.md §11). Decided at quote time from what is known then; an
 * order qualifies only when EVERY condition holds. Evidence: the 368 activated leads in smb_leads.csv, days from KYC
 * complete (order confirmed) to activation:
 *  - cityTiers: tier-1 cities went live within 3 days 57% of the time, tier-2 cities 31%.
 *  - maxEmployees, maxSites: in tier 1, businesses with ≤ 10 people on 1 site went live within 3 days 73% of the time
 *    (99 orders); bigger tier-1 businesses 44%. This is the best group known at quote time; none reaches 90%.
 *  - connectionProductIds: fibre up to 300 Mbps and 5G AirFiber install at street level (catalogue: 2–5 days, and
 *    AirFiber can bridge fibre). 1 Gbps fibre and leased lines need a site survey (catalogue: 7–30 days).
 *  - requiresAirFiberCoverage: AirFiber is the bridge when the fibre install slips, and the fallback when the site
 *    turns out not to be feasible for fibre (41 confirmed orders in the case data dropped for that reason).
 * Expected cost (6_tests/measure_promise_scope.mjs): 23.5% of confirmed orders qualify. The guarantee is missed on
 * 27% of qualifying activated orders, but their bills are the smallest (median ₹2,620/month). Credits per 1,000
 * orders fall from ₹93 lakh (72 hours for everyone) to ₹52 lakh.
 */
const GUARANTEE_SCOPE = {
  hours: 72,
  cityTiers: [1],
  maxEmployees: 10,
  maxSites: 1,
  connectionProductIds: [PRODUCT.BIZ_FIBRE_100, PRODUCT.BIZ_FIBRE_300, PRODUCT.AIRFIBER_5G],
  requiresAirFiberCoverage: true,
};

/** promise_type values. firm_date = a number of days from the case data, with the same month-one-free promise. */
const PROMISE_TYPE = { GUARANTEED_72H: "guaranteed_72h", FIRM_DATE: "firm_date" };
/** Why an order is outside the 72-hour scope (codes in promise_reasons, read by the agent and the tests). */
const PROMISE_SCOPE_REASON = {
  CITY_TIER: "city_tier",
  TEAM_SIZE: "team_size",
  SITES: "sites",
  CONNECTION: "connection",
  AIRFIBER_COVERAGE: "airfiber_coverage",
};
const HOURS_PER_DAY = 24;

/**
 * SIMULATED: cities with 5G AirFiber coverage. The case pack has no coverage data and the leads have no pincode (the
 * registry's pincodes are random), so this lists every city in the case data: the catalogue sells AirFiber in both
 * tiers. Production replaces it with a pincode-level coverage lookup; the airfiber_available input ("no") already
 * lets a feasibility check overrule it.
 */
const AIRFIBER_COVERAGE_CITY_NAMES = TIER_1_CITY_NAMES.concat([
  "kochi",
  "cochin",
  "ludhiana",
  "nagpur",
  "jaipur",
  "visakhapatnam",
  "vizag",
  "lucknow",
  "bhopal",
  "indore",
  "surat",
  "vadodara",
  "baroda",
  "nashik",
  "patna",
  "coimbatore",
  "mysuru",
  "mysore",
]);

/** Thresholds that decide segment and connectivity. Design choices, tuned against the bundles in smb_leads.csv. */
const THRESHOLDS = {
  /** 3+ sites makes a business "multi-site" (case Appendix A2: "3–10 store retailer"). */
  sitesForMultiSite: 3,
  /** With no recognisable business type, this many employees or more → treated as a professional office. */
  employeesForProfessionalWhenTypeUnknown: 6,
  /** Team size assumed only for the segment guess when the employee count is missing. */
  employeesAssumedForSegmentGuess: 3,
  /** Offices this size or smaller get Biz Fibre 100 instead of 300. */
  maxEmployeesForBizFibre100InOffices: 5,
  /** Multi-site: more than this many employees per site → Biz Fibre 300 per site. */
  employeesPerSiteNeedingBizFibre300: 15,
  /** Offices this size or bigger get 4G/5G failover even if they didn't ask (downtime hurts a whole team). */
  officeTeamSizeForDefaultFailover: 8,
  /** Factories this size or bigger can get the 100 Mbps leased line when they ask for speed. */
  employeesForLeasedLine100: 25,
  /** City tier assumed when no city is given (tier 2 is the conservative choice: fewer products). */
  defaultCityTier: 2,
};

/**
 * Quantity sizing. Ratios fitted to the median quantities bought by activated leads in smb_leads.csv,
 * e.g. professional offices: ~3 business lines and ~7 email users for ~14 employees.
 */
const SIZING = {
  defaultEmployeesBySegment: { micro: 2, prof: 8, multi: 40, mfg: 40 },
  microMaxEmployeesForOneLine: 2,
  microLinesForTinyShop: 1,
  microLinesOtherwise: 2,
  employeesPerLine: { prof: 5, multi: 18, mfg: 20 },
  minLines: { prof: 2, multi: 2, mfg: 2 },
  maxLines: { prof: 8, multi: 10, mfg: 10 },
  emailShareOfStaff: { prof: 0.6, mfg: 0.13, multi: 0.15 },
  minimumEmailUsers: 3,
  minimumEmailUsersMicro: 1,
  securedDeviceShareOfStaff: { prof: 0.4, mfg: 0.1 },
  minimumSecuredDevices: { prof: 2, mfg: 3 },
  maxSecuredDevicesOtherSegments: 3,
  multiSiteCamerasPerSite: 1.5,
  defaultCameras: { mfg: 5, other: 2 },
  defaultCountersPerSite: 1,
  defaultMachines: 10,
  defaultVehicles: 4,
  employeesPerTelephonyChannel: 6,
  minTelephonyChannels: 2,
  maxTelephonyChannels: 3,
};

/** Order in which optional items are removed to fit a budget: nice-to-haves first; connection and lines never. */
const BUDGET_TRIM_ORDER = [
  PRODUCT.CLOUD_BACKUP_1TB,
  PRODUCT.ENDPOINT_SECURITY,
  PRODUCT.WEBSITE_DOMAIN,
  PRODUCT.SECURE_WIFI,
  PRODUCT.CLOUD_CCTV,
  PRODUCT.TOLL_FREE_NUMBER,
  PRODUCT.WHATSAPP_API,
  PRODUCT.BUSINESS_SMS,
  PRODUCT.FAILOVER_4G_5G,
  PRODUCT.CLOUD_TELEPHONY,
  PRODUCT.STATIC_IP,
  PRODUCT.CLOUD_EMAIL,
  PRODUCT.CLOUD_POS,
  PRODUCT.MACHINE_IOT,
  PRODUCT.FLEET_TRACKER,
  PRODUCT.MANAGED_SD_WAN,
  PRODUCT.MANAGED_FIREWALL,
];

/** Words recognised in the owner's answers. Short words (≤ 4 letters) only match as whole words. */
const YES_WORDS = ["yes", "y", "true", "1", "haan", "ha", "हाँ", "हां", "han", "active"];
const NO_WORDS = ["no", "n", "false", "0", "nahi", "nahin", "नहीं", "na"];
const SHORT_KEYWORD_MAX_LENGTH = 4;

const SEGMENT_KEYWORDS = {
  segmentInputMicro: ["micro", "retail & services", "kirana", "shop"],
  segmentInputProfessional: ["prof", "office"],
  segmentInputMultiSite: ["multi", "chain"],
  segmentInputManufacturer: ["mfg", "manufactur", "factory"],
  multiSite: ["chain", "branches", "outlets", "group", "franchise"],
  manufacturer: [
    "factory",
    "manufactur",
    "unit",
    "plant",
    "workshop",
    "textile",
    "auto-part",
    "auto part",
    "fabricat",
    "packaging",
    "moulding",
    "molding",
    "printing press",
    "food processing",
    "furniture",
  ],
  professional: [
    "clinic",
    "dental",
    "dentist",
    "doctor",
    "diagnostic",
    "lab",
    "physio",
    "ca firm",
    "chartered",
    "accountant",
    "law",
    "legal",
    "advocate",
    "lawyer",
    "coaching",
    "tuition",
    "institute",
    "insurance",
    "travel",
    "architect",
    "studio",
    "real estate",
    "consult",
    "agency",
    "office",
  ],
  micro: [
    "kirana",
    "grocery",
    "general store",
    "salon",
    "parlour",
    "parlor",
    "pharmacy",
    "chemist",
    "medical store",
    "bakery",
    "boutique",
    "hardware",
    "mobile",
    "optician",
    "stationery",
    "sweet",
    "shop",
    "store",
    "cafe",
    "tea",
    "dhaba",
  ],
  /** Multi-site businesses that sell at a counter get Cloud POS by default. */
  retailOrFood: [
    "retail",
    "restaurant",
    "bakery",
    "pharmacy",
    "apparel",
    "electronics",
    "store",
    "outlet",
    "shop",
    "cafe",
    "sweet",
  ],
};

/** Need keywords the agent passes in `needs` (see TOOL_SETUP.md), with the everyday words owners use. */
const NEED_KEYWORDS = {
  failover: [
    "failover",
    "uptime",
    "never stop",
    "never down",
    "always on",
    "outage",
    "downtime",
    "redundan",
    "backup internet",
    "backup line",
    "backup connection",
    "net backup",
  ],
  email: ["email", "e-mail", "mail", "office suite", "workspace", "microsoft", "outlook"],
  storage: ["storage", "cloud backup", "data backup", "records", "files", "backup"],
  security: ["security", "antivirus", "virus", "cyber", "endpoint", "malware"],
  firewall: ["firewall"],
  pos: ["pos", "billing", "invoice", "counter", "point of sale"],
  cctv: ["cctv", "camera", "surveillance"],
  wifi: ["wifi", "wi-fi", "guest"],
  whatsapp: ["whatsapp", "catalogue", "catalog", "broadcast"],
  sms: ["sms", "reminder", "text message"],
  website: ["website", "domain", "online presence", "web site"],
  telephony: ["telephony", "calls", "ivr", "call centre", "call center", "landline", "extension", "sip"],
  tollfree: ["toll-free", "toll free", "tollfree", "1800"],
  staticip: ["static ip", "staticip", "remote access", "server", "cctv remote"],
  iot: ["iot", "machine", "sensor", "monitoring"],
  fleet: ["fleet", "vehicle", "gps", "truck", "delivery bike", "tracking van"],
  sdwan: ["sd-wan", "sdwan", "central management", "one network", "centrally"],
  leased: ["leased", "dedicated", "ill"],
  highspeed: ["1 gbps", "1gbps", "gigabit", "heavy files", "large files", "high speed", "fastest"],
};

/** "backup" + one of these words means a backup INTERNET line (failover), not data backup. */
const BACKUP_INTERNET_WORDS = ["internet", "line", "connection", "net", "4g", "5g"];
/** Words that mean "mobile lines" when the owner asks to add some. */
const MOBILE_LINE_WORDS = ["sim", "line", "mobile", "postpaid"];

/** Which product a need keyword adds (used when the owner says "add cctv"). */
const PRODUCT_BY_NEED = {
  failover: PRODUCT.FAILOVER_4G_5G,
  email: PRODUCT.CLOUD_EMAIL,
  storage: PRODUCT.CLOUD_BACKUP_1TB,
  security: PRODUCT.ENDPOINT_SECURITY,
  firewall: PRODUCT.MANAGED_FIREWALL,
  pos: PRODUCT.CLOUD_POS,
  cctv: PRODUCT.CLOUD_CCTV,
  wifi: PRODUCT.SECURE_WIFI,
  whatsapp: PRODUCT.WHATSAPP_API,
  sms: PRODUCT.BUSINESS_SMS,
  website: PRODUCT.WEBSITE_DOMAIN,
  telephony: PRODUCT.CLOUD_TELEPHONY,
  tollfree: PRODUCT.TOLL_FREE_NUMBER,
  staticip: PRODUCT.STATIC_IP,
  iot: PRODUCT.MACHINE_IOT,
  fleet: PRODUCT.FLEET_TRACKER,
  sdwan: PRODUCT.MANAGED_SD_WAN,
};

/** How many reasons appear in the "Why:" line. */
const MAX_REASONS_SHOWN = 3;

// ================================================================ MESSAGES (all user-facing text)

const MESSAGES = {
  errorPrefix: "price_bundle failed: ",
  en: {
    perMonth: "/month",
    oneTimeSetup: "One-time setup",
    noSetupFee: "No setup fee",
    monthPlanSuffix: "-month plan",
    liveInDays: "live in about {days} days",
    gstExtra: "GST extra",
    notAdded: "Not added",
    whyPrefix: "Why: ",
    budgetFitted: "To fit {budget} we removed/changed: ",
    budgetLowestPossible: "Lowest possible: {total}/month (essentials only)",
    promiseGuaranteed72h: "✅ Connected in 72 hours, guaranteed, or month one is free",
    promiseFirmDate: "✅ Connected within {days} days of your order, guaranteed, or month one is free",
  },
  hi: {
    perMonth: "/माह",
    oneTimeSetup: "एक बार का सेटअप",
    noSetupFee: "कोई सेटअप शुल्क नहीं",
    monthPlanSuffix: " महीने का प्लान",
    liveInDays: "लगभग {days} दिनों में चालू",
    gstExtra: "GST अलग",
    notAdded: "शामिल नहीं",
    whyPrefix: "क्यों: ",
    budgetFitted: "बजट {budget} में फिट करने के लिए हटाया/बदला: ",
    budgetLowestPossible: "सबसे कम संभव: {total}/माह (सिर्फ़ ज़रूरी चीज़ें)",
    promiseGuaranteed72h: "✅ 72 घंटे में कनेक्शन की गारंटी, वरना पहला महीना मुफ़्त",
    promiseFirmDate: "✅ ऑर्डर के {days} दिनों के अंदर कनेक्शन की गारंटी, वरना पहला महीना मुफ़्त",
  },
  /**
   * Why an order is outside the 72-hour scope, in English inside promise_reasons (like blocked_text): the agent
   * explains it in the owner's language only if asked, and never promises 72 hours instead.
   */
  promiseScopeReasons: {
    city_tier: "the 72-hour guarantee covers tier-1 cities only",
    team_size: "the 72-hour guarantee covers businesses of up to {count} people",
    sites: "the 72-hour guarantee covers single-site businesses",
    connection: "{name} needs a site survey before installation",
    airfiber_coverage: "5G AirFiber, the 72-hour bridge, doesn't cover the address",
  },
  /** Eligibility problems are shown in English inside blocked_text; the agent explains them in the owner's language. */
  eligibility: {
    cityTier: "not sold in tier-{tier} cities yet",
    minimumEmployees: "needs at least {count} employees",
    minimumSites: "needs at least {count} sites",
    gstin: "needs an active GSTIN",
    connection: "needs a broadband or leased line in the same bundle",
  },
  switchedToAirFiber: " → 5G AirFiber",
  /** One reason per product: [English, Hindi]. {quantity} is replaced by the item quantity. */
  reasonByProductId: {
    P01: ["100 Mbps business fibre", "100 Mbps बिज़नेस फाइबर"],
    P02: ["300 Mbps fibre for the whole team", "पूरी टीम के लिए 300 Mbps फाइबर"],
    P03: ["1 Gbps fibre for heavy files", "भारी फ़ाइलों के लिए 1 Gbps फाइबर"],
    P04: ["plug-and-play 5G, live in about 2 days", "प्लग-एंड-प्ले 5G, लगभग 2 दिन में चालू"],
    P05: ["a dedicated line with 99.5% uptime", "99.5% अपटाइम वाली डेडिकेटेड लाइन"],
    P06: ["a dedicated 100 Mbps line with 99.9% uptime", "99.9% अपटाइम वाली 100 Mbps डेडिकेटेड लाइन"],
    P07: ["{quantity} business SIM(s) on the same bill", "उसी बिल पर {quantity} बिज़नेस सिम"],
    P08: ["{quantity} business lines with priority care", "प्रायोरिटी केयर के साथ {quantity} बिज़नेस लाइन"],
    P09: ["auto-switch to 4G/5G if the fibre drops", "फाइबर रुके तो अपने-आप 4G/5G पर"],
    P10: ["one managed network across all branches", "सभी ब्रांच के लिए एक मैनेज्ड नेटवर्क"],
    P11: ["a static IP for remote access", "रिमोट एक्सेस के लिए स्टैटिक IP"],
    P12: ["cloud calling with {quantity} lines", "{quantity} लाइन के साथ क्लाउड कॉलिंग"],
    P13: ["one toll-free number for customers", "ग्राहकों के लिए एक टोल-फ्री नंबर"],
    P14: ["SMS reminders to customers", "ग्राहकों को SMS रिमाइंडर"],
    P15: ["WhatsApp catalogue and broadcasts", "WhatsApp पर कैटलॉग और मैसेज"],
    P16: ["business email for {quantity} staff", "{quantity} लोगों के लिए बिज़नेस ईमेल"],
    P17: ["1 TB cloud backup for records", "रिकॉर्ड के लिए 1 TB क्लाउड बैकअप"],
    P18: ["a website with your own domain", "अपने डोमेन के साथ वेबसाइट"],
    P19: ["billing at {quantity} counter(s)", "{quantity} काउंटर पर बिलिंग"],
    P20: ["virus protection on {quantity} devices", "{quantity} डिवाइस पर वायरस सुरक्षा"],
    P21: ["a managed firewall", "मैनेज्ड फ़ायरवॉल"],
    P22: ["secure Wi-Fi with a guest network", "गेस्ट नेटवर्क के साथ सुरक्षित Wi-Fi"],
    P23: ["{quantity} cloud cameras you can watch on your phone", "फोन पर दिखने वाले {quantity} क्लाउड कैमरे"],
    P24: ["{quantity} machine-monitoring sensors", "{quantity} मशीन-मॉनिटरिंग सेंसर"],
    P25: ["{quantity} vehicle trackers", "{quantity} वाहन ट्रैकर"],
  },
};

// ================================================================ LOGIC: small helpers

/** Reads a positive number from free text ("16 people" → 16); returns `fallback` when there isn't one. */
function parsePositiveNumber(value, fallback) {
  const text = String(value === undefined || value === null ? "" : value);
  const number = parseFloat(text.replace(/[^0-9.]/g, ""));
  return isFinite(number) && number > 0 ? number : fallback;
}

/** True when the owner's answer means yes (English, Hinglish or Hindi). */
function isYes(value) {
  const answer = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  return YES_WORDS.indexOf(answer) >= 0;
}

/** True when the owner's answer means no (English, Hinglish or Hindi). */
function isNo(value) {
  const answer = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  return NO_WORDS.indexOf(answer) >= 0;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** True when `text` contains any keyword. Short keywords must stand alone, so "lab" doesn't match "label". */
function containsAnyKeyword(text, keywords) {
  const paddedText = " " + String(text || "").toLowerCase() + " ";
  return keywords.some((keyword) =>
    keyword.length <= SHORT_KEYWORD_MAX_LENGTH
      ? new RegExp("[^a-z]" + keyword + "[^a-z]").test(paddedText)
      : paddedText.indexOf(keyword) >= 0,
  );
}

/** Formats rupees with Indian digit grouping: 123456 → "₹1,23,456". */
function formatRupees(amount) {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return "₹" + digits;
  const lastThree = digits.slice(-3);
  const leading = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return "₹" + leading + "," + lastThree;
}

function fillTemplate(template, values) {
  return Object.keys(values).reduce((text, key) => text.split("{" + key + "}").join(values[key]), template);
}

// ================================================================ LOGIC: understanding the business

/**
 * Decides which of the four case segments the business belongs to.
 * Order matters: an explicit segment wins, then 3+ sites, then keywords, then team size.
 */
function detectSegment(inputVars, siteCount) {
  const segmentInput = String(inputVars.segment || "").toLowerCase();
  if (segmentInput) {
    if (containsAnyKeyword(segmentInput, SEGMENT_KEYWORDS.segmentInputMicro)) return SEGMENT.MICRO;
    if (containsAnyKeyword(segmentInput, SEGMENT_KEYWORDS.segmentInputProfessional)) return SEGMENT.PROFESSIONAL;
    if (containsAnyKeyword(segmentInput, SEGMENT_KEYWORDS.segmentInputMultiSite)) return SEGMENT.MULTI_SITE;
    if (containsAnyKeyword(segmentInput, SEGMENT_KEYWORDS.segmentInputManufacturer)) return SEGMENT.MANUFACTURER;
  }
  const businessType = String(inputVars.business_type || "").toLowerCase();
  if (siteCount >= THRESHOLDS.sitesForMultiSite) return SEGMENT.MULTI_SITE;
  if (containsAnyKeyword(businessType, SEGMENT_KEYWORDS.multiSite)) return SEGMENT.MULTI_SITE;
  if (containsAnyKeyword(businessType, SEGMENT_KEYWORDS.manufacturer)) return SEGMENT.MANUFACTURER;
  if (containsAnyKeyword(businessType, SEGMENT_KEYWORDS.professional)) return SEGMENT.PROFESSIONAL;
  if (containsAnyKeyword(businessType, SEGMENT_KEYWORDS.micro)) return SEGMENT.MICRO;
  const employeesForGuess = parsePositiveNumber(inputVars.employees, THRESHOLDS.employeesAssumedForSegmentGuess);
  return employeesForGuess >= THRESHOLDS.employeesForProfessionalWhenTypeUnknown ? SEGMENT.PROFESSIONAL : SEGMENT.MICRO;
}

/** Turns "Internet that never stops, billing" into flags like { failover: true, pos: true }. */
function parseNeeds(needsText) {
  const phrases = String(needsText || "")
    .toLowerCase()
    .split(/[,;\n|/]+/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
  const needs = {};
  phrases.forEach((phrase) => {
    if (containsAnyKeyword(phrase, ["backup"]) && containsAnyKeyword(phrase, BACKUP_INTERNET_WORDS)) {
      needs.failover = true;
      return;
    }
    Object.keys(NEED_KEYWORDS).forEach((needName) => {
      // "backup internet" is failover, not storage; "cctv" alone is not a static-IP request.
      if (needName === "storage" && containsAnyKeyword(phrase, NEED_KEYWORDS.failover)) return;
      if (needName === "staticip" && phrase.indexOf("cctv") >= 0 && phrase.indexOf("remote") < 0) return;
      if (containsAnyKeyword(phrase, NEED_KEYWORDS[needName])) needs[needName] = true;
    });
  });
  return needs;
}

/** Lists why a product can't be sold to this business (empty list = eligible). Rules from product_catalogue.csv. */
function getEligibilityProblems(product, business, includedProductIds) {
  const problems = [];
  if (product.availableCityTiers.indexOf(business.cityTier) < 0) {
    problems.push(fillTemplate(MESSAGES.eligibility.cityTier, { tier: business.cityTier }));
  }
  if (business.employeeCount < product.minimumEmployees) {
    problems.push(fillTemplate(MESSAGES.eligibility.minimumEmployees, { count: product.minimumEmployees }));
  }
  if (business.siteCount < product.minimumSites) {
    problems.push(fillTemplate(MESSAGES.eligibility.minimumSites, { count: product.minimumSites }));
  }
  if (product.requiresGstin && !business.hasGstin) problems.push(MESSAGES.eligibility.gstin);
  if (
    product.requiresOneOfProductIds.length &&
    !product.requiresOneOfProductIds.some((productId) => includedProductIds[productId])
  ) {
    problems.push(MESSAGES.eligibility.connection);
  }
  return problems;
}

/** Finds a catalogue product from an ID ("P20"), a name ("static ip") or a need word ("cctv"). Null if unknown. */
function findProductByText(text) {
  const searchText = String(text || "")
    .trim()
    .toLowerCase();
  if (!searchText) return null;
  const idMatch = searchText.toUpperCase().match(/^P\d{2}$/);
  if (idMatch && PRODUCTS_BY_ID[idMatch[0]]) return PRODUCTS_BY_ID[idMatch[0]];
  let shortestNameMatch = null;
  PRODUCT_CATALOGUE.forEach((product) => {
    const productName = product.name.toLowerCase();
    const isMatch =
      productName === searchText || productName.indexOf(searchText) >= 0 || searchText.indexOf(productName) >= 0;
    if (isMatch && (!shortestNameMatch || product.name.length < shortestNameMatch.name.length)) {
      shortestNameMatch = product;
    }
  });
  if (shortestNameMatch) return shortestNameMatch;
  const needs = parseNeeds(searchText);
  for (const needName in PRODUCT_BY_NEED) {
    if (needs[needName]) return PRODUCTS_BY_ID[PRODUCT_BY_NEED[needName]];
  }
  if (containsAnyKeyword(searchText, MOBILE_LINE_WORDS)) return PRODUCTS_BY_ID[PRODUCT.POSTPAID_299];
  return null;
}

// ================================================================ LOGIC: building the quote
// TODO(CODE_REVIEW.md): buildQuote still does several jobs (sizing, candidates, edits, eligibility, budget,
// formatting). Splitting it is planned; this cleanup only renamed things and moved numbers into CONFIG.

/** Builds the full quote for one business. Returns plain data; main() maps it to Voiceflow outputs. */
function buildQuote(inputVars) {
  const language = /^(hi|hindi|हिंदी|hinglish)/i.test(String(inputVars.lang || "")) ? "hi" : "en";
  const siteCount = Math.round(parsePositiveNumber(inputVars.sites, 1));
  const segment = detectSegment(inputVars, siteCount);
  const employeeCount = Math.round(parsePositiveNumber(inputVars.employees, SIZING.defaultEmployeesBySegment[segment]));
  const cityName = String(inputVars.city || "")
    .trim()
    .toLowerCase();
  const cityTier = cityName
    ? TIER_1_CITY_NAMES.indexOf(cityName) >= 0
      ? 1
      : 2
    : parsePositiveNumber(inputVars.city_tier, THRESHOLDS.defaultCityTier);
  const hasGstin = isYes(inputVars.has_gstin);
  const fibreUnavailable = isNo(inputVars.fibre_available);
  const needs = parseNeeds(inputVars.needs);
  const business = { segment, employeeCount, siteCount, cityTier, hasGstin };
  const businessType = String(inputVars.business_type || "").toLowerCase();

  const mobileLineCount = Math.round(
    parsePositiveNumber(inputVars.lines, defaultMobileLineCount(segment, employeeCount)),
  );
  const emailUserCount = Math.round(
    parsePositiveNumber(inputVars.email_users, defaultEmailUserCount(segment, employeeCount)),
  );
  const securedDeviceCount = defaultSecuredDeviceCount(segment, employeeCount);
  const cameraCount = Math.round(
    parsePositiveNumber(
      inputVars.cameras,
      segment === SEGMENT.MULTI_SITE
        ? Math.round(SIZING.multiSiteCamerasPerSite * siteCount)
        : segment === SEGMENT.MANUFACTURER
          ? SIZING.defaultCameras.mfg
          : SIZING.defaultCameras.other,
    ),
  );
  const counterCount = Math.round(parsePositiveNumber(inputVars.counters, SIZING.defaultCountersPerSite));
  const machineCount = Math.round(parsePositiveNumber(inputVars.machines, SIZING.defaultMachines));
  const vehicleCount = Math.round(parsePositiveNumber(inputVars.vehicles, SIZING.defaultVehicles));

  // Candidates in order; the first one is always the connection (eligibility of later items depends on it).
  const candidates = [];
  const addCandidate = (productId, quantity, ownerAskedForIt, isOptional) =>
    candidates.push({
      productId,
      quantity: Math.max(1, Math.round(quantity)),
      ownerAskedForIt: !!ownerAskedForIt,
      isOptional: !!isOptional,
    });

  /** First product in the list this business may buy; falls back to the last one. */
  function pickFirstEligible(productIds) {
    for (const productId of productIds) {
      if (getEligibilityProblems(PRODUCTS_BY_ID[productId], business, {}).length === 0) return productId;
    }
    return productIds[productIds.length - 1];
  }

  const connectionProductId = chooseConnection(
    segment,
    employeeCount,
    siteCount,
    needs,
    fibreUnavailable,
    pickFirstEligible,
  );
  addCandidate(connectionProductId, segment === SEGMENT.MULTI_SITE ? siteCount : 1, false, false);

  const isRetailOrFood = containsAnyKeyword(businessType, SEGMENT_KEYWORDS.retailOrFood);
  if (segment === SEGMENT.MICRO) {
    addCandidate(PRODUCT.POSTPAID_299, mobileLineCount, false, false);
    if (needs.pos) addCandidate(PRODUCT.CLOUD_POS, counterCount, true, true);
    if (needs.cctv) addCandidate(PRODUCT.CLOUD_CCTV, cameraCount, true, true);
    if (needs.wifi) addCandidate(PRODUCT.SECURE_WIFI, 1, true, true);
    if (needs.whatsapp) addCandidate(PRODUCT.WHATSAPP_API, 1, true, true);
    if (needs.website) addCandidate(PRODUCT.WEBSITE_DOMAIN, 1, true, true);
    if (needs.sms) addCandidate(PRODUCT.BUSINESS_SMS, 1, true, true);
    if (needs.email) addCandidate(PRODUCT.CLOUD_EMAIL, emailUserCount, true, true);
    if (needs.security) addCandidate(PRODUCT.ENDPOINT_SECURITY, securedDeviceCount, true, true);
    if (needs.failover) addCandidate(PRODUCT.FAILOVER_4G_5G, 1, true, true);
  } else if (segment === SEGMENT.PROFESSIONAL) {
    if (needs.failover || employeeCount >= THRESHOLDS.officeTeamSizeForDefaultFailover) {
      addCandidate(PRODUCT.FAILOVER_4G_5G, 1, !!needs.failover, true);
    }
    addCandidate(PRODUCT.POSTPAID_599, mobileLineCount, false, false);
    addCandidate(PRODUCT.CLOUD_EMAIL, emailUserCount, !!needs.email, true);
    addCandidate(PRODUCT.ENDPOINT_SECURITY, securedDeviceCount, !!needs.security, true);
    addCandidate(PRODUCT.CLOUD_BACKUP_1TB, 1, !!needs.storage, true);
    if (needs.telephony) {
      const channelCount = Math.min(
        SIZING.maxTelephonyChannels,
        Math.max(SIZING.minTelephonyChannels, Math.round(employeeCount / SIZING.employeesPerTelephonyChannel)),
      );
      addCandidate(PRODUCT.CLOUD_TELEPHONY, channelCount, true, true);
    }
    if (needs.staticip) addCandidate(PRODUCT.STATIC_IP, 1, true, true);
    if (needs.sms) addCandidate(PRODUCT.BUSINESS_SMS, 1, true, true);
    if (needs.tollfree) addCandidate(PRODUCT.TOLL_FREE_NUMBER, 1, true, true);
    if (needs.website) addCandidate(PRODUCT.WEBSITE_DOMAIN, 1, true, true);
    if (needs.whatsapp) addCandidate(PRODUCT.WHATSAPP_API, 1, true, true);
    if (needs.wifi) addCandidate(PRODUCT.SECURE_WIFI, 1, true, true);
    if (needs.cctv) addCandidate(PRODUCT.CLOUD_CCTV, cameraCount, true, true);
    if (needs.firewall) addCandidate(PRODUCT.MANAGED_FIREWALL, 1, true, true);
  } else if (segment === SEGMENT.MULTI_SITE) {
    addCandidate(PRODUCT.FAILOVER_4G_5G, siteCount, !!needs.failover, true);
    addCandidate(PRODUCT.SECURE_WIFI, siteCount, !!needs.wifi, true);
    if (needs.pos || isRetailOrFood) addCandidate(PRODUCT.CLOUD_POS, siteCount * counterCount, !!needs.pos, true);
    if (needs.cctv) addCandidate(PRODUCT.CLOUD_CCTV, cameraCount, true, true);
    addCandidate(PRODUCT.POSTPAID_599, mobileLineCount, false, false);
    addCandidate(PRODUCT.TOLL_FREE_NUMBER, 1, !!needs.tollfree, true);
    if (needs.sdwan) addCandidate(PRODUCT.MANAGED_SD_WAN, siteCount, true, true);
    if (needs.whatsapp) addCandidate(PRODUCT.WHATSAPP_API, 1, true, true);
    if (needs.email) addCandidate(PRODUCT.CLOUD_EMAIL, emailUserCount, true, true);
    if (needs.fleet) addCandidate(PRODUCT.FLEET_TRACKER, vehicleCount, true, true);
    if (needs.security) addCandidate(PRODUCT.ENDPOINT_SECURITY, securedDeviceCount, true, true);
  } else {
    const isFibreOrAirFiber =
      connectionProductId === PRODUCT.BIZ_FIBRE_300 ||
      connectionProductId === PRODUCT.BIZ_FIBRE_1G ||
      connectionProductId === PRODUCT.AIRFIBER_5G;
    if (isFibreOrAirFiber) addCandidate(PRODUCT.FAILOVER_4G_5G, 1, !!needs.failover, true);
    addCandidate(PRODUCT.MANAGED_FIREWALL, 1, !!needs.firewall, true);
    addCandidate(PRODUCT.POSTPAID_599, mobileLineCount, false, false);
    addCandidate(PRODUCT.CLOUD_EMAIL, emailUserCount, !!needs.email, true);
    if (needs.iot) addCandidate(PRODUCT.MACHINE_IOT, machineCount, true, true);
    if (needs.fleet) addCandidate(PRODUCT.FLEET_TRACKER, vehicleCount, true, true);
    if (needs.security) addCandidate(PRODUCT.ENDPOINT_SECURITY, securedDeviceCount, true, true);
    if (needs.staticip) addCandidate(PRODUCT.STATIC_IP, 1, true, true);
    if (needs.cctv) addCandidate(PRODUCT.CLOUD_CCTV, cameraCount, true, true);
  }

  applyOwnerEdits(candidates, inputVars, addCandidate);

  // Eligibility pass, in order, so add-ons see the connection that came before them.
  const includedProductIds = {};
  const items = [];
  const blockedItems = [];
  candidates.forEach((candidate) => {
    const product = PRODUCTS_BY_ID[candidate.productId];
    const problems = getEligibilityProblems(product, business, includedProductIds);
    if (problems.length === 0) {
      items.push({
        productId: candidate.productId,
        quantity: candidate.quantity,
        ownerAskedForIt: candidate.ownerAskedForIt,
        isOptional: candidate.isOptional,
        product,
      });
      includedProductIds[candidate.productId] = true;
    } else {
      blockedItems.push({ productId: candidate.productId, name: product.name, reason: problems.join(", ") });
    }
  });

  const budgetNote = fitToBudget(items, parsePositiveNumber(inputVars.budget, 0), segment, business, language);

  const monthlyTotalInRupees = sumMonthlyPrice(items);
  const setupTotalInRupees = items.reduce((sum, item) => sum + item.quantity * item.product.oneTimeSetupInRupees, 0);
  const preferredContractMonths = parsePositiveNumber(inputVars.contract_months, 0);
  const contractMonths = Math.max(
    preferredContractMonths,
    items.reduce((longest, item) => Math.max(longest, item.product.minimumContractMonths), 1),
  );
  const installDays = items.reduce((slowest, item) => Math.max(slowest, item.product.typicalInstallDays), 1);
  const bundleName = BUNDLE_NAME_BY_SEGMENT[segment];
  const promise = decideActivationPromise(business, items, cityName, inputVars, language);

  const blockedText = blockedItems.map((blocked) => blocked.name + " (" + blocked.reason + ")").join("; ");
  const quoteText = formatQuoteText({
    bundleName,
    items,
    monthlyTotalInRupees,
    setupTotalInRupees,
    contractMonths,
    installDays,
    promiseText: promise.text,
    blockedText,
    budgetNote,
    language,
  });
  const whyText = formatWhyText(items, language);

  return {
    segment,
    bundleName,
    monthlyTotalInRupees,
    setupTotalInRupees,
    contractMonths,
    installDays,
    promise,
    quoteText,
    whyText,
    blockedText,
    budgetNote,
    items,
  };
}

/** Business postpaid lines by segment (see SIZING). */
function defaultMobileLineCount(segment, employeeCount) {
  if (segment === SEGMENT.MICRO) {
    return employeeCount <= SIZING.microMaxEmployeesForOneLine
      ? SIZING.microLinesForTinyShop
      : SIZING.microLinesOtherwise;
  }
  return clamp(
    Math.round(employeeCount / SIZING.employeesPerLine[segment]),
    SIZING.minLines[segment],
    SIZING.maxLines[segment],
  );
}

/** Cloud email users by segment (see SIZING). */
function defaultEmailUserCount(segment, employeeCount) {
  if (segment === SEGMENT.PROFESSIONAL) {
    return Math.max(SIZING.minimumEmailUsers, Math.ceil(employeeCount * SIZING.emailShareOfStaff.prof));
  }
  if (segment === SEGMENT.MANUFACTURER) {
    return Math.max(SIZING.minimumEmailUsers, Math.round(employeeCount * SIZING.emailShareOfStaff.mfg));
  }
  if (segment === SEGMENT.MULTI_SITE) {
    return Math.max(SIZING.minimumEmailUsers, Math.round(employeeCount * SIZING.emailShareOfStaff.multi));
  }
  return Math.max(SIZING.minimumEmailUsersMicro, employeeCount);
}

/** Devices that get endpoint security, by segment (see SIZING). */
function defaultSecuredDeviceCount(segment, employeeCount) {
  if (segment === SEGMENT.PROFESSIONAL) {
    return Math.max(
      SIZING.minimumSecuredDevices.prof,
      Math.round(employeeCount * SIZING.securedDeviceShareOfStaff.prof),
    );
  }
  if (segment === SEGMENT.MANUFACTURER) {
    return Math.max(SIZING.minimumSecuredDevices.mfg, Math.round(employeeCount * SIZING.securedDeviceShareOfStaff.mfg));
  }
  return Math.max(1, Math.min(employeeCount, SIZING.maxSecuredDevicesOtherSegments));
}

/**
 * Picks the main connection. No fibre → 5G AirFiber (installs in ~2 days). Factories prefer a leased line
 * (99.5% SLA) when they have a GSTIN; otherwise the best eligible fibre.
 */
function chooseConnection(segment, employeeCount, siteCount, needs, fibreUnavailable, pickFirstEligible) {
  if (segment === SEGMENT.MICRO) return fibreUnavailable ? PRODUCT.AIRFIBER_5G : PRODUCT.BIZ_FIBRE_100;
  if (segment === SEGMENT.PROFESSIONAL) {
    if (fibreUnavailable) return PRODUCT.AIRFIBER_5G;
    if (needs.highspeed) return pickFirstEligible([PRODUCT.BIZ_FIBRE_1G, PRODUCT.BIZ_FIBRE_300]);
    return employeeCount <= THRESHOLDS.maxEmployeesForBizFibre100InOffices
      ? PRODUCT.BIZ_FIBRE_100
      : PRODUCT.BIZ_FIBRE_300;
  }
  if (segment === SEGMENT.MULTI_SITE) {
    if (fibreUnavailable) return PRODUCT.AIRFIBER_5G;
    return employeeCount / siteCount > THRESHOLDS.employeesPerSiteNeedingBizFibre300
      ? PRODUCT.BIZ_FIBRE_300
      : PRODUCT.BIZ_FIBRE_100;
  }
  if (fibreUnavailable) return pickFirstEligible([PRODUCT.LEASED_LINE_20, PRODUCT.AIRFIBER_5G]);
  if ((needs.leased || needs.highspeed) && employeeCount >= THRESHOLDS.employeesForLeasedLine100) {
    return pickFirstEligible([
      PRODUCT.LEASED_LINE_100,
      PRODUCT.LEASED_LINE_20,
      PRODUCT.BIZ_FIBRE_1G,
      PRODUCT.BIZ_FIBRE_300,
    ]);
  }
  return pickFirstEligible([PRODUCT.LEASED_LINE_20, PRODUCT.BIZ_FIBRE_1G, PRODUCT.BIZ_FIBRE_300]);
}

/**
 * Reads one "add" request ("P20 5", "Business Postpaid 599", "cctv x6", "4 cctv") into a product and a quantity.
 * Order matters (CODE_REVIEW.md L2): the catalogue ID and the full product name are found BEFORE any number is
 * read as a quantity, because IDs and some names contain digits. Stripping digits first turned "P20" into "P"
 * (→ Static IP ×20) and "Business Postpaid 599" into Postpaid 299 ×599.
 * Returns { product, quantity } with quantity null when no number was given, or null for an unknown product.
 * Example: parseAddRequest("P20 5") → { product: Endpoint Security, quantity: 5 }.
 */
function parseAddRequest(request) {
  // "x5", "x 5", "5x" and "×5" all mean 5.
  const text = String(request || "")
    .trim()
    .replace(/(^|\s)[x×]\s*(\d)/gi, "$1$2")
    .replace(/(\d)\s*[x×](?=\s|$)/gi, "$1");
  if (!text) return null;
  let product = null;
  let rest = text;
  const idMatch = text.match(/\bp-?(\d{1,2})\b/i);
  if (idMatch) {
    product = PRODUCTS_BY_ID["P" + idMatch[1].padStart(2, "0")];
    if (!product) return null; // an ID that isn't in the catalogue: never guess another product
    rest = text.replace(idMatch[0], " ");
  } else {
    const lowerText = text.toLowerCase();
    PRODUCT_CATALOGUE.forEach((candidate) => {
      const isLongerFullNameMatch =
        lowerText.indexOf(candidate.name.toLowerCase()) >= 0 &&
        (!product || candidate.name.length > product.name.length);
      if (isLongerFullNameMatch) product = candidate;
    });
    if (product) {
      const nameStart = lowerText.indexOf(product.name.toLowerCase());
      rest = text.slice(0, nameStart) + " " + text.slice(nameStart + product.name.length);
    }
  }
  const quantityMatch = rest.match(/(\d+)\s*$/) || rest.match(/^\s*(\d+)/);
  if (!product) product = findProductByText(rest.replace(/\d+/g, " "));
  if (!product) return null;
  return { product, quantity: quantityMatch ? parseInt(quantityMatch[1], 10) : null };
}

/**
 * Applies the owner's "remove …" and "add …" requests to the candidate list.
 * The connection (first candidate) can never be removed.
 */
function applyOwnerEdits(candidates, inputVars, addCandidate) {
  String(inputVars.remove || "")
    .split(/[,;]+/)
    .forEach((request) => {
      const product = findProductByText(request);
      if (!product) return;
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].productId === product.id && i > 0) candidates.splice(i, 1);
      }
    });
  String(inputVars.add || "")
    .split(/[,;]+/)
    .forEach((request) => {
      const parsed = parseAddRequest(request);
      if (!parsed) return;
      const existing = candidates.find((candidate) => candidate.productId === parsed.product.id);
      if (existing) existing.quantity = parsed.quantity === null ? existing.quantity : parsed.quantity;
      else addCandidate(parsed.product.id, parsed.quantity === null ? 1 : parsed.quantity, true, true);
    });
}

function sumMonthlyPrice(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.product.monthlyPriceFloorInRupees, 0);
}

/**
 * Shrinks the bundle to a monthly budget, in this order: drop optional items (BUDGET_TRIM_ORDER), swap fibre
 * for 5G AirFiber (shops and offices only), cut mobile lines down to one. Changes `items` in place and returns
 * the note for the owner ("" when no budget was given or it already fits). Targets the case's top drop reason:
 * "Price too high", 414 leads lost after needs assessment.
 */
function fitToBudget(items, monthlyBudget, segment, business, language) {
  if (!(monthlyBudget > 0 && sumMonthlyPrice(items) > monthlyBudget)) return "";
  const removedForBudget = [];
  for (const productId of BUDGET_TRIM_ORDER) {
    if (sumMonthlyPrice(items) <= monthlyBudget) break;
    const index = items.findIndex((item) => item.productId === productId && item.isOptional);
    if (index >= 0) {
      removedForBudget.push(items[index].product.name);
      items.splice(index, 1);
    }
  }
  // Evaluated only when still over budget (same short-circuit order as before the cleanup).
  const canSwitchToAirFiber = () =>
    (segment === SEGMENT.MICRO || segment === SEGMENT.PROFESSIONAL) &&
    items[0].productId !== PRODUCT.AIRFIBER_5G &&
    getEligibilityProblems(PRODUCTS_BY_ID[PRODUCT.AIRFIBER_5G], business, {}).length === 0;
  if (sumMonthlyPrice(items) > monthlyBudget && canSwitchToAirFiber()) {
    removedForBudget.push(items[0].product.name + MESSAGES.switchedToAirFiber);
    items[0] = {
      productId: PRODUCT.AIRFIBER_5G,
      quantity: items[0].quantity,
      ownerAskedForIt: false,
      isOptional: false,
      product: PRODUCTS_BY_ID[PRODUCT.AIRFIBER_5G],
    };
  }
  const mobileLineItem = items.find(
    (item) => item.productId === PRODUCT.POSTPAID_299 || item.productId === PRODUCT.POSTPAID_599,
  );
  while (sumMonthlyPrice(items) > monthlyBudget && mobileLineItem && mobileLineItem.quantity > 1) {
    mobileLineItem.quantity -= 1;
  }
  const text = MESSAGES[language];
  return sumMonthlyPrice(items) <= monthlyBudget
    ? fillTemplate(text.budgetFitted, { budget: formatRupees(monthlyBudget) }) + (removedForBudget.join(", ") || "-")
    : fillTemplate(text.budgetLowestPossible, { total: formatRupees(sumMonthlyPrice(items)) });
}

/** The quote card shown to the owner: one line per item, then setup, plan length, install time and GST. */
function formatQuoteText(quote) {
  const text = MESSAGES[quote.language];
  const itemLines = quote.items.map(
    (item) =>
      "• " +
      item.product.name +
      (item.quantity > 1 ? " ×" + item.quantity : "") +
      " · " +
      formatRupees(item.quantity * item.product.monthlyPriceFloorInRupees),
  );
  let quoteText =
    quote.bundleName +
    " · " +
    formatRupees(quote.monthlyTotalInRupees) +
    text.perMonth +
    "\n" +
    itemLines.join("\n") +
    "\n" +
    (quote.setupTotalInRupees > 0
      ? text.oneTimeSetup + " " + formatRupees(quote.setupTotalInRupees)
      : text.noSetupFee) +
    " · " +
    quote.contractMonths +
    text.monthPlanSuffix +
    " · " +
    fillTemplate(text.liveInDays, { days: quote.installDays }) +
    " · " +
    text.gstExtra +
    "\n" +
    quote.promiseText;
  if (quote.blockedText) quoteText += "\n" + text.notAdded + ": " + quote.blockedText;
  if (quote.budgetNote) quoteText += "\n" + quote.budgetNote;
  return quoteText;
}

/** The quote's connection item: the first item that is a connection product, or null. */
function findConnectionItem(items) {
  return items.find((item) => ACTIVATION_PROMISE_DATA.connectionTypeByProduct[item.productId]) || null;
}

/**
 * Why this quote is outside GUARANTEE_SCOPE: a list of PROMISE_SCOPE_REASON codes, empty when it qualifies.
 * Uses only what is known at quote time: city tier and AirFiber coverage, team size, sites and the connection.
 */
function findGuaranteeScopeProblems(business, connectionItem, cityName, inputVars) {
  const problems = [];
  if (GUARANTEE_SCOPE.cityTiers.indexOf(business.cityTier) < 0) problems.push(PROMISE_SCOPE_REASON.CITY_TIER);
  if (business.employeeCount > GUARANTEE_SCOPE.maxEmployees) problems.push(PROMISE_SCOPE_REASON.TEAM_SIZE);
  if (business.siteCount > GUARANTEE_SCOPE.maxSites) problems.push(PROMISE_SCOPE_REASON.SITES);
  if (!connectionItem || GUARANTEE_SCOPE.connectionProductIds.indexOf(connectionItem.productId) < 0) {
    problems.push(PROMISE_SCOPE_REASON.CONNECTION);
  }
  const isAirFiberCovered = AIRFIBER_COVERAGE_CITY_NAMES.indexOf(cityName) >= 0 && !isNo(inputVars.airfiber_available);
  if (GUARANTEE_SCOPE.requiresAirFiberCoverage && !isAirFiberCovered) {
    problems.push(PROMISE_SCOPE_REASON.AIRFIBER_COVERAGE);
  }
  return problems;
}

/**
 * The activation promise shown on the quote card: "Connected in 72 hours, guaranteed" inside GUARANTEE_SCOPE,
 * otherwise a firm number of days for the quote's city tier and connection type (ACTIVATION_PROMISE_DATA, from the
 * case data). Never shorter than the 72-hour guarantee. Returns { type, hours, days, text, reasons, reasonsText }.
 * Example: Delhi kirana, 3 people, Biz Fibre 100 → { type: "guaranteed_72h", hours: 72, days: 3, reasons: [] }.
 */
function decideActivationPromise(business, items, cityName, inputVars, language) {
  const text = MESSAGES[language];
  const connectionItem = findConnectionItem(items);
  const reasons = findGuaranteeScopeProblems(business, connectionItem, cityName, inputVars);
  const reasonsText = reasons
    .map((reason) =>
      fillTemplate(MESSAGES.promiseScopeReasons[reason], {
        count: GUARANTEE_SCOPE.maxEmployees,
        name: connectionItem ? connectionItem.product.name : "",
      }),
    )
    .join("; ");
  const guaranteeDays = Math.ceil(GUARANTEE_SCOPE.hours / HOURS_PER_DAY);
  if (reasons.length === 0) {
    return {
      type: PROMISE_TYPE.GUARANTEED_72H,
      hours: GUARANTEE_SCOPE.hours,
      days: guaranteeDays,
      text: text.promiseGuaranteed72h,
      reasons,
      reasonsText,
    };
  }
  const connectionType = connectionItem
    ? ACTIVATION_PROMISE_DATA.connectionTypeByProduct[connectionItem.productId]
    : ACTIVATION_PROMISE_DATA.anyConnectionType;
  const firmDaysByType =
    ACTIVATION_PROMISE_DATA.firmDays[String(business.cityTier)] ||
    ACTIVATION_PROMISE_DATA.firmDays[String(THRESHOLDS.defaultCityTier)];
  const days = Math.max(firmDaysByType[connectionType].days, guaranteeDays);
  return {
    type: PROMISE_TYPE.FIRM_DATE,
    hours: days * HOURS_PER_DAY,
    days,
    text: fillTemplate(text.promiseFirmDate, { days }),
    reasons,
    reasonsText,
  };
}

/** "Why:" line: the connection first, then what the owner asked for, then the rest (top MAX_REASONS_SHOWN). */
function formatWhyText(items, language) {
  const languageIndex = language === "hi" ? 1 : 0;
  const itemsByImportance = items
    .slice()
    .sort((first, second) =>
      first === items[0] ? -1 : second === items[0] ? 1 : second.ownerAskedForIt - first.ownerAskedForIt,
    );
  return (
    MESSAGES[language].whyPrefix +
    itemsByImportance
      .slice(0, MAX_REASONS_SHOWN)
      .map((item) => MESSAGES.reasonByProductId[item.productId][languageIndex].replace("{quantity}", item.quantity))
      .join("; ")
  );
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/**
 * The 25 products from product_catalogue.csv (case pack, synthetic). Fields per product:
 * id, category, name, unit, monthlyPriceFloorInRupees, monthlyPriceCeilingInRupees, oneTimeSetupInRupees,
 * minimumContractMonths, availableCityTiers, minimumEmployees, minimumSites, requiresGstin,
 * requiresOneOfProductIds, typicalInstallDays.
 */
const PRODUCT_CATALOGUE = [{"id":"P01","category":"Connectivity","name":"Biz Fibre 100","unit":"per site","monthlyPriceFloorInRupees":999,"monthlyPriceCeilingInRupees":1199,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":5},{"id":"P02","category":"Connectivity","name":"Biz Fibre 300","unit":"per site","monthlyPriceFloorInRupees":1499,"monthlyPriceCeilingInRupees":1799,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":5},{"id":"P03","category":"Connectivity","name":"Biz Fibre 1G","unit":"per site","monthlyPriceFloorInRupees":3999,"monthlyPriceCeilingInRupees":4499,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1],"minimumEmployees":5,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":7},{"id":"P04","category":"Connectivity","name":"Biz 5G AirFiber 100","unit":"per site","monthlyPriceFloorInRupees":899,"monthlyPriceCeilingInRupees":1099,"oneTimeSetupInRupees":0,"minimumContractMonths":6,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":2},{"id":"P05","category":"Connectivity","name":"Internet Leased Line 20","unit":"per site","monthlyPriceFloorInRupees":8000,"monthlyPriceCeilingInRupees":12000,"oneTimeSetupInRupees":10000,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":10,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":21},{"id":"P06","category":"Connectivity","name":"Internet Leased Line 100","unit":"per site","monthlyPriceFloorInRupees":25000,"monthlyPriceCeilingInRupees":35000,"oneTimeSetupInRupees":15000,"minimumContractMonths":24,"availableCityTiers":[1,2],"minimumEmployees":25,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":30},{"id":"P07","category":"Connectivity","name":"Business Postpaid 299","unit":"per line","monthlyPriceFloorInRupees":299,"monthlyPriceCeilingInRupees":399,"oneTimeSetupInRupees":0,"minimumContractMonths":1,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P08","category":"Connectivity","name":"Business Postpaid 599","unit":"per line","monthlyPriceFloorInRupees":599,"monthlyPriceCeilingInRupees":799,"oneTimeSetupInRupees":0,"minimumContractMonths":1,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P09","category":"Connectivity","name":"Backup 4G/5G Failover","unit":"per site","monthlyPriceFloorInRupees":499,"monthlyPriceCeilingInRupees":599,"oneTimeSetupInRupees":1500,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":["P01","P02","P03","P05","P06"],"typicalInstallDays":3},{"id":"P10","category":"Connectivity","name":"Managed SD-WAN","unit":"per site","monthlyPriceFloorInRupees":2500,"monthlyPriceCeilingInRupees":3500,"oneTimeSetupInRupees":5000,"minimumContractMonths":24,"availableCityTiers":[1,2],"minimumEmployees":10,"minimumSites":3,"requiresGstin":true,"requiresOneOfProductIds":["P01","P02","P03","P05","P06"],"typicalInstallDays":14},{"id":"P11","category":"Connectivity","name":"Static IP","unit":"per IP","monthlyPriceFloorInRupees":200,"monthlyPriceCeilingInRupees":300,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":["P01","P02","P03"],"typicalInstallDays":1},{"id":"P12","category":"Communication","name":"Cloud Telephony / SIP","unit":"per channel","monthlyPriceFloorInRupees":1000,"monthlyPriceCeilingInRupees":1500,"oneTimeSetupInRupees":2000,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":3,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":["P01","P02","P03","P04","P05","P06"],"typicalInstallDays":5},{"id":"P13","category":"Communication","name":"Toll-free Number","unit":"per number","monthlyPriceFloorInRupees":1500,"monthlyPriceCeilingInRupees":2000,"oneTimeSetupInRupees":1000,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":3},{"id":"P14","category":"Communication","name":"Business SMS 10k","unit":"per pack","monthlyPriceFloorInRupees":1500,"monthlyPriceCeilingInRupees":2000,"oneTimeSetupInRupees":0,"minimumContractMonths":1,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":4},{"id":"P15","category":"Communication","name":"WhatsApp Business API Starter","unit":"per account","monthlyPriceFloorInRupees":999,"monthlyPriceCeilingInRupees":1499,"oneTimeSetupInRupees":0,"minimumContractMonths":3,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":3},{"id":"P16","category":"Cloud & Productivity","name":"Cloud Email & Office Suite","unit":"per user","monthlyPriceFloorInRupees":125,"monthlyPriceCeilingInRupees":150,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P17","category":"Cloud & Productivity","name":"Cloud Backup 1 TB","unit":"per account","monthlyPriceFloorInRupees":499,"monthlyPriceCeilingInRupees":699,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P18","category":"Cloud & Productivity","name":"Website + Domain Starter","unit":"per account","monthlyPriceFloorInRupees":299,"monthlyPriceCeilingInRupees":499,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":2},{"id":"P19","category":"Cloud & Productivity","name":"Cloud POS & Billing","unit":"per counter","monthlyPriceFloorInRupees":599,"monthlyPriceCeilingInRupees":899,"oneTimeSetupInRupees":2500,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":3},{"id":"P20","category":"Security","name":"Endpoint Security","unit":"per device","monthlyPriceFloorInRupees":99,"monthlyPriceCeilingInRupees":149,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P21","category":"Security","name":"Managed Firewall","unit":"per site","monthlyPriceFloorInRupees":1999,"monthlyPriceCeilingInRupees":2999,"oneTimeSetupInRupees":4000,"minimumContractMonths":24,"availableCityTiers":[1,2],"minimumEmployees":10,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":["P01","P02","P03","P05","P06"],"typicalInstallDays":10},{"id":"P22","category":"Security","name":"Secure Wi-Fi with Guest Network","unit":"per site","monthlyPriceFloorInRupees":399,"monthlyPriceCeilingInRupees":599,"oneTimeSetupInRupees":1000,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":["P01","P02","P03","P04"],"typicalInstallDays":3},{"id":"P23","category":"IoT & Physical","name":"Cloud CCTV","unit":"per camera","monthlyPriceFloorInRupees":199,"monthlyPriceCeilingInRupees":299,"oneTimeSetupInRupees":1800,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":["P01","P02","P03","P04","P05","P06"],"typicalInstallDays":4},{"id":"P24","category":"IoT & Physical","name":"Machine Monitoring IoT","unit":"per device","monthlyPriceFloorInRupees":149,"monthlyPriceCeilingInRupees":249,"oneTimeSetupInRupees":3000,"minimumContractMonths":24,"availableCityTiers":[1,2],"minimumEmployees":10,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":10},{"id":"P25","category":"IoT & Physical","name":"Fleet Tracker","unit":"per vehicle","monthlyPriceFloorInRupees":199,"monthlyPriceCeilingInRupees":299,"oneTimeSetupInRupees":1500,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":3}];

/**
 * Activation-promise data from smb_leads.csv (case pack, synthetic), built by _build/gen_kit.py
 * (compute_activation_promise_data): connectionTypeByProduct (connection product → type) and firmDays[tier][type] =
 * { days, observedDays, catalogueDays, orders, basis }. days = the day by which 9 in 10 past activated orders of that
 * tier and connection were live, never shorter than the catalogue's install time.
 */
const ACTIVATION_PROMISE_DATA = {"connectionTypeByProduct":{"P01":"fibre","P02":"fibre","P03":"fibre_1g","P04":"airfiber","P05":"leased_line","P06":"leased_line"},"anyConnectionType":"any","firmDays":{"1":{"airfiber":{"days":8,"observedDays":8,"catalogueDays":2,"orders":221,"basis":"tier, all connections"},"fibre":{"days":7,"observedDays":7,"catalogueDays":5,"orders":180,"basis":"tier and connection"},"fibre_1g":{"days":7,"observedDays":7,"catalogueDays":7,"orders":27,"basis":"tier and connection"},"leased_line":{"days":21,"observedDays":14,"catalogueDays":21,"orders":27,"basis":"connection, both tiers"},"any":{"days":8,"observedDays":8,"catalogueDays":1,"orders":221,"basis":"tier, all connections"}},"2":{"airfiber":{"days":11,"observedDays":11,"catalogueDays":2,"orders":147,"basis":"tier, all connections"},"fibre":{"days":10,"observedDays":10,"catalogueDays":5,"orders":101,"basis":"tier and connection"},"fibre_1g":{"days":9,"observedDays":9,"catalogueDays":7,"orders":24,"basis":"tier and connection"},"leased_line":{"days":21,"observedDays":14,"catalogueDays":21,"orders":27,"basis":"connection, both tiers"},"any":{"days":11,"observedDays":11,"catalogueDays":1,"orders":147,"basis":"tier, all connections"}}}};
const PRODUCTS_BY_ID = {};
PRODUCT_CATALOGUE.forEach((product) => {
  PRODUCTS_BY_ID[product.id] = product;
});

  return main;
})();
