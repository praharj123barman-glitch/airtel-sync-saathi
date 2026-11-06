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
const consent = /*__CONSENT_RULES__*/ null;
