/*
 * verify_udyam.js: Voiceflow function tool "verify_udyam" (TEMPLATE; the build injects the mock registry).
 *
 * What it does: Smart-KYC step 2 (optional). Checks a Udyam registration number (format UDYAM-XX-00-0000000)
 * against the case's mock Udyam registry (mock_udyam_registry.csv, 2,723 synthetic records).
 *
 * How it fits: the "Business verification" playbook calls it after the GSTIN step. A failure never blocks the
 * order: Udyam is optional, so the playbook just continues.
 *
 * Reading the number (from the owner's whole message), the format check and the masking come from the shared
 * _build/udyam_input.js, embedded by the build; onboard_from_gstin uses the very same code for Udyam entry.
 *
 * SIMULATED: the registry is the case's synthetic mock; production would call the Udyam portal instead.
 */

/**
 * Voiceflow entry point: checks one Udyam number and returns a ready-to-show message in English or Hindi.
 *
 * @param {{inputVars?: {udyam_number?: string, business_name?: string, lang?: string}}} args
 * @returns {{outputVars: {udyam_ok: boolean, udyam_masked: string, enterprise_name: string, enterprise_type: string,
 *   major_activity: string, udyam_city: string, name_match: string, kyc_message: string, error: string}}}
 * @example
 *   await main({ inputVars: { udyam_number: "UDYAM-DL-00-7084760", lang: "en" } })
 *   // → udyam_ok true, udyam_masked "UDYAM-DL-••-•••4760"
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const isHindi = /^(hi|hindi|हिंदी|hinglish)/i.test(String(inputVars.lang || ""));
  const text = isHindi ? MESSAGES.hi : MESSAGES.en;
  const outputVars = {
    udyam_ok: false,
    udyam_masked: "",
    enterprise_name: "",
    enterprise_type: "",
    major_activity: "",
    udyam_city: "",
    name_match: "",
    kyc_message: "",
    error: "",
  };
  try {
    const reading = udyamInput.readUdyam(inputVars.udyam_number);
    if (reading.problem) {
      outputVars.kyc_message = text.invalidFormat;
      return { outputVars };
    }
    const udyamNumber = reading.udyamNumber;
    outputVars.udyam_masked = udyamInput.maskUdyam(udyamNumber);
    const record = findRegistryRecord(udyamNumber);
    if (!record) {
      outputVars.kyc_message = text.notFound;
      return { outputVars };
    }
    outputVars.udyam_ok = true;
    outputVars.enterprise_name = record.enterpriseName;
    outputVars.enterprise_type = record.enterpriseType;
    outputVars.major_activity = record.majorActivity;
    outputVars.udyam_city = record.city;
    outputVars.name_match = matchBusinessName(inputVars.business_name, [record.enterpriseName]);
    outputVars.kyc_message = fillTemplate(text.verified, {
      udyam: outputVars.udyam_masked,
      name: record.enterpriseName,
      type: record.enterpriseType,
      activity: record.majorActivity,
      city: record.city,
    });
    return { outputVars };
  } catch (error) {
    outputVars.error = MESSAGES.errorPrefix + (error && error.message ? error.message : String(error));
    return { outputVars };
  }
}

// ================================================================ CONFIG

/** Name match: share of the owner's name words found in the registry name (same rule as verify_gstin). */
const NAME_MATCH_THRESHOLDS = { match: 0.6, partial: 0.3 };
const NAME_MATCH = { MATCH: "match", PARTIAL: "partial", NO_MATCH: "no_match", NOT_CHECKED: "not_checked" };
/**
 * "M/s" (Messrs) starts many Indian business names. It is removed before punctuation becomes spaces, which would
 * otherwise split it into "m" and "s" and count those as name words.
 */
const MESSRS_PATTERN = /\bm\/s\b\.?/g;
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

const MESSAGES = {
  errorPrefix: "verify_udyam failed: ",
  en: {
    invalidFormat:
      "A Udyam number looks like UDYAM-DL-00-1234567. Could you check it? It's optional, so we can also skip it.",
    notFound:
      "I couldn't find this Udyam number in the registry. No problem, it's optional; we can continue without it.",
    verified: "Udyam verified ✓ {udyam} · {name} · {type}, {activity} · {city}.",
  },
  hi: {
    invalidFormat:
      "Udyam नंबर कुछ ऐसा होता है: UDYAM-DL-00-1234567. एक बार जाँच लेंगे? यह ज़रूरी नहीं है, चाहें तो छोड़ सकते हैं।",
    notFound: "यह Udyam नंबर रजिस्ट्री में नहीं मिला। कोई बात नहीं, यह ज़रूरी नहीं है; हम इसके बिना आगे बढ़ सकते हैं।",
    verified: "Udyam वेरिफ़ाइड ✓ {udyam} · {name} · {type}, {activity} · {city}.",
  },
};

// ================================================================ LOGIC

/** Lower-case words of a business name without punctuation or stop words. Keeps Devanagari. */
function toNameWords(name) {
  return (
    String(name || "")
      .toLowerCase()
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
    const sharedCount = givenWords.filter((word) => registryWords.indexOf(word) >= 0).length;
    bestShare = Math.max(bestShare, sharedCount / Math.max(givenWords.length, 1));
  });
  if (bestShare >= NAME_MATCH_THRESHOLDS.match) return NAME_MATCH.MATCH;
  if (bestShare >= NAME_MATCH_THRESHOLDS.partial) return NAME_MATCH.PARTIAL;
  return NAME_MATCH.NO_MATCH;
}

function fillTemplate(template, values) {
  return Object.keys(values).reduce((text, key) => text.split("{" + key + "}").join(values[key]), template);
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/**
 * SIMULATED: mock Udyam registry from the case pack (synthetic; district code 00 does not exist in reality).
 * One record per line: UDYAM number|enterprise name|type M/S/D|activity T/S/F|city
 */
const REGISTRY_TEXT = /*__UDYAM_REGISTRY__*/ "";
const ENTERPRISE_TYPE_BY_CODE = { M: "Micro", S: "Small", D: "Medium" };
const MAJOR_ACTIVITY_BY_CODE = { T: "Trading", S: "Services", F: "Manufacturing" };
let registryIndex = null;

/** Shared Udyam reading, format check and masking (_build/udyam_input.js), embedded unchanged by the build. */
const udyamInput = /*__UDYAM_INPUT__*/ null;

/** Finds a Udyam number in the embedded registry (index built on first use). Returns null when it isn't there. */
function findRegistryRecord(udyamNumber) {
  if (!registryIndex) {
    registryIndex = {};
    REGISTRY_TEXT.split("\n").forEach((line) => {
      if (line) {
        const fields = line.split("|");
        registryIndex[fields[0]] = fields;
      }
    });
  }
  const fields = registryIndex[udyamNumber];
  if (!fields) return null;
  return {
    enterpriseName: fields[1],
    enterpriseType: ENTERPRISE_TYPE_BY_CODE[fields[2]] || fields[2],
    majorActivity: MAJOR_ACTIVITY_BY_CODE[fields[3]] || fields[3],
    city: fields[4],
  };
}
