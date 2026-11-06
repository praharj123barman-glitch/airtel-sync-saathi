/*
 * readiness_score.js: Voiceflow function tool "readiness_score" (TEMPLATE; the build injects eligibility rules
 * from the product catalogue).
 *
 * What it does: a digital-readiness score from 0 to 100 for a small business. It reads what the business already
 * uses ("home broadband, 2 Jio SIMs, UPI QR"), scores it against what matters for its segment, names the top 3
 * gaps, and lists the Accel add-ons that close them, with the new score after each one (cumulative).
 *
 * How it fits: STRATEGY.md, PROMISE ("Outcomes, not products"). The advisor playbook runs it at the start of
 * discovery; the onboarding playbook offers it after the GSTIN lookup. It never prices anything: prices come only
 * from price_bundle.
 *
 * All scoring rules live in ONE object, READINESS_RULES, so they can be read, defended and changed in one place.
 */

/**
 * Voiceflow entry point: scores the business and suggests the add-ons that raise the score most.
 *
 * @param {{inputVars?: {current_products?: string, segment?: string, staff_count?: string, sites?: string,
 *   has_gstin?: string, lang?: string, show_card?: string}}} args
 *   current_products: what the business already uses, comma- or line-separated ("none" is a valid answer).
 *   segment: micro / prof / multi / mfg, an onboarding category (e.g. "clinic") or a business type.
 * @returns {{outputVars: Object, trace: Array}}  Every declared output, always; `error` on failure.
 * @example
 *   await main({ inputVars: { current_products: "home broadband, 2 jio sims, gmail", segment: "prof", staff_count: "12" } })
 *   // → readiness_score 19; top gaps: data security, backup internet, business email (add-ons → 39, 54, 65)
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const language = detectLanguage(inputVars.lang);
  const text = MESSAGES[language];
  const outputVars = createEmptyOutputs();
  try {
    const productItems = splitProducts(inputVars.current_products);
    if (productItems.length === 0) {
      outputVars.next_action = NEXT_ACTION.ASK_PRODUCTS;
      outputVars.message = text.askProducts;
      return respond(outputVars, inputVars);
    }
    const segmentChoice = chooseSegment(inputVars.segment, inputVars.sites);
    const weights = READINESS_RULES.weightsBySegment[segmentChoice.segment];
    const recognition = recogniseProducts(productItems, segmentChoice.segment);
    const credits = recognition.creditByCapability;

    outputVars.next_action = NEXT_ACTION.SHOW_SCORE;
    outputVars.segment_used = segmentChoice.segment;
    outputVars.segment_assumed = segmentChoice.wasAssumed;
    outputVars.readiness_score = computeScore(weights, credits);
    outputVars.recognised_products = recognition.recognised.join("; ");
    outputVars.unrecognised_items = recognition.unrecognised.join(", ");

    const gaps = findTopGaps(weights, credits);
    const facts = readBusinessFacts(inputVars);
    const addOnPath = planAddOns(gaps, weights, credits, segmentChoice.segment, facts);
    outputVars.gaps_json = JSON.stringify(gaps);
    outputVars.top_gaps = gaps.map((gap) => capabilityLabel(gap.capability, language)).join(" | ");
    outputVars.add_ons_json = JSON.stringify(addOnPath);
    outputVars.score_after_add_ons = addOnPath.length
      ? addOnPath[addOnPath.length - 1].new_score
      : outputVars.readiness_score;
    outputVars.add_on_path_text = describeAddOnPath(addOnPath, language);
    outputVars.suggested_needs = addOnPath
      .filter((step) => step.available && PRICING_NEED_BY_PRODUCT[step.product_id])
      .map((step) => PRICING_NEED_BY_PRODUCT[step.product_id])
      .join(", ");
    outputVars.message = writeMessage(outputVars, gaps, segmentChoice, language);
    return respond(outputVars, inputVars);
  } catch (error) {
    outputVars.error = ERROR_PREFIX + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG: the scoring rules (one object)

/**
 * READINESS_RULES: everything that decides the score.
 *
 * 1. capabilities: what a business can have. Each has `levels` (words that describe what the owner uses, and the
 *    credit from 0 to 1 that it earns; the best matching level counts) and `addOns` (Accel products that bring the
 *    capability to full credit, in order of preference; the first one the business is eligible for is suggested).
 *    Partial credits are design choices: a consumer product does part of the job, e.g. home broadband = 0.5
 *    because it has no business SLA, and a personal SIM = 0.5 because it isn't on the business bill.
 *    An add-on earns full credit (1) unless `addOnCredits` says otherwise; it is only suggested if it raises the
 *    capability's credit.
 *
 * 2. weightsBySegment: how much each capability matters, out of 100, for each of the case's four segments. They
 *    follow the "key needs" in the case's Appendix A2:
 *      micro  "Reliable internet for UPI/POS, WhatsApp catalogue"
 *      prof   "Uptime, cloud email/storage, data security"
 *      multi  "One bill, central management, CCTV, failover"
 *      mfg    "Dedicated bandwidth, IoT for machines, ERP access"
 *    "general" is used when the segment is unknown (and the result says so).
 *    Every segment's weights add up to exactly 100 (checked by a test).
 *
 * Score = sum over capabilities of weight × credit, rounded to a whole number.
 */
const READINESS_RULES = {
  capabilities: {
    reliable_internet: {
      levels: [
        { words: ["leased line", "dedicated internet", "dedicated line", "ill"], credit: 1 },
        {
          words: ["business broadband", "business fibre", "business fiber", "biz fibre", "business internet"],
          credit: 1,
          // Factories need dedicated bandwidth (Appendix A2): shared fibre is only part of the job.
          creditBySegment: { mfg: 0.6 },
        },
        { words: ["airfiber", "5g fwa"], credit: 0.8, creditBySegment: { mfg: 0.5 } },
        { words: ["broadband", "fibre", "fiber", "wifi", "wi-fi", "home internet"], credit: 0.5 },
        { words: ["hotspot", "mobile data", "dongle", "data card"], credit: 0.25 },
      ],
      addOnsBySegment: {
        micro: ["P01", "P04"],
        prof: ["P02", "P01"],
        multi: ["P01", "P02"],
        mfg: ["P05", "P02"],
        general: ["P02", "P01"],
      },
      // Credit an add-on earns when it isn't full (same values as the levels above): AirFiber is 0.8 (0.5 for a
      // factory); business fibre is 0.6 for a factory, which needs dedicated bandwidth.
      addOnCredits: { P04: { default: 0.8, mfg: 0.5 }, P01: { mfg: 0.6 }, P02: { mfg: 0.6 } },
    },
    backup_internet: {
      levels: [
        { words: ["failover", "backup internet", "backup connection", "second connection", "4g router"], credit: 1 },
      ],
      addOns: ["P09"],
    },
    business_lines: {
      levels: [
        { words: ["business postpaid", "postpaid", "business sim", "corporate sim", "business mobile"], credit: 1 },
        { words: ["sim", "sims", "mobile", "prepaid", "phone", "jio", "recharge"], credit: 0.5 },
      ],
      // "Jio fiber" or "mobile hotspot" is the internet connection, not a phone line for the business.
      notWhenAlsoMatched: ["reliable_internet"],
      addOnsBySegment: { micro: ["P07"], prof: ["P08"], multi: ["P08"], mfg: ["P08"], general: ["P08"] },
    },
    customer_messaging: {
      levels: [
        { words: ["whatsapp business api", "whatsapp api", "bulk sms", "sms"], credit: 1 },
        // The free WhatsApp Business app works, but has no catalogue broadcasts or team inbox.
        { words: ["whatsapp business", "whatsapp"], credit: 0.5 },
      ],
      addOns: ["P15", "P14"],
    },
    billing_payments: {
      levels: [
        { words: ["pos", "billing software", "point of sale", "petpooja", "billing"], credit: 1 },
        // Takes digital payments but has no billing system.
        { words: ["upi", "qr", "paytm", "phonepe", "card machine", "swipe machine"], credit: 0.5 },
      ],
      addOns: ["P19"],
    },
    online_presence: {
      levels: [
        { words: ["website", "domain", "online store", "e-commerce"], credit: 1 },
        { words: ["google business", "google maps", "instagram", "facebook"], credit: 0.5 },
      ],
      addOns: ["P18"],
    },
    cloud_email: {
      levels: [
        {
          words: ["google workspace", "microsoft 365", "office 365", "business email", "cloud email", "zoho mail"],
          credit: 1,
        },
        // A personal Gmail is the case's own example for professional offices ("personal Gmail").
        { words: ["gmail", "personal email", "email"], credit: 0.25 },
      ],
      addOns: ["P16"],
    },
    cloud_backup: {
      levels: [
        { words: ["cloud backup", "cloud storage", "google drive", "onedrive", "dropbox", "backup"], credit: 1 },
      ],
      // "backup internet" is a backup CONNECTION, not data backup.
      notWhenAlsoMatched: ["backup_internet"],
      addOns: ["P17"],
    },
    data_security: {
      levels: [
        {
          words: [
            "antivirus",
            "anti-virus",
            "endpoint security",
            "firewall",
            "security software",
            "quick heal",
            "norton",
            "kaspersky",
          ],
          credit: 1,
        },
      ],
      addOnsBySegment: { micro: ["P20"], prof: ["P20"], multi: ["P20"], mfg: ["P21", "P20"], general: ["P20"] },
    },
    cctv: {
      levels: [{ words: ["cctv", "camera", "cameras", "surveillance", "dvr"], credit: 1 }],
      addOns: ["P23"],
    },
    central_management: {
      levels: [{ words: ["sd-wan", "sdwan", "mpls", "central management"], credit: 1 }],
      addOns: ["P10"],
    },
    machine_iot: {
      levels: [
        { words: ["machine monitoring", "iot", "sensors"], credit: 1 },
        { words: ["gps", "fleet", "vehicle tracking"], credit: 0.5 },
      ],
      // Only machine IoT closes this gap; a fleet tracker is partial credit (0.5) and is not suggested here.
      addOns: ["P24"],
    },
    voice: {
      levels: [
        { words: ["cloud telephony", "ivr", "toll free", "toll-free"], credit: 1 },
        { words: ["landline"], credit: 0.5 },
      ],
      addOns: ["P12", "P13"],
    },
  },
  weightsBySegment: {
    micro: {
      reliable_internet: 25,
      billing_payments: 25,
      customer_messaging: 20,
      business_lines: 10,
      online_presence: 10,
      data_security: 5,
      cctv: 5,
    },
    prof: {
      reliable_internet: 20,
      backup_internet: 15,
      cloud_email: 15,
      cloud_backup: 10,
      data_security: 20,
      business_lines: 10,
      voice: 5,
      online_presence: 5,
    },
    multi: {
      reliable_internet: 15,
      backup_internet: 20,
      central_management: 20,
      cctv: 20,
      billing_payments: 10,
      business_lines: 10,
      customer_messaging: 5,
    },
    mfg: {
      reliable_internet: 30,
      machine_iot: 25,
      data_security: 20,
      cloud_email: 10,
      business_lines: 10,
      backup_internet: 5,
    },
    general: {
      reliable_internet: 25,
      backup_internet: 10,
      business_lines: 10,
      cloud_email: 10,
      cloud_backup: 5,
      data_security: 15,
      billing_payments: 10,
      customer_messaging: 10,
      online_presence: 5,
    },
  },
};

// ================================================================ CONFIG: everything else

const NEXT_ACTION = { SHOW_SCORE: "show_score", ASK_PRODUCTS: "ask_products" };
/**
 * The price_bundle `needs` keyword for each add-on, so the playbook can re-price with them. Needs keywords are
 * used instead of product names because names contain numbers ("Business Postpaid 299") that price_bundle's
 * add parser would read as quantities (CODE_REVIEW.md L2). Connections and lines are in every bundle: "".
 */
const PRICING_NEED_BY_PRODUCT = {
  P01: "",
  P02: "",
  P04: "",
  P05: "leased",
  P07: "",
  P08: "",
  P09: "failover",
  P10: "sdwan",
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
  P23: "cctv",
  P24: "iot",
};
const TOP_GAP_COUNT = 3;
const MAX_SCORE = 100;
/** Answers that mean "we use nothing digital yet" (a valid answer that scores 0, not a missing answer). */
const NOTHING_WORDS = ["none", "nothing", "no", "nil", "kuch nahi", "कुछ नहीं", "कुछ भी नहीं", "ಏನೂ ಇಲ್ಲ", "ಇಲ್ಲ"];
/** Segment inputs understood (codes, onboarding categories, case segment names, common business words). */
const SEGMENT_WORDS = {
  multi: ["multi", "chain", "branches", "outlets", "small multi-site businesses"],
  mfg: ["mfg", "manufactur", "factory", "small_factory", "small manufacturers", "unit", "workshop"],
  prof: [
    "prof",
    "office",
    "clinic",
    "ca_firm",
    "ca firm",
    "coaching",
    "lab",
    "professional offices",
    "agency",
    "studio",
  ],
  micro: [
    "micro",
    "kirana",
    "shop",
    "store",
    "retail",
    "salon",
    "restaurant",
    "pharmacy",
    "bakery",
    "micro retail & services",
  ],
};
/** 3+ sites makes a business multi-site (case Appendix A2: "3–10 store retailer"). */
const SITES_FOR_MULTI_SITE = 3;
const PRODUCT_SEPARATOR_PATTERN = /[,;\n]+/;
const ERROR_PREFIX = "readiness_score failed: ";

// ================================================================ MESSAGES (all user-facing text)
// Kannada text was written for this prototype; have a native speaker review it before going live.

const MESSAGES = {
  en: {
    askProducts:
      'Which of these does your business already use? Internet (which kind), business SIMs, billing/POS or UPI, WhatsApp for customers, website, business email, cloud backup, antivirus, CCTV. Say "none" if nothing yet.',
    score: "Your digital-readiness score: {score}/100.",
    fullScore: "You already have everything that matters most for your kind of business.",
    gaps: "Biggest gaps: {gaps}.",
    pathIntro: "What would raise it:",
    pathStep: "• Add {product} → {score}/100",
    pathCondition: " ({condition})",
    pathUnavailable: "• {gap}: {reason}",
    noBetterProduct: "no Accel product improves this for your business",
    segmentAssumed: "(Scored as a general small business. Tell me your business type for a sharper score.)",
    unrecognised: "I didn't recognise: {items}.",
    labels: {
      reliable_internet: "business-grade internet",
      backup_internet: "backup internet",
      business_lines: "business SIMs",
      customer_messaging: "WhatsApp/SMS to customers",
      billing_payments: "billing/POS",
      online_presence: "website",
      cloud_email: "business email",
      cloud_backup: "cloud backup",
      data_security: "data security",
      cctv: "CCTV",
      central_management: "central network management",
      machine_iot: "machine monitoring",
      voice: "business calling",
    },
    conditions: { gstin: "needs an active GSTIN", staff: "needs {count}+ staff", sites: "needs {count}+ locations" },
  },
  hi: {
    askProducts:
      'आपका बिज़नेस इनमें से क्या-क्या पहले से इस्तेमाल करता है? इंटरनेट (कौन-सा), बिज़नेस सिम, बिलिंग/POS या UPI, ग्राहकों के लिए WhatsApp, वेबसाइट, बिज़नेस ईमेल, क्लाउड बैकअप, एंटीवायरस, CCTV. अभी कुछ नहीं हो तो "कुछ नहीं" लिखिए।',
    score: "आपका डिजिटल-रेडीनेस स्कोर: {score}/100.",
    fullScore: "आपके बिज़नेस के लिए ज़रूरी सब कुछ आपके पास पहले से है।",
    gaps: "सबसे बड़ी कमियाँ: {gaps}.",
    pathIntro: "स्कोर ऐसे बढ़ेगा:",
    pathStep: "• {product} जोड़ें → {score}/100",
    pathCondition: " ({condition})",
    pathUnavailable: "• {gap}: {reason}",
    noBetterProduct: "आपके बिज़नेस के लिए Accel का कोई प्रोडक्ट इसे बेहतर नहीं करता",
    segmentAssumed: "(सामान्य छोटे बिज़नेस के हिसाब से स्कोर किया। बिज़नेस का प्रकार बताएँ तो स्कोर और सटीक होगा।)",
    unrecognised: "ये मैं नहीं समझ पाया: {items}.",
    labels: {
      reliable_internet: "बिज़नेस-ग्रेड इंटरनेट",
      backup_internet: "बैकअप इंटरनेट",
      business_lines: "बिज़नेस सिम",
      customer_messaging: "ग्राहकों को WhatsApp/SMS",
      billing_payments: "बिलिंग/POS",
      online_presence: "वेबसाइट",
      cloud_email: "बिज़नेस ईमेल",
      cloud_backup: "क्लाउड बैकअप",
      data_security: "डेटा सुरक्षा",
      cctv: "CCTV",
      central_management: "सेंट्रल नेटवर्क मैनेजमेंट",
      machine_iot: "मशीन मॉनिटरिंग",
      voice: "बिज़नेस कॉलिंग",
    },
    conditions: { gstin: "एक्टिव GSTIN ज़रूरी", staff: "{count}+ स्टाफ़ ज़रूरी", sites: "{count}+ जगहें ज़रूरी" },
  },
  kn: {
    askProducts:
      'ನಿಮ್ಮ ವ್ಯಾಪಾರ ಇವುಗಳಲ್ಲಿ ಯಾವುದನ್ನು ಈಗಾಗಲೇ ಬಳಸುತ್ತಿದೆ? ಇಂಟರ್ನೆಟ್ (ಯಾವ ರೀತಿಯದು), ಬಿಸಿನೆಸ್ ಸಿಮ್, ಬಿಲ್ಲಿಂಗ್/POS ಅಥವಾ UPI, ಗ್ರಾಹಕರಿಗೆ WhatsApp, ವೆಬ್‌ಸೈಟ್, ಬಿಸಿನೆಸ್ ಇಮೇಲ್, ಕ್ಲೌಡ್ ಬ್ಯಾಕಪ್, ಆಂಟಿವೈರಸ್, CCTV. ಏನೂ ಇಲ್ಲದಿದ್ದರೆ "ಏನೂ ಇಲ್ಲ" ಎಂದು ಬರೆಯಿರಿ.',
    score: "ನಿಮ್ಮ ಡಿಜಿಟಲ್-ಸಿದ್ಧತೆ ಸ್ಕೋರ್: {score}/100.",
    fullScore: "ನಿಮ್ಮ ವ್ಯಾಪಾರಕ್ಕೆ ಮುಖ್ಯವಾದ ಎಲ್ಲವೂ ಈಗಾಗಲೇ ನಿಮ್ಮಲ್ಲಿದೆ.",
    gaps: "ದೊಡ್ಡ ಕೊರತೆಗಳು: {gaps}.",
    pathIntro: "ಸ್ಕೋರ್ ಹೀಗೆ ಹೆಚ್ಚುತ್ತದೆ:",
    pathStep: "• {product} ಸೇರಿಸಿ → {score}/100",
    pathCondition: " ({condition})",
    pathUnavailable: "• {gap}: {reason}",
    noBetterProduct: "ನಿಮ್ಮ ವ್ಯಾಪಾರಕ್ಕೆ ಇದನ್ನು ಉತ್ತಮಗೊಳಿಸುವ Accel ಉತ್ಪನ್ನ ಇಲ್ಲ",
    segmentAssumed:
      "(ಸಾಮಾನ್ಯ ಸಣ್ಣ ವ್ಯಾಪಾರವೆಂದು ಸ್ಕೋರ್ ಮಾಡಲಾಗಿದೆ. ನಿಮ್ಮ ವ್ಯಾಪಾರದ ಪ್ರಕಾರ ತಿಳಿಸಿದರೆ ಸ್ಕೋರ್ ಇನ್ನಷ್ಟು ನಿಖರವಾಗುತ್ತದೆ.)",
    unrecognised: "ಇವು ನನಗೆ ಅರ್ಥವಾಗಲಿಲ್ಲ: {items}.",
    labels: {
      reliable_internet: "ಬಿಸಿನೆಸ್ ದರ್ಜೆಯ ಇಂಟರ್ನೆಟ್",
      backup_internet: "ಬ್ಯಾಕಪ್ ಇಂಟರ್ನೆಟ್",
      business_lines: "ಬಿಸಿನೆಸ್ ಸಿಮ್",
      customer_messaging: "ಗ್ರಾಹಕರಿಗೆ WhatsApp/SMS",
      billing_payments: "ಬಿಲ್ಲಿಂಗ್/POS",
      online_presence: "ವೆಬ್‌ಸೈಟ್",
      cloud_email: "ಬಿಸಿನೆಸ್ ಇಮೇಲ್",
      cloud_backup: "ಕ್ಲೌಡ್ ಬ್ಯಾಕಪ್",
      data_security: "ಡೇಟಾ ಸುರಕ್ಷತೆ",
      cctv: "CCTV",
      central_management: "ಕೇಂದ್ರೀಕೃತ ನೆಟ್‌ವರ್ಕ್ ನಿರ್ವಹಣೆ",
      machine_iot: "ಯಂತ್ರ ಮೇಲ್ವಿಚಾರಣೆ",
      voice: "ಬಿಸಿನೆಸ್ ಕರೆಗಳು",
    },
    conditions: { gstin: "ಸಕ್ರಿಯ GSTIN ಬೇಕು", staff: "{count}+ ಸಿಬ್ಬಂದಿ ಬೇಕು", sites: "{count}+ ಸ್ಥಳಗಳು ಬೇಕು" },
  },
};

// ================================================================ LOGIC: inputs and outputs

function createEmptyOutputs() {
  return {
    next_action: "",
    readiness_score: 0,
    segment_used: "",
    segment_assumed: false,
    recognised_products: "",
    unrecognised_items: "",
    top_gaps: "",
    gaps_json: "[]",
    add_ons_json: "[]",
    add_on_path_text: "",
    score_after_add_ons: 0,
    suggested_needs: "",
    message: "",
    error: "",
  };
}

/** Shows the message in the chat unless show_card = "no". */
function respond(outputVars, inputVars) {
  const shouldShow = String(inputVars.show_card || "yes").toLowerCase() !== "no";
  return {
    outputVars,
    trace: shouldShow && outputVars.message ? [{ type: "text", payload: { message: outputVars.message } }] : [],
  };
}

function detectLanguage(languageInput) {
  const value = String(languageInput || "").trim();
  if (/^(hi|hindi|हिंदी|hinglish)/i.test(value)) return "hi";
  if (/^(kn|kannada|ಕನ್ನಡ)/i.test(value)) return "kn";
  return "en";
}

function fillTemplate(template, values) {
  return Object.keys(values).reduce((text, key) => text.split("{" + key + "}").join(values[key]), template);
}

function toPaddedText(text) {
  return (
    " " +
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\-& ]/g, " ")
      .replace(/\s+/g, " ")
      .trim() +
    " "
  );
}

function containsAnyWord(text, words) {
  const paddedText = toPaddedText(text);
  return words.some((word) => paddedText.indexOf(" " + word + " ") >= 0);
}

function capabilityLabel(capability, language) {
  return MESSAGES[language].labels[capability];
}

/** Optional number from free text; null when not given. */
function parseOptionalCount(value) {
  const match = String(value === undefined || value === null ? "" : value).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// ================================================================ LOGIC: scoring

/** "home broadband, 2 SIMs\nUPI" → ["home broadband", "2 SIMs", "UPI"]; "none" → ["none"]. Empty → []. */
function splitProducts(productsInput) {
  return String(productsInput || "")
    .split(PRODUCT_SEPARATOR_PATTERN)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Segment from a code, an onboarding category, a case segment name or a business word; "general" if unknown. */
function chooseSegment(segmentInput, sitesInput) {
  const segmentText = String(segmentInput || "").toLowerCase();
  const siteCount = parseOptionalCount(sitesInput);
  for (const segment of Object.keys(SEGMENT_WORDS)) {
    if (SEGMENT_WORDS[segment].some((word) => segmentText.indexOf(word) >= 0)) {
      const isMultiSite = siteCount !== null && siteCount >= SITES_FOR_MULTI_SITE && segment === "micro";
      return { segment: isMultiSite ? "multi" : segment, wasAssumed: false };
    }
  }
  if (siteCount !== null && siteCount >= SITES_FOR_MULTI_SITE) return { segment: "multi", wasAssumed: false };
  return { segment: "general", wasAssumed: true };
}

/**
 * Matches each product the owner named to capabilities and keeps the best credit per capability.
 * Returns { creditByCapability, recognised: ["home broadband → reliable_internet 50%"], unrecognised: [...] }.
 */
function recogniseProducts(productItems, segment) {
  const creditByCapability = {};
  const recognised = [];
  const unrecognised = [];
  const saysNothing = productItems.every((item) => NOTHING_WORDS.indexOf(item.toLowerCase()) >= 0);
  if (saysNothing) return { creditByCapability, recognised, unrecognised };

  productItems.forEach((item) => {
    const matchedCapabilities = [];
    Object.keys(READINESS_RULES.capabilities).forEach((capability) => {
      const rule = READINESS_RULES.capabilities[capability];
      const level = rule.levels.find((candidate) => containsAnyWord(item, candidate.words));
      if (!level) return;
      matchedCapabilities.push({ capability, rule, level });
    });
    const matchedNames = matchedCapabilities.map((match) => match.capability);
    const usableMatches = matchedCapabilities.filter(
      (match) => !(match.rule.notWhenAlsoMatched || []).some((other) => matchedNames.indexOf(other) >= 0),
    );
    if (usableMatches.length === 0) {
      unrecognised.push(item);
      return;
    }
    usableMatches.forEach(({ capability, level }) => {
      const credit =
        level.creditBySegment && level.creditBySegment[segment] !== undefined
          ? level.creditBySegment[segment]
          : level.credit;
      creditByCapability[capability] = Math.max(creditByCapability[capability] || 0, credit);
      recognised.push(item + " → " + capability + " " + Math.round(credit * 100) + "%");
    });
  });
  return { creditByCapability, recognised, unrecognised };
}

/** Score = Σ weight × credit over the segment's capabilities, rounded, 0–100. */
function computeScore(weights, creditByCapability) {
  const total = Object.keys(weights).reduce(
    (sum, capability) => sum + weights[capability] * (creditByCapability[capability] || 0),
    0,
  );
  return Math.min(MAX_SCORE, Math.round(total));
}

/** Capabilities losing the most points (weight × missing credit), biggest first; ties keep config order. */
function findTopGaps(weights, creditByCapability) {
  return Object.keys(weights)
    .map((capability) => ({
      capability,
      weight: weights[capability],
      points_missing: Math.round(weights[capability] * (1 - (creditByCapability[capability] || 0)) * 10) / 10,
    }))
    .filter((gap) => gap.points_missing > 0)
    .sort((first, second) => second.points_missing - first.points_missing)
    .slice(0, TOP_GAP_COUNT);
}

// ================================================================ LOGIC: add-on suggestions

/** has_gstin (true/false/null = unknown), staff count and site count, as known. Unknown facts become conditions. */
function readBusinessFacts(inputVars) {
  const gstinAnswer = String(inputVars.has_gstin || "")
    .trim()
    .toLowerCase();
  return {
    hasGstin: /^(y|yes|true|1|active|haan|हाँ|ಹೌದು)/.test(gstinAnswer)
      ? true
      : /^(n|no|false|0|nahi|नहीं|ಇಲ್ಲ)/.test(gstinAnswer)
        ? false
        : null,
    staffCount: parseOptionalCount(inputVars.staff_count),
    siteCount: parseOptionalCount(inputVars.sites),
  };
}

/**
 * Checks a product against the catalogue's eligibility rules. Returns { isEligible, conditions, reasons }:
 * known facts that fail → reasons (not eligible); unknown facts → conditions (eligible if true).
 */
function checkEligibility(productId, facts) {
  const rule = PRODUCT_RULES[productId];
  const conditions = [];
  const reasons = [];
  if (rule.requiresGstin) {
    if (facts.hasGstin === false) reasons.push({ key: "gstin" });
    else if (facts.hasGstin === null) conditions.push({ key: "gstin" });
  }
  if (rule.minimumEmployees > 1) {
    if (facts.staffCount === null) conditions.push({ key: "staff", count: rule.minimumEmployees });
    else if (facts.staffCount < rule.minimumEmployees) reasons.push({ key: "staff", count: rule.minimumEmployees });
  }
  if (rule.minimumSites > 1) {
    if (facts.siteCount === null) conditions.push({ key: "sites", count: rule.minimumSites });
    else if (facts.siteCount < rule.minimumSites) reasons.push({ key: "sites", count: rule.minimumSites });
  }
  return { isEligible: reasons.length === 0, conditions, reasons };
}

function addOnCandidates(capability, segment) {
  const rule = READINESS_RULES.capabilities[capability];
  return rule.addOnsBySegment ? rule.addOnsBySegment[segment] || rule.addOnsBySegment.general : rule.addOns;
}

/** Credit a product earns for a capability once added: 1 unless addOnCredits lists a partial value. */
function addOnCredit(capability, productId, segment) {
  const partial = (READINESS_RULES.capabilities[capability].addOnCredits || {})[productId];
  if (!partial) return 1;
  if (partial[segment] !== undefined) return partial[segment];
  return partial.default !== undefined ? partial.default : 1;
}

/**
 * For each top gap, the first add-on in preference order that the business is eligible for and that actually raises
 * the capability's credit. Unknown facts (GSTIN, staff, sites) don't change the choice: they are stated as
 * conditions. Scores are cumulative: step 2's score includes step 1's add-on. Gaps nothing can improve are listed as
 * unavailable, with the reason.
 */
function planAddOns(gaps, weights, creditByCapability, segment, facts) {
  const creditsAfter = Object.assign({}, creditByCapability);
  return gaps.map((gap, index) => {
    const currentCredit = creditsAfter[gap.capability] || 0;
    const improving = addOnCandidates(gap.capability, segment)
      .map((productId) => ({
        productId,
        credit: addOnCredit(gap.capability, productId, segment),
        eligibility: checkEligibility(productId, facts),
      }))
      .filter((candidate) => candidate.credit > currentCredit);
    const choice = improving.find((candidate) => candidate.eligibility.isEligible);
    if (!choice) {
      return {
        step: index + 1,
        capability: gap.capability,
        available: false,
        product_id: "",
        product_name: "",
        conditions: [],
        reasons: improving[0] ? improving[0].eligibility.reasons : [],
        new_score: computeScore(weights, creditsAfter),
      };
    }
    creditsAfter[gap.capability] = choice.credit;
    return {
      step: index + 1,
      capability: gap.capability,
      available: true,
      product_id: choice.productId,
      product_name: PRODUCT_RULES[choice.productId].name,
      conditions: choice.eligibility.conditions,
      reasons: [],
      new_score: computeScore(weights, creditsAfter),
    };
  });
}

function describeConditions(conditionList, language) {
  return conditionList
    .map((condition) => fillTemplate(MESSAGES[language].conditions[condition.key], { count: condition.count }))
    .join(", ");
}

function describeAddOnPath(addOnPath, language) {
  const text = MESSAGES[language];
  return addOnPath
    .map((step) =>
      step.available
        ? fillTemplate(text.pathStep, { product: step.product_name, score: step.new_score }) +
          (step.conditions.length
            ? fillTemplate(text.pathCondition, { condition: describeConditions(step.conditions, language) })
            : "")
        : fillTemplate(text.pathUnavailable, {
            gap: capabilityLabel(step.capability, language),
            reason: step.reasons.length ? describeConditions(step.reasons, language) : text.noBetterProduct,
          }),
    )
    .join("\n");
}

function writeMessage(outputVars, gaps, segmentChoice, language) {
  const text = MESSAGES[language];
  const parts = [fillTemplate(text.score, { score: outputVars.readiness_score })];
  if (gaps.length === 0) {
    parts.push(text.fullScore);
  } else {
    parts.push(
      fillTemplate(text.gaps, { gaps: gaps.map((gap) => capabilityLabel(gap.capability, language)).join(", ") }),
    );
    parts.push(text.pathIntro);
    parts.push(outputVars.add_on_path_text);
  }
  if (outputVars.unrecognised_items)
    parts.push(fillTemplate(text.unrecognised, { items: outputVars.unrecognised_items }));
  if (segmentChoice.wasAssumed) parts.push(text.segmentAssumed);
  return parts.join("\n");
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/**
 * Eligibility rules from product_catalogue.csv (case pack, synthetic), keyed by product ID:
 * { name, requiresGstin, minimumEmployees, minimumSites }.
 */
const PRODUCT_RULES = {"P01":{"name":"Biz Fibre 100","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P02":{"name":"Biz Fibre 300","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P03":{"name":"Biz Fibre 1G","requiresGstin":true,"minimumEmployees":5,"minimumSites":1},"P04":{"name":"Biz 5G AirFiber 100","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P05":{"name":"Internet Leased Line 20","requiresGstin":true,"minimumEmployees":10,"minimumSites":1},"P06":{"name":"Internet Leased Line 100","requiresGstin":true,"minimumEmployees":25,"minimumSites":1},"P07":{"name":"Business Postpaid 299","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P08":{"name":"Business Postpaid 599","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P09":{"name":"Backup 4G/5G Failover","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P10":{"name":"Managed SD-WAN","requiresGstin":true,"minimumEmployees":10,"minimumSites":3},"P11":{"name":"Static IP","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P12":{"name":"Cloud Telephony / SIP","requiresGstin":true,"minimumEmployees":3,"minimumSites":1},"P13":{"name":"Toll-free Number","requiresGstin":true,"minimumEmployees":1,"minimumSites":1},"P14":{"name":"Business SMS 10k","requiresGstin":true,"minimumEmployees":1,"minimumSites":1},"P15":{"name":"WhatsApp Business API Starter","requiresGstin":true,"minimumEmployees":1,"minimumSites":1},"P16":{"name":"Cloud Email & Office Suite","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P17":{"name":"Cloud Backup 1 TB","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P18":{"name":"Website + Domain Starter","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P19":{"name":"Cloud POS & Billing","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P20":{"name":"Endpoint Security","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P21":{"name":"Managed Firewall","requiresGstin":true,"minimumEmployees":10,"minimumSites":1},"P22":{"name":"Secure Wi-Fi with Guest Network","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P23":{"name":"Cloud CCTV","requiresGstin":false,"minimumEmployees":1,"minimumSites":1},"P24":{"name":"Machine Monitoring IoT","requiresGstin":true,"minimumEmployees":10,"minimumSites":1},"P25":{"name":"Fleet Tracker","requiresGstin":false,"minimumEmployees":1,"minimumSites":1}};
