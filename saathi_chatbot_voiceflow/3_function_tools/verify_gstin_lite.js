/*
 * verify_gstin_lite.js: LITE build, use only if the full verify_gstin.js is too big for Voiceflow's editor. Voiceflow function tool "verify_gstin" (TEMPLATE; the build injects the mock registry).
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
const IS_LITE_BUILD = true;
/**
 * Shared GSTIN reading, checks, masking and owner-facing problem messages (_build/gstin_input.js), embedded
 * unchanged by the build. The same code runs in verify_gstin, verify_gstin_lite and the demo page.
 */
const gstinInput = (function embeddedGSTIN_INPUT_API() {
/*
 * gstin_input.js: reads a GSTIN out of whatever the owner typed, checks it, and explains any problem in plain words
 * (SHARED MODULE; the build embeds it unchanged in onboard_from_gstin, verify_gstin, verify_gstin_lite, the demo
 * page's certificate reader and 7_demo_site/gstin_input.js, so there is one implementation).
 *
 * What it does:
 *   - readGstin("my gstin is 07PUTXM1153M1Z9") → { gstin: "07PUTXM1153M1Z9", problem: "", candidates: [...] }
 *     Separators are removed and letters upper-cased first, then every 15-character GSTIN-shaped run is collected.
 *     Zero or several candidates are reported as problems, never guessed.
 *   - checkGstin: format, state code and the official mod-36 checksum (one copy, used by every tool)
 *   - problemMessage / statusLabel: a short, friendly message for every status code in English, Hindi and Kannada,
 *     so internal codes such as INVALID_FORMAT never reach the owner
 *   - maskGstin: "07PUT•••••••1Z9" for anything shown in chat (DPDP data minimisation)
 *
 * Why: owners type "GSTIN: 07PUT…", "my gstin is …" or "07 putxm 1153 m1z9". The agent passes their whole message,
 * and this module finds the number.
 */

// ================================================================ CONFIG

/**
 * Characters removed before searching: spaces (any whitespace), dashes, and the dots and slashes people put between
 * the parts of a GSTIN ("07.PUTXM.1153.M1Z9"). Earlier versions removed all punctuation, so dots and slashes are kept
 * as separators to keep those inputs working.
 */
const SEPARATOR_PATTERN = /[\s\-‐-―./]+/g;
/** GSTIN shape: 2-digit state, 5 letters + 4 digits + 1 letter (PAN), entity number (1-9 or A-Z), "Z", check character. */
const GSTIN_SHAPE_SOURCE = "[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]";
const GSTIN_PATTERN = new RegExp("^" + GSTIN_SHAPE_SOURCE + "$");
/** Valid GST state codes run from 01 to 38. */
const STATE_CODE_RANGE = { min: 1, max: 38 };
const STATE_CODE_LENGTH = 2;
/** Official GSTIN mod-36 checksum over the first 14 characters, weights alternating 1 and 2. */
const CHECKSUM_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHECKSUM_BASE = 36;
const CHECKSUM_INPUT_LENGTH = 14;
const CHECKSUM_WEIGHTS = [1, 2];

/**
 * Status codes. These are an interface (gstin_status outputs, playbook branches); they are never shown to the owner.
 * INVALID_FORMAT keeps its old name for the playbooks: it now means "no complete GSTIN in the message".
 */
const GSTIN_PROBLEM = {
  NO_GSTIN: "INVALID_FORMAT",
  SEVERAL_GSTINS: "MULTIPLE_GSTINS",
  INVALID_STATE: "INVALID_STATE",
  CHECKSUM_FAILED: "CHECKSUM_FAILED",
};
const LOOKUP_STATUS = { NOT_FOUND: "NOT_FOUND", FORMAT_OK: "FORMAT_OK" };
const REGISTRY_STATUS = { ACTIVE: "Active", CANCELLED: "Cancelled", SUSPENDED: "Suspended" };

/** Masking: show the first 5 and last 3 characters (state + start of PAN, and the tail), hide the rest. */
const MASK = {
  visiblePrefix: 5,
  visibleSuffix: 3,
  minimumHidden: 3,
  shortInputVisiblePrefix: 2,
  shortInputMaxLength: 8,
};
const MASK_CHARACTER = "•";
const LANGUAGES = ["en", "hi", "kn"];
const DEFAULT_LANGUAGE = "en";

// ================================================================ MESSAGES (all languages)
// Hindi and Kannada were written for this prototype; have native speakers review them before going live.

const GSTIN_MESSAGES = {
  en: {
    problems: {
      INVALID_FORMAT:
        "I couldn't find a complete GSTIN in that. A GSTIN has 15 characters, for example 07ABCDE1234F1Z5. Could you send it again?",
      MULTIPLE_GSTINS:
        "I can see {count} GSTINs in your message ({list}). Which one is for this business? Please send just that one.",
      INVALID_STATE: "The first two digits should be a state code (01–38). Could you check it?",
      CHECKSUM_FAILED: "The last character doesn't match, so there is probably a typo. Could you re-type the GSTIN?",
      NOT_FOUND: "The format is right, but this GSTIN isn't in the GST registry.",
    },
    unknownProblem: "Something about this GSTIN doesn't look right. Could you check it and send it again?",
    statusLabels: {
      Active: "Active",
      Cancelled: "Cancelled",
      Suspended: "Suspended",
      FORMAT_OK: "Format and checksum OK",
    },
    listJoiner: " and ",
  },
  hi: {
    problems: {
      INVALID_FORMAT:
        "इसमें मुझे पूरा GSTIN नहीं मिला। GSTIN में 15 अक्षर होते हैं, जैसे 07ABCDE1234F1Z5. एक बार फिर भेजेंगे?",
      MULTIPLE_GSTINS:
        "आपके मैसेज में {count} GSTIN दिख रहे हैं ({list})। इस बिज़नेस का कौन-सा है? कृपया सिर्फ़ वही भेजिए।",
      INVALID_STATE: "पहले दो अंक राज्य कोड (01–38) होने चाहिए। एक बार जाँच लेंगे?",
      CHECKSUM_FAILED: "आख़िरी अक्षर मेल नहीं खा रहा, शायद टाइपिंग में गलती है। GSTIN दोबारा लिखेंगे?",
      NOT_FOUND: "फ़ॉर्मेट सही है, पर यह GSTIN GST रजिस्ट्री में नहीं है।",
    },
    unknownProblem: "इस GSTIN में कुछ ठीक नहीं लग रहा। एक बार जाँचकर फिर भेजेंगे?",
    statusLabels: {
      Active: "सक्रिय (Active)",
      Cancelled: "रद्द (Cancelled)",
      Suspended: "निलंबित (Suspended)",
      FORMAT_OK: "फ़ॉर्मेट और चेकसम सही",
    },
    listJoiner: " और ",
  },
  kn: {
    problems: {
      INVALID_FORMAT:
        "ಇದರಲ್ಲಿ ಪೂರ್ಣ GSTIN ಸಿಗಲಿಲ್ಲ. GSTIN ನಲ್ಲಿ 15 ಅಕ್ಷರಗಳಿರುತ್ತವೆ, ಉದಾ: 07ABCDE1234F1Z5. ದಯವಿಟ್ಟು ಮತ್ತೆ ಕಳುಹಿಸಿ.",
      MULTIPLE_GSTINS:
        "ನಿಮ್ಮ ಸಂದೇಶದಲ್ಲಿ {count} GSTIN ಗಳಿವೆ ({list}). ಈ ವ್ಯಾಪಾರದ್ದು ಯಾವುದು? ದಯವಿಟ್ಟು ಅದನ್ನು ಮಾತ್ರ ಕಳುಹಿಸಿ.",
      INVALID_STATE: "ಮೊದಲ ಎರಡು ಅಂಕೆಗಳು ರಾಜ್ಯ ಕೋಡ್ (01–38) ಆಗಿರಬೇಕು. ದಯವಿಟ್ಟು ಒಮ್ಮೆ ಪರಿಶೀಲಿಸಿ.",
      CHECKSUM_FAILED: "ಕೊನೆಯ ಅಕ್ಷರ ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ, ಬಹುಶಃ ಟೈಪಿಂಗ್ ತಪ್ಪಾಗಿದೆ. ದಯವಿಟ್ಟು GSTIN ಅನ್ನು ಮತ್ತೆ ಟೈಪ್ ಮಾಡಿ.",
      NOT_FOUND: "ಫಾರ್ಮ್ಯಾಟ್ ಸರಿಯಾಗಿದೆ, ಆದರೆ ಈ GSTIN GST ನೋಂದಣಿಯಲ್ಲಿ ಇಲ್ಲ.",
    },
    unknownProblem: "ಈ GSTIN ನಲ್ಲಿ ಏನೋ ಸರಿಯಿಲ್ಲ ಎನಿಸುತ್ತದೆ. ದಯವಿಟ್ಟು ಪರಿಶೀಲಿಸಿ ಮತ್ತೆ ಕಳುಹಿಸಿ.",
    statusLabels: {
      Active: "ಸಕ್ರಿಯ (Active)",
      Cancelled: "ರದ್ದು (Cancelled)",
      Suspended: "ಅಮಾನತು (Suspended)",
      FORMAT_OK: "ಫಾರ್ಮ್ಯಾಟ್ ಮತ್ತು ಚೆಕ್‌ಸಮ್ ಸರಿ",
    },
    listJoiner: " ಮತ್ತು ",
  },
};

// ================================================================ LOGIC

function messagesFor(language) {
  return GSTIN_MESSAGES[LANGUAGES.indexOf(language) >= 0 ? language : DEFAULT_LANGUAGE];
}

/**
 * Finds every GSTIN-shaped run of 15 characters in free text, after removing separators and upper-casing.
 * @returns {string[]} distinct candidates, in the order they appear (the same GSTIN typed twice counts once)
 * @example findGstinCandidates("GSTIN: 07 putxm 1153 m1z9") // → ["07PUTXM1153M1Z9"]
 */
function findGstinCandidates(text) {
  const compacted = String(text === undefined || text === null ? "" : text)
    .toUpperCase()
    .replace(SEPARATOR_PATTERN, "");
  const matches = compacted.match(new RegExp(GSTIN_SHAPE_SOURCE, "g")) || [];
  return matches.filter((candidate, index) => matches.indexOf(candidate) === index);
}

/** Official GSTIN check character for the first 14 characters. */
function computeChecksumCharacter(firstFourteenCharacters) {
  let sum = 0;
  for (let i = 0; i < CHECKSUM_INPUT_LENGTH; i++) {
    const product =
      CHECKSUM_ALPHABET.indexOf(firstFourteenCharacters[i]) * CHECKSUM_WEIGHTS[i % CHECKSUM_WEIGHTS.length];
    sum += Math.floor(product / CHECKSUM_BASE) + (product % CHECKSUM_BASE);
  }
  return CHECKSUM_ALPHABET[(CHECKSUM_BASE - (sum % CHECKSUM_BASE)) % CHECKSUM_BASE];
}

/**
 * Checks one clean 15-character GSTIN. Returns "" when format, state code and checksum are fine, else the problem
 * code (INVALID_FORMAT, INVALID_STATE or CHECKSUM_FAILED).
 */
function checkGstin(gstin) {
  if (!GSTIN_PATTERN.test(gstin)) return GSTIN_PROBLEM.NO_GSTIN;
  const stateCode = parseInt(gstin.slice(0, STATE_CODE_LENGTH), 10);
  if (stateCode < STATE_CODE_RANGE.min || stateCode > STATE_CODE_RANGE.max) return GSTIN_PROBLEM.INVALID_STATE;
  if (computeChecksumCharacter(gstin.slice(0, CHECKSUM_INPUT_LENGTH)) !== gstin[CHECKSUM_INPUT_LENGTH]) {
    return GSTIN_PROBLEM.CHECKSUM_FAILED;
  }
  return "";
}

/**
 * Reads the GSTIN from the owner's message and checks it.
 * @returns {{ gstin: string, problem: string, candidates: string[] }}
 *   gstin is "" unless exactly one candidate was found. problem is "" when the GSTIN is usable, else a status code.
 * @example readGstin("my gstin is 07PUTXM1153M1Z9") // → { gstin: "07PUTXM1153M1Z9", problem: "", candidates: [...] }
 * @example readGstin("07PUTXM1153M1Z9 or 29OKAXP4077P1ZL") // → { gstin: "", problem: "MULTIPLE_GSTINS", ... }
 */
function readGstin(text) {
  const candidates = findGstinCandidates(text);
  if (candidates.length === 0) return { gstin: "", problem: GSTIN_PROBLEM.NO_GSTIN, candidates };
  if (candidates.length > 1) return { gstin: "", problem: GSTIN_PROBLEM.SEVERAL_GSTINS, candidates };
  return { gstin: candidates[0], problem: checkGstin(candidates[0]), candidates };
}

/** "07PUTXM1153M1Z9" → "07PUT•••••••1Z9". Never show a full GSTIN in chat or logs. */
function maskGstin(gstin) {
  if (!gstin || gstin.length <= MASK.shortInputMaxLength) {
    return gstin ? gstin.slice(0, MASK.shortInputVisiblePrefix) + MASK_CHARACTER.repeat(MASK.minimumHidden) : "";
  }
  const hiddenCount = Math.max(MASK.minimumHidden, gstin.length - MASK.visiblePrefix - MASK.visibleSuffix);
  return gstin.slice(0, MASK.visiblePrefix) + MASK_CHARACTER.repeat(hiddenCount) + gstin.slice(-MASK.visibleSuffix);
}

/**
 * The owner-facing message for a status code, in the owner's language. Unknown codes get a generic friendly line:
 * a code is never returned as text.
 * @param {string[]} [candidates] for MULTIPLE_GSTINS: listed masked
 */
function problemMessage(code, language, candidates) {
  const text = messagesFor(language);
  const template = text.problems[code] || text.unknownProblem;
  const list = (candidates || []).map(maskGstin).join(text.listJoiner);
  return template
    .split("{count}")
    .join(String((candidates || []).length))
    .split("{list}")
    .join(list);
}

/** True for the statuses the GST registry itself reports (Active, Cancelled, Suspended). */
function isRegistryStatus(status) {
  return Object.keys(REGISTRY_STATUS).some((key) => REGISTRY_STATUS[key] === status);
}

/** A status for display: registry statuses as words in the owner's language; problem codes as their message. */
function statusLabel(status, language) {
  const text = messagesFor(language);
  if (text.statusLabels[status]) return text.statusLabels[status];
  return problemMessage(status, language);
}

const GSTIN_INPUT_API = {
  GSTIN_PROBLEM,
  LOOKUP_STATUS,
  REGISTRY_STATUS,
  GSTIN_MESSAGES,
  findGstinCandidates,
  checkGstin,
  readGstin,
  maskGstin,
  problemMessage,
  isRegistryStatus,
  statusLabel,
};

  return GSTIN_INPUT_API;
})();
/** GST state names; records store the index in base 36. */
const STATE_NAMES = ["Andhra Pradesh", "Bihar", "Delhi", "Gujarat", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Punjab", "Rajasthan", "Tamil Nadu", "Telangana", "Uttar Pradesh", "West Bengal"];
/**
 * SIMULATED: mock GST registry from the case pack (synthetic, cannot match real taxpayers).
 * One record per line: GSTIN|legal name|trade name (blank = same as legal)|status A/C/S|constitution P/C/L|state index
 */
const REGISTRY_TEXT = "23QYBXS1811Q1ZD|Meera Kulkarni (Prop. Sahyadri Realty)|Sahyadri Realty|S|P|6\n37IHKXV5167L1ZS|Neha Kaur (Prop. Vindhya Tours & Travels)|Vindhya Tours & Travels|C|P|0\n29OKAXP4077P1ZL|Ishita Menon (Prop. Prime General Store)|Prime General Store|C|P|4\n29KAFXC8220C1ZG|Lakshmi Yadav (Prop. City Tours & Travels)|City Tours & Travels|C|P|4\n32WAHXG8645K1ZH|Neha Patel (Prop. Galaxy Medicals)|Galaxy Medicals|S|P|5\n27KYVXC5489I1ZX|Thomas Verma (Prop. Classic Packaging)|Classic Packaging|S|P|7\n29YAEXE0018X1Z6|Neha Gupta (Prop. Evergreen Opticals)|Evergreen Opticals|S|P|4\n27QQIXU3971M1Z3|Unity Tours & Travels Pvt Ltd||C|C|7\n23CWIXR4699P1ZZ|Ishita Menon (Prop. Royal Bakers)|Royal Bakers|C|P|6\n29PSZXE5591A1ZG|Rajesh Sheikh (Prop. Evergreen Hardware)|Evergreen Hardware|C|P|4\n23TMIXV3459Z1ZQ|Rajesh Sharma (Prop. Vindhya Stationers)|Vindhya Stationers|C|P|6\n33EHNXK1784C1ZW|Harpreet Khan (Prop. Krishna Stationers)|Krishna Stationers|C|P|a\n07FBUXP2624T1Z2|Prime Electronics Pvt Ltd||S|C|2\n27NGUXG1536L1Z6|Ganesh Fitness Pvt Ltd||C|C|7\n29NIHXK0626P1Z1|Prakash Gowda (Prop. Kaveri Hardware)|Kaveri Hardware|S|P|4\n29LVDXS5308A1ZZ|Kavita Verma (Prop. Sai Stationers)|Sai Stationers|C|P|4\n27IPZXN3759R1ZR|Rajesh Sheikh (Prop. Navkar General Store)|Navkar General Store|S|P|7\n07ESVXS6793Z1Z2|Vikram Khan (Prop. Saffron Diagnostics)|Saffron Diagnostics|S|P|2\n24LMGXS6096R1ZA|Rajesh Iyer (Prop. Star Mobile Care)|Star Mobile Care|S|P|3\n29QBUXG9051Y1Z9|Imran Sheikh (Prop. Galaxy Diagnostics)|Galaxy Diagnostics|C|P|4\n09UTAXG7703O1ZF|Anita Kulkarni (Prop. Galaxy Insurance Advisors)|Galaxy Insurance Advisors|S|P|c\n37WXVXC4856R1ZB|Arjun Iyer (Prop. Coral Unisex Salon)|Coral Unisex Salon|C|P|0\n27PKHXM2990R1ZE|Moonlight Kids Academy LLP||S|L|7\n29PUEXH0889L1Z8|Sunita Nair (Prop. Harmony Kids Academy)|Harmony Kids Academy|S|P|4\n29UKRXK4108M1ZL|Krishna & Associates Pvt Ltd||C|C|4\n07MRBXG9963M1ZG|Lakshmi Chauhan (Prop. Ganga Physio Clinic)|Ganga Physio Clinic|C|P|2\n29CWZXK3772W1ZB|Fatima Gowda (Prop. Kaveri Opticals)|Kaveri Opticals|C|P|4\n32HJJXE5083Y1ZR|Neha Banerjee (Prop. Evergreen Sweets)|Evergreen Sweets|C|P|5\n03BODXE2416A1ZK|Lakshmi Pillai (Prop. Evergreen Physio Clinic)|Evergreen Physio Clinic|C|P|8\n03NJEXR8045U1ZM|Divya Deshmukh (Prop. Royal Pharma Retail)|Royal Pharma Retail|S|P|8\n27NYEXA2663Z1ZT|Apex Tours & Travels LLP||C|L|7\n08JJQXM8788K1ZB|Amit Yadav (Prop. Modern Bakers)|Modern Bakers|C|P|9\n27UXVXB7893F1ZT|Blue Lotus Stays LLP||C|L|7\n07OASXE0025I1Z3|Prakash Iyer (Prop. Evergreen Tours & Travels)|Evergreen Tours & Travels|C|P|2\n33IMLXS7553A1ZC|Rajesh Khan (Prop. Saffron Insurance Advisors)|Saffron Insurance Advisors|C|P|a\n29CRQXC6805V1Z8|Shalini Iyer (Prop. Classic Fitness)|Classic Fitness|S|P|4\n37CARXA2860B1ZH|Joseph Bhat (Prop. Annapurna Hardware)|Annapurna Hardware|S|P|0\n27WYUXV2386N1Z3|Vindhya Dental Care LLP||C|L|7\n27SVRXP4743E1Z8|Anjali Kaur (Prop. Prime Design Studio)|Prime Design Studio|S|P|7\n36TDRXV3839T1Z5|Abdul Pillai (Prop. Vindhya General Store)|Vindhya General Store|C|P|b\n29KBXXN3993R1ZC|Shalini Mukherjee (Prop. Neelgiri Polymers)|Neelgiri Polymers|C|P|4\n23ZPSXL5449B1ZP|Ayesha Yadav (Prop. Lakshmi Opticals)|Lakshmi Opticals|S|P|6\n37ROMXH5761A1Z3|Harmony Kitchens Pvt Ltd||C|C|0\n24TEJXS0991W1ZE|Rekha Pillai (Prop. Sunrise Unisex Salon)|Sunrise Unisex Salon|C|P|3\n19ORHXA9881Z1ZI|Amrit Fashions LLP||C|L|d\n23YXMXN0068G1ZF|Neelgiri Insurance Advisors Pvt Ltd||S|C|6\n19GSPXM7318S1ZY|Rituparna Fernandes (Prop. Modern Unisex Salon)|Modern Unisex Salon|C|P|d\n27EIOXA8022D1Z0|Anita Shah (Prop. Amrit Stationers)|Amrit Stationers|S|P|7\n24ZTPXN8954W1Z1|Sourav Rao (Prop. New Medicals)|New Medicals|S|P|3\n19OKIXU7416K1ZM|Rajesh Gowda (Prop. Unity Dental Care)|Unity Dental Care|C|P|d\n27RMTXH9452I1ZG|Mary Sharma (Prop. Harmony Stationers)|Harmony Stationers|S|P|7\n33IDMXP3483N1Z9|Prime & Associates Pvt Ltd||C|C|a\n23VCVXB1574Z1ZK|Blue Lotus Design Studio LLP||C|L|6\n33CVRXO3340J1ZU|Om Fashions LLP||S|L|a\n32EEZXS9142M1ZZ|Saffron Tours & Travels Pvt Ltd||C|C|5\n27BGNXS0919Q1Z2|Farhan Gowda (Prop. Shree Stays)|Shree Stays|C|P|7\n03DCGXS8124I1Z0|Priya Mukherjee (Prop. Sunrise Sweets)|Sunrise Sweets|S|P|8\n03BWOXG8467V1ZX|Rituparna Kulkarni (Prop. Galaxy Boutique)|Galaxy Boutique|C|P|8\n36CHRXN9824I1Z3|Imran Singh (Prop. New Dental Care)|New Dental Care|C|P|b\n07UBGXS5732Q1ZX|Silver Oak Classes Pvt Ltd||S|C|2\n29MPXXN1267D1ZN|Kavita Khan (Prop. Navkar Medicals)|Navkar Medicals|S|P|4\n29SPJXB7358S1Z0|Anjali Gupta (Prop. Blue Lotus Boutique)|Blue Lotus Boutique|C|P|4\n29KEJXM8154O1ZW|Modern Packaging Pvt Ltd||C|C|4\n27NFFXA8598N1ZX|Joseph Das (Prop. Amrit Bake House)|Amrit Bake House|C|P|7\n29TYUXS9938G1Z8|Abdul Rao (Prop. Sunrise Stationers)|Sunrise Stationers|C|P|4\n27AKLXU3339W1ZE|Unity Packaging Pvt Ltd||C|C|7\n24FOXXO5936Q1Z6|Mary Chauhan (Prop. Orbit Kitchens)|Orbit Kitchens|C|P|3\n29VHJXM1063E1ZE|Metro Insurance Advisors LLP||C|L|4\n24UUQXL1774X1ZF|Lakshmi Insurance Advisors Pvt Ltd||C|C|3\n33JEXXN2129X1ZO|Neelgiri Kids Academy Pvt Ltd||C|C|a\n29PSRXA0739Z1ZP|Amrit Insurance Advisors Pvt Ltd||C|C|4\n29ECZXS4400X1ZL|Rahul Pandey (Prop. Silver Oak Medicals)|Silver Oak Medicals|C|P|4\n32FHPXT6817T1ZN|Karthik Gowda (Prop. Trinity Insurance Advisors)|Trinity Insurance Advisors|S|P|5\n33EMNXM0163C1ZW|Modern Foods Pvt Ltd||C|C|a\n27SMFXE7544V1Z9|Arjun Pandey (Prop. Evergreen Realty)|Evergreen Realty|C|P|7\n08TEYXC5610Q1ZV|Pooja Deshmukh (Prop. Coral Hardware)|Coral Hardware|C|P|9\n27DVFXG2484X1Z3|Kavita Singh (Prop. Green Leaf Mobile Care)|Green Leaf Mobile Care|S|P|7\n29TWWXK9615G1ZS|Farhan Singh (Prop. Kaveri General Store)|Kaveri General Store|C|P|4\n29VXPXA6650E1ZC|Apex Fashions Pvt Ltd||S|C|4\n37QQZXO1943A1ZO|Fatima Bhat (Prop. Orbit Mobile Care)|Orbit Mobile Care|S|P|0\n24ULRXO0224M1ZW|Imran Deshmukh (Prop. Om Sweets)|Om Sweets|C|P|3\n03AJNXM0356S1Z9|Rituparna D'Souza (Prop. Modern Electronics)|Modern Electronics|S|P|8\n27RCHXU6940M1ZX|Karthik Nair (Prop. Unity Packaging)|Unity Packaging|C|P|7\n29XGPXA2838W1ZA|Apex Physio Clinic Pvt Ltd||S|C|4\n37GCAXB6355H1Z7|Harpreet Chauhan (Prop. Blue Lotus Boutique)|Blue Lotus Boutique|S|P|0\n09JAXXN1947F1ZG|Sneha Kaur (Prop. New Stationers)|New Stationers|C|P|c\n07TFDXM6438Z1ZC|Moonlight Physio Clinic Pvt Ltd||C|C|2\n10MBEXN5162L1ZZ|Farhan Gowda (Prop. Navkar Boutique)|Navkar Boutique|S|P|1\n27ZBFXG7549V1ZI|Zoya Pandey (Prop. Green Leaf Pharma Retail)|Green Leaf Pharma Retail|C|P|7\n24VWPXC5318F1ZP|City Textiles Pvt Ltd||C|C|3\n07YJXXS6557M1ZU|Pooja Kaur (Prop. Star & Associates)|Star & Associates|C|P|2\n03UFDXM5300H1Z1|Metro Bake House Pvt Ltd||C|C|8\n19YIBXS8513E1Z2|Ishita Das (Prop. Sahyadri Unisex Salon)|Sahyadri Unisex Salon|S|P|d\n27UZSXS0499L1ZA|Vikram Nair (Prop. Shree Bakers)|Shree Bakers|S|P|7\n08VNHXS2029I1ZS|Rohan Nair (Prop. Sahyadri Opticals)|Sahyadri Opticals|C|P|9\n27DYBXN4318P1ZH|Navkar Electronics Pvt Ltd||C|C|7\n23PBBXO1449K1ZV|Om Dental Care Pvt Ltd||S|C|6\n29QFZXP5525E1ZX|Naveen Verma (Prop. Prime Classes)|Prime Classes|C|P|4\n07TCUXM5961B1ZC|Anita Yadav (Prop. Metro Hardware)|Metro Hardware|C|P|2\n07RXZXM7162J1ZO|Suresh Das (Prop. Modern Pharma Retail)|Modern Pharma Retail|S|P|2\n29VFBXK3405U1ZX|Neha Das (Prop. Kaveri & Associates)|Kaveri & Associates|C|P|4\n37WJIXC2825D1ZK|Imran Agarwal (Prop. Classic General Store)|Classic General Store|C|P|0\n29WBNXK6905C1ZI|Harpreet Patel (Prop. Krishna Hardware)|Krishna Hardware|S|P|4\n29KVIXC5637Z1ZO|Imran Mishra (Prop. Coral General Store)|Coral General Store|C|P|4\n36IMMXN6222I1Z5|Neelgiri Kitchens Pvt Ltd||C|C|b\n24KFTXS4562O1ZS|Anita Gowda (Prop. Shree Stationers)|Shree Stationers|C|P|3\n32BOTXB4918X1ZK|Balaji Tours & Travels LLP||C|L|5\n19KMFXS6409G1Z1|Sahyadri & Associates Pvt Ltd||C|C|d\n27HPBXT4330O1ZV|Trinity Kitchens Pvt Ltd||C|C|7\n27BNLXG5426W1ZL|Ganga & Associates LLP||S|L|7\n23ICVXB7267L1ZF|Harpreet Pillai (Prop. Balaji Auto Components)|Balaji Auto Components|C|P|6\n33HBSXK1864P1ZC|Kaveri Woodcraft LLP||S|L|a\n24GBUXG1949T1Z4|Fatima Banerjee (Prop. Ganga Sweets)|Ganga Sweets|S|P|3\n27VDVXG3305U1ZQ|Sourav Fernandes (Prop. Galaxy Bakers)|Galaxy Bakers|S|P|7\n33VQKXA5818I1ZX|Imran Mishra (Prop. Amrit Sweets)|Amrit Sweets|C|P|a\n29NBUXC9770C1ZF|Arjun Banerjee (Prop. City Kids Academy)|City Kids Academy|C|P|4\n09WEIXN0541K1ZB|Rahul Kaur (Prop. Navkar Insurance Advisors)|Navkar Insurance Advisors|C|P|c\n27MSKXA7203E1ZD|Venkat Chauhan (Prop. Amrit Unisex Salon)|Amrit Unisex Salon|S|P|7\n29UWNXN8694F1ZM|New Pharma Retail LLP||C|L|4\n27RCKXH3354W1ZT|Harmony Realty Pvt Ltd||S|C|7\n24SIBXS2458S1ZO|Sunita Nair (Prop. Sahyadri Design Studio)|Sahyadri Design Studio|S|P|3\n23LPTXB3405I1ZD|Abdul Gowda (Prop. Balaji Bakers)|Balaji Bakers|C|P|6\n27XFCXM0271K1ZE|Pooja Reddy (Prop. Moonlight Stationers)|Moonlight Stationers|S|P|7\n09SSGXA8200C1ZE|Meera Gowda (Prop. Annapurna Medicals)|Annapurna Medicals|S|P|c\n24CBZXT7192Q1ZP|Ishita Joshi (Prop. Trinity Hardware)|Trinity Hardware|S|P|3\n07CUZXA8929N1Z4|Pooja Nair (Prop. Amrit Medicals)|Amrit Medicals|S|P|2\n03ODMXS1407Q1ZD|Suresh Shah (Prop. Saffron Unisex Salon)|Saffron Unisex Salon|S|P|8\n27HOQXG7154I1ZV|Sunita Agarwal (Prop. Ganga Mobile Care)|Ganga Mobile Care|S|P|7\n07LFEXA2234W1ZF|Priya Shah (Prop. Amrit Auto Components)|Amrit Auto Components|C|P|2\n29SBQXK8673J1ZR|Priya Das (Prop. Kaveri Sweets)|Kaveri Sweets|S|P|4\n29NSXXR4493O1ZF|Farhan Iyer (Prop. Riddhi Classes)|Riddhi Classes|C|P|4\n23ODRXH9901J1ZG|Mary D'Souza (Prop. Harmony Fitness)|Harmony Fitness|C|P|6\n32LEFXS2692K1ZF|Naveen Kulkarni (Prop. Sunrise Tours & Travels)|Sunrise Tours & Travels|C|P|5\n33NAMXA7003O1ZZ|Imran Patel (Prop. Annapurna Kitchens)|Annapurna Kitchens|C|P|a\n27PKSXR6228H1ZO|Vikram Reddy (Prop. Royal General Store)|Royal General Store|C|P|7\n36HXAXV8485I1Z3|Vindhya Realty LLP||S|L|b\n19WRHXA6022V1Z7|Joseph Mukherjee (Prop. Annapurna Boutique)|Annapurna Boutique|C|P|d\n23LVJXH4494W1ZU|Naveen Fernandes (Prop. Harmony Fashions)|Harmony Fashions|S|P|6\n19VITXN0385W1ZT|Kavita Chauhan (Prop. Navkar Insurance Advisors)|Navkar Insurance Advisors|C|P|d\n07YZQXS8772V1ZI|Joseph Yadav (Prop. Sahyadri Sweets)|Sahyadri Sweets|S|P|2\n33SOAXG6361H1ZB|Ganga Tours & Travels LLP||C|L|a\n10QFNXT1832Z1ZN|Gurpreet Chauhan (Prop. Trinity Fitness)|Trinity Fitness|C|P|1\n33MWBXU7113K1ZN|Prakash Menon (Prop. Unity Legal Associates)|Unity Legal Associates|C|P|a\n27RIXXO8920N1Z8|Rajesh Mukherjee (Prop. Om Opticals)|Om Opticals|C|P|7\n24HJIXS3251C1ZU|Sunrise Textiles Pvt Ltd||S|C|3\n07TQUXC0519D1Z5|Vikram Mukherjee (Prop. Coral General Store)|Coral General Store|C|P|2\n36EWDXN6759Q1Z0|Fatima Mishra (Prop. Neelgiri Diagnostics)|Neelgiri Diagnostics|C|P|b\n27QFAXS9539I1Z0|Saffron & Associates LLP||C|L|7\n27GVMXU9097U1Z6|Zoya Sharma (Prop. Unity Bakers)|Unity Bakers|C|P|7\n08YAIXE4604L1ZM|Vikram Singh (Prop. Evergreen Boutique)|Evergreen Boutique|S|P|9\n37ZCQXT2261P1ZK|Neha Sharma (Prop. Trinity Fitness)|Trinity Fitness|S|P|0\n09BNDXL1317U1Z0|Lakshmi Design Studio LLP||S|L|c\n29LIVXB9114F1ZA|Balaji Realty Pvt Ltd||C|C|4\n24INOXG5008Q1ZZ|Gurpreet Iyer (Prop. Ganesh Diagnostics)|Ganesh Diagnostics|S|P|3\n07WMJXC4558B1ZA|Classic Auto Components Pvt Ltd||S|C|2\n36KXJXN2100W1Z7|Shalini Chauhan (Prop. New Fitness)|New Fitness|C|P|b\n37HRHXH4883M1ZI|Anjali Das (Prop. Harmony Bakers)|Harmony Bakers|C|P|0\n27VDOXS3065T1ZE|Sunrise Tours & Travels LLP||S|L|7\n23UVHXG5337G1ZT|Neha Banerjee (Prop. Green Leaf Boutique)|Green Leaf Boutique|C|P|6\n09RKXXR1896I1Z4|Royal Fashions LLP||C|L|c\n33MNPXM2567K1ZR|Abdul Agarwal (Prop. Modern Legal Associates)|Modern Legal Associates|C|P|a\n27DSAXO9692U1ZW|Sneha Verma (Prop. Orbit Unisex Salon)|Orbit Unisex Salon|C|P|7\n27UTKXG3826A1Z0|Abdul Patel (Prop. Green Leaf Boutique)|Green Leaf Boutique|C|P|7\n29FVQXB7146P1Z6|Mary Patel (Prop. Balaji Stays)|Balaji Stays|C|P|4\n27AGSXC8732N1Z9|Joseph Bhat (Prop. City & Associates)|City & Associates|C|P|7\n27SXJXS1998E1ZY|Sai Woodcraft LLP||S|L|7\n29NORXA3515H1Z4|Meera Rao (Prop. Apex Unisex Salon)|Apex Unisex Salon|S|P|4\n03MTGXN7717R1ZA|Manoj Banerjee (Prop. Navkar Sweets)|Navkar Sweets|C|P|8\n09NCIXS3154G1ZL|Ayesha Pandey (Prop. Saffron & Associates)|Saffron & Associates|C|P|c\n29OJCXH9419E1ZC|Prakash Menon (Prop. Harmony Fitness)|Harmony Fitness|S|P|4\n23TNKXU2583A1Z3|Ishita Verma (Prop. Unity Woodcraft)|Unity Woodcraft|C|P|6\n29PJEXP8493V1ZU|Karthik Mishra (Prop. Prime Legal Associates)|Prime Legal Associates|C|P|4\n10GSVXS8844K1ZB|Naveen Fernandes (Prop. Sahyadri Auto Components)|Sahyadri Auto Components|C|P|1\n19TBTXM6768S1Z4|Moonlight Electronics Pvt Ltd||C|C|d\n10CTKXG0240M1ZM|Sneha Reddy (Prop. Green Leaf Polymers)|Green Leaf Polymers|C|P|1\n27LIGXG4177J1ZA|Divya Pandey (Prop. Green Leaf Fitness)|Green Leaf Fitness|S|P|7\n23JEUXC9102R1ZC|Coral Auto Components Pvt Ltd||C|C|6\n36KHOXG2931Q1Z3|Anita Joshi (Prop. Ganga General Store)|Ganga General Store|C|P|b\n07TGOXZ4322L1ZR|Zoya Bhat (Prop. Zenith Mobile Care)|Zenith Mobile Care|C|P|2\n27XEUXG9940U1Z2|Anjali Mishra (Prop. Ganga Realty)|Ganga Realty|C|P|7\n27JUFXG3289U1Z0|Sneha Verma (Prop. Green Leaf Opticals)|Green Leaf Opticals|C|P|7\n03VGMXO5999B1Z2|Imran Menon (Prop. Om Boutique)|Om Boutique|S|P|8\n33VRPXP1878C1ZK|Amit Verma (Prop. Pearl Legal Associates)|Pearl Legal Associates|C|P|a\n24TJDXS8045J1ZY|Ishita Gowda (Prop. Star Insurance Advisors)|Star Insurance Advisors|C|P|3\n33SHWXK1252B1ZO|Pooja Verma (Prop. Kaveri General Store)|Kaveri General Store|S|P|a\n27BITXS5367Z1ZX|Silver Oak Electronics Pvt Ltd||C|C|7\n07MTIXG6421N1ZO|Ganesh Physio Clinic Pvt Ltd||S|C|2\n19YQUXN7122J1Z2|Anita Gowda (Prop. Navkar Dental Care)|Navkar Dental Care|C|P|d\n29LRWXG9484B1ZD|Ishita Verma (Prop. Ganga Packaging)|Ganga Packaging|S|P|4\n37HPWXM1842I1ZP|Suresh Nair (Prop. Metro Hardware)|Metro Hardware|C|P|0\n36FZPXC4716T1Z1|Amit Mukherjee (Prop. City Fitness)|City Fitness|S|P|b\n27QJCXK4705K1ZB|Krishna Stays LLP||C|L|7\n10QMTXE7824M1ZV|Abdul Singh (Prop. Evergreen Legal Associates)|Evergreen Legal Associates|C|P|1\n07PHWXG6510F1ZF|Ganesh Bake House Pvt Ltd||S|C|2\n29FAJXM2713F1Z7|Metro Pharma Retail Pvt Ltd||C|C|4\n29GPKXS4274W1ZT|Fatima Bhat (Prop. Sai Hardware)|Sai Hardware|S|P|4\n33BCDXU0418G1ZG|Arjun Chauhan (Prop. Unity Auto Components)|Unity Auto Components|S|P|a\n27RLXXR4709T1ZS|Joseph Fernandes (Prop. Royal Physio Clinic)|Royal Physio Clinic|S|P|7\n32CJJXG6393E1ZS|Rekha D'Souza (Prop. Ganesh Stays)|Ganesh Stays|S|P|5\n36TMTXS5251J1ZD|Sneha Pillai (Prop. Sahyadri General Store)|Sahyadri General Store|S|P|b\n19FTDXM8226J1ZQ|Metro Dental Care Pvt Ltd||S|C|d\n29JONXV6953G1ZD|Vindhya Bake House Pvt Ltd||C|C|4\n24BDFXS9342W1ZZ|Pooja Sheikh (Prop. Sai General Store)|Sai General Store|C|P|3\n24WIIXO0706M1Z6|Rohan Bhat (Prop. Om General Store)|Om General Store|C|P|3\n03VFWXG9146G1Z5|Ayesha Das (Prop. Galaxy General Store)|Galaxy General Store|S|P|8\n32LQEXO5899W1ZS|Prakash Banerjee (Prop. Orbit Sweets)|Orbit Sweets|C|P|5\n19BSJXG8517K1ZS|Fatima Khan (Prop. Galaxy Medicals)|Galaxy Medicals|C|P|d\n32TDCXC1707M1Z2|Deepak Bhat (Prop. Coral Medicals)|Coral Medicals|S|P|5\n27CVCXS5602Y1Z3|Sunrise Design Studio LLP||S|L|7\n33LDUXA9181Z1ZI|Apex Electronics Pvt Ltd||C|C|a\n23DGHXS6478W1ZK|Priya Joshi (Prop. Saffron Sweets)|Saffron Sweets|C|P|6\n24RAGXO6276A1ZY|Naveen Nair (Prop. Orbit Mobile Care)|Orbit Mobile Care|C|P|3\n36MJCXK2412O1ZG|Amit Pillai (Prop. Kaveri Opticals)|Kaveri Opticals|C|P|b\n24GVGXL6996N1Z3|Imran Fernandes (Prop. Lakshmi Printers)|Lakshmi Printers|S|P|3\n33NBEXA5396V1Z7|Suresh Yadav (Prop. Apex & Associates)|Apex & Associates|C|P|a\n33GXSXR5429K1Z6|Kavita Banerjee (Prop. Royal Stationers)|Royal Stationers|C|P|a\n27HBGXO8842P1Z5|Orbit Electronics Pvt Ltd||S|C|7\n27ZWIXS0441U1ZL|Suresh Yadav (Prop. Sahyadri Unisex Salon)|Sahyadri Unisex Salon|C|P|7\n36TKMXR5479W1ZL|Suresh Pandey (Prop. Riddhi Diagnostics)|Riddhi Diagnostics|S|P|b\n24ZSNXK5897M1ZO|Kaveri Bake House Pvt Ltd||S|C|3\n07HQBXM3520Y1ZK|Zoya Sheikh (Prop. Metro Medicals)|Metro Medicals|C|P|2\n07SYJXC0851L1ZH|Joseph Rao (Prop. City Boutique)|City Boutique|C|P|2\n23XVDXC7863H1ZL|City Legal Associates Pvt Ltd||C|C|6\n33RHSXM1976C1ZA|Anjali Banerjee (Prop. Metro Classes)|Metro Classes|C|P|a\n29RNDXS8639C1ZP|Silver Oak Physio Clinic Pvt Ltd||C|C|4\n24WIAXB0815W1Z5|Blue Lotus Woodcraft Pvt Ltd||C|C|3\n27CWZXB2676D1ZQ|Prakash Bhat (Prop. Blue Lotus Mobile Care)|Blue Lotus Mobile Care|C|P|7\n36XCUXM5897S1ZX|Modern Stays Pvt Ltd||C|C|b\n32AFHXS5568F1ZS|Shree Classes Pvt Ltd||S|C|5\n33YHQXS6275Z1ZM|Rituparna Patel (Prop. Saffron Sweets)|Saffron Sweets|C|P|a\n10WQKXK8321Q1ZI|Joseph Rao (Prop. Kaveri Mobile Care)|Kaveri Mobile Care|S|P|1\n33GQHXL2135V1ZQ|Anjali Sheikh (Prop. Lakshmi Mobile Care)|Lakshmi Mobile Care|S|P|a\n10KEFXS8866B1ZT|Rajesh Sharma (Prop. Shree Physio Clinic)|Shree Physio Clinic|S|P|1\n19UPSXP7949M1ZJ|Divya Gowda (Prop. Prime Stationers)|Prime Stationers|C|P|d\n24PITXK2108D1ZP|Kaveri Dental Care Pvt Ltd||C|C|3\n27VOQXA1669W1ZV|Rajesh Joshi (Prop. Apex Unisex Salon)|Apex Unisex Salon|C|P|7\n07EKIXC6601U1Z6|Imran Gupta (Prop. City Design Studio)|City Design Studio|S|P|2\n24NDYXN6883W1Z1|Navkar Insurance Advisors Pvt Ltd||S|C|3\n23PPSXS9906X1ZH|Anjali Verma (Prop. Sai General Store)|Sai General Store|C|P|6\n29GUHXO8952Z1ZB|Abdul Bhat (Prop. Orbit Textiles)|Orbit Textiles|S|P|4\n33GGWXR4592N1ZP|Joseph Das (Prop. Royal Dental Care)|Royal Dental Care|S|P|a\n24BJMXG6304X1Z1|Galaxy Pharma Retail Pvt Ltd||C|C|3\n37OXMXZ3253C1ZB|Gurpreet Kaur (Prop. Zenith Bakers)|Zenith Bakers|S|P|0\n27PABXM1024P1ZU|Gurpreet Iyer (Prop. Modern Realty)|Modern Realty|C|P|7\n08RZYXS1979U1ZM|Divya Mukherjee (Prop. Sai Medicals)|Sai Medicals|C|P|9\n27CXWXS0320D1ZX|Rohan Iyer (Prop. Saffron Auto Components)|Saffron Auto Components|C|P|7\n33GUHXN0161K1Z4|Ayesha Patel (Prop. New Mobile Care)|New Mobile Care|C|P|a\n27TZFXM1216B1ZY|Deepak Patel (Prop. Metro Realty)|Metro Realty|C|P|7\n23OJMXS7818Z1ZX|Amit Sharma (Prop. Sai Auto Components)|Sai Auto Components|S|P|6\n08ETYXE7309X1ZR|Rekha Verma (Prop. Evergreen Stationers)|Evergreen Stationers|C|P|9\n27TGVXC7639C1Z6|Ayesha Kaur (Prop. Coral Bakers)|Coral Bakers|C|P|7\n07LYRXT3271B1ZG|Harpreet Agarwal (Prop. Trinity Stationers)|Trinity Stationers|S|P|2\n08XMMXP5228D1ZU|Gurpreet Rao (Prop. Prime Unisex Salon)|Prime Unisex Salon|C|P|9\n19FOTXO7660O1Z4|Anjali Agarwal (Prop. Om Mobile Care)|Om Mobile Care|C|P|d\n23HFAXS8866V1ZN|Fatima Das (Prop. Silver Oak Pharma Retail)|Silver Oak Pharma Retail|S|P|6\n29PTBXP7467P1ZT|Pearl Diagnostics Pvt Ltd||C|C|4\n07EHLXH5388Q1ZV|Harmony Design Studio Pvt Ltd||C|C|2\n07GOCXG9273O1ZS|Galaxy Insurance Advisors LLP||C|L|2\n36WKAXP7872S1Z3|Prime Dental Care LLP||C|L|b\n32MMJXP5816J1Z2|Pearl Realty Pvt Ltd||C|C|5\n36SDMXT7959U1ZY|Priya Sheikh (Prop. Trinity General Store)|Trinity General Store|S|P|b\n37JXBXN9414M1ZB|Anjali Kulkarni (Prop. New Opticals)|New Opticals|S|P|0\n07EHCXG5083U1Z5|Ganga Electronics LLP||C|L|2\n36GNEXM4470I1Z8|Ayesha Pillai (Prop. Moonlight Mobile Care)|Moonlight Mobile Care|C|P|b\n27KNFXA4620I1ZM|Rituparna Patel (Prop. Amrit Kitchens)|Amrit Kitchens|C|P|7\n33LEFXM6212E1Z8|Sneha Patel (Prop. Modern Boutique)|Modern Boutique|C|P|a\n08ZXXXP0967K1ZC|Pearl Foods Pvt Ltd||S|C|9\n27ZWYXR2491Z1ZI|Riddhi & Associates Pvt Ltd||S|C|7";
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
