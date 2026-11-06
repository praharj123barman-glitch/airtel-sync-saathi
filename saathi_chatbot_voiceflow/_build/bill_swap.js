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
const PRODUCT_DESCRIPTIONS = /*__PRODUCT_DESCRIPTIONS__*/ {};

/**
 * The real pricing function (price_bundle main), embedded unchanged by the build in its own scope. Every Accel
 * price in this file comes from it. Never write prices here.
 */
const priceBundleMain = /*__PRICE_BUNDLE_MAIN__*/ null;
