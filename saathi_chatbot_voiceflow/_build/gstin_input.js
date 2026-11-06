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

export const GSTIN_INPUT_API = {
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
