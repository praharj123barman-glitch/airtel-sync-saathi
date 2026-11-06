/*
 * udyam_input.js: reads a Udyam registration number out of whatever the owner typed, checks its format, masks it and
 * explains any problem in plain words (SHARED MODULE; the build embeds it unchanged in verify_udyam and
 * onboard_from_gstin, so there is one implementation, as gstin_input.js is for GSTINs).
 *
 * What it does:
 *   - readUdyam("my udyam is UDYAM-KL-00-3078801") → { udyamNumber: "UDYAM-KL-00-3078801", problem: "",
 *     candidates: ["UDYAM-KL-00-3078801"] }. Letters are upper-cased and everything but letters and digits is
 *     removed, then every Udyam-shaped run is collected. Zero or several different numbers are reported as
 *     problems, never guessed.
 *   - maskUdyam: "UDYAM-KL-••-•••8801" for anything shown in chat (DPDP data minimisation)
 *   - mentionsUdyam: whether a message is about a Udyam number at all (so onboarding can tell "no GSTIN, here is my
 *     Udyam number" from a mistyped GSTIN)
 *   - problemMessage: a short, friendly message for every problem code in English, Hindi and Kannada
 *
 * Why: owners without a GSTIN can start with their Udyam number (STRATEGY.md §12). They type "UDYAM-KL-00-3078801",
 * "udyam kl 00 3078801" or "my Udyam no. is …"; the agent passes their whole message and this module finds it.
 * Sample data: the case's Udyam numbers use district code 00, which doesn't exist, so none can match a real one.
 */

// ================================================================ CONFIG

/** "UDYAM" + 2-letter state + 2-digit district + 7-digit serial, once spaces, dashes and other punctuation are gone. */
// The serial must not be followed by another digit: "…-30788011" (one digit too many) is a typo to report, never the
// different, registered number "…-3078801". Found by comparing the old anchored check with this reader.
const UDYAM_SHAPE_SOURCE = "UDYAM([A-Z]{2})(\\d{2})(\\d{7})(?!\\d)";
/** Masking shows the state and the last 4 serial digits only (same as verify_udyam always did). */
const MASK_VISIBLE_SERIAL_DIGITS = 4;
const MASK_CHARACTER = "•";
/** Words that show the owner is talking about Udyam (English, Hindi and Kannada script). */
const UDYAM_WORD_PATTERN = /udyam|उद्यम|ಉದ್ಯಮ/i;

/** Problem codes. These are an interface (udyam_status outputs, playbook branches); never shown to the owner. */
const UDYAM_PROBLEM = { NO_UDYAM: "INVALID_FORMAT", SEVERAL_UDYAM: "MULTIPLE_UDYAM" };
const LANGUAGES = ["en", "hi", "kn"];
const DEFAULT_LANGUAGE = "en";

// ================================================================ MESSAGES (all languages)
// Hindi and Kannada were written for this prototype; have native speakers review them before going live.

const UDYAM_MESSAGES = {
  en: {
    INVALID_FORMAT:
      "I couldn't find a complete Udyam number in that. It looks like UDYAM-DL-00-1234567. Could you send it again?",
    MULTIPLE_UDYAM:
      "I can see {count} Udyam numbers in your message. Which one is for this business? Please send just that one.",
    unknownProblem: "Something about this Udyam number doesn't look right. Could you check it and send it again?",
  },
  hi: {
    INVALID_FORMAT:
      "इसमें मुझे पूरा Udyam नंबर नहीं मिला। यह कुछ ऐसा होता है: UDYAM-DL-00-1234567. एक बार फिर भेजेंगे?",
    MULTIPLE_UDYAM: "आपके मैसेज में {count} Udyam नंबर दिख रहे हैं। इस बिज़नेस का कौन-सा है? कृपया सिर्फ़ वही भेजिए।",
    unknownProblem: "इस Udyam नंबर में कुछ ठीक नहीं लग रहा। एक बार जाँचकर फिर भेजेंगे?",
  },
  kn: {
    INVALID_FORMAT:
      "ಇದರಲ್ಲಿ ಪೂರ್ಣ Udyam ಸಂಖ್ಯೆ ಸಿಗಲಿಲ್ಲ. ಇದು ಹೀಗಿರುತ್ತದೆ: UDYAM-DL-00-1234567. ದಯವಿಟ್ಟು ಮತ್ತೆ ಕಳುಹಿಸಿ.",
    MULTIPLE_UDYAM: "ನಿಮ್ಮ ಸಂದೇಶದಲ್ಲಿ {count} Udyam ಸಂಖ್ಯೆಗಳಿವೆ. ಈ ವ್ಯಾಪಾರದ್ದು ಯಾವುದು? ದಯವಿಟ್ಟು ಅದನ್ನು ಮಾತ್ರ ಕಳುಹಿಸಿ.",
    unknownProblem: "ಈ Udyam ಸಂಖ್ಯೆಯಲ್ಲಿ ಏನೋ ಸರಿಯಿಲ್ಲ ಎನಿಸುತ್ತದೆ. ದಯವಿಟ್ಟು ಪರಿಶೀಲಿಸಿ ಮತ್ತೆ ಕಳುಹಿಸಿ.",
  },
};

// ================================================================ LOGIC

/** Every different Udyam number in the text, in the canonical form "UDYAM-KL-00-3078801". */
function findUdyamCandidates(text) {
  const compactText = String(text === undefined || text === null ? "" : text)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  const candidates = [];
  const pattern = new RegExp(UDYAM_SHAPE_SOURCE, "g");
  let match = pattern.exec(compactText);
  while (match) {
    const udyamNumber = "UDYAM-" + match[1] + "-" + match[2] + "-" + match[3];
    if (candidates.indexOf(udyamNumber) < 0) candidates.push(udyamNumber);
    match = pattern.exec(compactText);
  }
  return candidates;
}

/**
 * Reads a Udyam number out of the owner's message. Returns { udyamNumber, problem, candidates }: problem is "" when
 * exactly one number was found, else a UDYAM_PROBLEM code (udyamNumber is then "").
 */
function readUdyam(text) {
  const candidates = findUdyamCandidates(text);
  if (candidates.length === 1) return { udyamNumber: candidates[0], problem: "", candidates };
  return {
    udyamNumber: "",
    problem: candidates.length === 0 ? UDYAM_PROBLEM.NO_UDYAM : UDYAM_PROBLEM.SEVERAL_UDYAM,
    candidates,
  };
}

/** "UDYAM-KL-00-3078801" → "UDYAM-KL-••-•••8801"; "" for anything that isn't a canonical Udyam number. */
function maskUdyam(udyamNumber) {
  const parts = String(udyamNumber || "").match(/^UDYAM-([A-Z]{2})-(\d{2})-(\d{7})$/);
  if (!parts) return "";
  return (
    "UDYAM-" +
    parts[1] +
    "-" +
    MASK_CHARACTER.repeat(parts[2].length) +
    "-" +
    MASK_CHARACTER.repeat(parts[3].length - MASK_VISIBLE_SERIAL_DIGITS) +
    parts[3].slice(-MASK_VISIBLE_SERIAL_DIGITS)
  );
}

/** True when the message is about Udyam: it says "Udyam" (any script) or holds a Udyam-shaped number. */
function mentionsUdyam(text) {
  return UDYAM_WORD_PATTERN.test(String(text || "")) || findUdyamCandidates(text).length > 0;
}

/** The owner-facing message for a problem code, in the owner's language (English if unknown). */
function problemMessage(code, language, candidates) {
  const messages = UDYAM_MESSAGES[LANGUAGES.indexOf(language) >= 0 ? language : DEFAULT_LANGUAGE];
  const template = messages[code] || messages.unknownProblem;
  return template.split("{count}").join(String((candidates || []).length));
}

export const UDYAM_INPUT_API = {
  UDYAM_PROBLEM,
  UDYAM_MESSAGES,
  readUdyam,
  maskUdyam,
  mentionsUdyam,
  problemMessage,
};
