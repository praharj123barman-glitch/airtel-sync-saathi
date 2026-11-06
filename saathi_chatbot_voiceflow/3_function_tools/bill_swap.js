/*
 * bill_swap.js: Voiceflow function tool "bill_swap" (TEMPLATE; the build injects product descriptions from the
 * catalogue and the pricing function).
 *
 * What it does: "bill-swap calculator". The owner types the monthly bills they pay today (category, vendor,
 * amount). The function reads them, prices the MATCHING Accel bundle by calling the real pricing function
 * (price_bundle, embedded unchanged by the build) and compares like for like: monthly and yearly savings, or, if
 * Accel costs more, says so plainly and shows what the extra money buys.
 *
 * How it fits: the onboarding and advisor playbooks offer "Compare with my bills" right after a bundle proposal.
 * The case found 54% of activated customers got none of the products they asked about; pricing exactly what the
 * owner already pays for makes the comparison honest and easy to check.
 *
 * Honesty rules built in:
 *   - Every Accel price comes from price_bundle. Nothing is priced here.
 *   - Only bills Accel can replace are compared. Other bills (electricity, rent, software Accel doesn't sell) are
 *     listed as "not compared" and kept out of the totals.
 *   - Amounts that can't be read, or look implausible, are never guessed. They are listed for the owner to confirm.
 *   - Quantities the owner didn't state (lines, email users, cameras) are reported in `assumptions`.
 */

/**
 * Voiceflow entry point: compares today's bills with the matching Accel bundle.
 *
 * @param {{inputVars?: {bills?: string, business_context_json?: string, business_type?: string, segment?: string,
 *   city?: string, employees?: string, sites?: string, has_gstin?: string, lang?: string, show_card?: string}}} args
 *   bills: one bill per line as "category | vendor | monthly amount" (lines may also be separated by ";"), or a JSON
 *   array of {category, vendor, amount}. business_context_json: the pricing_inputs_json from onboard_from_gstin
 *   (optional); single fields override it.
 * @returns {{outputVars: Object, trace: Array}}  Every declared output, always; `error` on failure.
 * @example
 *   await main({ inputVars: { bills: "Broadband | Local ISP | ₹2,500\nMobile | Jio | 3 x 799", segment: "prof",
 *     city: "Delhi", employees: "14", has_gstin: "yes" } })
 *   // → current_monthly_total 4897, accel_monthly_total from price_bundle, monthly_saving > 0
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const language = detectLanguage(inputVars.lang);
  const text = MESSAGES[language];
  const outputVars = createEmptyOutputs();
  try {
    const bills = parseBills(inputVars.bills);
    const readableBills = bills.filter((bill) => bill.problem === "");
    outputVars.bills_read = readableBills.length;
    outputVars.unreadable_lines = bills
      .filter((bill) => bill.problem !== "")
      .map((bill) => bill.originalText + " (" + bill.problem + ")")
      .join("; ");
    outputVars.needs_confirmation = outputVars.unreadable_lines !== "";

    const telecomBills = readableBills.filter((bill) => bill.categoryId !== NOT_TELECOM);
    const otherBills = readableBills.filter((bill) => bill.categoryId === NOT_TELECOM);
    if (telecomBills.length === 0) {
      outputVars.next_action = NEXT_ACTION.ASK_BILLS;
      outputVars.not_compared_text = describeBills(otherBills, text.notSoldByAccel);
      outputVars.message =
        bills.length === 0
          ? text.askForBills
          : readableBills.length === 0
            ? fillTemplate(text.confirmNote, { items: outputVars.unreadable_lines })
            : text.nothingToCompare;
      return respond(outputVars, inputVars);
    }

    const context = readBusinessContext(inputVars);
    const pricing = buildPricingRequest(telecomBills, context, language);
    const quote = (await priceBundleMain({ inputVars: pricing.inputs })).outputVars;
    if (quote.error) throw new Error(quote.error);

    const comparison = compareWithQuote(telecomBills, quote);
    const notCompared = otherBills
      .map((bill) => ({ bill, reason: text.notSoldByAccel }))
      .concat(comparison.unmatchedBills.map((bill) => ({ bill, reason: comparison.reasonByBill.get(bill) })));

    outputVars.next_action = comparison.matchedBills.length ? NEXT_ACTION.SHOW_COMPARISON : NEXT_ACTION.ASK_BILLS;
    outputVars.pricing_inputs_json = JSON.stringify(pricing.inputs);
    outputVars.assumptions = pricing.assumptions.join("; ");
    outputVars.accel_bundle_name = quote.bundle_name;
    outputVars.accel_monthly_total = quote.monthly_total;
    outputVars.accel_setup_total = quote.setup_total;
    outputVars.accel_items_json = quote.items_json;
    outputVars.accel_quote_text = quote.quote_text;
    outputVars.current_monthly_total = sumAmounts(comparison.matchedBills);
    outputVars.not_compared_monthly_total = sumAmounts(notCompared.map((entry) => entry.bill));
    outputVars.not_compared_text = notCompared
      .map((entry) => entry.bill.label + " " + formatRupees(entry.bill.monthlyAmount) + " (" + entry.reason + ")")
      .join("; ");
    outputVars.comparison_text = comparison.lines.join("\n");
    outputVars.monthly_saving = outputVars.current_monthly_total - outputVars.accel_monthly_total;
    outputVars.yearly_saving = outputVars.monthly_saving * MONTHS_PER_YEAR;
    outputVars.first_year_saving = outputVars.yearly_saving - outputVars.accel_setup_total;
    outputVars.is_accel_cheaper = outputVars.monthly_saving > 0;
    outputVars.extra_value_text = describeExtraValue(comparison, quote, language);
    outputVars.message =
      comparison.matchedBills.length === 0 ? text.nothingToCompare : writeMessage(outputVars, language);
    return respond(outputVars, inputVars);
  } catch (error) {
    outputVars.error = ERROR_PREFIX + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG

const NEXT_ACTION = { SHOW_COMPARISON: "show_comparison", ASK_BILLS: "ask_bills" };
const NOT_TELECOM = "not_telecom";

/**
 * Bill categories, checked in this order (specific before general). Each maps to what the pricing function
 * needs: a `need` keyword for price_bundle (null = part of every bundle), the Accel product IDs that replace it,
 * and which price_bundle quantity input a stated count fills (e.g. "3 SIMs" → lines = 3).
 */
const BILL_CATEGORIES = [
  {
    id: NOT_TELECOM,
    label: "Not telecom",
    words: ["electricity", "power", "rent", "salary", "water", "gas", "tally", "accounting", "insurance", "loan"],
    need: null,
    productIds: [],
  },
  {
    id: "leased_line",
    label: "Leased line",
    words: ["leased line", "leased", "dedicated internet", "ill"],
    need: "leased",
    productIds: ["P05", "P06"],
  },
  {
    id: "failover",
    label: "Backup internet",
    words: ["backup internet", "backup connection", "failover", "4g router", "second connection"],
    need: "failover",
    productIds: ["P09"],
  },
  {
    id: "toll_free",
    label: "Toll-free number",
    words: ["toll free", "toll-free", "tollfree", "1800"],
    need: "tollfree",
    productIds: ["P13"],
  },
  {
    id: "telephony",
    label: "Cloud telephony / IVR",
    words: ["ivr", "cloud telephony", "telephony", "call centre", "call center", "landline", "exotel", "knowlarity"],
    need: "telephony",
    productIds: ["P12"],
  },
  {
    id: "whatsapp",
    label: "WhatsApp Business",
    words: ["whatsapp", "wati", "interakt", "aisensy"],
    need: "whatsapp",
    productIds: ["P15"],
  },
  { id: "sms", label: "Business SMS", words: ["bulk sms", "sms"], need: "sms", productIds: ["P14"] },
  {
    id: "email",
    label: "Business email",
    words: ["google workspace", "g suite", "gsuite", "microsoft 365", "office 365", "zoho mail", "email", "e-mail"],
    need: "email",
    productIds: ["P16"],
    countInput: "email_users",
  },
  {
    id: "storage",
    label: "Cloud backup / storage",
    words: ["cloud storage", "cloud backup", "google drive", "onedrive", "dropbox", "backup", "storage"],
    need: "storage",
    productIds: ["P17"],
  },
  {
    id: "security",
    label: "Antivirus / security",
    words: ["antivirus", "anti-virus", "endpoint", "quick heal", "norton", "kaspersky", "security"],
    need: "security",
    productIds: ["P20"],
  },
  { id: "firewall", label: "Firewall", words: ["firewall"], need: "firewall", productIds: ["P21"] },
  {
    id: "pos",
    label: "POS / billing software",
    words: ["pos", "point of sale", "billing software", "petpooja", "billing"],
    need: "pos",
    productIds: ["P19"],
    countInput: "counters",
  },
  {
    id: "cctv",
    label: "CCTV",
    words: ["cctv", "camera", "cameras", "surveillance", "dvr"],
    need: "cctv",
    productIds: ["P23"],
    countInput: "cameras",
  },
  {
    id: "website",
    label: "Website / domain",
    words: ["website", "domain", "hosting", "godaddy"],
    need: "website",
    productIds: ["P18"],
  },
  {
    id: "iot",
    label: "Machine monitoring",
    words: ["machine monitoring", "iot", "sensors"],
    need: "iot",
    productIds: ["P24"],
    countInput: "machines",
  },
  {
    id: "fleet",
    label: "Vehicle tracking",
    words: ["vehicle tracking", "fleet", "gps"],
    need: "fleet",
    productIds: ["P25"],
    countInput: "vehicles",
  },
  { id: "sd_wan", label: "SD-WAN / MPLS", words: ["sd-wan", "sdwan", "mpls"], need: "sdwan", productIds: ["P10"] },
  // Before "mobile": a "mobile hotspot" or "data card" bill is the shop's internet connection, not a phone line.
  // Any connection Accel offers can replace it (a factory's broadband may be replaced by a leased line).
  {
    id: "internet",
    label: "Internet / broadband",
    words: ["broadband", "internet", "wifi", "wi-fi", "fibre", "fiber", "hotspot", "data card", "dongle", "airfiber"],
    need: null,
    productIds: ["P01", "P02", "P03", "P04", "P05", "P06"],
  },
  {
    id: "mobile",
    label: "Mobile / SIMs",
    words: ["mobile", "sim", "sims", "postpaid", "prepaid", "phone", "recharge", "jio", "vi", "bsnl"],
    need: null,
    productIds: ["P07", "P08"],
    countInput: "lines",
  },
];

/**
 * Optional items price_bundle adds by default for some segments. For a like-for-like price they are removed
 * unless the owner already pays for that category. (Connection is always included: a bundle needs one.)
 */
const REMOVABLE_DEFAULT_PRODUCT_BY_CATEGORY = {
  failover: "P09",
  email: "P16",
  security: "P20",
  storage: "P17",
  firewall: "P21",
  pos: "P19",
  toll_free: "P13",
  mobile: "P07, P08",
};
/** Secure Wi-Fi has no bill category of its own (it comes with the router), so it is always removed. */
const ALWAYS_REMOVED_FOR_LIKE_FOR_LIKE = ["P22"];

/**
 * A single business telecom bill above this is almost certainly a typo or a yearly figure: the biggest activated
 * bundle in smb_leads.csv was ₹72,950/month. Such lines are flagged for confirmation, never used.
 */
const MAX_PLAUSIBLE_MONTHLY_BILL_IN_RUPEES = 100000;
const MONTHS_PER_YEAR = 12;
const RUPEES_PER_THOUSAND = 1000;
const RUPEES_PER_LAKH = 100000;
/** Words that mark an amount as yearly; it is divided by 12 and reported in `assumptions`. */
const YEARLY_WORDS = ["per year", "/year", "a year", "yearly", "annual", "annually", "p.a", "/yr"];
/** Words that make an amount "per unit", so it is multiplied by the stated count ("₹125 per user, 10 users"). */
const PER_UNIT_WORDS = ["per user", "per line", "per sim", "per camera", "per counter", "each", "/user", "/line"];
/** Words that name a quantity: a number right before one ("3 SIMs", "10 users", "4 cameras") is never money. */
const COUNT_UNIT_SOURCE =
  "users?|seats?|lines?|sims?|connections?|cameras?|counters?|vehicles?|machines?|sensors?|channels?";
/** "3 SIMs", "10 users", "4 cameras" anywhere in a bill line → a stated quantity. */
const COUNT_PATTERN = new RegExp("(\\d+)\\s*(" + COUNT_UNIT_SOURCE + ")\\b", "i");
/** The same quantity words, right after a number. */
const COUNT_UNIT_AFTER_NUMBER = new RegExp("^\\s*(?:" + COUNT_UNIT_SOURCE + ")\\b");
/** A number in a bill line: digits with Indian or Western comma grouping and optional decimals ("1,29,900.50"). */
const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g;
/** Money marks: "₹799", "Rs 799", "Rs. 799", "INR 799" before the number, or "799 rupees", "799 INR", "799/-" after. */
const CURRENCY_BEFORE_NUMBER = /(?:₹|\brs\.?|\binr)\s*$/;
const CURRENCY_AFTER_NUMBER = /^\s*(?:\/-|rs\b\.?|inr\b|rupees?\b)/;
/** "1.2k", "1.5 lakh": a multiplier written after the number. */
const MULTIPLIER_AFTER_NUMBER = /^\s*(k|lakhs?|lacs?)\b/;
/**
 * Units that make a number something other than money: a share ("18% GST"), a speed or data size ("100 Mbps",
 * "50 GB") or a time ("12 months"). Found reading bills like "₹999 for 100 Mbps", which was read as ₹100.
 */
const NON_MONEY_UNIT_AFTER_NUMBER =
  /^\s*(?:%|percent\b|[kmg]bps\b|[kmgt]b\b|months?\b|mos?\b|days?\b|years?\b|yrs?\b|hours?\b|hrs?\b|mins?\b|minutes?\b)/;
/** A letter stuck to a number ("5G", "4G", "P07") makes it a name, not an amount. "x" is the multiplication sign. */
const LETTER_STUCK_AFTER = /^[a-wyz]/;
const LETTER_STUCK_BEFORE = /[a-wyz]$/;
/** "3 x 799", "₹799 × 3", "3*799" and "3 lines at 799", "3 @ ₹799": two numbers that multiply. */
const MULTIPLY_SIGN_GAP = /^\s*[x×*]\s*$/;
const AT_PRICE_GAP = /^\s*(?:at|@)\s*$/;
/**
 * Largest quantity read from a bill line: the biggest team in smb_leads.csv has 150 staff, so no case business needs
 * more lines, users or cameras than that. A bigger "quantity" is asked about, never used.
 */
const MAX_STATED_QUANTITY = 150;
/**
 * In "A x B" with no ₹ or unit word, the quantity is the number under this and the price the number at or above it.
 * Design choice: the cheapest monthly price in product_catalogue.csv is ₹99 (P20 Endpoint Security), and half of that
 * leaves room for cheaper plans. When both numbers are on the same side ("120 x 100"), the owner is asked.
 */
const MIN_UNIT_PRICE_IN_RUPEES = 50;
const TOKEN_KIND = { MONEY: "money", COUNT: "count", OTHER: "other" };
const ROLE = { COUNT: "count", PRICE: "price", UNMARKED: "unmarked" };
const FIELD_SEPARATOR = "|";
const BILL_SEPARATOR_PATTERN = /\n|;/;
const ERROR_PREFIX = "bill_swap failed: ";

// ================================================================ MESSAGES (all user-facing text)
// Kannada text was written for this prototype; have a native speaker review it before going live.

const MESSAGES = {
  en: {
    askForBills:
      "Tell me what you pay each month today, one bill per line: what it is, who you pay, and the amount. For example: Broadband | Local ISP | ₹1,200",
    nothingToCompare:
      "None of these are things Accel sells, so there's nothing to compare. Share your internet, mobile, email or CCTV bills and I'll compare them.",
    notSoldByAccel: "Accel doesn't sell this",
    cheaper:
      "Today you pay {current}/month for these. Accel {bundle} costs {accel}/month on one bill.\nYou save {saving}/month, about {yearly}/year.",
    cheaperWithSetup: "After the one-time setup of {setup}, year one still saves {firstYear}.",
    setupEatsFirstYear:
      "The one-time setup of {setup} means year one costs {firstYearCost} more; you save from year two.",
    samePrice: "Today you pay {current}/month for these. Accel {bundle} costs the same, {accel}/month, on one bill.",
    moreExpensive:
      "To be honest: Accel {bundle} costs {accel}/month, which is {difference} more than the {current}/month you pay today.\nWhat the extra buys:",
    notComparedNote: "Not compared (kept out of the totals): {items}.",
    confirmNote: "Please check these, I couldn't use them: {items}.",
    oneBill: "One bill and one support number for everything",
    youDontPayToday: "you don't pay for this today",
  },
  hi: {
    askForBills:
      "आज आप हर महीने क्या-क्या भरते हैं, एक लाइन में एक बिल लिखिए: क्या है, किसे देते हैं, और कितना। जैसे: ब्रॉडबैंड | लोकल ISP | ₹1,200",
    nothingToCompare:
      "इनमें से कोई भी चीज़ Accel नहीं बेचता, इसलिए तुलना नहीं हो सकती। इंटरनेट, मोबाइल, ईमेल या CCTV के बिल बताइए, मैं तुलना करता हूँ।",
    notSoldByAccel: "Accel यह नहीं बेचता",
    cheaper:
      "आज आप इनके लिए {current}/माह देते हैं। Accel {bundle} एक ही बिल पर {accel}/माह है।\nआपकी बचत {saving}/माह, यानी लगभग {yearly}/साल।",
    cheaperWithSetup: "एक बार के सेटअप {setup} के बाद भी पहले साल में {firstYear} की बचत।",
    setupEatsFirstYear: "एक बार के सेटअप {setup} की वजह से पहला साल {firstYearCost} महँगा पड़ेगा; बचत दूसरे साल से।",
    samePrice: "आज आप इनके लिए {current}/माह देते हैं। Accel {bundle} भी {accel}/माह ही है, एक ही बिल पर।",
    moreExpensive:
      "सच बताऊँ: Accel {bundle} {accel}/माह का है, जो आज के {current}/माह से {difference} ज़्यादा है।\nइस अतिरिक्त पैसे में आपको मिलता है:",
    notComparedNote: "तुलना में शामिल नहीं (कुल में नहीं जोड़ा): {items}.",
    confirmNote: "इन्हें एक बार जाँच लीजिए, मैं इनका इस्तेमाल नहीं कर पाया: {items}.",
    oneBill: "सब कुछ एक बिल और एक सपोर्ट नंबर पर",
    youDontPayToday: "यह आज आप नहीं लेते",
  },
  kn: {
    askForBills:
      "ಇಂದು ನೀವು ಪ್ರತಿ ತಿಂಗಳು ಏನೇನು ಪಾವತಿಸುತ್ತೀರಿ ಎಂದು ಒಂದು ಸಾಲಿಗೆ ಒಂದು ಬಿಲ್ ಬರೆಯಿರಿ: ಏನು, ಯಾರಿಗೆ, ಎಷ್ಟು. ಉದಾ: ಬ್ರಾಡ್‌ಬ್ಯಾಂಡ್ | ಲೋಕಲ್ ISP | ₹1,200",
    nothingToCompare:
      "ಇವುಗಳಲ್ಲಿ ಯಾವುದನ್ನೂ Accel ಮಾರಾಟ ಮಾಡುವುದಿಲ್ಲ, ಆದ್ದರಿಂದ ಹೋಲಿಕೆ ಸಾಧ್ಯವಿಲ್ಲ. ಇಂಟರ್ನೆಟ್, ಮೊಬೈಲ್, ಇಮೇಲ್ ಅಥವಾ CCTV ಬಿಲ್‌ಗಳನ್ನು ತಿಳಿಸಿ.",
    notSoldByAccel: "Accel ಇದನ್ನು ಮಾರಾಟ ಮಾಡುವುದಿಲ್ಲ",
    cheaper:
      "ಇಂದು ನೀವು ಇವುಗಳಿಗೆ ತಿಂಗಳಿಗೆ {current} ಪಾವತಿಸುತ್ತೀರಿ. Accel {bundle} ಒಂದೇ ಬಿಲ್‌ನಲ್ಲಿ ತಿಂಗಳಿಗೆ {accel}.\nನಿಮ್ಮ ಉಳಿತಾಯ ತಿಂಗಳಿಗೆ {saving}, ವರ್ಷಕ್ಕೆ ಸುಮಾರು {yearly}.",
    cheaperWithSetup: "ಒಂದು ಬಾರಿಯ ಸೆಟಪ್ {setup} ನಂತರವೂ ಮೊದಲ ವರ್ಷ {firstYear} ಉಳಿತಾಯ.",
    setupEatsFirstYear: "ಒಂದು ಬಾರಿಯ ಸೆಟಪ್ {setup} ಕಾರಣ ಮೊದಲ ವರ್ಷ {firstYearCost} ಹೆಚ್ಚು; ಎರಡನೇ ವರ್ಷದಿಂದ ಉಳಿತಾಯ.",
    samePrice:
      "ಇಂದು ನೀವು ಇವುಗಳಿಗೆ ತಿಂಗಳಿಗೆ {current} ಪಾವತಿಸುತ್ತೀರಿ. Accel {bundle} ಕೂಡ ತಿಂಗಳಿಗೆ {accel}, ಒಂದೇ ಬಿಲ್‌ನಲ್ಲಿ.",
    moreExpensive:
      "ನೇರವಾಗಿ ಹೇಳಬೇಕೆಂದರೆ: Accel {bundle} ತಿಂಗಳಿಗೆ {accel}, ಇದು ಇಂದಿನ {current} ಗಿಂತ {difference} ಹೆಚ್ಚು.\nಈ ಹೆಚ್ಚುವರಿ ಹಣಕ್ಕೆ ನಿಮಗೆ ಸಿಗುವುದು:",
    notComparedNote: "ಹೋಲಿಕೆಯಲ್ಲಿ ಸೇರಿಸಿಲ್ಲ (ಮೊತ್ತದಲ್ಲಿ ಇಲ್ಲ): {items}.",
    confirmNote: "ದಯವಿಟ್ಟು ಇವುಗಳನ್ನು ಪರಿಶೀಲಿಸಿ, ನಾನು ಬಳಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ: {items}.",
    oneBill: "ಎಲ್ಲದಕ್ಕೂ ಒಂದೇ ಬಿಲ್ ಮತ್ತು ಒಂದೇ ಸಪೋರ್ಟ್ ನಂಬರ್",
    youDontPayToday: "ಇದಕ್ಕೆ ನೀವು ಇಂದು ಪಾವತಿಸುತ್ತಿಲ್ಲ",
  },
  /** Reasons a bill line can't be used. Shown inside the confirm note (English; the agent may translate). */
  problems: {
    noAmount: "no amount found",
    notPositive: "amount must be more than zero",
    implausible: "over ₹1,00,000 a month: please confirm",
    unclearQuantity: "which number is the quantity? Please write it like 3 x ₹799",
    perUnitNoCount: "how many? Please write it like 3 x ₹799",
    severalAmounts: "more than one amount: which one is the monthly bill?",
  },
};

// ================================================================ LOGIC: inputs and outputs

function createEmptyOutputs() {
  return {
    next_action: "",
    bills_read: 0,
    unreadable_lines: "",
    needs_confirmation: false,
    current_monthly_total: 0,
    not_compared_monthly_total: 0,
    not_compared_text: "",
    comparison_text: "",
    pricing_inputs_json: "",
    assumptions: "",
    accel_bundle_name: "",
    accel_monthly_total: 0,
    accel_setup_total: 0,
    accel_items_json: "[]",
    accel_quote_text: "",
    monthly_saving: 0,
    yearly_saving: 0,
    first_year_saving: 0,
    is_accel_cheaper: false,
    extra_value_text: "",
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

/** Formats rupees with Indian digit grouping: 123456 → "₹1,23,456" (same as price_bundle). */
function formatRupees(amount) {
  const digits = String(Math.round(Math.abs(amount)));
  const sign = amount < 0 ? "-" : "";
  if (digits.length <= 3) return sign + "₹" + digits;
  const lastThree = digits.slice(-3);
  const leading = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return sign + "₹" + leading + "," + lastThree;
}

function containsAnyWord(text, words) {
  const paddedText =
    " " +
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9.\-/ ]/g, " ") +
    " ";
  return words.some(
    (word) => paddedText.indexOf(" " + word + " ") >= 0 || (word.length > 4 && paddedText.indexOf(word) >= 0),
  );
}

function sumAmounts(bills) {
  return bills.reduce((sum, bill) => sum + bill.monthlyAmount, 0);
}

// ================================================================ LOGIC: reading the bills

/** Bills from a JSON array or from text lines. Each gets a category, a monthly amount, a count, and a problem ("" = fine). */
function parseBills(billsInput) {
  const raw = String(billsInput || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list.map((entry) =>
          readBill([entry.category, entry.vendor, entry.amount].join(" " + FIELD_SEPARATOR + " "), entry),
        );
      }
    } catch {
      // Not valid JSON: fall back to reading it as text lines.
    }
  }
  return raw
    .split(BILL_SEPARATOR_PATTERN)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => readBill(line, null));
}

/** Reads one bill line, e.g. "Mobile | Jio | 3 x ₹799" or "Google Workspace 10 users ₹125 per user". */
function readBill(line, structuredEntry) {
  const fields = line.split(FIELD_SEPARATOR).map((field) => field.trim());
  const categoryText = structuredEntry ? String(structuredEntry.category || "") : fields[0] || "";
  const vendor = structuredEntry ? String(structuredEntry.vendor || "") : fields.length > 2 ? fields[1] : "";
  const category = findCategory(categoryText) || findCategory(line);
  const amountText = structuredEntry
    ? String(structuredEntry.amount === undefined ? "" : structuredEntry.amount)
    : chooseAmountField(fields, line);
  const amount = readMonthlyAmount(amountText, line);
  const countMatch = line.match(COUNT_PATTERN);
  const bill = {
    originalText: line,
    categoryId: category ? category.id : NOT_TELECOM,
    category,
    vendor,
    label:
      (category && category.id !== NOT_TELECOM ? category.label : categoryText || line) +
      (vendor ? " (" + vendor + ")" : ""),
    monthlyAmount: amount.monthlyAmount,
    wasYearly: amount.wasYearly,
    count: amount.count || (countMatch ? parseInt(countMatch[1], 10) : null),
    problem: amount.problem,
  };
  // Lines that name no telecom category but mention nothing Accel sells stay "not telecom" and are not compared.
  return bill;
}

function findCategory(text) {
  return BILL_CATEGORIES.find((category) => containsAnyWord(text, category.words)) || null;
}

/**
 * The part of a bill line that holds the amount: the last field after the category that has a digit in it
 * ("Biz Fibre 100 | Local ISP | 999" → "999", so the "100" in the plan name is not read as money). A line without
 * "|" fields is read whole.
 */
function chooseAmountField(fields, line) {
  if (fields.length < 2) return line;
  const withDigits = fields.slice(1).filter((field) => /\d/.test(field));
  return withDigits.length ? withDigits[withDigits.length - 1] : line;
}

/**
 * Every number in the text, marked as money, a quantity ("3 SIMs") or other ("100 Mbps", "18%", "5G"), with whether a
 * ₹/Rs/INR mark sits next to it. start and end cover the marks and the unit word, so the text between two tokens is
 * exactly what joins them ("x", "at").
 * @example findNumberTokens("3 sims x ₹799") → [{ value: 3, kind: "count" }, { value: 799, kind: "money", hasCurrency: true }]
 */
function findNumberTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const digits = match[0].replace(/,+$/, "");
    const before = text.slice(0, match.index);
    let end = match.index + digits.length;
    const currencyBefore = before.match(CURRENCY_BEFORE_NUMBER);
    const currencyAfter = text.slice(end).match(CURRENCY_AFTER_NUMBER);
    if (currencyAfter) end += currencyAfter[0].length;
    const after = text.slice(end);
    const token = {
      value: parseFloat(digits.replace(/,/g, "")),
      hasComma: digits.indexOf(",") >= 0,
      hasCurrency: Boolean(currencyBefore || currencyAfter),
      isMultiplied: false,
      kind: TOKEN_KIND.MONEY,
      start: currencyBefore ? match.index - currencyBefore[0].length : match.index,
      end,
    };
    const multiplier = after.match(MULTIPLIER_AFTER_NUMBER);
    const countUnit = after.match(COUNT_UNIT_AFTER_NUMBER);
    if (multiplier) {
      token.value *= multiplier[1] === "k" ? RUPEES_PER_THOUSAND : RUPEES_PER_LAKH;
      token.isMultiplied = true;
      token.end += multiplier[0].length;
    } else if (countUnit && !token.hasCurrency) {
      token.kind = TOKEN_KIND.COUNT;
      token.end += countUnit[0].length;
    } else if (
      NON_MONEY_UNIT_AFTER_NUMBER.test(after) ||
      LETTER_STUCK_AFTER.test(after) ||
      (!currencyBefore && LETTER_STUCK_BEFORE.test(before))
    ) {
      token.kind = TOKEN_KIND.OTHER;
    }
    tokens.push(token);
  }
  return tokens;
}

/** A whole number from 1 to MAX_STATED_QUANTITY, written plainly: something that can be a count of lines or users. */
function canBeQuantity(token) {
  return (
    Number.isInteger(token.value) &&
    token.value >= 1 &&
    token.value <= MAX_STATED_QUANTITY &&
    !token.hasComma &&
    !token.isMultiplied
  );
}

/** What a token says it is: a count (unit word), a price (₹/Rs/INR) or unmarked. */
function roleOf(token) {
  if (token.kind === TOKEN_KIND.COUNT) return ROLE.COUNT;
  return token.hasCurrency ? ROLE.PRICE : ROLE.UNMARKED;
}

/**
 * Which of two multiplied numbers is the quantity and which the price. Marks decide ("₹799 x 3", "3 lines at 799");
 * with no marks, the quantity is the number under MIN_UNIT_PRICE_IN_RUPEES and the price the one at or above it.
 * Returns { quantity, unitPrice } or null when it stays unclear (then the owner is asked).
 */
function splitQuantityAndPrice(first, second) {
  const firstRole = roleOf(first);
  const secondRole = roleOf(second);
  if (firstRole === ROLE.UNMARKED && secondRole === ROLE.UNMARKED) {
    const readings = [
      [first, second],
      [second, first],
    ].filter(
      ([quantity, price]) =>
        canBeQuantity(quantity) && quantity.value < MIN_UNIT_PRICE_IN_RUPEES && price.value >= MIN_UNIT_PRICE_IN_RUPEES,
    );
    return readings.length === 1 ? { quantity: readings[0][0], unitPrice: readings[0][1] } : null;
  }
  if (firstRole === secondRole) return null;
  const firstIsQuantity = firstRole === ROLE.COUNT || secondRole === ROLE.PRICE;
  const quantity = firstIsQuantity ? first : second;
  const unitPrice = firstIsQuantity ? second : first;
  if (!canBeQuantity(quantity) || roleOf(unitPrice) === ROLE.COUNT) return null;
  return { quantity, unitPrice };
}

/** A reading that couldn't be used: the question for the owner instead of an amount. */
function unclearReading(problem) {
  return { amount: null, count: null, problem };
}

/**
 * The amount and quantity a bill's amount text states, or the question to ask. Order: a multiplication ("3 x 799",
 * "₹799 ×3", "3 lines at 799"); else the one amount on the line ("₹1,299", "Rs. 1,299/-", "1299"), multiplied by the
 * stated quantity when it is "each" or "per line". Never guesses: two possible amounts, an unclear quantity or "each"
 * without a quantity all come back as a problem.
 * Returns { amount, count, problem }: amount in rupees before the yearly check, count or null.
 */
function readQuantityAndAmount(text, lowerLine) {
  const tokens = findNumberTokens(text).filter((token) => token.kind !== TOKEN_KIND.OTHER);
  for (let i = 0; i + 1 < tokens.length; i++) {
    const gap = text.slice(tokens[i].end, tokens[i + 1].start);
    if (!MULTIPLY_SIGN_GAP.test(gap) && !AT_PRICE_GAP.test(gap)) continue;
    const split = splitQuantityAndPrice(tokens[i], tokens[i + 1]);
    if (!split) return unclearReading(MESSAGES.problems.unclearQuantity);
    const amount = split.quantity.value * split.unitPrice.value;
    const otherAmounts = tokens.filter(
      (token, index) => index !== i && index !== i + 1 && token.kind === TOKEN_KIND.MONEY && token.value !== amount,
    );
    if (otherAmounts.length) return unclearReading(MESSAGES.problems.severalAmounts);
    return { amount, count: split.quantity.value, problem: "" };
  }
  const amounts = tokens.filter((token) => token.kind === TOKEN_KIND.MONEY);
  if (!amounts.length) return unclearReading(MESSAGES.problems.noAmount);
  const markedAmounts = amounts.filter((token) => token.hasCurrency);
  const chosen = amounts.length === 1 ? amounts[0] : markedAmounts.length === 1 ? markedAmounts[0] : null;
  if (!chosen) return unclearReading(MESSAGES.problems.severalAmounts);
  if (!PER_UNIT_WORDS.some((word) => lowerLine.indexOf(word) >= 0)) {
    return { amount: chosen.value, count: null, problem: "" };
  }
  const countMatch = lowerLine.match(COUNT_PATTERN);
  if (!countMatch) return unclearReading(MESSAGES.problems.perUnitNoCount);
  const count = parseInt(countMatch[1], 10);
  return { amount: chosen.value * count, count, problem: "" };
}

/**
 * Monthly amount from a bill's amount text. Handles ₹/Rs/INR or no symbol, commas, "1.2k", "1.5 lakh", "3 x 799",
 * "₹799 × 3", "3 lines at 799", "₹799 each" with a stated quantity, and yearly amounts (÷ 12).
 * Returns { monthlyAmount, wasYearly, count, problem }.
 */
function readMonthlyAmount(amountText, fullLine) {
  const lowerLine = String(fullLine).toLowerCase();
  const reading = readQuantityAndAmount(String(amountText).toLowerCase(), lowerLine);
  if (reading.problem) return { monthlyAmount: 0, wasYearly: false, count: null, problem: reading.problem };
  const wasYearly = YEARLY_WORDS.some((word) => lowerLine.indexOf(word) >= 0);
  const monthlyAmount = Math.round(wasYearly ? reading.amount / MONTHS_PER_YEAR : reading.amount);
  const count = reading.count;
  if (!isFinite(monthlyAmount)) return { monthlyAmount: 0, wasYearly, count, problem: MESSAGES.problems.noAmount };
  if (monthlyAmount <= 0) return { monthlyAmount: 0, wasYearly, count, problem: MESSAGES.problems.notPositive };
  if (monthlyAmount > MAX_PLAUSIBLE_MONTHLY_BILL_IN_RUPEES) {
    return { monthlyAmount: 0, wasYearly, count, problem: MESSAGES.problems.implausible };
  }
  return { monthlyAmount, wasYearly, count, problem: "" };
}

// ================================================================ LOGIC: pricing and comparing

/** Business details for pricing: business_context_json (from onboarding) first, single fields override it. */
function readBusinessContext(inputVars) {
  let context = {};
  try {
    context = inputVars.business_context_json ? JSON.parse(inputVars.business_context_json) : {};
  } catch {
    context = {};
  }
  ["business_type", "segment", "city", "employees", "sites", "has_gstin", "fibre_available"].forEach((field) => {
    if (inputVars[field]) context[field] = inputVars[field];
  });
  return context;
}

/** price_bundle inputs for a like-for-like quote, plus the assumptions made (quantities nobody stated). */
function buildPricingRequest(bills, context, language) {
  const categoryIds = new Set(bills.map((bill) => bill.categoryId));
  const needs = [];
  const quantityInputs = {};
  const assumptions = [];
  BILL_CATEGORIES.forEach((category) => {
    if (!categoryIds.has(category.id)) return;
    if (category.need) needs.push(category.need);
    if (!category.countInput) return;
    const billsInCategory = bills.filter((bill) => bill.categoryId === category.id);
    const statedCounts = billsInCategory.filter((bill) => bill.count);
    if (statedCounts.length === billsInCategory.length) {
      quantityInputs[category.countInput] = String(statedCounts.reduce((sum, bill) => sum + bill.count, 0));
    } else if (category.id === "mobile") {
      // One SIM per mobile bill unless a count was given: the cheapest honest reading of "a mobile bill".
      quantityInputs.lines = String(billsInCategory.reduce((sum, bill) => sum + (bill.count || 1), 0));
      assumptions.push("mobile lines = " + quantityInputs.lines + " (one per mobile bill without a stated count)");
    } else {
      assumptions.push(category.label + ": quantity not stated, Saathi's default for this business size used");
    }
  });
  bills.filter((bill) => bill.wasYearly).forEach((bill) => assumptions.push(bill.label + ": yearly amount ÷ 12"));

  const removals = ALWAYS_REMOVED_FOR_LIKE_FOR_LIKE.slice();
  Object.keys(REMOVABLE_DEFAULT_PRODUCT_BY_CATEGORY).forEach((categoryId) => {
    if (!categoryIds.has(categoryId)) removals.push(REMOVABLE_DEFAULT_PRODUCT_BY_CATEGORY[categoryId]);
  });
  if (!context.business_type && !context.segment) {
    assumptions.push("business type not given: priced as a small shop");
  }
  return {
    inputs: Object.assign(
      {
        business_type: context.business_type || "",
        segment: context.segment || "",
        city: context.city || "",
        employees: context.employees || "",
        sites: context.sites || "",
        has_gstin: context.has_gstin || "",
        fibre_available: context.fibre_available || "",
        needs: needs.join(", "),
        remove: removals.join(", "),
        lang: language === "hi" ? "hi" : "en",
        show_card: "no",
      },
      quantityInputs,
    ),
    assumptions,
  };
}

/**
 * Pairs each bill category with the Accel items that replace it. A category the quote couldn't cover (for example
 * WhatsApp API without a GSTIN) moves to "not compared" with the pricing function's own reason.
 */
function compareWithQuote(bills, quote) {
  const items = JSON.parse(quote.items_json || "[]");
  const matchedBills = [];
  const unmatchedBills = [];
  const reasonByBill = new Map();
  const lines = [];
  const coveredItemIds = new Set();
  const categories = BILL_CATEGORIES.filter((category) => bills.some((bill) => bill.categoryId === category.id));
  categories.forEach((category) => {
    const billsInCategory = bills.filter((bill) => bill.categoryId === category.id);
    const replacingItems = items.filter((item) => category.productIds.indexOf(item.id) >= 0);
    if (replacingItems.length === 0) {
      billsInCategory.forEach((bill) => {
        unmatchedBills.push(bill);
        reasonByBill.set(bill, findBlockedReason(quote.blocked_text, category) || "no Accel equivalent in this bundle");
      });
      return;
    }
    replacingItems.forEach((item) => coveredItemIds.add(item.id));
    billsInCategory.forEach((bill) => matchedBills.push(bill));
    lines.push(
      category.label +
        ": " +
        formatRupees(sumAmounts(billsInCategory)) +
        " → " +
        replacingItems
          .map((item) => item.name + (item.qty > 1 ? " ×" + item.qty : "") + " " + formatRupees(item.monthly))
          .join(", "),
    );
  });
  const extraItems = items.filter((item) => !coveredItemIds.has(item.id));
  return { matchedBills, unmatchedBills, reasonByBill, lines, extraItems, items };
}

/** The pricing function's own reason for leaving a product out (e.g. "needs an active GSTIN"). */
function findBlockedReason(blockedText, category) {
  const match = String(blockedText || "")
    .split("; ")
    .find((entry) =>
      category.productIds.some((productId) => entry.indexOf(PRODUCT_DESCRIPTIONS[productId].name) === 0),
    );
  return match ? match.slice(match.indexOf("(") + 1, match.lastIndexOf(")")) : "";
}

/** What the money buys: catalogue descriptions of the Accel items, items not paid for today, and the one bill. */
function describeExtraValue(comparison, quote, language) {
  const text = MESSAGES[language];
  const lines = comparison.items.map((item) => {
    const description = PRODUCT_DESCRIPTIONS[item.id] ? PRODUCT_DESCRIPTIONS[item.id].description : "";
    const notPaidToday = comparison.extraItems.some((extra) => extra.id === item.id)
      ? " (" + text.youDontPayToday + ")"
      : "";
    return "• " + item.name + ": " + description + notPaidToday;
  });
  lines.push("• " + text.oneBill);
  return lines.join("\n");
}

function describeBills(bills, reason) {
  return bills.map((bill) => bill.label + " " + formatRupees(bill.monthlyAmount) + " (" + reason + ")").join("; ");
}

/** The chat message: savings, or an honest "Accel costs more" with what the extra buys; then notes. */
function writeMessage(outputVars, language) {
  const text = MESSAGES[language];
  const values = {
    current: formatRupees(outputVars.current_monthly_total),
    accel: formatRupees(outputVars.accel_monthly_total),
    bundle: outputVars.accel_bundle_name,
    saving: formatRupees(outputVars.monthly_saving),
    yearly: formatRupees(outputVars.yearly_saving),
    setup: formatRupees(outputVars.accel_setup_total),
    firstYear: formatRupees(outputVars.first_year_saving),
    firstYearCost: formatRupees(-outputVars.first_year_saving),
    difference: formatRupees(-outputVars.monthly_saving),
  };
  const parts = [];
  if (outputVars.monthly_saving > 0) {
    parts.push(fillTemplate(text.cheaper, values));
    if (outputVars.accel_setup_total > 0) {
      parts.push(
        fillTemplate(outputVars.first_year_saving > 0 ? text.cheaperWithSetup : text.setupEatsFirstYear, values),
      );
    }
  } else if (outputVars.monthly_saving === 0) {
    parts.push(fillTemplate(text.samePrice, values));
  } else {
    parts.push(fillTemplate(text.moreExpensive, values));
    parts.push(outputVars.extra_value_text);
  }
  if (outputVars.not_compared_text)
    parts.push(fillTemplate(text.notComparedNote, { items: outputVars.not_compared_text }));
  if (outputVars.unreadable_lines) parts.push(fillTemplate(text.confirmNote, { items: outputVars.unreadable_lines }));
  return parts.join("\n");
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/** Product names and descriptions from product_catalogue.csv (case pack, synthetic), keyed by product ID. */
const PRODUCT_DESCRIPTIONS = {"P01":{"name":"Biz Fibre 100","description":"Business fibre broadband, 100 Mbps, unlimited data"},"P02":{"name":"Biz Fibre 300","description":"Business fibre broadband, 300 Mbps, unlimited data, static IP optional"},"P03":{"name":"Biz Fibre 1G","description":"Business fibre broadband, 1 Gbps, priority support"},"P04":{"name":"Biz 5G AirFiber 100","description":"Wireless (5G FWA) broadband, 100 Mbps, plug-and-play, for sites without fibre"},"P05":{"name":"Internet Leased Line 20","description":"Dedicated 1:1 internet, 20 Mbps, 99.5% SLA"},"P06":{"name":"Internet Leased Line 100","description":"Dedicated 1:1 internet, 100 Mbps, 99.9% SLA"},"P07":{"name":"Business Postpaid 299","description":"Business mobile line, 50 GB data, unlimited calls"},"P08":{"name":"Business Postpaid 599","description":"Business mobile line, 150 GB data, roaming, priority care"},"P09":{"name":"Backup 4G/5G Failover","description":"Automatic failover router with data SIM for when the main link is down"},"P10":{"name":"Managed SD-WAN","description":"Central management of links across sites, app-priority routing"},"P11":{"name":"Static IP","description":"Fixed public IP for CCTV, servers or remote access"},"P12":{"name":"Cloud Telephony / SIP","description":"Business phone lines over internet with IVR, call recording"},"P13":{"name":"Toll-free Number","description":"1800 number routed to mobile or cloud telephony"},"P14":{"name":"Business SMS 10k","description":"10,000 SMS per month for alerts and promotions, DLT registration assisted"},"P15":{"name":"WhatsApp Business API Starter","description":"Verified WhatsApp channel, catalogue, 1,000 conversations a month"},"P16":{"name":"Cloud Email & Office Suite","description":"Business email on own domain, documents, video meetings"},"P17":{"name":"Cloud Backup 1 TB","description":"Automatic backup of PCs and phones, 1 TB"},"P18":{"name":"Website + Domain Starter","description":"Domain, 5-page website builder, hosting, SSL"},"P19":{"name":"Cloud POS & Billing","description":"GST-ready billing, inventory, UPI/card acceptance on a tablet"},"P20":{"name":"Endpoint Security","description":"Antivirus and ransomware protection for PCs and phones"},"P21":{"name":"Managed Firewall","description":"Next-gen firewall at the site, managed by Accel SOC"},"P22":{"name":"Secure Wi-Fi with Guest Network","description":"Managed Wi-Fi access point with separate customer Wi-Fi and content filtering"},"P23":{"name":"Cloud CCTV","description":"HD camera with 30-day cloud recording and mobile app view"},"P24":{"name":"Machine Monitoring IoT","description":"IoT SIM + sensor kit for machine uptime and energy use"},"P25":{"name":"Fleet Tracker","description":"GPS tracker with IoT SIM and live dashboard"}};

/**
 * The real pricing function (price_bundle main), embedded unchanged by the build in its own scope. Every Accel
 * price in this file comes from it. Never write prices here.
 */
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
