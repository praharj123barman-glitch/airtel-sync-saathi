/*
 * consent_manager.js: Voiceflow function tool "consent_manager" (TEMPLATE; the build embeds _build/consent_rules.js).
 *
 * What it does, in four modes:
 *   - "show" (default): the consent screen in the owner's language: three SEPARATE purposes (registry lookup, KYC
 *     verification, marketing), each with its own yes/no, plus how to withdraw
 *   - "record": saves the owner's explicit answers in the consent record (JSON, with history and timestamps)
 *   - "withdraw": withdraws one purpose and says what that changes
 *   - "check": reports what the record allows (for playbooks before a lookup or a document read)
 *
 * How it fits: playbook 0 shows it before any GSTIN lookup (registry_lookup must be yes for onboard_from_gstin);
 * playbook B before any document or ID (kyc_verification must be yes); offers need marketing = yes. The record goes
 * to the Google Sheet (consent_* columns) and travels with the conversation (consent_record_json).
 */

/**
 * Voiceflow entry point.
 *
 * @param {{inputVars?: {mode?: string, lang?: string, consent_record_json?: string, registry_lookup?: string,
 *   kyc_verification?: string, marketing?: string, purpose?: string, show_card?: string}}} args
 * @returns {{outputVars: Object, trace: Array}}  Every declared output, always; `error` on failure.
 * @example
 *   await main({ inputVars: { mode: "record", registry_lookup: "yes", kyc_verification: "yes", marketing: "no" } })
 *   // → consent_registry_lookup true, consent_marketing false, consent_record_json with timestamps
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const language = detectLanguage(inputVars.lang);
  const text = consent.textFor(language);
  const outputVars = createEmptyOutputs();
  try {
    const mode = String(inputVars.mode || MODE.SHOW)
      .trim()
      .toLowerCase();
    let record = consent.parseRecord(inputVars.consent_record_json);
    let message = "";
    if (mode === MODE.SHOW) {
      const screen = consent.consentScreen(language);
      outputVars.consent_screen_text = screen.chatText;
      outputVars.consent_options_json = JSON.stringify(
        screen.purposes.map((purpose) => ({
          id: purpose.id,
          label: purpose.label,
          yes: screen.yesLabel,
          no: screen.noLabel,
        })),
      );
      message = screen.chatText;
    } else if (mode === MODE.RECORD) {
      record = consent.recordConsent(record, {
        registry_lookup: inputVars.registry_lookup,
        kyc_verification: inputVars.kyc_verification,
        marketing: inputVars.marketing,
      });
      message = consent.describeRecord(record, language);
    } else if (mode === MODE.WITHDRAW) {
      const purpose = consent.purposeFromText(inputVars.purpose);
      if (!purpose) {
        message = text.unknownPurpose;
      } else {
        record = consent.withdrawConsent(record, purpose);
        message = text.withdrawn[purpose];
      }
    } else if (mode !== MODE.CHECK) {
      throw new Error("unknown mode " + mode + " (use show, record, withdraw or check)");
    }
    fillRecordOutputs(outputVars, record);
    outputVars.message = mode === MODE.CHECK ? "" : message;
    const shouldShow = String(inputVars.show_card || "yes").toLowerCase() !== "no";
    return {
      outputVars,
      trace: shouldShow && outputVars.message ? [{ type: "text", payload: { message: outputVars.message } }] : [],
    };
  } catch (error) {
    outputVars.error = ERROR_PREFIX + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG

const MODE = { SHOW: "show", RECORD: "record", WITHDRAW: "withdraw", CHECK: "check" };
const ERROR_PREFIX = "consent_manager failed: ";

// ================================================================ LOGIC

function createEmptyOutputs() {
  return {
    consent_screen_text: "",
    consent_options_json: "[]",
    consent_record_json: "",
    consent_registry_lookup: false,
    consent_kyc_verification: false,
    consent_marketing: false,
    consent_version: "",
    consent_updated_at: "",
    message: "",
    error: "",
  };
}

function detectLanguage(languageInput) {
  const value = String(languageInput || "").trim();
  if (/^(hi|hindi|हिंदी|hinglish)/i.test(value)) return "hi";
  if (/^(kn|kannada|ಕನ್ನಡ)/i.test(value)) return "kn";
  return "en";
}

function fillRecordOutputs(outputVars, record) {
  outputVars.consent_record_json = JSON.stringify(record);
  outputVars.consent_registry_lookup = consent.isAllowed(record, "registry_lookup");
  outputVars.consent_kyc_verification = consent.isAllowed(record, "kyc_verification");
  outputVars.consent_marketing = consent.isAllowed(record, "marketing");
  outputVars.consent_version = record.version;
  outputVars.consent_updated_at = record.updatedAt;
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/** The consent rules (_build/consent_rules.js), embedded unchanged; the demo page embeds the same code. */
const consent = (function embeddedCONSENT_RULES_API() {
/*
 * consent_rules.js: consent rules and texts (TEMPLATE; embedded unchanged in consent_manager.js and in the demo
 * page's consent screen, 7_demo_site/consent_rules.js).
 *
 * What it does: one consent screen that asks SEPARATELY for three purposes, in the owner's language (English, Hindi,
 * Kannada), with a withdraw option for each. It also keeps a consent record: who agreed to what and when, with full
 * history.
 *   registry_lookup   look up the GSTIN / Udyam number in the registries (needed for zero-question onboarding)
 *   kyc_verification  verify the business for activation: read shared documents, check the signatory's ID
 *   marketing         offers and tips on WhatsApp (optional; never pre-ticked; saying no changes nothing else)
 *
 * Why: DPDP Act, 2023: consent must be specific to a purpose, given by a clear affirmative action, as easy to
 * withdraw as to give, and recorded. Nothing is ever granted by default or inferred from silence.
 */

// ================================================================ CONFIG

const CONSENT_RULES = {
  version: "2026-11-04",
  purposes: ["registry_lookup", "kyc_verification", "marketing"],
  /** Which consent each step needs. Marketing is never needed for any step. */
  requiredForStep: { onboarding: "registry_lookup", document_reading: "kyc_verification", kyc: "kyc_verification" },
  /** Retention promised in the texts below (also in 4_knowledge_base/saathi_privacy_notice.txt). */
  documentImageRetentionDays: 30,
};

// ================================================================ MESSAGES (all languages)
// Hindi and Kannada text was written for this prototype; have native speakers review it before going live.

const CONSENT_TEXT = {
  en: {
    title: "Your data, your choice",
    intro: "We ask about three things separately. Say yes or no to each; you can change your mind any time.",
    purposes: {
      registry_lookup: {
        label: "Registry lookup",
        description:
          "Look up your GSTIN and Udyam number in the government registries, to find your business and prepare your plan.",
      },
      kyc_verification: {
        label: "KYC verification",
        description:
          "Verify your business for activation: read the documents you share (like a GST certificate photo) and check the signatory's ID. Images are deleted {days} days after activation.",
      },
      marketing: {
        label: "Offers on WhatsApp (optional)",
        description: "Send you offers and tips about Accel products. Saying no changes nothing else.",
      },
    },
    yes: "Yes",
    no: "No",
    withdrawButton: "Withdraw",
    recordHeading: "Your consent record",
    notAnswered: "not answered yet",
    withdrawNote: 'You can withdraw any of these at any time: type "withdraw consent" or use the withdraw button.',
    saved: "Saved. Registry lookup: {registry_lookup} · KYC verification: {kyc_verification} · Offers: {marketing}.",
    granted: "yes",
    notGranted: "no",
    withdrawn: {
      registry_lookup:
        "Done: we won't look up your registrations again, and we'll remove the looked-up details from your application.",
      kyc_verification:
        "Done: we've stopped verification and will delete the documents you shared. Without verification we can't activate a new connection.",
      marketing: "Done: no more offers. Everything else stays the same.",
    },
    unknownPurpose: "Which consent would you like to withdraw: registry lookup, KYC verification or offers?",
  },
  hi: {
    title: "आपका डेटा, आपकी मर्ज़ी",
    intro:
      "हम तीन चीज़ों के बारे में अलग-अलग पूछते हैं। हर एक के लिए हाँ या ना कहिए; आप कभी भी अपना फ़ैसला बदल सकते हैं।",
    purposes: {
      registry_lookup: {
        label: "रजिस्ट्री लुकअप",
        description: "आपका बिज़नेस ढूँढने और प्लान बनाने के लिए सरकारी रजिस्ट्री में आपका GSTIN और Udyam नंबर देखना।",
      },
      kyc_verification: {
        label: "KYC वेरिफ़िकेशन",
        description:
          "एक्टिवेशन के लिए बिज़नेस वेरिफ़ाई करना: आपके भेजे डॉक्यूमेंट (जैसे GST सर्टिफ़िकेट की फ़ोटो) पढ़ना और हस्ताक्षरकर्ता की ID जाँचना। इमेज एक्टिवेशन के {days} दिन बाद डिलीट हो जाती हैं।",
      },
      marketing: {
        label: "WhatsApp पर ऑफ़र (वैकल्पिक)",
        description: "Accel प्रोडक्ट्स के ऑफ़र और सुझाव भेजना। ना कहने से और कुछ नहीं बदलता।",
      },
    },
    yes: "हाँ",
    no: "नहीं",
    withdrawButton: "वापस लें",
    recordHeading: "आपकी सहमति का रिकॉर्ड",
    notAnswered: "अभी जवाब नहीं दिया",
    withdrawNote: 'आप इनमें से कोई भी सहमति कभी भी वापस ले सकते हैं: "सहमति वापस" लिखिए या वापस लेने का बटन दबाइए।',
    saved: "सेव हो गया। रजिस्ट्री लुकअप: {registry_lookup} · KYC वेरिफ़िकेशन: {kyc_verification} · ऑफ़र: {marketing}।",
    granted: "हाँ",
    notGranted: "नहीं",
    withdrawn: {
      registry_lookup: "हो गया: हम आपकी रजिस्ट्रेशन दोबारा नहीं देखेंगे, और देखी गई जानकारी आपके आवेदन से हटा देंगे।",
      kyc_verification:
        "हो गया: वेरिफ़िकेशन रोक दिया है और आपके भेजे डॉक्यूमेंट डिलीट कर देंगे। वेरिफ़िकेशन के बिना नया कनेक्शन चालू नहीं हो सकता।",
      marketing: "हो गया: अब कोई ऑफ़र नहीं। बाकी सब वैसा ही रहेगा।",
    },
    unknownPurpose: "कौन-सी सहमति वापस लेनी है: रजिस्ट्री लुकअप, KYC वेरिफ़िकेशन या ऑफ़र?",
  },
  kn: {
    title: "ನಿಮ್ಮ ಡೇಟಾ, ನಿಮ್ಮ ಆಯ್ಕೆ",
    intro:
      "ನಾವು ಮೂರು ವಿಷಯಗಳ ಬಗ್ಗೆ ಪ್ರತ್ಯೇಕವಾಗಿ ಕೇಳುತ್ತೇವೆ. ಪ್ರತಿಯೊಂದಕ್ಕೂ ಹೌದು ಅಥವಾ ಇಲ್ಲ ಎನ್ನಿ; ಯಾವಾಗ ಬೇಕಾದರೂ ಬದಲಿಸಬಹುದು.",
    purposes: {
      registry_lookup: {
        label: "ನೋಂದಣಿ ಪರಿಶೀಲನೆ",
        description:
          "ನಿಮ್ಮ ವ್ಯಾಪಾರ ಹುಡುಕಲು ಮತ್ತು ಪ್ಲಾನ್ ಸಿದ್ಧಪಡಿಸಲು ಸರ್ಕಾರಿ ನೋಂದಣಿಗಳಲ್ಲಿ ನಿಮ್ಮ GSTIN ಮತ್ತು Udyam ಸಂಖ್ಯೆ ನೋಡುವುದು.",
      },
      kyc_verification: {
        label: "KYC ಪರಿಶೀಲನೆ",
        description:
          "ಸಕ್ರಿಯಗೊಳಿಸಲು ವ್ಯಾಪಾರ ಪರಿಶೀಲನೆ: ನೀವು ಹಂಚಿಕೊಳ್ಳುವ ದಾಖಲೆಗಳನ್ನು (GST ಪ್ರಮಾಣಪತ್ರದ ಫೋಟೋ) ಓದುವುದು ಮತ್ತು ಸಹಿದಾರರ ID ಪರಿಶೀಲಿಸುವುದು. ಚಿತ್ರಗಳನ್ನು ಸಕ್ರಿಯಗೊಳಿಸಿದ {days} ದಿನಗಳ ನಂತರ ಅಳಿಸಲಾಗುತ್ತದೆ.",
      },
      marketing: {
        label: "WhatsApp ನಲ್ಲಿ ಆಫರ್‌ಗಳು (ಐಚ್ಛಿಕ)",
        description: "Accel ಉತ್ಪನ್ನಗಳ ಆಫರ್ ಮತ್ತು ಸಲಹೆಗಳನ್ನು ಕಳುಹಿಸುವುದು. ಇಲ್ಲ ಎಂದರೆ ಬೇರೇನೂ ಬದಲಾಗುವುದಿಲ್ಲ.",
      },
    },
    yes: "ಹೌದು",
    no: "ಇಲ್ಲ",
    withdrawButton: "ಹಿಂಪಡೆ",
    recordHeading: "ನಿಮ್ಮ ಒಪ್ಪಿಗೆಯ ದಾಖಲೆ",
    notAnswered: "ಇನ್ನೂ ಉತ್ತರಿಸಿಲ್ಲ",
    withdrawNote:
      'ಇವುಗಳಲ್ಲಿ ಯಾವುದನ್ನಾದರೂ ಯಾವಾಗ ಬೇಕಾದರೂ ಹಿಂಪಡೆಯಬಹುದು: "ಒಪ್ಪಿಗೆ ಹಿಂಪಡೆ" ಎಂದು ಬರೆಯಿರಿ ಅಥವಾ ಹಿಂಪಡೆಯುವ ಬಟನ್ ಒತ್ತಿ.',
    saved: "ಉಳಿಸಲಾಗಿದೆ. ನೋಂದಣಿ ಪರಿಶೀಲನೆ: {registry_lookup} · KYC ಪರಿಶೀಲನೆ: {kyc_verification} · ಆಫರ್‌ಗಳು: {marketing}.",
    granted: "ಹೌದು",
    notGranted: "ಇಲ್ಲ",
    withdrawn: {
      registry_lookup:
        "ಆಯಿತು: ನಿಮ್ಮ ನೋಂದಣಿಗಳನ್ನು ಮತ್ತೆ ನೋಡುವುದಿಲ್ಲ, ಮತ್ತು ನೋಡಿದ ವಿವರಗಳನ್ನು ನಿಮ್ಮ ಅರ್ಜಿಯಿಂದ ತೆಗೆದುಹಾಕುತ್ತೇವೆ.",
      kyc_verification:
        "ಆಯಿತು: ಪರಿಶೀಲನೆ ನಿಲ್ಲಿಸಿದ್ದೇವೆ ಮತ್ತು ನೀವು ಹಂಚಿಕೊಂಡ ದಾಖಲೆಗಳನ್ನು ಅಳಿಸುತ್ತೇವೆ. ಪರಿಶೀಲನೆ ಇಲ್ಲದೆ ಹೊಸ ಸಂಪರ್ಕ ಸಕ್ರಿಯಗೊಳಿಸಲು ಸಾಧ್ಯವಿಲ್ಲ.",
      marketing: "ಆಯಿತು: ಇನ್ನು ಆಫರ್‌ಗಳಿಲ್ಲ. ಬೇರೆಲ್ಲವೂ ಹಾಗೆಯೇ ಇರುತ್ತದೆ.",
    },
    unknownPurpose: "ಯಾವ ಒಪ್ಪಿಗೆಯನ್ನು ಹಿಂಪಡೆಯಬೇಕು: ನೋಂದಣಿ ಪರಿಶೀಲನೆ, KYC ಪರಿಶೀಲನೆ ಅಥವಾ ಆಫರ್‌ಗಳು?",
  },
};

/** Words that name a purpose when the owner types it ("withdraw marketing", "stop KYC"). */
const PURPOSE_WORDS = {
  registry_lookup: ["registry", "lookup", "look up", "gstin", "रजिस्ट्री", "ನೋಂದಣಿ"],
  kyc_verification: ["kyc", "verification", "document", "वेरिफ़िकेशन", "डॉक्यूमेंट", "ದಾಖಲೆ"],
  marketing: ["marketing", "offer", "offers", "whatsapp", "ऑफ़र", "ಆಫರ್"],
};
const YES_PATTERN = /^(y|yes|true|1|agree|i agree|haan|हाँ|हां|ಹೌದು)$/i;
const NO_PATTERN = /^(n|no|false|0|nahi|nahin|नहीं|ಇಲ್ಲ)$/i;

// ================================================================ LOGIC

function textFor(language) {
  return CONSENT_TEXT[language] || CONSENT_TEXT.en;
}

/** Yes → true, no → false, anything else → null (unanswered: never treated as yes). */
function readAnswer(value) {
  const answer = String(value === undefined || value === null ? "" : value).trim();
  if (YES_PATTERN.test(answer)) return true;
  if (NO_PATTERN.test(answer)) return false;
  return null;
}

/** The consent screen in a language: three separate purposes, each with its own yes/no, and the withdraw note. */
function consentScreen(language) {
  const text = textFor(language);
  const purposes = CONSENT_RULES.purposes.map((id) => ({
    id,
    label: text.purposes[id].label,
    description: text.purposes[id].description.split("{days}").join(String(CONSENT_RULES.documentImageRetentionDays)),
  }));
  const chatText = [text.title, text.intro]
    .concat(purposes.map((purpose, index) => index + 1 + ". " + purpose.label + ": " + purpose.description))
    .concat([text.withdrawNote])
    .join("\n");
  return {
    title: text.title,
    intro: text.intro,
    purposes,
    yesLabel: text.yes,
    noLabel: text.no,
    withdrawNote: text.withdrawNote,
    chatText,
  };
}

/** A record with every purpose not granted. */
function emptyRecord() {
  const purposes = {};
  CONSENT_RULES.purposes.forEach((id) => {
    purposes[id] = { granted: false, at: "" };
  });
  return { version: CONSENT_RULES.version, updatedAt: "", purposes, history: [] };
}

/** Reads a stored record (JSON text or object); a missing or damaged record becomes an empty one. */
function parseRecord(recordInput) {
  if (recordInput && typeof recordInput === "object") return recordInput;
  try {
    const parsed = JSON.parse(String(recordInput || ""));
    if (parsed && parsed.purposes) return parsed;
  } catch {
    // Damaged or empty: start a fresh record (everything not granted).
  }
  return emptyRecord();
}

/**
 * Records the owner's answers. choices = { registry_lookup: "yes"/"no", … }. Only explicit answers change the
 * record; unanswered purposes keep their previous state (never granted by default). Every change goes into history.
 */
function recordConsent(recordInput, choices, now) {
  const record = JSON.parse(JSON.stringify(parseRecord(recordInput)));
  const at = (now || new Date()).toISOString();
  CONSENT_RULES.purposes.forEach((id) => {
    const answer = readAnswer(choices[id]);
    if (answer === null) return;
    if (record.purposes[id].granted !== answer || !record.purposes[id].at) {
      record.purposes[id] = { granted: answer, at };
      record.history.push({ purpose: id, granted: answer, at });
    }
  });
  record.version = CONSENT_RULES.version;
  record.updatedAt = at;
  return record;
}

/** Withdraws one purpose (as easy as giving it). Returns the updated record. */
function withdrawConsent(recordInput, purpose, now) {
  const choices = {};
  choices[purpose] = "no";
  return recordConsent(recordInput, choices, now);
}

/** Which purpose the owner means ("stop marketing" → "marketing"); "" if unclear. */
function purposeFromText(purposeInput) {
  const text = String(purposeInput || "").toLowerCase();
  if (CONSENT_RULES.purposes.indexOf(text.trim()) >= 0) return text.trim();
  return CONSENT_RULES.purposes.find((id) => PURPOSE_WORDS[id].some((word) => text.indexOf(word) >= 0)) || "";
}

function isAllowed(recordInput, purpose) {
  const record = parseRecord(recordInput);
  return !!(record.purposes[purpose] && record.purposes[purpose].granted);
}

/** "Saved. Registry lookup: yes · KYC verification: no · Offers: no." in the owner's language. */
function describeRecord(recordInput, language) {
  const text = textFor(language);
  const record = parseRecord(recordInput);
  const values = {};
  CONSENT_RULES.purposes.forEach((id) => {
    values[id] = record.purposes[id].granted ? text.granted : text.notGranted;
  });
  return Object.keys(values).reduce((message, key) => message.split("{" + key + "}").join(values[key]), text.saved);
}

const CONSENT_RULES_API = {
  CONSENT_RULES,
  CONSENT_TEXT,
  textFor,
  readAnswer,
  consentScreen,
  emptyRecord,
  parseRecord,
  recordConsent,
  withdrawConsent,
  purposeFromText,
  isAllowed,
  describeRecord,
};

  return CONSENT_RULES_API;
})();
