/*
 * verify_gstin.js: Voiceflow function tool "verify_gstin" (TEMPLATE; the build injects the mock registry).
 *
 * What it does: Smart-KYC step 1. Checks a GSTIN without asking for a certificate upload:
 *   1. format (15 characters: 2-digit state code, 10-character PAN, entity number, "Z", checksum character)
 *   2. state code range
 *   3. checksum (the official GSTIN mod-36 algorithm)
 *   4. lookup in the case's mock GST registry (mock_gstin_registry.csv, 3,534 synthetic records)
 *   5. status must be Active: Cancelled and Suspended are blocked
 *   6. name match against the business name the owner gave
 *
 * How it fits: the "Business verification" playbook calls it after the owner accepts a quote AND gives consent.
 * Consent is enforced here too, not only in the prompt: without consent_given = yes nothing is read or looked up.
 * It never returns the full GSTIN to the chat (gstin_masked only). _build/gen_kit.py builds two versions:
 * verify_gstin.js (full registry) and verify_gstin_lite.js (only the cancelled/suspended records, for when
 * Voiceflow's editor rejects the full file's size).
 *
 * SIMULATED: the registry is the case's synthetic mock; production would call the GST network's API instead.
 */

/**
 * Voiceflow entry point: checks one GSTIN and returns a ready-to-show message in English or Hindi.
 *
 * @param {{inputVars?: {gstin?: string, consent_given?: string, business_name?: string, lang?: string}}} args
 *   consent_given must be "yes" (or "true", what consent_manager's consent_registry_lookup holds when granted);
 *   anything else (missing, "no", "false" after a withdrawal) means no lookup at all. gstin may be the owner's
 *   whole message ("GSTIN: 07PUT…"): the GSTIN is read out of it; zero or several GSTINs are reported.
 * @returns {{outputVars: {gstin_ok: boolean, gstin_status: string, gstin_masked: string, legal_name: string,
 *   trade_name: string, gst_state: string, constitution: string, name_match: string, kyc_message: string,
 *   error: string}}}
 * @example
 *   await main({ inputVars: { gstin: "29OKAXP4077P1ZL", consent_given: "yes", lang: "en" } })
 *   // → gstin_ok false, gstin_status "Cancelled"
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const isHindi = /^(hi|hindi|हिंदी|hinglish)/i.test(String(inputVars.lang || ""));
  const language = isHindi ? LANGUAGE.HINDI : LANGUAGE.ENGLISH;
  const text = MESSAGES[language];
  const outputVars = {
    gstin_ok: false,
    gstin_status: "",
    gstin_masked: "",
    legal_name: "",
    trade_name: "",
    gst_state: "",
    constitution: "",
    name_match: "",
    kyc_message: "",
    error: "",
  };
  try {
    // Privacy by design (DPDP Act): no registry lookup without the owner's registry-lookup consent. Same rule as
    // onboard_from_gstin; the prompt says so too, but the code must not rely on the prompt.
    if (!isYes(inputVars.consent_given)) {
      outputVars.gstin_status = STATUS.CONSENT_NEEDED;
      outputVars.kyc_message = text.consentNeeded;
      return { outputVars };
    }
    // The owner's whole message may come in ("GSTIN: 07PUT…"); zero or several GSTINs are reported, not guessed.
    const reading = gstinInput.readGstin(inputVars.gstin);
    const gstin = reading.gstin;
    outputVars.gstin_masked = gstinInput.maskGstin(gstin);
    if (reading.problem) {
      outputVars.gstin_status = reading.problem;
      outputVars.kyc_message = gstinInput.problemMessage(reading.problem, language, reading.candidates);
      return { outputVars };
    }
    const record = findRegistryRecord(gstin);
    if (!record && IS_LITE_BUILD) {
      // Lite build: only cancelled/suspended GSTINs are embedded; anything else passed format + checksum.
      outputVars.gstin_ok = true;
      outputVars.gstin_status = STATUS.FORMAT_OK;
      outputVars.kyc_message = fillTemplate(text.liteFormatOk, { gstin: outputVars.gstin_masked });
      return { outputVars };
    }
    if (!record) {
      outputVars.gstin_status = STATUS.NOT_FOUND;
      outputVars.kyc_message = text.notFound;
      return { outputVars };
    }
    outputVars.legal_name = record.legalName;
    outputVars.trade_name = record.tradeName;
    outputVars.gst_state = record.state;
    outputVars.constitution = record.constitution;
    outputVars.gstin_status = record.status;
    outputVars.name_match = matchBusinessName(inputVars.business_name, [record.tradeName, record.legalName]);
    const shownName = record.tradeName || record.legalName;

    // Block cancelled/suspended GSTINs: 22 of 368 activations in smb_leads.csv went live on dead registrations.
    if (record.status !== STATUS.ACTIVE) {
      outputVars.kyc_message = fillTemplate(text.blocked, {
        gstin: outputVars.gstin_masked,
        name: shownName,
        status: isHindi ? MESSAGES.hi.statusWord[record.status] : record.status.toUpperCase(),
      });
      return { outputVars };
    }
    outputVars.gstin_ok = true;
    const nameNote =
      outputVars.name_match === NAME_MATCH.MATCH ? "" : fillTemplate(text.confirmRegisteredName, { name: shownName });
    outputVars.kyc_message =
      fillTemplate(text.verified, { gstin: outputVars.gstin_masked, name: shownName, state: record.state }) + nameNote;
    return { outputVars };
  } catch (error) {
    outputVars.error = MESSAGES.errorPrefix + (error && error.message ? error.message : String(error));
    return { outputVars };
  }
}

// ================================================================ CONFIG

/** The languages this tool writes in. */
const LANGUAGE = { ENGLISH: "en", HINDI: "hi" };

/**
 * Values of gstin_status set in this file (playbook B branches on these). The input problems (INVALID_FORMAT,
 * MULTIPLE_GSTINS, INVALID_STATE, CHECKSUM_FAILED) come from gstin_input. Codes are never shown to the owner.
 */
const STATUS = {
  ACTIVE: "Active",
  CANCELLED: "Cancelled",
  SUSPENDED: "Suspended",
  NOT_FOUND: "NOT_FOUND",
  FORMAT_OK: "FORMAT_OK",
  /** No lookup was made: registry-lookup consent is missing or was withdrawn. */
  CONSENT_NEEDED: "CONSENT_NEEDED",
};

/** Answers that count as consent (same list as onboard_from_gstin). Anything else, including silence, is a no. */
const YES_WORDS = ["yes", "y", "true", "1", "haan", "ha", "हाँ", "हां", "ಹೌದು", "agree", "i agree"];

/** Name match: share of the owner's name words found in the registry name. Design choice, tuned on the registry. */
const NAME_MATCH_THRESHOLDS = { match: 0.6, partial: 0.3 };
const NAME_MATCH = { MATCH: "match", PARTIAL: "partial", NO_MATCH: "no_match", NOT_CHECKED: "not_checked" };
/**
 * "M/s" (Messrs) starts many Indian business names. It is removed before punctuation becomes spaces, which would
 * otherwise split it into "m" and "s" and count those as name words.
 */
const MESSRS_PATTERN = /\bm\/s\b\.?/g;
/** Words ignored when comparing business names. */
const NAME_STOP_WORDS = [
  "pvt",
  "ltd",
  "private",
  "limited",
  "llp",
  "the",
  "and",
  "co",
  "company",
  "prop",
  "m/s",
  "ms",
  "&",
];

// ================================================================ MESSAGES (all user-facing text)

// Messages for a GSTIN that can't be read or fails its checks are shared: gstin_input.problemMessage.
const MESSAGES = {
  errorPrefix: "verify_gstin failed: ",
  en: {
    consentNeeded:
      "Before I check your GSTIN, I need your OK to look it up in the GST registry. It is used only to verify this order.",
    notFound:
      "The format is right, but I can't find this GSTIN in the GST registry. Our team can verify it on a quick call.",
    liteFormatOk:
      "GSTIN {gstin} passed the format and checksum checks ✓. The GST registry confirms the name before activation, so no certificate upload is needed now.",
    blocked:
      "The GST registry shows {gstin} ({name}) as {status}. We can't activate GST-only products on it. You can continue with a plan that doesn't need GST, or talk to our team.",
    verified: "Verified ✓ {gstin} · {name} · {state} · Active. No GST certificate upload needed.",
    confirmRegisteredName: ' The registered name is "{name}". Please confirm this is your business.',
  },
  hi: {
    consentNeeded:
      "GSTIN जाँचने से पहले GST रजिस्ट्री में देखने के लिए आपकी अनुमति चाहिए। इसका इस्तेमाल सिर्फ़ इस ऑर्डर को वेरिफ़ाई करने में होगा।",
    notFound:
      "फ़ॉर्मेट सही है, पर यह GSTIN GST रजिस्ट्री में नहीं मिला। हमारी टीम एक छोटी कॉल पर इसे वेरिफ़ाई कर सकती है।",
    liteFormatOk:
      "GSTIN {gstin} फ़ॉर्मेट और चेकसम जाँच में सही ✓. एक्टिवेशन से पहले GST रजिस्ट्री से नाम पक्का होगा, अभी सर्टिफ़िकेट अपलोड की ज़रूरत नहीं।",
    blocked:
      "GST रजिस्ट्री में {gstin} ({name}) {status} दिख रहा है। इस पर GST वाले प्रोडक्ट चालू नहीं हो सकते। आप बिना GST वाले प्लान के साथ आगे बढ़ सकते हैं या हमारी टीम से बात कर सकते हैं।",
    verified: "वेरिफ़ाइड ✓ {gstin} · {name} · {state} · Active. GST सर्टिफ़िकेट अपलोड करने की ज़रूरत नहीं।",
    confirmRegisteredName: ' रजिस्टर्ड नाम "{name}" है। कृपया पुष्टि करें कि यह आपका बिज़नेस है।',
    /** Hindi wording for a blocked status (only Cancelled has its own word; everything else reads as Suspended). */
    statusWord: { Cancelled: "रद्द (Cancelled)", Suspended: "निलंबित (Suspended)", Active: "निलंबित (Suspended)" },
  },
};

// ================================================================ LOGIC

/** Lower-case words of a business name, without "(Prop. …)", punctuation or stop words. Keeps Devanagari. */
function toNameWords(name) {
  return (
    String(name || "")
      .toLowerCase()
      .replace(/\(prop\.[^)]*\)/g, " ")
      .replace(MESSRS_PATTERN, " ")
      // eslint-disable-next-line no-misleading-character-class -- the whole Devanagari block is kept on purpose
      .replace(/[^a-z0-9ऀ-ॿ ]/g, " ")
      .split(/\s+/)
      .filter((word) => word && NAME_STOP_WORDS.indexOf(word) < 0)
  );
}

/** Compares the owner's business name with registry names: "match", "partial", "no_match" or "not_checked". */
function matchBusinessName(givenName, registryNames) {
  const givenWords = toNameWords(givenName);
  if (!givenWords.length) return NAME_MATCH.NOT_CHECKED;
  let bestShare = 0;
  registryNames.forEach((registryName) => {
    const registryWords = toNameWords(registryName);
    if (!registryWords.length) return;
    const sharedCount = givenWords.filter((word) => registryWords.indexOf(word) >= 0).length;
    bestShare = Math.max(bestShare, sharedCount / Math.max(givenWords.length, 1));
  });
  if (bestShare >= NAME_MATCH_THRESHOLDS.match) return NAME_MATCH.MATCH;
  if (bestShare >= NAME_MATCH_THRESHOLDS.partial) return NAME_MATCH.PARTIAL;
  return NAME_MATCH.NO_MATCH;
}

/** True only for a clear yes (see YES_WORDS). */
function isYes(value) {
  return (
    YES_WORDS.indexOf(
      String(value === undefined || value === null ? "" : value)
        .trim()
        .toLowerCase(),
    ) >= 0
  );
}

function fillTemplate(template, values) {
  return Object.keys(values).reduce((text, key) => text.split("{" + key + "}").join(values[key]), template);
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/** true in verify_gstin_lite.js: only cancelled/suspended records are embedded. */
const IS_LITE_BUILD = /*__LITE__*/ false;
/**
 * Shared GSTIN reading, checks, masking and owner-facing problem messages (_build/gstin_input.js), embedded
 * unchanged by the build. The same code runs in verify_gstin, verify_gstin_lite and the demo page.
 */
const gstinInput = /*__GSTIN_INPUT__*/ null;
/** GST state names; records store the index in base 36. */
const STATE_NAMES = /*__STATES__*/ [];
/**
 * SIMULATED: mock GST registry from the case pack (synthetic, cannot match real taxpayers).
 * One record per line: GSTIN|legal name|trade name (blank = same as legal)|status A/C/S|constitution P/C/L|state index
 */
const REGISTRY_TEXT = /*__GSTIN_REGISTRY__*/ "";
const STATUS_BY_CODE = { A: STATUS.ACTIVE, C: STATUS.CANCELLED, S: STATUS.SUSPENDED };
const CONSTITUTION_BY_CODE = {
  P: "Proprietorship",
  C: "Private Limited Company",
  L: "Limited Liability Partnership",
};
let registryIndex = null;

/** Finds a GSTIN in the embedded registry (index built on first use). Returns null when it isn't there. */
function findRegistryRecord(gstin) {
  if (!registryIndex) {
    registryIndex = {};
    REGISTRY_TEXT.split("\n").forEach((line) => {
      if (!line) return;
      const fields = line.split("|");
      registryIndex[fields[0]] = fields;
    });
  }
  const fields = registryIndex[gstin];
  if (!fields) return null;
  return {
    legalName: fields[1],
    tradeName: fields[2] || fields[1],
    status: STATUS_BY_CODE[fields[3]] || fields[3],
    constitution: CONSTITUTION_BY_CODE[fields[4]] || fields[4],
    state: STATE_NAMES[parseInt(fields[5], 36)] || "",
  };
}
