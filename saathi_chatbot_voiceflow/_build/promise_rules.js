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

export const PROMISE_RULES_API = {
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
