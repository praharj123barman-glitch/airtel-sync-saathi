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
const MODEL = /*__MODEL__*/ {};
