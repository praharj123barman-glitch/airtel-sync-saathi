/*
 * reach_rules.js: the REACH layer's business rules (TEMPLATE; the build injects the referrer directory and the
 * territory map, then embeds this file unchanged in two places).
 *
 * What it does: referral codes, territory credit, hot-lead handoff and rewards (STRATEGY.md, REACH: "One million
 * salespeople").
 *   - Referral codes for CA partners, existing customers (micro-agents) and field reps, with a check character so
 *     typos are caught.
 *   - Territory: every lead maps to the field rep who owns its district (city from the GST registry address), or
 *     its state when the city isn't covered.
 *   - Hot-lead handoff: top-20% leads (register_lead "Hot") that Saathi couldn't close go to a rep with a summary.
 *   - Rewards: commission / bill credit / incentive / territory credit are EARNED ON ACTIVATION only, then held
 *     REACH_RATES.payoutHoldDays before they become payable (void if the customer leaves in that window).
 *
 * How it fits: _build/gen_kit.py wraps this file into
 *   - 3_function_tools/reach_tag_lead.js (Voiceflow: tags a new lead row before it goes to the Google Sheet)
 *   - 8_back_office/reach_rules.js (the back-office page: recomputes territory, handoff and rewards from the sheet)
 * so the chatbot and the back office can never disagree. Rates live in ONE object: REACH_RATES.
 *
 * SIMULATED: the referrer directory (CA partners, field reps) and the territory map are built from the case data
 * for the demo; production would read them from the partner and sales systems.
 */

// ================================================================ CONFIG: rates (one object)

/**
 * REACH_RATES: every rate, cap and timing rule of the reach layer.
 *
 * Amounts are a share of the referred customer's FIRST monthly bill (monthly_total from price_bundle), capped.
 * Why these levels: in smb_leads.csv a referral activation cost ₹4,099 and a field-sales activation ₹24,335, for a
 * median bundle of ₹6,900/month. Even the highest rate below (1× the first bill, capped at ₹10,000) stays far
 * under the field-sales cost. The exact percentages are design choices to test in the pilot.
 *
 * Why the hold: referred customers churned the most in the case data (24.6% within 6 months vs 15.2% overall), so
 * rewards are earned at activation but only paid after payoutHoldDays, and voided if the customer leaves first.
 */
const REACH_RATES = {
  earnOn: "Activated",
  payoutHoldDays: 90,
  referral: {
    ca_partner: { rewardKind: "commission", shareOfFirstMonthlyBill: 1.0, capInRupees: 10000 },
    customer: { rewardKind: "bill_credit", shareOfFirstMonthlyBill: 0.5, capInRupees: 3000 },
    // A rep earns this only when Saathi closes the lead they referred; selling it in person is paid by normal
    // sales commission, outside this system.
    field_rep: {
      rewardKind: "incentive",
      shareOfFirstMonthlyBill: 0.25,
      capInRupees: 5000,
      notWhenClosedBy: ["field_rep"],
    },
  },
  /** Credit to the rep who owns the territory, for activations Saathi closed digitally (no field visit). */
  territoryCredit: {
    rewardKind: "territory_credit",
    activationsCountedTowardTarget: 1,
    shareOfFirstMonthlyBill: 0.1,
    capInRupees: 2000,
    closedByValues: ["saathi"],
  },
  /** register_lead priority that triggers a rep callback when the lead isn't closed (top 20% of scores). */
  handoffPriority: "Hot",
};

// ================================================================ CONFIG: everything else

const REFERRER_TYPE = { CA_PARTNER: "ca_partner", CUSTOMER: "customer", FIELD_REP: "field_rep", NONE: "none" };
/** Code prefix per referrer type: "CA-7K2P9-X". */
const CODE_PREFIX_BY_TYPE = { ca_partner: "CA", customer: "CU", field_rep: "FR" };
const TYPE_BY_CODE_PREFIX = { CA: "ca_partner", CU: "customer", FR: "field_rep" };
/** Code alphabet without look-alike characters (no 0/O, 1/I/L), so codes survive being read out on a call. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_BODY_LENGTH = 5;
const CODE_PATTERN = /^(CA|CU|FR)-([2-9A-HJKMNP-Z]{5})-([2-9A-HJKMNP-Z])$/;
/** FNV-1a 32-bit hash constants (a simple, well-known string hash that gives every referrer a stable code). */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** The case funnel stages (smb_leads.csv stage_reached), used for drop-off everywhere. */
const FUNNEL_STAGES = ["Lead", "Contacted", "Needs assessed", "Quote accepted", "KYC complete", "Activated"];
/** Saathi playbook stages → funnel stage (a proposal shown = needs assessed and quoted). */
const FUNNEL_STAGE_BY_SAATHI_STAGE = {
  callback_requested: "Contacted",
  question_asked: "Contacted",
  human_review: "Contacted",
  no_phone: "Contacted",
  proposal_shown: "Needs assessed",
  quote_viewed: "Needs assessed",
  quote_accepted: "Quote accepted",
  kyc_started: "Quote accepted",
  kyc_done: "KYC complete",
  // Order-tracker stages: an order exists (KYC done) but isn't live yet; the back office sets Activated on go-live.
  reschedule: "KYC complete",
  support: "KYC complete",
  airfiber_bridge: "KYC complete",
  retention: "KYC complete",
  activated: "Activated",
};
const SEGMENT_LABEL = {
  micro: "Micro retail & services",
  prof: "Professional offices",
  multi: "Small multi-site businesses",
  mfg: "Small manufacturers",
};
const CENTRAL_DESK = { id: "CENTRAL-DESK", label: "Central sales desk" };
const MILLISECONDS_PER_DAY = 86400000;
/** Demo order numbers map to case leads: "UD-0002" ↔ "L00002" (SIMULATED convention used by order_status). */
const ORDER_TO_CUSTOMER_PATTERN = /^UD-?(\d{1,5})$/i;
const CUSTOMER_ID_DIGITS = 5;

// ================================================================ LOGIC: referral codes

function hashText(text) {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** Check character over prefix + body (weighted sum mod 31), so a single wrong or swapped character is caught. */
function computeCheckCharacter(prefixAndBody) {
  let sum = 0;
  for (let i = 0; i < prefixAndBody.length; i++) {
    const value = CODE_ALPHABET.indexOf(prefixAndBody[i]);
    sum += (value < 0 ? prefixAndBody.charCodeAt(i) : value) * (i + 1);
  }
  return CODE_ALPHABET[sum % CODE_ALPHABET.length];
}

/**
 * The referral code of a referrer: "CA-7K2P9-X". Deterministic, so it never needs storing.
 * @example issueReferralCode("customer", "L00002") → "CU-....-."
 */
function issueReferralCode(referrerType, referrerId) {
  const prefix = CODE_PREFIX_BY_TYPE[referrerType];
  if (!prefix) throw new Error("unknown referrer type: " + referrerType);
  let value = hashText(referrerType + ":" + referrerId);
  let body = "";
  for (let i = 0; i < CODE_BODY_LENGTH; i++) {
    body += CODE_ALPHABET[value % CODE_ALPHABET.length];
    value = Math.floor(value / CODE_ALPHABET.length);
  }
  return prefix + "-" + body + "-" + computeCheckCharacter(prefix + body);
}

/** "ca 7k2p9 x" / "CA7K2P9X" → "CA-7K2P9-X"; "" when it can't be a code. */
function normaliseReferralCode(codeInput) {
  const compact = String(codeInput || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  if (compact.length !== 2 + CODE_BODY_LENGTH + 1) return "";
  return compact.slice(0, 2) + "-" + compact.slice(2, 2 + CODE_BODY_LENGTH) + "-" + compact.slice(-1);
}

let referrerByCode = null;
function referrerIndex() {
  if (!referrerByCode) {
    referrerByCode = {};
    REFERRER_DIRECTORY.forEach((referrer) => {
      referrerByCode[issueReferralCode(referrer.type, referrer.id)] = referrer;
    });
  }
  return referrerByCode;
}

/**
 * Checks a referral code. problem: "" (valid and known), "none" (no code), "format", "checksum" (typo) or
 * "unknown_referrer" (well-formed but not in the directory: stored, but nobody is credited until it is resolved).
 */
function validateReferralCode(codeInput) {
  const empty = {
    code: "",
    isValid: false,
    problem: "none",
    referrerType: REFERRER_TYPE.NONE,
    referrerId: "",
    referrerLabel: "",
    territoryId: "",
  };
  if (!String(codeInput || "").trim()) return empty;
  const code = normaliseReferralCode(codeInput);
  const parts = code.match(CODE_PATTERN);
  if (!parts) return Object.assign({}, empty, { code, problem: "format" });
  if (computeCheckCharacter(parts[1] + parts[2]) !== parts[3])
    return Object.assign({}, empty, { code, problem: "checksum" });
  const referrer = referrerIndex()[code];
  if (!referrer) {
    return Object.assign({}, empty, { code, problem: "unknown_referrer", referrerType: TYPE_BY_CODE_PREFIX[parts[1]] });
  }
  return {
    code,
    isValid: true,
    problem: "",
    referrerType: referrer.type,
    referrerId: referrer.id,
    referrerLabel: referrer.label,
    territoryId: referrer.territoryId || "",
  };
}

/** "UD-0002" → "L00002" (demo orders are built from case leads). Returns "" if the order number doesn't fit. */
function customerIdFromOrderId(orderId) {
  const match = String(orderId || "")
    .trim()
    .match(ORDER_TO_CUSTOMER_PATTERN);
  return match ? "L" + match[1].padStart(CUSTOMER_ID_DIGITS, "0") : "";
}

function findReferrer(referrerType, referrerId) {
  return REFERRER_DIRECTORY.find((referrer) => referrer.type === referrerType && referrer.id === referrerId) || null;
}

// ================================================================ LOGIC: territory

/**
 * The territory and its field rep, from the most precise location available:
 * 1. city (the district in the GST registry address), 2. state, 3. the state code in a GSTIN (masked is fine).
 * Pincodes are not used: the mock registry's pincodes are synthetic and don't match real districts.
 */
function findTerritory(location) {
  const city = String(location.city || "")
    .trim()
    .toLowerCase();
  const state = String(location.state || "")
    .trim()
    .toLowerCase();
  const stateCode = String(location.gstin || "")
    .trim()
    .slice(0, 2);
  const byCity = TERRITORIES.find((territory) => territory.city.toLowerCase() === city);
  if (city && byCity) return describeTerritory(byCity, "city");
  const stateName = state || (STATE_NAME_BY_CODE[stateCode] || "").toLowerCase();
  const stateTerritoryId = Object.keys(STATE_DEFAULT_TERRITORY).find((name) => name.toLowerCase() === stateName);
  if (stateName && stateTerritoryId) {
    const territory = TERRITORIES.find((candidate) => candidate.id === STATE_DEFAULT_TERRITORY[stateTerritoryId]);
    return describeTerritory(territory, state ? "state" : "gstin_state_code");
  }
  return {
    territoryId: "UNASSIGNED",
    territoryLabel: "Unassigned",
    repId: CENTRAL_DESK.id,
    repLabel: CENTRAL_DESK.label,
    matchedBy: "none",
  };
}

function describeTerritory(territory, matchedBy) {
  return {
    territoryId: territory.id,
    territoryLabel: territory.city + ", " + territory.state,
    repId: territory.repId,
    repLabel: territory.repLabel,
    matchedBy,
  };
}

// ================================================================ LOGIC: stages, handoff, rewards

/** Any stage text (funnel stage or Saathi playbook stage) → funnel stage; "Contacted" if unknown. */
function normaliseStage(stageInput) {
  const value = String(stageInput || "").trim();
  const funnelStage = FUNNEL_STAGES.find((stage) => stage.toLowerCase() === value.toLowerCase());
  if (funnelStage) return funnelStage;
  return FUNNEL_STAGE_BY_SAATHI_STAGE[value.toLowerCase()] || "Contacted";
}

function formatRupees(amount) {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return "₹" + digits;
  return "₹" + digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + digits.slice(-3);
}

/**
 * Should a rep call this lead back? Yes when register_lead rated it Hot (top 20%) and it isn't activated or
 * blocked. The owner is the field rep who referred it, else the territory rep. Returns a one-line summary.
 * @param lead {business_name, segment_code, city, bundle_name, monthly_total, stage, reason_not_closed, lead_score,
 *   priority, gstin_status, referral (from validateReferralCode), territory (from findTerritory)}
 */
function decideHandoff(lead) {
  const stage = normaliseStage(lead.stage);
  const isBlocked = lead.gstin_status === "Cancelled" || lead.gstin_status === "Suspended";
  const isHandoff = lead.priority === REACH_RATES.handoffPriority && stage !== "Activated" && !isBlocked;
  if (!isHandoff) return { isHandoff: false, ownerId: "", ownerLabel: "", summary: "" };
  const owner =
    lead.referral && lead.referral.isValid && lead.referral.referrerType === REFERRER_TYPE.FIELD_REP
      ? { id: lead.referral.referrerId, label: lead.referral.referrerLabel }
      : { id: lead.territory.repId, label: lead.territory.repLabel };
  const parts = [
    (lead.business_name || "Unnamed business") +
      " (" +
      (SEGMENT_LABEL[lead.segment_code] || "segment unknown") +
      (lead.city ? ", " + lead.city : "") +
      ")",
    lead.bundle_name
      ? "viewed " +
        lead.bundle_name +
        (Number(lead.monthly_total) > 0 ? " " + formatRupees(Number(lead.monthly_total)) + "/mo" : "")
      : "no bundle viewed",
    "dropped at " + stage + (lead.reason_not_closed ? ": " + lead.reason_not_closed : ""),
    "score " + lead.lead_score + " (" + lead.priority + ")",
  ];
  if (lead.referral && lead.referral.isValid) parts.push("referred by " + lead.referral.referrerLabel);
  return { isHandoff: true, ownerId: owner.id, ownerLabel: owner.label, summary: parts.join(" · ") };
}

function rewardStatus(lead, asOfDate) {
  if (lead.churned === true || String(lead.churned).toUpperCase() === "Y") return "void";
  const activatedAt = Date.parse(lead.activated_date);
  if (!isFinite(activatedAt)) return "held";
  const payableAt = activatedAt + REACH_RATES.payoutHoldDays * MILLISECONDS_PER_DAY;
  return asOfDate.getTime() >= payableAt ? "payable" : "held";
}

function cappedShare(rate, monthlyTotal) {
  return Math.min(rate.capInRupees, Math.round(rate.shareOfFirstMonthlyBill * monthlyTotal));
}

/**
 * Rewards a lead has earned. NOTHING is earned before activation. On activation:
 *   - the referrer (if the code is valid and known) earns its REACH_RATES.referral reward, unless the rate
 *     excludes how the sale was closed (a field rep is not paid a referral incentive on their own field sale)
 *   - the territory rep earns territory credit if Saathi closed the sale digitally (closed_by = "saathi"), unless
 *     that rep already earns the referral reward for the same activation (no double credit)
 * Each reward is "held" for payoutHoldDays, then "payable"; "void" if the customer churned.
 * @returns [{ beneficiaryType, beneficiaryId, beneficiaryLabel, rewardKind, amountInRupees, status }]
 */
function computeRewards(lead, asOfDate) {
  if (normaliseStage(lead.stage) !== REACH_RATES.earnOn) return [];
  const monthlyTotal = Number(lead.monthly_total) || 0;
  const status = rewardStatus(lead, asOfDate);
  const rewards = [];
  const referral = lead.referral;
  const closedBy = String(lead.closed_by || "").toLowerCase();
  const referralRate = referral && referral.isValid ? REACH_RATES.referral[referral.referrerType] : null;
  if (referralRate && (referralRate.notWhenClosedBy || []).indexOf(closedBy) < 0) {
    const rate = referralRate;
    rewards.push({
      beneficiaryType: referral.referrerType,
      beneficiaryId: referral.referrerId,
      beneficiaryLabel: referral.referrerLabel,
      rewardKind: rate.rewardKind,
      amountInRupees: cappedShare(rate, monthlyTotal),
      status,
    });
  }
  const territoryRate = REACH_RATES.territoryCredit;
  const isDigital = territoryRate.closedByValues.indexOf(closedBy) >= 0;
  const repAlreadyRewarded = rewards.some((reward) => reward.beneficiaryId === lead.territory.repId);
  if (isDigital && lead.territory.repId !== CENTRAL_DESK.id && !repAlreadyRewarded) {
    rewards.push({
      beneficiaryType: REFERRER_TYPE.FIELD_REP,
      beneficiaryId: lead.territory.repId,
      beneficiaryLabel: lead.territory.repLabel,
      rewardKind: territoryRate.rewardKind,
      amountInRupees: cappedShare(territoryRate, monthlyTotal),
      activationsCountedTowardTarget: territoryRate.activationsCountedTowardTarget,
      status,
    });
  }
  return rewards;
}

/** Everything the reach layer adds to one lead row (used by the Voiceflow function and the back-office page). */
function tagLead(lead, asOfDate) {
  const referral = validateReferralCode(lead.referral_code);
  const territory = findTerritory({ city: lead.city, state: lead.state, gstin: lead.gstin_masked });
  const enriched = Object.assign({}, lead, { referral, territory });
  return {
    referral,
    territory,
    dropOffStage: normaliseStage(lead.stage),
    handoff: decideHandoff(enriched),
    rewards: computeRewards(enriched, asOfDate || new Date()),
  };
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/** SIMULATED referrer directory: [{ type, id, label, territoryId }] for CA partners, customers and field reps. */
const REFERRER_DIRECTORY = /*__REFERRER_DIRECTORY__*/ [];
/** SIMULATED territories: one per case city, each owned by a field rep: [{ id, city, state, repId, repLabel }]. */
const TERRITORIES = /*__TERRITORIES__*/ [];
/** State → the territory that covers leads from that state outside the listed cities. */
const STATE_DEFAULT_TERRITORY = /*__STATE_DEFAULT_TERRITORY__*/ {};
/** GST state code (first two GSTIN digits) → state name, from the GST registry. */
const STATE_NAME_BY_CODE = /*__STATE_NAME_BY_CODE__*/ {};

export const REACH_RULES_API = {
  REACH_RATES,
  REFERRER_TYPE,
  FUNNEL_STAGES,
  SEGMENT_LABEL,
  REFERRER_DIRECTORY,
  TERRITORIES,
  issueReferralCode,
  normaliseReferralCode,
  validateReferralCode,
  customerIdFromOrderId,
  findReferrer,
  findTerritory,
  normaliseStage,
  decideHandoff,
  computeRewards,
  tagLead,
};
