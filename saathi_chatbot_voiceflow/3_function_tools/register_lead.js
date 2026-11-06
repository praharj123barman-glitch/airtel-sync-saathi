/*
 * register_lead.js: Voiceflow function tool "register_lead" (TEMPLATE; the build injects the trained model).
 *
 * What it does: prepares one back-office row: a reference ID, a lead score (0–100 percentile of the chance to
 * activate), a priority (Hot / Warm / Cold) and the expected go-live date.
 *
 * How it fits: the "Callback & lead capture" playbook calls it once, then the Google Sheets tool appends the row.
 * That sheet is the case's stretch goal: "a back-office view of leads the advisor could not close, with a
 * propensity score".
 *
 * The model: logistic regression trained by _build/gen_kit.py on smb_leads.csv (5,000 synthetic leads;
 * 5-fold CV AUC 0.71; the top 20% of scored leads held 40% of activations). Privacy: it receives business
 * attributes only, never a name or phone number. Unknown fields count as "average" so they neither help nor hurt.
 */

/**
 * Voiceflow entry point: scores a lead and creates its reference ID and go-live date.
 *
 * @param {{inputVars?: Object<string, string>}} args  segment, business_type, city, language, employees, sites,
 *   has_gstin, has_udyam, current_internet, current_provider, contact_role, monthly_spend, needs, install_days.
 *   (No stage or lead-source input: the score uses business attributes only; the stage goes to reach_tag_lead.)
 * @returns {{outputVars: {ref_id: string, lead_score: number, priority: string, activation_probability: number,
 *   expected_live_date: string, created_at: string, error: string}}}
 * @example
 *   await main({ inputVars: { segment: "prof", city: "Delhi", employees: "16", has_gstin: "yes", install_days: "5" } })
 *   // → priority "Hot", ref_id like "SA-15FTHB"
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const outputVars = {
    ref_id: "",
    lead_score: 0,
    priority: "",
    activation_probability: 0,
    expected_live_date: "",
    created_at: "",
    error: "",
  };
  try {
    const probability = predictActivationProbability(inputVars);
    const percentile = toPercentile(probability);
    outputVars.activation_probability = Math.round(probability * PROBABILITY_ROUNDING) / PROBABILITY_ROUNDING;
    outputVars.lead_score = percentile;
    outputVars.priority = toPriority(percentile);
    const now = new Date();
    const nowInIst = new Date(now.getTime() + IST_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE); // read with getUTC*
    outputVars.created_at = nowInIst.toISOString().slice(0, 16).replace("T", " ") + " IST";
    outputVars.ref_id = REFERENCE_PREFIX + now.getTime().toString(36).toUpperCase().slice(-REFERENCE_SUFFIX_LENGTH);
    const daysToGoLive = estimateDaysToGoLive(inputVars.install_days);
    outputVars.expected_live_date = formatDate(new Date(nowInIst.getTime() + daysToGoLive * MILLISECONDS_PER_DAY));
    return { outputVars };
  } catch (error) {
    outputVars.error = ERROR_PREFIX + (error && error.message ? error.message : String(error));
    return { outputVars };
  }
}

// ================================================================ CONFIG

/** Priority bands on the lead-score percentile. Hot = top 20% (they held 40% of activations in smb_leads.csv). */
const PRIORITY_BANDS = { hotMinimumPercentile: 80, warmMinimumPercentile: 50 };
const PRIORITY = { HOT: "Hot", WARM: "Warm", COLD: "Cold" };
/** India Standard Time is UTC+5:30. */
const IST_OFFSET_MINUTES = 330;
const MILLISECONDS_PER_MINUTE = 60000;
const MILLISECONDS_PER_DAY = 86400000;
/** Used when the quote's install time isn't known: Biz Fibre's typical install time (product_catalogue.csv). */
const DEFAULT_INSTALL_DAYS = 5;
/** One extra day for KYC and scheduling before the install clock starts. Design choice. */
const KYC_BUFFER_DAYS = 1;
/** In the training data a lead asked about 1–3 products, so more needs than 3 count as 3. */
const MAX_INTERESTS_COUNTED = 3;
/** Reference IDs look like "SA-15FTHB": "SA" for Saathi + the last 6 base-36 digits of the timestamp. */
const REFERENCE_PREFIX = "SA-";
const REFERENCE_SUFFIX_LENGTH = 6;
/** activation_probability is rounded to 3 decimals. */
const PROBABILITY_ROUNDING = 1000;
const ERROR_PREFIX = "register_lead failed: ";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Maps free-text answers onto the categories the model was trained on (smb_leads.csv column values). */
const SEGMENT_PATTERNS = [
  // Later matches win, so the more specific segments come last (same order as training-time rules).
  { pattern: /micro|kirana|salon|pharmacy|shop|store|bakery|boutique/, value: "Micro retail & services" },
  { pattern: /prof|office|clinic|lab|ca firm|law|coaching|agency|studio/, value: "Professional offices" },
  { pattern: /multi|chain|branches|outlets/, value: "Small multi-site businesses" },
  { pattern: /mfg|manufactur|factory|unit|workshop|press/, value: "Small manufacturers" },
];
const LANGUAGE_BY_INPUT = {
  hi: "Hindi",
  hindi: "Hindi",
  en: "English",
  english: "English",
  mr: "Marathi",
  marathi: "Marathi",
  ta: "Tamil",
  tamil: "Tamil",
  te: "Telugu",
  telugu: "Telugu",
  kn: "Kannada",
  kannada: "Kannada",
  ml: "Malayalam",
  malayalam: "Malayalam",
  gu: "Gujarati",
  gujarati: "Gujarati",
  bn: "Bengali",
  bengali: "Bengali",
  pa: "Punjabi",
  punjabi: "Punjabi",
};
const YES_PATTERN = /^(y|yes|true|1|active|haan|हाँ)/;
const NO_PATTERN = /^(n|no|false|0|nahi|नहीं)/;
const CURRENT_INTERNET_PATTERNS = [
  { pattern: /hotspot|mobile data|phone/, value: "Mobile hotspot" },
  { pattern: /home/, value: "Home broadband" },
  { pattern: /leased|dedicated/, value: "Leased line" },
  { pattern: /mixed|different/, value: "Mixed per site" },
  { pattern: /business|broadband|fibre|fiber/, value: "Business broadband" },
];
const CONTACT_ROLE_PATTERNS = [
  { pattern: /owner|proprietor|malik/, value: "Owner" },
  { pattern: /partner/, value: "Partner" },
  { pattern: /manager/, value: "Manager" },
  { pattern: /admin|office/, value: "Office admin" },
];

// ================================================================ LOGIC

function toLowerText(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
}

function toNumberOrNull(value) {
  const number = parseFloat(String(value === undefined || value === null ? "" : value).replace(/[^0-9.]/g, ""));
  return isFinite(number) ? number : null;
}

/** "Y", "N" or null (unknown) from a yes/no answer. */
function toYesNoCode(value) {
  const answer = toLowerText(value);
  if (YES_PATTERN.test(answer)) return "Y";
  if (NO_PATTERN.test(answer)) return "N";
  return null;
}

/** Converts what the chat knows into the model's categorical fields. Unknown fields stay undefined. */
function toModelCategories(inputVars) {
  const categories = {};
  const segmentText = toLowerText(inputVars.segment) + " " + toLowerText(inputVars.business_type);
  SEGMENT_PATTERNS.forEach(({ pattern, value }) => {
    if (pattern.test(segmentText)) categories.segment = value;
  });
  const city = toLowerText(inputVars.city);
  if (city) categories.city_tier = MODEL.tier1.indexOf(city) >= 0 ? "1" : "2";
  const language = toLowerText(inputVars.language);
  if (LANGUAGE_BY_INPUT[language]) categories.preferred_language = LANGUAGE_BY_INPUT[language];
  if (toYesNoCode(inputVars.has_gstin)) categories.has_gstin = toYesNoCode(inputVars.has_gstin);
  if (toYesNoCode(inputVars.has_udyam)) categories.has_udyam = toYesNoCode(inputVars.has_udyam);
  const currentInternet = toLowerText(inputVars.current_internet);
  const internetMatch = CURRENT_INTERNET_PATTERNS.find(({ pattern }) => pattern.test(currentInternet));
  if (internetMatch) categories.current_internet = internetMatch.value;
  const provider = toLowerText(inputVars.current_provider);
  if (/accel/.test(provider))
    categories.current_provider = /mobile|sim/.test(provider) ? "Accel (mobile only)" : "Accel";
  else if (/local|cable/.test(provider)) categories.current_provider = "Local ISP";
  const role = toLowerText(inputVars.contact_role);
  const roleMatch = CONTACT_ROLE_PATTERNS.find(({ pattern }) => pattern.test(role));
  if (roleMatch) categories.contact_role = roleMatch.value;
  return categories;
}

/** Logistic-regression probability that this lead activates (standardised features, unknown = training mean). */
function predictActivationProbability(inputVars) {
  const categories = toModelCategories(inputVars);
  const numbers = {
    employee_count: toNumberOrNull(inputVars.employees),
    num_sites: toNumberOrNull(inputVars.sites),
    monthly_telecom_spend_inr: toNumberOrNull(inputVars.monthly_spend),
    n_interest: inputVars.needs
      ? Math.min(
          MAX_INTERESTS_COUNTED,
          String(inputVars.needs)
            .split(/[,;]+/)
            .filter((need) => need.trim()).length,
        )
      : null,
  };
  let logit = MODEL.intercept;
  MODEL.features.forEach((feature, index) => {
    let value;
    if (feature.group) {
      const category = categories[feature.group];
      value = category === undefined ? MODEL.mean[index] : String(category) === feature.value ? 1 : 0;
    } else {
      const number = numbers[feature.name];
      value = number === null || number === undefined ? MODEL.mean[index] : number;
    }
    logit += MODEL.coef[index] * ((value - MODEL.mean[index]) / MODEL.scale[index]);
  });
  return 1 / (1 + Math.exp(-logit));
}

/** Where the probability falls among the 5,000 training leads (0–100), using 101 stored quantile cut points. */
function toPercentile(probability) {
  const cutPoints = MODEL.quantiles;
  let percentile = 0;
  while (percentile < cutPoints.length - 1 && probability > cutPoints[percentile + 1]) percentile++;
  return Math.min(100, percentile);
}

function toPriority(percentile) {
  if (percentile >= PRIORITY_BANDS.hotMinimumPercentile) return PRIORITY.HOT;
  if (percentile >= PRIORITY_BANDS.warmMinimumPercentile) return PRIORITY.WARM;
  return PRIORITY.COLD;
}

/** Install days from the quote (or the default), plus the KYC buffer; at least 1 + buffer. */
function estimateDaysToGoLive(installDaysInput) {
  const installDays = Number(String(installDaysInput || "").replace(/[^0-9.]/g, "")) || DEFAULT_INSTALL_DAYS;
  return Math.max(1, Math.round(installDays)) + KYC_BUFFER_DAYS;
}

/** "Tue 10 Nov 2026" from a Date already shifted to IST (read with getUTC*). */
function formatDate(dateInIst) {
  return (
    DAY_NAMES[dateInIst.getUTCDay()] +
    " " +
    dateInIst.getUTCDate() +
    " " +
    MONTH_NAMES[dateInIst.getUTCMonth()] +
    " " +
    dateInIst.getUTCFullYear()
  );
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/**
 * Trained lead-score model: feature list (categorical {group, value} or numeric {name}), StandardScaler mean and
 * scale, logistic-regression coefficients and intercept, 101 quantile cut points of the training predictions,
 * and the tier-1 city list.
 */
const MODEL = {"features":[{"group":"segment","value":"Micro retail & services"},{"group":"segment","value":"Professional offices"},{"group":"segment","value":"Small manufacturers"},{"group":"segment","value":"Small multi-site businesses"},{"group":"city_tier","value":"1"},{"group":"city_tier","value":"2"},{"group":"preferred_language","value":"Bengali"},{"group":"preferred_language","value":"English"},{"group":"preferred_language","value":"Gujarati"},{"group":"preferred_language","value":"Hindi"},{"group":"preferred_language","value":"Kannada"},{"group":"preferred_language","value":"Malayalam"},{"group":"preferred_language","value":"Marathi"},{"group":"preferred_language","value":"Punjabi"},{"group":"preferred_language","value":"Tamil"},{"group":"preferred_language","value":"Telugu"},{"group":"has_gstin","value":"N"},{"group":"has_gstin","value":"Y"},{"group":"has_udyam","value":"N"},{"group":"has_udyam","value":"Y"},{"group":"current_internet","value":"Business broadband"},{"group":"current_internet","value":"Home broadband"},{"group":"current_internet","value":"Leased line"},{"group":"current_internet","value":"Mixed per site"},{"group":"current_internet","value":"Mobile hotspot"},{"group":"current_provider","value":"Accel"},{"group":"current_provider","value":"Accel (mobile only)"},{"group":"current_provider","value":"Competitor A"},{"group":"current_provider","value":"Competitor B"},{"group":"current_provider","value":"Local ISP"},{"group":"contact_role","value":"Manager"},{"group":"contact_role","value":"Office admin"},{"group":"contact_role","value":"Owner"},{"group":"contact_role","value":"Partner"},{"name":"employee_count"},{"name":"num_sites"},{"name":"monthly_telecom_spend_inr"},{"name":"n_interest"}],"mean":[0.5418,0.2494,0.0578,0.151,0.5156,0.4844,0.0222,0.2336,0.0466,0.4274,0.0506,0.0166,0.101,0.0192,0.0414,0.0414,0.2932,0.7068,0.4554,0.5446,0.2866,0.25,0.0346,0.0442,0.3598,0.077,0.301,0.24,0.1488,0.2084,0.205,0.1918,0.4142,0.189,20.4656,2.0392,3317.93,1.9942],"scale":[0.49825,0.432666,0.233365,0.358049,0.499757,0.499757,0.147333,0.423121,0.210781,0.494701,0.219179,0.127767,0.301329,0.137227,0.199214,0.199214,0.455229,0.455229,0.498007,0.498007,0.452173,0.433013,0.182764,0.205539,0.479942,0.266591,0.458693,0.427083,0.355891,0.406164,0.403702,0.393717,0.492583,0.391509,31.288145,2.587753,4270.787283,0.810781],"coef":[-0.227603,0.109225,0.088831,0.126841,0.105736,-0.105736,0.006502,0.055173,-0.017801,0.082925,-0.095808,0.031744,-0.057496,-0.05142,-0.109657,0.008012,-0.289289,0.289289,-0.044131,0.044131,-0.009169,0.030693,0.065998,0.052742,-0.048863,0.067618,0.131611,-0.05761,-0.00137,-0.110074,0.011969,-0.027133,0.012692,-0.001025,-0.084832,-0.057195,-0.022252,-0.084106],"intercept":-2.830166,"quantiles":[0.005187,0.008126,0.009601,0.010913,0.011781,0.012464,0.01303,0.013762,0.014435,0.014997,0.015901,0.016417,0.016961,0.017743,0.018311,0.018994,0.019589,0.020196,0.020999,0.021623,0.022507,0.023507,0.024337,0.025365,0.026938,0.028401,0.030171,0.031481,0.03246,0.033825,0.03541,0.036916,0.038383,0.039766,0.041619,0.043003,0.044162,0.04568,0.046668,0.047982,0.049469,0.051073,0.052923,0.054758,0.056181,0.057109,0.058631,0.060459,0.061855,0.063,0.064403,0.065473,0.066702,0.068245,0.069705,0.071224,0.072839,0.074449,0.075971,0.077582,0.078844,0.080585,0.081633,0.083702,0.085223,0.087009,0.088761,0.090836,0.092249,0.094552,0.096148,0.098181,0.099879,0.101979,0.104346,0.106565,0.109508,0.111782,0.114011,0.116328,0.118484,0.120804,0.123567,0.126378,0.128882,0.131596,0.134615,0.13757,0.140594,0.143563,0.147231,0.15124,0.15468,0.159361,0.165848,0.173989,0.180881,0.190369,0.200611,0.21596,0.291044],"tier1":["ahmedabad","bengaluru","chennai","delhi","hyderabad","kolkata","mumbai","pune"]};
