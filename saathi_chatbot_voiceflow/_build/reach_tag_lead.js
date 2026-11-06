/*
 * reach_tag_lead.js: Voiceflow function tool "reach_tag_lead" (TEMPLATE; the build embeds _build/reach_rules.js).
 *
 * What it does, in two modes:
 *   - mode "tag" (default): just before a lead row goes to the Google Sheet, adds the REACH columns: the referral
 *     code and referrer type, the territory and its field rep, the drop-off stage, and, for Hot leads Saathi
 *     couldn't close, the rep-callback flag with a one-line context summary.
 *   - mode "issue_code": gives an existing customer their own referral code (micro-agent) with a share message.
 *
 * How it fits: the "Callback & lead capture" playbook calls it after register_lead and before the Google Sheets
 * row; the "Order tracker" playbook calls mode "issue_code" for live customers. Rewards are NOT computed here:
 * nothing is earned at lead creation. The back-office page computes them when a row reaches "Activated", with the
 * same embedded rules (STRATEGY.md, REACH).
 */

/**
 * Voiceflow entry point.
 *
 * @param {{inputVars?: Object<string, string>}} args  mode ("tag" | "issue_code"); for "tag": referral_code, city,
 *   state, gstin_masked, lead_score, priority, stage, business_name, segment_code, bundle_name, monthly_total,
 *   reason_not_closed, gstin_status, closed_by; for "issue_code": order_id or customer_id; and lang.
 * @returns {{outputVars: Object, trace: Array}}  Every declared output, always; `error` on failure.
 * @example
 *   await main({ inputVars: { referral_code: "<a CA code>", city: "Delhi", priority: "Hot", lead_score: "92",
 *     stage: "proposal_shown", business_name: "Metro Diagnostics Pvt Ltd", segment_code: "prof" } })
 *   // → referrer_type "ca_partner", territory_rep_id "REP-DEL", handoff_flag true, handoff_summary "Metro …"
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const language = detectLanguage(inputVars.lang);
  const text = MESSAGES[language];
  const outputVars = createEmptyOutputs();
  try {
    if (
      String(inputVars.mode || "")
        .trim()
        .toLowerCase() === MODE.ISSUE_CODE
    ) {
      issueCustomerCode(outputVars, inputVars, text);
      return respond(outputVars, inputVars, outputVars.share_text);
    }
    const tags = reachRules.tagLead({
      referral_code: inputVars.referral_code,
      city: inputVars.city || inputVars.gst_city,
      state: inputVars.state || inputVars.gst_state,
      gstin_masked: inputVars.gstin_masked,
      lead_score: inputVars.lead_score,
      priority: inputVars.priority,
      stage: inputVars.stage,
      business_name: inputVars.business_name,
      segment_code: inputVars.segment_code,
      bundle_name: inputVars.bundle_name,
      monthly_total: inputVars.monthly_total,
      reason_not_closed: inputVars.reason_not_closed,
      gstin_status: inputVars.gstin_status,
      closed_by: inputVars.closed_by || DEFAULT_CLOSED_BY,
    });
    outputVars.referral_code = tags.referral.code;
    outputVars.referral_valid = tags.referral.isValid;
    outputVars.referral_problem = tags.referral.problem;
    outputVars.referrer_type = tags.referral.referrerType;
    outputVars.referrer_id = tags.referral.referrerId;
    outputVars.territory_id = tags.territory.territoryId;
    outputVars.territory_label = tags.territory.territoryLabel;
    outputVars.territory_rep_id = tags.territory.repId;
    outputVars.territory_matched_by = tags.territory.matchedBy;
    outputVars.closed_by = inputVars.closed_by || DEFAULT_CLOSED_BY;
    outputVars.drop_off_stage = tags.dropOffStage;
    outputVars.handoff_flag = tags.handoff.isHandoff;
    outputVars.handoff_owner_id = tags.handoff.ownerId;
    outputVars.handoff_summary = tags.handoff.summary;
    outputVars.owner_message = referralMessage(tags.referral, text);
    return respond(outputVars, inputVars, outputVars.owner_message);
  } catch (error) {
    outputVars.error = ERROR_PREFIX + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG

const MODE = { TAG: "tag", ISSUE_CODE: "issue_code" };
/** Leads tagged by this function were handled by Saathi; the back office changes it if a rep closes the sale. */
const DEFAULT_CLOSED_BY = "saathi";
const ERROR_PREFIX = "reach_tag_lead failed: ";

// ================================================================ MESSAGES (all user-facing text)
// Kannada text was written for this prototype; have a native speaker review it before going live.

const MESSAGES = {
  en: {
    thanksForReferral: "Thanks for coming through a referral from {who}.",
    referrerWord: { ca_partner: "your CA", customer: "an Accel customer", field_rep: "an Accel field rep" },
    codeMistyped:
      "That referral code looks mistyped (it looks like CA-7K2P9-X). Could you check it? You can also skip it.",
    codeUnknown: "I couldn't match that referral code yet. I've saved it, and our team will check it.",
    shareText:
      "Your referral code: {code}. Share it with another business owner. When they go live with Accel, you get a bill credit of {share}% of their first monthly bill (up to {cap}), once they've stayed {days} days.",
    noCustomer: "I couldn't find your account from that order number. Our team can share your referral code on a call.",
  },
  hi: {
    thanksForReferral: "{who} के रेफ़रल से आने के लिए धन्यवाद।",
    referrerWord: { ca_partner: "आपके CA", customer: "एक Accel ग्राहक", field_rep: "एक Accel फ़ील्ड प्रतिनिधि" },
    codeMistyped:
      "यह रेफ़रल कोड गलत टाइप हुआ लगता है (कुछ ऐसा होता है: CA-7K2P9-X)। एक बार जाँच लेंगे? चाहें तो छोड़ भी सकते हैं।",
    codeUnknown: "यह रेफ़रल कोड अभी मिल नहीं पाया। मैंने इसे सेव कर लिया है, हमारी टीम इसे जाँच लेगी।",
    shareText:
      "आपका रेफ़रल कोड: {code}. इसे किसी दूसरे बिज़नेस मालिक के साथ शेयर कीजिए। जब वे Accel से जुड़कर चालू हो जाएँगे और {days} दिन तक बने रहेंगे, तो आपको उनके पहले महीने के बिल का {share}% (अधिकतम {cap}) बिल क्रेडिट मिलेगा।",
    noCustomer: "इस ऑर्डर नंबर से आपका अकाउंट नहीं मिला। हमारी टीम कॉल पर आपका रेफ़रल कोड बता देगी।",
  },
  kn: {
    thanksForReferral: "{who} ಅವರ ರೆಫರಲ್ ಮೂಲಕ ಬಂದದ್ದಕ್ಕೆ ಧನ್ಯವಾದ.",
    referrerWord: { ca_partner: "ನಿಮ್ಮ CA", customer: "ಒಬ್ಬ Accel ಗ್ರಾಹಕ", field_rep: "ಒಬ್ಬ Accel ಫೀಲ್ಡ್ ಪ್ರತಿನಿಧಿ" },
    codeMistyped:
      "ಈ ರೆಫರಲ್ ಕೋಡ್ ತಪ್ಪಾಗಿ ಟೈಪ್ ಆಗಿದೆ ಎನಿಸುತ್ತದೆ (ಉದಾ: CA-7K2P9-X). ದಯವಿಟ್ಟು ಪರಿಶೀಲಿಸಿ, ಬೇಕಾದರೆ ಬಿಟ್ಟುಬಿಡಬಹುದು.",
    codeUnknown: "ಈ ರೆಫರಲ್ ಕೋಡ್ ಇನ್ನೂ ಹೊಂದಿಕೆಯಾಗಿಲ್ಲ. ನಾನು ಇದನ್ನು ಉಳಿಸಿದ್ದೇನೆ, ನಮ್ಮ ತಂಡ ಪರಿಶೀಲಿಸುತ್ತದೆ.",
    shareText:
      "ನಿಮ್ಮ ರೆಫರಲ್ ಕೋಡ್: {code}. ಇದನ್ನು ಇನ್ನೊಬ್ಬ ವ್ಯಾಪಾರ ಮಾಲೀಕರೊಂದಿಗೆ ಹಂಚಿಕೊಳ್ಳಿ. ಅವರು Accel ಸೇವೆ ಆರಂಭಿಸಿ {days} ದಿನ ಮುಂದುವರಿದರೆ, ಅವರ ಮೊದಲ ತಿಂಗಳ ಬಿಲ್‌ನ {share}% (ಗರಿಷ್ಠ {cap}) ಬಿಲ್ ಕ್ರೆಡಿಟ್ ನಿಮಗೆ ಸಿಗುತ್ತದೆ.",
    noCustomer: "ಈ ಆರ್ಡರ್ ಸಂಖ್ಯೆಯಿಂದ ನಿಮ್ಮ ಖಾತೆ ಸಿಗಲಿಲ್ಲ. ನಮ್ಮ ತಂಡ ಕರೆಯಲ್ಲಿ ನಿಮ್ಮ ರೆಫರಲ್ ಕೋಡ್ ತಿಳಿಸುತ್ತದೆ.",
  },
};

// ================================================================ LOGIC

function createEmptyOutputs() {
  return {
    referral_code: "",
    referral_valid: false,
    referral_problem: "",
    referrer_type: "",
    referrer_id: "",
    territory_id: "",
    territory_label: "",
    territory_rep_id: "",
    territory_matched_by: "",
    closed_by: "",
    drop_off_stage: "",
    handoff_flag: false,
    handoff_owner_id: "",
    handoff_summary: "",
    owner_message: "",
    share_text: "",
    error: "",
  };
}

/** Shows the owner-facing message (if any) unless show_card = "no". The handoff summary is internal: never shown. */
function respond(outputVars, inputVars, message) {
  const shouldShow = String(inputVars.show_card || "yes").toLowerCase() !== "no";
  return { outputVars, trace: shouldShow && message ? [{ type: "text", payload: { message } }] : [] };
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

function formatRupees(amount) {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return "₹" + digits;
  return "₹" + digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + digits.slice(-3);
}

/** Thanks the owner for a valid referral without naming the referrer; asks once about a mistyped code. */
function referralMessage(referral, text) {
  if (referral.isValid) return fillTemplate(text.thanksForReferral, { who: text.referrerWord[referral.referrerType] });
  if (referral.problem === "format" || referral.problem === "checksum") return text.codeMistyped;
  if (referral.problem === "unknown_referrer") return text.codeUnknown;
  return "";
}

/** Mode "issue_code": a live customer's own micro-agent code, with the reward terms taken from REACH_RATES. */
function issueCustomerCode(outputVars, inputVars, text) {
  const customerId = String(inputVars.customer_id || "").trim() || reachRules.customerIdFromOrderId(inputVars.order_id);
  const customer = customerId ? reachRules.findReferrer(reachRules.REFERRER_TYPE.CUSTOMER, customerId) : null;
  if (!customer) {
    outputVars.share_text = text.noCustomer;
    return;
  }
  const rate = reachRules.REACH_RATES.referral.customer;
  outputVars.referral_code = reachRules.issueReferralCode(reachRules.REFERRER_TYPE.CUSTOMER, customer.id);
  outputVars.referral_valid = true;
  outputVars.referrer_type = reachRules.REFERRER_TYPE.CUSTOMER;
  outputVars.referrer_id = customer.id;
  outputVars.share_text = fillTemplate(text.shareText, {
    code: outputVars.referral_code,
    share: Math.round(rate.shareOfFirstMonthlyBill * 100),
    cap: formatRupees(rate.capInRupees),
    days: reachRules.REACH_RATES.payoutHoldDays,
  });
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/** The REACH rules (_build/reach_rules.js), embedded unchanged; the back-office page embeds the very same code. */
const reachRules = /*__REACH_RULES__*/ null;
