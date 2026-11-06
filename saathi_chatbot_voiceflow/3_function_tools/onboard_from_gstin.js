/*
 * onboard_from_gstin.js: Voiceflow function tool "onboard_from_gstin" (TEMPLATE; the build injects the registry,
 * statistics from the case data, and the pricing function).
 *
 * What it does: "zero-question onboarding" (STRATEGY.md, CORE: "Your GSTIN is your application"). From a GSTIN:
 *   1. checks it (format, state code, checksum) and its registry status. Cancelled and Suspended GSTINs are
 *      blocked and routed to human review: no quote, never activated.
 *   2. reads the business name (trade name), location (city, state, city tier) and registration age
 *   3. infers the business category and scale, with a confidence value and the registry fields used
 *   4. when confident: prices the BASE bundle for the smallest sensible business in its segment, by calling the real
 *      pricing function (price_bundle, embedded unchanged by the build), so the first quote never overshoots. The
 *      segment's extras (POS, failover, CCTV, machine sensors) are offered as suggested add-ons, switched off and
 *      each priced by price_bundle. The greeting (English, Hindi or Kannada) states every assumption in plain words
 *   5. when not confident: returns ONE clarifying question instead of guessing
 *   6. sets a pre-approved flag with a one-line reason
 *
 * Udyam entry (STRATEGY.md §12): an owner without a GSTIN can start with their Udyam number instead (29% of the case
 * leads have no GSTIN). The number is read and masked by the shared udyam_input module (the same code verify_udyam
 * runs) and looked up in the embedded Udyam registry, whose business type (nic_description), city and state give
 * category, scale and location. From there the flow is the same: one question at most, price_bundle for every price
 * (priced without a GSTIN, so GST-only products are left out), the same consent gate. A GSTIN, when given, always
 * wins: the GST registry also has the registration status.
 *
 * How it fits: the "GSTIN-first onboarding" playbook calls it after the owner agrees to the consent notice, and
 * again with the owner's answer if it asked a question. The owner's answer always beats the registry inference.
 *
 * SIMULATED: the GST registry is the case's synthetic mock. The Udyam link is made at build time by business name
 * + state; production would follow the PAN inside the GSTIN to the Udyam record. Filing history is not in the case
 * data, so "clean status" means an Active registration at least 6 months old.
 */

/**
 * Voiceflow entry point: turns a GSTIN into a greeting with a priced proposal, one question, or a block.
 *
 * @param {{inputVars?: {gstin?: string, udyam_number?: string, consent_given?: string, lang?: string,
 *   answer_business_type?: string, answer_sites?: string, as_of_date?: string, show_card?: string}}} args
 *   consent_given = "yes" and either gstin or udyam_number are required. Both may be the owner's whole message ("my
 *   gstin is …", "my Udyam no. is …"): the number is read out of it. A Udyam number typed into gstin is recognised
 *   too. answer_* carry the owner's reply to a clarifying question.
 *   as_of_date (YYYY-MM-DD) fixes "today" for tests; by default it is today in India.
 * @returns {{outputVars: Object, trace: Array}}  Every declared output, always; next_action tells the playbook
 *   what to do: show_proposal, ask_question, human_review, fix_gstin, fix_udyam, use_advisor or ask_consent.
 * @example
 *   await main({ inputVars: { gstin: "07PUTXM1153M1Z9", consent_given: "yes", lang: "en" } })
 *   // → next_action "show_proposal", business_category "clinic", bundle_name "Office Pro", pre_approved true
 * @example
 *   await main({ inputVars: { udyam_number: "UDYAM-KL-00-3078801", consent_given: "yes", lang: "en" } })
 *   // → entry_type "udyam", next_action "show_proposal", business_category "clinic", priced with has_gstin "no"
 */
export default async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const language = detectLanguage(inputVars.lang);
  const text = MESSAGES[language];
  const outputVars = createEmptyOutputs();
  try {
    // Privacy by design (DPDP Act): no registry lookup until the owner has agreed to the notice.
    if (!isYes(inputVars.consent_given)) {
      outputVars.next_action = NEXT_ACTION.ASK_CONSENT;
      outputVars.greeting = text.consentNeeded;
      return respond(outputVars, inputVars, null);
    }

    outputVars.entry_type = chooseEntryType(inputVars);
    const record =
      outputVars.entry_type === ENTRY_TYPE.UDYAM
        ? lookUpUdyam(inputVars, outputVars, language)
        : lookUpGstin(inputVars, outputVars, language);
    // No record: the lookup already set next_action and the greeting (fix the number, or use the advisor).
    if (!record) return respond(outputVars, inputVars, null);

    const asOfDate = parseAsOfDate(inputVars.as_of_date);
    copyRegistryFacts(outputVars, record, asOfDate);
    const preApproval = decidePreApproval(record, asOfDate);
    outputVars.pre_approved = preApproval.isPreApproved;
    outputVars.pre_approval_reason = preApproval.reason;

    // Block cancelled/suspended GSTINs: 22 of 368 activations in smb_leads.csv went live on dead registrations.
    if (record.status !== STATUS.ACTIVE) {
      outputVars.is_blocked = true;
      outputVars.next_action = NEXT_ACTION.HUMAN_REVIEW;
      outputVars.greeting = fillTemplate(text.blocked, {
        gstin: outputVars.gstin_masked,
        name: record.tradeName,
        status: text.statusWord[record.status],
      });
      return respond(outputVars, inputVars, null);
    }

    const inference = inferBusiness(record, inputVars);
    copyInference(outputVars, inference);

    if (inference.profileId === PROFILE_ID.OTHER_UNKNOWN) {
      outputVars.next_action = NEXT_ACTION.USE_ADVISOR;
      outputVars.greeting = fillTemplate(text.tellMeMore, { name: record.tradeName });
      return respond(outputVars, inputVars, null);
    }

    const questionType = chooseQuestion(inference);
    if (questionType) {
      outputVars.next_action = NEXT_ACTION.ASK_QUESTION;
      outputVars.question_type = questionType;
      outputVars.clarifying_question = fillTemplate(text.questions[questionType], { name: record.tradeName });
      outputVars.question_options = text.questionOptions[questionType].join(OPTION_SEPARATOR);
      outputVars.greeting =
        writeFoundBusiness(record, outputVars, language) +
        "\n" +
        fillTemplate(text.oneQuestion, { question: outputVars.clarifying_question });
      return respond(outputVars, inputVars, null);
    }

    // The first quote must never overshoot: smallest sensible team, base bundle only (see SMALLEST_TEAM_BY_SEGMENT).
    const pricingInputs = buildPricingInputs(record, inference, language);
    const quote = await priceWith(pricingInputs, {});
    if (quote.error) throw new Error(quote.error);
    copyQuote(outputVars, quote, pricingInputs);
    const largestTeam = await largestTeamForSameQuote(pricingInputs, quote);
    const addons = await suggestAddons(pricingInputs, quote, language);
    const assumptions = describeAssumptions(record, inference, pricingInputs, largestTeam, quote, language);
    outputVars.assumptions_json = JSON.stringify(assumptions);
    outputVars.assumptions = writeAssumptionSentence(assumptions, language);
    outputVars.suggested_addons_json = JSON.stringify(addons);
    outputVars.next_action = NEXT_ACTION.SHOW_PROPOSAL;
    outputVars.greeting = writeProposalGreeting(record, outputVars, inference, preApproval, addons, language);
    return respond(outputVars, inputVars, outputVars.quote_text);
  } catch (error) {
    outputVars.error = ERROR_PREFIX + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG

/** What the playbook should do next. */
const NEXT_ACTION = {
  SHOW_PROPOSAL: "show_proposal",
  ASK_QUESTION: "ask_question",
  HUMAN_REVIEW: "human_review",
  FIX_GSTIN: "fix_gstin",
  FIX_UDYAM: "fix_udyam",
  USE_ADVISOR: "use_advisor",
  ASK_CONSENT: "ask_consent",
};

/** Which registry the owner's number was looked up in (entry_type output). */
const ENTRY_TYPE = { GSTIN: "gstin", UDYAM: "udyam" };
/**
 * Values of udyam_status: the udyam_input problem codes (INVALID_FORMAT, MULTIPLE_UDYAM), or these two. Empty on the
 * GSTIN path.
 */
const UDYAM_STATUS = { FOUND: "FOUND", NOT_FOUND: "NOT_FOUND" };
/** price_bundle's promise_type for "Connected in 72 hours, guaranteed" (an interface value; see price_bundle.js). */
const PROMISE_TYPE_GUARANTEED_72H = "guaranteed_72h";

/**
 * Values of gstin_status set in this file (same names as verify_gstin, so playbooks can share branches). The
 * input problems (INVALID_FORMAT, MULTIPLE_GSTINS, INVALID_STATE, CHECKSUM_FAILED) come from gstin_input.
 */
const STATUS = {
  ACTIVE: "Active",
  CANCELLED: "Cancelled",
  SUSPENDED: "Suspended",
  NOT_FOUND: "NOT_FOUND",
};

/** The seven categories asked for in the strategy; "other" covers offices, salons, gyms, hotels, pre-schools. */
const CATEGORY = {
  KIRANA_RETAIL: "kirana_retail",
  CLINIC: "clinic",
  CA_FIRM: "ca_firm",
  COACHING_CENTRE: "coaching_centre",
  RESTAURANT: "restaurant",
  SMALL_FACTORY: "small_factory",
  OTHER: "other",
  UNKNOWN: "unknown",
};
const CATEGORY_LABEL = {
  kirana_retail: "Kirana / retail",
  clinic: "Clinic",
  ca_firm: "CA firm",
  coaching_centre: "Coaching centre",
  restaurant: "Restaurant",
  small_factory: "Small factory",
  other: "Other",
  unknown: "Unknown",
};

/** Pricing segments understood by price_bundle (the case's four segments, Appendix A2). */
const SEGMENT = { MICRO: "micro", PROFESSIONAL: "prof", MULTI_SITE: "multi", MANUFACTURER: "mfg" };

/**
 * Business profiles. A profile fixes the category and either a fixed segment, or (for businesses that can be a
 * single shop or a chain) the segment of a single site plus how sure a proprietorship is to be a single site.
 * proprietorSingleSiteConfidence for shops = 0.88: 87.8% of proprietor retailers in smb_leads.csv had one site.
 * Food and hospitality are set to 0.5 (always ask): every restaurant, gym and hotel in the case data is a chain,
 * which says nothing about single restaurants in real life.
 */
const PROFILE_ID = {
  RETAIL_SHOP: "retail_shop",
  SALON: "salon",
  RESTAURANT: "restaurant",
  CHAIN_CAPABLE_SERVICE: "chain_capable_service",
  CLINIC: "clinic",
  CA_FIRM: "ca_firm",
  COACHING_CENTRE: "coaching_centre",
  SMALL_FACTORY: "small_factory",
  PROFESSIONAL_OTHER: "professional_other",
  OTHER_UNKNOWN: "other_unknown",
};
const PROFILES = {
  retail_shop: {
    category: CATEGORY.KIRANA_RETAIL,
    pricingBusinessType: "Retail shop",
    fixedSegment: null,
    singleSiteSegment: SEGMENT.MICRO,
    proprietorSingleSiteConfidence: 0.88,
  },
  salon: {
    category: CATEGORY.OTHER,
    pricingBusinessType: "Salon",
    fixedSegment: null,
    singleSiteSegment: SEGMENT.MICRO,
    proprietorSingleSiteConfidence: 0.88,
  },
  restaurant: {
    category: CATEGORY.RESTAURANT,
    pricingBusinessType: "Restaurant",
    fixedSegment: null,
    singleSiteSegment: SEGMENT.MICRO,
    proprietorSingleSiteConfidence: 0.5,
  },
  chain_capable_service: {
    category: CATEGORY.OTHER,
    pricingBusinessType: "Gym, hotel or pre-school",
    fixedSegment: null,
    singleSiteSegment: SEGMENT.MICRO,
    proprietorSingleSiteConfidence: 0.5,
  },
  clinic: { category: CATEGORY.CLINIC, pricingBusinessType: "Clinic", fixedSegment: SEGMENT.PROFESSIONAL },
  ca_firm: { category: CATEGORY.CA_FIRM, pricingBusinessType: "CA firm", fixedSegment: SEGMENT.PROFESSIONAL },
  coaching_centre: {
    category: CATEGORY.COACHING_CENTRE,
    pricingBusinessType: "Coaching centre",
    fixedSegment: SEGMENT.PROFESSIONAL,
  },
  small_factory: {
    category: CATEGORY.SMALL_FACTORY,
    pricingBusinessType: "Small factory",
    fixedSegment: SEGMENT.MANUFACTURER,
  },
  professional_other: { category: CATEGORY.OTHER, pricingBusinessType: "Office", fixedSegment: SEGMENT.PROFESSIONAL },
  other_unknown: { category: CATEGORY.OTHER, pricingBusinessType: "", fixedSegment: null },
};

/** Udyam business types (nic_description) → profile. The exact segment of each comes from the case data. */
const PROFILE_BY_NIC_DESCRIPTION = {
  "Kirana store": PROFILE_ID.RETAIL_SHOP,
  Bakery: PROFILE_ID.RETAIL_SHOP,
  "Bakery chain": PROFILE_ID.RETAIL_SHOP,
  Boutique: PROFILE_ID.RETAIL_SHOP,
  "Apparel retail chain": PROFILE_ID.RETAIL_SHOP,
  "Electronics retail chain": PROFILE_ID.RETAIL_SHOP,
  "Hardware store": PROFILE_ID.RETAIL_SHOP,
  "Mobile repair shop": PROFILE_ID.RETAIL_SHOP,
  Optician: PROFILE_ID.RETAIL_SHOP,
  Pharmacy: PROFILE_ID.RETAIL_SHOP,
  "Pharmacy chain": PROFILE_ID.RETAIL_SHOP,
  "Stationery shop": PROFILE_ID.RETAIL_SHOP,
  "Sweet shop": PROFILE_ID.RETAIL_SHOP,
  Salon: PROFILE_ID.SALON,
  "Restaurant chain": PROFILE_ID.RESTAURANT,
  "Gym chain": PROFILE_ID.CHAIN_CAPABLE_SERVICE,
  "Budget hotel group": PROFILE_ID.CHAIN_CAPABLE_SERVICE,
  "Pre-school chain": PROFILE_ID.CHAIN_CAPABLE_SERVICE,
  "Dental clinic": PROFILE_ID.CLINIC,
  "Diagnostic lab": PROFILE_ID.CLINIC,
  "Physiotherapy clinic": PROFILE_ID.CLINIC,
  "CA firm": PROFILE_ID.CA_FIRM,
  "Coaching centre": PROFILE_ID.COACHING_CENTRE,
  "Law office": PROFILE_ID.PROFESSIONAL_OTHER,
  "Architecture studio": PROFILE_ID.PROFESSIONAL_OTHER,
  "Insurance agency": PROFILE_ID.PROFESSIONAL_OTHER,
  "Real estate agency": PROFILE_ID.PROFESSIONAL_OTHER,
  "Travel agency": PROFILE_ID.PROFESSIONAL_OTHER,
  "Auto-parts unit": PROFILE_ID.SMALL_FACTORY,
  "Food processing unit": PROFILE_ID.SMALL_FACTORY,
  "Furniture workshop": PROFILE_ID.SMALL_FACTORY,
  "Packaging unit": PROFILE_ID.SMALL_FACTORY,
  "Plastic moulding unit": PROFILE_ID.SMALL_FACTORY,
  "Printing press": PROFILE_ID.SMALL_FACTORY,
  "Textile unit": PROFILE_ID.SMALL_FACTORY,
};

/**
 * How sure a trade-name word makes us of the category. "clear" is capped at 0.85 although clear words were right
 * for ≥ 99% of the synthetic registry: real business names are messier than the case data. "ambiguous" words are
 * shared by two kinds of business, e.g. "Associates" = 106 CA firms and 114 law offices in the registry.
 */
const NAME_CONFIDENCE = { clear: 0.85, ambiguous: 0.5 };

/** Trade-name words, checked in this order (specific before general). Whole words or phrases only. */
const NAME_RULES = [
  {
    words: ["dental", "dentist", "diagnostic", "diagnostics", "pathology", "physio", "physiotherapy", "clinic"],
    profileId: PROFILE_ID.CLINIC,
    confidence: NAME_CONFIDENCE.clear,
  },
  {
    words: ["hospital", "nursing home", "healthcare", "health care"],
    profileId: PROFILE_ID.CLINIC,
    confidence: NAME_CONFIDENCE.clear,
  },
  {
    words: ["chartered accountants", "tax consultants", "accountants", "audit", "& co"],
    profileId: PROFILE_ID.CA_FIRM,
    confidence: NAME_CONFIDENCE.clear,
  },
  {
    words: ["advocates", "legal", "law", "solicitors"],
    profileId: PROFILE_ID.PROFESSIONAL_OTHER,
    confidence: NAME_CONFIDENCE.clear,
  },
  { words: ["associates"], profileId: PROFILE_ID.CA_FIRM, confidence: NAME_CONFIDENCE.ambiguous },
  {
    words: ["kids academy", "play school", "playschool", "preschool", "pre-school", "kindergarten", "montessori"],
    profileId: PROFILE_ID.CHAIN_CAPABLE_SERVICE,
    confidence: NAME_CONFIDENCE.clear,
  },
  {
    words: ["classes", "coaching", "tutorials", "tuition", "institute", "career"],
    profileId: PROFILE_ID.COACHING_CENTRE,
    confidence: NAME_CONFIDENCE.clear,
  },
  // "Academy" is used by coaching centres and pre-schools alike.
  { words: ["academy"], profileId: PROFILE_ID.COACHING_CENTRE, confidence: NAME_CONFIDENCE.ambiguous },
  {
    words: ["kitchens", "kitchen", "restaurant", "dhaba", "cafe", "caterers", "biryani", "bhojanalaya", "eatery"],
    profileId: PROFILE_ID.RESTAURANT,
    confidence: NAME_CONFIDENCE.clear,
  },
  // "Foods" is used by food processors, restaurants and food traders alike.
  { words: ["foods"], profileId: PROFILE_ID.SMALL_FACTORY, confidence: NAME_CONFIDENCE.ambiguous },
  {
    words: [
      "textiles",
      "polymers",
      "plastics",
      "printers",
      "printing",
      "packaging",
      "components",
      "industries",
      "udyog",
      "engineering",
      "woodcraft",
      "furniture",
      "mills",
      "fabricators",
      "manufacturing",
      "moulding",
    ],
    profileId: PROFILE_ID.SMALL_FACTORY,
    confidence: NAME_CONFIDENCE.clear,
  },
  {
    words: [
      "realty",
      "real estate",
      "estates",
      "properties",
      "travels",
      "tours",
      "holidays",
      "insurance",
      "advisors",
      "architects",
      "architecture",
      "studio",
      "design",
    ],
    profileId: PROFILE_ID.PROFESSIONAL_OTHER,
    confidence: NAME_CONFIDENCE.clear,
  },
  {
    words: ["salon", "beauty", "parlour", "parlor", "spa", "unisex"],
    profileId: PROFILE_ID.SALON,
    confidence: NAME_CONFIDENCE.clear,
  },
  {
    words: ["fitness", "gym", "stays", "hotel", "hotels", "lodge", "inn", "residency"],
    profileId: PROFILE_ID.CHAIN_CAPABLE_SERVICE,
    confidence: NAME_CONFIDENCE.clear,
  },
  {
    words: [
      "kirana",
      "general store",
      "provisions",
      "supermarket",
      "mart",
      "stores",
      "store",
      "traders",
      "medicals",
      "medical",
      "chemists",
      "pharma",
      "pharmacy",
      "opticals",
      "optician",
      "stationers",
      "stationery",
      "sweets",
      "mithai",
      "bakers",
      "bakery",
      "bake house",
      "boutique",
      "fashions",
      "garments",
      "hardware",
      "electronics",
      "mobiles",
      "mobile",
      "retail",
      "emporium",
    ],
    profileId: PROFILE_ID.RETAIL_SHOP,
    confidence: NAME_CONFIDENCE.clear,
  },
];

/**
 * Confidence of the Udyam business type. Measured 1.00 on the 1,964 GSTINs with a unique name + state link in the
 * case data; capped at 0.95 because a name + state match can link a namesake (production would link by PAN).
 */
const UDYAM_LINK_CONFIDENCE = 0.95;
/**
 * Confidence of the business type when the owner gave their OWN Udyam number (Udyam entry): no name + state link, so
 * no namesake risk. The nic_description gave the right segment for 100% of linked leads in the case data.
 */
const UDYAM_DIRECT_CONFIDENCE = 1;
/** When the trade name and the Udyam record agree, confidence rises to at most this. */
const MAX_COMBINED_CONFIDENCE = 0.99;
/** When they disagree, the Udyam category is kept but its confidence is multiplied by this (forces a question). */
const DISAGREEMENT_PENALTY = 0.6;
/**
 * Companies and LLPs that sell retail are treated as chains: none of the 1,091 companies/LLPs in the registry was a
 * single-site shop. Capped at 0.9 for the same real-world reason as above. A chain still triggers the locations
 * question, because the price scales with the number of sites.
 */
const COMPANY_CHAIN_CONFIDENCE = 0.9;
/** Below this overall confidence the function asks one question instead of proposing. Design choice. */
const PROPOSAL_CONFIDENCE_THRESHOLD = 0.7;
/** The owner's own answer is taken as certain. */
const OWNER_ANSWER_CONFIDENCE = 1;
/** Clinics, CA firms, coaching centres, offices and factories were all single-scale segments in the case data. */
const FIXED_SCALE_CONFIDENCE = 1;
/** The Udyam business type already says "chain" or not (e.g. "Pharmacy chain"), so scale is as sure as the link. */
const UDYAM_SCALE_CONFIDENCE = 1;
/** 3+ sites makes a business "multi-site" (case Appendix A2: "3–10 store retailer"); same rule as price_bundle. */
const SITES_FOR_MULTI_SITE = 3;
/** Single-site segments start with one location (median num_sites for those segments in smb_leads.csv is 1). */
const DEFAULT_SITE_COUNT = 1;

/**
 * Locations-question answers → number of sites: the LOWEST number in each range ("10+" counts as 10), so the first
 * quote never assumes more sites than the owner has. Telling Saathi the exact number re-quotes.
 */
const SITE_COUNT_BY_ANSWER = { 1: 1, 2: 2, "3–5": 3, "6–10": 6, "10+": 10 };

/**
 * Sizing rule for the first quote (design choice; the outside review found 77% of first quotes above the price at
 * the business's true size when the segment MEDIAN was used): price for the SMALLEST sensible business in the
 * segment. That is the smallest team seen for the segment in smb_leads.csv (SMALLEST_TEAM_BY_SEGMENT, injected by
 * the build: shops and services 1, offices 3, chains 15, factories 12), and never fewer than one person per site.
 * price_bundle's price only grows with team size and sites, so the first quote is at most what the business pays
 * at its true size: telling Saathi the real size can only move it up, never surprise the owner later.
 */
const MIN_PEOPLE_PER_SITE = 1;
/** Used only if a segment had no data in the case pack: one person. */
const FALLBACK_SMALLEST_TEAM = 1;
/**
 * The greeting says which team sizes the same quote covers ("a team of 1–2"). The upper end is found by re-pricing
 * with one more person at a time, up to this many people above the smallest team (price_bundle's steps for every
 * segment come well before that).
 */
const TEAM_SIZE_SEARCH_LIMIT = 60;

/**
 * Suggested add-ons per segment, from the case's "key needs" (Appendix A2). They are NOT in the first total: each
 * is priced on its own by price_bundle (base + that need, minus base) and offered switched off. A need the base
 * bundle already covers (no price difference), or one the business can't buy, is left out.
 */
const SUGGESTED_ADDON_NEEDS_BY_SEGMENT = {
  micro: ["pos"],
  prof: ["failover", "email", "storage", "security"],
  multi: ["cctv"],
  mfg: ["iot"],
};

/** Connection product in a quote → the connection the quote assumes can reach the business. */
const CONNECTION_ASSUMPTION_BY_PRODUCT = { P01: "fibre", P02: "fibre", P03: "fibre", P05: "leased", P06: "leased" };
/** Assumption keys, in the order the greeting states them. */
const ASSUMPTION = {
  BUSINESS_TYPE: "business_type",
  TEAM_SIZE: "team_size",
  LOCATIONS: "locations",
  CONNECTION: "connection",
};
/** English needs "an" before these letters ("an insurance agency", "an office"). */
const ENGLISH_VOWELS = "aeiou";

/** Pre-approval: an Active registration at least this old. Design choice; filing history isn't in the case data. */
const PRE_APPROVAL_MIN_REGISTRATION_MONTHS = 6;
const PRE_APPROVAL_REASONS = {
  invalid: "Not pre-approved: the GSTIN failed the format or checksum check.",
  notFound: "Not pre-approved: the GSTIN is not in the GST registry.",
  blocked: "Not pre-approved: the GST registration is {status}; routed to human review, never activated.",
  tooNew:
    "Not pre-approved: the GST registration is only {months} months old; a specialist confirms before activation.",
  approved:
    "Pre-approved: GST registration Active for {years} years (filing history is not in the case data, so not checked).",
  udyamInvalid: "Not pre-approved: no single valid Udyam number in the message.",
  udyamNotFound: "Not pre-approved: the Udyam number is not in the Udyam registry.",
  udyamTooNew:
    "Not pre-approved: the Udyam registration is only {months} months old; a specialist confirms before activation.",
  udyamApproved:
    "Pre-approved: Udyam registration {years} years old (no GSTIN; the Udyam registry has no status field, so it is not checked).",
};

const IST_OFFSET_MINUTES = 330;
const MILLISECONDS_PER_MINUTE = 60000;
const MILLISECONDS_PER_DAY = 86400000;
const DAYS_PER_YEAR = 365.25;
const YES_WORDS = ["yes", "y", "true", "1", "haan", "ha", "हाँ", "हां", "ಹೌದು", "agree", "i agree"];
const OPTION_SEPARATOR = " | ";
const ERROR_PREFIX = "onboard_from_gstin failed: ";

// ================================================================ MESSAGES (all user-facing text)
// Hindi and Kannada text was written for this prototype; have native speakers review it before going live.

const MESSAGES = {
  en: {
    consentNeeded:
      "Before I look up your GST or Udyam number: we use it only to find your business in the government registry and prepare your plan. Never for marketing. Is that okay?",
    notFound:
      "I couldn't find this GSTIN in the GST registry. No problem: tell me a little about your business and I'll suggest a plan.",
    udyamNotFound:
      "I couldn't find this Udyam number in the Udyam registry. No problem: tell me a little about your business and I'll suggest a plan.",
    blocked:
      "The GST registry shows {gstin} ({name}) as {status}, so I can't set up a connection on it. Our team will review it and get back to you.",
    statusWord: { Cancelled: "CANCELLED", Suspended: "SUSPENDED" },
    tellMeMore: "Thanks! Tell me a little about what {name} does, and I'll suggest a plan.",
    foundBusiness: "Namaste! I found {name}, {city} on the GST registry (active since {year}).",
    foundBusinessUdyam: "Namaste! I found {name}, {city} on the Udyam registry (registered in {year}).",
    oneQuestion: "One quick question so I suggest the right plan: {question}",
    proposal: "For {name} ({category}), I suggest {bundle}: {price}/month, GST extra. {promise}",
    promiseGuaranteed72h: "Connected in 72 hours, guaranteed, or month one is free.",
    promiseFirmDate: "Connected within {days} days of your order, guaranteed, or month one is free.",
    preApproved: "✅ Pre-approved: your GST record is enough, no certificate upload needed.",
    notPreApproved: "Your GST registration is new, so a specialist will confirm a few details before activation.",
    preApprovedUdyam: "✅ Pre-approved: your Udyam record is enough, no certificate upload needed.",
    notPreApprovedUdyam:
      "Your Udyam registration is new, so a specialist will confirm a few details before activation.",
    assumptionSentence: "I've assumed {list}. Tell me if you're bigger or anything is different.",
    assumptionParts: {
      business_type: "{article} {business}",
      team_size: "a team of {team}",
      locations: { one: "{sites} location", many: "{sites} locations" },
      connection: { fibre: "business fibre reaching your address", leased: "a leased line reaching your site" },
    },
    listSeparator: ", ",
    lastSeparator: " and ",
    addonsSentence: "Optional, not in the price above: {list}. Tell me if you'd like any of them.",
    addonItem: "{name} +{price}/month{setup}, to {reason}",
    addonSetup: " ({setup} one-time)",
    addonSeparator: "; ",
    addonReasons: {
      pos: "bill faster and take UPI and card payments at the counter",
      failover: "stay online when the main line is down",
      email: "get business email on your own domain",
      storage: "back up your PCs and phones automatically",
      security: "protect your devices from viruses and ransomware",
      cctv: "watch every outlet from your phone, with 30-day cloud recording",
      iot: "track machine uptime and power use",
    },
    questions: {
      business_type: "What kind of business is {name}?",
      locations: "How many locations does {name} have?",
    },
    questionOptions: {
      business_type: [
        "Shop / kirana",
        "Clinic or lab",
        "CA firm",
        "Coaching centre",
        "Restaurant",
        "Small factory",
        "Other",
      ],
      locations: ["1", "2", "3–5", "6–10", "10+"],
    },
    categoryWord: {
      kirana_retail: "shop",
      clinic: "clinic",
      ca_firm: "CA firm",
      coaching_centre: "coaching centre",
      restaurant: "restaurant",
      small_factory: "factory",
      other: "business",
    },
  },
  hi: {
    consentNeeded:
      "आपका GST या Udyam नंबर देखने से पहले: हम इसे सिर्फ़ सरकारी रजिस्ट्री में आपका बिज़नेस ढूँढने और प्लान बनाने के लिए इस्तेमाल करेंगे, मार्केटिंग के लिए नहीं। क्या यह ठीक है?",
    notFound:
      "यह GSTIN GST रजिस्ट्री में नहीं मिला। कोई बात नहीं: अपने बिज़नेस के बारे में थोड़ा बताइए, मैं प्लान सुझाता हूँ।",
    udyamNotFound:
      "यह Udyam नंबर Udyam रजिस्ट्री में नहीं मिला। कोई बात नहीं: अपने बिज़नेस के बारे में थोड़ा बताइए, मैं प्लान सुझाता हूँ।",
    blocked:
      "GST रजिस्ट्री में {gstin} ({name}) {status} दिख रहा है, इसलिए इस पर कनेक्शन नहीं बन सकता। हमारी टीम इसे जाँचकर आपसे संपर्क करेगी।",
    statusWord: { Cancelled: "रद्द (Cancelled)", Suspended: "निलंबित (Suspended)" },
    tellMeMore: "धन्यवाद! {name} क्या काम करता है, थोड़ा बताइए, मैं प्लान सुझाता हूँ।",
    foundBusiness: "नमस्ते! GST रजिस्ट्री में आपका बिज़नेस मिल गया: {name}, {city} ({year} से एक्टिव)।",
    foundBusinessUdyam: "नमस्ते! Udyam रजिस्ट्री में आपका बिज़नेस मिल गया: {name}, {city} ({year} में रजिस्टर्ड)।",
    oneQuestion: "सही प्लान बताने के लिए बस एक सवाल: {question}",
    proposal: "{name} ({category}) के लिए मेरा सुझाव: {bundle}, {price}/माह, GST अलग। {promise}",
    promiseGuaranteed72h: "72 घंटे में कनेक्शन की गारंटी, वरना पहला महीना मुफ़्त।",
    promiseFirmDate: "ऑर्डर के {days} दिनों के अंदर कनेक्शन की गारंटी, वरना पहला महीना मुफ़्त।",
    preApproved: "✅ प्री-अप्रूव्ड: आपका GST रिकॉर्ड काफ़ी है, सर्टिफ़िकेट अपलोड की ज़रूरत नहीं।",
    notPreApproved: "आपका GST रजिस्ट्रेशन नया है, इसलिए एक्टिवेशन से पहले हमारे स्पेशलिस्ट कुछ बातें पक्की करेंगे।",
    preApprovedUdyam: "✅ प्री-अप्रूव्ड: आपका Udyam रिकॉर्ड काफ़ी है, सर्टिफ़िकेट अपलोड की ज़रूरत नहीं।",
    notPreApprovedUdyam:
      "आपका Udyam रजिस्ट्रेशन नया है, इसलिए एक्टिवेशन से पहले हमारे स्पेशलिस्ट कुछ बातें पक्की करेंगे।",
    assumptionSentence: "मैंने माना है: {list}। टीम बड़ी हो या कुछ और अलग हो तो बताइए।",
    assumptionParts: {
      business_type: "{business}",
      team_size: "{team} लोगों की टीम",
      locations: { one: "{sites} जगह", many: "{sites} जगहें" },
      connection: { fibre: "आपके पते तक बिज़नेस फ़ाइबर", leased: "आपकी साइट तक लीज़्ड लाइन" },
    },
    listSeparator: ", ",
    lastSeparator: " और ",
    addonsSentence: "वैकल्पिक, ऊपर की क़ीमत में शामिल नहीं: {list}। इनमें से कुछ चाहिए तो बताइए।",
    addonItem: "{name} +{price}/माह{setup}, {reason}",
    addonSetup: " ({setup} एक बार)",
    addonSeparator: "; ",
    addonReasons: {
      pos: "काउंटर पर तेज़ बिलिंग और UPI/कार्ड पेमेंट के लिए",
      failover: "मुख्य लाइन बंद होने पर भी ऑनलाइन रहने के लिए",
      email: "अपने डोमेन पर बिज़नेस ईमेल के लिए",
      storage: "PC और फ़ोन के अपने-आप बैकअप के लिए",
      security: "वायरस और रैनसमवेयर से बचाव के लिए",
      cctv: "फ़ोन से हर आउटलेट देखने के लिए, 30 दिन की क्लाउड रिकॉर्डिंग",
      iot: "मशीनों के चलने का समय और बिजली खपत देखने के लिए",
    },
    questions: {
      business_type: "{name} किस तरह का बिज़नेस है?",
      locations: "{name} कितनी जगहों पर है?",
    },
    questionOptions: {
      business_type: [
        "दुकान / किराना",
        "क्लिनिक या लैब",
        "CA फ़र्म",
        "कोचिंग सेंटर",
        "रेस्टोरेंट",
        "छोटी फ़ैक्ट्री",
        "कुछ और",
      ],
      locations: ["1", "2", "3–5", "6–10", "10+"],
    },
    categoryWord: {
      kirana_retail: "दुकान",
      clinic: "क्लिनिक",
      ca_firm: "CA फ़र्म",
      coaching_centre: "कोचिंग सेंटर",
      restaurant: "रेस्टोरेंट",
      small_factory: "फ़ैक्ट्री",
      other: "बिज़नेस",
    },
  },
  kn: {
    consentNeeded:
      "ನಿಮ್ಮ GST ಅಥವಾ Udyam ಸಂಖ್ಯೆ ನೋಡುವ ಮೊದಲು: ಇದನ್ನು ಸರ್ಕಾರಿ ನೋಂದಣಿಯಲ್ಲಿ ನಿಮ್ಮ ವ್ಯಾಪಾರ ಹುಡುಕಲು ಮತ್ತು ಪ್ಲಾನ್ ಸಿದ್ಧಪಡಿಸಲು ಮಾತ್ರ ಬಳಸುತ್ತೇವೆ, ಮಾರ್ಕೆಟಿಂಗ್ ಉದ್ದೇಶಕ್ಕೆ ಅಲ್ಲ. ಸರಿಯೇ?",
    notFound:
      "ಈ GSTIN GST ನೋಂದಣಿಯಲ್ಲಿ ಸಿಗಲಿಲ್ಲ. ಪರವಾಗಿಲ್ಲ: ನಿಮ್ಮ ವ್ಯಾಪಾರದ ಬಗ್ಗೆ ಸ್ವಲ್ಪ ತಿಳಿಸಿ, ನಾನು ಪ್ಲಾನ್ ಸೂಚಿಸುತ್ತೇನೆ.",
    udyamNotFound:
      "ಈ Udyam ಸಂಖ್ಯೆ Udyam ನೋಂದಣಿಯಲ್ಲಿ ಸಿಗಲಿಲ್ಲ. ಪರವಾಗಿಲ್ಲ: ನಿಮ್ಮ ವ್ಯಾಪಾರದ ಬಗ್ಗೆ ಸ್ವಲ್ಪ ತಿಳಿಸಿ, ನಾನು ಪ್ಲಾನ್ ಸೂಚಿಸುತ್ತೇನೆ.",
    blocked:
      "GST ನೋಂದಣಿಯಲ್ಲಿ {gstin} ({name}) {status} ಎಂದು ತೋರಿಸುತ್ತಿದೆ, ಆದ್ದರಿಂದ ಇದರ ಮೇಲೆ ಸಂಪರ್ಕ ನೀಡಲು ಸಾಧ್ಯವಿಲ್ಲ. ನಮ್ಮ ತಂಡ ಇದನ್ನು ಪರಿಶೀಲಿಸಿ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತದೆ.",
    statusWord: { Cancelled: "ರದ್ದು (Cancelled)", Suspended: "ಅಮಾನತು (Suspended)" },
    tellMeMore: "ಧನ್ಯವಾದ! {name} ಏನು ಕೆಲಸ ಮಾಡುತ್ತದೆ ಎಂದು ಸ್ವಲ್ಪ ತಿಳಿಸಿ, ನಾನು ಪ್ಲಾನ್ ಸೂಚಿಸುತ್ತೇನೆ.",
    foundBusiness: "ನಮಸ್ಕಾರ! GST ನೋಂದಣಿಯಲ್ಲಿ ನಿಮ್ಮ ವ್ಯಾಪಾರ ಸಿಕ್ಕಿದೆ: {name}, {city} ({year} ರಿಂದ ಸಕ್ರಿಯ).",
    foundBusinessUdyam: "ನಮಸ್ಕಾರ! Udyam ನೋಂದಣಿಯಲ್ಲಿ ನಿಮ್ಮ ವ್ಯಾಪಾರ ಸಿಕ್ಕಿದೆ: {name}, {city} ({year} ರಲ್ಲಿ ನೋಂದಣಿ).",
    oneQuestion: "ಸರಿಯಾದ ಪ್ಲಾನ್ ಸೂಚಿಸಲು ಒಂದೇ ಪ್ರಶ್ನೆ: {question}",
    proposal: "{name} ({category}) ಗಾಗಿ ನನ್ನ ಸಲಹೆ: {bundle}, ತಿಂಗಳಿಗೆ {price}, GST ಪ್ರತ್ಯೇಕ. {promise}",
    promiseGuaranteed72h: "72 ಗಂಟೆಗಳಲ್ಲಿ ಸಂಪರ್ಕದ ಗ್ಯಾರಂಟಿ, ಇಲ್ಲದಿದ್ದರೆ ಮೊದಲ ತಿಂಗಳು ಉಚಿತ.",
    promiseFirmDate: "ಆರ್ಡರ್ ಮಾಡಿದ {days} ದಿನಗಳೊಳಗೆ ಸಂಪರ್ಕದ ಗ್ಯಾರಂಟಿ, ಇಲ್ಲದಿದ್ದರೆ ಮೊದಲ ತಿಂಗಳು ಉಚಿತ.",
    preApproved: "✅ ಪೂರ್ವ-ಅನುಮೋದಿತ: ನಿಮ್ಮ GST ದಾಖಲೆ ಸಾಕು, ಪ್ರಮಾಣಪತ್ರ ಬೇಕಿಲ್ಲ.",
    preApprovedUdyam: "✅ ಪೂರ್ವ-ಅನುಮೋದಿತ: ನಿಮ್ಮ Udyam ದಾಖಲೆ ಸಾಕು, ಪ್ರಮಾಣಪತ್ರ ಬೇಕಿಲ್ಲ.",
    notPreApproved:
      "ನಿಮ್ಮ GST ನೋಂದಣಿ ಹೊಸದಾಗಿರುವುದರಿಂದ, ಸಕ್ರಿಯಗೊಳಿಸುವ ಮೊದಲು ನಮ್ಮ ತಜ್ಞರು ಕೆಲವು ವಿವರಗಳನ್ನು ಖಚಿತಪಡಿಸುತ್ತಾರೆ.",
    notPreApprovedUdyam:
      "ನಿಮ್ಮ Udyam ನೋಂದಣಿ ಹೊಸದಾಗಿರುವುದರಿಂದ, ಸಕ್ರಿಯಗೊಳಿಸುವ ಮೊದಲು ನಮ್ಮ ತಜ್ಞರು ಕೆಲವು ವಿವರಗಳನ್ನು ಖಚಿತಪಡಿಸುತ್ತಾರೆ.",
    assumptionSentence: "ನಾನು ಊಹಿಸಿರುವುದು: {list}. ನಿಮ್ಮ ತಂಡ ದೊಡ್ಡದಿದ್ದರೆ ಅಥವಾ ಬೇರೆ ಏನಾದರೂ ಬೇರೆ ಇದ್ದರೆ ತಿಳಿಸಿ.",
    assumptionParts: {
      business_type: "{business}",
      team_size: "{team} ಜನರ ತಂಡ",
      locations: { one: "{sites} ಸ್ಥಳ", many: "{sites} ಸ್ಥಳಗಳು" },
      connection: { fibre: "ನಿಮ್ಮ ವಿಳಾಸಕ್ಕೆ ಬಿಸಿನೆಸ್ ಫೈಬರ್", leased: "ನಿಮ್ಮ ಸ್ಥಳಕ್ಕೆ ಲೀಸ್ಡ್ ಲೈನ್" },
    },
    listSeparator: ", ",
    lastSeparator: " ಮತ್ತು ",
    addonsSentence: "ಐಚ್ಛಿಕ, ಮೇಲಿನ ಬೆಲೆಯಲ್ಲಿ ಸೇರಿಲ್ಲ: {list}. ಯಾವುದಾದರೂ ಬೇಕಿದ್ದರೆ ತಿಳಿಸಿ.",
    addonItem: "{name}: ತಿಂಗಳಿಗೆ +{price}{setup}, {reason}",
    addonSetup: " ({setup} ಒಮ್ಮೆ)",
    addonSeparator: "; ",
    addonReasons: {
      pos: "ಕೌಂಟರ್‌ನಲ್ಲಿ ವೇಗದ ಬಿಲ್ಲಿಂಗ್ ಮತ್ತು UPI/ಕಾರ್ಡ್ ಪಾವತಿಗಾಗಿ",
      failover: "ಮುಖ್ಯ ಲೈನ್ ಸ್ಥಗಿತವಾದರೂ ಆನ್‌ಲೈನ್‌ನಲ್ಲಿರಲು",
      email: "ನಿಮ್ಮದೇ ಡೊಮೇನ್‌ನಲ್ಲಿ ಬಿಸಿನೆಸ್ ಇಮೇಲ್‌ಗಾಗಿ",
      storage: "PC ಮತ್ತು ಫೋನ್‌ಗಳ ಸ್ವಯಂ ಬ್ಯಾಕಪ್‌ಗಾಗಿ",
      security: "ವೈರಸ್ ಮತ್ತು ರ್ಯಾನ್ಸಮ್‌ವೇರ್‌ನಿಂದ ರಕ್ಷಣೆಗಾಗಿ",
      cctv: "ಫೋನ್‌ನಿಂದಲೇ ಪ್ರತಿ ಶಾಖೆಯನ್ನು ನೋಡಲು, 30 ದಿನಗಳ ಕ್ಲೌಡ್ ರೆಕಾರ್ಡಿಂಗ್",
      iot: "ಯಂತ್ರಗಳ ಕಾರ್ಯ ಸಮಯ ಮತ್ತು ವಿದ್ಯುತ್ ಬಳಕೆ ನೋಡಲು",
    },
    questions: {
      business_type: "ನಿಮ್ಮ ವ್ಯಾಪಾರ ಯಾವ ರೀತಿಯದು?",
      locations: "ನಿಮ್ಮ ವ್ಯಾಪಾರಕ್ಕೆ ಎಷ್ಟು ಶಾಖೆಗಳಿವೆ?",
    },
    questionOptions: {
      business_type: [
        "ಅಂಗಡಿ / ಕಿರಾಣಿ",
        "ಕ್ಲಿನಿಕ್ ಅಥವಾ ಲ್ಯಾಬ್",
        "CA ಸಂಸ್ಥೆ",
        "ಕೋಚಿಂಗ್ ಕೇಂದ್ರ",
        "ರೆಸ್ಟೋರೆಂಟ್",
        "ಸಣ್ಣ ಕಾರ್ಖಾನೆ",
        "ಬೇರೆ",
      ],
      locations: ["1", "2", "3–5", "6–10", "10+"],
    },
    categoryWord: {
      kirana_retail: "ಅಂಗಡಿ",
      clinic: "ಕ್ಲಿನಿಕ್",
      ca_firm: "CA ಸಂಸ್ಥೆ",
      coaching_centre: "ಕೋಚಿಂಗ್ ಕೇಂದ್ರ",
      restaurant: "ರೆಸ್ಟೋರೆಂಟ್",
      small_factory: "ಕಾರ್ಖಾನೆ",
      other: "ವ್ಯಾಪಾರ",
    },
  },
};

/** Business-type answer buttons (same order in every language) → profile. "Other" goes to the advisor. */
const PROFILE_BY_BUSINESS_TYPE_OPTION_INDEX = [
  PROFILE_ID.RETAIL_SHOP,
  PROFILE_ID.CLINIC,
  PROFILE_ID.CA_FIRM,
  PROFILE_ID.COACHING_CENTRE,
  PROFILE_ID.RESTAURANT,
  PROFILE_ID.SMALL_FACTORY,
  PROFILE_ID.OTHER_UNKNOWN,
];

// ================================================================ LOGIC: inputs and outputs

function createEmptyOutputs() {
  return {
    entry_type: "",
    gstin_valid: false,
    gstin_status: "",
    gstin_masked: "",
    udyam_valid: false,
    udyam_status: "",
    udyam_masked: "",
    is_blocked: false,
    next_action: "",
    business_name: "",
    gst_city: "",
    gst_state: "",
    city_tier: 0,
    constitution: "",
    registration_date: "",
    registration_age_years: 0,
    business_category: "",
    category_label: "",
    segment_code: "",
    segment_confidence: 0,
    evidence_fields: "",
    assumptions: "",
    assumptions_json: "[]",
    clarifying_question: "",
    question_type: "",
    question_options: "",
    pricing_inputs_json: "",
    bundle_name: "",
    monthly_total: 0,
    setup_total: 0,
    contract_months: 0,
    install_days: 0,
    promise_type: "",
    promise_hours: 0,
    promise_days: 0,
    promise_text: "",
    quote_text: "",
    why_text: "",
    blocked_text: "",
    items_json: "[]",
    suggested_addons_json: "[]",
    pre_approved: false,
    pre_approval_reason: "",
    greeting: "",
    error: "",
  };
}

/** Shows the greeting (and the quote card after a proposal) unless show_card = "no". */
function respond(outputVars, inputVars, quoteCardText) {
  const shouldShow = String(inputVars.show_card || "yes").toLowerCase() !== "no";
  const trace = [];
  if (shouldShow && outputVars.greeting) trace.push({ type: "text", payload: { message: outputVars.greeting } });
  if (shouldShow && quoteCardText) trace.push({ type: "text", payload: { message: quoteCardText } });
  return { outputVars, trace };
}

/** "hi"/"hindi"/"हिंदी"/"hinglish" → hi; "kn"/"kannada"/"ಕನ್ನಡ" → kn; anything else → en. */
function detectLanguage(languageInput) {
  const value = String(languageInput || "").trim();
  if (/^(hi|hindi|हिंदी|hinglish)/i.test(value)) return "hi";
  if (/^(kn|kannada|ಕನ್ನಡ)/i.test(value)) return "kn";
  return "en";
}

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

/** Formats rupees with Indian digit grouping: 123456 → "₹1,23,456" (same as price_bundle). */
function formatRupees(amount) {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return "₹" + digits;
  const lastThree = digits.slice(-3);
  const leading = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return "₹" + leading + "," + lastThree;
}

// ================================================================ LOGIC: reading the number and the lookup

/**
 * Udyam entry when the owner gave a Udyam number and no GSTIN: udyam_number filled and gstin empty, or a message in
 * gstin that is about Udyam and holds nothing GSTIN-shaped. Everything else goes the GSTIN way (a GSTIN wins when
 * both are given: the GST registry also has the registration status).
 */
function chooseEntryType(inputVars) {
  const gstinText = String(inputVars.gstin || "").trim();
  const udyamText = String(inputVars.udyam_number || "").trim();
  if (udyamText && !gstinText) return ENTRY_TYPE.UDYAM;
  const hasGstinShape = gstinInput.readGstin(gstinText).candidates.length > 0;
  if (gstinText && !hasGstinShape && udyamInput.mentionsUdyam(gstinText)) return ENTRY_TYPE.UDYAM;
  return ENTRY_TYPE.GSTIN;
}

/**
 * GSTIN path: reads the GSTIN from the owner's message (zero or several GSTINs are reported, not guessed), checks it
 * and finds the registry record. Returns the record, or null after setting next_action and the greeting.
 */
function lookUpGstin(inputVars, outputVars, language) {
  const reading = gstinInput.readGstin(inputVars.gstin);
  outputVars.gstin_masked = gstinInput.maskGstin(reading.gstin);
  if (reading.problem) {
    outputVars.gstin_status = reading.problem;
    outputVars.next_action = NEXT_ACTION.FIX_GSTIN;
    outputVars.pre_approval_reason = PRE_APPROVAL_REASONS.invalid;
    outputVars.greeting = gstinInput.problemMessage(reading.problem, language, reading.candidates);
    return null;
  }
  outputVars.gstin_valid = true;
  const record = findRegistryRecord(reading.gstin);
  if (!record) {
    outputVars.gstin_status = STATUS.NOT_FOUND;
    outputVars.next_action = NEXT_ACTION.USE_ADVISOR;
    outputVars.pre_approval_reason = PRE_APPROVAL_REASONS.notFound;
    outputVars.greeting = MESSAGES[language].notFound;
    return null;
  }
  return record;
}

/**
 * Udyam path (no GSTIN): reads the Udyam number with the shared udyam_input (the same code as verify_udyam) and finds
 * it in the Udyam registry. Returns a record shaped like a GST record, or null after setting next_action and the
 * greeting: fix_udyam for no or several numbers, use_advisor for a number that isn't registered.
 */
function lookUpUdyam(inputVars, outputVars, language) {
  const reading = udyamInput.readUdyam(String(inputVars.udyam_number || "").trim() || inputVars.gstin);
  outputVars.udyam_masked = udyamInput.maskUdyam(reading.udyamNumber);
  if (reading.problem) {
    outputVars.udyam_status = reading.problem;
    outputVars.next_action = NEXT_ACTION.FIX_UDYAM;
    outputVars.pre_approval_reason = PRE_APPROVAL_REASONS.udyamInvalid;
    outputVars.greeting = udyamInput.problemMessage(reading.problem, language, reading.candidates);
    return null;
  }
  outputVars.udyam_valid = true;
  const record = findUdyamRecord(reading.udyamNumber);
  if (!record) {
    outputVars.udyam_status = UDYAM_STATUS.NOT_FOUND;
    outputVars.next_action = NEXT_ACTION.USE_ADVISOR;
    outputVars.pre_approval_reason = PRE_APPROVAL_REASONS.udyamNotFound;
    outputVars.greeting = MESSAGES[language].udyamNotFound;
    return null;
  }
  outputVars.udyam_status = UDYAM_STATUS.FOUND;
  return record;
}

// ================================================================ LOGIC: registry facts and pre-approval

/** "Today" in India, or the as_of_date input (YYYY-MM-DD) for reproducible tests. Returned as a UTC midnight. */
function parseAsOfDate(asOfInput) {
  const match = String(asOfInput || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const nowInIst = new Date(Date.now() + IST_OFFSET_MINUTES * MILLISECONDS_PER_MINUTE);
  return new Date(Date.UTC(nowInIst.getUTCFullYear(), nowInIst.getUTCMonth(), nowInIst.getUTCDate()));
}

/** Whole calendar months from one date to another: 15 Apr → 15 Jul = 3, 15 Apr → 14 Jul = 2. */
function calendarMonthsBetween(fromDate, toDate) {
  const monthDifference =
    (toDate.getUTCFullYear() - fromDate.getUTCFullYear()) * 12 + (toDate.getUTCMonth() - fromDate.getUTCMonth());
  return toDate.getUTCDate() < fromDate.getUTCDate() ? monthDifference - 1 : monthDifference;
}

function registrationAgeInDays(record, asOfDate) {
  return Math.floor((asOfDate.getTime() - record.registrationDate.getTime()) / MILLISECONDS_PER_DAY);
}

function copyRegistryFacts(outputVars, record, asOfDate) {
  const ageInDays = registrationAgeInDays(record, asOfDate);
  // A Udyam record has no GST status: gstin_status stays empty on the Udyam path (udyam_status says FOUND).
  if (record.entryType === ENTRY_TYPE.GSTIN) outputVars.gstin_status = record.status;
  outputVars.business_name = record.tradeName;
  outputVars.gst_city = record.city;
  outputVars.gst_state = record.state;
  outputVars.city_tier = CITY_TIER_BY_NAME[record.city.toLowerCase()] || 0;
  outputVars.constitution = record.constitution;
  outputVars.registration_date = record.registrationDate.toISOString().slice(0, 10);
  outputVars.registration_age_years = Math.round((ageInDays / DAYS_PER_YEAR) * 10) / 10;
}

/**
 * Pre-approved = Active and registered at least PRE_APPROVAL_MIN_REGISTRATION_MONTHS ago. A Udyam record has no status
 * field, so on the Udyam path only the registration age counts (and the reason says so).
 */
function decidePreApproval(record, asOfDate) {
  const isUdyam = record.entryType === ENTRY_TYPE.UDYAM;
  if (record.status !== STATUS.ACTIVE) {
    return { isPreApproved: false, reason: fillTemplate(PRE_APPROVAL_REASONS.blocked, { status: record.status }) };
  }
  const ageInDays = registrationAgeInDays(record, asOfDate);
  const ageInMonths = calendarMonthsBetween(record.registrationDate, asOfDate);
  if (ageInMonths < PRE_APPROVAL_MIN_REGISTRATION_MONTHS) {
    return {
      isPreApproved: false,
      reason: fillTemplate(isUdyam ? PRE_APPROVAL_REASONS.udyamTooNew : PRE_APPROVAL_REASONS.tooNew, {
        months: Math.max(0, ageInMonths),
      }),
    };
  }
  const ageInYears = Math.round((ageInDays / DAYS_PER_YEAR) * 10) / 10;
  return {
    isPreApproved: true,
    reason: fillTemplate(isUdyam ? PRE_APPROVAL_REASONS.udyamApproved : PRE_APPROVAL_REASONS.approved, {
      years: ageInYears,
    }),
  };
}

// ================================================================ LOGIC: inferring the business

/** Lower-case words of a name with "&" kept, padded with spaces so phrases match whole words only. */
function toPaddedWords(name) {
  return (
    " " +
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9& ]/g, " ")
      .replace(/\s+/g, " ")
      .trim() +
    " "
  );
}

/**
 * First NAME_RULES entry whose word appears in the name, as { profileId, confidence, word }; or null. Rule words are
 * normalised like the name, so "pre-school" matches "Pre-School" and "Pre School" (the hyphen becomes a space in both).
 */
function matchNameRule(name) {
  const paddedName = toPaddedWords(name);
  for (const rule of NAME_RULES) {
    const word = rule.words.find((candidate) => paddedName.indexOf(toPaddedWords(candidate)) >= 0);
    if (word) return { profileId: rule.profileId, confidence: rule.confidence, word };
  }
  return null;
}

/** Maps the owner's reply (a button label in any language, or free text) to a profile; null if unclear. */
function profileFromBusinessTypeAnswer(answer) {
  const trimmedAnswer = String(answer || "").trim();
  if (!trimmedAnswer) return null;
  for (const language of Object.keys(MESSAGES)) {
    const index = MESSAGES[language].questionOptions.business_type.indexOf(trimmedAnswer);
    if (index >= 0) return PROFILE_BY_BUSINESS_TYPE_OPTION_INDEX[index];
  }
  const rule = matchNameRule(trimmedAnswer);
  return rule ? rule.profileId : null;
}

/** "3–5" → 4, "7" → 7, "" → null. Range buttons use SITE_COUNT_BY_ANSWER; free text takes the first number. */
function siteCountFromAnswer(answer) {
  const trimmedAnswer = String(answer || "")
    .trim()
    .replace("-", "–");
  if (!trimmedAnswer) return null;
  if (SITE_COUNT_BY_ANSWER[trimmedAnswer] !== undefined) return SITE_COUNT_BY_ANSWER[trimmedAnswer];
  const firstNumber = trimmedAnswer.match(/\d+/);
  return firstNumber ? Math.max(1, parseInt(firstNumber[0], 10)) : null;
}

/**
 * Decides category, scale (segment) and confidence from, in priority order: the owner's answers, the Udyam
 * business type (linked record) and the GST trade name, plus the constitution for single shop vs chain.
 * Returns { profileId, category, segment, siteCount, categoryConfidence, scaleConfidence, evidence, ... }.
 */
function inferBusiness(record, inputVars) {
  const evidence = [];
  const answeredProfileId = profileFromBusinessTypeAnswer(inputVars.answer_business_type);
  const answeredSiteCount = siteCountFromAnswer(inputVars.answer_sites);
  const nameRule = matchNameRule(record.tradeName);
  const nicProfileId = record.nicDescription ? PROFILE_BY_NIC_DESCRIPTION[record.nicDescription] : null;

  let profileId = null;
  let categoryConfidence = 0;
  let nicSegment = null;
  if (answeredProfileId) {
    profileId = answeredProfileId;
    categoryConfidence = OWNER_ANSWER_CONFIDENCE;
    evidence.push("owner answer (business type)");
  } else if (nicProfileId && record.entryType === ENTRY_TYPE.UDYAM) {
    // The owner's own Udyam number: the registered business type is direct evidence, not a name + state link.
    profileId = nicProfileId;
    nicSegment = NIC_SEGMENT_BY_DESCRIPTION[record.nicDescription] || null;
    categoryConfidence = UDYAM_DIRECT_CONFIDENCE;
    evidence.push('udyam.nic_description ("' + record.nicDescription + '", looked up by Udyam number)');
  } else if (nicProfileId) {
    profileId = nicProfileId;
    nicSegment = NIC_SEGMENT_BY_DESCRIPTION[record.nicDescription] || null;
    evidence.push('udyam.nic_description ("' + record.nicDescription + '", linked by name + state)');
    if (nameRule && PROFILES[nameRule.profileId].category === PROFILES[nicProfileId].category) {
      categoryConfidence = Math.min(
        MAX_COMBINED_CONFIDENCE,
        1 - (1 - UDYAM_LINK_CONFIDENCE) * (1 - nameRule.confidence),
      );
      evidence.push('gst.trade_name ("' + nameRule.word + '")');
    } else if (nameRule) {
      categoryConfidence = UDYAM_LINK_CONFIDENCE * DISAGREEMENT_PENALTY;
      evidence.push('gst.trade_name ("' + nameRule.word + '", disagrees)');
    } else {
      categoryConfidence = UDYAM_LINK_CONFIDENCE;
    }
  } else if (nameRule) {
    profileId = nameRule.profileId;
    categoryConfidence = nameRule.confidence;
    evidence.push('gst.trade_name ("' + nameRule.word + '")');
  }

  // "Other" (or nothing recognisable) can't be priced from the registry: the playbook switches to the advisor.
  if (profileId === PROFILE_ID.OTHER_UNKNOWN) {
    return {
      profileId,
      category: CATEGORY.OTHER,
      segment: "",
      siteCount: null,
      categoryConfidence,
      scaleConfidence: 0,
      evidence,
    };
  }
  if (!profileId) {
    return {
      profileId: null,
      category: CATEGORY.UNKNOWN,
      segment: "",
      siteCount: null,
      categoryConfidence: 0,
      scaleConfidence: 0,
      evidence,
    };
  }
  const profile = PROFILES[profileId];
  const scale = decideScale(profile, record, nicSegment, answeredProfileId, answeredSiteCount, evidence);
  return {
    profileId,
    category: profile.category,
    pricingBusinessType:
      answeredProfileId || !record.nicDescription ? profile.pricingBusinessType : record.nicDescription,
    segment: scale.segment,
    siteCount: scale.siteCount,
    categoryConfidence,
    scaleConfidence: scale.confidence,
    evidence,
  };
}

/**
 * Single site or chain? Fixed-segment profiles (clinic, CA, coaching, factory, offices) need no decision. For shops,
 * restaurants and similar: the owner's site count wins, then the Udyam business type (which says "chain"), then
 * the constitution (proprietorship → probably one shop; company/LLP → chain).
 */
function decideScale(profile, record, nicSegment, answeredProfileId, answeredSiteCount, evidence) {
  if (answeredSiteCount !== null) evidence.push("owner answer (locations)");
  if (profile.fixedSegment) {
    return {
      segment: profile.fixedSegment,
      siteCount: answeredSiteCount || DEFAULT_SITE_COUNT,
      confidence: FIXED_SCALE_CONFIDENCE,
    };
  }
  if (answeredSiteCount !== null) {
    const segment = answeredSiteCount >= SITES_FOR_MULTI_SITE ? SEGMENT.MULTI_SITE : profile.singleSiteSegment;
    return { segment, siteCount: answeredSiteCount, confidence: OWNER_ANSWER_CONFIDENCE };
  }
  if (nicSegment && !answeredProfileId) {
    return {
      segment: nicSegment,
      siteCount: nicSegment === SEGMENT.MULTI_SITE ? null : DEFAULT_SITE_COUNT,
      confidence: UDYAM_SCALE_CONFIDENCE,
    };
  }
  evidence.push("gst.constitution (" + record.constitution + ")");
  if (record.constitution === CONSTITUTION.PROPRIETORSHIP) {
    return {
      segment: profile.singleSiteSegment,
      siteCount: DEFAULT_SITE_COUNT,
      confidence: profile.proprietorSingleSiteConfidence,
    };
  }
  return { segment: SEGMENT.MULTI_SITE, siteCount: null, confidence: COMPANY_CHAIN_CONFIDENCE };
}

/** "business_type" when the category is unclear, "locations" when the number of sites matters; "" to propose. */
function chooseQuestion(inference) {
  if (inference.categoryConfidence < PROPOSAL_CONFIDENCE_THRESHOLD) return "business_type";
  if (inference.segment === SEGMENT.MULTI_SITE && inference.siteCount === null) return "locations";
  if (inference.categoryConfidence * inference.scaleConfidence < PROPOSAL_CONFIDENCE_THRESHOLD) return "locations";
  return "";
}

function copyInference(outputVars, inference) {
  outputVars.business_category = inference.category;
  outputVars.category_label = CATEGORY_LABEL[inference.category];
  outputVars.segment_code = inference.segment;
  outputVars.segment_confidence = Math.round(inference.categoryConfidence * inference.scaleConfidence * 100) / 100;
  outputVars.evidence_fields = inference.evidence.join(", ");
}

// ================================================================ LOGIC: pricing and greeting

/** The smallest sensible team for a segment (see SMALLEST_TEAM_BY_SEGMENT), and at least one person per site. */
function smallestTeam(segment, siteCount) {
  return Math.max(SMALLEST_TEAM_BY_SEGMENT[segment] || FALLBACK_SMALLEST_TEAM, siteCount * MIN_PEOPLE_PER_SITE);
}

/**
 * Inputs for price_bundle: the base bundle for the smallest sensible business. No extras (needs stays empty). A
 * business that came in with its Udyam number has no GSTIN, so price_bundle leaves GST-only products out.
 */
function buildPricingInputs(record, inference, language) {
  const siteCount = inference.siteCount || DEFAULT_SITE_COUNT;
  return {
    business_type: inference.pricingBusinessType,
    segment: inference.segment,
    city: record.city,
    employees: String(smallestTeam(inference.segment, siteCount)),
    sites: String(siteCount),
    has_gstin: record.entryType === ENTRY_TYPE.UDYAM ? "no" : "yes",
    needs: "",
    lang: language === "hi" ? "hi" : "en",
    show_card: "no",
  };
}

/** price_bundle's outputs for the pricing inputs with some fields changed. The only source of prices here. */
async function priceWith(pricingInputs, changes) {
  return (await priceBundleMain({ inputVars: Object.assign({}, pricingInputs, changes) })).outputVars;
}

/** The largest team the same quote still covers: one more person at a time until the quote changes. */
async function largestTeamForSameQuote(pricingInputs, baseQuote) {
  const smallest = Number(pricingInputs.employees);
  let largest = smallest;
  for (let teamSize = smallest + 1; teamSize <= smallest + TEAM_SIZE_SEARCH_LIMIT; teamSize++) {
    const quote = await priceWith(pricingInputs, { employees: String(teamSize) });
    if (quote.items_json !== baseQuote.items_json || quote.monthly_total !== baseQuote.monthly_total) break;
    largest = teamSize;
  }
  return largest;
}

/** Items in the quote with an add-on that the base quote doesn't have (or has fewer of). */
function itemsAdded(baseItems, itemsWithAddon) {
  const added = [];
  itemsWithAddon.forEach((item) => {
    const inBase = baseItems.find((baseItem) => baseItem.id === item.id);
    const extraQuantity = item.qty - (inBase ? inBase.qty : 0);
    if (extraQuantity > 0) added.push({ id: item.id, name: item.name, qty: extraQuantity });
  });
  return added;
}

/**
 * The segment's extras as suggested add-ons, switched OFF. Each price is price_bundle's total with that one need minus
 * the base total. Returns [{ need, items, monthly_price, setup_price, reason, included: false }].
 */
async function suggestAddons(pricingInputs, baseQuote, language) {
  const text = MESSAGES[language];
  const baseItems = JSON.parse(baseQuote.items_json);
  const addons = [];
  for (const need of SUGGESTED_ADDON_NEEDS_BY_SEGMENT[pricingInputs.segment] || []) {
    const quote = await priceWith(pricingInputs, { needs: need });
    const extraMonthly = quote.monthly_total - baseQuote.monthly_total;
    // Already in the base bundle, or not allowed for this business: nothing to suggest.
    if (quote.error || extraMonthly <= 0) continue;
    addons.push({
      need,
      items: itemsAdded(baseItems, JSON.parse(quote.items_json)),
      monthly_price: extraMonthly,
      setup_price: quote.setup_total - baseQuote.setup_total,
      reason: text.addonReasons[need],
      included: false,
    });
  }
  return addons;
}

/** "insurance agency" → "an"; "clinic" → "a" (English only). */
function englishArticle(word) {
  return ENGLISH_VOWELS.indexOf(String(word).charAt(0).toLowerCase()) >= 0 ? "an" : "a";
}

/** The business type in the owner's language; for "other" businesses, the type used for pricing ("salon", "office"). */
function businessLabel(inference, language) {
  const text = MESSAGES[language];
  if (inference.category !== CATEGORY.OTHER || !inference.pricingBusinessType) {
    return text.categoryWord[inference.category];
  }
  return language === "en" ? inference.pricingBusinessType.toLowerCase() : inference.pricingBusinessType;
}

/**
 * Every assumption behind the first quote, in plain words in the owner's language: business type, team size (as the
 * range the same quote covers), locations, and the connection the quote needs. Returns [{ key, value, text }].
 */
function describeAssumptions(record, inference, pricingInputs, largestTeam, quote, language) {
  const parts = MESSAGES[language].assumptionParts;
  const business = businessLabel(inference, language);
  const smallest = Number(pricingInputs.employees);
  const team = largestTeam > smallest ? smallest + "–" + largestTeam : String(smallest);
  const siteCount = Number(pricingInputs.sites);
  const assumptions = [
    {
      key: ASSUMPTION.BUSINESS_TYPE,
      value: inference.category,
      text: fillTemplate(parts.business_type, { article: englishArticle(business), business }).trim(),
    },
    { key: ASSUMPTION.TEAM_SIZE, value: team, text: fillTemplate(parts.team_size, { team }) },
    {
      key: ASSUMPTION.LOCATIONS,
      value: String(siteCount),
      text: fillTemplate(siteCount === 1 ? parts.locations.one : parts.locations.many, { sites: siteCount }),
    },
  ];
  const connectionItem = JSON.parse(quote.items_json).find((item) => CONNECTION_ASSUMPTION_BY_PRODUCT[item.id]);
  if (connectionItem) {
    const connection = CONNECTION_ASSUMPTION_BY_PRODUCT[connectionItem.id];
    assumptions.push({ key: ASSUMPTION.CONNECTION, value: connection, text: parts.connection[connection] });
  }
  return assumptions;
}

/** "a, b, c and d" in the owner's language. */
function joinList(pieces, language) {
  const text = MESSAGES[language];
  if (pieces.length <= 1) return pieces.join("");
  return pieces.slice(0, -1).join(text.listSeparator) + text.lastSeparator + pieces[pieces.length - 1];
}

function writeAssumptionSentence(assumptions, language) {
  return fillTemplate(MESSAGES[language].assumptionSentence, {
    list: joinList(
      assumptions.map((assumption) => assumption.text),
      language,
    ),
  });
}

/** "Optional, not in the price above: Cloud POS & Billing +₹599/month (₹2,500 one-time), to …". "" when none. */
function writeAddonsSentence(addons, language) {
  if (!addons.length) return "";
  const text = MESSAGES[language];
  const described = addons.map((addon) =>
    fillTemplate(text.addonItem, {
      name: addon.items.map((item) => item.name + (item.qty > 1 ? " ×" + item.qty : "")).join(" + "),
      price: formatRupees(addon.monthly_price),
      setup: addon.setup_price > 0 ? fillTemplate(text.addonSetup, { setup: formatRupees(addon.setup_price) }) : "",
      reason: addon.reason,
    }),
  );
  return fillTemplate(text.addonsSentence, { list: described.join(text.addonSeparator) });
}

function copyQuote(outputVars, quoteOutputs, pricingInputs) {
  outputVars.pricing_inputs_json = JSON.stringify(pricingInputs);
  outputVars.bundle_name = quoteOutputs.bundle_name;
  outputVars.monthly_total = quoteOutputs.monthly_total;
  outputVars.setup_total = quoteOutputs.setup_total;
  outputVars.contract_months = quoteOutputs.contract_months;
  outputVars.install_days = quoteOutputs.install_days;
  outputVars.promise_type = quoteOutputs.promise_type;
  outputVars.promise_hours = quoteOutputs.promise_hours;
  outputVars.promise_days = quoteOutputs.promise_days;
  outputVars.promise_text = quoteOutputs.promise_text;
  outputVars.quote_text = quoteOutputs.quote_text;
  outputVars.why_text = quoteOutputs.why_text;
  outputVars.blocked_text = quoteOutputs.blocked_text;
  outputVars.items_json = quoteOutputs.items_json;
}

/** "Namaste! I found …" naming the registry the business was found in (GST or Udyam). */
function writeFoundBusiness(record, outputVars, language) {
  const text = MESSAGES[language];
  const template = record.entryType === ENTRY_TYPE.UDYAM ? text.foundBusinessUdyam : text.foundBusiness;
  return fillTemplate(template, foundBusinessValues(record, outputVars));
}

function foundBusinessValues(record, outputVars) {
  return { name: record.tradeName, city: record.city, year: outputVars.registration_date.slice(0, 4) };
}

/**
 * The activation guarantee in the owner's language, from the quote's promise_type and promise_days (price_bundle
 * decides it). Never a promise of its own: the greeting can't say 72 hours when the quote card says 10 days.
 */
function describePromise(outputVars, language) {
  const text = MESSAGES[language];
  return outputVars.promise_type === PROMISE_TYPE_GUARANTEED_72H
    ? text.promiseGuaranteed72h
    : fillTemplate(text.promiseFirmDate, { days: outputVars.promise_days });
}

/**
 * Greeting with the proposal: who we found (GST or Udyam registry), the base bundle, its price and the activation
 * guarantee, pre-approval, every assumption, and the suggested add-ons (named with their prices, never included).
 */
function writeProposalGreeting(record, outputVars, inference, preApproval, addons, language) {
  const text = MESSAGES[language];
  const isUdyam = record.entryType === ENTRY_TYPE.UDYAM;
  const preApprovalLine = isUdyam
    ? preApproval.isPreApproved
      ? text.preApprovedUdyam
      : text.notPreApprovedUdyam
    : preApproval.isPreApproved
      ? text.preApproved
      : text.notPreApproved;
  return [
    writeFoundBusiness(record, outputVars, language),
    fillTemplate(text.proposal, {
      name: record.tradeName,
      category: text.categoryWord[inference.category],
      bundle: outputVars.bundle_name,
      price: formatRupees(outputVars.monthly_total),
      promise: describePromise(outputVars, language),
    }),
    preApprovalLine,
    outputVars.assumptions,
    writeAddonsSentence(addons, language),
  ]
    .filter(Boolean)
    .join("\n");
}

// ================================================================ DATA (injected by _build/gen_kit.py)

const CONSTITUTION = {
  PROPRIETORSHIP: "Proprietorship",
  COMPANY: "Private Limited Company",
  LLP: "Limited Liability Partnership",
};
const CONSTITUTION_BY_CODE = { P: CONSTITUTION.PROPRIETORSHIP, C: CONSTITUTION.COMPANY, L: CONSTITUTION.LLP };
const STATUS_BY_CODE = { A: STATUS.ACTIVE, C: STATUS.CANCELLED, S: STATUS.SUSPENDED };
/** GST state names; records store the index in base 36. */
const STATE_NAMES = ["Andhra Pradesh", "Bihar", "Delhi", "Gujarat", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Punjab", "Rajasthan", "Tamil Nadu", "Telangana", "Uttar Pradesh", "West Bengal"];
/** City names parsed from principal_place_of_business; records store the index in base 36. */
const CITY_NAMES = ["Ahmedabad", "Bengaluru", "Bhopal", "Chennai", "Coimbatore", "Delhi", "Hyderabad", "Indore", "Jaipur", "Kochi", "Kolkata", "Lucknow", "Ludhiana", "Mumbai", "Mysuru", "Nagpur", "Nashik", "Patna", "Pune", "Surat", "Vadodara", "Visakhapatnam"];
/** Udyam business types (nic_description) with their case segment; records store the index in base 36. */
const NIC_DESCRIPTIONS = [["Apparel retail chain","multi"],["Architecture studio","prof"],["Auto-parts unit","mfg"],["Bakery","micro"],["Bakery chain","multi"],["Boutique","micro"],["Budget hotel group","multi"],["CA firm","prof"],["Coaching centre","prof"],["Dental clinic","prof"],["Diagnostic lab","prof"],["Electronics retail chain","multi"],["Food processing unit","mfg"],["Furniture workshop","mfg"],["Gym chain","multi"],["Hardware store","micro"],["Insurance agency","prof"],["Kirana store","micro"],["Law office","prof"],["Mobile repair shop","micro"],["Optician","micro"],["Packaging unit","mfg"],["Pharmacy","micro"],["Pharmacy chain","multi"],["Physiotherapy clinic","prof"],["Plastic moulding unit","mfg"],["Pre-school chain","multi"],["Printing press","mfg"],["Real estate agency","prof"],["Restaurant chain","multi"],["Salon","micro"],["Stationery shop","micro"],["Sweet shop","micro"],["Textile unit","mfg"],["Travel agency","prof"]];
const NIC_SEGMENT_BY_DESCRIPTION = {};
NIC_DESCRIPTIONS.forEach(([description, segment]) => {
  NIC_SEGMENT_BY_DESCRIPTION[description] = segment;
});
/** City (lower case) → tier 1 or 2, from smb_leads.csv. */
const CITY_TIER_BY_NAME = {"kochi":2,"ludhiana":2,"chennai":1,"nagpur":2,"jaipur":2,"visakhapatnam":2,"lucknow":2,"bhopal":2,"kolkata":1,"pune":1,"surat":2,"hyderabad":1,"bengaluru":1,"mumbai":1,"mysuru":2,"ahmedabad":1,"coimbatore":2,"indore":2,"nashik":2,"delhi":1,"vadodara":2,"patna":2};
/** Smallest employee_count per segment in smb_leads.csv (the first-quote sizing rule; see MIN_PEOPLE_PER_SITE). */
const SMALLEST_TEAM_BY_SEGMENT = {"mfg":12,"micro":1,"multi":15,"prof":3};
/**
 * SIMULATED: mock GST registry joined with the Udyam registry (synthetic case data).
 * One record per line: GSTIN|trade name|status A/C/S|constitution P/C/L|state index|city index|registration date
 * (YYYYMMDD)|Udyam business-type index (blank = no unique Udyam match)
 */
const REGISTRY_TEXT = "32TTNXB7384T1ZW|Balaji Dental Care LLP|A|L|5|9|20200604|9\n03PJNXS4821G1ZB|Saffron Bakers|A|P|8|c|20190415|\n33MFTXS9954Q1Z9|Star Electronics|A|P|a|3|20251005|b\n27QTBXZ1995X1Z9|Zenith Diagnostics|A|P|7|f|20241229|a\n32AITXR9985H1ZT|Royal Fashions|A|P|5|9|20230805|0\n08JVKXA4705I1Z0|Amrit Fashions|A|P|9|8|20231126|0\n03ZCKXG5592Y1ZG|Green Leaf Physio Clinic|A|P|8|c|20240307|o\n03JEUXR9399M1ZI|Royal Auto Components|A|P|8|c|20240919|\n37ZHYXR1505E1ZY|Riddhi Fashions Pvt Ltd|A|C|0|l|20170326|0\n09YHJXG6633U1ZC|Ganga Stationers|A|P|c|b|20250727|\n23QYBXS1811Q1ZD|Sahyadri Realty|S|P|6|2|20190817|\n27DGKXS9651J1Z2|Shree Legal Associates Pvt Ltd|A|C|7|i|20210619|i\n24DTTXB1771D1ZD|Balaji Unisex Salon|A|P|3|j|20250718|\n36KNNXK2611U1ZM|Kaveri Hardware|A|P|b|6|20240421|\n29CPSXS6426Z1ZL|Sai Classes|A|P|4|1|20170212|\n29LMJXM4925L1ZP|Metro Sweets|A|P|4|e|20190525|w\n19SNXXC4363G1ZO|Coral Bake House Pvt Ltd|A|C|d|a|20230325|4\n19JENXB8672I1ZA|Blue Lotus Kitchens Pvt Ltd|A|C|d|a|20220906|t\n24WYCXA0557Q1ZD|Amrit Bakers|A|P|3|0|20180210|3\n03XJTXS5280Q1Z5|Sahyadri Classes LLP|A|L|8|c|20240131|\n29QBQXC4576O1ZX|Classic Unisex Salon|A|P|4|1|20191113|u\n27UOIXN0412X1ZA|Navkar Pharma Retail|A|P|7|d|20191028|n\n33PBWXO2282E1ZL|Om & Associates Pvt Ltd|A|C|a|4|20190228|\n23LFMXA6364W1ZY|Amrit Design Studio Pvt Ltd|A|C|6|7|20160820|1\n27VOFXG2227P1ZQ|Green Leaf Stationers|A|P|7|d|20211023|v\n27SREXP1740M1ZL|Pearl Medicals|A|P|7|f|20220906|m\n03MYQXS9075K1ZS|Saffron Tours & Travels|A|P|8|c|20221122|y\n24CICXV8429A1ZU|Vindhya Hardware|A|P|3|0|20230320|\n09LUFXE7890K1ZB|Evergreen Kids Academy LLP|A|L|c|b|20250817|q\n29GYVXO5300N1Z1|Orbit Diagnostics Pvt Ltd|A|C|4|1|20210712|a\n29CLBXV8310R1ZS|Vindhya Medicals|A|P|4|e|20210210|\n24RNIXO0321M1Z6|Om Pharma Retail LLP|A|L|3|j|20161002|n\n29MEZXG7940I1ZW|Galaxy Bakers|A|P|4|1|20210218|\n37IHKXV5167L1ZS|Vindhya Tours & Travels|C|P|0|l|20250607|\n29SEBXK0105Z1Z1|Krishna Pharma Retail|A|P|4|e|20200324|n\n03AEVXV7072Z1ZE|Vindhya Medicals|A|P|8|c|20221013|\n23LUKXM0207R1ZP|Moonlight Medicals|A|P|6|7|20210908|\n33QOHXB1019L1ZH|Blue Lotus Medicals|A|P|a|3|20240130|m\n23NXPXN8383Q1ZK|New Textiles Pvt Ltd|A|C|6|7|20161222|x\n24AYQXU7285O1ZQ|Unity Insurance Advisors|A|P|3|0|20220915|g\n23AOUXS7882R1Z1|Star Bakers|A|P|6|2|20180506|\n23NCVXM2162E1ZU|Metro Polymers|A|P|6|2|20190209|p\n27UCDXP4181S1ZU|Pearl & Associates Pvt Ltd|A|C|7|g|20210122|7\n08HGJXP5435R1ZW|Prime Polymers|A|P|9|8|20210807|p\n24MRJXE8457W1ZZ|Evergreen Textiles Pvt Ltd|A|C|3|k|20180218|x\n27NGEXH1594Z1ZJ|Harmony Electronics|A|P|7|g|20220615|b\n10FTFXH5630I1ZJ|Harmony Tours & Travels Pvt Ltd|A|C|1|h|20241220|\n32CEOXN8894D1ZJ|Neelgiri Packaging LLP|A|L|5|9|20181116|l\n07PUTXM1153M1Z9|Metro Diagnostics Pvt Ltd|A|C|2|5|20180630|a\n23UTQXA4314W1Z6|Apex Design Studio Pvt Ltd|A|C|6|7|20220626|1\n27HQWXN0015K1ZW|Neelgiri Sweets|A|P|7|d|20181206|w\n27BBCXS8971M1ZB|Silver Oak Hardware|A|P|7|g|20170428|\n36RPXXM3190M1Z3|Modern Stationers|A|P|b|6|20200308|\n29SWLXB8773Z1Z1|Blue Lotus Physio Clinic Pvt Ltd|A|C|4|1|20170707|\n08ZIGXG8807M1ZP|Ganga Design Studio LLP|A|L|9|8|20250603|1\n37SMHXL6685B1ZW|Lakshmi Stays|A|P|0|l|20161124|\n03SEDXS6431X1ZS|Silver Oak Boutique|A|P|8|c|20180422|\n33ILLXK1904U1ZY|Krishna Mobile Care|A|P|a|4|20240511|\n24DZRXG0254P1ZH|Galaxy Classes LLP|A|L|3|0|20210719|\n27WAYXK3010I1ZI|Krishna Mobile Care|A|P|7|g|20200520|\n29CUEXS7606Z1ZP|Shree General Store|A|P|4|e|20210210|h\n36OOUXA2729H1ZZ|Amrit Realty LLP|A|L|b|6|20240819|s\n29HIHXN8231E1ZI|Neelgiri Physio Clinic LLP|A|L|4|1|20160816|o\n33UNYXV4732Q1ZU|Vindhya Medicals|A|P|a|3|20200113|\n27RGTXP6860Z1ZP|Pearl Stays|A|P|7|d|20200324|6\n29OKAXP4077P1ZL|Prime General Store|C|P|4|1|20200227|h\n29KAFXC8220C1ZG|City Tours & Travels|C|P|4|e|20230804|y\n07VPTXZ0659U1ZB|Zenith Bakers|A|P|2|5|20220818|\n24NCEXS3921N1ZJ|Saffron Sweets|A|P|3|k|20220928|w\n10TAEXE8005X1ZJ|Evergreen Diagnostics|A|P|1|h|20221112|a\n23GIKXG4361Y1ZV|Green Leaf Hardware|A|P|6|7|20230906|f\n27SJYXA0184Q1ZK|Annapurna Legal Associates|A|P|7|i|20180207|i\n32YTFXM8956A1ZN|Modern Mobile Care|A|P|5|9|20221210|\n27TFYXA1689M1ZO|Amrit General Store|A|P|7|d|20220110|\n07JHCXG5421H1Z1|Ganesh Hardware|A|P|2|5|20180809|\n27VBLXG7653G1ZE|Green Leaf General Store|A|P|7|d|20171224|h\n37MQBXG9993U1ZT|Green Leaf Foods Pvt Ltd|A|C|0|l|20200223|c\n27AKCXU3103P1ZF|Unity Boutique|A|P|7|d|20211202|\n27ZGXXB2827W1Z6|Balaji Hardware|A|P|7|i|20211129|f\n24THBXG1758C1ZY|Galaxy Realty LLP|A|L|3|j|20180505|s\n29ODKXM3847C1ZK|Moonlight Physio Clinic Pvt Ltd|A|C|4|e|20231010|o\n27YMLXM5762Q1ZZ|Metro & Associates|A|P|7|g|20220809|7\n23ZVEXH1766D1ZV|Harmony Fashions|A|P|6|7|20230220|\n32WAHXG8645K1ZH|Galaxy Medicals|S|P|5|9|20210914|\n08YKZXS5189L1ZO|Saffron Unisex Salon|A|P|9|8|20190925|u\n36OMJXM5116Z1Z6|Moonlight Stationers|A|P|b|6|20241020|v\n24RZGXM9709E1ZD|Moonlight Kitchens Pvt Ltd|A|C|3|k|20241002|\n19FLHXP4453B1ZJ|Prime Medicals|A|P|d|a|20230803|m\n27KYVXC5489I1ZX|Classic Packaging|S|P|7|d|20240630|l\n27IASXS2798M1ZT|Star General Store|A|P|7|i|20200305|\n24KPEXS3236Q1ZP|Saffron Boutique|A|P|3|k|20240325|5\n07JBBXO2791K1ZO|Om Insurance Advisors LLP|A|L|2|5|20250220|g\n24URAXA4296J1ZX|Annapurna Stays|A|P|3|j|20170612|\n29QAPXB7258G1ZH|Balaji Mobile Care|A|P|4|1|20220402|j\n24LKWXB1846L1Z3|Balaji Diagnostics|A|P|3|j|20210404|\n29YAEXE0018X1Z6|Evergreen Opticals|S|P|4|1|20230714|k\n32COEXU4782T1ZH|Unity Realty|A|P|5|9|20240413|s\n27DIDXN3795G1ZF|Navkar Kitchens|A|P|7|d|20171029|t\n29NONXP8492Y1Z8|Pearl Stationers|A|P|4|e|20240312|v\n24XTKXM1891R1ZT|Moonlight Medicals|A|P|3|k|20210814|\n23DSOXK2977E1Z1|Krishna Stationers|A|P|6|2|20240429|v\n24HFNXN0473L1ZI|New Hardware|A|P|3|k|20240209|f\n08EAHXC5550F1ZF|Coral Medicals|A|P|9|8|20240517|\n07JHXXN9131N1ZP|Neelgiri Pharma Retail Pvt Ltd|A|C|2|5|20190326|n\n27QQIXU3971M1Z3|Unity Tours & Travels Pvt Ltd|C|C|7|d|20250612|y\n27NXVXE4061Y1ZG|Evergreen Realty LLP|A|L|7|f|20210815|\n10WYQXO5250T1ZO|Orbit Unisex Salon|A|P|1|h|20190514|\n32DUWXB6433R1ZH|Blue Lotus Pharma Retail|A|P|5|9|20160607|n\n10MTKXS0808O1ZQ|Sahyadri General Store|A|P|1|h|20180720|h\n23MMCXN9620R1ZS|New Physio Clinic Pvt Ltd|A|C|6|2|20190201|o\n27JTXXN1257Q1ZX|Neelgiri Opticals|A|P|7|f|20240401|k\n36LBWXA1919O1ZE|Annapurna Bakers|A|P|b|6|20221018|3\n37URPXP0366T1ZP|Prime Medicals|A|P|0|l|20200508|m\n33NFHXP9748E1ZC|Pearl Kitchens Pvt Ltd|A|C|a|4|20210718|\n36JJHXM2611B1Z2|Modern Mobile Care|A|P|b|6|20190408|j\n19GSWXO0162R1Z3|Om Kids Academy LLP|A|L|d|a|20201114|q\n24TBYXN1425H1ZI|New General Store|A|P|3|0|20210803|h\n27TUUXS7310M1ZT|Silver Oak Boutique|A|P|7|i|20231123|\n07GXPXR9913Z1Z5|Royal Mobile Care|A|P|2|5|20230207|j\n29NEIXB7539R1ZW|Blue Lotus Design Studio LLP|A|L|4|1|20180418|1\n03DWZXR2983F1ZD|Riddhi Hardware|A|P|8|c|20200326|f\n27IABXO3711I1Z7|Om Kids Academy|A|P|7|d|20201027|\n27WOSXC8829I1ZA|Classic Realty Pvt Ltd|A|C|7|i|20250331|\n36KHLXG2292O1Z4|Green Leaf Dental Care|A|P|b|6|20171216|9\n29FCHXS7993K1ZW|Sunrise Packaging|A|P|4|e|20240405|l\n29KTNXG3207M1ZN|Ganesh Foods Pvt Ltd|A|C|4|e|20180129|c\n29KDTXA5600D1Z2|Annapurna Opticals|A|P|4|1|20201009|k\n07EUAXS2248V1Z9|Saffron Kitchens Pvt Ltd|A|C|2|5|20181026|t\n24TPHXN1504B1ZM|Neelgiri Physio Clinic|A|P|3|0|20181215|o\n29KBGXG2454M1ZO|Galaxy Boutique|A|P|4|1|20250323|\n10FLCXE2345M1ZZ|Evergreen Insurance Advisors|A|P|1|h|20231110|g\n24KYWXS4427Y1Z6|Sahyadri Dental Care|A|P|3|j|20240819|9\n33IWBXS3261K1ZS|Silver Oak Diagnostics|A|P|a|4|20170930|a\n24CTQXG3069Z1Z0|Galaxy Stationers|A|P|3|0|20170702|\n33OPDXR8076J1ZM|Royal Dental Care LLP|A|L|a|3|20200805|\n09DDCXV5733R1Z4|Vindhya Boutique|A|P|c|b|20170617|5\n27TURXG8083C1ZD|Galaxy Pharma Retail Pvt Ltd|A|C|7|f|20190919|n\n27FYMXG7454G1ZJ|Ganesh Opticals|A|P|7|d|20170720|k\n33JUCXO2963T1Z9|Orbit Sweets|A|P|a|3|20181030|\n10EHQXC2517S1ZN|City Packaging LLP|A|L|1|h|20210112|l\n23YTQXB3554K1ZH|Blue Lotus Polymers LLP|A|L|6|7|20221213|\n09WZUXO4309C1Z2|Orbit Unisex Salon|A|P|c|b|20230224|\n23CWIXR4699P1ZZ|Royal Bakers|C|P|6|7|20171213|\n33LTDXN2304V1ZM|New Fitness Pvt Ltd|A|C|a|3|20230623|e\n33NBVXZ1566P1ZP|Zenith Design Studio|A|P|a|3|20170131|\n36ZCKXM1526X1ZL|Moonlight Realty|A|P|b|6|20241103|\n10SFBXG1202E1ZT|Galaxy Boutique|A|P|1|h|20211130|\n32APHXH4845Y1ZL|Harmony Opticals|A|P|5|9|20200617|k\n29PSZXE5591A1ZG|Evergreen Hardware|C|P|4|e|20240604|f\n32YNYXA6387Z1ZG|Apex Legal Associates Pvt Ltd|A|C|5|9|20211002|\n36LCUXH8521T1ZT|Harmony Packaging Pvt Ltd|A|C|b|6|20250417|l\n33VXWXG9635Z1ZW|Galaxy Kitchens Pvt Ltd|A|C|a|3|20180726|\n07TZEXK3217Q1Z3|Kaveri Mobile Care|A|P|2|5|20180803|j\n27SRHXG7278L1Z8|Ganga Sweets|A|P|7|d|20220722|w\n23TMIXV3459Z1ZQ|Vindhya Stationers|C|P|6|2|20211210|v\n24JZVXA8393F1ZA|Apex General Store|A|P|3|j|20251106|\n32IPGXC3102E1Z8|Classic Insurance Advisors Pvt Ltd|A|C|5|9|20220907|g\n33LJCXC8720X1ZY|Classic & Associates|A|P|a|4|20190915|7\n33ZSBXK7584Y1ZH|Krishna Physio Clinic|A|P|a|3|20250728|\n08BZZXZ4205N1ZR|Zenith Medicals|A|P|9|8|20210627|\n36KXBXC8459W1ZS|Classic Fitness|A|P|b|6|20200610|\n24TNMXO4383M1ZE|Orbit Pharma Retail|A|P|3|0|20250906|\n37STWXS3914U1ZB|Sahyadri Unisex Salon|A|P|0|l|20240114|\n33CPQXG4480H1Z9|Green Leaf Diagnostics LLP|A|L|a|4|20171229|a\n08LREXC7484B1Z7|Classic Unisex Salon|A|P|9|8|20180712|u\n33EKPXS4010P1Z7|Sai Hardware|A|P|a|4|20250812|\n03SRPXB0344N1ZY|Blue Lotus Dental Care LLP|A|L|8|c|20180512|9\n03TJCXB6895M1Z0|Balaji Realty Pvt Ltd|A|C|8|c|20190602|s\n37QFDXS0542X1ZP|Saffron Classes Pvt Ltd|A|C|0|l|20230203|\n19VVUXC7402I1Z9|Coral & Associates Pvt Ltd|A|C|d|a|20250811|7\n19GCUXS7719G1Z4|Star Classes LLP|A|L|d|a|20220426|8\n23FBBXS4037C1ZK|Saffron Unisex Salon|A|P|6|2|20250120|\n19AJRXN7406X1ZC|Navkar Legal Associates Pvt Ltd|A|C|d|a|20170108|i\n27ZKVXZ6458Q1ZC|Zenith Opticals|A|P|7|g|20180705|k\n27PVHXL0437A1Z6|Lakshmi Sweets|A|P|7|d|20210725|w\n33SMRXM9081R1Z0|Modern Design Studio Pvt Ltd|A|C|a|4|20160815|\n24RIMXS2157O1ZQ|Sunrise Pharma Retail LLP|A|L|3|j|20220504|\n36AFWXN2439F1ZM|Neelgiri & Associates Pvt Ltd|A|C|b|6|20230720|7\n19AWJXT8814Y1ZG|Trinity Opticals|A|P|d|a|20251015|k\n24QRLXK0067L1ZR|Krishna Dental Care Pvt Ltd|A|C|3|j|20230730|\n24PYNXS2996R1ZA|Shree Electronics|A|P|3|j|20180312|b\n27HQRXB4046Q1ZM|Balaji Boutique|A|P|7|d|20250831|5\n19JZBXK2349P1Z6|Kaveri Kitchens|A|P|d|a|20230320|t\n24UPGXS3171L1ZL|Sunrise Woodcraft|A|P|3|j|20250211|\n36MMPXR1829L1ZL|Riddhi Electronics|A|P|b|6|20250226|b\n03OJAXP2821F1ZY|Prime Mobile Care|A|P|8|c|20221003|\n33EHNXK1784C1ZW|Krishna Stationers|C|P|a|3|20230315|\n29TWXXA0702Q1Z2|Annapurna Opticals|A|P|4|e|20231213|k\n27NCBXZ9970V1Z8|Zenith Kitchens|A|P|7|i|20220223|t\n29XJBXO4350L1ZU|Om General Store|A|P|4|1|20230420|\n27YXMXS9879U1ZG|Sunrise Textiles|A|P|7|i|20161222|x\n27STFXR1112O1ZK|Riddhi Legal Associates|A|P|7|d|20220422|\n27SXCXL2951P1Z2|Lakshmi Polymers Pvt Ltd|A|C|7|f|20161226|\n27KYBXS2220X1Z0|Silver Oak Boutique|A|P|7|g|20191229|\n09ZLAXL3057K1ZU|Lakshmi Stationers|A|P|c|b|20220720|\n24QPWXT9719P1ZM|Trinity Unisex Salon|A|P|3|j|20191229|\n32LFZXA8166P1ZW|Apex Legal Associates|A|P|5|9|20230727|\n19IUYXT7806K1ZR|Trinity Textiles LLP|A|L|d|a|20250204|x\n33HQQXC5675A1ZD|Coral General Store|A|P|a|4|20220528|\n03RTXXO5348W1ZE|Om Unisex Salon|A|P|8|c|20171027|\n07FBUXP2624T1Z2|Prime Electronics Pvt Ltd|S|C|2|5|20180524|\n08XWOXZ7264D1ZQ|Zenith Sweets|A|P|9|8|20221012|w\n27QPWXS3967V1Z7|Sai Medicals|A|P|7|i|20200822|m\n27IPMXG0303R1Z1|Ganga General Store|A|P|7|i|20180509|\n24AMQXK7894G1ZY|Krishna Fashions LLP|A|L|3|0|20250603|0\n29AJRXR2478X1Z1|Riddhi Opticals|A|P|4|e|20220724|\n27KYKXO1222C1Z2|Orbit Boutique|A|P|7|g|20180219|\n27NGUXG1536L1Z6|Ganesh Fitness Pvt Ltd|C|C|7|f|20250921|\n33OGRXS7146Z1Z1|Shree Hardware|A|P|a|3|20180805|f\n07ALNXM2634L1ZA|Metro Boutique|A|P|2|5|20171230|\n09VHXXG7717B1Z1|Galaxy Stationers|A|P|c|b|20210813|v\n29NIHXK0626P1Z1|Kaveri Hardware|S|P|4|1|20230527|\n32ERPXL8400C1ZJ|Lakshmi Dental Care|A|P|5|9|20190630|\n27JGKXC7876G1ZC|Coral Fashions Pvt Ltd|A|C|7|i|20250102|0\n27XWOXN1931K1Z1|New Diagnostics LLP|A|L|7|g|20190507|a\n29LVDXS5308A1ZZ|Sai Stationers|C|P|4|1|20250602|v\n27TCSXS7035D1Z9|Sunrise Classes LLP|A|L|7|d|20250919|8\n37BIFXC5273A1Z8|Coral Boutique|A|P|0|l|20240206|\n27IPZXN3759R1ZR|Navkar General Store|S|P|7|d|20190406|\n27STPXE2072U1ZY|Evergreen Bakers|A|P|7|d|20180419|\n29AMAXS5136A1ZT|Sunrise Fashions LLP|A|L|4|1|20190911|0\n03RNMXR9680G1ZK|Royal General Store|A|P|8|c|20160921|\n29THRXU8038U1ZQ|Unity Kids Academy LLP|A|L|4|1|20240613|q\n27MOMXN1130U1ZJ|New Stays|A|P|7|i|20161130|\n32FLAXZ4481O1ZX|Zenith Hardware|A|P|5|9|20180628|\n08YAGXA5251K1ZP|Amrit Mobile Care|A|P|9|8|20230723|\n27SVGXS5543Z1Z9|Saffron Fashions Pvt Ltd|A|C|7|d|20240925|0\n24QQEXU2270T1Z9|Unity Opticals|A|P|3|j|20230605|\n24IVFXH5030G1ZE|Harmony Boutique|A|P|3|0|20160926|\n07GLAXT2211A1Z8|Trinity Realty Pvt Ltd|A|C|2|5|20230511|\n27FFPXK2444C1ZZ|Krishna Kitchens LLP|A|L|7|f|20191117|t\n24QSQXR6240D1ZR|Royal Kitchens LLP|A|L|3|j|20210507|\n27MPJXV8828Z1ZB|Vindhya Design Studio LLP|A|L|7|i|20220325|1\n29VTCXG1994Y1ZH|Ganesh Stays|A|P|4|e|20181001|6\n32TLEXG7302V1ZU|Galaxy Stays|A|P|5|9|20190102|\n33AOFXA2248T1ZB|Apex Bake House|A|P|a|3|20220603|4\n07ORQXN2173Z1ZM|Neelgiri Hardware|A|P|2|5|20210103|f\n08HWWXG8186U1ZB|Galaxy Medicals|A|P|9|8|20201103|\n07CHWXK9356R1ZH|Kaveri Physio Clinic|A|P|2|5|20250305|\n33ZOUXP4145L1Z8|Pearl Unisex Salon|A|P|a|3|20230925|\n07ESVXS6793Z1Z2|Saffron Diagnostics|S|P|2|5|20220501|a\n08SYIXG0611P1ZE|Galaxy & Associates Pvt Ltd|A|C|9|8|20250823|7\n27VSWXS6710K1ZV|Sahyadri Stationers|A|P|7|d|20200717|\n09RQTXA0069Q1ZA|Annapurna Classes|A|P|c|b|20171203|\n08KSAXS9633Q1Z4|Shree Boutique|A|P|9|8|20180926|\n37QRUXL7956K1ZS|Lakshmi & Associates LLP|A|L|0|l|20180604|\n27CYRXS4222F1ZN|Shree Physio Clinic Pvt Ltd|A|C|7|i|20230422|o\n27ZEEXA7813O1Z6|Apex Boutique|A|P|7|i|20221020|\n10RBOXU9980V1ZB|Unity General Store|A|P|1|h|20191219|h\n27UQUXO8330Z1Z8|Orbit Physio Clinic|A|P|7|d|20170910|\n36FMBXK1547E1ZT|Kaveri Unisex Salon|A|P|b|6|20180103|\n33RPUXT8172I1Z5|Trinity Opticals|A|P|a|3|20171127|k\n24UPKXN2565J1ZM|New Mobile Care|A|P|3|j|20210308|j\n33FOCXS6984C1Z7|Silver Oak Electronics|A|P|a|4|20220927|b\n27QECXS9292L1ZS|Sai Hardware|A|P|7|i|20240803|\n24LIEXN0737X1ZT|Neelgiri Hardware|A|P|3|0|20200607|f\n32RIYXA2018I1ZJ|Annapurna Auto Components|A|P|5|9|20200914|2\n37UIRXR4710O1ZH|Royal Bake House|A|P|0|l|20240624|4\n24LMGXS6096R1ZA|Star Mobile Care|S|P|3|k|20240305|j\n23FNEXG9354R1ZV|Galaxy Opticals|A|P|6|2|20170512|\n09EUWXG2842Y1ZP|Green Leaf Foods|A|P|c|b|20200608|c\n29YSUXS5445B1Z3|Sahyadri Dental Care|A|P|4|1|20170313|9\n32ESLXS7472V1ZX|Star Bake House Pvt Ltd|A|C|5|9|20200229|4\n09HYVXN8984A1ZY|Neelgiri Diagnostics|A|P|c|b|20180616|a\n29CXXXG5379Z1Z2|Green Leaf Bakers|A|P|4|1|20230515|\n10DAQXG9921E1ZD|Ganesh Stationers|A|P|1|h|20161217|\n32CPTXO1191X1Z9|Om Insurance Advisors|A|P|5|9|20220623|g\n08PJJXZ5358U1ZV|Zenith Physio Clinic Pvt Ltd|A|C|9|8|20250616|\n10NSHXT0633R1ZO|Trinity Stays LLP|A|L|1|h|20220921|6\n36TUOXV2634K1Z0|Vindhya Dental Care|A|P|b|6|20220731|\n23RZPXM0660H1ZG|Metro Realty|A|P|6|2|20180119|s\n36VQHXE1695K1ZJ|Evergreen Bakers|A|P|b|6|20221216|\n33CUEXO1655I1Z5|Orbit Textiles Pvt Ltd|A|C|a|4|20250331|x\n10KRTXH3522T1ZN|Harmony Bake House|A|P|1|h|20200423|\n29BKMXA3184L1ZB|Amrit Legal Associates Pvt Ltd|A|C|4|1|20180915|i\n03CLLXA4443F1Z4|Apex Printers LLP|A|L|8|c|20180215|\n24LYUXP2821Y1ZG|Prime Bakers|A|P|3|0|20180415|\n03HGRXK7594C1ZI|Kaveri Physio Clinic LLP|A|L|8|c|20230509|o\n27BZIXA7137H1ZX|Apex Opticals|A|P|7|i|20190521|\n36FPGXG1606F1ZS|Green Leaf General Store|A|P|b|6|20180928|\n24KCWXP6849H1Z3|Pearl Hardware|A|P|3|0|20230625|f\n27VOFXR8076J1Z8|Riddhi Electronics|A|P|7|g|20250701|b\n27SALXV6379K1ZQ|Vindhya Tours & Travels LLP|A|L|7|d|20240414|y\n37CICXB0978J1ZQ|Blue Lotus General Store|A|P|0|l|20170903|h\n23DTVXH5800G1Z7|Harmony Design Studio LLP|A|L|6|2|20250819|1\n33JVJXB3817F1ZB|Blue Lotus Mobile Care|A|P|a|4|20220803|\n24HRZXR4610V1ZY|Royal Medicals|A|P|3|0|20180607|\n36KCDXB7458W1Z1|Blue Lotus Stays|A|P|b|6|20190113|\n03OCNXE8100R1ZM|Evergreen Medicals|A|P|8|c|20170922|\n24WDHXO6089E1ZB|Orbit Physio Clinic Pvt Ltd|A|C|3|k|20240711|o\n33HKWXP2296O1ZI|Pearl General Store|A|P|a|3|20200202|\n29APQXV6801V1ZZ|Vindhya Bake House|A|P|4|1|20250117|\n19IUKXZ2324P1Z2|Zenith Classes Pvt Ltd|A|C|d|a|20180925|\n07SNIXL7949D1ZR|Lakshmi Fashions|A|P|2|5|20170815|0\n29VBSXA1233M1ZG|Amrit Unisex Salon|A|P|4|1|20190401|\n29HCUXO8254W1Z9|Orbit Boutique|A|P|4|1|20200314|\n29OQNXS4451L1Z7|Saffron Hardware|A|P|4|1|20200314|f\n36HXVXS9533Q1ZE|Sai Sweets|A|P|b|6|20201213|\n07XHVXN3250Z1ZX|New Electronics LLP|A|L|2|5|20241020|b\n33QSWXN6120D1ZV|New Fashions LLP|A|L|a|3|20180525|0\n23YEQXG6815S1ZP|Ganga Design Studio|A|P|6|2|20220607|1\n24GMYXK0402E1ZQ|Kaveri Stays Pvt Ltd|A|C|3|0|20170705|6\n24OJHXO6719G1Z9|Orbit Mobile Care|A|P|3|0|20191128|j\n27ILSXG5851Z1Z0|Green Leaf Realty LLP|A|L|7|f|20231104|\n29QHAXM4405G1ZO|Modern Kids Academy LLP|A|L|4|e|20190401|\n24HMGXS0648L1Z4|Sahyadri Textiles Pvt Ltd|A|C|3|j|20231016|x\n27EYNXS0615N1ZB|Star Design Studio|A|P|7|g|20250115|1\n27QBMXG5738D1ZQ|Galaxy Diagnostics|A|P|7|g|20231217|a\n32XGRXS1045R1ZO|Shree Tours & Travels|A|P|5|9|20200910|y\n33TAUXM2011V1Z5|Modern Stationers|A|P|a|3|20220812|v\n33KHZXS1392R1ZF|Sahyadri Dental Care Pvt Ltd|A|C|a|3|20200409|9\n07PAOXS8324N1Z0|Star Tours & Travels Pvt Ltd|A|C|2|5|20190502|y\n07BSWXR0494W1ZP|Riddhi & Associates|A|P|2|5|20180313|\n29GBYXA2598C1ZO|Amrit Tours & Travels|A|P|4|1|20160619|y\n27QMEXM6938Z1ZS|Moonlight Bakers|A|P|7|d|20200727|\n24TXEXN8699F1ZZ|Navkar Hardware|A|P|3|j|20230529|f\n07DASXO7711L1ZJ|Om General Store|A|P|2|5|20160809|\n10XDRXS0425H1ZN|Sai Mobile Care|A|P|1|h|20221118|\n24EFBXO7732T1Z8|Om Stays Pvt Ltd|A|C|3|0|20171222|6\n23UABXS0086F1Z0|Saffron Hardware|A|P|6|7|20211128|f\n27SXZXB4763T1ZB|Balaji Unisex Salon|A|P|7|i|20200705|\n29WPDXP1619R1Z6|Prime Dental Care|A|P|4|1|20241007|\n23OWDXT4108M1ZK|Trinity Woodcraft LLP|A|L|6|7|20241127|d\n24MJRXL6497P1ZA|Lakshmi Opticals|A|P|3|k|20241130|\n07HKOXZ4022Y1Z7|Zenith Legal Associates LLP|A|L|2|5|20190520|i\n36VPGXG1920I1Z4|Ganga Boutique|A|P|b|6|20190120|\n29OUSXS9253O1ZE|Silver Oak Insurance Advisors|A|P|4|1|20181225|\n29CWGXP1329X1ZY|Prime Textiles Pvt Ltd|A|C|4|1|20250208|x\n23DTGXC7408E1ZN|City Bakers|A|P|6|7|20240505|3\n33WAOXS4833Q1ZU|Sahyadri Mobile Care|A|P|a|3|20240505|\n29PBJXK1319O1ZE|Kaveri Stationers|A|P|4|1|20180831|v\n33WSAXC6355U1ZA|Classic Unisex Salon|A|P|a|4|20240113|u\n29RBNXU9798S1ZR|Unity Stays Pvt Ltd|A|C|4|1|20180722|\n29EWOXP8811J1Z7|Prime Opticals|A|P|4|1|20210627|\n08IEIXS4835B1ZS|Silver Oak Mobile Care|A|P|9|8|20180519|j\n29XLVXA1237C1Z7|Annapurna Boutique|A|P|4|1|20221008|\n29SSHXB2201H1ZB|Blue Lotus Fashions Pvt Ltd|A|C|4|1|20200211|0\n09VXUXA7425X1Z7|Amrit Boutique|A|P|c|b|20190119|\n10PWSXS9401X1ZK|Star Opticals|A|P|1|h|20171221|k\n37DAWXE3285E1ZW|Evergreen Legal Associates|A|P|0|l|20190418|i\n07TCKXR6482D1ZB|Royal Kids Academy LLP|A|L|2|5|20200520|\n29QBUXG9051Y1Z9|Galaxy Diagnostics|C|P|4|1|20200512|\n23QOTXL7898Z1Z5|Lakshmi Insurance Advisors|A|P|6|7|20241227|g\n33YMGXV3298B1ZU|Vindhya Opticals|A|P|a|4|20190808|k\n33CYTXR2683P1ZV|Riddhi Stays LLP|A|L|a|4|20250428|6\n07RQVXR2899V1Z3|Riddhi Sweets|A|P|2|5|20171220|w\n27KZRXV3071F1Z5|Vindhya Sweets|A|P|7|f|20230717|\n29JINXM2104O1Z6|Moonlight Bakers|A|P|4|e|20210517|3\n33RALXC9978T1ZO|Coral Opticals|A|P|a|3|20240326|\n09UTAXG7703O1ZF|Galaxy Insurance Advisors|S|P|c|b|20230309|\n10EGQXG6446F1Z0|Green Leaf Legal Associates|A|P|1|h|20220721|i\n27OYJXV0374S1ZK|Vindhya Electronics|A|P|7|d|20160829|b\n27TAHXR7997X1ZX|Royal Tours & Travels Pvt Ltd|A|C|7|d|20240102|y\n33QDDXK1580G1Z0|Kaveri Realty|A|P|a|4|20190523|s\n24GXHXG8846H1ZN|Ganga Unisex Salon|A|P|3|0|20231221|\n23UBHXK7695U1ZK|Kaveri Stationers|A|P|6|7|20221106|\n27SJNXH7061P1ZK|Harmony Physio Clinic LLP|A|L|7|d|20200404|\n27AWAXS1319O1ZR|Saffron Design Studio|A|P|7|f|20190121|1\n24APTXK7215X1ZB|Krishna Sweets|A|P|3|0|20241214|\n29UJQXH8899W1Z9|Harmony Opticals|A|P|4|1|20240226|\n37WXVXC4856R1ZB|Coral Unisex Salon|C|P|0|l|20200722|\n10OXTXM5512S1Z2|Modern Electronics|A|P|1|h|20210928|b\n19IFGXH1791B1ZZ|Harmony Sweets|A|P|d|a|20241001|\n29AEQXR0429A1Z1|Royal Kids Academy|A|P|4|e|20250322|q\n27PABXT7621Y1ZQ|Trinity Stationers|A|P|7|g|20240509|\n29SXAXN8202Y1ZK|Neelgiri Printers|A|P|4|1|20240531|r\n19BRUXM8532J1ZG|Moonlight Physio Clinic|A|P|d|a|20230217|o\n10WMTXN1755W1Z2|New Stationers|A|P|1|h|20181025|\n27CDWXN0613P1ZE|New Bake House|A|P|7|f|20191021|\n27PKHXM2990R1ZE|Moonlight Kids Academy LLP|S|L|7|g|20230304|q\n29NNRXS8593T1ZB|Sunrise Hardware|A|P|4|1|20190301|f\n24UTDXS8343J1ZC|Saffron Mobile Care|A|P|3|k|20190111|j\n19BVSXN5692T1ZI|Neelgiri Bakers|A|P|d|a|20230903|3\n29ANFXL2339K1Z9|Lakshmi Pharma Retail Pvt Ltd|A|C|4|1|20170309|n\n27GZAXR9679D1Z8|Royal Auto Components Pvt Ltd|A|C|7|i|20200821|2\n09WYEXK4035Y1ZG|Kaveri Fashions Pvt Ltd|A|C|c|b|20220207|0\n29PUEXH0889L1Z8|Harmony Kids Academy|S|P|4|e|20210909|q\n08VWEXP0821S1Z0|Prime Realty LLP|A|L|9|8|20200723|s\n27PEOXC0521M1ZP|Coral Bakers|A|P|7|i|20200629|3\n07OTJXR8266U1ZH|Riddhi Stays|A|P|2|5|20240425|6\n29EHLXG1203Y1Z4|Green Leaf Pharma Retail Pvt Ltd|A|C|4|e|20170203|n\n27IQHXS6054U1Z2|Sahyadri Tours & Travels Pvt Ltd|A|C|7|f|20240916|\n23FLVXU8655D1ZV|Unity Classes|A|P|6|2|20211016|\n29UBUXU2271V1Z5|Unity Opticals|A|P|4|1|20180709|\n07MJZXR3816T1Z3|Royal Realty Pvt Ltd|A|C|2|5|20250202|\n23ESXXS8039H1ZG|Star Tours & Travels|A|P|6|7|20191014|y\n24HYXXP0644M1Z4|Prime Hardware|A|P|3|0|20200310|\n29UKRXK4108M1ZL|Krishna & Associates Pvt Ltd|C|C|4|1|20190918|\n33RXKXG3033S1ZA|Green Leaf Tours & Travels|A|P|a|3|20210728|\n27FHOXH7052Q1Z0|Harmony Stays Pvt Ltd|A|C|7|d|20200704|6\n24UWWXL6523X1Z8|Lakshmi Stationers|A|P|3|k|20240701|\n29IFBXG2894R1Z1|Ganesh Fitness|A|P|4|e|20241203|e\n03HWDXO6323L1ZV|Om Physio Clinic|A|P|8|c|20221029|\n27MMHXZ1761N1ZH|Zenith Stays LLP|A|L|7|f|20240330|\n10OTWXK4768J1ZB|Krishna Bakers|A|P|1|h|20220222|\n27VMPXS0013Z1Z0|Saffron Opticals|A|P|7|g|20211221|\n03XKSXC3206N1Z4|Classic & Associates|A|P|8|c|20240307|7\n07MRBXG9963M1ZG|Ganga Physio Clinic|C|P|2|5|20220624|o\n29EBTXM7576E1ZB|Metro & Associates Pvt Ltd|A|C|4|1|20190731|\n27GACXP8912T1Z8|Prime Sweets|A|P|7|d|20190228|w\n27FEPXK1363M1ZG|Kaveri Dental Care|A|P|7|d|20200317|\n27WKYXR8043Q1ZR|Royal Diagnostics LLP|A|L|7|d|20180527|\n23BSWXS1625N1ZL|Sahyadri Design Studio LLP|A|L|6|7|20160927|\n36ERNXP6469D1ZQ|Prime & Associates|A|P|b|6|20171110|7\n07PKIXN9860V1ZZ|Neelgiri Stays LLP|A|L|2|5|20231220|6\n03JPLXM8963J1ZN|Metro Kitchens LLP|A|L|8|c|20180210|t\n07ORJXC9153V1Z2|Coral Tours & Travels Pvt Ltd|A|C|2|5|20200109|y\n29CWZXK3772W1ZB|Kaveri Opticals|C|P|4|e|20200809|\n29LZQXK4252Q1ZO|Krishna Bake House|A|P|4|1|20230110|4\n29OTSXG2161B1ZY|Green Leaf Sweets|A|P|4|1|20180402|w\n24KITXT0391U1ZD|Trinity Design Studio Pvt Ltd|A|C|3|k|20210115|\n09IOVXZ0868F1ZC|Zenith Mobile Care|A|P|c|b|20230422|j\n29WKBXR1036Z1Z5|Royal Kitchens Pvt Ltd|A|C|4|1|20180705|\n08IEUXS7446K1ZS|Silver Oak Classes|A|P|9|8|20241024|\n07LYHXB6786M1Z3|Blue Lotus Boutique|A|P|2|5|20230513|\n19MZWXB6059Y1Z2|Balaji Bakers|A|P|d|a|20250122|3\n24XJHXG8486B1Z6|Ganesh Hardware|A|P|3|k|20190213|\n33XLXXG7172S1ZZ|Ganesh Fashions|A|P|a|3|20230401|0\n27YZYXG0620G1Z8|Ganesh Design Studio LLP|A|L|7|d|20201118|1\n24UNEXA8597O1ZF|Amrit Stationers|A|P|3|j|20181112|\n33VKQXG8381Y1ZT|Ganesh & Associates|A|P|a|3|20250603|\n27MHIXS8266V1Z4|Silver Oak Printers LLP|A|L|7|d|20240822|r\n37NFAXA9474Q1Z2|Annapurna Design Studio|A|P|0|l|20180703|1\n33JZHXC2396B1Z4|Coral Packaging|A|P|a|3|20241114|l\n27FPYXL9728K1Z6|Lakshmi Fitness|A|P|7|i|20250813|e\n27IHCXC4026H1Z5|Classic Sweets|A|P|7|i|20170510|\n27JGZXK8163M1ZM|Krishna Stays|A|P|7|g|20171008|6\n36XBYXS5979P1ZW|Sai Realty LLP|A|L|b|6|20171016|s\n32XVFXP9025O1Z2|Prime Tours & Travels|A|P|5|9|20230824|y\n27NELXS1699H1Z0|Sahyadri Realty|A|P|7|d|20190422|\n23FDJXS4193P1Z8|Sunrise Diagnostics|A|P|6|2|20240130|\n33QNMXA0306G1ZU|Amrit Boutique|A|P|a|3|20170510|5\n29MIAXU6391H1ZY|Unity Foods Pvt Ltd|A|C|4|1|20200904|c\n27KWNXN3875Y1Z8|Navkar Stationers|A|P|7|f|20210831|v\n33AYBXC1222W1ZZ|Classic Pharma Retail|A|P|a|3|20250228|n\n37TCLXA3480M1ZD|Amrit Unisex Salon|A|P|0|l|20190509|\n32YJTXS2240M1ZP|Sai Mobile Care|A|P|5|9|20180820|j\n23MBKXS1618S1ZA|Star Realty|A|P|6|7|20181130|s\n29VNXXB5323P1Z8|Blue Lotus Realty Pvt Ltd|A|C|4|1|20240929|\n27JDRXS1644F1ZJ|Sunrise Unisex Salon|A|P|7|g|20190430|u\n27LRRXS3617L1ZA|Sai Kitchens|A|P|7|i|20240417|\n33MMBXC5254A1Z4|City Realty|A|P|a|3|20200415|s\n37QPMXB4716Y1Z2|Balaji Legal Associates|A|P|0|l|20230705|i\n24LMNXS2270G1Z6|Star Stays|A|P|3|j|20250508|6\n19TXUXM8677T1ZO|Moonlight Stationers|A|P|d|a|20180727|\n24CPTXS6412E1Z7|Saffron Medicals|A|P|3|j|20240218|\n32TQCXG3724S1ZQ|Green Leaf Kids Academy|A|P|5|9|20180907|q\n07FTWXM9924G1ZC|Moonlight Stationers|A|P|2|5|20220206|\n03OTIXG7421B1ZH|Galaxy Pharma Retail LLP|A|L|8|c|20171120|n\n33ZQUXG2689X1ZC|Ganga Woodcraft|A|P|a|3|20210616|d\n07EJLXC6266U1ZS|Classic Dental Care|A|P|2|5|20221011|\n32HJJXE5083Y1ZR|Evergreen Sweets|C|P|5|9|20200722|\n24LMYXP4602O1ZL|Pearl Dental Care|A|P|3|k|20200830|\n27PNSXB2865Q1ZC|Blue Lotus Tours & Travels|A|P|7|d|20250826|\n03BODXE2416A1ZK|Evergreen Physio Clinic|C|P|8|c|20190512|\n33IMPXE9087S1ZC|Evergreen Diagnostics|A|P|a|3|20240107|a\n37QXDXA4936R1Z4|Annapurna Insurance Advisors|A|P|0|l|20230106|\n33OLKXR3813H1Z9|Riddhi Pharma Retail Pvt Ltd|A|C|a|3|20190510|n\n23EYSXA1380C1ZB|Amrit Design Studio|A|P|6|2|20170305|1\n07YPDXN4173J1ZL|New Pharma Retail|A|P|2|5|20180606|n\n09PDBXN1690Q1Z3|Neelgiri Electronics|A|P|c|b|20230725|b\n03NJEXR8045U1ZM|Royal Pharma Retail|S|P|8|c|20190621|n\n09EVHXP8428E1ZO|Pearl Electronics LLP|A|L|c|b|20190507|\n23KCNXU2858D1ZO|Unity Fashions Pvt Ltd|A|C|6|7|20160712|0\n37ESGXM1723S1ZM|Moonlight Textiles Pvt Ltd|A|C|0|l|20250623|x\n37KBMXG2875C1ZX|Galaxy Realty|A|P|0|l|20221026|s\n37SQUXB7199D1ZE|Balaji Classes Pvt Ltd|A|C|0|l|20241019|\n33DXKXR9572F1ZG|Royal Unisex Salon|A|P|a|3|20211024|u\n27NALXO4339F1ZP|Om General Store|A|P|7|i|20220423|h\n19YVNXC6419X1ZC|Coral Insurance Advisors LLP|A|L|d|a|20250902|\n27NYEXA2663Z1ZT|Apex Tours & Travels LLP|C|L|7|d|20241224|\n23CRJXB0080A1Z8|Blue Lotus Design Studio|A|P|6|7|20230905|1\n08UDJXB9013D1ZY|Balaji Fashions|A|P|9|8|20220508|0\n24QXDXB6500D1ZF|Balaji Stationers|A|P|3|0|20200324|\n27WXMXV5825V1ZZ|Vindhya Bake House Pvt Ltd|A|C|7|d|20220730|\n03QIEXB3880B1Z3|Balaji Kitchens|A|P|8|c|20240905|t\n27IRMXC5656R1ZB|Classic Kids Academy|A|P|7|d|20230912|q\n24LZQXG5386P1ZR|Ganesh Textiles|A|P|3|j|20250202|x\n33TUWXS0230B1ZW|Sunrise Boutique|A|P|a|3|20200405|\n27UTXXO0562M1ZV|Om Hardware|A|P|7|d|20241006|f\n08JJQXM8788K1ZB|Modern Bakers|C|P|9|8|20241107|\n10TKNXC4995R1ZK|Coral Foods|A|P|1|h|20161211|c\n23LFRXU2070I1ZE|Unity Kids Academy|A|P|6|2|20180505|q\n10OPNXG9383O1ZH|Green Leaf Printers Pvt Ltd|A|C|1|h|20160627|r\n27HNQXU3815C1Z4|Unity Design Studio Pvt Ltd|A|C|7|i|20211006|1\n27ZVOXV8676K1Z5|Vindhya Fitness LLP|A|L|7|i|20250311|e\n24FIUXO4460V1ZI|Orbit Kids Academy|A|P|3|0|20201104|q\n08RQFXM8655F1ZL|Moonlight Legal Associates Pvt Ltd|A|C|9|8|20220413|i\n23EDVXA0465M1ZU|Annapurna Unisex Salon|A|P|6|7|20230618|\n36ODGXM4890X1ZH|Modern Fashions Pvt Ltd|A|C|b|6|20171123|\n36QXSXP8841L1ZK|Pearl Unisex Salon|A|P|b|6|20250505|u\n09LCGXB1694K1ZO|Blue Lotus Mobile Care|A|P|c|b|20250521|\n27ZJPXO1209P1ZI|Om Classes Pvt Ltd|A|C|7|d|20210122|8\n27UXVXB7893F1ZT|Blue Lotus Stays LLP|C|L|7|d|20191213|6\n33GWIXT4914M1ZG|Trinity Mobile Care|A|P|a|3|20190515|j\n36YZSXS4646Z1ZI|Silver Oak Polymers|A|P|b|6|20251120|p\n07OASXE0025I1Z3|Evergreen Tours & Travels|C|P|2|5|20240213|\n33IMLXS7553A1ZC|Saffron Insurance Advisors|C|P|a|4|20210104|g\n07XKVXG0665D1Z1|Galaxy Diagnostics|A|P|2|5|20240306|a\n29AZRXS7352D1ZA|Sahyadri Auto Components|A|P|4|1|20170317|2\n03PXLXS3141U1ZX|Star Hardware|A|P|8|c|20241216|\n27PYUXZ7041M1ZE|Zenith Fashions|A|P|7|i|20231020|0\n23QXAXB4341L1Z0|Balaji Fitness|A|P|6|7|20201227|e\n23TODXR5929M1ZI|Riddhi Medicals|A|P|6|2|20190903|\n23AANXO2212V1ZR|Orbit Woodcraft Pvt Ltd|A|C|6|2|20190514|d\n24VMOXN9252E1ZS|Navkar Unisex Salon|A|P|3|j|20220414|\n23QSFXL7001E1ZF|Lakshmi Unisex Salon|A|P|6|7|20221218|\n33ZEEXS0584H1ZC|Silver Oak Medicals|A|P|a|4|20200112|m\n10VSDXN5658O1ZD|Navkar Pharma Retail|A|P|1|h|20231228|\n23ETOXC4128Q1ZU|Classic Sweets|A|P|6|2|20170730|\n24GGBXN3764X1ZX|New Kids Academy Pvt Ltd|A|C|3|0|20200911|\n37NUMXU8391O1ZH|Unity Realty Pvt Ltd|A|C|0|l|20190521|\n33JEKXA7248M1ZM|Amrit Classes|A|P|a|3|20220730|\n07VAOXS5910Z1ZC|Star Bakers|A|P|2|5|20200422|\n24ZHZXS3407L1ZJ|Sunrise Classes Pvt Ltd|A|C|3|0|20240502|8\n36EXXXB8054L1Z8|Balaji Mobile Care|A|P|b|6|20200705|j\n33MDIXB7222H1Z7|Blue Lotus Sweets|A|P|a|3|20250203|\n24AJLXN4952W1ZO|Neelgiri Opticals|A|P|3|j|20180528|\n29CRQXC6805V1Z8|Classic Fitness|S|P|4|1|20221204|\n33QZZXM5838C1Z2|Moonlight Boutique|A|P|a|3|20190412|5\n27CKRXA0814G1ZX|Apex Fitness|A|P|7|i|20170308|\n27HPNXK1923C1ZG|Kaveri Kids Academy|A|P|7|d|20200301|q\n07HNCXB9136C1ZT|Blue Lotus Stationers|A|P|2|5|20210413|\n27HIMXG0726Y1ZR|Ganga Realty|A|P|7|f|20211230|\n27ARNXG9391Y1ZS|Galaxy Sweets|A|P|7|g|20250603|\n27FKVXC9852A1ZC|City Legal Associates Pvt Ltd|A|C|7|g|20240412|\n33HABXP4597Q1ZC|Prime Boutique|A|P|a|3|20190110|5\n03RIZXU9249U1ZO|Unity Mobile Care|A|P|8|c|20240709|j\n27OPHXG8041P1ZL|Green Leaf Pharma Retail|A|P|7|f|20220822|\n27ZFDXB0651C1Z3|Balaji Unisex Salon|A|P|7|d|20160806|\n27NXOXG1878R1ZO|Green Leaf Opticals|A|P|7|f|20230919|k\n08DHYXG1924E1ZP|Green Leaf General Store|A|P|9|8|20170105|h\n10YBHXV4971Y1ZF|Vindhya Tours & Travels|A|P|1|h|20170122|\n27WTPXP8334J1ZW|Prime Fitness|A|P|7|i|20191213|e\n19ZCCXO4856Z1Z4|Orbit Auto Components LLP|A|L|d|a|20240503|2\n24CHMXG8468Y1ZI|Galaxy Medicals|A|P|3|j|20211001|\n08ZOSXS9660O1ZG|Silver Oak Realty|A|P|9|8|20200907|s\n24UQGXG3352A1ZJ|Galaxy Tours & Travels|A|P|3|k|20221122|y\n23SQDXM8572X1ZT|Metro Insurance Advisors|A|P|6|7|20220626|\n19LNEXM2731P1ZT|Modern Mobile Care|A|P|d|a|20240913|\n29IWOXA1598T1ZS|Annapurna & Associates|A|P|4|1|20251002|7\n32ZRRXS6562V1ZB|Saffron Stays|A|P|5|9|20250701|\n03FWHXN1066L1ZW|New Tours & Travels|A|P|8|c|20250211|y\n32PCDXS0844C1Z8|Star Mobile Care|A|P|5|9|20230502|\n37CARXA2860B1ZH|Annapurna Hardware|S|P|0|l|20200510|\n29YTGXA6031C1Z3|Annapurna Woodcraft Pvt Ltd|A|C|4|1|20221222|d\n03AFVXG9074F1ZQ|Green Leaf Tours & Travels Pvt Ltd|A|C|8|c|20250826|y\n27RSFXU7526R1ZS|Unity Printers|A|P|7|i|20161127|r\n33HDBXT2148Y1Z3|Trinity Diagnostics Pvt Ltd|A|C|a|3|20191129|\n27UFUXN8507V1Z1|Navkar Mobile Care|A|P|7|d|20221228|\n27KNWXN5669U1ZL|Navkar Fashions|A|P|7|i|20180727|0\n29WRUXM6198B1Z1|Modern Tours & Travels LLP|A|L|4|1|20241209|y\n07KVLXS6117W1ZO|Sai Mobile Care|A|P|2|5|20190920|j\n03YIUXU2260I1ZT|Unity Legal Associates|A|P|8|c|20231218|i\n37LVWXU5163P1ZH|Unity Stays LLP|A|L|0|l|20220818|\n33WSNXH2872S1ZY|Harmony Tours & Travels LLP|A|L|a|3|20191104|y\n07CKVXA3006O1ZG|Amrit & Associates Pvt Ltd|A|C|2|5|20170613|7\n07QHIXG4300Y1ZX|Green Leaf General Store|A|P|2|5|20230328|h\n29SHRXR2506S1ZD|Royal Legal Associates|A|P|4|1|20170225|i\n24NFMXC2114N1ZU|Coral Realty Pvt Ltd|A|C|3|0|20230830|\n09LBIXB5546E1Z2|Blue Lotus Auto Components|A|P|c|b|20210810|2\n33AMAXS2243D1Z4|Sunrise Sweets|A|P|a|3|20161104|w\n29SEQXN2444Y1Z7|Navkar Classes|A|P|4|1|20201105|8\n03FHLXH3049L1ZQ|Harmony Tours & Travels|A|P|8|c|20200413|y\n10DXVXM5509T1Z4|Moonlight Fashions LLP|A|L|1|h|20190927|0\n07CDTXS4871Q1ZS|Star Sweets|A|P|2|5|20251014|w\n10EZGXO8608T1Z6|Om Bake House|A|P|1|h|20170602|4\n33UMDXG4181F1ZG|Ganga Tours & Travels Pvt Ltd|A|C|a|3|20251120|\n29ERUXN0087G1ZO|Neelgiri Design Studio Pvt Ltd|A|C|4|e|20181230|1\n27WYUXV2386N1Z3|Vindhya Dental Care LLP|C|L|7|i|20220423|9\n27JCYXS6675J1ZO|Sahyadri Classes|A|P|7|d|20160721|8\n27SVRXP4743E1Z8|Prime Design Studio|S|P|7|f|20170823|\n08DRNXN4805H1Z0|Navkar Hardware|A|P|9|8|20200713|\n27BHZXA0122W1Z7|Apex Boutique|A|P|7|f|20240319|\n36TDRXV3839T1Z5|Vindhya General Store|C|P|b|6|20200126|h\n10ITBXS6663R1ZG|Silver Oak Sweets|A|P|1|h|20230315|\n23HMPXP7002J1ZA|Pearl Design Studio|A|P|6|7|20250714|\n27GIKXC2227D1Z5|Coral Bake House Pvt Ltd|A|C|7|d|20200616|4\n33EDCXM6771O1ZJ|Modern Stays LLP|A|L|a|3|20250829|6\n23NDYXS3624W1ZH|Sahyadri Dental Care|A|P|6|7|20250728|9\n27ISNXR4402D1Z4|Royal Medicals|A|P|7|i|20211211|\n23AXDXC3225Z1ZN|City Kitchens LLP|A|L|6|2|20190608|t\n07EIHXN7394K1Z0|New Insurance Advisors|A|P|2|5|20230212|\n29IQAXS9014Q1ZF|Star Boutique|A|P|4|1|20241012|\n36GAXXG7606D1ZX|Galaxy Kids Academy|A|P|b|6|20220104|q\n27CYGXA2176M1ZS|Annapurna Tours & Travels|A|P|7|f|20210303|y\n19BZNXA6784W1ZJ|Apex Bakers|A|P|d|a|20170220|\n27PYQXT2836N1ZL|Trinity Hardware|A|P|7|i|20190624|\n29DZEXP1186S1ZW|Pearl Classes|A|P|4|1|20211003|8\n27QZDXN5837Y1Z8|Neelgiri Bake House Pvt Ltd|A|C|7|i|20250216|\n24TXKXM9064Z1Z4|Metro Sweets|A|P|3|k|20241116|w\n32ZMYXS0636P1Z3|Sahyadri Bakers|A|P|5|9|20200226|\n24CLIXA5105M1ZV|Annapurna Legal Associates Pvt Ltd|A|C|3|k|20230708|\n27WDCXS1214N1ZE|Saffron Mobile Care|A|P|7|i|20200505|\n27NHCXA3889P1Z0|Amrit Bakers|A|P|7|d|20210401|3\n36XNAXS7535R1Z3|Shree Fitness|A|P|b|6|20160614|\n29GGAXR1212R1ZH|Riddhi Classes|A|P|4|e|20231015|\n10OIYXA9787X1Z0|Annapurna Opticals|A|P|1|h|20180406|\n03UGNXP3068L1Z0|Pearl Physio Clinic LLP|A|L|8|c|20200402|o\n19UDWXG1052X1ZH|Ganesh Fitness|A|P|d|a|20221101|\n24YWUXG0911A1ZY|Green Leaf Sweets|A|P|3|0|20190214|\n29KBXXN3993R1ZC|Neelgiri Polymers|C|P|4|e|20210708|\n29SOEXG1551O1ZR|Ganga Stationers|A|P|4|1|20241105|\n33TZFXZ4145O1ZR|Zenith Unisex Salon|A|P|a|4|20200515|u\n07VMOXS1508Y1ZV|Sahyadri Opticals|A|P|2|5|20250225|k\n29HOZXA8478F1ZI|Amrit Legal Associates|A|P|4|1|20231223|i\n24CAOXM9858P1Z2|Moonlight Kitchens LLP|A|L|3|j|20180924|\n23KODXP2272K1Z7|Prime Physio Clinic LLP|A|L|6|7|20251109|o\n33RYMXZ4872P1ZC|Zenith Sweets|A|P|a|4|20220218|\n27EDVXS3064F1ZI|Silver Oak & Associates Pvt Ltd|A|C|7|i|20211005|7\n27URSXS3298U1Z5|Star Bakers|A|P|7|g|20250616|3\n23ZPSXL5449B1ZP|Lakshmi Opticals|S|P|6|7|20211125|k\n23OVZXN2956P1ZO|Navkar General Store|A|P|6|7|20230526|\n32OCGXS0735M1ZN|Sunrise Stationers|A|P|5|9|20250904|v\n09JJQXC7392P1ZJ|Coral Fitness LLP|A|L|c|b|20231114|\n03UAKXG6514T1ZB|Ganesh Opticals|A|P|8|c|20201226|k\n37ROMXH5761A1Z3|Harmony Kitchens Pvt Ltd|C|C|0|l|20200912|\n23SMZXK4291W1ZR|Kaveri Sweets|A|P|6|2|20210217|\n36OCQXA2448Z1ZR|Annapurna Medicals|A|P|b|6|20210807|m\n03HKQXN1430N1ZD|Neelgiri Dental Care LLP|A|L|8|c|20201001|9\n24IKKXR7862S1ZC|Royal Kids Academy|A|P|3|k|20240303|\n27XFKXL8035H1Z4|Lakshmi Polymers LLP|A|L|7|f|20170414|\n32EAOXM2812H1ZC|Moonlight Pharma Retail|A|P|5|9|20210216|n\n24TEJXS0991W1ZE|Sunrise Unisex Salon|C|P|3|k|20190102|u\n29LDWXC4636E1ZK|City Medicals|A|P|4|1|20170908|\n23QESXO2981E1ZD|Om Medicals|A|P|6|2|20190730|\n08APFXG1633Q1Z7|Ganesh Bakers|A|P|9|8|20220305|3\n23AQQXS9585B1ZU|Star Sweets|A|P|6|7|20190729|\n33QEMXC2490H1ZS|City Fitness|A|P|a|4|20250919|e\n09JKLXS8271K1ZK|Sai Insurance Advisors LLP|A|L|c|b|20191130|\n33FTCXL3646F1ZD|Lakshmi Mobile Care|A|P|a|3|20230926|\n27SELXS7467X1ZW|Star Medicals|A|P|7|d|20221030|\n23XPMXB6846M1ZH|Balaji Dental Care LLP|A|L|6|2|20160731|9\n03EXKXS4599S1ZP|Saffron Woodcraft LLP|A|L|8|c|20240121|d\n23CSXXS0826D1Z3|Star Electronics|A|P|6|2|20160913|b\n32TZSXS6268B1Z2|Sai Tours & Travels|A|P|5|9|20210325|\n27XQEXC1939Y1ZY|Coral Woodcraft|A|P|7|d|20170218|d\n09NZCXS2831F1ZK|Sahyadri Insurance Advisors|A|P|c|b|20230421|\n19IETXS6529O1ZK|Silver Oak Hardware|A|P|d|a|20200307|\n29RKQXC5652W1Z2|City Physio Clinic LLP|A|L|4|1|20180329|o\n29EVVXS6735A1ZF|Star Physio Clinic LLP|A|L|4|1|20240315|o\n07MQEXM6112U1ZI|Modern Hardware|A|P|2|5|20160917|\n24YOFXM0982R1Z9|Modern Tours & Travels|A|P|3|0|20161223|y\n23XJHXS5229F1Z5|Sai Insurance Advisors LLP|A|L|6|7|20211209|\n08QSQXA5575X1ZL|Annapurna Tours & Travels LLP|A|L|9|8|20250925|y\n29YICXH2259A1ZK|Harmony Electronics|A|P|4|1|20230518|b\n23NNCXM6372M1ZX|Modern Dental Care|A|P|6|7|20190416|9\n07XKUXC9586B1ZO|Classic Physio Clinic Pvt Ltd|A|C|2|5|20210904|o\n08EUYXZ5413B1ZK|Zenith Opticals|A|P|9|8|20190726|k\n29HBZXM2105E1ZV|Metro Boutique|A|P|4|1|20180617|\n32QYVXK0427H1ZJ|Kaveri Mobile Care|A|P|5|9|20210128|\n24VVKXU4771Q1ZK|Unity Bake House|A|P|3|0|20170210|4\n27WCJXS0859D1ZD|Silver Oak Hardware|A|P|7|d|20191217|\n32UDXXC2226B1Z3|Coral Hardware|A|P|5|9|20210910|\n23OVSXL6523V1ZQ|Lakshmi Legal Associates LLP|A|L|6|7|20201009|i\n23PSEXR5636K1ZL|Royal Stays Pvt Ltd|A|C|6|7|20251024|6\n24YLFXZ8933Q1ZX|Zenith General Store|A|P|3|k|20180319|\n27CYXXN5752O1ZQ|Navkar Pharma Retail|A|P|7|g|20160819|n\n09JEWXM5868X1ZX|Metro Packaging|A|P|c|b|20170619|l\n29DVYXR4286Y1ZZ|Riddhi Insurance Advisors|A|P|4|1|20240717|g\n24DRJXR6099Z1ZN|Riddhi Fashions LLP|A|L|3|k|20171025|0\n33UWHXN0154V1ZZ|Neelgiri Opticals|A|P|a|3|20250618|k\n27BOLXK5656W1Z7|Kaveri Stationers|A|P|7|d|20200616|v\n03SYYXM6281N1ZK|Modern Classes|A|P|8|c|20200618|8\n29MBBXS5701N1ZH|Silver Oak Hardware|A|P|4|1|20250312|f\n33HNYXL3295B1Z4|Lakshmi Kids Academy LLP|A|L|a|4|20200609|q\n24LHCXG2560N1ZO|Galaxy & Associates LLP|A|L|3|j|20200729|\n24SQMXK9511V1ZZ|Kaveri Legal Associates|A|P|3|j|20200519|i\n09NJZXP0887I1ZD|Pearl Bake House Pvt Ltd|A|C|c|b|20171116|4\n29FECXC4330V1ZI|Coral Diagnostics LLP|A|L|4|e|20180907|\n27PMSXO7505U1ZY|Om Stays|A|P|7|d|20221212|\n24MRNXB1481Q1ZO|Balaji Hardware|A|P|3|k|20180304|\n09UXNXB3995Y1Z1|Blue Lotus Unisex Salon|A|P|c|b|20230928|\n29YDHXK6936R1ZG|Krishna Physio Clinic LLP|A|L|4|e|20220122|\n09SNDXS8755E1ZL|Saffron Fashions Pvt Ltd|A|C|c|b|20221112|0\n03BOHXT8260U1ZI|Trinity Unisex Salon|A|P|8|c|20190930|\n09AACXS8664X1ZS|Sahyadri Bakers|A|P|c|b|20240909|3\n29FRWXA7475B1ZU|Apex Kids Academy Pvt Ltd|A|C|4|e|20211109|q\n07VKAXT1509V1ZH|Trinity Opticals|A|P|2|5|20230530|\n29WQPXS8294C1ZZ|Sunrise Sweets|A|P|4|1|20160712|\n27ZZGXA2790N1ZX|Amrit Tours & Travels|A|P|7|i|20231031|\n33CGUXE6224H1ZW|Evergreen Stays Pvt Ltd|A|C|a|3|20170505|\n27RVZXZ9288K1ZW|Zenith Unisex Salon|A|P|7|f|20190619|u\n27VNWXV7853N1ZI|Vindhya Realty|A|P|7|f|20220629|\n27DKXXC6197S1ZB|Classic & Associates LLP|A|L|7|d|20240706|7\n24NTLXS6553T1ZR|Star Electronics Pvt Ltd|A|C|3|j|20250919|b\n23VETXG5886B1ZB|Ganga Realty Pvt Ltd|A|C|6|7|20210208|s\n10APJXG6316N1ZI|Ganga Boutique|A|P|1|h|20160712|5\n29VPNXS3087P1ZO|Sunrise Stays|A|P|4|1|20160523|6\n36NIBXR1797Y1Z5|Riddhi Dental Care|A|P|b|6|20241209|9\n27HBPXU9682F1Z3|Unity Sweets|A|P|7|i|20160530|\n24CHXXS7165F1Z6|Sai Hardware|A|P|3|0|20201129|\n07ELAXS5251K1ZC|Sunrise Physio Clinic Pvt Ltd|A|C|2|5|20171231|\n19NVEXA3682V1ZZ|Amrit Hardware|A|P|d|a|20230615|\n27KIQXA8986S1Z8|Annapurna Fitness|A|P|7|d|20181205|e\n23UGLXO1087T1ZM|Orbit Legal Associates Pvt Ltd|A|C|6|2|20231227|i\n27YCMXM3678K1ZS|Modern Insurance Advisors LLP|A|L|7|d|20230805|\n37XKKXN5405W1Z3|Neelgiri Hardware|A|P|0|l|20190326|f\n23HIIXS8889J1ZP|Saffron Electronics|A|P|6|7|20191021|b\n29FGUXG3354T1ZQ|Ganesh Woodcraft|A|P|4|1|20210923|d\n07WTSXA8155C1ZM|Apex Realty Pvt Ltd|A|C|2|5|20211008|\n03VLPXS1980H1ZR|Sai Unisex Salon|A|P|8|c|20181228|\n27UZJXL4695A1Z7|Lakshmi Textiles LLP|A|L|7|d|20191205|x\n33CZWXB3640X1ZZ|Blue Lotus Diagnostics LLP|A|L|a|4|20250820|a\n32GMNXC3494U1ZP|City Legal Associates|A|P|5|9|20160926|\n07KAHXO2689Y1ZM|Om Packaging|A|P|2|5|20240522|l\n33MVOXS6948R1ZJ|Sunrise Legal Associates Pvt Ltd|A|C|a|3|20250623|i\n24ZSCXN8743I1ZD|Neelgiri Bake House Pvt Ltd|A|C|3|j|20241207|4\n24LBXXM9478L1ZQ|Moonlight Dental Care|A|P|3|0|20191212|\n27TVOXN6262A1ZI|New Bake House|A|P|7|d|20210826|\n24RODXG2781V1ZF|Galaxy Tours & Travels|A|P|3|0|20180309|y\n33XGTXT4416F1Z3|Trinity Bake House|A|P|a|4|20200114|4\n33HEHXN2442A1ZH|Navkar Stationers|A|P|a|3|20230113|v\n23YDGXV1435S1ZW|Vindhya Hardware|A|P|6|2|20201222|\n07YFGXS0176R1ZN|Saffron Sweets|A|P|2|5|20241112|w\n29MWPXN8406F1ZA|Navkar Unisex Salon|A|P|4|e|20190810|\n29AIPXH9344K1Z2|Harmony Medicals|A|P|4|1|20180903|\n29NNSXB1919Y1Z1|Balaji Bake House LLP|A|L|4|1|20250425|4\n19JNWXO3853T1ZU|Om Tours & Travels LLP|A|L|d|a|20191124|\n19ORHXA9881Z1ZI|Amrit Fashions LLP|C|L|d|a|20240703|0\n27ADAXP5912A1ZJ|Pearl Boutique|A|P|7|i|20170116|\n36XEVXA2876Y1Z3|Apex Electronics Pvt Ltd|A|C|b|6|20230820|\n19SCWXG1917Q1ZT|Green Leaf Stationers|A|P|d|a|20241223|v\n29OAJXP1550V1ZX|Prime & Associates|A|P|4|1|20200916|\n24WPRXG3243D1Z4|Green Leaf Medicals|A|P|3|k|20220925|m\n36YOGXU2926Q1Z1|Unity Legal Associates Pvt Ltd|A|C|b|6|20170412|i\n23OIVXM5535M1ZS|Moonlight Insurance Advisors|A|P|6|7|20230130|\n27PZSXS1936O1ZH|Saffron Dental Care LLP|A|L|7|f|20200512|\n23YXMXN0068G1ZF|Neelgiri Insurance Advisors Pvt Ltd|S|C|6|7|20211211|g\n29HZGXA3895C1ZQ|Annapurna Unisex Salon|A|P|4|1|20250509|\n36PNMXS8352V1ZQ|Sahyadri Unisex Salon|A|P|b|6|20170908|\n08XPGXL3873U1ZS|Lakshmi Stays Pvt Ltd|A|C|9|8|20240215|6\n23IVUXH7055D1ZU|Harmony Polymers LLP|A|L|6|7|20230428|p\n24WWFXN4144V1ZS|New Pharma Retail|A|P|3|0|20251014|n\n27EDEXS9136R1Z1|Saffron Fitness Pvt Ltd|A|C|7|f|20191121|e\n07CEKXN0853Q1ZE|Neelgiri Fitness Pvt Ltd|A|C|2|5|20220906|\n19YXQXN1436Z1ZZ|New Diagnostics|A|P|d|a|20220128|\n29UMCXN9796I1Z5|Navkar Physio Clinic Pvt Ltd|A|C|4|1|20210512|o\n37HLKXC7906L1Z4|City Hardware|A|P|0|l|20220329|\n27FUBXS2327R1ZH|Sunrise Pharma Retail Pvt Ltd|A|C|7|d|20250127|n\n19GSPXM7318S1ZY|Modern Unisex Salon|C|P|d|a|20240112|u\n29QTLXS6507Q1ZQ|Saffron Stationers|A|P|4|e|20211202|v\n27TJFXK3520G1ZJ|Kaveri Tours & Travels LLP|A|L|7|f|20231129|y\n27EIOXA8022D1Z0|Amrit Stationers|S|P|7|d|20190818|\n33WRSXO5853E1ZE|Orbit Polymers|A|P|a|3|20181109|p\n32DVPXM6495T1ZT|Modern Classes|A|P|5|9|20250107|8\n32XSIXC8239Y1ZS|Coral Boutique|A|P|5|9|20180705|5\n33BONXC5877E1ZE|Classic Tours & Travels|A|P|a|3|20220611|y\n23TRZXS5731Z1Z7|Star Hardware|A|P|6|2|20200701|\n07JYOXS9002X1ZG|Silver Oak Sweets|A|P|2|5|20180120|\n24LNLXG3545Y1ZD|Ganga Medicals|A|P|3|k|20221013|m\n07TMYXO5726K1Z7|Om Kids Academy LLP|A|L|2|5|20230223|q\n07XVXXM7189F1ZM|Moonlight Boutique|A|P|2|5|20170925|5\n10TZIXS1961A1ZU|Sai Pharma Retail LLP|A|L|1|h|20221118|n\n24DXBXT3616U1ZA|Trinity Tours & Travels Pvt Ltd|A|C|3|0|20171026|\n29KIKXM5850Z1Z3|Moonlight Unisex Salon|A|P|4|1|20170209|\n24ZTPXN8954W1Z1|New Medicals|S|P|3|0|20160805|\n07AJEXS0301O1ZR|Shree Medicals|A|P|2|5|20160819|\n27EXCXH2500X1ZJ|Harmony Tours & Travels|A|P|7|d|20170907|y\n09VZOXS4551X1ZU|Silver Oak Unisex Salon|A|P|c|b|20180315|u\n33IAGXG5052B1ZQ|Green Leaf Hardware|A|P|a|3|20190626|\n27BZZXA1857I1ZE|Annapurna Stationers|A|P|7|d|20190103|\n33QQTXG2268I1ZP|Ganesh Classes|A|P|a|3|20250612|\n19OKIXU7416K1ZM|Unity Dental Care|C|P|d|a|20180216|9\n36QIIXR5891C1Z1|Royal & Associates LLP|A|L|b|6|20201006|7\n10ZZPXR4254O1ZP|Royal Kids Academy|A|P|1|h|20190207|q\n36SSHXP5570D1ZO|Prime Physio Clinic LLP|A|L|b|6|20201216|\n24ZKUXP8734T1ZO|Pearl Stationers|A|P|3|0|20220427|\n09EDWXN7041Y1ZG|New Insurance Advisors|A|P|c|b|20210501|g\n36TVNXG1183U1ZS|Ganga Stationers|A|P|b|6|20180221|\n27LVTXK0100S1ZE|Krishna Stays Pvt Ltd|A|C|7|g|20180712|6\n07JNZXM5528E1ZT|Metro Legal Associates|A|P|2|5|20210901|\n24VJRXG1435M1Z0|Ganga Medicals|A|P|3|0|20250520|m\n23XWZXO0214K1Z7|Orbit Stays Pvt Ltd|A|C|6|2|20210505|6\n33HLNXG9238Y1ZA|Ganga Physio Clinic Pvt Ltd|A|C|a|3|20230124|o\n24DYFXG3123F1ZI|Green Leaf Diagnostics Pvt Ltd|A|C|3|0|20200117|a\n33KAUXH9528J1ZF|Harmony Insurance Advisors|A|P|a|3|20190725|g\n29SEBXS4966K1ZU|Star Sweets|A|P|4|e|20240215|\n23UPHXA2603N1Z9|Annapurna Printers Pvt Ltd|A|C|6|7|20160927|\n33UTEXM8681N1Z1|Moonlight Pharma Retail LLP|A|L|a|3|20250330|\n33FIIXB4713D1ZD|Blue Lotus Electronics|A|P|a|4|20161109|b\n19HRAXL6643Z1ZZ|Lakshmi Hardware|A|P|d|a|20230313|f\n27FFLXB2378L1ZK|Balaji Medicals|A|P|7|i|20190728|m\n33IZXXL0283G1ZG|Lakshmi Bakers|A|P|a|3|20240908|\n24LZGXS3563A1ZT|Silver Oak Bakers|A|P|3|k|20221201|3\n27RMTXH9452I1ZG|Harmony Stationers|S|P|7|d|20211025|\n36UJQXR3248C1Z0|Riddhi Insurance Advisors Pvt Ltd|A|C|b|6|20210209|\n24WLRXL9370V1ZQ|Lakshmi Polymers Pvt Ltd|A|C|3|j|20200910|p\n37OWLXS0694O1ZP|Sai Realty Pvt Ltd|A|C|0|l|20211030|s\n27ALPXN5882V1Z5|New Diagnostics Pvt Ltd|A|C|7|d|20170226|a\n27KTMXS3058G1ZK|Sunrise Boutique|A|P|7|d|20221203|5\n27WVSXE2212Z1ZN|Evergreen Stationers|A|P|7|d|20241123|v\n23WCTXB6837N1Z1|Blue Lotus Bakers|A|P|6|2|20251108|\n27MEZXH3033B1ZU|Harmony Pharma Retail|A|P|7|d|20180213|n\n07CWXXM1348E1ZQ|Metro Stays LLP|A|L|2|5|20170910|6\n33IDMXP3483N1Z9|Prime & Associates Pvt Ltd|C|C|a|3|20240421|7\n29BPAXA0720X1Z5|Annapurna Diagnostics LLP|A|L|4|1|20190103|a\n19SKBXN1191D1ZF|Neelgiri General Store|A|P|d|a|20181126|\n23HZXXO5414A1ZS|Om Opticals|A|P|6|7|20190414|k\n29VWNXZ8482A1ZP|Zenith Realty|A|P|4|e|20210711|\n19LUJXE1143M1ZS|Evergreen Stationers|A|P|d|a|20180412|\n23SNPXP2345V1Z5|Pearl Kids Academy LLP|A|L|6|7|20181231|\n27USJXE4777W1ZK|Evergreen Electronics Pvt Ltd|A|C|7|i|20170224|\n36MZJXK7860J1Z1|Kaveri Dental Care LLP|A|L|b|6|20220511|9\n07DFIXG3750R1ZG|Green Leaf Opticals|A|P|2|5|20250727|\n23VCVXB1574Z1ZK|Blue Lotus Design Studio LLP|C|L|6|2|20161208|1\n24PQQXG3168M1ZJ|Green Leaf Kitchens LLP|A|L|3|k|20230601|t\n10QWVXA0612Z1Z7|Annapurna Kitchens LLP|A|L|1|h|20220411|t\n27WTOXO2248S1ZN|Om Mobile Care|A|P|7|f|20200621|\n29GFHXZ4704O1ZZ|Zenith General Store|A|P|4|1|20180901|h\n09KDDXE6029D1Z7|Evergreen General Store|A|P|c|b|20160525|h\n23UVLXS4390Z1Z7|Sahyadri & Associates|A|P|6|7|20180202|7\n24DKDXA3407S1ZO|Amrit Kitchens|A|P|3|0|20161221|t\n27NHLXN8465X1Z0|Neelgiri Physio Clinic|A|P|7|g|20251031|o\n37HPSXP1397P1Z2|Pearl Mobile Care|A|P|0|l|20210524|\n09OUPXZ5915M1ZN|Zenith Classes|A|P|c|b|20201111|8\n29MGDXS2586G1Z7|Sunrise Electronics|A|P|4|e|20190718|\n07ARWXO3645X1ZU|Om & Associates Pvt Ltd|A|C|2|5|20200818|7\n37NJEXM8464E1Z6|Metro Unisex Salon|A|P|0|l|20211209|\n32GPEXS7977K1ZK|Star Bakers|A|P|5|9|20220625|3\n29BWIXA8135G1Z1|Apex Sweets|A|P|4|e|20240501|\n24CEDXG5639N1ZS|Ganga Diagnostics Pvt Ltd|A|C|3|0|20170808|\n10DNOXO1192G1ZL|Orbit Insurance Advisors|A|P|1|h|20170627|\n19GWPXR4540N1Z1|Royal Electronics|A|P|d|a|20170131|\n19TYVXZ5978I1ZW|Zenith Medicals|A|P|d|a|20190326|\n33HHYXM1624P1Z2|Metro Fitness LLP|A|L|a|3|20240930|\n27BKVXK9108I1Z2|Krishna Electronics LLP|A|L|7|i|20200401|b\n33PTNXZ8363E1Z8|Zenith Dental Care LLP|A|L|a|4|20180828|\n03NKPXR1457D1ZE|Royal Boutique|A|P|8|c|20190424|5\n24YPHXS2848N1Z6|Sunrise Stays Pvt Ltd|A|C|3|j|20180311|6\n07FOVXS6714J1ZK|Saffron Pharma Retail|A|P|2|5|20231128|n\n24XKTXN5567N1Z4|Navkar Printers Pvt Ltd|A|C|3|0|20181009|r\n03UAJXG7426W1Z1|Ganesh Unisex Salon|A|P|8|c|20190616|\n33CVRXO3340J1ZU|Om Fashions LLP|S|L|a|3|20241103|\n09GHTXK2011T1Z2|Krishna Printers|A|P|c|b|20220428|\n27JMHXG0303W1Z1|Ganga Legal Associates|A|P|7|d|20200824|i\n37IMQXB5769O1ZH|Balaji Unisex Salon|A|P|0|l|20210101|\n32EEZXS9142M1ZZ|Saffron Tours & Travels Pvt Ltd|C|C|5|9|20240522|\n27MGCXG9308T1ZZ|Galaxy Design Studio Pvt Ltd|A|C|7|g|20250301|1\n27BGNXS0919Q1Z2|Shree Stays|C|P|7|g|20200516|\n23LYQXM2688L1ZY|Metro Kitchens|A|P|6|2|20251101|t\n03JMLXP6659H1ZY|Pearl Dental Care|A|P|8|c|20220127|9\n27UNAXN7228N1ZK|Navkar Hardware|A|P|7|f|20191024|f\n07FNKXE5717C1ZP|Evergreen Legal Associates|A|P|2|5|20210221|i\n27NIXXN3763M1ZG|Navkar Boutique|A|P|7|d|20230215|5\n27DZEXV7895J1ZS|Vindhya Textiles|A|P|7|i|20200203|x\n23XUNXA3437Z1ZS|Amrit Opticals|A|P|6|2|20220715|\n03DCGXS8124I1Z0|Sunrise Sweets|S|P|8|c|20181202|\n03BWOXG8467V1ZX|Galaxy Boutique|C|P|8|c|20250522|5\n23DYTXN5211H1ZU|Neelgiri Mobile Care|A|P|6|7|20161227|j\n24PJXXN1072K1ZW|Neelgiri Legal Associates|A|P|3|k|20211219|\n33SBHXS8833W1ZJ|Saffron Kids Academy Pvt Ltd|A|C|a|4|20230325|\n27SDUXV2365K1ZP|Vindhya Bakers|A|P|7|d|20200216|3\n03NBLXS9338X1ZJ|Sahyadri Realty Pvt Ltd|A|C|8|c|20220810|\n36CHRXN9824I1Z3|New Dental Care|C|P|b|6|20170312|9\n24YJIXS1562Z1Z0|Saffron Medicals|A|P|3|0|20200506|\n29SQKXT0982H1ZA|Trinity Tours & Travels Pvt Ltd|A|C|4|1|20180309|y\n37FZPXZ5800H1Z6|Zenith Unisex Salon|A|P|0|l|20201227|u\n27FVMXG8786E1ZG|Galaxy Polymers Pvt Ltd|A|C|7|d|20200311|p\n24ZHNXS6875N1Z5|Sahyadri Tours & Travels Pvt Ltd|A|C|3|j|20220722|y\n27BEPXL9127C1ZU|Lakshmi Hardware|A|P|7|g|20211203|f\n24SZYXP9852C1ZR|Prime Stationers|A|P|3|j|20201019|v\n07TCKXK4623D1ZV|Krishna Insurance Advisors LLP|A|L|2|5|20200513|\n03BQTXL3914S1ZN|Lakshmi Stays|A|P|8|c|20210608|6\n27KESXC2342X1ZX|Coral Unisex Salon|A|P|7|d|20180217|u\n32YOMXP3470J1ZL|Prime Physio Clinic LLP|A|L|5|9|20201003|\n24UMEXM0136X1ZK|Metro Unisex Salon|A|P|3|k|20250619|\n07UBGXS5732Q1ZX|Silver Oak Classes Pvt Ltd|S|C|2|5|20250828|\n19RAVXE8412A1ZU|Evergreen Foods Pvt Ltd|A|C|d|a|20241213|c\n32HLFXN4295G1ZF|Neelgiri Electronics LLP|A|L|5|9|20240116|\n27NXMXS2900D1ZQ|Star Electronics Pvt Ltd|A|C|7|g|20230522|b\n23ZJCXE4413J1ZL|Evergreen Unisex Salon|A|P|6|7|20160706|u\n07HWVXG9744X1ZA|Green Leaf Physio Clinic|A|P|2|5|20250613|\n24CFMXN0481B1Z9|Neelgiri Hardware|A|P|3|j|20201110|f\n29YZGXN9588L1Z3|Neelgiri Foods LLP|A|L|4|1|20220322|c\n33DCMXP9653V1ZS|Pearl Opticals|A|P|a|4|20230515|\n27ADTXC6711G1Z2|City Foods|A|P|7|d|20180409|c\n24YLBXA5895E1Z8|Annapurna Unisex Salon|A|P|3|j|20180820|\n29INPXN0235P1ZO|New Tours & Travels|A|P|4|e|20230828|y\n33YLNXS1682M1ZD|Shree & Associates Pvt Ltd|A|C|a|3|20181119|7\n27RXYXB9017K1ZY|Balaji Realty LLP|A|L|7|g|20170409|\n03DJZXB8826C1ZN|Blue Lotus Bakers|A|P|8|c|20250105|3\n27DTPXA2631F1ZF|Apex Medicals|A|P|7|i|20230413|m\n27JCJXS3871G1ZI|Sai Design Studio|A|P|7|d|20210726|\n07YGWXZ5321F1ZQ|Zenith Medicals|A|P|2|5|20250110|\n27IYCXU6382J1Z4|Unity Medicals|A|P|7|g|20170326|m\n27ZANXH5718W1ZI|Harmony Woodcraft|A|P|7|i|20230828|\n29MPXXN1267D1ZN|Navkar Medicals|S|P|4|e|20220312|\n27ARIXA3864B1ZO|Annapurna Stays LLP|A|L|7|i|20240311|\n29JTSXR1594S1ZI|Riddhi Bake House|A|P|4|1|20160705|\n23TRSXT6803T1ZQ|Trinity Unisex Salon|A|P|6|7|20240903|\n36PHZXU3999T1ZH|Unity Stays LLP|A|L|b|6|20200516|6\n27AMWXV2790X1ZR|Vindhya Mobile Care|A|P|7|g|20211119|\n27UXFXN1230E1ZW|Neelgiri Bake House|A|P|7|i|20231021|\n27RCGXG5534M1ZG|Ganga Stays|A|P|7|d|20230517|6\n29KRCXB7811H1Z8|Blue Lotus Legal Associates|A|P|4|1|20180306|i\n27XBNXS8132O1ZP|Star Tours & Travels Pvt Ltd|A|C|7|d|20171020|y\n09WFIXS5784G1ZQ|Sahyadri Classes|A|P|c|b|20181107|8\n27WSHXP4177W1ZF|Pearl Opticals|A|P|7|g|20180326|k\n29SPJXB7358S1Z0|Blue Lotus Boutique|C|P|4|1|20190106|5\n33TBBXV2633Y1ZV|Vindhya Kitchens LLP|A|L|a|3|20220813|t\n23XMSXC6200X1ZE|Classic Boutique|A|P|6|2|20160728|\n29BCQXS9061T1ZM|Saffron Pharma Retail|A|P|4|1|20170928|n\n29KEJXM8154O1ZW|Modern Packaging Pvt Ltd|C|C|4|e|20220826|\n37PNLXK7848K1ZC|Kaveri Fashions Pvt Ltd|A|C|0|l|20211119|0\n27ALGXV4848J1ZY|Vindhya Classes Pvt Ltd|A|C|7|g|20230619|\n27VGIXN6876N1ZE|Neelgiri Mobile Care|A|P|7|i|20230508|j\n27NFFXA8598N1ZX|Amrit Bake House|C|P|7|i|20240903|4\n19QLTXR5555X1ZG|Riddhi General Store|A|P|d|a|20190917|\n10KJFXO9020K1ZN|Om General Store|A|P|1|h|20200314|h\n36LDTXA9874G1Z8|Amrit Bake House|A|P|b|6|20200402|\n27KAOXS0731M1ZI|Sahyadri Kids Academy Pvt Ltd|A|C|7|d|20170414|\n32JYAXG7619W1Z4|Ganesh Fitness|A|P|5|9|20180208|e\n08HMNXA2909Z1ZH|Annapurna Boutique|A|P|9|8|20240824|\n07AFPXS6711L1ZD|Silver Oak Hardware|A|P|2|5|20211117|\n27THFXE0532R1Z9|Evergreen Kitchens Pvt Ltd|A|C|7|f|20170402|\n36THCXV5037L1ZY|Vindhya Bake House|A|P|b|6|20171009|4\n29TYUXS9938G1Z8|Sunrise Stationers|C|P|4|1|20170121|\n27UKVXL6072U1ZT|Lakshmi Boutique|A|P|7|i|20211130|5\n08VPNXC7020Z1ZZ|Classic General Store|A|P|9|8|20220213|h\n24FPHXA3350N1ZG|Apex Pharma Retail LLP|A|L|3|k|20231210|n\n07TPCXP5809W1ZY|Pearl Bakers|A|P|2|5|20190604|\n07WFUXS4481J1ZJ|Sai Dental Care|A|P|2|5|20181120|\n19EOGXH4115Y1ZL|Harmony Dental Care|A|P|d|a|20220417|9\n10RZWXR3166F1Z8|Riddhi & Associates LLP|A|L|1|h|20200512|7\n27XRJXL1612B1Z7|Lakshmi Dental Care Pvt Ltd|A|C|7|f|20220310|\n27MXEXB2365U1Z6|Balaji Bakers|A|P|7|d|20211218|3\n37EATXP7074B1ZQ|Pearl Hardware|A|P|0|l|20220106|\n03KMMXC9003R1Z4|Coral & Associates LLP|A|L|8|c|20230715|\n33OURXS9360C1ZF|Star Fitness|A|P|a|3|20160528|e\n33WLGXG6886J1ZO|Ganesh Diagnostics|A|P|a|3|20160924|a\n09RSFXO8981J1ZZ|Orbit Fashions Pvt Ltd|A|C|c|b|20250117|\n23BRIXO4015L1ZB|Om Legal Associates LLP|A|L|6|2|20221107|\n36EVZXS9210X1ZD|Silver Oak Stays|A|P|b|6|20231029|6\n08ZGIXS9889T1ZI|Sunrise Diagnostics|A|P|9|8|20211206|\n27WXIXN4824D1ZF|Neelgiri Physio Clinic LLP|A|L|7|f|20220611|o\n24YGAXN7733E1ZI|Neelgiri & Associates Pvt Ltd|A|C|3|k|20191226|\n23FLHXH0502A1ZM|Harmony & Associates|A|P|6|7|20250708|7\n03FHFXK0912R1ZR|Krishna Diagnostics|A|P|8|c|20250404|\n08VXIXC3393E1ZJ|City Pharma Retail Pvt Ltd|A|C|9|8|20190818|\n27XUQXO1128E1ZI|Om Mobile Care|A|P|7|d|20210123|\n19SFMXC9651J1Z0|Coral Bakers|A|P|d|a|20210111|3\n29LXUXR6399T1ZR|Riddhi Medicals|A|P|4|1|20220315|\n27IRCXS3798J1ZE|Saffron Opticals|A|P|7|d|20170730|\n27YBRXS9651R1Z4|Sahyadri Textiles LLP|A|L|7|i|20221223|x\n27AKLXU3339W1ZE|Unity Packaging Pvt Ltd|C|C|7|d|20241025|\n24IZSXS4944K1ZW|Sahyadri Dental Care LLP|A|L|3|j|20231010|9\n24FOXXO5936Q1Z6|Orbit Kitchens|C|P|3|0|20241007|t\n23UCDXT7431Y1ZN|Trinity Opticals|A|P|6|7|20200904|k\n03DGCXA8486L1ZR|Amrit Tours & Travels|A|P|8|c|20181226|\n09NVLXN7920L1Z3|New Polymers|A|P|c|b|20170119|p\n29XUTXP6178J1ZF|Pearl Insurance Advisors Pvt Ltd|A|C|4|1|20210711|g\n27VOVXR0254U1ZQ|Riddhi Kids Academy|A|P|7|g|20200824|\n19MEZXA8085N1ZN|Amrit Unisex Salon|A|P|d|a|20210816|\n09PTDXV6195M1ZU|Vindhya Bakers|A|P|c|b|20220902|3\n33VYUXS0974G1ZV|Sunrise Mobile Care|A|P|a|3|20180226|\n27ABHXA4841V1ZM|Amrit Unisex Salon|A|P|7|d|20190209|u\n33RSUXV1205U1ZX|Vindhya Sweets|A|P|a|3|20210804|\n08EFJXS7378S1ZI|Silver Oak Stationers|A|P|9|8|20250116|\n27MXRXA7144H1ZI|Apex Kids Academy Pvt Ltd|A|C|7|f|20211215|q\n33MLXXO7582C1ZT|Orbit Diagnostics|A|P|a|3|20251101|\n33TYQXG2182E1ZL|Ganesh Auto Components Pvt Ltd|A|C|a|3|20160831|2\n23BQCXM6360W1ZN|Modern Diagnostics LLP|A|L|6|7|20191212|a\n33EQBXC1809N1ZK|City Physio Clinic Pvt Ltd|A|C|a|4|20211101|o\n33JITXG8350X1ZF|Ganga Opticals|A|P|a|4|20230802|\n10YFWXM8473Y1ZW|Modern Hardware|A|P|1|h|20171213|\n08GSGXL6365X1ZW|Lakshmi Hardware|A|P|9|8|20220801|f\n03BRLXA8605A1ZZ|Apex Tours & Travels|A|P|8|c|20240904|y\n32FVLXS1171T1ZA|Saffron Medicals|A|P|5|9|20220424|\n29WJAXB8201Q1Z1|Balaji Bakers|A|P|4|1|20250726|\n29MMXXE4084V1ZW|Evergreen Realty LLP|A|L|4|e|20241120|s\n36SGEXA0935O1ZH|Apex Unisex Salon|A|P|b|6|20201006|\n33NKMXS4589Y1ZR|Sai Mobile Care|A|P|a|3|20180801|\n10QDWXL8380W1ZF|Lakshmi Realty|A|P|1|h|20200711|s\n33WESXG3199S1ZH|Galaxy Stationers|A|P|a|3|20230811|v\n27MXRXS1292I1Z0|Sai Dental Care|A|P|7|f|20200602|9\n27FMIXG3993T1ZG|Ganga Mobile Care|A|P|7|d|20200413|\n29TOEXP7788F1Z9|Prime Foods LLP|A|L|4|e|20200317|c\n37UJCXO1578G1Z2|Orbit Diagnostics|A|P|0|l|20231006|a\n33SPSXR8287C1ZD|Riddhi Legal Associates Pvt Ltd|A|C|a|4|20210104|i\n29PYOXM4121Z1ZC|Modern Legal Associates LLP|A|L|4|1|20220305|\n29VHJXM1063E1ZE|Metro Insurance Advisors LLP|C|L|4|1|20211122|g\n03TTWXG6890N1ZU|Galaxy Fashions|A|P|8|c|20210508|0\n07CVBXK8638C1Z5|Kaveri Bakers|A|P|2|5|20180105|3\n27DLFXM1086O1Z3|Metro Electronics Pvt Ltd|A|C|7|f|20240520|\n27LRZXK1742R1Z0|Kaveri Opticals|A|P|7|d|20180420|k\n27MLYXA3532P1ZQ|Annapurna Design Studio Pvt Ltd|A|C|7|g|20220903|1\n27LZGXT4613G1ZH|Trinity Tours & Travels|A|P|7|g|20240511|y\n32UOSXG1123K1Z4|Ganesh Physio Clinic Pvt Ltd|A|C|5|9|20220121|\n36RHXXR8626O1Z4|Royal Tours & Travels Pvt Ltd|A|C|b|6|20180812|y\n27PPSXC4385B1ZZ|Classic Realty LLP|A|L|7|f|20191118|\n27NGGXM2160Q1Z6|Metro Unisex Salon|A|P|7|d|20241219|u\n27KHEXG8718M1Z7|Galaxy Bakers|A|P|7|d|20220715|3\n33GUPXP6046V1ZW|Prime Insurance Advisors LLP|A|L|a|3|20250502|g\n27MLXXE7540V1Z3|Evergreen Mobile Care|A|P|7|d|20220707|\n29YBEXO2976O1ZP|Om Mobile Care|A|P|4|e|20200612|j\n24GEHXS4238R1Z7|Shree Packaging|A|P|3|0|20251114|l\n33XFEXG4550L1ZH|Ganesh Boutique|A|P|a|4|20170504|5\n09BKIXK0855S1ZX|Kaveri Stays|A|P|c|b|20221212|\n07YOKXS1388E1ZJ|Star Fashions LLP|A|L|2|5|20180911|0\n03KLIXO0766T1ZQ|Om Realty|A|P|8|c|20191019|s\n27SZPXL4762D1Z5|Lakshmi Realty|A|P|7|f|20170926|s\n24UEEXR3868I1Z5|Royal Printers|A|P|3|j|20180327|r\n27VUBXV5871Q1ZL|Vindhya Bake House|A|P|7|g|20201209|\n09SFAXG9953J1Z4|Ganesh Electronics|A|P|c|b|20191027|b\n23ZVFXG6024A1Z8|Green Leaf Stays Pvt Ltd|A|C|6|7|20161208|\n32NVCXO9676P1ZX|Orbit Mobile Care|A|P|5|9|20200619|j\n27OSOXM0783U1ZR|Metro Printers|A|P|7|d|20230821|r\n07WCOXC8879J1ZT|City Sweets|A|P|2|5|20181014|w\n37COMXS4747V1Z0|Silver Oak Classes LLP|A|L|0|l|20210606|\n27YHAXS4176J1ZV|Sunrise Bakers|A|P|7|g|20191008|\n33KTYXR9187K1ZP|Royal Sweets|A|P|a|3|20200805|\n37FTSXM1881E1ZP|Metro Physio Clinic|A|P|0|l|20250801|o\n27SBJXO0489Q1ZU|Orbit Sweets|A|P|7|f|20161115|\n27HGAXM6360Q1Z8|Moonlight Polymers|A|P|7|i|20210917|\n29GWAXN4494M1Z8|Navkar Auto Components Pvt Ltd|A|C|4|1|20200726|2\n07DLRXV0769U1Z4|Vindhya Bakers|A|P|2|5|20250219|\n29KROXS4934D1ZL|Saffron Bakers|A|P|4|1|20200528|\n24UEXXS2542J1ZY|Sai Dental Care|A|P|3|j|20160713|9\n33ROKXN2697R1Z3|New Sweets|A|P|a|3|20220106|\n27VWGXN0263V1ZQ|New Stays Pvt Ltd|A|C|7|d|20221213|\n32RQYXL9419M1Z1|Lakshmi Medicals|A|P|5|9|20180908|\n29YEUXM7556N1Z5|Metro Hardware|A|P|4|1|20220818|f\n03KWWXK0823K1ZM|Krishna Fashions|A|P|8|c|20160625|\n24UUQXL1774X1ZF|Lakshmi Insurance Advisors Pvt Ltd|C|C|3|k|20190430|g\n03FPBXC3459W1ZW|Coral Stays LLP|A|L|8|c|20220613|6\n29UTEXM6011R1Z6|Metro & Associates|A|P|4|e|20160922|\n27AKOXP7565L1ZQ|Pearl Boutique|A|P|7|f|20201120|\n27AQMXC9224W1ZF|Coral Boutique|A|P|7|d|20221013|5\n36CBHXC2556Y1ZD|Coral Design Studio|A|P|b|6|20220919|\n29THTXO5273K1ZF|Om Kids Academy|A|P|4|1|20200719|\n07TIYXR3645F1ZP|Riddhi Boutique|A|P|2|5|20231102|\n10HDQXN3434W1Z7|Navkar Fashions|A|P|1|h|20240607|\n24TDLXS5010T1Z0|Sahyadri General Store|A|P|3|j|20250218|h\n27AXKXR0609U1Z5|Riddhi Kids Academy|A|P|7|d|20210113|\n32XPDXL8532K1ZQ|Lakshmi Realty Pvt Ltd|A|C|5|9|20240509|s\n27RUDXL3661V1ZV|Lakshmi Boutique|A|P|7|d|20201225|5\n19OYLXB8503C1ZT|Blue Lotus Bakers|A|P|d|a|20210207|\n37UYBXO7902P1ZU|Orbit Kitchens|A|P|0|l|20201217|\n24QDWXN6735X1Z7|New Medicals|A|P|3|k|20210120|\n27OYTXS7158C1ZY|Saffron Stays Pvt Ltd|A|C|7|i|20240817|\n27TRLXB6106N1ZN|Blue Lotus Mobile Care|A|P|7|g|20240323|j\n19DKMXR7736B1Z8|Royal Printers LLP|A|L|d|a|20241227|r\n33CAVXS8657U1ZL|Sai Dental Care|A|P|a|3|20251026|9\n24ZYLXO7536Z1ZW|Orbit Unisex Salon|A|P|3|0|20210425|\n29EJIXM5276A1ZK|Moonlight Dental Care Pvt Ltd|A|C|4|1|20250928|9\n27IOSXS1504M1ZQ|Sunrise Tours & Travels|A|P|7|g|20240426|\n08GFUXN8493D1Z3|Neelgiri Dental Care LLP|A|L|9|8|20210419|\n07HALXL6190X1ZU|Lakshmi Hardware|A|P|2|5|20241114|\n29MXBXB2626J1ZV|Blue Lotus Bakers|A|P|4|1|20180627|3\n03MTAXO0307A1ZY|Om Classes|A|P|8|c|20180323|\n29NHSXM6690S1Z1|Metro Kids Academy Pvt Ltd|A|C|4|1|20170130|q\n24CDZXU0361A1Z0|Unity Diagnostics|A|P|3|k|20220607|a\n27TMCXN8481W1ZU|New Boutique|A|P|7|i|20160605|\n33JEXXN2129X1ZO|Neelgiri Kids Academy Pvt Ltd|C|C|a|4|20180401|\n29DZZXP3536B1ZC|Prime Stays Pvt Ltd|A|C|4|1|20181118|6\n19FPMXH4065P1ZL|Harmony Electronics LLP|A|L|d|a|20230922|b\n37RUPXH2006L1ZL|Harmony Hardware|A|P|0|l|20220317|f\n24KRVXA4713M1ZU|Annapurna Fashions LLP|A|L|3|0|20210706|0\n24HDRXN1811V1Z6|New Opticals|A|P|3|k|20230819|\n10ENKXS0915L1ZG|Sunrise Legal Associates Pvt Ltd|A|C|1|h|20250122|i\n32GLNXA0313H1Z8|Annapurna Stays Pvt Ltd|A|C|5|9|20180425|6\n23ELCXG1775Y1ZV|Ganesh Kids Academy Pvt Ltd|A|C|6|7|20170309|\n09GOQXK1317K1Z1|Krishna Sweets|A|P|c|b|20210324|w\n24JBZXS4404X1ZO|Star Physio Clinic|A|P|3|0|20200608|o\n09HKJXR1000O1ZC|Riddhi Classes Pvt Ltd|A|C|c|b|20161025|8\n29ZXSXG3857C1Z0|Ganga Diagnostics|A|P|4|1|20231216|a\n37COKXS2099U1Z3|Silver Oak Medicals|A|P|0|l|20170803|\n23WYMXS5787Q1Z5|Shree Auto Components Pvt Ltd|A|C|6|7|20240401|2\n36ZYBXG7001B1Z2|Green Leaf Hardware|A|P|b|6|20180715|f\n29YNGXC7540D1Z3|City Stays Pvt Ltd|A|C|4|1|20240613|\n33CDEXC4941N1Z3|City Design Studio|A|P|a|4|20200306|1\n36UAEXC4045X1Z6|Coral Unisex Salon|A|P|b|6|20231028|\n29UJGXR9780M1Z3|Royal Medicals|A|P|4|1|20240215|m\n29HIOXG6546R1ZL|Ganesh Hardware|A|P|4|e|20160902|\n27VLIXP1741L1ZR|Pearl Tours & Travels Pvt Ltd|A|C|7|f|20220607|y\n23EKUXS3927I1Z1|Saffron Boutique|A|P|6|7|20250102|5\n33FJSXS5707S1ZL|Silver Oak Kids Academy|A|P|a|4|20250807|q\n07UFMXS2391F1Z5|Shree Opticals|A|P|2|5|20250505|\n24DTZXC4381L1ZL|City Mobile Care|A|P|3|0|20181225|\n29XEQXU6887B1ZJ|Unity Fashions|A|P|4|e|20171109|0\n27HZRXA3108I1ZS|Annapurna Unisex Salon|A|P|7|i|20180626|\n09LRVXC2741A1Z8|City Packaging|A|P|c|b|20250719|l\n29PSRXA0739Z1ZP|Amrit Insurance Advisors Pvt Ltd|C|C|4|1|20220720|g\n27WOCXU7640P1Z3|Unity Hardware|A|P|7|i|20220822|\n08OZYXA3516V1ZK|Apex Fashions|A|P|9|8|20250130|0\n08MXZXG6151T1ZI|Green Leaf Sweets|A|P|9|8|20180212|\n29UXNXE3700Z1ZJ|Evergreen Fashions Pvt Ltd|A|C|4|1|20240622|0\n29RDXXT8328E1ZR|Trinity Mobile Care|A|P|4|1|20250609|j\n27DQQXS9002D1Z3|Sahyadri Stays Pvt Ltd|A|C|7|i|20191025|\n27PDOXO2285N1ZW|Om Hardware|A|P|7|f|20230801|f\n29FOWXK3428L1ZK|Krishna Opticals|A|P|4|1|20240811|\n27HMFXK0471P1Z2|Krishna Bakers|A|P|7|i|20191228|\n24XJIXN6745B1Z8|Navkar Fashions|A|P|3|0|20161019|0\n24XAQXG5424O1Z9|Green Leaf Stationers|A|P|3|j|20201102|\n33GTZXB8812I1ZQ|Balaji Legal Associates Pvt Ltd|A|C|a|4|20180422|i\n24QKNXK7162V1Z9|Krishna General Store|A|P|3|k|20231028|\n36ARSXL3083T1Z8|Lakshmi Unisex Salon|A|P|b|6|20200219|\n19PZLXG3531O1Z2|Ganesh Hardware|A|P|d|a|20170513|\n27EEOXG7830E1ZV|Green Leaf Medicals|A|P|7|f|20250612|\n07NWJXG9571T1ZN|Galaxy Auto Components LLP|A|L|2|5|20170911|2\n29ECZXS4400X1ZL|Silver Oak Medicals|C|P|4|1|20190831|\n29KPLXN8097J1Z6|Neelgiri Sweets|A|P|4|1|20240703|\n29EIXXN8585H1ZI|Navkar Dental Care LLP|A|L|4|e|20170517|\n23IPVXB5454W1Z9|Balaji Dental Care|A|P|6|2|20240422|9\n32WEYXH5611L1Z5|Harmony Fitness Pvt Ltd|A|C|5|9|20180926|e\n27WTYXR2928W1ZZ|Royal Bake House Pvt Ltd|A|C|7|f|20190504|\n27CHKXH1534I1ZW|Harmony Fashions Pvt Ltd|A|C|7|d|20190911|0\n24VAYXA4588R1ZO|Annapurna Stays|A|P|3|k|20220917|\n10NVNXB7999W1ZL|Balaji Sweets|A|P|1|h|20190202|\n37FZYXG7322K1Z4|Ganga Polymers Pvt Ltd|A|C|0|l|20241205|p\n32FHPXT6817T1ZN|Trinity Insurance Advisors|S|P|5|9|20181105|g\n03LWLXV1654O1Z6|Vindhya Realty LLP|A|L|8|c|20231026|\n33NZWXK6489N1ZE|Kaveri Kids Academy LLP|A|L|a|3|20240710|q\n19HKCXM2027R1Z4|Moonlight General Store|A|P|d|a|20231111|h\n07IOUXO8155K1ZD|Om Insurance Advisors Pvt Ltd|A|C|2|5|20211128|g\n27RUBXM9961C1ZK|Modern Unisex Salon|A|P|7|i|20230618|\n24WCOXS9041K1ZZ|Sunrise Design Studio|A|P|3|0|20240706|\n07ZADXE6343D1Z1|Evergreen Hardware|A|P|2|5|20170506|f\n29QNZXH5349Q1ZT|Harmony Hardware|A|P|4|1|20190228|\n27LJDXV4464O1ZO|Vindhya Mobile Care|A|P|7|f|20200806|\n09BWBXL0456Y1Z6|Lakshmi General Store|A|P|c|b|20250309|h\n36XRPXS2508O1ZZ|Saffron Fitness|A|P|b|6|20251019|e\n07NATXT5683C1ZB|Trinity Medicals|A|P|2|5|20190618|\n24LXBXA5553K1ZX|Amrit Sweets|A|P|3|j|20190814|\n29BUDXA6700N1Z4|Apex Dental Care LLP|A|L|4|1|20220105|\n24IEJXS6431N1ZC|Saffron Insurance Advisors LLP|A|L|3|k|20180305|\n36BHWXG2194J1ZB|Ganesh Hardware|A|P|b|6|20210523|\n27JJQXS8675O1Z3|Shree Unisex Salon|A|P|7|d|20220312|\n27PWFXS4296B1ZG|Sunrise Unisex Salon|A|P|7|d|20220907|u\n27WGQXH5491Y1ZW|Harmony Unisex Salon|A|P|7|d|20210507|u\n27WKNXA8453I1ZT|Amrit Stationers|A|P|7|g|20200219|\n33EMNXM0163C1ZW|Modern Foods Pvt Ltd|C|C|a|3|20220725|c\n36ZYXXT7593E1Z8|Trinity Hardware|A|P|b|6|20210102|\n33CSBXS5956D1Z7|Star Mobile Care|A|P|a|4|20200227|\n19DCGXR2504T1ZE|Royal Unisex Salon|A|P|d|a|20200605|\n07JFVXV0728Z1Z6|Vindhya Medicals|A|P|2|5|20221127|\n32YMGXG9435W1Z5|Green Leaf Unisex Salon|A|P|5|9|20211112|u\n07LIOXS7139K1ZQ|Star Kitchens Pvt Ltd|A|C|2|5|20240215|t\n27TWYXP8491D1ZN|Prime Opticals|A|P|7|d|20210209|\n27LFPXT1320K1ZE|Trinity Boutique|A|P|7|d|20170730|\n37XVEXO7061C1ZJ|Orbit Bakers|A|P|0|l|20160930|3\n37XLLXN9447X1ZG|Navkar Kids Academy Pvt Ltd|A|C|0|l|20241005|q\n10HSEXP3392H1Z8|Pearl Printers|A|P|1|h|20250903|r\n07QDEXG0585W1ZY|Galaxy & Associates|A|P|2|5|20240219|7\n36ZYRXV1920K1ZO|Vindhya Hardware|A|P|b|6|20220312|f\n32NXTXS4664W1Z8|Star Legal Associates Pvt Ltd|A|C|5|9|20221212|i\n24VIEXM1314F1ZU|Metro Kitchens|A|P|3|0|20181011|\n27BFFXM6333X1Z0|Metro Auto Components|A|P|7|d|20221016|\n33NFJXK0761R1Z9|Kaveri Medicals|A|P|a|3|20181012|\n24OGOXM8326D1ZI|Metro Boutique|A|P|3|j|20241016|\n03AYOXP8999L1ZS|Prime Design Studio Pvt Ltd|A|C|8|c|20190705|1\n29OYGXM0874T1ZL|Moonlight Textiles|A|P|4|1|20160531|x\n07ZPZXG0099O1ZU|Green Leaf Design Studio LLP|A|L|2|5|20160909|\n09CXPXL5712J1ZI|Lakshmi Woodcraft LLP|A|L|c|b|20190225|d\n09TLZXT7817G1Z4|Trinity Legal Associates|A|P|c|b|20250104|\n10QRWXO3894G1ZF|Om Electronics|A|P|1|h|20160721|b\n36RDIXM7233O1Z3|Modern Medicals|A|P|b|6|20230516|\n07KNZXG6475P1Z3|Green Leaf Insurance Advisors|A|P|2|5|20231030|g\n37JMKXG2057Q1ZU|Galaxy Mobile Care|A|P|0|l|20170908|j\n27JEIXM5783X1ZF|Metro Bakers|A|P|7|d|20230806|\n27SMFXE7544V1Z9|Evergreen Realty|C|P|7|d|20240829|\n27OBWXR8437K1ZQ|Royal Legal Associates|A|P|7|d|20191215|\n33HEEXE9230N1ZU|Evergreen Polymers|A|P|a|4|20160710|p\n33FJQXG2244N1ZF|Galaxy Polymers Pvt Ltd|A|C|a|3|20240828|p\n27QUNXA9618K1ZA|Apex Design Studio|A|P|7|f|20200209|1\n27XBDXA6223A1ZE|Amrit Opticals|A|P|7|i|20161015|k\n08TEYXC5610Q1ZV|Coral Hardware|C|P|9|8|20200303|\n32NCRXO4594R1ZQ|Om Tours & Travels Pvt Ltd|A|C|5|9|20210808|\n27RGHXB2314Q1ZG|Blue Lotus Sweets|A|P|7|i|20221031|\n33QHCXL0433G1Z2|Lakshmi Stays|A|P|a|4|20171024|\n24RFNXG9854Y1Z6|Green Leaf Legal Associates|A|P|3|j|20210323|\n03KBFXK7547Z1ZX|Kaveri Legal Associates LLP|A|L|8|c|20240821|i\n24MKUXV5202R1ZI|Vindhya Stays|A|P|3|j|20240129|6\n19CJOXP3483P1ZM|Pearl Medicals|A|P|d|a|20181028|\n07HDPXU4584M1ZV|Unity Bake House Pvt Ltd|A|C|2|5|20210206|\n29KVXXU0690B1Z9|Unity Dental Care LLP|A|L|4|1|20250408|\n24NSOXL8313M1ZH|Lakshmi General Store|A|P|3|k|20250816|h\n24DUYXB8413U1Z6|Blue Lotus Mobile Care|A|P|3|0|20230903|\n36ZRJXA0984E1ZU|Amrit Electronics|A|P|b|6|20220815|b\n24PSBXO9440Z1ZT|Om Legal Associates Pvt Ltd|A|C|3|0|20200823|i\n27DVFXG2484X1Z3|Green Leaf Mobile Care|S|P|7|d|20250606|\n27YOEXA0032S1ZX|Amrit Physio Clinic|A|P|7|f|20171111|o\n27QSCXG2281O1ZM|Ganga Unisex Salon|A|P|7|d|20200812|\n24RMIXE4694I1ZY|Evergreen Packaging Pvt Ltd|A|C|3|k|20230620|\n29TWWXK9615G1ZS|Kaveri General Store|C|P|4|1|20240404|\n19LRBXP4315K1ZV|Prime Boutique|A|P|d|a|20250106|5\n29VXPXA6650E1ZC|Apex Fashions Pvt Ltd|S|C|4|1|20160604|0\n27BLXXH4423Y1ZD|Harmony Kitchens|A|P|7|g|20240122|\n07FPDXA9295V1ZC|Annapurna Classes|A|P|2|5|20201121|8\n23WWHXS7493D1Z6|Star General Store|A|P|6|2|20190128|h\n32VEKXR8099M1ZK|Riddhi Unisex Salon|A|P|5|9|20191122|u\n27WKXXS1964F1ZE|Silver Oak General Store|A|P|7|f|20220925|h\n32CNEXM4739T1ZU|Moonlight Dental Care|A|P|5|9|20211206|9\n24BWKXZ9430O1Z3|Zenith Textiles LLP|A|L|3|k|20160809|x\n24OPXXC3889I1ZF|City Kitchens|A|P|3|j|20240612|t\n32EJOXP7826S1ZN|Prime Fitness Pvt Ltd|A|C|5|9|20200919|e\n33AETXO3787E1ZL|Om & Associates LLP|A|L|a|3|20220203|\n33DYYXG1368R1Z0|Ganga Classes Pvt Ltd|A|C|a|4|20170423|\n23RKCXC2631X1Z1|City Printers|A|P|6|7|20210201|r\n07ISFXK8366I1ZN|Kaveri Tours & Travels LLP|A|L|2|5|20250726|y\n29FTZXG2691A1ZR|Galaxy Stationers|A|P|4|1|20250830|\n29WVQXG0972K1ZY|Ganga Polymers|A|P|4|1|20180221|p\n24YARXM5029J1ZA|Moonlight Design Studio|A|P|3|0|20190819|1\n33DBTXL9622D1ZZ|Lakshmi Tours & Travels Pvt Ltd|A|C|a|3|20241028|y\n27YMTXS7639V1Z7|Saffron Realty|A|P|7|i|20180609|\n27WYDXE6813K1ZB|Evergreen Kitchens|A|P|7|i|20160804|\n27LVLXT7932N1ZT|Trinity Realty|A|P|7|d|20230207|s\n29OESXO4166Q1ZH|Om Pharma Retail|A|P|4|e|20160902|n\n33BRLXK6986F1ZW|Krishna Pharma Retail Pvt Ltd|A|C|a|3|20180319|n\n24NZAXB8697R1ZU|Blue Lotus Fashions|A|P|3|k|20170920|0\n08YIBXS1075G1Z6|Silver Oak & Associates Pvt Ltd|A|C|9|8|20161015|\n27DGVXG5294I1Z6|Galaxy Classes LLP|A|L|7|d|20251002|\n24TAHXO2877F1ZM|Orbit General Store|A|P|3|k|20180824|h\n08KORXH1384D1Z5|Harmony Boutique|A|P|9|8|20171022|\n37QQZXO1943A1ZO|Orbit Mobile Care|S|P|0|l|20201027|\n33LFZXR0426Y1ZG|Riddhi Unisex Salon|A|P|a|3|20240713|u\n24ULRXO0224M1ZW|Om Sweets|C|P|3|0|20250905|\n03AJNXM0356S1Z9|Modern Electronics|S|P|8|c|20230227|b\n07LQBXS0400Z1ZJ|Sunrise Physio Clinic LLP|A|L|2|5|20230107|\n19UBXXK0340V1ZN|Kaveri Bakers|A|P|d|a|20201030|3\n07PALXT2460N1Z9|Trinity Diagnostics LLP|A|L|2|5|20160610|\n19CTXXA4286Q1Z3|Annapurna Stays Pvt Ltd|A|C|d|a|20170720|6\n27HNSXR1052U1ZB|Royal Mobile Care|A|P|7|f|20221231|\n32KIAXA7536J1ZV|Annapurna Dental Care|A|P|5|9|20200317|\n37IPFXM9396M1Z8|Moonlight Boutique|A|P|0|l|20171104|\n24FLAXK8996S1ZH|Kaveri Bakers|A|P|3|k|20210131|3\n19QAAXO4433H1ZV|Orbit & Associates|A|P|d|a|20170326|\n36PFCXN2679J1Z8|Navkar Bakers|A|P|b|6|20170119|\n19RAJXS6789T1Z5|Sahyadri Pharma Retail|A|P|d|a|20230308|n\n32BGOXN6640G1ZU|Neelgiri Legal Associates|A|P|5|9|20200916|i\n07FUYXB9940F1ZL|Balaji Kitchens|A|P|2|5|20170530|t\n23IDDXA1833A1ZZ|Amrit General Store|A|P|6|7|20210115|\n32RPGXB0719D1ZT|Balaji Boutique|A|P|5|9|20220221|\n24YXSXH5984V1ZZ|Harmony Legal Associates LLP|A|L|3|k|20251116|\n27RCHXU6940M1ZX|Unity Packaging|C|P|7|d|20210907|\n23NZSXN7517J1Z1|Neelgiri Kitchens|A|P|6|7|20181104|t\n36WHGXR3759I1ZS|Royal Woodcraft Pvt Ltd|A|C|b|6|20171028|d\n29XGPXA2838W1ZA|Apex Physio Clinic Pvt Ltd|S|C|4|1|20180313|\n07DWSXA4637T1Z5|Annapurna Kids Academy Pvt Ltd|A|C|2|5|20160915|\n24DTFXP9030K1ZY|Pearl Design Studio Pvt Ltd|A|C|3|k|20220814|\n08XHVXM1745X1ZW|Moonlight Hardware|A|P|9|8|20170316|\n32HJMXG0864Q1Z7|Ganga Tours & Travels Pvt Ltd|A|C|5|9|20200706|\n07SNXXV9349V1Z3|Vindhya Tours & Travels Pvt Ltd|A|C|2|5|20221104|y\n23LEJXS9215W1ZP|Shree Diagnostics|A|P|6|7|20210924|a\n27ZSQXC6277K1ZZ|Coral Legal Associates|A|P|7|f|20220719|i\n29NTKXM6465R1ZP|Metro Bakers|A|P|4|1|20181105|3\n37GCAXB6355H1Z7|Blue Lotus Boutique|S|P|0|l|20231028|\n09JAXXN1947F1ZG|New Stationers|C|P|c|b|20221128|v\n33TCHXS2113K1ZR|Sai Fitness Pvt Ltd|A|C|a|3|20230716|e\n37YMLXA1903X1ZD|Apex Tours & Travels Pvt Ltd|A|C|0|l|20220424|y\n23AQUXH8683O1ZD|Harmony Bake House|A|P|6|2|20200219|4\n33SQDXS1118A1ZL|Saffron Textiles|A|P|a|3|20241118|x\n27QRSXG8579N1ZP|Galaxy Woodcraft Pvt Ltd|A|C|7|i|20210514|d\n37AXUXS5391M1ZS|Saffron Tours & Travels LLP|A|L|0|l|20201126|y\n27PZFXP8382E1Z4|Pearl Legal Associates|A|P|7|g|20190724|i\n24WENXP8841K1ZT|Prime Physio Clinic|A|P|3|0|20220302|o\n07TFDXM6438Z1ZC|Moonlight Physio Clinic Pvt Ltd|C|C|2|5|20201220|\n24LADXP6755Z1ZR|Pearl Stays Pvt Ltd|A|C|3|0|20211014|\n03VGVXS2093T1Z9|Sai Legal Associates|A|P|8|c|20180227|i\n27WTDXO4061I1ZJ|Orbit Diagnostics LLP|A|L|7|i|20200918|\n07TXKXH1426U1ZX|Harmony Diagnostics|A|P|2|5|20170216|a\n19YVZXP6963C1ZL|Prime Realty|A|P|d|a|20230101|\n07YVFXK5007Z1ZN|Krishna Tours & Travels LLP|A|L|2|5|20200604|y\n27ZJBXK1087U1ZE|Kaveri Fitness|A|P|7|d|20240210|e\n27KAWXM8236D1ZJ|Moonlight Pharma Retail LLP|A|L|7|g|20200905|n\n36ERNXM8997V1ZF|Modern Opticals|A|P|b|6|20250609|\n24GRTXE5093K1ZP|Evergreen Kids Academy|A|P|3|0|20210621|q\n27JJYXB7611K1Z2|Balaji General Store|A|P|7|i|20200616|\n07YZGXS3567J1ZP|Sunrise Fashions LLP|A|L|2|5|20181220|\n07RLCXR2881X1Z2|Royal Opticals|A|P|2|5|20180910|\n29MLOXN9604T1Z2|New Opticals|A|P|4|1|20180420|\n23VHGXS5545I1Z3|Silver Oak Design Studio LLP|A|L|6|7|20160926|1\n24AAMXA4159F1ZJ|Amrit Insurance Advisors|A|P|3|k|20240419|\n33CAVXZ9583S1ZF|Zenith Fashions LLP|A|L|a|4|20210524|0\n08CLZXC8961R1ZA|Classic Diagnostics|A|P|9|8|20190723|a\n33FFSXV9392S1ZA|Vindhya Printers|A|P|a|4|20250802|r\n19CSUXC5874G1ZN|Coral Unisex Salon|A|P|d|a|20160824|\n03VDQXN5493P1ZN|Neelgiri Design Studio Pvt Ltd|A|C|8|c|20211020|1\n19RHTXS6926J1ZE|Silver Oak Insurance Advisors LLP|A|L|d|a|20231024|g\n37LUPXP5169U1ZF|Prime General Store|A|P|0|l|20200324|\n10MBEXN5162L1ZZ|Navkar Boutique|S|P|1|h|20240813|5\n33OOAXG2169D1ZP|Ganesh Bakers|A|P|a|3|20201020|\n08KTTXT6680L1ZR|Trinity Kitchens|A|P|9|8|20250807|\n19AZJXS9180X1Z8|Sunrise Stationers|A|P|d|a|20240311|\n19IWPXO4462U1ZJ|Om General Store|A|P|d|a|20170805|\n09AKDXR3323B1Z2|Riddhi Fitness LLP|A|L|c|b|20251128|e\n29TCSXO5855T1Z4|Om Classes|A|P|4|1|20251011|8\n23DGVXG1870K1ZK|Ganesh Stationers|A|P|6|7|20170727|\n03DBFXA2295J1ZF|Annapurna Physio Clinic LLP|A|L|8|c|20190928|o\n27ZBFXG7549V1ZI|Green Leaf Pharma Retail|C|P|7|d|20161231|\n36MHNXB7617U1ZQ|Blue Lotus & Associates|A|P|b|6|20220606|\n27VMHXZ1160P1ZB|Zenith Physio Clinic LLP|A|L|7|i|20190315|o\n10OUQXG5491K1ZJ|Ganesh Design Studio|A|P|1|h|20170425|\n33OORXM3233W1Z8|Metro Classes|A|P|a|4|20200921|\n29AMDXC5075M1ZB|City General Store|A|P|4|e|20220217|\n19FIIXL2548O1Z1|Lakshmi Boutique|A|P|d|a|20221102|\n29LVUXC4459O1ZV|Classic Mobile Care|A|P|4|1|20221016|j\n24HINXT5075F1ZA|Trinity Kids Academy|A|P|3|0|20190625|q\n23GSLXU1091X1Z1|Unity Diagnostics Pvt Ltd|A|C|6|7|20160913|a\n27AGKXB7534C1Z7|Balaji Stationers|A|P|7|d|20200821|\n23KXSXK9928X1Z8|Krishna Diagnostics|A|P|6|7|20191023|a\n36YLAXS8575F1ZL|Sunrise Stationers|A|P|b|6|20201229|v\n09CFCXM9900E1Z0|Moonlight Classes LLP|A|L|c|b|20250827|8\n07OXYXC9915F1Z6|City Bakers|A|P|2|5|20180903|\n07BRIXA9308I1ZB|Amrit Diagnostics|A|P|2|5|20230403|\n07LTZXZ5985H1ZJ|Zenith & Associates Pvt Ltd|A|C|2|5|20161228|7\n27ZFOXN3770L1ZN|Neelgiri Medicals|A|P|7|i|20200806|\n27SNOXC7002F1ZC|Classic Stays|A|P|7|g|20230818|6\n27NBXXB6030B1Z4|Balaji Stays|A|P|7|i|20230306|6\n33KDXXK9324J1Z9|Krishna Foods|A|P|a|4|20240520|c\n23IURXM5608U1Z0|Metro Hardware|A|P|6|7|20211006|f\n36QDNXC5675T1ZP|Classic Dental Care|A|P|b|6|20180113|9\n27JCZXC9111C1ZX|Classic Fitness LLP|A|L|7|f|20240730|e\n29LNMXS8071Z1ZH|Sai Textiles Pvt Ltd|A|C|4|1|20171111|x\n37ZHAXU3353D1ZB|Unity Bake House Pvt Ltd|A|C|0|l|20250716|4\n23ZDEXN9382P1ZP|New Bakers|A|P|6|2|20250716|\n24ZGZXV9818V1ZF|Vindhya Bakers|A|P|3|j|20230218|3\n03GMLXB3098J1ZF|Balaji General Store|A|P|8|c|20191023|h\n19JQNXK8916B1ZW|Krishna Physio Clinic|A|P|d|a|20171108|o\n29XJYXA0827G1ZY|Annapurna Electronics LLP|A|L|4|1|20230709|b\n33CTJXG1191X1ZH|Ganga Unisex Salon|A|P|a|4|20220718|\n24HAFXC2880A1ZR|Classic Bake House|A|P|3|k|20220622|4\n10FJYXR3855Z1Z5|Riddhi Dental Care LLP|A|L|1|h|20200211|\n29ETWXO0131W1ZZ|Om Insurance Advisors LLP|A|L|4|1|20180525|\n36LJLXP9575W1ZT|Prime Hardware|A|P|b|6|20160626|\n32GSAXK3883Q1ZP|Krishna Design Studio|A|P|5|9|20230824|1\n29NFXXT0330H1Z7|Trinity Bake House Pvt Ltd|A|C|4|e|20210904|4\n36XRRXH9868L1ZL|Harmony Fitness|A|P|b|6|20180910|\n24QYQXU8248G1ZU|Unity Bakers|A|P|3|j|20180814|3\n27EAKXO2517V1ZA|Om Packaging LLP|A|L|7|g|20240818|\n33DMIXR3947I1Z6|Royal Polymers|A|P|a|4|20180208|\n07YZYXH6477Y1ZH|Harmony Printers Pvt Ltd|A|C|2|5|20180716|r\n27ZYDXS2258F1Z6|Shree Stays|A|P|7|f|20181026|\n32KAZXG7394V1ZL|Galaxy Design Studio Pvt Ltd|A|C|5|9|20220818|1\n27FOUXV5837I1ZC|Vindhya Classes LLP|A|L|7|d|20230615|\n19AZYXC0617H1ZQ|Coral & Associates|A|P|d|a|20210610|7\n08FMFXS1153M1Z5|Sunrise Unisex Salon|A|P|9|8|20250818|u\n27BNQXN4466V1Z5|Neelgiri Fashions Pvt Ltd|A|C|7|d|20220903|\n24LUWXS4060M1Z4|Sai Unisex Salon|A|P|3|0|20201009|\n23BCNXN2063X1ZA|New Electronics|A|P|6|7|20220317|b\n10IZJXM5708P1ZE|Metro Kids Academy|A|P|1|h|20241016|\n27MZGXS6880I1ZV|Star Realty LLP|A|L|7|d|20200826|\n27FIVXE2763I1Z9|Evergreen Hardware|A|P|7|f|20180121|f\n24VNYXT4576S1ZG|Trinity Fashions LLP|A|L|3|k|20210111|0\n24LOSXP9060P1Z7|Pearl Unisex Salon|A|P|3|k|20241207|\n07HPAXS1241D1ZQ|Shree Classes LLP|A|L|2|5|20230811|8\n24VWPXC5318F1ZP|City Textiles Pvt Ltd|C|C|3|k|20190106|\n23BBDXR7966O1ZE|Royal Unisex Salon|A|P|6|2|20191010|u\n10ELDXM8607K1ZM|Metro Unisex Salon|A|P|1|h|20161210|\n27LJJXO6965J1ZP|Om Unisex Salon|A|P|7|i|20220111|u\n08ZLJXP0337W1Z2|Prime Sweets|A|P|9|8|20231024|w\n33OFXXP6482I1ZT|Pearl Hardware|A|P|a|3|20220118|\n10ZLZXO6761T1ZS|Orbit Bake House Pvt Ltd|A|C|1|h|20170825|4\n09CKNXG1586E1ZI|Green Leaf Realty Pvt Ltd|A|C|c|b|20230711|\n10YETXC2127S1Z8|Coral Tours & Travels Pvt Ltd|A|C|1|h|20200614|\n27QJLXS9166O1Z5|Saffron Dental Care|A|P|7|f|20170228|\n27ELSXS0539U1ZB|Shree Classes|A|P|7|g|20170516|8\n07YJXXS6557M1ZU|Star & Associates|C|P|2|5|20210327|7\n33FBVXG1967P1ZB|Galaxy Mobile Care|A|P|a|3|20240530|j\n29QXQXN7720L1ZR|New Bakers|A|P|4|1|20250103|3\n07BWEXS6322L1ZP|Saffron Hardware|A|P|2|5|20181231|f\n19WSCXV9888L1ZD|Vindhya Unisex Salon|A|P|d|a|20240522|\n19FNWXM5205F1Z3|Modern Boutique|A|P|d|a|20190117|5\n33REZXA8145A1ZQ|Amrit Tours & Travels|A|P|a|3|20170109|y\n27XQOXG2361E1ZV|Green Leaf Tours & Travels Pvt Ltd|A|C|7|f|20220309|y\n07TPKXP9064S1ZR|Prime Mobile Care|A|P|2|5|20191119|\n23WTVXT9752A1Z5|Trinity Insurance Advisors|A|P|6|2|20220809|\n24TGGXG1437I1ZQ|Galaxy Tours & Travels Pvt Ltd|A|C|3|k|20230511|y\n24DOUXC1892R1ZM|City & Associates Pvt Ltd|A|C|3|k|20211030|7\n27OXJXM3538A1ZS|Moonlight Fashions Pvt Ltd|A|C|7|d|20220419|0\n08VBUXS4221K1Z2|Silver Oak General Store|A|P|9|8|20181121|h\n33AEEXC4227G1ZN|Coral Unisex Salon|A|P|a|3|20210912|u\n03NOJXK1590I1Z6|Krishna Fitness LLP|A|L|8|c|20231226|e\n09BDSXT6451P1ZV|Trinity Diagnostics Pvt Ltd|A|C|c|b|20181002|a\n03UFDXM5300H1Z1|Metro Bake House Pvt Ltd|C|C|8|c|20190217|\n33KHQXP2619U1ZP|Prime Legal Associates Pvt Ltd|A|C|a|3|20160606|\n23OVHXO4722K1ZN|Orbit Diagnostics|A|P|6|2|20241107|a\n33CGBXM3704L1Z3|Moonlight Diagnostics|A|P|a|4|20220920|\n27NZXXR3695O1Z3|Royal Opticals|A|P|7|f|20230924|\n29POLXS2457B1ZV|Sai Auto Components Pvt Ltd|A|C|4|1|20200818|2\n37KTMXN0098U1ZT|New Classes Pvt Ltd|A|C|0|l|20160801|8\n27OSEXB3108T1ZP|Blue Lotus Auto Components LLP|A|L|7|i|20240928|\n33XVNXG2727V1ZS|Ganga Hardware|A|P|a|3|20241108|\n19YIBXS8513E1Z2|Sahyadri Unisex Salon|S|P|d|a|20240115|u\n36NNJXA8618E1ZB|Annapurna Unisex Salon|A|P|b|6|20200501|\n03GHVXK9021T1ZW|Kaveri Electronics|A|P|8|c|20180501|\n10ITIXS8110X1ZB|Saffron Medicals|A|P|1|h|20180122|\n24NRSXN8802W1ZR|New Legal Associates Pvt Ltd|A|C|3|0|20161122|\n24HKLXC0416Q1ZJ|Coral Pharma Retail|A|P|3|k|20241014|\n27KFXXS3468X1ZX|Saffron Hardware|A|P|7|f|20250426|\n09MHZXN6048T1Z2|New Physio Clinic Pvt Ltd|A|C|c|b|20230202|o\n19YAXXS7449V1ZP|Sunrise Insurance Advisors|A|P|d|a|20230115|g\n08NDCXR5965G1ZD|Royal Boutique|A|P|9|8|20180603|5\n29PAVXS1957G1Z1|Saffron Tours & Travels|A|P|4|1|20200915|\n29VNDXS7302I1ZQ|Silver Oak Fashions Pvt Ltd|A|C|4|1|20161218|\n23AQPXA2216I1ZS|Apex Kitchens Pvt Ltd|A|C|6|7|20170929|t\n27EESXO9180S1ZJ|Om Realty|A|P|7|d|20210131|\n07LOIXN7586F1ZP|Neelgiri Unisex Salon|A|P|2|5|20250920|\n27FAOXS8414Q1Z3|Shree Pharma Retail|A|P|7|i|20240311|n\n27WDRXG4296X1Z3|Green Leaf Realty|A|P|7|i|20200316|\n24JPTXA8203S1ZO|Amrit Pharma Retail|A|P|3|k|20220527|n\n33QFUXG9382B1ZD|Galaxy Legal Associates LLP|A|L|a|3|20241208|\n27TXHXG9614Y1ZD|Galaxy Dental Care LLP|A|L|7|i|20190311|\n27CQRXH7459B1Z1|Harmony Classes|A|P|7|i|20181008|8\n33FRSXK4786Z1ZM|Krishna Hardware|A|P|a|4|20230418|\n27OHOXN4325B1ZM|Navkar Boutique|A|P|7|f|20231127|5\n32BPAXG3179N1ZD|Green Leaf Opticals|A|P|5|9|20230101|\n27LHOXL4621K1Z9|Lakshmi Bake House|A|P|7|d|20230908|4\n09JEAXS3645Y1ZO|Sai Insurance Advisors|A|P|c|b|20240711|\n24KYWXM9476B1Z4|Moonlight Diagnostics LLP|A|L|3|j|20250417|a\n32IWXXS0421X1ZU|Sahyadri Medicals|A|P|5|9|20190606|m\n03WZGXC0411A1ZL|Classic Medicals|A|P|8|c|20210121|m\n27TGEXM1905K1ZF|Modern Legal Associates Pvt Ltd|A|C|7|f|20241027|\n27EWFXS4064V1ZW|Saffron Design Studio LLP|A|L|7|i|20241219|1\n37DVIXB4830A1ZL|Balaji Legal Associates Pvt Ltd|A|C|0|l|20251009|i\n33ZRVXS6027Y1Z7|Sai Sweets|A|P|a|3|20230527|w\n32RIWXH6370W1Z7|Harmony Textiles|A|P|5|9|20250330|x\n08WDRXS8095R1ZY|Sai Legal Associates|A|P|9|8|20181002|i\n24XWSXS0638L1ZU|Silver Oak Kids Academy LLP|A|L|3|k|20201021|q\n03ARVXM3530L1Z1|Modern General Store|A|P|8|c|20180710|\n27UZSXS0499L1ZA|Shree Bakers|S|P|7|f|20220606|\n27SFVXO5350S1ZC|Orbit Fashions Pvt Ltd|A|C|7|d|20180326|\n23MDWXA6911A1Z7|Annapurna Tours & Travels Pvt Ltd|A|C|6|2|20241110|y\n36AEGXR1379H1ZR|Riddhi Classes Pvt Ltd|A|C|b|6|20240718|\n08YGIXO2749F1Z3|Om Sweets|A|P|9|8|20241105|\n24ZCMXN6750S1ZL|New Printers|A|P|3|j|20161231|r\n33NHCXS3976Z1Z9|Sunrise Polymers|A|P|a|3|20191218|p\n29QPCXT3591R1ZY|Trinity Tours & Travels|A|P|4|1|20170125|y\n27NRXXA4280V1ZV|Amrit Realty|A|P|7|g|20160910|\n24BHCXS2155I1ZX|Silver Oak Kitchens|A|P|3|j|20240703|\n33EHUXL7581U1ZG|Lakshmi Stays LLP|A|L|a|4|20160603|\n29ETWXK1015B1Z9|Kaveri Kids Academy LLP|A|L|4|1|20241129|\n09YDZXG4740F1Z3|Ganesh Classes LLP|A|L|c|b|20210524|\n07ZWPXH6571P1ZI|Harmony Realty LLP|A|L|2|5|20170331|\n37YBZXT2764D1ZV|Trinity Design Studio|A|P|0|l|20200319|\n24FYLXO2837E1ZT|Om Hardware|A|P|3|k|20181221|\n27DOGXS8342Z1ZZ|Saffron Woodcraft Pvt Ltd|A|C|7|g|20211203|d\n29CKWXS2260X1Z3|Sunrise Hardware|A|P|4|e|20250128|f\n33KYTXA7446H1ZI|Amrit Auto Components Pvt Ltd|A|C|a|3|20180322|2\n27SXUXO2143J1Z1|Orbit Stationers|A|P|7|i|20240806|\n10KQFXU5695Q1ZA|Unity Hardware|A|P|1|h|20220327|f\n36TNTXO1521F1ZZ|Om Medicals|A|P|b|6|20241108|\n07WUBXU8748E1Z6|Unity Fitness LLP|A|L|2|5|20240901|e\n37OCQXS3911L1Z5|Sunrise Diagnostics|A|P|0|l|20200315|a\n10WHKXV0944J1Z7|Vindhya Realty|A|P|1|h|20230828|s\n24RMUXK1379B1Z3|Krishna Stays|A|P|3|k|20250831|6\n08VNHXS2029I1ZS|Sahyadri Opticals|C|P|9|8|20251117|\n09MLTXP0148V1Z4|Prime Medicals|A|P|c|b|20211004|\n19RDAXG1179J1ZM|Green Leaf Dental Care LLP|A|L|d|a|20180509|9\n32CLWXB2847A1ZX|Blue Lotus Dental Care LLP|A|L|5|9|20190829|9\n36RZGXC7118X1ZO|Coral Mobile Care|A|P|b|6|20241212|j\n27DYBXN4318P1ZH|Navkar Electronics Pvt Ltd|C|C|7|i|20180302|b\n27MBDXZ1658E1ZN|Zenith Kids Academy|A|P|7|d|20200223|q\n24PXHXR1561E1ZR|Riddhi & Associates|A|P|3|0|20180305|\n27WWDXS0328C1ZS|Star Bake House Pvt Ltd|A|C|7|i|20210118|4\n29EINXS9076N1ZE|Sai Classes LLP|A|L|4|e|20180311|\n36KGRXG5032G1ZP|Ganesh Medicals|A|P|b|6|20190723|m\n33RVXXP3432L1Z3|Prime General Store|A|P|a|3|20180911|\n07WVNXU1626E1ZD|Unity Design Studio Pvt Ltd|A|C|2|5|20181221|\n36JQFXK6804O1ZQ|Kaveri Medicals|A|P|b|6|20180505|m\n24IBPXG0705V1ZJ|Ganesh Tours & Travels|A|P|3|0|20240526|y\n36RZPXP0949A1ZC|Prime Physio Clinic|A|P|b|6|20190419|\n23NHIXH4842Y1ZQ|Harmony Physio Clinic|A|P|6|2|20250523|\n33QOHXN0094U1ZE|Neelgiri Medicals|A|P|a|4|20200609|\n33CASXM1366P1ZK|Metro & Associates|A|P|a|3|20231106|7\n36CBFXV5969W1ZL|Vindhya Kids Academy|A|P|b|6|20211222|q\n08UZMXS0570B1ZD|Silver Oak Boutique|A|P|9|8|20250921|\n27FFNXS1009B1Z4|Saffron Opticals|A|P|7|i|20161019|\n27BVQXG8646O1Z4|Ganesh Stationers|A|P|7|d|20190620|\n36STLXM7247V1ZI|Metro Pharma Retail|A|P|b|6|20251030|n\n19ITZXN3930K1Z5|Neelgiri Physio Clinic LLP|A|L|d|a|20250606|o\n23PBBXO1449K1ZV|Om Dental Care Pvt Ltd|S|C|6|7|20170707|9\n29NIDXN2577W1ZA|Neelgiri Stationers|A|P|4|e|20230331|v\n27RSLXU5832O1ZV|Unity Kitchens LLP|A|L|7|d|20220909|t\n23VJAXA2221N1ZT|Apex Unisex Salon|A|P|6|2|20210211|\n24LQFXT9749J1ZC|Trinity Diagnostics|A|P|3|j|20200816|\n07VLNXS7236G1ZM|Silver Oak & Associates|A|P|2|5|20190124|7\n24SOFXP0038R1ZP|Pearl Medicals|A|P|3|0|20210107|\n23PACXB2119G1ZP|Balaji Polymers|A|P|6|2|20231101|p\n08MVCXS4245G1ZP|Sunrise Bakers|A|P|9|8|20171006|3\n23HUZXN7052U1ZQ|Neelgiri Kids Academy|A|P|6|7|20220628|q\n10MBNXG1744A1ZO|Green Leaf Pharma Retail|A|P|1|h|20220619|n\n09BTNXG6147I1ZT|Ganesh Medicals|A|P|c|b|20180406|\n27ACLXS3433I1ZU|Saffron Legal Associates|A|P|7|d|20171228|\n33VZFXA8966A1ZM|Amrit Pharma Retail LLP|A|L|a|4|20230224|n\n19YGOXS3287N1Z6|Star Woodcraft|A|P|d|a|20180312|d\n29QFZXP5525E1ZX|Prime Classes|C|P|4|1|20250412|8\n29HOEXO6298A1Z1|Orbit Sweets|A|P|4|1|20180628|w\n23LIKXG5669R1ZR|Galaxy Sweets|A|P|6|2|20210503|w\n27WJWXM2900K1ZQ|Metro Mobile Care|A|P|7|d|20230612|\n29FLSXK0304B1ZU|Krishna Mobile Care|A|P|4|e|20190315|\n07TCUXM5961B1ZC|Metro Hardware|C|P|2|5|20211225|\n36TBQXK4319F1ZL|Krishna Opticals|A|P|b|6|20230312|\n19GPVXV8426Z1Z8|Vindhya Medicals|A|P|d|a|20190708|m\n07EBAXU6644F1ZZ|Unity Diagnostics Pvt Ltd|A|C|2|5|20230514|\n24QRBXA6229W1ZH|Apex Kitchens LLP|A|L|3|j|20220924|\n27LRJXN6081Z1ZN|New Stationers|A|P|7|i|20210402|\n24NRGXR5830R1ZB|Riddhi Opticals|A|P|3|k|20210214|k\n33RSCXN4802E1ZB|New & Associates|A|P|a|3|20230710|\n36GYVXG3392R1ZQ|Galaxy Stationers|A|P|b|6|20230715|v\n29SNRXH6644G1ZK|Harmony Bakers|A|P|4|1|20170329|\n23PTIXS6918M1Z7|Sahyadri Medicals|A|P|6|7|20250706|m\n32ORKXP5441Z1ZW|Prime Realty Pvt Ltd|A|C|5|9|20221013|\n07RXZXM7162J1ZO|Modern Pharma Retail|S|P|2|5|20210407|n\n29PGQXR5614M1ZO|Royal Bakers|A|P|4|e|20221128|\n03XOMXB6103O1ZZ|Balaji Opticals|A|P|8|c|20230928|k\n33GWHXS7747D1ZO|Shree Pharma Retail Pvt Ltd|A|C|a|3|20190716|\n24ZLMXN2816O1ZJ|New & Associates Pvt Ltd|A|C|3|j|20231111|7\n23TXQXP8585T1Z1|Prime Bake House|A|P|6|7|20210307|4\n07BVWXK8061D1ZQ|Kaveri Realty LLP|A|L|2|5|20240406|s\n08SARXB5506T1Z3|Balaji Design Studio|A|P|9|8|20180117|1\n33BNTXO7569A1Z5|Om Opticals|A|P|a|4|20170119|\n27PTDXB4033Z1Z9|Balaji Stationers|A|P|7|i|20200320|\n24KNXXS5363F1ZP|Saffron Bake House|A|P|3|k|20161104|4\n27ISZXK3245P1Z3|Kaveri Pharma Retail Pvt Ltd|A|C|7|d|20230630|\n10MUNXG8458C1Z0|Galaxy Sweets|A|P|1|h|20171028|w\n32EQSXA2317A1Z1|Amrit Medicals|A|P|5|9|20220611|\n24UKBXU3504P1ZX|Unity Stays Pvt Ltd|A|C|3|0|20191021|\n32HUDXA3911H1ZP|Annapurna Physio Clinic Pvt Ltd|A|C|5|9|20200312|\n07ZTIXM4212Y1ZQ|Modern Physio Clinic|A|P|2|5|20160826|o\n27RXNXL6759U1Z4|Lakshmi Unisex Salon|A|P|7|i|20220731|u\n24AXPXN1814M1ZP|Neelgiri Legal Associates|A|P|3|0|20180507|\n10DYHXS1241S1ZN|Sahyadri Unisex Salon|A|P|1|h|20220227|\n27HRJXG0622Q1ZX|Ganga Fashions LLP|A|L|7|i|20191208|0\n07COAXK7493W1ZC|Krishna Legal Associates LLP|A|L|2|5|20200309|i\n07ZTHXS4697N1ZI|Sai Stays LLP|A|L|2|5|20231120|6\n23KFLXA1062P1ZT|Annapurna Legal Associates|A|P|6|2|20210514|\n27APEXS5360X1ZA|Shree Opticals|A|P|7|f|20230517|k\n29VFBXK3405U1ZX|Kaveri & Associates|C|P|4|1|20200521|7\n27MRZXP7782N1ZI|Pearl Physio Clinic Pvt Ltd|A|C|7|d|20250325|o\n09AIUXK3946E1ZD|Krishna Insurance Advisors|A|P|c|b|20231229|g\n27ANQXC3496R1ZL|Classic Bakers|A|P|7|f|20220411|\n37WJIXC2825D1ZK|Classic General Store|C|P|0|l|20210407|h\n29LZUXM2308W1ZD|Modern General Store|A|P|4|1|20230707|h\n33WBXXR6342N1ZQ|Royal & Associates LLP|A|L|a|3|20191020|7\n29YWYXK6376R1ZU|Krishna Fitness LLP|A|L|4|1|20240302|e\n32TGLXO5353I1Z9|Om Unisex Salon|A|P|5|9|20231120|u\n27YGQXS8059R1ZV|Sunrise Opticals|A|P|7|i|20200411|\n33VSXXS6323K1Z0|Sai Kids Academy Pvt Ltd|A|C|a|4|20231030|q\n24YDRXN8224S1ZI|New Unisex Salon|A|P|3|j|20180206|u\n29GLYXL8225G1ZS|Lakshmi Tours & Travels|A|P|4|1|20200706|y\n29WBNXK6905C1ZI|Krishna Hardware|S|P|4|1|20210312|\n19ALUXH2722C1ZP|Harmony Boutique|A|P|d|a|20191206|\n36TENXO3840Q1ZR|Orbit Realty|A|P|b|6|20171213|s\n24VUDXO2339G1ZS|Om Tours & Travels Pvt Ltd|A|C|3|0|20230330|y\n29UJIXA4601C1ZT|Amrit Physio Clinic Pvt Ltd|A|C|4|1|20210619|o\n27EXFXA9714C1Z8|Annapurna Realty|A|P|7|f|20240302|\n29KVIXC5637Z1ZO|Coral General Store|C|P|4|e|20230118|h\n33DPRXG5573F1Z7|Galaxy Diagnostics|A|P|a|3|20251101|\n27CRVXG2004L1Z4|Galaxy & Associates LLP|A|L|7|d|20201106|\n23MFWXS8571R1ZA|Sai Realty Pvt Ltd|A|C|6|2|20230928|\n23YJYXU9598H1ZT|Unity Physio Clinic Pvt Ltd|A|C|6|7|20240503|o\n33XPUXS1023O1ZC|Shree Opticals|A|P|a|4|20250621|k\n27LABXN8751X1ZT|Navkar Diagnostics Pvt Ltd|A|C|7|d|20181003|a\n36IMMXN6222I1Z5|Neelgiri Kitchens Pvt Ltd|C|C|b|6|20190423|t\n24BUIXR2200M1Z7|Riddhi Stays|A|P|3|j|20180531|6\n19HKKXA6222Q1Z5|Apex Diagnostics|A|P|d|a|20180930|a\n36SCMXH3091L1ZB|Harmony Kitchens|A|P|b|6|20160606|t\n24RFMXS6693L1ZM|Sunrise Kitchens LLP|A|L|3|0|20250626|t\n24QOAXS7980M1ZE|Sahyadri Classes Pvt Ltd|A|C|3|j|20241225|\n24ZKRXA1546B1ZJ|Annapurna Bakers|A|P|3|0|20230309|3\n36RMPXN9980M1ZY|Navkar Textiles|A|P|b|6|20230425|x\n07HXYXZ2241W1ZA|Zenith Polymers|A|P|2|5|20171103|p\n07XAHXM1769W1ZK|Metro General Store|A|P|2|5|20221107|\n27RXOXE0665G1ZI|Evergreen Sweets|A|P|7|g|20200303|w\n27QJRXK4556F1ZY|Kaveri Kitchens LLP|A|L|7|i|20170528|t\n29TEUXS5950A1Z1|Silver Oak Unisex Salon|A|P|4|e|20230206|\n09KBVXK6608R1ZT|Kaveri Boutique|A|P|c|b|20240825|\n24OBDXK7613R1ZG|Krishna Electronics|A|P|3|j|20230914|b\n27ATXXE0024V1ZI|Evergreen Pharma Retail|A|P|7|d|20230903|n\n33WKCXR4871G1Z1|Royal Printers|A|P|a|4|20250218|\n36UAWXL1979V1Z6|Lakshmi Diagnostics LLP|A|L|b|6|20241116|\n27NIGXB8261N1Z4|Balaji Design Studio LLP|A|L|7|d|20210914|1\n33HCUXV9442Z1Z7|Vindhya & Associates|A|P|a|3|20161224|7\n24KFTXS4562O1ZS|Shree Stationers|C|P|3|j|20240621|v\n32NZFXO5368A1ZS|Om Bakers|A|P|5|9|20250509|3\n32BOTXB4918X1ZK|Balaji Tours & Travels LLP|C|L|5|9|20240618|\n29TSNXC7763A1ZO|Classic Electronics|A|P|4|1|20161208|\n27EREXM1226Z1ZF|Modern Polymers Pvt Ltd|A|C|7|i|20210529|p\n29BDCXN9351S1Z4|Navkar Fitness Pvt Ltd|A|C|4|1|20160919|e\n19KMFXS6409G1Z1|Sahyadri & Associates Pvt Ltd|C|C|d|a|20200427|7\n07TSBXB2228A1ZP|Blue Lotus Realty|A|P|2|5|20250217|\n07OBOXS0982M1Z1|Sai Unisex Salon|A|P|2|5|20220312|\n27YFGXN2039Q1ZU|Navkar Physio Clinic|A|P|7|d|20250513|\n23JJZXA1462W1ZP|Annapurna Design Studio Pvt Ltd|A|C|6|2|20161015|1\n24XHFXA2830G1ZX|Apex & Associates LLP|A|L|3|j|20211016|\n24HAFXA2935U1ZS|Apex Hardware|A|P|3|j|20251031|f\n29CTNXA0740Y1ZD|Amrit General Store|A|P|4|1|20180328|\n24XTBXG9815S1Z2|Galaxy Bakers|A|P|3|j|20160921|3\n23QXDXG8374T1ZV|Green Leaf Mobile Care|A|P|6|2|20180701|\n09PDNXG0158H1ZO|Ganesh Kids Academy|A|P|c|b|20230517|q\n32SZXXM2147Q1ZN|Moonlight Auto Components|A|P|5|9|20190324|2\n07GPEXG1294U1ZN|Galaxy Design Studio|A|P|2|5|20181116|1\n36LXYXR8601W1Z5|Riddhi Fitness Pvt Ltd|A|C|b|6|20220406|e\n19OFOXN1231N1Z7|Neelgiri Kitchens|A|P|d|a|20181201|\n29CBFXS3950F1ZX|Star Stays LLP|A|L|4|1|20210311|6\n33QNOXH2440U1ZL|Harmony Auto Components|A|P|a|3|20220731|\n24MMHXM0690K1Z4|Metro Stationers|A|P|3|0|20170619|\n19APUXK8508V1ZZ|Kaveri Mobile Care|A|P|d|a|20221123|\n03HEEXE1071H1ZJ|Evergreen Realty LLP|A|L|8|c|20190526|s\n10AJIXH1744N1ZW|Harmony Textiles Pvt Ltd|A|C|1|h|20211025|\n08BWXXO0937D1ZO|Om Kitchens LLP|A|L|9|8|20210820|\n24YGFXG8174V1ZG|Ganga Diagnostics Pvt Ltd|A|C|3|k|20250223|\n23DOOXS8670N1ZG|Star Physio Clinic Pvt Ltd|A|C|6|2|20180424|o\n29AWVXC8136I1ZH|Coral Hardware|A|P|4|e|20250115|f\n27PBEXG6261M1ZK|Green Leaf Insurance Advisors LLP|A|L|7|g|20180705|\n29OHOXB0148X1ZO|Balaji Classes|A|P|4|e|20221227|8\n24WXUXN8308K1ZR|New Insurance Advisors|A|P|3|k|20230706|g\n10GTOXT5753H1ZS|Trinity Opticals|A|P|1|h|20210704|\n23JJUXB3042H1ZS|Blue Lotus Unisex Salon|A|P|6|7|20181025|\n27HPBXT4330O1ZV|Trinity Kitchens Pvt Ltd|C|C|7|d|20170706|\n24IEXXA3985N1Z3|Annapurna Fashions Pvt Ltd|A|C|3|j|20200720|0\n27IXEXR4292Q1ZW|Riddhi Unisex Salon|A|P|7|i|20201006|\n29XNBXK0634U1ZD|Krishna Electronics LLP|A|L|4|1|20210825|\n07NLWXG9816E1ZV|Galaxy Unisex Salon|A|P|2|5|20220706|u\n27BDEXH1476Y1Z6|Harmony Kitchens|A|P|7|d|20190924|\n27QEPXO6165N1ZP|Om Bakers|A|P|7|g|20250527|3\n03IFHXC9717Z1ZX|Coral Design Studio LLP|A|L|8|c|20170124|1\n27YBKXH4108L1ZG|Harmony Medicals|A|P|7|g|20180523|\n07IJOXG5650C1ZO|Galaxy Hardware|A|P|2|5|20251015|f\n19DRKXP5697F1ZI|Prime Pharma Retail Pvt Ltd|A|C|d|a|20211014|n\n32BLCXH8928K1ZH|Harmony Sweets|A|P|5|9|20230507|w\n07JPLXE6677L1ZK|Evergreen & Associates LLP|A|L|2|5|20180430|7\n07ZOMXS2973B1ZL|Sahyadri Bakers|A|P|2|5|20250719|\n24TBIXG7120F1Z5|Ganesh Bakers|A|P|3|0|20211130|3\n08CIRXO1576W1ZD|Om Legal Associates Pvt Ltd|A|C|9|8|20180620|i\n07AQLXC3115S1Z4|City Dental Care LLP|A|L|2|5|20250414|9\n36TAMXS8241B1ZM|Silver Oak Woodcraft|A|P|b|6|20211113|d\n29HJOXG3762B1ZK|Ganga Mobile Care|A|P|4|1|20220630|\n07VAAXZ2972Z1ZB|Zenith Woodcraft Pvt Ltd|A|C|2|5|20250928|\n27BNLXG5426W1ZL|Ganga & Associates LLP|S|L|7|i|20180205|\n27KMOXE6882B1Z6|Evergreen Kitchens|A|P|7|d|20190821|\n37UJWXA2750Q1ZJ|Amrit Dental Care LLP|A|L|0|l|20250829|\n33RHPXM2868V1Z9|Modern Realty|A|P|a|4|20230928|s\n24QDXXE1414Q1ZB|Evergreen Classes|A|P|3|0|20160725|\n37IYYXT7762N1Z8|Trinity Kids Academy|A|P|0|l|20201206|q\n29KOUXE8306A1Z7|Evergreen Stationers|A|P|4|e|20201227|\n27QJNXC5368Z1Z1|City Woodcraft LLP|A|L|7|d|20231013|d\n23FYZXS2824F1ZG|Star Stays LLP|A|L|6|7|20230310|6\n29TUPXS4835I1ZU|Shree Printers Pvt Ltd|A|C|4|1|20160624|r\n03RNCXS4136G1ZC|Sai General Store|A|P|8|c|20250210|h\n24LLWXG3976Q1ZB|Galaxy Mobile Care|A|P|3|j|20190919|\n33KHGXV2807X1ZP|Vindhya Electronics|A|P|a|3|20170525|b\n19GCCXP2878T1ZW|Prime Hardware|A|P|d|a|20170228|f\n19VLVXG2941J1ZK|Ganesh Opticals|A|P|d|a|20240417|\n23ICVXB7267L1ZF|Balaji Auto Components|C|P|6|7|20200302|2\n19AJCXS4242D1ZV|Shree Mobile Care|A|P|d|a|20200720|\n36AGPXG2658E1ZV|Ganga Medicals|A|P|b|6|20250130|m\n24XDSXO1287I1Z0|Om Boutique|A|P|3|k|20240121|5\n27ICBXM4213P1ZS|Moonlight Electronics LLP|A|L|7|i|20200112|b\n27KZGXM4307M1ZD|Metro Stays Pvt Ltd|A|C|7|d|20181117|6\n27TNLXO1783D1ZU|Om Sweets|A|P|7|g|20190320|w\n33HBSXK1864P1ZC|Kaveri Woodcraft LLP|S|L|a|3|20200317|d\n10OTRXA8992T1ZW|Apex Boutique|A|P|1|h|20250403|\n27EGJXU4223Q1Z4|Unity Bake House|A|P|7|g|20201111|4\n24GBUXG1949T1Z4|Ganga Sweets|S|P|3|j|20180915|\n29RDPXM2132G1ZK|Modern Diagnostics LLP|A|L|4|e|20190213|\n24JRZXN6996S1ZD|Neelgiri Pharma Retail Pvt Ltd|A|C|3|j|20200118|n\n27VDVXG3305U1ZQ|Galaxy Bakers|S|P|7|i|20210110|3\n36CBSXA7152Y1Z2|Annapurna Textiles Pvt Ltd|A|C|b|6|20160824|x\n27HGTXS6625T1ZD|Sunrise Dental Care|A|P|7|d|20160701|\n08RKWXU8170A1ZO|Unity Packaging Pvt Ltd|A|C|9|8|20191021|l\n27TMNXP9777M1ZS|Pearl Kitchens|A|P|7|d|20230411|\n24QWCXS8265X1ZE|Shree Boutique|A|P|3|k|20180313|\n27XDFXV7596U1ZW|Vindhya & Associates LLP|A|L|7|d|20181209|7\n07OCMXR7066K1Z1|Royal Hardware|A|P|2|5|20180425|f\n33VVTXS4434F1Z9|Sunrise Unisex Salon|A|P|a|3|20170422|\n33VQKXA5818I1ZX|Amrit Sweets|C|P|a|4|20210704|\n29NBUXC9770C1ZF|City Kids Academy|C|P|4|1|20231129|q\n27JARXN6752C1ZP|New Fitness|A|P|7|d|20201029|e\n09IXMXM2049S1ZW|Moonlight Boutique|A|P|c|b|20241231|5\n27ERWXS3016W1ZX|Sunrise Foods Pvt Ltd|A|C|7|d|20241118|c\n36BRYXP5369D1ZL|Pearl & Associates Pvt Ltd|A|C|b|6|20210409|7\n27LAEXP5922T1Z5|Pearl Fitness Pvt Ltd|A|C|7|i|20191216|e\n19ZTVXZ4472I1ZD|Zenith Opticals|A|P|d|a|20240811|\n09DICXE7634A1Z5|Evergreen Medicals|A|P|c|b|20190608|m\n23NJUXM7017K1ZZ|Modern Textiles|A|P|6|7|20200112|x\n27RAYXN9494T1ZY|Navkar Mobile Care|A|P|7|i|20220609|\n29HLDXH5566X1ZB|Harmony Dental Care Pvt Ltd|A|C|4|e|20160723|9\n36JTZXO5403H1ZI|Om Pharma Retail|A|P|b|6|20210106|\n37BDVXK6799T1ZB|Krishna & Associates Pvt Ltd|A|C|0|l|20230312|7\n27HGKXC0736E1Z5|Coral Stays|A|P|7|g|20190502|6\n36KGNXV2255R1ZO|Vindhya Tours & Travels|A|P|b|6|20250607|y\n27QUNXG2932I1ZL|Galaxy Design Studio Pvt Ltd|A|C|7|d|20231224|1\n36LUGXK5652J1ZL|Kaveri Bakers|A|P|b|6|20230204|\n08IWYXA5517I1ZH|Apex Pharma Retail Pvt Ltd|A|C|9|8|20221108|\n03QJVXM6273A1ZA|Metro Pharma Retail|A|P|8|c|20231124|\n09WEIXN0541K1ZB|Navkar Insurance Advisors|C|P|c|b|20171211|\n27MSKXA7203E1ZD|Amrit Unisex Salon|S|P|7|i|20161213|u\n27SROXA9597K1ZZ|Apex General Store|A|P|7|i|20211123|\n07VVGXN1210C1Z8|New Fashions Pvt Ltd|A|C|2|5|20200525|0\n27TDLXK2704D1ZW|Kaveri Bakers|A|P|7|i|20220731|\n32CXPXL1359M1ZK|Lakshmi Unisex Salon|A|P|5|9|20230116|\n33WRDXE4056Z1Z3|Evergreen Fashions Pvt Ltd|A|C|a|3|20230812|0\n29PGUXS3617X1ZY|Shree Kids Academy LLP|A|L|4|1|20170406|q\n37QXCXT4079K1ZY|Trinity Classes|A|P|0|l|20160807|8\n24LQHXS4556S1Z6|Sahyadri Opticals|A|P|3|k|20170104|k\n27BSQXM3814C1Z9|Metro Mobile Care|A|P|7|g|20210624|\n37SDBXV5211U1ZW|Vindhya Classes|A|P|0|l|20250607|\n29UWNXN8694F1ZM|New Pharma Retail LLP|C|L|4|1|20220624|\n24QSGXP5234K1ZO|Pearl Tours & Travels|A|P|3|j|20190717|\n03TGIXV0035L1ZF|Vindhya Opticals|A|P|8|c|20180120|\n27BZQXZ5979B1ZY|Zenith Fitness LLP|A|L|7|f|20220721|e\n03DURXC6200D1ZQ|City General Store|A|P|8|c|20240707|\n03DIYXL7482Z1Z3|Lakshmi Boutique|A|P|8|c|20231219|5\n27RHCXS2697V1Z6|Sunrise Insurance Advisors|A|P|7|g|20251120|\n29YDGXO2379G1Z3|Orbit Legal Associates LLP|A|L|4|1|20251115|\n27MWIXO5506I1ZI|Om Kids Academy|A|P|7|g|20221128|\n19ISUXN7354U1ZI|New Fitness|A|P|d|a|20251018|e\n08EKJXT3656H1Z4|Trinity Physio Clinic Pvt Ltd|A|C|9|8|20180512|\n10XPSXR7824I1ZE|Riddhi Printers|A|P|1|h|20161127|r\n27LPOXN6846Q1ZZ|New Insurance Advisors LLP|A|L|7|d|20220917|\n27CDBXG5602Y1ZH|Green Leaf Stationers|A|P|7|i|20171220|v\n29SFSXC2118E1ZO|Coral Stationers|A|P|4|e|20160907|v\n33SFKXS7543Z1Z5|Sahyadri Hardware|A|P|a|3|20180619|f\n33GQGXN6824R1ZL|New Stationers|A|P|a|4|20210729|v\n07TCNXM3758E1ZE|Modern Tours & Travels|A|P|2|5|20220703|y\n33NRQXA5700E1ZH|Amrit Classes LLP|A|L|a|3|20230130|\n09OGCXG3031N1ZN|Ganesh Realty Pvt Ltd|A|C|c|b|20180922|s\n27RCKXH3354W1ZT|Harmony Realty Pvt Ltd|S|C|7|i|20240909|s\n24EEWXS2699R1ZH|Sunrise Hardware|A|P|3|0|20170907|\n33LULXG0537Y1Z6|Ganga Boutique|A|P|a|3|20230618|\n09VQCXM3179L1ZC|Moonlight Sweets|A|P|c|b|20220703|\n37ECLXK4692X1ZO|Krishna Stationers|A|P|0|l|20200729|\n07YOMXA4104L1Z0|Apex Diagnostics|A|P|2|5|20200814|a\n29GQHXO5216Q1ZI|Orbit Medicals|A|P|4|e|20240829|m\n27KPJXP9155G1ZO|Prime Classes LLP|A|L|7|f|20161210|\n36CDMXG7052F1Z2|Galaxy Auto Components LLP|A|L|b|6|20210910|2\n24SHLXM4659F1Z7|Metro Auto Components Pvt Ltd|A|C|3|0|20240613|2\n24SIBXS2458S1ZO|Sahyadri Design Studio|S|P|3|j|20200902|\n33JFEXL4137B1ZC|Lakshmi General Store|A|P|a|4|20190619|\n32CBYXS7997Z1ZZ|Silver Oak Bakers|A|P|5|9|20240713|3\n27OORXR7777Q1ZJ|Riddhi Hardware|A|P|7|d|20230627|\n27CFHXP6048G1ZP|Prime Physio Clinic|A|P|7|d|20210521|o\n29XYHXK2873K1ZS|Krishna Sweets|A|P|4|1|20190806|\n29MZGXP7365T1ZA|Pearl Kids Academy LLP|A|L|4|1|20160925|q\n23LPTXB3405I1ZD|Balaji Bakers|C|P|6|7|20161126|\n27UIPXA2170S1ZR|Apex Medicals|A|P|7|d|20170130|m\n27XFCXM0271K1ZE|Moonlight Stationers|S|P|7|i|20230915|v\n33SSLXS1001B1ZH|Star Classes|A|P|a|3|20241130|8\n27EXKXO8467R1ZM|Orbit Tours & Travels LLP|A|L|7|d|20190718|y\n29JBVXS2628S1ZM|Star Realty|A|P|4|1|20220524|\n09SSGXA8200C1ZE|Annapurna Medicals|S|P|c|b|20240413|m\n03KTFXK0002W1ZY|Krishna Pharma Retail|A|P|8|c|20251105|\n24DWGXZ4595S1ZP|Zenith Hardware|A|P|3|j|20231207|\n07AAXXO0997P1ZZ|Orbit Stays|A|P|2|5|20191202|6\n27EQNXK9663X1ZP|Krishna Legal Associates LLP|A|L|7|g|20191011|i\n27ZGEXS3141M1ZZ|Shree Boutique|A|P|7|i|20190830|5\n27PSPXO1490N1Z3|Orbit Classes|A|P|7|g|20230428|8\n29TLOXK8221V1ZZ|Krishna Boutique|A|P|4|e|20230103|\n23XSSXP1658X1ZD|Pearl Electronics|A|P|6|7|20250826|b\n27EOIXN1349B1ZL|Navkar Tours & Travels|A|P|7|i|20240122|y\n33ILJXC3654F1ZS|Classic Dental Care LLP|A|L|a|3|20220517|9\n27PVGXS8222T1ZQ|Saffron General Store|A|P|7|d|20180513|\n29NCXXC0387C1ZN|Classic Stays LLP|A|L|4|1|20171112|6\n29BLMXS5537A1ZD|Sahyadri Bake House|A|P|4|e|20190404|\n24BFJXU9189S1ZK|Unity Realty Pvt Ltd|A|C|3|k|20170618|s\n24NUCXE5091M1ZR|Evergreen Packaging Pvt Ltd|A|C|3|0|20240219|\n08CYCXM6841Z1ZQ|Modern & Associates|A|P|9|8|20160703|7\n27RFYXS0995T1ZV|Star Legal Associates LLP|A|L|7|d|20200128|i\n19ZTIXT4723A1ZJ|Trinity Stationers|A|P|d|a|20230827|v\n03ISUXM4922A1Z9|Modern Tours & Travels Pvt Ltd|A|C|8|c|20230706|y\n23ONIXK8480C1Z8|Krishna Hardware|A|P|6|7|20210915|f\n29LAAXL5201L1Z1|Lakshmi Fashions Pvt Ltd|A|C|4|1|20171225|\n24CBZXT7192Q1ZP|Trinity Hardware|S|P|3|k|20241217|\n09MVDXC2514B1ZK|City Hardware|A|P|c|b|20171120|\n09USZXS2314B1ZI|Shree Kids Academy LLP|A|L|c|b|20200831|q\n36CFCXS9439P1Z0|Star Insurance Advisors|A|P|b|6|20240126|g\n27ZHTXC4091S1ZB|Coral Pharma Retail|A|P|7|g|20190621|\n19WYPXS5981Q1ZV|Shree Unisex Salon|A|P|d|a|20200901|\n29GMDXO6964W1Z1|Orbit Insurance Advisors LLP|A|L|4|e|20191225|g\n08BRLXK9696U1ZP|Kaveri & Associates LLP|A|L|9|8|20231228|7\n23ZTJXK9230Q1Z1|Kaveri Unisex Salon|A|P|6|7|20251012|\n27HXTXA2854F1ZQ|Amrit Classes Pvt Ltd|A|C|7|f|20190620|8\n23CAYXS7566V1ZJ|Star Medicals|A|P|6|7|20240616|\n07KJEXB6612C1Z5|Balaji Dental Care|A|P|2|5|20200315|9\n07VNSXP8814X1ZF|Prime & Associates|A|P|2|5|20220115|\n27OTWXP4137E1ZF|Pearl Kitchens Pvt Ltd|A|C|7|g|20241201|\n07ZBJXG0365P1Z8|Green Leaf Stays|A|P|2|5|20170922|\n27ZJWXZ1791W1Z7|Zenith Stationers|A|P|7|f|20171018|v\n07BWUXM4816Z1ZK|Moonlight Unisex Salon|A|P|2|5|20250930|\n03TLSXR1699L1ZA|Riddhi Kitchens Pvt Ltd|A|C|8|c|20180205|t\n09XPUXK3607P1ZZ|Krishna Opticals|A|P|c|b|20200321|\n27GUHXS7674B1ZN|Silver Oak Dental Care|A|P|7|i|20241116|\n07ULJXP3852X1ZX|Pearl Boutique|A|P|2|5|20220422|\n32TUBXM9823N1ZB|Moonlight Dental Care Pvt Ltd|A|C|5|9|20240902|9\n33PKDXS5843X1Z9|Star Medicals|A|P|a|3|20220611|\n29JTXXS3235J1Z4|Star Opticals|A|P|4|1|20210408|\n19DPWXB4174S1ZB|Balaji Sweets|A|P|d|a|20180206|\n24DTWXK9719W1ZM|Kaveri Physio Clinic|A|P|3|0|20200322|\n27DWFXC5580U1Z8|Coral Realty LLP|A|L|7|g|20181220|\n27IMFXS1781I1Z0|Saffron Sweets|A|P|7|d|20240908|\n24BMQXS6228J1Z0|Sahyadri Sweets|A|P|3|j|20230131|w\n32QHDXS1232G1ZX|Shree & Associates Pvt Ltd|A|C|5|9|20250904|\n27ZUTXA0255D1ZR|Annapurna & Associates Pvt Ltd|A|C|7|d|20240718|7\n27AASXS7616N1Z8|Sahyadri Stays LLP|A|L|7|g|20161101|\n32VTGXO3882D1ZQ|Om Fitness|A|P|5|9|20160817|e\n07CUZXA8929N1Z4|Amrit Medicals|S|P|2|5|20200319|\n33NQZXO7941N1ZY|Om Pharma Retail|A|P|a|3|20190111|\n03BGEXV9199H1ZB|Vindhya Design Studio|A|P|8|c|20200921|1\n07CSLXN5702K1ZY|Navkar Design Studio|A|P|2|5|20200102|1\n09UIIXB6669V1Z5|Blue Lotus General Store|A|P|c|b|20210821|\n27VDUXG7039X1Z6|Green Leaf Medicals|A|P|7|i|20240519|\n03ODMXS1407Q1ZD|Saffron Unisex Salon|S|P|8|c|20190517|u\n27HOQXG7154I1ZV|Ganga Mobile Care|S|P|7|f|20230827|\n33CLNXM7118J1ZC|Modern Pharma Retail|A|P|a|4|20181116|n\n29QGBXP6047X1ZD|Pearl Stationers|A|P|4|1|20161109|v\n27YOJXA0796O1ZD|Amrit Mobile Care|A|P|7|g|20231205|\n08RIIXG7051L1Z3|Galaxy Bakers|A|P|9|8|20251112|3\n29LRAXK8892B1ZT|Krishna Stationers|A|P|4|1|20180912|\n33YEIXS3139J1Z7|Star Physio Clinic Pvt Ltd|A|C|a|3|20200519|\n03BQMXC6856S1ZO|Coral Kids Academy LLP|A|L|8|c|20171116|q\n27YBKXS5053V1ZF|Saffron Polymers Pvt Ltd|A|C|7|g|20170929|p\n29WZUXA3526W1Z8|Amrit Bake House Pvt Ltd|A|C|4|1|20180707|4\n07NXVXP5017I1Z5|Prime Bake House LLP|A|L|2|5|20250629|4\n08RWGXS4853X1Z9|Silver Oak Pharma Retail|A|P|9|8|20250226|n\n29RUBXN0647T1ZZ|Neelgiri Classes|A|P|4|1|20181009|8\n03FYGXV0581I1ZP|Vindhya Classes LLP|A|L|8|c|20191112|8\n37GQCXC3791A1ZN|Classic Classes|A|P|0|l|20200914|\n27UDPXS6139T1Z9|Star Medicals|A|P|7|i|20210902|\n19BGAXC9446N1ZI|Classic Classes LLP|A|L|d|a|20180704|8\n33KKEXH5615H1ZR|Harmony Bakers|A|P|a|4|20221008|3\n09SNHXG0225U1ZN|Green Leaf Unisex Salon|A|P|c|b|20240317|\n36YQHXA0653C1ZD|Apex Opticals|A|P|b|6|20220901|k\n37MTRXR1145N1Z6|Royal Stationers|A|P|0|l|20181217|v\n03LAQXS2648P1Z7|Sahyadri Stationers|A|P|8|c|20191209|v\n33NQHXN5391S1Z7|Navkar Stationers|A|P|a|4|20240425|v\n24CYVXS8460I1Z2|Sunrise Stationers|A|P|3|0|20200906|v\n27XJFXO3557S1Z9|Om Design Studio Pvt Ltd|A|C|7|f|20161115|\n03LZXXN3798Y1ZV|New & Associates|A|P|8|c|20220124|7\n08WRLXR5235J1Z8|Royal & Associates|A|P|9|8|20190511|7\n27MXTXM5190P1ZL|Modern General Store|A|P|7|d|20201105|h\n27DCVXB1539V1Z5|Blue Lotus Fashions Pvt Ltd|A|C|7|f|20201121|\n33BFDXS4793P1Z7|Sunrise Sweets|A|P|a|4|20251012|w\n24RDAXB3847L1ZT|Blue Lotus Electronics|A|P|3|k|20210717|b\n27IEWXS9913G1ZZ|Shree Dental Care|A|P|7|g|20170701|\n32AIRXR3392E1ZK|Riddhi Diagnostics|A|P|5|9|20180827|\n36ATCXS0542V1ZJ|Saffron Design Studio|A|P|b|6|20221229|1\n09KLJXH5337S1ZL|Harmony Pharma Retail LLP|A|L|c|b|20190530|n\n33LHOXK8591R1ZI|Krishna Legal Associates Pvt Ltd|A|C|a|3|20171120|i\n03BMVXG4356M1Z4|Green Leaf Opticals|A|P|8|c|20240511|\n33CFCXR2082O1ZO|Royal Medicals|A|P|a|4|20161206|m\n36WOOXA4328B1ZA|Apex Tours & Travels Pvt Ltd|A|C|b|6|20220127|\n29WXCXS0871G1Z7|Sahyadri Fashions|A|P|4|e|20190330|0\n27MTOXS8482A1ZE|Silver Oak Opticals|A|P|7|d|20161127|\n07LFEXA2234W1ZF|Amrit Auto Components|C|P|2|5|20220121|2\n32WXKXL2833C1ZT|Lakshmi Stays|A|P|5|9|20221206|6\n32UMCXN3136V1ZM|Neelgiri Bakers|A|P|5|9|20230709|\n29TPWXP7298F1ZS|Prime Classes LLP|A|L|4|1|20241023|8\n37KGJXS2347Y1ZE|Star General Store|A|P|0|l|20180407|\n07SUUXA5900N1ZC|Amrit Boutique|A|P|2|5|20180715|5\n19XULXZ1600A1ZO|Zenith Foods Pvt Ltd|A|C|d|a|20211113|c\n29AGQXL2975Y1ZB|Lakshmi Stationers|A|P|4|1|20250410|v\n29FIPXB9916O1ZT|Blue Lotus Opticals|A|P|4|1|20161128|k\n29SBQXK8673J1ZR|Kaveri Sweets|S|P|4|1|20230607|\n27IAFXG3956X1Z2|Ganesh Sweets|A|P|7|i|20220714|w\n33ZKUXS3035D1ZZ|Sunrise Design Studio|A|P|a|4|20200719|1\n19RVIXC5476D1ZM|Coral Design Studio|A|P|d|a|20211208|1\n08CAIXC7036Q1ZS|Classic Opticals|A|P|9|8|20200420|\n33SGFXU4168R1ZN|Unity Stays Pvt Ltd|A|C|a|4|20241102|\n33KSGXC9522M1ZX|Classic Mobile Care|A|P|a|3|20240929|j\n24FGGXN0486V1Z0|Navkar Fitness|A|P|3|k|20250706|e\n19CFPXC3385G1ZP|Coral Classes Pvt Ltd|A|C|d|a|20171001|\n32DYBXG5983J1ZS|Galaxy Kids Academy Pvt Ltd|A|C|5|9|20230517|q\n29KLEXC9177I1ZZ|Classic Stays|A|P|4|1|20250817|6\n09LIIXS5556R1ZD|Sahyadri Design Studio|A|P|c|b|20181026|\n33FRJXG0196B1ZO|Galaxy Boutique|A|P|a|4|20250712|5\n09AIZXE9694M1ZG|Evergreen Bakers|A|P|c|b|20190707|\n24EQAXS1192B1ZP|Silver Oak Auto Components LLP|A|L|3|k|20250501|\n29BQBXB7996P1ZH|Balaji Boutique|A|P|4|e|20220507|\n36CFKXT0571R1Z4|Trinity Bake House LLP|A|L|b|6|20200130|4\n29WCSXH2452F1ZE|Harmony Sweets|A|P|4|e|20170405|\n36OXOXC8355R1ZQ|City Classes Pvt Ltd|A|C|b|6|20221227|8\n09WXSXK9079U1ZQ|Krishna Mobile Care|A|P|c|b|20190228|\n23FNWXP6171E1Z2|Prime Polymers|A|P|6|7|20180704|\n09CEHXS9658G1Z8|Sunrise Classes|A|P|c|b|20180405|8\n24CPBXR8380U1ZE|Riddhi General Store|A|P|3|j|20210217|\n33QJOXS4770O1ZH|Star Unisex Salon|A|P|a|4|20180227|\n27EEGXU1479G1ZK|Unity Classes LLP|A|L|7|d|20160721|8\n24EPYXC2891R1ZE|Coral Realty Pvt Ltd|A|C|3|j|20240617|\n24QARXG6789H1Z8|Ganesh Dental Care Pvt Ltd|A|C|3|k|20171222|\n29NSXXR4493O1ZF|Riddhi Classes|C|P|4|1|20250614|\n33WIGXP5786A1Z7|Pearl Kitchens|A|P|a|3|20240625|\n33MBXXO6722U1ZP|Om Mobile Care|A|P|a|3|20201025|\n27JPZXP2211L1ZN|Prime Legal Associates|A|P|7|i|20200712|\n27FFZXA5880Y1ZC|Amrit Stationers|A|P|7|i|20231230|\n36YNDXR8319T1ZW|Royal Sweets|A|P|b|6|20190502|w\n24QBFXS4974T1ZQ|Star Sweets|A|P|3|0|20160708|w\n33TJKXM4553K1ZZ|Moonlight Design Studio|A|P|a|3|20250106|1\n24MZAXK1258W1Z1|Krishna Hardware|A|P|3|k|20180222|\n29LGZXN7517Z1ZR|Navkar Physio Clinic|A|P|4|e|20170828|o\n27BYNXG4443K1ZM|Galaxy Unisex Salon|A|P|7|g|20210916|\n24AKDXC0917N1ZY|Coral Bakers|A|P|3|0|20240821|3\n24TYUXE1904C1ZU|Evergreen Bake House LLP|A|L|3|j|20180926|4\n27EIXXA6582U1ZF|Annapurna Boutique|A|P|7|d|20230330|\n19HFXXG1550S1ZW|Green Leaf Design Studio Pvt Ltd|A|C|d|a|20160530|\n19XRLXR0337N1Z3|Riddhi Medicals|A|P|d|a|20220205|\n37JRAXZ9468Q1ZQ|Zenith Classes|A|P|0|l|20200510|\n32PTMXG9252H1ZQ|Ganga Dental Care LLP|A|L|5|9|20210908|\n23ATVXB8743X1Z1|Blue Lotus Opticals|A|P|6|7|20210723|k\n29GYVXL5048D1ZC|Lakshmi Fitness LLP|A|L|4|1|20231212|\n36VJCXK6843U1ZC|Kaveri General Store|A|P|b|6|20200507|\n27BFIXN1279C1Z0|Neelgiri Stationers|A|P|7|f|20231215|v\n19QZVXA7185K1ZN|Annapurna Fashions|A|P|d|a|20170715|0\n10CIDXC8153V1ZH|Coral Design Studio Pvt Ltd|A|C|1|h|20240511|\n27IWGXG4457G1ZT|Galaxy Stationers|A|P|7|i|20170306|\n37WYYXP7357Q1ZT|Prime Foods Pvt Ltd|A|C|0|l|20221224|\n29DVVXK9827B1ZF|Krishna Kitchens Pvt Ltd|A|C|4|1|20230706|t\n23ODRXH9901J1ZG|Harmony Fitness|C|P|6|7|20160830|e\n36PWBXG4008C1ZD|Galaxy Physio Clinic|A|P|b|6|20190211|o\n27JQIXR3715C1Z8|Riddhi Bake House|A|P|7|f|20170726|4\n32LEFXS2692K1ZF|Sunrise Tours & Travels|C|P|5|9|20220107|\n37SSCXB1393I1ZX|Blue Lotus Unisex Salon|A|P|0|l|20200514|\n33REXXG0925P1Z3|Ganesh Design Studio LLP|A|L|a|4|20191028|1\n09HLJXS9523C1Z6|Sahyadri Stays LLP|A|L|c|b|20231012|6\n32FMNXM9617M1ZV|Modern Medicals|A|P|5|9|20161107|m\n27HGZXP8736Z1ZQ|Prime Pharma Retail Pvt Ltd|A|C|7|d|20200721|\n27NSGXP2008V1Z9|Pearl Kids Academy LLP|A|L|7|i|20240918|q\n27PQBXE5204K1Z9|Evergreen Fitness LLP|A|L|7|d|20191218|e\n07PLFXH8455T1ZD|Harmony Pharma Retail LLP|A|L|2|5|20220717|n\n07TSHXP5252P1Z4|Prime Unisex Salon|A|P|2|5|20200827|\n24DLSXM0187G1ZD|Moonlight Diagnostics LLP|A|L|3|k|20161009|a\n07FAXXO2124X1ZZ|Orbit Diagnostics Pvt Ltd|A|C|2|5|20230717|a\n29WVVXU9526V1ZL|Unity Boutique|A|P|4|1|20250708|5\n33NAMXA7003O1ZZ|Annapurna Kitchens|C|P|a|3|20250226|t\n23BXEXA2056C1ZV|Amrit & Associates Pvt Ltd|A|C|6|2|20231216|7\n24OCAXR8653L1ZC|Royal General Store|A|P|3|k|20170414|h\n07WPNXN1690E1ZO|New Dental Care Pvt Ltd|A|C|2|5|20201102|9\n29YBWXG1988N1ZF|Green Leaf Packaging LLP|A|L|4|1|20250602|\n36IHTXC5772X1ZD|Coral Realty LLP|A|L|b|6|20250811|s\n24OZIXS3443P1ZY|Saffron Insurance Advisors|A|P|3|0|20160529|\n07YJTXN9495W1Z8|Navkar Opticals|A|P|2|5|20200724|k\n29EIVXG6375V1Z6|Green Leaf Stationers|A|P|4|e|20230521|\n24PGCXS7357Q1ZR|Saffron Stationers|A|P|3|j|20160626|\n07PMNXG9450U1Z5|Ganga Opticals|A|P|2|5|20160828|\n09AALXS1585V1ZX|Star Unisex Salon|A|P|c|b|20180611|\n36SFFXG9587K1ZU|Ganga Bake House LLP|A|L|b|6|20190912|4\n33APRXN9589M1Z8|Neelgiri Sweets|A|P|a|4|20181106|\n32QOQXG2777W1Z0|Green Leaf & Associates Pvt Ltd|A|C|5|9|20180518|7\n24ZWEXS9824F1Z5|Shree Opticals|A|P|3|k|20231105|k\n29NAWXN7509I1Z2|Neelgiri Woodcraft Pvt Ltd|A|C|4|1|20240718|d\n27PKSXR6228H1ZO|Royal General Store|C|P|7|i|20200728|h\n09GVPXN2618R1Z1|Neelgiri & Associates|A|P|c|b|20250722|7\n29ECAXA3970S1ZL|Annapurna Kitchens Pvt Ltd|A|C|4|1|20180927|t\n36HXAXV8485I1Z3|Vindhya Realty LLP|S|L|b|6|20210603|s\n24MZYXK5494L1ZL|Kaveri Fitness LLP|A|L|3|k|20220702|e\n27WJIXR5726V1ZZ|Riddhi General Store|A|P|7|f|20170601|\n19WRHXA6022V1Z7|Annapurna Boutique|C|P|d|a|20200601|\n07BVQXP3092T1ZX|Prime Pharma Retail|A|P|2|5|20180511|\n07VJJXO3495G1ZT|Om & Associates|A|P|2|5|20160808|7\n24AWPXS4237C1Z0|Star Hardware|A|P|3|0|20240419|\n27PTYXR3740J1Z0|Riddhi Tours & Travels LLP|A|L|7|g|20180321|\n33YTVXN8080T1ZA|New Auto Components|A|P|a|4|20220926|\n33OGPXG5513K1ZI|Ganesh Stationers|A|P|a|3|20170902|\n19CAEXG4917L1ZZ|Ganga Woodcraft LLP|A|L|d|a|20200929|d\n32RJBXC9356L1Z9|City Bakers|A|P|5|9|20200322|3\n32VBCXP0902X1ZA|Pearl Polymers|A|P|5|9|20181029|p\n09WPOXN9717M1ZU|Neelgiri Medicals|A|P|c|b|20210404|m\n37CFXXS7895Q1Z3|Saffron Bakers|A|P|0|l|20230817|3\n23LVJXH4494W1ZU|Harmony Fashions|S|P|6|2|20230110|\n36WKUXP4377D1ZK|Prime Classes Pvt Ltd|A|C|b|6|20220118|\n33BJAXV0229P1ZJ|Vindhya Bakers|A|P|a|4|20250419|3\n23VJOXR7009B1ZB|Royal Design Studio Pvt Ltd|A|C|6|2|20160720|\n29OCCXR9105P1Z3|Riddhi Boutique|A|P|4|1|20240316|\n27OWHXP7041N1Z4|Pearl Printers Pvt Ltd|A|C|7|d|20230522|r\n27VFNXA1927F1ZN|Amrit Physio Clinic Pvt Ltd|A|C|7|d|20190209|o\n08FUVXS6902M1Z2|Sai Physio Clinic|A|P|9|8|20210125|\n27EQEXS5464E1Z2|Saffron General Store|A|P|7|i|20250621|\n19VITXN0385W1ZT|Navkar Insurance Advisors|C|P|d|a|20160724|\n27SDZXS4678O1Z3|Saffron & Associates|A|P|7|f|20170501|7\n23LANXS5898U1ZG|Star Woodcraft Pvt Ltd|A|C|6|7|20190502|\n33YYBXE8697K1ZW|Evergreen Boutique|A|P|a|3|20170329|5\n27TWQXN8335C1Z8|Navkar Hardware|A|P|7|i|20240809|f\n23AQVXH9882N1ZB|Harmony Packaging Pvt Ltd|A|C|6|2|20200910|l\n32KCQXC5674P1ZB|City Fashions|A|P|5|9|20171210|0\n29WSQXN1072E1ZH|Neelgiri Diagnostics|A|P|4|1|20220511|\n33ICVXG5453M1ZF|Ganga Kids Academy Pvt Ltd|A|C|a|3|20220312|\n29EVPXS1919N1Z2|Sahyadri Boutique|A|P|4|1|20230602|5\n08EKEXK6055R1ZY|Krishna Fitness LLP|A|L|9|8|20210127|\n37GNRXR4089P1Z3|Royal Unisex Salon|A|P|0|l|20180816|\n29MLGXS2778K1ZI|Star Kids Academy|A|P|4|1|20190727|q\n07YZQXS8772V1ZI|Sahyadri Sweets|S|P|2|5|20190910|\n33WHBXO2731A1Z1|Orbit Mobile Care|A|P|a|4|20180115|j\n27HJCXC8336M1ZD|Coral Stationers|A|P|7|f|20221203|v\n29QTYXV2356E1Z0|Vindhya General Store|A|P|4|1|20220518|\n27PESXG2143J1ZH|Galaxy Medicals|A|P|7|g|20170822|\n29NDNXK5038W1ZK|Kaveri Packaging|A|P|4|e|20190422|l\n33SOAXG6361H1ZB|Ganga Tours & Travels LLP|C|L|a|3|20210904|\n27ONMXM5235D1Z5|Metro Physio Clinic Pvt Ltd|A|C|7|d|20250310|\n27BRVXZ4095L1ZZ|Zenith Bake House|A|P|7|d|20211003|4\n08ZGKXM4021B1ZP|Modern Bake House Pvt Ltd|A|C|9|8|20170117|4\n23QWBXA5503S1ZQ|Amrit Hardware|A|P|6|7|20160907|f\n27RPUXR4564Z1Z6|Riddhi Physio Clinic Pvt Ltd|A|C|7|d|20190804|\n27YXJXU4143W1Z6|Unity Bake House|A|P|7|d|20180709|4\n10QXFXP6037U1Z1|Pearl Mobile Care|A|P|1|h|20250625|\n10QFNXT1832Z1ZN|Trinity Fitness|C|P|1|h|20210511|e\n33QHMXM9288Y1ZV|Moonlight General Store|A|P|a|3|20170621|\n27QKFXK0552T1ZR|Kaveri Packaging|A|P|7|d|20200815|l\n23IFXXB8440L1ZE|Balaji Unisex Salon|A|P|6|7|20170719|\n29GVAXK7275X1ZQ|Kaveri Bakers|A|P|4|e|20240809|\n27LVZXZ4515W1Z2|Zenith Sweets|A|P|7|d|20240708|\n27IKHXR3909M1ZX|Royal Kids Academy|A|P|7|i|20171017|q\n27WIBXB4519D1ZS|Balaji Mobile Care|A|P|7|d|20201208|j\n09JSGXZ8102F1ZR|Zenith Sweets|A|P|c|b|20250904|\n27KWDXN2125F1Z4|New & Associates LLP|A|L|7|d|20230128|7\n03QCBXR4864L1ZG|Riddhi Printers LLP|A|L|8|c|20201228|r\n24JWEXR8288T1ZL|Riddhi Stationers|A|P|3|0|20241118|\n33GNQXU7485G1ZM|Unity General Store|A|P|a|3|20200909|h\n07JKDXZ9634G1ZX|Zenith Boutique|A|P|2|5|20240308|\n19ZLUXG4644U1ZR|Ganesh Stationers|A|P|d|a|20181027|\n37CHYXN8628E1Z3|New Stationers|A|P|0|l|20171029|v\n27WVUXG7405J1Z2|Green Leaf Electronics|A|P|7|f|20200830|\n07CUDXH6618C1ZG|Harmony Legal Associates LLP|A|L|2|5|20180620|i\n23GTWXN5858W1ZI|New Pharma Retail Pvt Ltd|A|C|6|7|20230121|n\n27QCMXC3940E1ZY|Coral Opticals|A|P|7|i|20171024|k\n27KTXXN9554T1ZA|New Boutique|A|P|7|f|20160806|\n33MWBXU7113K1ZN|Unity Legal Associates|C|P|a|3|20220820|i\n08RSNXK3007P1ZE|Krishna Boutique|A|P|9|8|20180410|\n36PDHXS3828F1ZI|Star Unisex Salon|A|P|b|6|20170928|\n07HLPXG2107H1ZO|Galaxy Bakers|A|P|2|5|20210101|\n24MCLXS3939G1ZI|Sai Kitchens|A|P|3|k|20250927|\n29UDUXN8508Q1ZA|New Boutique|A|P|4|1|20161119|\n07WCVXM0441O1Z0|Metro Insurance Advisors|A|P|2|5|20200906|g\n27PVYXN8250N1ZL|New Boutique|A|P|7|d|20200216|\n03NRTXA5804T1ZH|Apex & Associates|A|P|8|c|20200528|7\n27MDQXN2390L1Z4|Navkar Woodcraft Pvt Ltd|A|C|7|d|20230826|d\n29MGOXM0975I1Z0|Modern Stays|A|P|4|1|20171127|6\n23MAYXA5570F1ZW|Annapurna Sweets|A|P|6|2|20210308|\n32TGOXP5998D1ZX|Pearl Foods|A|P|5|9|20250213|c\n36ALZXG8543R1ZF|Galaxy & Associates LLP|A|L|b|6|20210227|7\n27VLJXH3964U1Z3|Harmony Diagnostics|A|P|7|d|20250921|a\n33IMAXC0437D1ZC|Coral Classes LLP|A|L|a|3|20231210|8\n08QFLXZ8438Q1Z6|Zenith Printers Pvt Ltd|A|C|9|8|20230523|r\n24FCEXC6029Q1ZW|City Stays|A|P|3|j|20200608|6\n10HCYXS9935O1ZU|Sunrise Design Studio Pvt Ltd|A|C|1|h|20241107|1\n36XISXC1520S1ZS|City Tours & Travels|A|P|b|6|20230702|\n36LDQXH5053V1ZU|Harmony Bake House LLP|A|L|b|6|20240514|\n24GDDXM6837G1ZX|Metro Medicals|A|P|3|0|20220925|m\n27RIXXO8920N1Z8|Om Opticals|C|P|7|g|20170505|k\n37AQFXA6813G1ZN|Apex Physio Clinic Pvt Ltd|A|C|0|l|20220902|o\n27TSLXS6694S1Z9|Star & Associates|A|P|7|i|20201121|\n24EPLXB2783J1Z9|Balaji Medicals|A|P|3|0|20230309|\n09MGHXS6493K1ZQ|Silver Oak Mobile Care|A|P|c|b|20221101|j\n27OQDXC9059S1Z9|Classic Sweets|A|P|7|d|20240903|\n24HJIXS3251C1ZU|Sunrise Textiles Pvt Ltd|S|C|3|j|20251124|x\n08ODKXC4819H1ZQ|City Legal Associates Pvt Ltd|A|C|9|8|20190617|\n27NSBXU5596A1ZP|Unity Stays|A|P|7|f|20221226|\n23IWZXS3904I1ZB|Sahyadri Electronics Pvt Ltd|A|C|6|7|20211028|\n29LXLXK7129L1Z1|Krishna Tours & Travels|A|P|4|1|20190528|y\n08WRAXG7926T1Z0|Green Leaf Printers|A|P|9|8|20220822|\n07SMBXC7072M1Z0|Coral Opticals|A|P|2|5|20221209|k\n07TQUXC0519D1Z5|Coral General Store|C|P|2|5|20250910|\n27EAZXS4220R1Z3|Sai Kitchens|A|P|7|d|20211118|\n36FUSXM2558K1ZC|Metro Boutique|A|P|b|6|20240206|\n23TZGXA0147F1Z5|Amrit Realty Pvt Ltd|A|C|6|2|20220609|s\n03QPDXG1322J1ZN|Ganga Bakers|A|P|8|c|20250705|3\n29UKTXG9637A1ZS|Green Leaf Classes|A|P|4|1|20190217|\n23ZLIXL5010A1ZS|Lakshmi Diagnostics|A|P|6|7|20250701|\n07JGZXK7041B1ZK|Kaveri Auto Components|A|P|2|5|20170522|2\n27XOSXK8022K1ZC|Krishna Hardware|A|P|7|f|20190220|\n03JJAXC3468E1Z5|Classic Textiles LLP|A|L|8|c|20201209|x\n27PDXXB2776W1ZE|Blue Lotus Fashions LLP|A|L|7|f|20200525|\n36NODXN6008L1ZZ|Neelgiri Unisex Salon|A|P|b|6|20190927|u\n19PXVXK7984P1Z1|Krishna Mobile Care|A|P|d|a|20170523|\n27RFOXE4314S1Z0|Evergreen Physio Clinic Pvt Ltd|A|C|7|d|20200118|\n27YUAXG5290N1Z7|Green Leaf Boutique|A|P|7|g|20171110|\n07TJDXZ5758Z1ZL|Zenith & Associates|A|P|2|5|20250711|7\n23FMDXA6095F1ZT|Apex Opticals|A|P|6|7|20251023|\n27IWQXO1745D1ZO|Om & Associates LLP|A|L|7|f|20160711|7\n07BWUXC2395V1ZW|City Medicals|A|P|2|5|20190821|\n33ZZPXP7700E1Z7|Prime Classes LLP|A|L|a|3|20180909|\n33KBWXC3997X1ZJ|Coral Fitness|A|P|a|3|20171220|e\n33IMEXM1200W1Z8|Moonlight Stays|A|P|a|4|20200117|\n23ZPCXN1067E1Z7|Neelgiri Boutique|A|P|6|7|20191101|\n27REPXT6041E1ZB|Trinity General Store|A|P|7|i|20240726|\n36ENOXZ2251P1ZI|Zenith Tours & Travels|A|P|b|6|20210115|y\n27NVRXN1766N1ZV|New Physio Clinic|A|P|7|i|20220911|o\n36EWDXN6759Q1Z0|Neelgiri Diagnostics|C|P|b|6|20210329|a\n10FRCXK0697C1ZR|Krishna Kitchens Pvt Ltd|A|C|1|h|20231117|t\n29BSWXS2459S1ZP|Shree Mobile Care|A|P|4|1|20161020|\n29IDBXS9706M1Z6|Saffron Sweets|A|P|4|e|20251020|w\n32JMTXT9464Y1ZL|Trinity Stays Pvt Ltd|A|C|5|9|20191230|\n27CHBXA8978X1ZO|Amrit Stays Pvt Ltd|A|C|7|f|20200628|6\n36PEXXO2328C1ZH|Om Kids Academy|A|P|b|6|20200712|\n33LTBXS2772R1ZB|Saffron Boutique|A|P|a|4|20170821|5\n27QFAXS9539I1Z0|Saffron & Associates LLP|C|L|7|i|20220513|7\n27CNNXS9089T1ZT|Star Unisex Salon|A|P|7|i|20221228|\n24VPNXS3642F1ZQ|Star Fashions LLP|A|L|3|j|20170328|0\n33OGOXN9214V1ZK|Neelgiri Kitchens|A|P|a|3|20220424|t\n07PUUXS9185Y1ZQ|Silver Oak Tours & Travels|A|P|2|5|20161116|y\n08QDJXG4615C1Z1|Ganesh Mobile Care|A|P|9|8|20190113|\n27KRIXS7106J1ZO|Sunrise Design Studio LLP|A|L|7|f|20221216|\n29GPGXM8702U1ZA|Moonlight Fitness Pvt Ltd|A|C|4|1|20190902|e\n24LOQXA6086J1ZW|Amrit Design Studio|A|P|3|k|20230523|1\n33IBMXO2799Z1ZH|Om Mobile Care|A|P|a|4|20191201|\n36ZQKXT9581O1ZG|Trinity Foods|A|P|b|6|20201116|c\n23DPGXM3933Z1ZG|Modern Mobile Care|A|P|6|7|20190515|j\n24EFOXC3249C1ZA|City Design Studio Pvt Ltd|A|C|3|k|20170823|\n23VZZXK6292W1ZT|Krishna Fitness Pvt Ltd|A|C|6|2|20170628|\n24SFNXK0657S1ZU|Kaveri Woodcraft|A|P|3|0|20230923|\n27GVMXU9097U1Z6|Unity Bakers|C|P|7|d|20220727|3\n08ETAXM9379L1ZD|Modern General Store|A|P|9|8|20250520|h\n07TNLXE8271O1ZE|Evergreen Electronics|A|P|2|5|20171024|b\n07BTEXB7712B1ZT|Balaji Classes|A|P|2|5|20220510|\n37FZTXE8889Z1ZR|Evergreen & Associates|A|P|0|l|20180712|7\n10WRMXS0084H1ZT|Shree Design Studio Pvt Ltd|A|C|1|h|20160901|1\n27XCMXN7000Q1Z0|New Kids Academy Pvt Ltd|A|C|7|i|20180427|q\n08YAIXE4604L1ZM|Evergreen Boutique|S|P|9|8|20171002|\n23VSDXB0046G1ZJ|Balaji Diagnostics Pvt Ltd|A|C|6|7|20221221|\n33MZIXN0695Q1ZW|New Legal Associates Pvt Ltd|A|C|a|3|20220130|i\n37ZCQXT2261P1ZK|Trinity Fitness|S|P|0|l|20200518|\n24ASZXP9730R1ZY|Pearl Tours & Travels|A|P|3|k|20171203|\n33XGUXM9012L1ZU|Moonlight Pharma Retail|A|P|a|4|20250423|\n08ZDQXS6714R1ZA|Silver Oak Hardware|A|P|9|8|20161004|\n03PIHXO6887X1Z2|Orbit Legal Associates Pvt Ltd|A|C|8|c|20210903|\n33FAYXS9296L1ZS|Sai Electronics|A|P|a|3|20230409|b\n07HBIXK4506C1ZF|Kaveri Insurance Advisors Pvt Ltd|A|C|2|5|20250227|\n27AVGXE8733C1ZA|Evergreen Electronics|A|P|7|i|20240206|\n33ATSXC2573Q1ZO|Classic Bake House Pvt Ltd|A|C|a|3|20240629|4\n07YMAXO4062T1ZD|Om Hardware|A|P|2|5|20171007|\n27PLMXK2822T1ZI|Krishna Hardware|A|P|7|d|20231204|\n24TXWXH5268N1ZN|Harmony Classes LLP|A|L|3|j|20180405|8\n33CIHXN7129U1ZY|New Bake House|A|P|a|4|20211128|4\n27SAGXO1407J1ZT|Om Stationers|A|P|7|d|20230214|v\n27RGZXO7235I1ZN|Orbit Diagnostics LLP|A|L|7|d|20230718|\n10JVFXC7589W1Z2|Classic Fitness|A|P|1|h|20250225|e\n07IOOXS9416J1ZJ|Star Stationers|A|P|2|5|20211210|\n29SOOXN0812F1ZZ|Neelgiri Opticals|A|P|4|1|20251112|\n10QWTXG4335W1ZX|Green Leaf Tours & Travels Pvt Ltd|A|C|1|h|20180930|y\n09BNDXL1317U1Z0|Lakshmi Design Studio LLP|S|L|c|b|20231003|1\n10AXTXC9456Y1ZV|Coral Boutique|A|P|1|h|20200721|\n33LMLXK5967M1ZM|Krishna Stationers|A|P|a|4|20161124|\n33EQXXS0871Y1ZS|Shree Bakers|A|P|a|3|20220428|\n27JUNXR6860I1Z6|Riddhi Polymers|A|P|7|d|20240217|\n23NLCXS4457K1Z1|Sahyadri Unisex Salon|A|P|6|7|20190313|\n27BPWXR5270S1Z1|Royal Unisex Salon|A|P|7|g|20250130|\n07LXJXN1310J1ZV|New Bake House Pvt Ltd|A|C|2|5|20180826|4\n29LIVXB9114F1ZA|Balaji Realty Pvt Ltd|C|C|4|1|20220621|s\n27TOUXH1167P1Z7|Harmony Mobile Care|A|P|7|d|20220330|j\n27IPGXN6526H1Z0|New Bakers|A|P|7|f|20230507|3\n29SDKXM2311F1ZT|Modern Design Studio|A|P|4|e|20220524|1\n07TSNXS3433J1ZC|Shree & Associates|A|P|2|5|20250612|7\n24EGSXZ5705L1Z1|Zenith Pharma Retail|A|P|3|j|20170804|n\n23KUQXS1516S1Z6|Saffron Design Studio|A|P|6|2|20250220|1\n07TWVXZ0688A1ZX|Zenith Woodcraft|A|P|2|5|20251005|\n32TGHXZ0649E1ZE|Zenith Fitness Pvt Ltd|A|C|5|9|20211222|e\n19UFMXA1636E1ZQ|Amrit Tours & Travels LLP|A|L|d|a|20230823|y\n10WOTXR8077T1ZN|Riddhi Hardware|A|P|1|h|20230524|\n24GQLXR6356K1ZM|Riddhi Dental Care Pvt Ltd|A|C|3|k|20240906|9\n03SDUXK4640O1Z4|Krishna Sweets|A|P|8|c|20220718|w\n29XAXXA4692F1Z5|Annapurna Insurance Advisors Pvt Ltd|A|C|4|1|20250525|g\n24INOXG5008Q1ZZ|Ganesh Diagnostics|S|P|3|0|20181110|a\n27POTXC8320F1Z1|Classic Physio Clinic|A|P|7|d|20240812|o\n29FFRXB4499B1ZL|Blue Lotus Pharma Retail Pvt Ltd|A|C|4|1|20161220|\n29LHUXZ1023K1ZV|Zenith Bakers|A|P|4|1|20240917|\n32PHMXB6593J1Z9|Balaji Unisex Salon|A|P|5|9|20240113|u\n23ZUNXB8595J1Z0|Blue Lotus Polymers|A|P|6|2|20250411|\n36ONIXS6170Q1Z9|Sahyadri Electronics|A|P|b|6|20190427|b\n27QMWXA4852W1ZZ|Apex Design Studio LLP|A|L|7|i|20211216|1\n19DZVXS5636C1Z7|Sunrise Bake House Pvt Ltd|A|C|d|a|20180925|4\n27SWYXZ2694M1Z2|Zenith Unisex Salon|A|P|7|d|20190501|u\n33DPEXM1306H1ZV|Metro Dental Care Pvt Ltd|A|C|a|3|20190218|\n29CWXXM4329L1Z2|Modern Polymers|A|P|4|1|20181107|p\n27OIAXA8512F1ZX|Annapurna Stays|A|P|7|g|20210625|\n29EYGXR2552B1ZW|Royal Sweets|A|P|4|1|20250827|w\n27EPFXM9832P1ZI|Modern Auto Components LLP|A|L|7|i|20161018|2\n24BGSXS6604C1ZU|Saffron Bakers|A|P|3|k|20230328|3\n32OUZXN1062E1ZR|New Mobile Care|A|P|5|9|20201031|j\n24RVGXK4218N1ZI|Kaveri Diagnostics|A|P|3|0|20220819|a\n33KMWXA0761E1ZL|Apex Bakers|A|P|a|4|20240117|3\n27KJOXS8887B1ZP|Silver Oak Bakers|A|P|7|d|20190326|\n19TDBXP0139O1ZA|Pearl Electronics Pvt Ltd|A|C|d|a|20160809|b\n08YOXXK3084W1ZE|Kaveri Stationers|A|P|9|8|20220618|v\n27GWMXO8833B1ZN|Orbit Legal Associates Pvt Ltd|A|C|7|d|20170603|\n36DEPXE9489K1Z2|Evergreen Legal Associates|A|P|b|6|20190329|i\n07WMJXC4558B1ZA|Classic Auto Components Pvt Ltd|S|C|2|5|20220829|2\n36KXJXN2100W1Z7|New Fitness|C|P|b|6|20210819|e\n24BCSXS0333B1ZE|Star Mobile Care|A|P|3|0|20240413|j\n29LPIXM3506B1ZE|Moonlight Printers|A|P|4|1|20250502|r\n29JOTXG6629V1ZU|Galaxy Diagnostics LLP|A|L|4|1|20250426|\n33QQUXC9415O1ZD|Coral Unisex Salon|A|P|a|4|20220814|u\n27SZFXA2472P1Z6|Annapurna Medicals|A|P|7|i|20210217|\n23LDZXK9261U1ZH|Kaveri Tours & Travels Pvt Ltd|A|C|6|7|20200826|y\n33ORJXP0193O1ZI|Pearl Stays|A|P|a|4|20240524|6\n23GGPXL9236I1ZE|Lakshmi Stays Pvt Ltd|A|C|6|2|20230405|\n24WDBXC9415R1ZA|City Unisex Salon|A|P|3|k|20250628|u\n37DRYXH3271I1ZP|Harmony Stays LLP|A|L|0|l|20170207|6\n37HRHXH4883M1ZI|Harmony Bakers|C|P|0|l|20220831|3\n07YCIXL8012B1ZW|Lakshmi Medicals|A|P|2|5|20170601|m\n27BZMXB0571K1ZT|Balaji Fitness|A|P|7|g|20161102|\n09DDHXS8383R1ZQ|Sunrise Polymers|A|P|c|b|20210609|p\n09WFYXG0817L1ZV|Ganesh Legal Associates|A|P|c|b|20181126|\n24UYFXS3386W1Z9|Sahyadri Kids Academy Pvt Ltd|A|C|3|k|20161208|q\n07JCAXT6165I1ZM|Trinity Unisex Salon|A|P|2|5|20190624|u\n07HUFXO3197I1ZL|Om Stationers|A|P|2|5|20250828|v\n23YYZXG9671J1ZH|Green Leaf Tours & Travels Pvt Ltd|A|C|6|2|20250704|\n19TMTXU5142Y1ZF|Unity & Associates|A|P|d|a|20210819|7\n33ZHNXR0543X1ZA|Riddhi Sweets|A|P|a|4|20161209|w\n19AUSXC6583S1ZY|Coral Classes|A|P|d|a|20160818|\n33JXMXS3318N1ZA|Saffron Electronics LLP|A|L|a|3|20180210|\n29JZJXS6747B1Z8|Silver Oak Fashions LLP|A|L|4|1|20190217|\n27VDOXS3065T1ZE|Sunrise Tours & Travels LLP|S|L|7|f|20170419|\n08QJNXP8706A1Z7|Prime General Store|A|P|9|8|20160531|\n32BXNXZ2292K1ZB|Zenith Insurance Advisors Pvt Ltd|A|C|5|9|20241005|g\n09VXRXK9975W1ZJ|Krishna Unisex Salon|A|P|c|b|20231125|\n07IOIXS3755W1Z1|Shree Physio Clinic|A|P|2|5|20231029|o\n32IKJXG1988B1ZR|Ganga Auto Components|A|P|5|9|20220219|2\n19FZXXO6653R1Z9|Om Classes LLP|A|L|d|a|20200616|8\n19TVWXS5492J1ZD|Sunrise Legal Associates|A|P|d|a|20230307|\n03CBXXA7553N1ZN|Annapurna Medicals|A|P|8|c|20190410|m\n23FWQXS3452K1ZG|Sunrise Electronics|A|P|6|7|20241224|b\n36JQBXB2185Z1ZF|Blue Lotus General Store|A|P|b|6|20250802|\n27USJXC4303U1ZC|Coral Design Studio|A|P|7|i|20200803|\n33NXSXO9880L1ZL|Om Pharma Retail|A|P|a|4|20220423|\n37XJKXC1197W1Z7|Classic Polymers|A|P|0|l|20161107|p\n29YKPXZ1126S1ZW|Zenith Physio Clinic Pvt Ltd|A|C|4|1|20181110|o\n19EOWXM5501Y1Z0|Modern Kids Academy|A|P|d|a|20180602|q\n24RCIXA7423G1Z3|Amrit Legal Associates|A|P|3|k|20210301|i\n27AXPXN2622B1Z6|Neelgiri Design Studio LLP|A|L|7|i|20230121|\n29KNPXM3613P1ZJ|Metro Mobile Care|A|P|4|1|20170921|\n07SAZXM6169T1Z9|Moonlight Foods|A|P|2|5|20170406|c\n19UQOXS3936O1ZR|Shree Printers|A|P|d|a|20210128|r\n07GJSXR4890J1ZO|Riddhi Hardware|A|P|2|5|20240727|\n29DQHXB7760O1ZP|Balaji Unisex Salon|A|P|4|1|20210521|\n09MFBXM7986A1ZH|Modern Tours & Travels Pvt Ltd|A|C|c|b|20240805|y\n23FKPXZ8016B1ZF|Zenith Fashions Pvt Ltd|A|C|6|2|20210112|\n32SLDXB6958A1ZO|Balaji Electronics|A|P|5|9|20250126|b\n23UVHXG5337G1ZT|Green Leaf Boutique|C|P|6|7|20160704|5\n09RKXXR1896I1Z4|Royal Fashions LLP|C|L|c|b|20250603|0\n07ZHWXG1172M1ZQ|Green Leaf Classes|A|P|2|5|20200404|8\n29VRXXK0945W1ZB|Kaveri Realty Pvt Ltd|A|C|4|1|20220213|s\n27NQDXP2892H1ZP|Pearl Realty LLP|A|L|7|d|20211214|\n19EDYXM7409S1ZM|Moonlight Hardware|A|P|d|a|20180430|\n33QVIXZ5064T1ZL|Zenith Pharma Retail|A|P|a|4|20221025|\n24XOEXA0332O1Z9|Annapurna Bakers|A|P|3|k|20210209|3\n36GZSXC6728S1ZR|Coral Electronics|A|P|b|6|20210913|\n19XVJXA9750M1ZX|Amrit Auto Components|A|P|d|a|20191214|2\n27OEVXV5920I1ZV|Vindhya Insurance Advisors Pvt Ltd|A|C|7|d|20190914|\n23KRVXK6997E1ZD|Kaveri Stationers|A|P|6|2|20240415|\n33MNPXM2567K1ZR|Modern Legal Associates|C|P|a|3|20190809|\n24WAZXP6471P1ZH|Pearl Kitchens LLP|A|L|3|k|20190716|t\n27ATFXR4517W1Z7|Riddhi Stays LLP|A|L|7|d|20221230|\n24JRUXG3834F1Z1|Galaxy Insurance Advisors|A|P|3|k|20240311|\n10XMRXS9638P1ZY|Silver Oak Fitness|A|P|1|h|20240411|e\n23ZVDXO9006U1ZT|Orbit Packaging LLP|A|L|6|2|20241223|l\n10XZOXP9766K1ZJ|Pearl Unisex Salon|A|P|1|h|20190224|\n19YELXO9572X1ZP|Orbit Opticals|A|P|d|a|20190625|k\n37TQMXP5087C1ZI|Prime Unisex Salon|A|P|0|l|20220429|u\n37DOUXS6223H1ZT|Sunrise Insurance Advisors LLP|A|L|0|l|20201127|\n27DSAXO9692U1ZW|Orbit Unisex Salon|C|P|7|i|20250706|\n33NPRXS0953T1Z2|Sai General Store|A|P|a|4|20180813|\n29CRUXO4513U1Z1|Om Kids Academy|A|P|4|e|20190521|\n19WBMXS8296N1Z9|Sunrise Stays|A|P|d|a|20160617|6\n23VRTXA4613V1Z6|Apex Mobile Care|A|P|6|2|20171114|\n36CQJXS8593P1Z1|Silver Oak Legal Associates|A|P|b|6|20200721|i\n09JQZXS3762Z1Z6|Silver Oak Diagnostics LLP|A|L|c|b|20241122|\n08RJLXB0492W1ZI|Blue Lotus Design Studio|A|P|9|8|20210921|\n10HJDXN9203T1ZA|New Legal Associates Pvt Ltd|A|C|1|h|20250418|\n19FKVXG9938M1ZD|Galaxy Fitness Pvt Ltd|A|C|d|a|20201105|e\n33EGVXB9729Q1ZX|Balaji Packaging Pvt Ltd|A|C|a|3|20240124|l\n29NRVXC5310P1ZE|Coral Physio Clinic Pvt Ltd|A|C|4|1|20160716|\n19EMNXG5269C1ZB|Galaxy & Associates|A|P|d|a|20170530|7\n07TFRXS0158K1ZX|Saffron Diagnostics LLP|A|L|2|5|20200126|a\n36HSZXS0034J1ZK|Sahyadri Realty|A|P|b|6|20191218|s\n10CBPXP8715T1ZB|Pearl Fashions Pvt Ltd|A|C|1|h|20240429|0\n29IBOXO5089D1ZG|Om Opticals|A|P|4|1|20250122|\n36FGNXM1236Y1ZT|Moonlight Medicals|A|P|b|6|20180320|m\n33MEGXE0952T1ZG|Evergreen Mobile Care|A|P|a|3|20170107|\n27AAVXC5262X1Z3|Classic Mobile Care|A|P|7|i|20250714|\n27UTKXG3826A1Z0|Green Leaf Boutique|C|P|7|f|20250331|\n07UVFXL3977G1ZA|Lakshmi Stays Pvt Ltd|A|C|2|5|20220416|\n24CVGXG9103N1ZZ|Green Leaf Stationers|A|P|3|k|20231023|\n27SJHXO0722G1ZG|Om Unisex Salon|A|P|7|d|20231011|u\n27JJKXN7586M1ZI|Navkar Stays|A|P|7|d|20160601|6\n23FQAXT4985S1ZB|Trinity Kids Academy Pvt Ltd|A|C|6|2|20200622|\n08NEUXP6031A1ZO|Pearl General Store|A|P|9|8|20180502|h\n29YUDXR4531L1Z3|Royal & Associates|A|P|4|1|20180209|7\n29SYZXB4461M1ZO|Balaji Hardware|A|P|4|1|20170126|\n27IMDXM5227T1ZP|Metro Insurance Advisors Pvt Ltd|A|C|7|g|20170730|g\n36METXT3414F1ZG|Trinity Kids Academy|A|P|b|6|20240211|q\n29JRHXB6229F1Z6|Blue Lotus Medicals|A|P|4|1|20171019|\n29OBDXC4034Y1Z7|Classic Medicals|A|P|4|1|20171002|\n09SVGXG9545A1ZO|Green Leaf Electronics|A|P|c|b|20170607|b\n29ZXCXV1634C1ZE|Vindhya Physio Clinic|A|P|4|e|20190916|o\n29AMZXM8441D1ZY|Moonlight General Store|A|P|4|e|20220928|h\n27DMJXS0727G1ZE|Saffron Boutique|A|P|7|d|20160611|\n24BVPXS5949I1ZB|Sai Bakers|A|P|3|j|20230623|3\n23KDYXC7289J1Z5|Classic Fitness|A|P|6|2|20190304|\n33CGRXM6036R1Z4|Modern Bakers|A|P|a|3|20220604|3\n33ISPXS1928R1Z6|Saffron Electronics Pvt Ltd|A|C|a|3|20200611|\n33MTFXN5653R1Z9|New Legal Associates|A|P|a|4|20210411|i\n24JKCXB1019P1ZS|Blue Lotus Legal Associates|A|P|3|0|20181218|i\n29FVQXB7146P1Z6|Balaji Stays|C|P|4|1|20190518|\n24NRQXC1886D1Z1|Coral Medicals|A|P|3|j|20180314|\n07UZSXG8384S1Z2|Ganga Hardware|A|P|2|5|20230712|\n32YHWXO1221B1ZN|Om Mobile Care|A|P|5|9|20190524|\n36WMWXC1951K1ZM|City Bakers|A|P|b|6|20170111|\n27MDOXK4890W1ZE|Kaveri Sweets|A|P|7|d|20170820|w\n32HJAXR7770B1ZS|Riddhi Classes Pvt Ltd|A|C|5|9|20200811|8\n23QAHXG2937L1ZT|Green Leaf Fitness|A|P|6|7|20190108|e\n23ITFXB2826J1ZD|Balaji Realty|A|P|6|2|20240120|\n27NTLXA6526V1Z2|Amrit Stays|A|P|7|f|20220613|6\n23MAZXM3771Y1ZH|Metro Electronics Pvt Ltd|A|C|6|2|20250915|b\n27AGSXC8732N1Z9|City & Associates|C|P|7|d|20241227|7\n32SLNXL3574K1ZT|Lakshmi Mobile Care|A|P|5|9|20240201|\n27FZAXG2949S1Z6|Ganga Foods LLP|A|L|7|g|20191224|c\n27SXJXS1998E1ZY|Sai Woodcraft LLP|S|L|7|i|20180413|d\n19TBUXM9696J1ZC|Modern Design Studio|A|P|d|a|20250626|1\n29NORXA3515H1Z4|Apex Unisex Salon|S|P|4|1|20220713|\n27GWKXN7303I1ZO|Neelgiri Boutique|A|P|7|d|20201126|\n36LFGXU3603V1ZV|Unity Fitness LLP|A|L|b|6|20220105|\n24TPQXL3512G1Z1|Lakshmi Boutique|A|P|3|k|20220816|\n36IIHXB6100F1Z8|Balaji Electronics Pvt Ltd|A|C|b|6|20171229|\n24WRAXM3821G1Z5|Metro Bakers|A|P|3|k|20170614|3\n24YDSXR4230N1ZX|Royal Unisex Salon|A|P|3|j|20200213|u\n27DXEXK7993Q1ZU|Krishna Packaging|A|P|7|i|20171220|l\n24NNQXB4712S1ZS|Blue Lotus Pharma Retail|A|P|3|k|20201210|n\n29GWQXS2013H1ZN|Sunrise Fashions|A|P|4|e|20190607|0\n27NVSXK2881X1ZB|Krishna Boutique|A|P|7|d|20201128|\n37YXJXR2223L1Z1|Royal Fitness|A|P|0|l|20251025|e\n33QPWXG1005U1ZJ|Green Leaf Pharma Retail|A|P|a|4|20191026|n\n10PKFXG3113G1Z7|Galaxy Classes Pvt Ltd|A|C|1|h|20240330|\n29JWKXN2051W1ZU|Neelgiri Kitchens|A|P|4|1|20210123|t\n03MTGXN7717R1ZA|Navkar Sweets|C|P|8|c|20250718|\n24UITXA8543U1ZC|Amrit Diagnostics Pvt Ltd|A|C|3|0|20230804|a\n29UYSXS8456Y1ZD|Star Bakers|A|P|4|1|20190916|3\n29LBFXP0665O1ZA|Pearl Opticals|A|P|4|1|20240609|\n27CSTXT3119C1Z0|Trinity Insurance Advisors LLP|A|L|7|g|20180613|g\n27RTHXZ8654F1Z1|Zenith Stationers|A|P|7|d|20230121|v\n09NCIXS3154G1ZL|Saffron & Associates|C|P|c|b|20200921|7\n09OYRXZ4743E1ZU|Zenith Stays LLP|A|L|c|b|20221203|6\n27CNJXG4243Y1ZL|Ganesh Unisex Salon|A|P|7|g|20200908|\n29OJCXH9419E1ZC|Harmony Fitness|S|P|4|e|20171012|\n19ZLNXM1545V1ZW|Modern Bake House|A|P|d|a|20210926|\n27VJVXR8516W1ZJ|Royal Diagnostics|A|P|7|f|20201104|\n33PIRXS7509R1ZC|Silver Oak Insurance Advisors|A|P|a|3|20200816|g\n07OMFXS2887S1Z3|Silver Oak Opticals|A|P|2|5|20240621|k\n27SBYXA9592L1ZP|Apex Electronics Pvt Ltd|A|C|7|f|20200322|b\n37UPWXM9304Z1Z9|Modern Boutique|A|P|0|l|20221010|\n32NREXU0571L1ZT|Unity Packaging Pvt Ltd|A|C|5|9|20250224|l\n27OJSXA1122X1ZS|Annapurna Classes|A|P|7|f|20250528|\n33FMAXC9616Q1Z9|Classic Bake House|A|P|a|3|20190705|4\n23TNKXU2583A1Z3|Unity Woodcraft|C|P|6|2|20210414|d\n09TSDXA3498X1ZR|Apex Stays LLP|A|L|c|b|20220117|\n32ECDXN0414O1Z9|Navkar Insurance Advisors Pvt Ltd|A|C|5|9|20220824|g\n32LQMXP7323Q1ZG|Prime Kitchens|A|P|5|9|20250919|t\n07AFRXH6302F1Z4|Harmony Electronics LLP|A|L|2|5|20230207|b\n27APLXK3852H1Z7|Kaveri & Associates LLP|A|L|7|d|20161217|\n27YRJXT2376S1ZK|Trinity Kids Academy LLP|A|L|7|d|20201112|q\n27BXHXM8238N1Z9|Metro Electronics Pvt Ltd|A|C|7|i|20180403|\n33AXNXO4248W1ZX|Orbit Opticals|A|P|a|3|20171030|\n23JLSXV2165B1ZC|Vindhya Opticals|A|P|6|2|20200319|\n29PJEXP8493V1ZU|Prime Legal Associates|C|P|4|1|20250112|i\n27TQHXM6668W1ZH|Modern Unisex Salon|A|P|7|d|20250612|\n23LUPXA4438Q1ZH|Amrit Opticals|A|P|6|7|20220820|\n24YEHXG0361S1Z7|Green Leaf Opticals|A|P|3|j|20210418|k\n36BKUXU4110M1Z2|Unity Foods Pvt Ltd|A|C|b|6|20180312|c\n32EJPXS5648M1ZV|Sai Opticals|A|P|5|9|20210430|k\n23DJQXG3873K1ZB|Ganga Fashions|A|P|6|2|20180801|0\n33CWYXA5712K1ZT|Apex Hardware|A|P|a|3|20251010|\n07HEWXK8400P1Z3|Kaveri Bake House|A|P|2|5|20220801|4\n24CAZXE1567Z1ZX|Evergreen Boutique|A|P|3|0|20200123|5\n27LMGXG5478L1ZS|Galaxy Dental Care|A|P|7|g|20240908|\n27WIJXK0742L1Z1|Krishna Kids Academy Pvt Ltd|A|C|7|i|20190821|q\n10GSVXS8844K1ZB|Sahyadri Auto Components|C|P|1|h|20220506|2\n36XDQXS0552Z1Z5|Sunrise Diagnostics|A|P|b|6|20180104|a\n33UWHXA3890W1ZT|Apex Unisex Salon|A|P|a|4|20161015|\n29HLKXO7118D1ZA|Orbit Stationers|A|P|4|1|20240507|v\n24IRLXS2095Q1Z9|Silver Oak Bakers|A|P|3|0|20190207|3\n37KXJXS7118P1ZU|Saffron Unisex Salon|A|P|0|l|20190628|u\n19TBTXM6768S1Z4|Moonlight Electronics Pvt Ltd|C|C|d|a|20170428|b\n27JKSXA6405K1Z9|Apex Pharma Retail LLP|A|L|7|d|20161021|n\n37PQHXO2328F1Z0|Orbit Hardware|A|P|0|l|20191003|f\n27VSOXC9548A1ZM|City Stationers|A|P|7|i|20200108|v\n03YNLXP6753V1ZT|Prime Bake House|A|P|8|c|20180704|4\n10LNEXS3956J1Z4|Saffron Sweets|A|P|1|h|20230711|w\n23FYBXM7455R1Z8|Metro Boutique|A|P|6|2|20250818|5\n27VAZXM9064S1Z6|Metro Auto Components Pvt Ltd|A|C|7|i|20211002|\n03MYFXP6223S1Z6|Prime Stays|A|P|8|c|20220430|6\n27IRCXS8111N1ZP|Shree Packaging|A|P|7|g|20230928|l\n29CFQXR8577G1ZW|Riddhi Physio Clinic LLP|A|L|4|e|20190125|\n07CPCXN0398P1ZT|Neelgiri Physio Clinic|A|P|2|5|20240113|o\n23UWJXG2704O1ZJ|Ganesh Boutique|A|P|6|7|20240325|5\n24DRCXS7467R1ZB|Sahyadri Printers Pvt Ltd|A|C|3|k|20160730|r\n07ULRXG7814H1ZT|Ganesh Pharma Retail Pvt Ltd|A|C|2|5|20210910|n\n07ONHXS9323H1ZT|Sunrise Foods|A|P|2|5|20180820|c\n03UMFXT1348R1ZK|Trinity Medicals|A|P|8|c|20161011|\n10CTKXG0240M1ZM|Green Leaf Polymers|C|P|1|h|20180122|p\n09DWBXO9556Y1ZI|Om Mobile Care|A|P|c|b|20230212|\n07HEGXA3556P1ZM|Amrit Dental Care Pvt Ltd|A|C|2|5|20180420|\n33QHVXC3252W1ZO|City Electronics Pvt Ltd|A|C|a|3|20200325|\n08FIBXS0011P1ZO|Sahyadri General Store|A|P|9|8|20230615|\n27LIGXG4177J1ZA|Green Leaf Fitness|S|P|7|i|20220521|e\n23JEUXC9102R1ZC|Coral Auto Components Pvt Ltd|C|C|6|7|20200229|2\n29TZUXB0984J1ZS|Balaji Insurance Advisors Pvt Ltd|A|C|4|1|20160925|g\n29JDQXS1373B1ZM|Sunrise Unisex Salon|A|P|4|e|20190822|u\n07HWHXA7355B1Z8|Annapurna Mobile Care|A|P|2|5|20251030|j\n33CJGXB6512G1Z9|Balaji Pharma Retail|A|P|a|4|20200915|n\n29SOWXA7303W1ZX|Amrit Bakers|A|P|4|1|20200809|3\n03YJXXM9786L1ZX|Modern Stationers|A|P|8|c|20250207|\n27BBKXN6010W1ZE|New Mobile Care|A|P|7|d|20170121|j\n23ZBXXK2172H1ZC|Krishna Mobile Care|A|P|6|2|20190516|j\n24ODHXB8912P1ZH|Balaji Bake House LLP|A|L|3|0|20220119|4\n29ZMAXS9442S1ZU|Shree Unisex Salon|A|P|4|1|20190530|\n27UBEXC0160V1ZF|City Sweets|A|P|7|f|20220714|\n23FOSXU8792T1ZP|Unity Stays LLP|A|L|6|2|20170606|\n07TTHXA8334Z1ZS|Apex Mobile Care|A|P|2|5|20200408|j\n19AUXXM9983E1Z2|Metro Electronics|A|P|d|a|20210720|\n36KHOXG2931Q1Z3|Ganga General Store|C|P|b|6|20200118|\n07TGOXZ4322L1ZR|Zenith Mobile Care|C|P|2|5|20250213|\n27LQPXE2310Z1ZC|Evergreen General Store|A|P|7|f|20210101|\n27XEUXG9940U1Z2|Ganga Realty|C|P|7|g|20250724|\n23OBZXN1839R1ZT|Navkar Stationers|A|P|6|7|20200423|v\n29CSHXG2150W1ZJ|Ganesh Opticals|A|P|4|1|20200111|\n29URFXS7125I1ZC|Shree Hardware|A|P|4|e|20250805|f\n27DNUXC9528I1ZV|Classic Insurance Advisors|A|P|7|i|20230530|g\n27KHKXV4828N1ZP|Vindhya & Associates|A|P|7|i|20250629|7\n29IHTXE8947N1ZJ|Evergreen Fitness LLP|A|L|4|1|20211217|e\n24YCQXL7001Y1ZM|Lakshmi Insurance Advisors LLP|A|L|3|k|20241031|g\n10JDIXM1037G1ZG|Modern Mobile Care|A|P|1|h|20220627|\n08QONXG5080Q1ZC|Green Leaf Insurance Advisors|A|P|9|8|20180507|g\n27ONCXA8080J1Z5|Amrit Diagnostics LLP|A|L|7|d|20220710|a\n33CKAXN6811P1ZG|New Boutique|A|P|a|3|20241213|5\n27JUFXG3289U1Z0|Green Leaf Opticals|C|P|7|d|20200413|k\n09BDFXZ5727U1ZR|Zenith Medicals|A|P|c|b|20181201|\n10BXNXS1436W1Z8|Saffron Stays|A|P|1|h|20210629|6\n09YBVXS3651D1Z3|Star Diagnostics LLP|A|L|c|b|20241211|a\n33SAHXH3521A1ZM|Harmony Opticals|A|P|a|3|20211117|\n08JQXXR1813R1Z3|Riddhi Stays|A|P|9|8|20200410|6\n24XOSXS9721M1ZY|Silver Oak Polymers|A|P|3|0|20250609|p\n03MPFXS9858W1ZQ|Sai Stays|A|P|8|c|20240804|6\n29MPPXL1920G1ZZ|Lakshmi Diagnostics Pvt Ltd|A|C|4|1|20221203|\n24HXWXO0105I1ZS|Orbit Medicals|A|P|3|0|20240805|\n23FDUXE0586L1ZM|Evergreen Mobile Care|A|P|6|2|20250620|\n29OHQXP2486F1ZW|Prime Realty|A|P|4|1|20170809|s\n24LFDXM6241R1ZB|Moonlight Stays LLP|A|L|3|0|20161212|6\n29JDVXC8764B1ZG|Coral Classes|A|P|4|1|20190414|\n33MPSXA9891J1ZH|Annapurna Stationers|A|P|a|3|20250810|v\n10XDCXM8820W1ZY|Modern Pharma Retail|A|P|1|h|20200305|n\n36INLXS6113S1ZH|Saffron Pharma Retail|A|P|b|6|20211013|n\n29XGZXK0175S1Z4|Krishna & Associates|A|P|4|e|20180618|\n27XTVXC4426P1ZX|City Opticals|A|P|7|f|20191228|\n29AJKXM7057D1ZH|Metro Pharma Retail|A|P|4|e|20220721|\n09GJHXS7678S1Z4|Sunrise Bake House LLP|A|L|c|b|20250616|4\n33CKZXH2017D1ZW|Harmony Diagnostics LLP|A|L|a|4|20200610|\n27SAYXO0633U1ZN|Om Bake House|A|P|7|g|20190703|4\n08WLTXS6746W1ZB|Star Fitness|A|P|9|8|20190220|e\n27QWIXN9919P1ZK|Navkar Bakers|A|P|7|i|20181120|\n10OUYXS1230Q1ZA|Sahyadri Design Studio Pvt Ltd|A|C|1|h|20220601|1\n24CPFXO0583E1ZL|Om Fashions Pvt Ltd|A|C|3|j|20230815|0\n09LINXC8211A1ZX|Coral Medicals|A|P|c|b|20210722|m\n03VBAXZ6625N1Z7|Zenith Fashions|A|P|8|c|20190711|0\n27LOTXG5978L1Z6|Galaxy Sweets|A|P|7|f|20250627|\n27PTCXR3164M1ZE|Riddhi Physio Clinic|A|P|7|g|20220510|\n23LEYXG1586T1ZQ|Ganesh Classes|A|P|6|2|20191122|8\n33DFTXS4356G1ZH|Sai & Associates|A|P|a|3|20200415|7\n29FTEXS4353V1ZY|Sunrise Polymers|A|P|4|e|20190621|p\n27LSMXO3597O1ZW|Om Physio Clinic|A|P|7|f|20161213|o\n07NGZXH3977L1ZL|Harmony Realty|A|P|2|5|20170328|\n08IHPXP9390V1Z1|Prime Kids Academy Pvt Ltd|A|C|9|8|20181119|q\n27GONXC9577Q1Z8|Classic Diagnostics LLP|A|L|7|d|20161005|a\n10LBTXC6016L1Z1|Classic Boutique|A|P|1|h|20250425|\n24SJMXM4896R1Z5|Modern Hardware|A|P|3|j|20190522|f\n24RKPXT3381F1ZX|Trinity Opticals|A|P|3|0|20170926|\n33VYTXM4240A1ZN|Moonlight General Store|A|P|a|4|20190515|\n36NISXG9520N1ZS|Ganesh Stationers|A|P|b|6|20170410|\n36ZBGXA7643V1ZT|Apex Sweets|A|P|b|6|20250830|w\n27EMEXS3689E1Z3|Shree Tours & Travels Pvt Ltd|A|C|7|i|20211224|y\n24BVDXP9687R1ZX|Pearl Legal Associates LLP|A|L|3|j|20241010|\n07BMMXL9410I1ZB|Lakshmi Mobile Care|A|P|2|5|20221125|\n33YKNXG5505Q1ZP|Ganesh Polymers|A|P|a|4|20250213|p\n36OENXM2411U1Z1|Metro General Store|A|P|b|6|20170716|\n24IGBXU9404Q1Z5|Unity Medicals|A|P|3|k|20210907|m\n27FLTXC9051G1Z9|Coral Stationers|A|P|7|d|20200616|v\n24XORXG9365M1Z3|Green Leaf Legal Associates|A|P|3|k|20181201|\n29HPDXK8754O1ZE|Krishna Dental Care|A|P|4|1|20170707|\n19FSBXS9061D1ZY|Saffron Textiles LLP|A|L|d|a|20181026|x\n27EKTXA2876Z1Z8|Amrit Stationers|A|P|7|f|20240209|\n10RZDXA9398D1ZQ|Apex Bakers|A|P|1|h|20210319|3\n32QUIXG4998P1ZZ|Green Leaf Tours & Travels LLP|A|L|5|9|20230616|y\n27AUEXT4006H1Z7|Trinity Stays Pvt Ltd|A|C|7|d|20250514|\n23OCEXP7660M1ZD|Prime Tours & Travels Pvt Ltd|A|C|6|2|20251002|y\n03KGZXT1320R1ZZ|Trinity Bake House Pvt Ltd|A|C|8|c|20190819|4\n27UILXS1322D1ZG|Sunrise Hardware|A|P|7|d|20210907|\n33QJOXC0724W1ZV|Classic Bakers|A|P|a|3|20160525|3\n32BWTXL6773P1Z1|Lakshmi Tours & Travels|A|P|5|9|20200626|y\n07YWQXV0429R1ZF|Vindhya Legal Associates|A|P|2|5|20201003|\n27SSVXV8176O1Z8|Vindhya Design Studio|A|P|7|d|20250315|1\n27JDOXP4246A1ZV|Prime Dental Care LLP|A|L|7|d|20200514|9\n07PVHXN2518N1ZD|Neelgiri Opticals|A|P|2|5|20231215|\n24VBQXM4030Z1ZP|Modern Physio Clinic Pvt Ltd|A|C|3|j|20251104|o\n03VGMXO5999B1Z2|Om Boutique|S|P|8|c|20240424|\n36SURXV5896M1Z8|Vindhya Legal Associates|A|P|b|6|20220313|i\n36YXWXC9503U1ZA|City Textiles LLP|A|L|b|6|20230123|x\n33LQGXE0572N1Z4|Evergreen & Associates Pvt Ltd|A|C|a|4|20170501|7\n33EFEXS1631V1ZC|Saffron Dental Care|A|P|a|3|20250709|9\n33QJAXS9688M1ZG|Star General Store|A|P|a|4|20170923|\n08AFFXR7159K1ZC|Royal Sweets|A|P|9|8|20210427|w\n27TUJXN2047K1ZD|Neelgiri Kids Academy|A|P|7|i|20160914|\n09KRMXV2275X1ZJ|Vindhya & Associates|A|P|c|b|20230727|\n33WHFXC7741L1ZA|City Fashions Pvt Ltd|A|C|a|3|20190603|0\n27MYXXP2438W1Z5|Prime Stationers|A|P|7|d|20171112|v\n36WETXK7345L1ZO|Kaveri Sweets|A|P|b|6|20170730|\n36ETVXK9351F1ZK|Krishna Dental Care|A|P|b|6|20210601|9\n08YTOXS9442X1ZX|Sahyadri Stays|A|P|9|8|20181003|6\n33VRPXP1878C1ZK|Pearl Legal Associates|C|P|a|4|20201127|\n36PAOXZ9839H1ZR|Zenith Sweets|A|P|b|6|20191009|\n07PVYXS5859X1ZP|Silver Oak Diagnostics|A|P|2|5|20160825|\n19CGRXS8219H1Z4|Shree Stays LLP|A|L|d|a|20180608|6\n24RKFXZ6107A1ZH|Zenith Medicals|A|P|3|j|20210521|\n23WYLXL4404X1ZN|Lakshmi Unisex Salon|A|P|6|2|20190306|\n33KPZXE1057V1ZA|Evergreen Textiles|A|P|a|3|20190826|x\n09HFUXS9513E1Z6|Sunrise Bakers|A|P|c|b|20200411|\n36NOIXN5551K1ZQ|New Tours & Travels Pvt Ltd|A|C|b|6|20210328|y\n07HOFXP2742N1ZX|Prime Opticals|A|P|2|5|20190402|\n24TJDXS8045J1ZY|Star Insurance Advisors|C|P|3|0|20210531|g\n19HAPXC0479D1Z3|City Kids Academy LLP|A|L|d|a|20171228|q\n08MUTXU9317F1Z3|Unity Tours & Travels|A|P|9|8|20170129|y\n29PMWXN5060K1ZD|Navkar Pharma Retail LLP|A|L|4|1|20241124|n\n33VAPXS8850Q1ZL|Sai Stays Pvt Ltd|A|C|a|4|20220327|6\n33SHWXK1252B1ZO|Kaveri General Store|S|P|a|3|20220721|\n29HTSXM6078P1ZQ|Metro Realty Pvt Ltd|A|C|4|1|20200618|s\n07FWGXB0225D1ZR|Blue Lotus Tours & Travels|A|P|2|5|20171104|y\n32TXOXZ7755M1ZE|Zenith Bakers|A|P|5|9|20240916|\n07DYIXS5558H1ZC|Silver Oak Textiles|A|P|2|5|20190120|x\n27KGYXZ7872J1Z7|Zenith Dental Care|A|P|7|i|20210913|\n23KPSXO2683D1ZZ|Orbit Medicals|A|P|6|2|20230226|\n10XMNXP2594V1Z0|Pearl Stays|A|P|1|h|20161115|\n27THIXG2702E1ZV|Ganesh Packaging|A|P|7|i|20200830|l\n24PJEXS6674J1ZU|Sunrise Realty|A|P|3|k|20240325|s\n07HRBXK3479X1Z4|Krishna Realty|A|P|2|5|20221225|s\n29NEUXB9623T1ZJ|Blue Lotus Sweets|A|P|4|e|20230317|w\n36FTFXP4008K1ZZ|Prime Diagnostics LLP|A|L|b|6|20190403|a\n27DKTXR5149M1ZM|Riddhi Legal Associates Pvt Ltd|A|C|7|f|20231205|\n24BMHXP7723P1ZY|Pearl Design Studio|A|P|3|0|20200307|\n27QAPXK5467W1ZG|Kaveri Boutique|A|P|7|d|20240601|5\n19UUDXT9801W1ZD|Trinity Mobile Care|A|P|d|a|20201102|j\n29EKDXZ4475J1ZS|Zenith Stationers|A|P|4|e|20180115|\n24WXPXM5531N1ZW|Moonlight Bake House|A|P|3|k|20200928|4\n27ZTPXS8845L1ZE|Star Insurance Advisors|A|P|7|g|20211004|\n10FDYXM0701J1Z4|Moonlight Design Studio Pvt Ltd|A|C|1|h|20250823|1\n37NBLXS1145E1ZU|Star Electronics|A|P|0|l|20170108|b\n07YPWXS5465C1Z7|Saffron Fitness|A|P|2|5|20191117|e\n07USTXZ1934C1ZB|Zenith Hardware|A|P|2|5|20230903|\n29PPLXG2511H1Z6|Galaxy Insurance Advisors Pvt Ltd|A|C|4|1|20200401|g\n36SFHXG6726A1ZU|Ganga Fashions LLP|A|L|b|6|20200813|0\n10BKWXL7064F1ZJ|Lakshmi Textiles|A|P|1|h|20180819|x\n27LHWXN7740U1Z5|Navkar Classes LLP|A|L|7|d|20231010|\n29TXDXS8306B1ZH|Shree Classes Pvt Ltd|A|C|4|1|20180329|8\n36EUZXM9429J1Z0|Modern Kitchens Pvt Ltd|A|C|b|6|20241108|t\n32DUAXB3760M1ZD|Blue Lotus Stationers|A|P|5|9|20241218|\n27XUIXG0767D1ZP|Ganesh Woodcraft|A|P|7|f|20200210|d\n23BEZXS4015W1ZV|Shree Classes|A|P|6|2|20220128|\n33XLPXR2105C1ZE|Royal Boutique|A|P|a|4|20220814|\n24WVQXH5708C1ZO|Harmony Mobile Care|A|P|3|0|20191009|\n27MCYXS5121M1Z0|Star Textiles|A|P|7|f|20220803|x\n37JUHXM2665U1ZX|Moonlight Unisex Salon|A|P|0|l|20190212|u\n37DSTXS8554X1ZB|Sunrise Bakers|A|P|0|l|20190521|\n29RRNXG3596D1ZJ|Ganesh Dental Care|A|P|4|e|20210727|9\n07XWYXR7217C1ZZ|Royal Bake House LLP|A|L|2|5|20210627|\n23PFGXS8145F1ZI|Saffron Bakers|A|P|6|7|20190102|\n29XPHXG3448S1Z1|Galaxy Sweets|A|P|4|1|20180718|\n36FVGXE2723W1ZF|Evergreen Sweets|A|P|b|6|20170703|\n23NLDXL3005D1Z4|Lakshmi Tours & Travels|A|P|6|7|20250212|\n23OHNXS6295J1ZS|Silver Oak Boutique|A|P|6|7|20170424|5\n23FWTXN6451J1ZF|Navkar Insurance Advisors|A|P|6|2|20240206|\n19TWAXS3200Z1ZR|Shree Stationers|A|P|d|a|20240302|v\n27BITXS5367Z1ZX|Silver Oak Electronics Pvt Ltd|C|C|7|d|20181104|\n27UTWXL9921K1ZQ|Lakshmi Design Studio|A|P|7|d|20220131|\n19TTKXH7278G1Z7|Harmony Packaging|A|P|d|a|20210110|l\n10XPAXT0053W1ZJ|Trinity Physio Clinic|A|P|1|h|20160927|o\n23GPRXU1013T1ZN|Unity Fitness|A|P|6|7|20231012|e\n27OFLXB4930A1Z4|Blue Lotus Electronics Pvt Ltd|A|C|7|d|20240127|b\n24EZLXS7683Q1ZL|Sahyadri Bakers|A|P|3|k|20240925|3\n32JXWXG2469I1ZE|Ganesh Bakers|A|P|5|9|20190129|\n24DPCXG6948B1ZO|Green Leaf Bake House|A|P|3|k|20211101|4\n09OIOXG6227Y1Z8|Galaxy Electronics|A|P|c|b|20241010|b\n07MTIXG6421N1ZO|Ganesh Physio Clinic Pvt Ltd|S|C|2|5|20230123|o\n03UFUXZ5094J1ZJ|Zenith Hardware|A|P|8|c|20231105|\n19YQUXN7122J1Z2|Navkar Dental Care|C|P|d|a|20181002|9\n27HAAXS6895M1Z6|Shree Stationers|A|P|7|d|20200209|\n29AWVXC8799X1Z2|City Stays|A|P|4|1|20250410|\n29OXGXU8203I1Z6|Unity Unisex Salon|A|P|4|1|20221104|\n09DZNXR7272U1ZC|Royal Sweets|A|P|c|b|20231002|w\n33EKEXV8800G1ZK|Vindhya Classes|A|P|a|3|20161230|8\n27NCJXN4867E1ZH|Navkar Unisex Salon|A|P|7|i|20161107|\n36GRIXZ6272A1ZW|Zenith Woodcraft|A|P|b|6|20170111|d\n09VLVXP3091M1Z3|Prime Kids Academy Pvt Ltd|A|C|c|b|20210603|q\n07CQLXK2740J1Z7|Krishna Opticals|A|P|2|5|20200629|k\n24EULXM4884J1ZI|Metro Hardware|A|P|3|k|20201119|f\n23XZNXV2588E1ZU|Vindhya Design Studio|A|P|6|7|20241010|\n24IZUXS4837E1Z7|Star Diagnostics|A|P|3|j|20231228|a\n29LRWXG9484B1ZD|Ganga Packaging|S|P|4|1|20241229|\n27LGAXH2212C1ZJ|Harmony Opticals|A|P|7|d|20210410|\n24VGTXC9503O1ZW|Classic Foods LLP|A|L|3|j|20161119|\n36RYCXC9718X1ZK|City Fashions|A|P|b|6|20250504|0\n07MBMXL5085E1ZP|Lakshmi Insurance Advisors LLP|A|L|2|5|20211231|g\n33QVVXC0129C1Z6|City & Associates|A|P|a|3|20200319|\n36BTPXA0596Z1Z1|Apex Stays|A|P|b|6|20250517|6\n36UJDXP6599J1ZG|Pearl Medicals|A|P|b|6|20161201|\n23WCMXV1441P1Z2|Vindhya Electronics|A|P|6|7|20171119|b\n07NVFXS5973M1ZX|Sahyadri General Store|A|P|2|5|20181125|h\n10ISWXR9541K1ZD|Riddhi General Store|A|P|1|h|20220211|\n10XPYXU4200E1ZY|Unity Mobile Care|A|P|1|h|20211110|\n36NOZXT6461X1ZA|Trinity Insurance Advisors|A|P|b|6|20170708|g\n08HZNXP1660M1Z4|Prime Stays|A|P|9|8|20170903|\n33IPVXA2292Q1ZN|Apex Mobile Care|A|P|a|3|20240602|\n33ZVLXC9350S1ZT|Classic Design Studio LLP|A|L|a|4|20191214|1\n24YNRXB3496C1ZY|Blue Lotus Boutique|A|P|3|j|20160713|5\n36ZQOXZ8370K1ZL|Zenith Mobile Care|A|P|b|6|20191101|j\n23RNLXR8452S1Z2|Riddhi Bake House|A|P|6|7|20191204|4\n36AIAXG9248W1ZW|Ganga & Associates|A|P|b|6|20220426|\n37HPWXM1842I1ZP|Metro Hardware|C|P|0|l|20161002|f\n36NHAXS7745B1ZJ|Silver Oak Design Studio|A|P|b|6|20210404|\n27CYFXA2014M1Z8|Apex Classes|A|P|7|g|20241020|\n07IWUXS4825R1ZM|Saffron Unisex Salon|A|P|2|5|20190920|u\n33RTPXA1823Q1ZL|Amrit Hardware|A|P|a|3|20230202|\n10DUJXL2207W1ZS|Lakshmi Tours & Travels|A|P|1|h|20171120|y\n36ACDXU2257F1Z4|Unity Hardware|A|P|b|6|20210706|f\n24MZGXS5387T1ZF|Star General Store|A|P|3|0|20221019|\n07HRPXG6395I1ZJ|Ganga Classes|A|P|2|5|20251105|\n27RRCXM9151W1ZU|Moonlight Boutique|A|P|7|i|20161201|5\n23DUKXC5810G1ZJ|Coral Diagnostics|A|P|6|2|20230126|\n36ORMXE7483C1ZU|Evergreen & Associates Pvt Ltd|A|C|b|6|20180222|7\n19GZIXK5054U1ZS|Kaveri Realty|A|P|d|a|20210128|s\n27TFVXN8979E1ZG|New Diagnostics|A|P|7|d|20180815|a\n33XTJXA7602U1Z8|Amrit Sweets|A|P|a|3|20200221|\n36FZPXC4716T1Z1|City Fitness|S|P|b|6|20210725|e\n33RWXXR4225M1ZW|Royal Hardware|A|P|a|3|20160527|\n07SKKXC8892I1ZP|Coral Electronics|A|P|2|5|20210802|b\n24WYIXS6129W1Z9|Shree Mobile Care|A|P|3|0|20201107|j\n23GOAXM8123X1ZP|Modern Boutique|A|P|6|2|20240523|\n33SRLXG1797V1ZV|Ganesh Physio Clinic Pvt Ltd|A|C|a|3|20180119|o\n33QPHXL1832I1Z6|Lakshmi Foods Pvt Ltd|A|C|a|3|20190219|c\n27PDWXC8648B1ZE|City Stationers|A|P|7|f|20190721|v\n24HPRXK3405I1Z8|Kaveri Opticals|A|P|3|j|20180516|\n33BFWXC4600V1ZE|Classic Opticals|A|P|a|3|20210407|\n27QJCXK4705K1ZB|Krishna Stays LLP|C|L|7|d|20240902|6\n19QABXG4479H1ZO|Ganga Unisex Salon|A|P|d|a|20190911|u\n23SKEXS0221Z1ZO|Shree Classes Pvt Ltd|A|C|6|2|20170530|\n29APLXH3978N1ZI|Harmony Mobile Care|A|P|4|1|20190918|j\n10QMTXE7824M1ZV|Evergreen Legal Associates|C|P|1|h|20161226|\n36ZTYXB9440I1Z0|Balaji Legal Associates|A|P|b|6|20201218|i\n27YIBXM3521Z1ZE|Moonlight Tours & Travels LLP|A|L|7|i|20180327|y\n07PHWXG6510F1ZF|Ganesh Bake House Pvt Ltd|S|C|2|5|20180208|4\n27TONXA7994C1ZP|Apex Stationers|A|P|7|i|20230115|\n27MJPXN3168Q1ZG|Navkar Foods LLP|A|L|7|i|20201213|c\n24ZNUXC4386S1ZX|Coral Legal Associates LLP|A|L|3|k|20250912|i\n27FGVXZ0306W1ZI|Zenith Woodcraft Pvt Ltd|A|C|7|g|20220728|\n10SPRXM3859H1ZP|Metro Woodcraft|A|P|1|h|20230805|d\n10LTPXM2689C1ZY|Modern Opticals|A|P|1|h|20160828|\n36VXHXS3229Z1Z7|Silver Oak Diagnostics LLP|A|L|b|6|20190821|a\n23XMVXS8468R1ZH|Star Kids Academy Pvt Ltd|A|C|6|2|20190613|q\n29RNHXS3333E1Z0|Saffron Realty LLP|A|L|4|e|20201126|s\n27XDZXT4287P1ZY|Trinity Bakers|A|P|7|f|20161205|3\n32CYHXM6718Z1ZU|Modern Dental Care LLP|A|L|5|9|20210226|9\n32GPKXN2332C1ZT|New Electronics|A|P|5|9|20180808|b\n36JJZXS0103J1Z6|Saffron Mobile Care|A|P|b|6|20210502|\n07QVOXC2880Z1ZJ|City Printers|A|P|2|5|20220517|r\n29FAJXM2713F1Z7|Metro Pharma Retail Pvt Ltd|C|C|4|e|20210615|\n37LCFXV7062I1ZC|Vindhya Fashions LLP|A|L|0|l|20240320|0\n03PBQXS1802J1ZR|Shree Boutique|A|P|8|c|20250114|\n29GPKXS4274W1ZT|Sai Hardware|S|P|4|1|20170721|f\n37LGNXG6115J1ZH|Ganesh Opticals|A|P|0|l|20191011|\n29OHRXN5678T1ZW|Neelgiri Mobile Care|A|P|4|e|20241208|\n29COFXS5317V1ZC|Sunrise Sweets|A|P|4|e|20170925|\n24TQVXK2064Y1ZP|Kaveri Insurance Advisors LLP|A|L|3|j|20190109|g\n27IDCXR0714F1Z7|Royal Printers|A|P|7|i|20211211|r\n24LVUXS5907Z1Z8|Saffron Realty|A|P|3|0|20180324|s\n24MZQXS5802L1Z1|Saffron Sweets|A|P|3|0|20181029|w\n07UMEXM2209M1Z0|Modern Stationers|A|P|2|5|20190203|\n36ITZXA0406Y1Z5|Annapurna Dental Care Pvt Ltd|A|C|b|6|20180315|\n36TROXS4510S1ZY|Shree Opticals|A|P|b|6|20190530|\n27DQNXN4102Q1ZT|Neelgiri Boutique|A|P|7|f|20200216|\n33TTSXM1802Z1ZR|Moonlight Insurance Advisors Pvt Ltd|A|C|a|4|20171117|\n08ZBEXO3762R1ZS|Orbit Physio Clinic LLP|A|L|9|8|20250926|\n07UKLXV8756M1Z0|Vindhya Sweets|A|P|2|5|20200716|\n03DJAXS8501M1ZM|Sahyadri Tours & Travels LLP|A|L|8|c|20180531|y\n32FMJXS1973U1ZI|Shree Diagnostics Pvt Ltd|A|C|5|9|20230508|a\n29QQKXB1105D1ZL|Blue Lotus Classes|A|P|4|e|20180612|\n36MHUXC4598S1ZC|Classic Fitness LLP|A|L|b|6|20161023|\n24GCFXK0639I1Z6|Kaveri Dental Care|A|P|3|0|20250618|\n27ZPEXV4958S1ZI|Vindhya General Store|A|P|7|g|20231127|h\n27XJLXU2693N1Z4|Unity Unisex Salon|A|P|7|f|20240803|u\n33BCDXU0418G1ZG|Unity Auto Components|S|P|a|3|20200501|2\n33AOYXA9627I1Z1|Amrit Mobile Care|A|P|a|4|20240211|j\n27DPDXN3121F1ZR|Navkar Tours & Travels Pvt Ltd|A|C|7|i|20200109|y\n29BXUXH7796N1ZK|Harmony Diagnostics|A|P|4|e|20190422|a\n27UAXXN2573F1Z7|Neelgiri Electronics Pvt Ltd|A|C|7|g|20200207|b\n27ARWXA1049R1ZO|Amrit Mobile Care|A|P|7|d|20180210|\n27ZLFXC7879B1ZX|City Textiles Pvt Ltd|A|C|7|g|20160815|x\n36YUSXN0102Y1ZO|Navkar Packaging|A|P|b|6|20200409|l\n33XHIXM1841M1Z5|Moonlight Classes Pvt Ltd|A|C|a|4|20250402|8\n03YYBXG5599T1ZK|Green Leaf Pharma Retail LLP|A|L|8|c|20200224|n\n29EAMXC7823D1Z6|Coral Polymers LLP|A|L|4|1|20240813|p\n24QLLXM0936C1ZI|Moonlight Fitness LLP|A|L|3|k|20190522|e\n07ANFXA5152O1ZH|Apex Boutique|A|P|2|5|20170413|\n33VSBXT4591J1ZD|Trinity Hardware|A|P|a|3|20220815|\n29XVFXO9401S1ZM|Orbit Realty|A|P|4|1|20240629|\n03DJPXS9023Q1ZW|Sahyadri Insurance Advisors Pvt Ltd|A|C|8|c|20210709|g\n10ZKQXB9469G1ZW|Balaji Kitchens|A|P|1|h|20170122|t\n27NBWXU6939Z1ZR|Unity Stationers|A|P|7|d|20250911|v\n24EBUXS2766Q1ZZ|Saffron Stays Pvt Ltd|A|C|3|0|20211125|6\n32DUAXM2724O1Z4|Metro Dental Care|A|P|5|9|20170917|\n10SFSXA5806S1Z7|Apex & Associates LLP|A|L|1|h|20211216|\n27RLXXR4709T1ZS|Royal Physio Clinic|S|P|7|i|20210327|o\n27NBWXA2980B1ZV|Amrit Insurance Advisors|A|P|7|d|20220403|g\n24QHVXS9295S1ZS|Sai Mobile Care|A|P|3|k|20250206|j\n24EYEXP3308W1Z7|Pearl Bakers|A|P|3|k|20230124|\n07UMDXE8285M1ZL|Evergreen Sweets|A|P|2|5|20190225|\n29ZQZXS1521H1Z4|Star Bake House Pvt Ltd|A|C|4|1|20240410|\n33JFGXC1135A1ZT|City Bakers|A|P|a|4|20210103|\n23MJIXV8006X1ZE|Vindhya Medicals|A|P|6|2|20220717|\n27JKYXH6980X1ZQ|Harmony Unisex Salon|A|P|7|i|20230221|u\n23XRYXT4470F1Z6|Trinity Dental Care|A|P|6|2|20190123|\n08QOTXA6620P1ZI|Apex General Store|A|P|9|8|20210818|\n24RTGXO0497V1ZT|Orbit Bakers|A|P|3|0|20170203|\n29EUOXP8709Y1ZC|Prime Bakers|A|P|4|1|20170917|\n36MMCXN2907Q1ZV|New Design Studio|A|P|b|6|20170814|1\n32CJJXG6393E1ZS|Ganesh Stays|S|P|5|9|20191002|6\n37GFDXC7891I1ZJ|City Opticals|A|P|0|l|20250122|k\n27KZZXR0470K1ZT|Royal Bakers|A|P|7|d|20250922|3\n36VVSXO5398D1ZV|Om Boutique|A|P|b|6|20220614|5\n07ZZWXS6155D1ZN|Shree Boutique|A|P|2|5|20190930|5\n07RCKXA2243O1ZO|Annapurna Sweets|A|P|2|5|20231125|\n08ZTVXS5299C1ZP|Shree Pharma Retail|A|P|9|8|20200813|\n07KTIXN6525D1ZZ|New Realty|A|P|2|5|20231123|s\n24QMNXE3077X1Z9|Evergreen Design Studio Pvt Ltd|A|C|3|k|20250928|1\n03IGLXS1510F1Z5|Sahyadri Mobile Care|A|P|8|c|20190725|\n27TLWXS0890T1ZO|Star Design Studio LLP|A|L|7|i|20210518|1\n29IMWXZ3690V1ZE|Zenith Medicals|A|P|4|1|20240508|m\n24GLTXE5877T1ZB|Evergreen Unisex Salon|A|P|3|k|20161022|u\n27JWSXG4600D1Z1|Green Leaf Bakers|A|P|7|d|20210412|3\n27OPWXZ9373I1ZO|Zenith Packaging|A|P|7|d|20191216|l\n29VUEXB1834X1ZX|Balaji Stays Pvt Ltd|A|C|4|e|20240804|\n33GABXC1102G1Z8|Classic Printers Pvt Ltd|A|C|a|3|20250802|r\n29GWSXG6196P1ZO|Galaxy Opticals|A|P|4|1|20250216|\n27TBYXS7621J1ZS|Star General Store|A|P|7|f|20200927|\n08DCOXM0963V1ZZ|Metro Design Studio Pvt Ltd|A|C|9|8|20220417|1\n27EQJXS3672U1Z2|Sahyadri Electronics Pvt Ltd|A|C|7|f|20210616|\n33DWTXS0990I1ZD|Star Diagnostics|A|P|a|3|20210211|\n08FOQXT6409V1ZY|Trinity Stationers|A|P|9|8|20210304|v\n29LQZXB4953U1ZQ|Blue Lotus Mobile Care|A|P|4|1|20210602|\n37TCHXC6240X1ZX|Classic Tours & Travels|A|P|0|l|20230701|y\n32EVUXS3203R1ZD|Sahyadri Auto Components Pvt Ltd|A|C|5|9|20250320|2\n24DYOXG6015Y1Z1|Galaxy Textiles|A|P|3|j|20161201|x\n36TMTXS5251J1ZD|Sahyadri General Store|S|P|b|6|20171027|\n33UBMXB0942Z1Z1|Blue Lotus Design Studio LLP|A|L|a|4|20220313|1\n24URMXR6328V1ZN|Royal Insurance Advisors|A|P|3|j|20241005|g\n29IKCXG4931V1ZR|Ganga Sweets|A|P|4|1|20230707|\n32YUTXA7498E1Z8|Apex Electronics|A|P|5|9|20201008|b\n23DCBXH0515G1ZW|Harmony Bakers|A|P|6|2|20190605|\n19FTDXM8226J1ZQ|Metro Dental Care Pvt Ltd|S|C|d|a|20171214|\n29JONXV6953G1ZD|Vindhya Bake House Pvt Ltd|C|C|4|1|20180813|\n24BDFXS9342W1ZZ|Sai General Store|C|P|3|0|20181026|\n23QIIXR4911R1ZU|Riddhi Sweets|A|P|6|2|20190509|\n03YWDXS3903W1ZS|Sai Mobile Care|A|P|8|c|20190904|\n07YAYXN9125T1Z9|Navkar Kitchens|A|P|2|5|20210920|t\n24BWSXS1327V1Z0|Shree Legal Associates LLP|A|L|3|k|20210729|i\n29SYNXC0188F1ZE|Classic General Store|A|P|4|1|20240815|h\n07XBIXZ6161J1ZY|Zenith General Store|A|P|2|5|20230213|\n29OWEXO3945P1ZV|Orbit Realty Pvt Ltd|A|C|4|1|20210806|\n07NYUXM1303T1ZW|Metro Unisex Salon|A|P|2|5|20201018|\n09VZSXG5871M1ZF|Ganga Foods LLP|A|L|c|b|20231125|c\n24VZRXN9955E1ZP|Neelgiri Packaging|A|P|3|j|20171028|l\n29NJWXB2707F1ZC|Balaji Opticals|A|P|4|e|20211227|\n27CXVXK6862I1Z4|Krishna Boutique|A|P|7|i|20201227|\n19DAUXT9409W1ZE|Trinity Physio Clinic|A|P|d|a|20180310|\n24XXRXP8263V1ZZ|Pearl Stationers|A|P|3|j|20200919|\n27IMQXS9839Z1ZC|Sunrise Sweets|A|P|7|d|20210309|\n23YOCXM4585F1ZW|Moonlight Opticals|A|P|6|2|20220707|k\n08VFHXA4043J1ZN|Apex Boutique|A|P|9|8|20171111|5\n08WVOXZ2140E1ZA|Zenith Fashions Pvt Ltd|A|C|9|8|20210420|0\n27HJUXB4197I1Z1|Balaji Medicals|A|P|7|d|20190820|m\n29AFOXN5178D1ZJ|Neelgiri Tours & Travels Pvt Ltd|A|C|4|1|20240924|y\n29KOZXT5058R1ZL|Trinity Fitness|A|P|4|1|20190402|e\n37MDPXC8389K1ZY|Classic Diagnostics Pvt Ltd|A|C|0|l|20180227|a\n23OJMXP2075D1ZI|Pearl Unisex Salon|A|P|6|7|20220224|\n24WIIXO0706M1Z6|Om General Store|C|P|3|j|20170516|\n03KSUXB5943H1ZX|Balaji Tours & Travels|A|P|8|c|20230303|y\n10TJUXR8820C1Z7|Royal Stationers|A|P|1|h|20190412|v\n03VFWXG9146G1Z5|Galaxy General Store|S|P|8|c|20181023|h\n24ERPXL1721J1Z7|Lakshmi Legal Associates|A|P|3|k|20241124|i\n24GNCXB1140T1ZJ|Blue Lotus General Store|A|P|3|0|20201029|h\n27EDWXZ7644K1ZP|Zenith Medicals|A|P|7|f|20220329|m\n32LQEXO5899W1ZS|Orbit Sweets|C|P|5|9|20200429|\n03TFEXC6213V1ZC|City Kids Academy Pvt Ltd|A|C|8|c|20220326|q\n27XCCXS7518Q1ZQ|Sunrise General Store|A|P|7|d|20190305|\n27EQJXM5708V1Z9|Metro Stationers|A|P|7|d|20250516|v\n23SAXXZ0272X1ZC|Zenith Mobile Care|A|P|6|2|20190828|j\n27BLHXL3071Q1Z3|Lakshmi Unisex Salon|A|P|7|d|20180531|u\n24TZKXG4586C1ZG|Ganesh Pharma Retail Pvt Ltd|A|C|3|k|20171203|n\n07MSXXB7260B1ZY|Blue Lotus & Associates LLP|A|L|2|5|20190618|\n19BSJXG8517K1ZS|Galaxy Medicals|C|P|d|a|20211204|\n32DRRXH5912T1ZK|Harmony Design Studio LLP|A|L|5|9|20170703|\n07VQIXV3084X1ZH|Vindhya Woodcraft|A|P|2|5|20231223|d\n32GSRXM1120A1ZT|Moonlight Tours & Travels|A|P|5|9|20181014|y\n27WSEXA7536R1Z6|Annapurna Medicals|A|P|7|g|20240319|\n10HCSXA2168T1ZL|Annapurna Realty|A|P|1|h|20221007|s\n09RWYXM8372C1ZW|Moonlight Mobile Care|A|P|c|b|20230623|j\n27ZOKXA1922K1ZX|Amrit Classes|A|P|7|i|20210909|8\n27TBMXG6906M1Z8|Green Leaf Design Studio Pvt Ltd|A|C|7|g|20241110|\n36BIAXU1299Z1ZG|Unity Bakers|A|P|b|6|20240809|\n27EZTXA2449A1Z0|Annapurna Mobile Care|A|P|7|d|20171001|\n27ZFZXH2259X1ZW|Harmony Sweets|A|P|7|d|20180911|\n36IZIXP4128F1ZN|Pearl Legal Associates|A|P|b|6|20190116|i\n32WUEXG4664A1Z5|Green Leaf Electronics LLP|A|L|5|9|20170121|b\n27WUJXC4412G1ZX|Coral Mobile Care|A|P|7|d|20250404|\n33IPWXA1036N1Z4|Annapurna Diagnostics|A|P|a|3|20160531|\n27IBCXS6631I1ZR|Shree Hardware|A|P|7|d|20210118|\n29PZEXR7306J1Z2|Riddhi Pharma Retail|A|P|4|e|20230415|n\n32OSOXC0435R1ZR|City Unisex Salon|A|P|5|9|20170315|u\n24CSFXS7793M1ZC|Sai Fashions LLP|A|L|3|k|20160703|0\n23IUSXN0788Q1ZZ|New Bake House|A|P|6|2|20200725|4\n33VKCXM8538I1ZY|Modern Design Studio|A|P|a|3|20170512|\n23FGBXZ7410U1Z3|Zenith Sweets|A|P|6|2|20210920|\n08QNEXP6823B1Z8|Pearl Design Studio|A|P|9|8|20211004|\n24COAXK3971G1ZM|Krishna Printers Pvt Ltd|A|C|3|k|20250201|r\n32TDCXC1707M1Z2|Coral Medicals|S|P|5|9|20181203|\n07IXRXN0415V1ZY|Navkar Stationers|A|P|2|5|20181220|\n27FHWXM9210F1ZE|Moonlight Legal Associates|A|P|7|d|20190127|\n27CVCXS5602Y1Z3|Sunrise Design Studio LLP|S|L|7|g|20220213|\n27QJWXC1663R1ZI|Classic Diagnostics LLP|A|L|7|g|20240118|a\n10VLFXN0176X1ZK|Navkar Physio Clinic LLP|A|L|1|h|20160919|o\n09WBCXG0267V1Z1|Green Leaf Pharma Retail Pvt Ltd|A|C|c|b|20220330|n\n09DYHXG5416M1ZL|Ganga Unisex Salon|A|P|c|b|20240430|\n33LDUXA9181Z1ZI|Apex Electronics Pvt Ltd|C|C|a|3|20190220|b\n19YAJXL0900T1Z4|Lakshmi Sweets|A|P|d|a|20220827|w\n29DNQXG4240X1ZE|Ganesh Medicals|A|P|4|e|20191103|\n33XKFXK3816Q1ZS|Krishna Bakers|A|P|a|3|20220523|3\n36FRJXT5525Z1ZT|Trinity Unisex Salon|A|P|b|6|20220505|\n10XQFXK2443B1ZM|Krishna Dental Care Pvt Ltd|A|C|1|h|20181112|\n33RWUXA6301Q1ZB|Annapurna Unisex Salon|A|P|a|3|20190823|\n29KYOXG6480A1ZK|Ganesh Stationers|A|P|4|1|20170908|v\n33NSJXO0346V1Z9|Om Boutique|A|P|a|4|20250526|\n24BGAXS1859F1ZZ|Sunrise Fashions|A|P|3|k|20181220|0\n07GBLXC0634F1ZI|Coral Unisex Salon|A|P|2|5|20230103|\n23ILQXS2726A1ZL|Shree Dental Care|A|P|6|2|20230404|9\n32FKKXG5486N1Z3|Green Leaf Foods|A|P|5|9|20210425|c\n24SMYXA1248R1ZJ|Apex Physio Clinic|A|P|3|j|20200306|o\n37KLPXG9085J1ZM|Green Leaf Insurance Advisors|A|P|0|l|20191018|g\n29UDFXA6802A1Z6|Apex Mobile Care|A|P|4|1|20170625|\n27ICUXN7925C1ZI|Neelgiri Unisex Salon|A|P|7|g|20170127|u\n27AFEXZ5596P1ZQ|Zenith Legal Associates LLP|A|L|7|d|20201209|i\n24TAIXA6568D1ZZ|Apex General Store|A|P|3|0|20210304|\n27MRRXB4018W1Z7|Balaji Classes Pvt Ltd|A|C|7|d|20170720|8\n24DHXXP7137P1ZR|Pearl Legal Associates LLP|A|L|3|k|20180507|\n32TZAXB5481U1Z1|Balaji Realty LLP|A|L|5|9|20200726|s\n10UMSXZ8744N1Z0|Zenith Kids Academy LLP|A|L|1|h|20171116|q\n24BTGXS1060Y1ZE|Saffron Stationers|A|P|3|k|20241227|\n27EQMXN0680I1ZY|New Mobile Care|A|P|7|i|20220308|j\n23IKUXZ9660A1ZX|Zenith Bakers|A|P|6|7|20200831|\n27XYMXS0020I1ZC|Sai Insurance Advisors|A|P|7|i|20210802|\n27XRVXS6133J1ZX|Saffron Bakers|A|P|7|d|20180414|3\n33BYAXC3410R1Z7|City Pharma Retail LLP|A|L|a|3|20250827|n\n27CKBXZ3790C1ZF|Zenith Fashions|A|P|7|d|20201120|0\n27GQIXT5743F1ZV|Trinity Stays|A|P|7|f|20210108|\n37ZEIXC9888U1Z0|Classic Mobile Care|A|P|0|l|20230425|\n23DGHXS6478W1ZK|Saffron Sweets|C|P|6|7|20170403|\n07MGQXM5205W1ZN|Metro Mobile Care|A|P|2|5|20230425|j\n03KRGXS2024O1ZZ|Sunrise Pharma Retail|A|P|8|c|20191007|n\n27QTTXP4335J1Z5|Pearl Insurance Advisors|A|P|7|g|20170209|\n27RKCXM4454J1Z2|Modern Medicals|A|P|7|i|20160717|\n29XLUXM3379O1ZS|Modern Packaging|A|P|4|1|20241024|\n24IBNXM4711J1ZX|Moonlight Hardware|A|P|3|k|20170422|\n23IFOXM1975O1Z4|Modern Classes Pvt Ltd|A|C|6|7|20250811|\n19WAUXS3498N1Z9|Star Hardware|A|P|d|a|20230704|f\n27VKGXG4699N1ZD|Ganesh Bakers|A|P|7|f|20220622|\n24HGVXC4982U1ZN|Coral Diagnostics|A|P|3|k|20191126|a\n09WKMXG2271V1Z8|Green Leaf Woodcraft Pvt Ltd|A|C|c|b|20190915|d\n24LFRXM3434J1ZG|Moonlight Tours & Travels LLP|A|L|3|j|20240226|\n29EEKXM7431Y1ZN|Moonlight Medicals|A|P|4|e|20220118|m\n08CJCXH5108B1ZC|Harmony Opticals|A|P|9|8|20190217|\n29LGCXG7654K1Z9|Ganga Stays|A|P|4|e|20191030|6\n09SMOXR5691R1ZP|Riddhi Medicals|A|P|c|b|20240630|\n36OFTXB8630M1Z3|Balaji & Associates|A|P|b|6|20201022|7\n29LRGXM6642W1ZU|Moonlight Electronics Pvt Ltd|A|C|4|1|20211213|b\n27JLVXL0176D1Z8|Lakshmi Legal Associates|A|P|7|g|20240804|i\n24ZGDXV7161N1ZP|Vindhya Textiles|A|P|3|j|20200301|x\n08UBZXO4832N1ZN|Om Bakers|A|P|9|8|20240929|3\n07XJAXR1330T1ZS|Royal Kids Academy Pvt Ltd|A|C|2|5|20181215|\n24RAGXO6276A1ZY|Orbit Mobile Care|C|P|3|j|20210702|j\n37CQOXM2835I1ZX|Metro Opticals|A|P|0|l|20190721|\n36MJCXK2412O1ZG|Kaveri Opticals|C|P|b|6|20221218|k\n27UQXXA0479N1Z5|Amrit Insurance Advisors|A|P|7|g|20241017|g\n07ZORXA3860Y1ZR|Apex Packaging|A|P|2|5|20200703|l\n24GVGXL6996N1Z3|Lakshmi Printers|S|P|3|j|20250113|r\n33ZMEXU2147U1Z7|Unity Diagnostics Pvt Ltd|A|C|a|3|20171121|a\n27IXFXR9720M1Z4|Riddhi Mobile Care|A|P|7|d|20170401|\n24ANTXM4335M1Z0|Metro Fashions Pvt Ltd|A|C|3|0|20170306|0\n24FXIXS3649U1ZT|Star Dental Care Pvt Ltd|A|C|3|k|20220519|9\n33NBEXA5396V1Z7|Apex & Associates|C|P|a|4|20231201|7\n33GXSXR5429K1Z6|Royal Stationers|C|P|a|4|20160805|\n33MKSXA7614M1Z4|Apex Opticals|A|P|a|3|20171019|k\n03ONLXM9635U1Z5|Metro Classes|A|P|8|c|20251112|\n08ANZXS2052Q1ZG|Shree & Associates|A|P|9|8|20200228|7\n36DZEXR7254M1Z6|Riddhi Tours & Travels Pvt Ltd|A|C|b|6|20190704|y\n29OJEXS1827L1ZW|Sai Mobile Care|A|P|4|1|20201029|j\n07YKMXS5219K1ZI|Sai Packaging|A|P|2|5|20180221|l\n23GLPXO2460Z1ZE|Om Bake House|A|P|6|7|20241001|\n27XGMXE1863W1ZE|Evergreen Kids Academy Pvt Ltd|A|C|7|i|20160828|\n29ENPXK7875Q1Z1|Kaveri Sweets|A|P|4|e|20210916|\n24UEWXS5847C1Z0|Saffron Mobile Care|A|P|3|0|20170306|j\n27HBGXO8842P1Z5|Orbit Electronics Pvt Ltd|S|C|7|g|20180430|b\n27ZWIXS0441U1ZL|Sahyadri Unisex Salon|C|P|7|d|20220921|u\n27KSPXC7187Y1ZK|City Opticals|A|P|7|i|20250423|\n36ABRXK6111H1Z5|Kaveri Bake House|A|P|b|6|20170506|4\n27YFJXS4784V1ZW|Sunrise Insurance Advisors Pvt Ltd|A|C|7|d|20170116|\n37YSFXM6386S1ZI|Modern Physio Clinic|A|P|0|l|20201112|o\n07EMTXN1349J1ZZ|New Fitness Pvt Ltd|A|C|2|5|20221022|e\n33SIMXM2903I1ZE|Moonlight Unisex Salon|A|P|a|4|20180714|u\n27HREXS7151V1Z2|Sahyadri Boutique|A|P|7|f|20161211|\n03BOMXA7819S1ZX|Amrit Pharma Retail|A|P|8|c|20180815|n\n33XUGXS9543T1ZH|Sunrise Electronics LLP|A|L|a|3|20241229|\n36UXQXG2957I1Z0|Galaxy Opticals|A|P|b|6|20251025|k\n19MUHXA1285G1ZZ|Apex Hardware|A|P|d|a|20170319|\n24XHPXG7363F1Z5|Green Leaf General Store|A|P|3|j|20190818|\n36TKMXR5479W1ZL|Riddhi Diagnostics|S|P|b|6|20250922|a\n23CFUXU6069P1ZR|Unity Hardware|A|P|6|7|20180509|\n07EZIXG7871M1Z6|Ganesh Sweets|A|P|2|5|20210724|\n27KSXXR5114Z1ZG|Royal Tours & Travels|A|P|7|d|20200229|y\n07VSPXC4437Y1ZO|City Mobile Care|A|P|2|5|20220929|\n19BVAXC2385B1ZK|City Packaging|A|P|d|a|20200618|l\n33BAFXA6222H1ZU|Annapurna Opticals|A|P|a|3|20180624|k\n32UJVXM8779H1ZC|Metro Boutique|A|P|5|9|20240428|\n33GFTXU2889V1Z7|Unity Insurance Advisors|A|P|a|4|20250101|g\n27PEGXS7584V1Z6|Silver Oak Physio Clinic LLP|A|L|7|g|20220927|o\n27ULQXO5988L1ZW|Orbit Opticals|A|P|7|g|20180117|\n36MPZXN1366P1Z1|Neelgiri Stays Pvt Ltd|A|C|b|6|20250221|6\n27POVXA0629H1Z1|Apex Sweets|A|P|7|d|20220504|w\n24ZSNXK5897M1ZO|Kaveri Bake House Pvt Ltd|S|C|3|k|20190213|4\n24EPJXB9119M1Z5|Blue Lotus Medicals|A|P|3|0|20251005|\n07ESIXS0502D1ZL|Saffron Classes LLP|A|L|2|5|20230926|\n32ITAXK6344D1ZI|Krishna Mobile Care|A|P|5|9|20230824|\n07AVFXB6531S1ZR|Balaji Fitness|A|P|2|5|20220706|e\n24WDRXP4802Q1ZU|Prime Pharma Retail LLP|A|L|3|0|20201009|n\n27JRWXS1549E1ZJ|Star Polymers|A|P|7|d|20181127|p\n29ZLLXT6727M1ZY|Trinity Dental Care LLP|A|L|4|1|20190508|9\n10HPUXR6662M1ZI|Riddhi Opticals|A|P|1|h|20220508|\n27CCNXA0923J1Z9|Annapurna General Store|A|P|7|i|20161004|h\n36EGPXS6968Z1ZV|Sunrise Opticals|A|P|b|6|20230217|\n07SQTXS5782N1ZN|Silver Oak Bakers|A|P|2|5|20250528|3\n03XAHXS0588Q1ZZ|Silver Oak Medicals|A|P|8|c|20250816|\n07EHZXS6746B1Z5|Saffron Boutique|A|P|2|5|20220125|5\n29IFRXS4362I1Z0|Sai Fashions|A|P|4|1|20251129|0\n07HQBXM3520Y1ZK|Metro Medicals|C|P|2|5|20211225|m\n23TBYXZ6926Y1ZT|Zenith Design Studio|A|P|6|7|20220718|\n29WMSXC2756A1Z1|Coral Fitness Pvt Ltd|A|C|4|e|20250505|e\n33JAXXT9513D1ZL|Trinity Stationers|A|P|a|4|20170610|\n29UXUXG2470C1ZC|Ganesh Mobile Care|A|P|4|e|20190613|j\n03LYRXP4932M1Z3|Prime Fitness LLP|A|L|8|c|20220902|\n27PKUXE9245J1ZN|Evergreen Stays LLP|A|L|7|g|20220313|\n23NRHXG9897E1ZN|Green Leaf Boutique|A|P|6|2|20190112|5\n27LVCXG6056U1Z4|Ganga Design Studio Pvt Ltd|A|C|7|g|20250509|1\n29ZJJXU6528T1ZQ|Unity Stationers|A|P|4|e|20230528|v\n36HVYXK1968I1Z4|Krishna & Associates|A|P|b|6|20251020|7\n23RFCXG7236H1ZU|Galaxy Medicals|A|P|6|2|20220313|m\n23MVTXS8772V1Z5|Sai & Associates|A|P|6|2|20221118|7\n09DUCXS8117Z1ZS|Sahyadri Kitchens|A|P|c|b|20220511|t\n36FRVXC4667G1ZS|City Unisex Salon|A|P|b|6|20210610|u\n07DKTXC0863P1Z2|Coral Sweets|A|P|2|5|20211012|\n08NTCXN9807D1ZT|Navkar Physio Clinic LLP|A|L|9|8|20191205|\n36WYTXS0726A1ZB|Saffron Electronics Pvt Ltd|A|C|b|6|20210319|b\n08KHLXS0801S1Z0|Star Stationers|A|P|9|8|20250918|\n29GZQXR5231B1ZK|Riddhi Hardware|A|P|4|1|20200309|f\n33ULVXP2769J1ZC|Prime Design Studio|A|P|a|4|20181205|\n32HLAXS0701A1ZG|Sai Sweets|A|P|5|9|20171128|w\n27YAFXN3658Y1ZE|Navkar Design Studio Pvt Ltd|A|C|7|i|20170103|\n23SCVXM0237L1ZE|Moonlight Legal Associates Pvt Ltd|A|C|6|2|20200908|i\n08BXPXB6024E1Z7|Blue Lotus Opticals|A|P|9|8|20220411|\n36EXXXA5889Q1ZM|Apex Insurance Advisors|A|P|b|6|20210420|\n27VMPXS1156X1ZQ|Sunrise Physio Clinic|A|P|7|d|20180118|o\n07WIJXN6905I1ZX|New Diagnostics Pvt Ltd|A|C|2|5|20230511|\n27YGQXV6887F1Z9|Vindhya Hardware|A|P|7|d|20210602|\n27AHKXS4423G1ZQ|Saffron Diagnostics|A|P|7|i|20221220|a\n24PXQXM1431U1ZX|Modern Physio Clinic|A|P|3|k|20250111|o\n07SYJXC0851L1ZH|City Boutique|C|P|2|5|20240903|5\n23XVDXC7863H1ZL|City Legal Associates Pvt Ltd|C|C|6|2|20220307|\n24MKOXU7805V1Z4|Unity Fitness Pvt Ltd|A|C|3|j|20190805|e\n07PPCXK8331X1Z6|Kaveri Legal Associates|A|P|2|5|20250925|i\n27QWYXM2972U1Z4|Metro Legal Associates Pvt Ltd|A|C|7|d|20190701|i\n10FYBXS3763U1Z8|Silver Oak Dental Care LLP|A|L|1|h|20190323|\n23PQKXK0028U1ZM|Kaveri Medicals|A|P|6|2|20250718|m\n33RHSXM1976C1ZA|Metro Classes|C|P|a|3|20170407|\n29RNDXS8639C1ZP|Silver Oak Physio Clinic Pvt Ltd|C|C|4|1|20240617|o\n27KJIXP9138C1ZA|Pearl Unisex Salon|A|P|7|g|20160927|\n03XCRXS1275P1ZT|Sunrise Legal Associates|A|P|8|c|20180922|i\n27JNHXS6667S1Z0|Saffron Bake House Pvt Ltd|A|C|7|d|20221217|4\n19JUEXN0880J1ZM|New Boutique|A|P|d|a|20240130|5\n24XMMXK8957L1Z6|Krishna Opticals|A|P|3|k|20220607|\n36BDJXS5306U1Z6|Shree Realty LLP|A|L|b|6|20160902|s\n24WIAXB0815W1Z5|Blue Lotus Woodcraft Pvt Ltd|C|C|3|k|20201014|d\n27NTPXP5112B1Z0|Prime Sweets|A|P|7|f|20221012|w\n36UYHXS1503V1ZP|Star Bakers|A|P|b|6|20201016|\n32MRFXS6294Q1Z5|Sai Dental Care Pvt Ltd|A|C|5|9|20220907|\n27DOWXB3195Z1ZZ|Balaji Design Studio|A|P|7|i|20240209|1\n10MNOXP4342Y1ZC|Pearl Hardware|A|P|1|h|20231129|f\n07PZAXR4965Z1Z5|Royal Bake House Pvt Ltd|A|C|2|5|20191214|\n29SMHXU0627U1Z3|Unity Sweets|A|P|4|e|20180914|w\n24BFCXA3138Q1Z2|Annapurna Medicals|A|P|3|k|20230323|\n24QPMXG9872L1ZB|Green Leaf Realty Pvt Ltd|A|C|3|k|20231002|s\n19ZBSXC4352H1ZC|City Bakers|A|P|d|a|20200725|\n24ZMHXS5345E1ZW|Sahyadri Stationers|A|P|3|0|20200326|\n32GQSXS4387Y1ZM|Sahyadri Legal Associates LLP|A|L|5|9|20230625|i\n24KRGXG1470N1Z1|Ganga Electronics|A|P|3|j|20200428|\n33IGJXE3487C1Z0|Evergreen Opticals|A|P|a|3|20160714|\n27PLVXE2632V1ZB|Evergreen Unisex Salon|A|P|7|i|20241125|\n29CYRXM5807A1ZQ|Modern Design Studio LLP|A|L|4|1|20211021|1\n08CASXM0333V1ZC|Metro Bakers|A|P|9|8|20160712|3\n36FUKXS8596L1ZU|Sunrise Sweets|A|P|b|6|20230831|\n27GQFXN6444Z1ZZ|Neelgiri Kitchens Pvt Ltd|A|C|7|d|20180902|t\n24CFOXL9000X1Z3|Lakshmi Textiles|A|P|3|0|20251108|x\n27CWZXB2676D1ZQ|Blue Lotus Mobile Care|C|P|7|d|20200204|j\n24KQGXS4666I1ZP|Sai Kitchens|A|P|3|0|20190509|\n27OXCXS1211K1ZQ|Sunrise Hardware|A|P|7|g|20250612|\n24HLCXM7018J1ZI|Moonlight Mobile Care|A|P|3|k|20220506|j\n27ELTXO9705A1Z9|Orbit General Store|A|P|7|d|20221203|h\n36XCUXM5897S1ZX|Modern Stays Pvt Ltd|C|C|b|6|20211224|6\n24JCZXV0187W1ZD|Vindhya Fashions LLP|A|L|3|0|20211219|\n19CPTXS3097V1ZO|Sunrise Mobile Care|A|P|d|a|20231107|\n27IIQXS9032L1ZR|Shree Fitness|A|P|7|d|20160830|e\n27QEFXG4213J1ZU|Galaxy Dental Care|A|P|7|d|20221116|\n19GDNXL7468Z1Z7|Lakshmi Dental Care|A|P|d|a|20250706|9\n27AQWXS6140A1Z5|Sai Stationers|A|P|7|d|20171113|v\n27IIJXR8437T1ZC|Riddhi Foods|A|P|7|d|20250619|c\n33WRJXR0086V1ZU|Royal Physio Clinic|A|P|a|3|20250218|\n23DZUXT3481I1Z6|Trinity Textiles|A|P|6|2|20190119|x\n36PYMXA5969V1ZD|Apex Dental Care LLP|A|L|b|6|20190313|\n07KWPXH1796O1ZY|Harmony Stays|A|P|2|5|20250430|\n36RGVXS6437S1Z2|Star Physio Clinic|A|P|b|6|20200407|o\n32AFHXS5568F1ZS|Shree Classes Pvt Ltd|S|C|5|9|20201101|\n27FCBXG1949U1ZE|Green Leaf Boutique|A|P|7|d|20190401|\n36IZGXM0908Q1Z9|Metro Hardware|A|P|b|6|20190402|\n27WLUXC0945A1ZA|Classic Design Studio|A|P|7|i|20191128|\n33YHQXS6275Z1ZM|Saffron Sweets|C|P|a|3|20230810|w\n19RHBXS1137B1ZS|Sahyadri Physio Clinic|A|P|d|a|20200211|o\n27BBXXS4468W1ZE|Sai Tours & Travels Pvt Ltd|A|C|7|f|20240428|y\n36TTMXG1033C1Z9|Green Leaf Bakers|A|P|b|6|20170520|\n07WPGXU6983C1ZE|Unity Fitness|A|P|2|5|20190707|e\n37ORPXN2811L1ZJ|Navkar Polymers LLP|A|L|0|l|20171020|p\n10ZYZXL6792M1ZC|Lakshmi Medicals|A|P|1|h|20180522|m\n24LRMXE2962Q1ZJ|Evergreen Diagnostics Pvt Ltd|A|C|3|j|20211002|a\n27UNUXH3118L1ZL|Harmony Hardware|A|P|7|d|20251102|f\n23CHOXN3174R1Z4|New Pharma Retail|A|P|6|7|20180729|n\n07BPKXA8806P1ZY|Annapurna Hardware|A|P|2|5|20230212|\n24BBXXZ2822N1Z9|Zenith Foods|A|P|3|j|20250108|c\n27WNLXP6083P1ZY|Pearl Stays LLP|A|L|7|d|20240530|6\n19IGBXU9493M1ZN|Unity Pharma Retail Pvt Ltd|A|C|d|a|20220805|n\n23FUNXN0062Y1Z8|Neelgiri Auto Components|A|P|6|7|20211209|2\n24AJAXM6648L1ZH|Moonlight Sweets|A|P|3|j|20160811|\n36KBDXC6383F1Z3|Coral Foods|A|P|b|6|20190218|c\n33USQXS2636N1Z2|Silver Oak Mobile Care|A|P|a|4|20240827|\n19TZHXS0930L1ZZ|Sahyadri Medicals|A|P|d|a|20170807|m\n29PLXXK9891B1ZD|Kaveri Unisex Salon|A|P|4|1|20190905|\n24RNNXK8608E1Z0|Kaveri Sweets|A|P|3|k|20200722|w\n27TPXXM9764F1ZZ|Moonlight General Store|A|P|7|f|20180922|\n19UJAXC4759T1ZI|Classic Legal Associates LLP|A|L|d|a|20230306|\n10NHYXS7046Z1Z2|Star Mobile Care|A|P|1|h|20210504|\n33GHCXN0530P1ZT|Neelgiri Unisex Salon|A|P|a|4|20231220|\n27HUQXS7102X1ZP|Sahyadri Bakers|A|P|7|d|20240418|\n27NJTXP5627D1Z0|Prime Medicals|A|P|7|i|20170331|\n23PFIXM4629X1ZO|Modern Fashions Pvt Ltd|A|C|6|7|20160730|0\n09BXVXS0016G1ZQ|Sai Unisex Salon|A|P|c|b|20250129|\n33RQEXP8122Y1Z1|Pearl Tours & Travels|A|P|a|3|20190213|y\n23OTHXM0928J1ZV|Metro Bakers|A|P|6|2|20221103|\n07YYMXK0200L1ZH|Krishna Woodcraft Pvt Ltd|A|C|2|5|20211209|d\n09OUBXK7063M1ZD|Kaveri Bakers|A|P|c|b|20170810|\n03OWRXN9827O1ZQ|Neelgiri Insurance Advisors|A|P|8|c|20220211|\n08KCZXU0932Q1ZQ|Unity & Associates LLP|A|L|9|8|20241221|\n07BLJXG6368F1ZH|Ganga Classes Pvt Ltd|A|C|2|5|20230314|\n32ULNXB0178V1ZL|Blue Lotus Fashions|A|P|5|9|20190704|0\n23LFIXM0618Q1ZH|Moonlight Foods LLP|A|L|6|2|20170227|\n07XOCXP1015M1ZY|Prime Physio Clinic Pvt Ltd|A|C|2|5|20170309|\n33BKQXK5786F1Z9|Krishna Mobile Care|A|P|a|3|20230221|\n27YAMXL0382V1ZO|Lakshmi Auto Components Pvt Ltd|A|C|7|g|20210924|2\n24OYEXS3299M1ZW|Shree Polymers|A|P|3|0|20200728|p\n23IFOXG2408J1ZY|Ganesh Diagnostics|A|P|6|2|20170906|a\n27WLOXS5015Q1Z8|Sahyadri Printers|A|P|7|i|20221208|r\n29PVFXO8582O1ZM|Orbit Tours & Travels Pvt Ltd|A|C|4|1|20251009|\n33FNFXP3437P1Z0|Prime Sweets|A|P|a|3|20200702|\n27BLTXZ9937X1ZG|Zenith Woodcraft LLP|A|L|7|d|20180824|\n19VALXG9077N1ZS|Green Leaf Classes Pvt Ltd|A|C|d|a|20161208|8\n32CKTXC7596A1ZL|Classic Sweets|A|P|5|9|20201118|w\n10WQKXK8321Q1ZI|Kaveri Mobile Care|S|P|1|h|20210204|\n27RATXS0183K1Z4|Saffron Electronics|A|P|7|i|20200918|b\n23LCEXR7132Z1ZX|Riddhi Dental Care|A|P|6|2|20190204|9\n33GQHXL2135V1ZQ|Lakshmi Mobile Care|S|P|a|4|20240603|\n27LZLXA1132L1ZS|Annapurna Fashions|A|P|7|d|20220212|0\n29JYEXS8660Q1ZK|Sai Kitchens|A|P|4|1|20240402|t\n24OSHXZ2913R1Z5|Zenith Auto Components LLP|A|L|3|k|20241215|2\n08HLOXC2613M1ZD|Coral Stays Pvt Ltd|A|C|9|8|20180829|6\n23NRSXV2894R1ZN|Vindhya Bake House LLP|A|L|6|7|20170610|4\n08UCXXN0395G1Z1|Neelgiri Realty Pvt Ltd|A|C|9|8|20200225|s\n09UHVXN9765S1ZM|Navkar Medicals|A|P|c|b|20220604|m\n27AVIXG8116T1ZE|Galaxy Realty|A|P|7|i|20220722|\n10KEFXS8866B1ZT|Shree Physio Clinic|S|P|1|h|20210107|o\n27CUJXA9514C1ZE|Annapurna Design Studio Pvt Ltd|A|C|7|i|20180407|1\n07UNSXC7020Q1ZJ|Coral Kids Academy Pvt Ltd|A|C|2|5|20210515|q\n33GOLXR0898W1Z0|Riddhi Boutique|A|P|a|3|20191214|\n07MXSXL4021B1ZY|Lakshmi Opticals|A|P|2|5|20251128|\n27LOAXN1089G1Z7|Neelgiri Physio Clinic LLP|A|L|7|g|20251101|o\n29HYHXC2082W1ZZ|City Printers Pvt Ltd|A|C|4|1|20230706|r\n29IINXU2467J1ZR|Unity Mobile Care|A|P|4|1|20220130|j\n19DYYXO9620N1ZN|Om Opticals|A|P|d|a|20190225|\n24ZTBXG5626Y1ZV|Galaxy General Store|A|P|3|0|20221228|\n19TUBXS5186C1ZG|Sai Mobile Care|A|P|d|a|20220405|j\n27MPQXC3446U1Z9|Classic Unisex Salon|A|P|7|d|20180619|u\n19UPSXP7949M1ZJ|Prime Stationers|C|P|d|a|20180830|v\n27UFRXS3635I1ZU|Sahyadri Insurance Advisors LLP|A|L|7|i|20250324|\n07CLHXG6316L1ZH|Green Leaf Physio Clinic LLP|A|L|2|5|20190127|\n29LPGXM6338F1ZW|Modern Physio Clinic Pvt Ltd|A|C|4|1|20170821|\n19JPYXO7539Z1Z5|Om Stationers|A|P|d|a|20250316|v\n36NBQXS8104V1ZN|Sunrise Legal Associates LLP|A|L|b|6|20241004|\n33JHBXS7422I1ZN|Sahyadri Legal Associates Pvt Ltd|A|C|a|3|20190917|i\n03EYMXA1177Z1Z5|Apex Bakers|A|P|8|c|20210617|\n24PITXK2108D1ZP|Kaveri Dental Care Pvt Ltd|C|C|3|k|20200905|\n27ECZXN3906S1ZV|Navkar Opticals|A|P|7|d|20171217|\n37QEEXC5787T1ZP|Coral Fitness|A|P|0|l|20220705|e\n23VNBXS4152E1ZB|Sai Insurance Advisors Pvt Ltd|A|C|6|2|20200503|\n33COOXV3602K1Z5|Vindhya Tours & Travels Pvt Ltd|A|C|a|4|20170922|\n08DVIXR5312G1ZZ|Riddhi Bake House Pvt Ltd|A|C|9|8|20170110|4\n08NSJXN0951X1ZW|Neelgiri Stationers|A|P|9|8|20250223|\n27SNZXG6439Y1ZF|Ganga Realty|A|P|7|d|20200415|\n19KIXXR6305M1ZK|Riddhi Pharma Retail LLP|A|L|d|a|20240620|n\n37GDLXA7956A1Z0|Annapurna Foods Pvt Ltd|A|C|0|l|20210304|c\n29WACXS1847I1ZB|Sahyadri Sweets|A|P|4|1|20210403|\n09RMUXT4842M1Z1|Trinity Kids Academy Pvt Ltd|A|C|c|b|20230629|q\n27KQYXE9039A1ZV|Evergreen General Store|A|P|7|d|20170623|\n27JQMXK5103U1ZG|Kaveri Medicals|A|P|7|g|20200124|\n07OGCXA4117T1ZG|Annapurna Fashions|A|P|2|5|20221013|0\n27VOQXA1669W1ZV|Apex Unisex Salon|C|P|7|d|20220509|\n08KWLXV3399N1ZL|Vindhya Printers|A|P|9|8|20240129|r\n23XRSXS4168G1Z8|Sai Hardware|A|P|6|7|20160705|\n24GMKXS8123T1ZJ|Sunrise Foods Pvt Ltd|A|C|3|k|20171108|c\n32WTTXG0680T1ZX|Ganesh Legal Associates|A|P|5|9|20231113|\n10DDBXN7334T1ZP|Navkar Legal Associates LLP|A|L|1|h|20161022|i\n03CALXB1193D1ZT|Blue Lotus Diagnostics|A|P|8|c|20200215|\n36ZXMXO7485E1ZR|Orbit Opticals|A|P|b|6|20201209|\n29LMTXP1870S1Z0|Pearl Insurance Advisors|A|P|4|e|20230716|g\n27XFLXN4133O1ZV|New Bake House LLP|A|L|7|d|20221211|\n36LHPXC8532B1ZR|City Foods LLP|A|L|b|6|20230913|c\n07EKIXC6601U1Z6|City Design Studio|S|P|2|5|20210822|\n27UECXS3433Z1ZH|Silver Oak Classes Pvt Ltd|A|C|7|i|20190105|8\n29HGCXC4102P1ZU|City Diagnostics|A|P|4|1|20201105|a\n29LURXS8004O1ZV|Sunrise Mobile Care|A|P|4|1|20170716|\n27LPWXG9754F1ZG|Galaxy Fashions Pvt Ltd|A|C|7|d|20160709|0\n32BOGXU6076K1ZZ|Unity Unisex Salon|A|P|5|9|20221229|\n19HBXXR4009Y1ZH|Royal Opticals|A|P|d|a|20240725|\n29ZMWXV1482B1ZC|Vindhya Diagnostics|A|P|4|e|20171220|a\n10DQXXO7016A1ZJ|Orbit Fitness LLP|A|L|1|h|20240725|e\n24VWDXN9449O1ZR|New Bake House LLP|A|L|3|0|20170615|4\n07NFZXC8624B1ZJ|Coral Packaging LLP|A|L|2|5|20240522|l\n32DCVXA4918A1ZH|Annapurna Physio Clinic LLP|A|L|5|9|20230724|\n27LGDXC3216T1ZG|City Fashions Pvt Ltd|A|C|7|i|20201014|0\n27TMWXB1737D1Z4|Balaji Stays Pvt Ltd|A|C|7|g|20200628|6\n29LIIXA5158S1ZT|Apex Woodcraft|A|P|4|e|20240526|d\n27TQTXZ0443H1ZA|Zenith Mobile Care|A|P|7|d|20180420|j\n23YNKXC2388Z1ZY|Coral & Associates|A|P|6|2|20210815|\n03FGDXG0862F1ZF|Ganesh Boutique|A|P|8|c|20231107|\n24XVFXM2432R1Z7|Metro Electronics Pvt Ltd|A|C|3|0|20230418|b\n19TOBXB8584U1Z0|Blue Lotus Medicals|A|P|d|a|20251119|\n27FAOXM1696M1ZB|Modern Boutique|A|P|7|i|20180227|\n23EFOXO8382B1ZQ|Orbit Design Studio Pvt Ltd|A|C|6|7|20240524|\n24NDYXN6883W1Z1|Navkar Insurance Advisors Pvt Ltd|S|C|3|0|20201207|g\n32EWIXN0657K1ZU|New Diagnostics|A|P|5|9|20210405|\n29ZVDXA7143S1ZX|Apex Boutique|A|P|4|e|20240207|\n33VAGXN8168S1ZS|Navkar Design Studio LLP|A|L|a|4|20190909|\n23PPSXS9906X1ZH|Sai General Store|C|P|6|7|20210325|h\n29GUHXO8952Z1ZB|Orbit Textiles|S|P|4|e|20190703|x\n29MEWXN5809F1Z3|Neelgiri General Store|A|P|4|1|20210911|\n27UVQXM0031X1ZQ|Metro Design Studio Pvt Ltd|A|C|7|i|20210910|1\n07FPFXA7897R1ZE|Amrit Kitchens LLP|A|L|2|5|20210821|t\n27NUBXO8554D1ZP|Orbit Dental Care|A|P|7|g|20230915|9\n23CJTXS5030M1Z8|Sai Boutique|A|P|6|7|20231119|\n24YVEXC7315Q1ZB|Classic Foods LLP|A|L|3|0|20191017|\n24LQAXA8164T1ZP|Annapurna Woodcraft|A|P|3|j|20181212|d\n09OGWXU0617M1ZP|Unity Diagnostics|A|P|c|b|20200218|a\n29HMTXC5339B1ZC|Classic Bake House Pvt Ltd|A|C|4|1|20170620|4\n27UKHXG3861X1Z7|Ganesh Fashions Pvt Ltd|A|C|7|f|20220921|0\n07KKLXG4668G1Z7|Green Leaf Packaging|A|P|2|5|20171120|l\n24ZCLXM4463L1Z3|Metro Sweets|A|P|3|j|20190111|w\n27RRPXS0902W1ZU|Sahyadri Legal Associates|A|P|7|d|20211025|\n24KLGXP1226J1ZI|Pearl Insurance Advisors Pvt Ltd|A|C|3|0|20170923|\n27FMOXN5985L1ZF|Neelgiri Kids Academy LLP|A|L|7|i|20221014|\n33QNZXA0280N1ZT|Annapurna Stays Pvt Ltd|A|C|a|3|20190128|6\n10LDZXZ0005Q1Z9|Zenith Textiles Pvt Ltd|A|C|1|h|20240217|x\n32LBXXL9653X1ZD|Lakshmi Hardware|A|P|5|9|20220509|\n29FUNXC3720P1ZM|Classic Medicals|A|P|4|e|20210921|\n29JLSXH0081V1ZE|Harmony Design Studio|A|P|4|1|20250726|1\n36OUNXC6106D1Z5|Coral Sweets|A|P|b|6|20220304|w\n24EGBXC6676J1ZT|City Packaging|A|P|3|k|20221024|l\n29HYSXB1572P1Z2|Balaji Stationers|A|P|4|1|20170711|v\n24TKLXP8929G1ZP|Pearl Opticals|A|P|3|0|20200803|k\n07CDNXC8276H1ZQ|City Hardware|A|P|2|5|20160705|f\n07FZZXK6226F1ZC|Kaveri Dental Care|A|P|2|5|20220611|9\n27DOEXM6985Y1ZW|Moonlight Unisex Salon|A|P|7|f|20240712|\n10DJSXG6688H1ZC|Galaxy Stationers|A|P|1|h|20210705|v\n23OPDXC5770V1ZJ|Coral Kids Academy LLP|A|L|6|7|20170825|\n09XMYXZ9913L1ZH|Zenith Printers LLP|A|L|c|b|20230417|r\n27KIYXP8937A1ZV|Prime Medicals|A|P|7|d|20171128|\n29CIAXG8665O1Z2|Galaxy Stays Pvt Ltd|A|C|4|1|20190523|\n32UZUXS1436A1ZH|Star Opticals|A|P|5|9|20190610|\n24JKEXL9990S1ZE|Lakshmi Foods Pvt Ltd|A|C|3|0|20200616|c\n32VORXM7739H1ZF|Modern Sweets|A|P|5|9|20200407|\n19EJFXR5551T1ZM|Royal Stationers|A|P|d|a|20231128|v\n07KVSXN6946Y1Z5|New Kids Academy LLP|A|L|2|5|20230104|q\n09RTUXC5983C1ZD|Classic Fitness LLP|A|L|c|b|20240721|e\n27RHQXS9052G1ZS|Silver Oak Stationers|A|P|7|d|20220306|\n27QHJXK0658U1ZL|Kaveri Stays LLP|A|L|7|d|20220713|6\n10SZLXM5318B1ZX|Moonlight Legal Associates|A|P|1|h|20181103|\n27CODXM7282I1Z2|Moonlight Medicals|A|P|7|i|20181029|m\n33NJMXA1777X1ZL|Amrit Dental Care LLP|A|L|a|3|20240402|\n03WIYXE0229K1Z6|Evergreen Dental Care Pvt Ltd|A|C|8|c|20250314|\n33GGWXR4592N1ZP|Royal Dental Care|S|P|a|3|20181212|\n36LRJXM4334F1Z2|Moonlight Dental Care Pvt Ltd|A|C|b|6|20171124|9\n09XHZXP5574S1ZM|Pearl Insurance Advisors LLP|A|L|c|b|20170203|g\n29IANXC9457Y1ZK|Coral Legal Associates Pvt Ltd|A|C|4|1|20240912|i\n23EEHXB1374T1ZP|Blue Lotus Kitchens Pvt Ltd|A|C|6|7|20170313|t\n29TYMXT6290C1ZW|Trinity Foods Pvt Ltd|A|C|4|1|20230704|\n07IBRXN7796J1ZX|New Opticals|A|P|2|5|20220901|k\n32XRMXP4614W1ZU|Pearl Printers|A|P|5|9|20181013|r\n07CKKXM8070B1ZO|Moonlight Hardware|A|P|2|5|20240608|f\n24BJMXG6304X1Z1|Galaxy Pharma Retail Pvt Ltd|C|C|3|0|20250114|n\n03XIHXZ1889Z1ZN|Zenith Dental Care Pvt Ltd|A|C|8|c|20200404|9\n36YXEXZ1955Y1ZX|Zenith Opticals|A|P|b|6|20191211|\n24CVKXA1075K1Z8|Amrit Bake House LLP|A|L|3|0|20210701|\n37OXMXZ3253C1ZB|Zenith Bakers|S|P|0|l|20241018|\n07WMBXB6827G1Z9|Balaji Opticals|A|P|2|5|20230928|\n27PABXM1024P1ZU|Modern Realty|C|P|7|i|20241206|s\n09WXSXN4795B1ZT|New Mobile Care|A|P|c|b|20170604|\n32GKLXO2040C1Z4|Om Sweets|A|P|5|9|20240604|\n07OCHXN3530V1Z3|New Mobile Care|A|P|2|5|20241111|\n29UDKXG1024B1Z5|Green Leaf Classes Pvt Ltd|A|C|4|1|20180815|\n29KWSXS2436K1ZZ|Sahyadri Boutique|A|P|4|e|20221201|5\n27SUDXR3895J1Z0|Royal Electronics Pvt Ltd|A|C|7|d|20160605|\n36YCPXA2716A1Z2|Apex Stationers|A|P|b|6|20210305|v\n27RXPXE6163B1ZM|Evergreen Polymers LLP|A|L|7|d|20180815|p\n09KCMXB5195Q1Z3|Balaji Opticals|A|P|c|b|20211001|\n07EVQXG4026B1ZC|Ganga Fashions LLP|A|L|2|5|20220127|\n32NOHXM2892Z1Z0|Moonlight Textiles Pvt Ltd|A|C|5|9|20220110|x\n33UFSXS5696G1ZO|Saffron Fashions Pvt Ltd|A|C|a|3|20210216|0\n08RZYXS1979U1ZM|Sai Medicals|C|P|9|8|20170216|m\n27CXWXS0320D1ZX|Saffron Auto Components|C|P|7|d|20240325|2\n08ZKQXH0948H1ZR|Harmony Electronics|A|P|9|8|20180430|b\n07HNAXG8174S1ZP|Ganga Fitness LLP|A|L|2|5|20170504|\n09VYTXO4610D1Z8|Om Kitchens|A|P|c|b|20160707|\n23FZCXC2581W1ZC|Classic & Associates|A|P|6|7|20181027|7\n27TLPXS6041X1ZS|Sahyadri Tours & Travels|A|P|7|f|20220707|\n27RSBXR8684X1ZA|Royal Bake House Pvt Ltd|A|C|7|i|20251113|\n23MHKXG4428N1ZE|Galaxy Medicals|A|P|6|7|20250220|m\n27JPRXL2696W1ZO|Lakshmi Kitchens Pvt Ltd|A|C|7|g|20170525|t\n33RIHXS8082O1ZK|Sahyadri Realty|A|P|a|3|20161214|s\n33GUHXN0161K1Z4|New Mobile Care|C|P|a|3|20250606|\n27FJGXR1453Y1ZK|Royal Unisex Salon|A|P|7|d|20210805|\n27TZFXM1216B1ZY|Metro Realty|C|P|7|d|20220712|\n33DYIXM7465E1ZR|Metro Unisex Salon|A|P|a|3|20220930|u\n24KXHXH3926O1ZG|Harmony Polymers Pvt Ltd|A|C|3|k|20250701|p\n27OLTXC7225C1ZC|Classic Hardware|A|P|7|f|20210717|\n24AFYXN8507P1ZZ|Navkar Hardware|A|P|3|k|20181214|f\n03PSFXH1822U1ZO|Harmony Hardware|A|P|8|c|20190217|f\n07HPRXC6963Y1ZV|City Pharma Retail|A|P|2|5|20170310|\n29DTEXC5949N1ZK|Classic Bakers|A|P|4|e|20181210|\n27REHXN6538D1ZH|New Bakers|A|P|7|g|20230418|3\n09EJRXK1355H1ZD|Kaveri Physio Clinic Pvt Ltd|A|C|c|b|20250923|\n07KXUXA7571P1ZV|Amrit Legal Associates LLP|A|L|2|5|20191224|i\n24SNDXS9552C1Z0|Silver Oak Pharma Retail|A|P|3|k|20241222|\n33CSQXU7363F1ZP|Unity Boutique|A|P|a|3|20240429|5\n19XVMXO4475K1ZO|Om Boutique|A|P|d|a|20171011|5\n29NIQXC0858S1ZK|Classic Packaging LLP|A|L|4|e|20161031|l\n27EVTXS3524O1Z3|Star Opticals|A|P|7|i|20170323|\n23EYHXG5209B1ZI|Ganga Stationers|A|P|6|7|20190923|\n23OJMXS7818Z1ZX|Sai Auto Components|S|P|6|2|20241108|2\n27QKFXS7824Q1ZC|Sahyadri Pharma Retail LLP|A|L|7|d|20190621|n\n32LWZXR4918P1ZO|Riddhi Packaging Pvt Ltd|A|C|5|9|20170305|l\n23TKAXA3131J1ZY|Amrit Kids Academy Pvt Ltd|A|C|6|2|20210330|q\n27SCVXZ7693J1Z7|Zenith Stays|A|P|7|f|20230916|\n23PUBXE0107T1ZZ|Evergreen Electronics Pvt Ltd|A|C|6|2|20210311|\n33IOXXZ4920B1ZY|Zenith Kids Academy LLP|A|L|a|3|20221224|q\n08ETYXE7309X1ZR|Evergreen Stationers|C|P|9|8|20161023|\n27MLWXA1430K1Z9|Apex Opticals|A|P|7|d|20180109|\n37NLEXM1705U1ZR|Modern Classes LLP|A|L|0|l|20191006|8\n29OIGXR5171N1ZO|Royal Unisex Salon|A|P|4|1|20220129|u\n07HVJXB7388S1ZZ|Balaji Hardware|A|P|2|5|20221010|f\n27AHEXP1270H1ZY|Prime Bakers|A|P|7|d|20200209|\n07ENJXN9717T1ZB|Navkar Mobile Care|A|P|2|5|20180829|\n24QKIXB1345J1ZM|Balaji Bakers|A|P|3|k|20220710|3\n09EXPXE6994I1Z3|Evergreen Kitchens LLP|A|L|c|b|20160627|t\n24PGZXG5508X1ZD|Ganga Sweets|A|P|3|0|20180506|\n29FHRXP3295J1ZU|Prime Mobile Care|A|P|4|1|20250211|\n36MRSXP6569I1Z1|Prime Realty Pvt Ltd|A|C|b|6|20211029|s\n07HYWXS2929C1ZB|Shree Stays Pvt Ltd|A|C|2|5|20161003|6\n08JINXZ3311D1ZH|Zenith Stays LLP|A|L|9|8|20190322|6\n08XJIXB4808P1ZT|Balaji Sweets|A|P|9|8|20231123|w\n24VSGXM0726Z1ZX|Moonlight Kitchens Pvt Ltd|A|C|3|0|20170131|\n36VJBXN1754L1Z0|Navkar Hardware|A|P|b|6|20161006|f\n23LFTXG6802G1ZR|Green Leaf Stays|A|P|6|2|20220425|\n27QLPXG0008R1ZW|Galaxy Kitchens Pvt Ltd|A|C|7|i|20190604|t\n27IJQXV5495S1ZX|Vindhya Legal Associates Pvt Ltd|A|C|7|d|20230813|i\n33JUDXC1155D1ZR|Classic Electronics|A|P|a|3|20180616|b\n29IZRXM4618Z1Z4|Modern Opticals|A|P|4|1|20211109|k\n27HIRXC1270W1ZT|Classic Hardware|A|P|7|d|20160929|\n27DVDXM8083Y1ZQ|Modern Mobile Care|A|P|7|d|20190730|j\n29BBOXA9525C1Z6|Annapurna Physio Clinic|A|P|4|e|20220824|o\n27BBQXB7205O1ZT|Blue Lotus Auto Components|A|P|7|i|20220628|\n27PBZXA8238C1ZL|Annapurna Diagnostics|A|P|7|i|20190313|\n27HECXM6731Q1ZB|Modern Textiles|A|P|7|d|20200524|x\n08DCBXS2327L1ZW|Sai Fashions Pvt Ltd|A|C|9|8|20230115|0\n19KUKXO2374G1ZK|Om Foods|A|P|d|a|20240101|c\n27NJLXS6137L1ZP|Sai Sweets|A|P|7|d|20190614|\n36HDEXH4151W1ZB|Harmony Hardware|A|P|b|6|20251104|f\n19PFUXE2469P1ZN|Evergreen Fashions LLP|A|L|d|a|20191102|\n07KUDXK0532Q1ZR|Kaveri Classes Pvt Ltd|A|C|2|5|20210514|\n24WXLXA6240U1ZY|Apex Stationers|A|P|3|0|20221117|v\n07FTFXC2066Y1ZF|City Physio Clinic|A|P|2|5|20240429|o\n24ZONXS6191A1ZO|Sai Sweets|A|P|3|0|20220117|w\n36YKAXM5103I1ZC|Metro Stays|A|P|b|6|20230105|6\n09DIQXV7400T1ZJ|Vindhya General Store|A|P|c|b|20221016|\n24HSIXO8710E1Z6|Orbit Hardware|A|P|3|k|20210722|f\n24MVZXS5986A1Z2|Silver Oak Fashions|A|P|3|0|20190809|0\n24RNZXS8251I1Z8|Sahyadri Hardware|A|P|3|j|20190111|\n33TJTXO7572A1Z0|Om Hardware|A|P|a|3|20230609|f\n07PYGXR7151E1ZG|Riddhi Textiles LLP|A|L|2|5|20250113|x\n24DUWXS3193B1ZR|Silver Oak Hardware|A|P|3|j|20250929|\n27TGVXC7639C1Z6|Coral Bakers|C|P|7|d|20210901|3\n27HQPXS8054J1ZD|Sai Insurance Advisors Pvt Ltd|A|C|7|d|20210831|\n33GCRXK4647Q1Z7|Krishna Boutique|A|P|a|3|20170319|\n36ZAVXN4012O1Z0|Navkar Dental Care|A|P|b|6|20240407|9\n07ALJXG5824F1ZR|Ganesh Diagnostics LLP|A|L|2|5|20220519|a\n10DYCXZ4415C1ZC|Zenith Classes Pvt Ltd|A|C|1|h|20250412|8\n03ZLPXB2480P1ZQ|Blue Lotus Mobile Care|A|P|8|c|20240831|j\n08WBGXO3360Q1Z1|Orbit Textiles Pvt Ltd|A|C|9|8|20250703|\n19SNJXS7868G1Z6|Sunrise Hardware|A|P|d|a|20251016|f\n29ANMXK2556C1ZH|Krishna Dental Care Pvt Ltd|A|C|4|1|20220501|\n29LOLXS9848C1ZG|Sai Diagnostics Pvt Ltd|A|C|4|1|20240102|a\n33XVWXO2128U1ZI|Orbit Stationers|A|P|a|3|20210926|v\n29NFUXC3483A1ZL|City Stationers|A|P|4|e|20180211|v\n33JUBXS3125E1ZD|Saffron Packaging Pvt Ltd|A|C|a|4|20181030|l\n27UXWXA0832J1ZB|Amrit & Associates|A|P|7|d|20190501|7\n29YWTXA5584L1ZL|Apex General Store|A|P|4|e|20180926|\n27UQGXK3493K1ZE|Kaveri Packaging LLP|A|L|7|i|20220614|l\n29QLRXG9641Z1ZL|Ganesh Stationers|A|P|4|e|20230806|v\n10FZQXB2095N1ZN|Blue Lotus Boutique|A|P|1|h|20190713|\n33RUYXV1366F1Z6|Vindhya Woodcraft Pvt Ltd|A|C|a|4|20190802|d\n37WFKXS1363B1ZG|Silver Oak Electronics|A|P|0|l|20220219|b\n07LYRXT3271B1ZG|Trinity Stationers|S|P|2|5|20200917|\n07BICXB0867A1ZH|Balaji Stationers|A|P|2|5|20250716|v\n08CUKXE8974P1Z4|Evergreen Unisex Salon|A|P|9|8|20200320|u\n23ULAXT3684H1ZZ|Trinity Opticals|A|P|6|2|20190212|k\n07LKHXC7996F1Z3|Classic Bakers|A|P|2|5|20251102|3\n33JFFXS4561S1Z1|Star Sweets|A|P|a|3|20181003|\n27VVIXV3159F1Z6|Vindhya Unisex Salon|A|P|7|d|20201022|\n24ERUXP4960X1ZR|Pearl Sweets|A|P|3|j|20160908|\n33QYFXG7633G1ZP|Ganga Bake House Pvt Ltd|A|C|a|3|20230122|4\n09XOPXC9535U1ZP|Classic General Store|A|P|c|b|20241229|\n36TXYXS9563T1ZN|Shree Design Studio Pvt Ltd|A|C|b|6|20230309|\n29PYAXN0298L1Z3|Neelgiri Bake House LLP|A|L|4|1|20161028|4\n07LQXXB6269X1ZN|Blue Lotus Dental Care LLP|A|L|2|5|20240620|9\n27OEDXZ6685K1ZP|Zenith & Associates|A|P|7|d|20190604|7\n27GPTXS9043W1ZN|Sai Stationers|A|P|7|f|20190801|v\n27DVQXB8599I1Z7|Balaji Pharma Retail|A|P|7|i|20210406|n\n23VRTXP3464M1Z2|Pearl Kids Academy|A|P|6|7|20230412|\n19WUGXR1711E1ZQ|Royal & Associates Pvt Ltd|A|C|d|a|20180523|7\n24COHXR7810Z1ZB|Royal Sweets|A|P|3|j|20160625|w\n33EWPXC6847X1ZU|City Boutique|A|P|a|3|20180918|\n08XMMXP5228D1ZU|Prime Unisex Salon|C|P|9|8|20180829|\n29GMOXK0052I1ZB|Kaveri Kids Academy Pvt Ltd|A|C|4|1|20190924|\n24NTIXN0373K1ZR|Neelgiri Fitness Pvt Ltd|A|C|3|0|20250311|\n36MMSXG2481X1Z3|Green Leaf Dental Care LLP|A|L|b|6|20220124|9\n03JLPXA0779G1ZK|Apex Printers|A|P|8|c|20250824|\n29HXBXL0884R1Z2|Lakshmi Mobile Care|A|P|4|1|20210110|\n03KJOXO6653A1ZL|Om & Associates|A|P|8|c|20210801|7\n03XBMXC8843L1ZC|Coral Physio Clinic|A|P|8|c|20190923|o\n24WRVXA6707S1Z0|Apex Tours & Travels Pvt Ltd|A|C|3|j|20171222|\n23AJYXK8731A1ZO|Krishna Sweets|A|P|6|2|20161113|\n29JZRXL0992A1ZE|Lakshmi Realty|A|P|4|1|20240403|s\n24DIRXC5851E1ZT|Classic General Store|A|P|3|0|20170603|h\n07ZFCXG0178V1ZS|Ganga Stationers|A|P|2|5|20211110|v\n37LDYXK0296F1ZB|Kaveri Insurance Advisors|A|P|0|l|20230920|g\n29JRJXK1636S1ZB|Krishna Realty Pvt Ltd|A|C|4|e|20160807|\n29QQWXM4152B1ZP|Modern Boutique|A|P|4|1|20161118|5\n29AODXO0639C1ZO|Orbit Kitchens|A|P|4|1|20180307|t\n32LNTXS5027E1Z4|Sunrise Legal Associates|A|P|5|9|20160920|\n27OLGXR5415V1ZB|Royal Physio Clinic LLP|A|L|7|f|20190405|o\n10GQYXR7711O1ZH|Royal Unisex Salon|A|P|1|h|20171114|\n07KEMXK6982P1ZR|Krishna Insurance Advisors|A|P|2|5|20220830|\n33XAQXA9673X1ZF|Amrit Electronics|A|P|a|3|20250813|\n36AFHXK2573T1Z8|Krishna Realty LLP|A|L|b|6|20220421|s\n27EIBXS6312B1Z2|Silver Oak Dental Care Pvt Ltd|A|C|7|d|20240415|\n23KCMXA3782L1ZR|Annapurna Boutique|A|P|6|7|20241030|\n09PSRXZ6196E1ZU|Zenith Textiles Pvt Ltd|A|C|c|b|20250214|x\n29PJLXA2257F1ZH|Apex Stationers|A|P|4|1|20251118|\n07RURXO2843G1ZD|Orbit Kitchens|A|P|2|5|20251110|t\n29VHOXK8384R1ZY|Krishna Electronics|A|P|4|e|20230215|\n29WEZXS9380S1ZK|Star Electronics Pvt Ltd|A|C|4|e|20180413|b\n27VPPXM5579J1ZZ|Moonlight Stationers|A|P|7|f|20211106|v\n37TSWXP2469N1ZL|Prime Bake House|A|P|0|l|20161120|4\n27AJJXV6630Q1ZT|Vindhya Insurance Advisors|A|P|7|d|20181205|\n24KNKXA8058K1Z3|Apex Polymers|A|P|3|j|20221130|p\n08VAAXG1182P1ZK|Green Leaf Boutique|A|P|9|8|20161118|5\n24PVFXP8369F1ZD|Prime Unisex Salon|A|P|3|k|20210716|\n32IZUXL5219E1ZN|Lakshmi Packaging Pvt Ltd|A|C|5|9|20250621|l\n36CBTXC5624F1Z5|Coral Insurance Advisors|A|P|b|6|20240228|\n29BJQXC7829K1Z1|Coral Stationers|A|P|4|1|20190921|v\n36TGAXS7896Q1Z8|Sai Hardware|A|P|b|6|20170517|\n27CAOXC0203L1ZH|City Legal Associates|A|P|7|f|20210614|\n07DRTXO5726Q1Z6|Om Unisex Salon|A|P|2|5|20171125|\n19FOTXO7660O1Z4|Om Mobile Care|C|P|d|a|20191224|\n27IVYXR1612Y1ZI|Royal Polymers|A|P|7|d|20210703|p\n07SKQXS8836R1ZT|Sunrise Stationers|A|P|2|5|20240926|v\n23HFAXS8866V1ZN|Silver Oak Pharma Retail|S|P|6|7|20210203|n\n07OIYXS0841H1ZX|Star Diagnostics LLP|A|L|2|5|20220219|a\n24DVYXS3457E1ZI|Star Legal Associates Pvt Ltd|A|C|3|k|20251102|\n07JTEXR6802S1Z9|Royal Bake House|A|P|2|5|20191123|\n33EKKXA3225R1ZJ|Annapurna Medicals|A|P|a|3|20161020|m\n29PTBXP7467P1ZT|Pearl Diagnostics Pvt Ltd|C|C|4|1|20230826|\n24HMEXZ0382W1ZE|Zenith Printers|A|P|3|k|20230512|r\n07EHLXH5388Q1ZV|Harmony Design Studio Pvt Ltd|C|C|2|5|20201022|1\n24SGGXO0874E1ZL|Om Boutique|A|P|3|j|20230307|5\n27ZWMXE9032E1ZF|Evergreen & Associates LLP|A|L|7|d|20180217|7\n24RWEXR9692E1Z6|Royal Diagnostics Pvt Ltd|A|C|3|k|20170203|a\n24GWNXS9625S1ZP|Sunrise Mobile Care|A|P|3|k|20220104|j\n37HHLXE7594H1Z7|Evergreen Printers Pvt Ltd|A|C|0|l|20250122|r\n07GOCXG9273O1ZS|Galaxy Insurance Advisors LLP|C|L|2|5|20220110|\n27GQTXO9479Y1Z5|Orbit Physio Clinic Pvt Ltd|A|C|7|d|20180907|\n09DRNXS5143S1Z5|Saffron General Store|A|P|c|b|20240127|\n32YHZXE8380O1ZD|Evergreen Bakers|A|P|5|9|20170722|\n27ZPOXA8804O1Z8|Amrit Fitness Pvt Ltd|A|C|7|g|20230828|e\n27VJQXM9225A1Z2|Modern Tours & Travels|A|P|7|d|20251003|y\n27HJRXM4322O1ZY|Moonlight Polymers LLP|A|L|7|d|20180404|\n36ODXXR6364Z1ZU|Royal Classes Pvt Ltd|A|C|b|6|20191227|\n33OKMXR0639F1ZB|Royal Bakers|A|P|a|3|20170919|\n07QXEXG6467I1ZC|Green Leaf Fashions Pvt Ltd|A|C|2|5|20250402|0\n27CELXV0421C1Z8|Vindhya Fitness Pvt Ltd|A|C|7|g|20171014|e\n36WKAXP7872S1Z3|Prime Dental Care LLP|C|L|b|6|20180616|9\n19JMAXA7183G1ZG|Apex Classes Pvt Ltd|A|C|d|a|20250107|\n32MMJXP5816J1Z2|Pearl Realty Pvt Ltd|C|C|5|9|20241028|s\n32NAZXC6642D1ZY|Coral Dental Care LLP|A|L|5|9|20190924|9\n24DHXXT8548G1ZX|Trinity Opticals|A|P|3|j|20180109|\n10MOMXU2750P1ZP|Unity Electronics Pvt Ltd|A|C|1|h|20240417|b\n36SDMXT7959U1ZY|Trinity General Store|S|P|b|6|20180315|\n29JOIXM9756X1ZL|Modern Opticals|A|P|4|e|20190117|k\n23LWIXC6365X1ZY|City Bakers|A|P|6|2|20251122|3\n09BXNXS1781M1Z3|Star Physio Clinic Pvt Ltd|A|C|c|b|20180805|\n33UWTXA7897Y1ZY|Apex Sweets|A|P|a|4|20181022|\n03WPQXG4818F1ZY|Ganga Boutique|A|P|8|c|20220130|\n27FJDXL0347F1ZX|Lakshmi Stationers|A|P|7|i|20161122|\n37JXBXN9414M1ZB|New Opticals|S|P|0|l|20250427|\n29AMRXB9061D1ZF|Blue Lotus Sweets|A|P|4|1|20180514|w\n03RJZXA1306M1ZC|Amrit Opticals|A|P|8|c|20200222|\n08ZHEXS1288R1ZB|Silver Oak Design Studio Pvt Ltd|A|C|9|8|20180531|\n07EHCXG5083U1Z5|Ganga Electronics LLP|C|L|2|5|20160714|b\n19PVEXS5788C1Z7|Sunrise Electronics|A|P|d|a|20200510|b\n23NTXXS8330P1ZU|Sunrise Packaging LLP|A|L|6|2|20251118|\n36KOZXG1838C1Z2|Ganesh Auto Components Pvt Ltd|A|C|b|6|20201222|2\n27YAVXO4296R1Z7|Om Physio Clinic|A|P|7|i|20180227|o\n07FXWXA3245D1Z0|Apex Kitchens LLP|A|L|2|5|20220626|t\n10KARXO3955D1Z1|Om Mobile Care|A|P|1|h|20210727|\n29PXAXR5038T1ZP|Royal Diagnostics LLP|A|L|4|1|20180414|a\n33TZXXR2466D1Z0|Royal Realty|A|P|a|3|20190324|s\n36ZIUXN2729K1ZG|Navkar General Store|A|P|b|6|20180516|h\n33MAUXL7404N1ZE|Lakshmi Boutique|A|P|a|4|20201231|5\n32CXWXR1014I1ZV|Riddhi Tours & Travels|A|P|5|9|20160926|\n33EPCXA3574Z1ZP|Amrit Electronics LLP|A|L|a|3|20210210|\n07NTXXL6218Y1ZE|Lakshmi Sweets|A|P|2|5|20181221|\n07STAXT9973F1Z7|Trinity Bakers|A|P|2|5|20251027|\n33LFYXO9404H1Z7|Om Kids Academy|A|P|a|3|20210809|q\n36RMWXS1846D1ZO|Sai Unisex Salon|A|P|b|6|20230422|\n23NTLXS6232X1ZT|Silver Oak General Store|A|P|6|2|20210915|h\n07JLJXC7064T1ZP|Classic Fashions Pvt Ltd|A|C|2|5|20251116|0\n32DDDXB4295L1Z3|Balaji Legal Associates|A|P|5|9|20171005|\n33CEFXG6920L1Z1|Ganesh Unisex Salon|A|P|a|4|20191001|u\n36GNEXM4470I1Z8|Moonlight Mobile Care|C|P|b|6|20200221|j\n24FFCXS6936H1ZN|Sai Kitchens LLP|A|L|3|k|20170925|\n10SNWXA8583G1ZV|Annapurna Fashions LLP|A|L|1|h|20240222|0\n29QMHXO9240L1ZI|Om Unisex Salon|A|P|4|1|20191026|\n27KNFXA4620I1ZM|Amrit Kitchens|C|P|7|g|20250128|t\n27ACEXL7239B1ZB|Lakshmi Insurance Advisors|A|P|7|f|20161228|g\n07LKZXK1954S1Z8|Krishna Classes|A|P|2|5|20220923|8\n19RJKXC2279L1ZW|City Bake House|A|P|d|a|20210601|4\n24NNYXR4784D1ZJ|Royal Kitchens LLP|A|L|3|0|20221013|\n27DMDXS7812C1ZK|Silver Oak Sweets|A|P|7|i|20160609|w\n33LEFXM6212E1Z8|Modern Boutique|C|P|a|4|20180727|5\n07TZZXN7665H1ZE|Navkar Tours & Travels LLP|A|L|2|5|20191230|y\n24OCIXZ2668W1ZF|Zenith Sweets|A|P|3|j|20250602|w\n07ECEXK4619X1Z7|Kaveri Opticals|A|P|2|5|20210806|\n36STKXS7287M1ZN|Sai Kitchens|A|P|b|6|20220220|\n19ASLXM9824D1ZW|Modern Sweets|A|P|d|a|20210215|\n07PSKXR3845D1ZP|Royal Printers|A|P|2|5|20231123|\n27SWPXC2610T1Z4|Coral Pharma Retail Pvt Ltd|A|C|7|d|20200121|\n29MNFXA0593C1ZL|Annapurna Classes Pvt Ltd|A|C|4|e|20170624|\n07OKWXS7797H1Z2|Star Opticals|A|P|2|5|20211214|k\n27BIIXZ6034L1Z3|Zenith Realty|A|P|7|f|20240512|s\n03AZHXA5578T1ZB|Annapurna Kitchens Pvt Ltd|A|C|8|c|20170520|t\n08ZXXXP0967K1ZC|Pearl Foods Pvt Ltd|S|C|9|8|20161220|\n33OLBXS5839T1ZE|Silver Oak Auto Components Pvt Ltd|A|C|a|3|20220511|2\n33BHHXS7386I1ZA|Saffron Pharma Retail Pvt Ltd|A|C|a|4|20210220|n\n36FHUXA7868Y1Z6|Amrit General Store|A|P|b|6|20231215|h\n27FLFXV5821G1ZA|Vindhya Stays Pvt Ltd|A|C|7|d|20210803|6\n19SMZXE7050F1ZQ|Evergreen Classes|A|P|d|a|20250704|8\n33XJMXS6104Q1ZK|Sahyadri Classes LLP|A|L|a|3|20230317|8\n37ARNXL3454Z1Z0|Lakshmi Realty Pvt Ltd|A|C|0|l|20180121|\n10JUQXK5160F1Z5|Kaveri General Store|A|P|1|h|20200613|h\n29QPMXK3051Y1ZW|Kaveri Classes LLP|A|L|4|e|20220224|\n10HQDXB6962I1ZI|Balaji Mobile Care|A|P|1|h|20170305|\n36KFRXS1586E1Z8|Silver Oak Mobile Care|A|P|b|6|20211001|j\n37GOGXE4450Y1ZI|Evergreen Opticals|A|P|0|l|20220112|\n03VMIXG7214C1ZN|Ganga Stays|A|P|8|c|20240226|6\n29QHGXK0261C1ZU|Kaveri Tours & Travels|A|P|4|e|20170319|\n08DSPXA2219U1ZM|Apex Legal Associates|A|P|9|8|20240314|\n03TDUXN2907O1Z2|Navkar Unisex Salon|A|P|8|c|20210202|\n27NHWXC2066C1ZM|Classic Kitchens Pvt Ltd|A|C|7|d|20250611|t\n07GRGXS7135L1ZN|Star Realty Pvt Ltd|A|C|2|5|20220903|\n19GGEXS8492U1ZB|Saffron Unisex Salon|A|P|d|a|20160926|\n37XFSXE2828J1Z0|Evergreen Medicals|A|P|0|l|20190619|\n23FMTXM9967N1Z9|Moonlight Polymers Pvt Ltd|A|C|6|7|20231122|p\n27TUHXB9960C1ZO|Blue Lotus Fashions|A|P|7|i|20250514|\n27ZWYXR2491Z1ZI|Riddhi & Associates Pvt Ltd|S|C|7|i|20210920|\n23CPPXS2227Q1ZR|Silver Oak Hardware|A|P|6|2|20250713|f\n23UWNXO1214C1Z1|Om Bake House|A|P|6|2|20210401|\n07QJXXK4804O1ZK|Krishna Stationers|A|P|2|5|20240805|v\n19SCZXP7440L1ZL|Pearl Opticals|A|P|d|a|20171009|k\n33HPKXE6847V1ZC|Evergreen Sweets|A|P|a|3|20210619|w\n24GSDXG8846G1Z3|Green Leaf Mobile Care|A|P|3|k|20230527|\n27MNXXC6669V1ZP|Classic Bakers|A|P|7|d|20250711|\n19LVBXS5878B1ZH|Shree Physio Clinic|A|P|d|a|20170918|\n27DSCXH9978R1Z2|Harmony Legal Associates|A|P|7|i|20221228|i\n36QSKXN4637F1ZN|Navkar Kitchens|A|P|b|6|20250904|t\n03MAUXP8631O1Z4|Pearl Auto Components|A|P|8|c|20181221|2\n03WCOXO5760M1Z1|Om Dental Care Pvt Ltd|A|C|8|c|20231124|\n29GWGXB5615J1ZV|Blue Lotus Dental Care Pvt Ltd|A|C|4|1|20221121|\n24EFTXO2546M1ZA|Om Mobile Care|A|P|3|j|20170605|\n03EYIXM7636K1ZJ|Metro Tours & Travels|A|P|8|c|20251027|y\n07WPKXM9768N1ZQ|Modern Boutique|A|P|2|5|20191122|5";
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
  const date = fields[6];
  return {
    entryType: ENTRY_TYPE.GSTIN,
    tradeName: fields[1],
    status: STATUS_BY_CODE[fields[2]] || fields[2],
    constitution: CONSTITUTION_BY_CODE[fields[3]] || fields[3],
    state: STATE_NAMES[parseInt(fields[4], 36)] || "",
    city: CITY_NAMES[parseInt(fields[5], 36)] || "",
    registrationDate: new Date(
      Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))),
    ),
    nicDescription: fields[7] ? NIC_DESCRIPTIONS[parseInt(fields[7], 36)][0] : "",
  };
}

/**
 * SIMULATED: the case's mock Udyam registry (synthetic; district code 00 does not exist), for Udyam entry.
 * One record per line: number without "UDYAM-"|enterprise name|business-type index|state index|city index|
 * registration date (YYYYMMDD)|enterprise type M/S/D. Indices point into the lists above, as for GST records.
 */
const UDYAM_REGISTRY_TEXT = "KL-00-3078801|Balaji Dental Care LLP|9|5|9|20231225|M\nTN-00-3866196|Star Electronics|b|a|3|20210425|M\nMH-00-7656096|Zenith Diagnostics|a|7|f|20231229|M\nKL-00-2007485|Royal Fashions|0|5|9|20210124|M\nRJ-00-3201049|Amrit Fashions|0|9|8|20210812|M\nPB-00-4186215|Green Leaf Physio Clinic|o|8|c|20211123|M\nAP-00-8759641|Riddhi Fashions Pvt Ltd|0|0|l|20220319|D\nMH-00-6293684|Shree Legal Associates Pvt Ltd|i|7|i|20230315|M\nKR-00-0687054|Metro Sweets|w|4|e|20220705|M\nWB-00-0060377|Coral Bake House Pvt Ltd|4|d|a|20220603|M\nWB-00-1029713|Blue Lotus Kitchens Pvt Ltd|t|d|a|20220618|M\nKR-00-3490370|Classic Unisex Salon|u|4|1|20240521|M\nTN-00-8339916|Om & Associates Pvt Ltd|7|a|4|20250604|M\nMH-00-5667782|Pearl Medicals|m|7|f|20250322|M\nPB-00-7313309|Saffron Tours & Travels|y|8|c|20210511|M\nUP-00-9722236|Evergreen Kids Academy LLP|q|c|b|20250905|M\nKR-00-3492978|Orbit Diagnostics Pvt Ltd|a|4|1|20240324|M\nDL-00-3640872|Green Leaf Hardware|f|2|5|20210608|S\nGJ-00-2911099|Om Pharma Retail LLP|n|3|j|20240831|S\nKR-00-5223683|Krishna Pharma Retail|n|4|e|20230829|M\nMP-00-9974500|Moonlight Medicals|m|6|7|20230228|M\nTN-00-0063604|Blue Lotus Medicals|m|a|3|20220821|M\nMP-00-9067638|New Textiles Pvt Ltd|x|6|7|20231230|D\nGJ-00-7142345|Unity Insurance Advisors|g|3|0|20240224|M\nMP-00-9364249|Metro Polymers|p|6|2|20210916|S\nMH-00-7697315|Pearl & Associates Pvt Ltd|7|7|g|20241220|M\nBR-00-4016785|Zenith Sweets|w|1|h|20230710|M\nRJ-00-6663020|Prime Polymers|p|9|8|20231214|M\nGJ-00-1728199|Evergreen Textiles Pvt Ltd|x|3|k|20210402|S\nMH-00-0267086|Harmony Electronics|b|7|g|20250703|M\nKL-00-7876687|Neelgiri Packaging LLP|l|5|9|20211129|S\nRJ-00-8211157|Classic Bakers|3|9|8|20221110|M\nTN-00-8799102|Silver Oak Hardware|f|a|4|20210820|M\nDL-00-7084760|Metro Diagnostics Pvt Ltd|a|2|5|20210811|M\nMP-00-4217909|Apex Design Studio Pvt Ltd|1|6|7|20220401|S\nRJ-00-0886046|Ganga Design Studio LLP|1|9|8|20230424|M\nUP-00-6140571|Galaxy Unisex Salon|u|c|b|20231013|S\nKR-00-0018133|Shree General Store|h|4|e|20221001|M\nTS-00-0613575|Amrit Realty LLP|s|b|6|20240627|S\nKR-00-4468149|Neelgiri Physio Clinic LLP|o|4|1|20210703|M\nKR-00-1489448|Prime General Store|h|4|1|20210211|M\nKR-00-2364721|City Tours & Travels|y|4|e|20230810|M\nBR-00-6198568|Evergreen Diagnostics|a|1|h|20250117|M\nMP-00-7185731|Green Leaf Hardware|f|6|7|20251120|S\nMH-00-5170539|Annapurna Legal Associates|i|7|i|20240218|D\nMH-00-6592181|Sai Boutique|5|7|f|20201128|S\nAP-00-1660257|Green Leaf Foods Pvt Ltd|c|0|l|20221106|S\nGJ-00-3827898|Galaxy Realty LLP|s|3|j|20220518|S\nKR-00-6803514|Moonlight Physio Clinic Pvt Ltd|o|4|e|20220927|M\nMH-00-1862743|Metro & Associates|7|7|g|20210802|M\nRJ-00-6577157|Saffron Unisex Salon|u|9|8|20251230|M\nTS-00-5027218|Moonlight Stationers|v|b|6|20211115|D\nGJ-00-6456760|Moonlight Kitchens Pvt Ltd|t|3|k|20240510|M\nTS-00-6023213|Om Bakers|3|b|6|20230827|S\nWB-00-5804066|Prime Medicals|m|d|a|20220406|M\nMH-00-7614265|Classic Packaging|l|7|d|20201126|S\nGJ-00-9981067|Saffron Boutique|5|3|k|20231216|M\nGJ-00-6379229|Annapurna Stays|6|3|j|20241116|M\nKR-00-8156839|Balaji Mobile Care|j|4|1|20240331|M\nMH-00-0185829|Navkar Sweets|w|7|d|20260123|M\nKR-00-6286611|Evergreen Opticals|k|4|1|20240618|M\nKL-00-7854190|Unity Realty|s|5|9|20250928|M\nMH-00-9106125|Navkar Kitchens|t|7|d|20201021|M\nKR-00-8505406|Pearl Stationers|v|4|e|20241215|S\nGJ-00-3272050|Shree Bakers|3|3|k|20210311|M\nMP-00-6644848|Krishna Stationers|v|6|2|20240719|S\nGJ-00-7249811|New Hardware|f|3|k|20240509|M\nDL-00-6937429|Neelgiri Pharma Retail Pvt Ltd|n|2|5|20231223|M\nMH-00-1630583|Unity Tours & Travels Pvt Ltd|y|7|d|20220405|M\nMH-00-8542981|Evergreen Realty LLP|s|7|f|20211106|M\nKL-00-8435408|Blue Lotus Pharma Retail|n|5|9|20221009|S\nBR-00-0028703|Sahyadri General Store|h|1|h|20251128|M\nMP-00-0396089|New Physio Clinic Pvt Ltd|o|6|2|20240111|M\nRJ-00-0542905|Annapurna Diagnostics|a|9|8|20231222|M\nMH-00-0242770|Neelgiri Opticals|k|7|f|20250226|M\nTS-00-7335530|Annapurna Bakers|3|b|6|20250914|M\nAP-00-0335828|Prime Medicals|m|0|l|20230322|M\nTN-00-9354553|Pearl Kitchens Pvt Ltd|t|a|4|20240711|M\nTS-00-3207045|Modern Mobile Care|j|b|6|20240222|M\nWB-00-2867489|Om Kids Academy LLP|q|d|a|20210731|M\nGJ-00-6425678|New General Store|h|3|0|20250417|M\nMH-00-0262257|Silver Oak Boutique|5|7|i|20220601|M\nDL-00-6611391|Royal Mobile Care|j|2|5|20211117|M\nKR-00-7506444|Blue Lotus Design Studio LLP|1|4|1|20220706|D\nPB-00-1171639|Riddhi Hardware|f|8|c|20240731|M\nMH-00-2413434|Om Kids Academy|q|7|d|20240614|M\nMH-00-1169337|Classic Realty Pvt Ltd|s|7|i|20241024|M\nTS-00-8676190|Green Leaf Dental Care|9|b|6|20221223|S\nKR-00-7574391|Sunrise Packaging|l|4|e|20210407|S\nKR-00-3517124|Ganesh Foods Pvt Ltd|c|4|e|20230907|S\nMH-00-8730045|Pearl General Store|h|7|i|20250414|S\nKR-00-8780776|Annapurna Opticals|k|4|1|20220520|S\nDL-00-4112846|Saffron Kitchens Pvt Ltd|t|2|5|20251012|M\nGJ-00-0067319|Neelgiri Physio Clinic|o|3|0|20251015|S\nBR-00-0192894|Evergreen Insurance Advisors|g|1|h|20250717|M\nTN-00-5282807|Silver Oak Diagnostics|a|a|4|20250706|M\nUP-00-8364989|Vindhya Boutique|5|c|b|20210909|S\nMH-00-5757930|Galaxy Pharma Retail Pvt Ltd|n|7|f|20251129|S\nTN-00-0601568|Orbit Hardware|f|a|3|20230712|M\nMH-00-6397693|Ganesh Opticals|k|7|d|20241009|M\nMP-00-3357518|Saffron Sweets|w|6|2|20240528|M\nMP-00-4298255|Classic Stationers|v|6|2|20201015|S\nBR-00-1190638|City Packaging LLP|l|1|h|20220130|S\nMP-00-5875460|Blue Lotus Polymers LLP|p|6|7|20210322|M\nTN-00-1581041|New Fitness Pvt Ltd|e|a|3|20241208|S\nKL-00-2289100|Harmony Opticals|k|5|9|20201020|M\nKR-00-6058993|Evergreen Hardware|f|4|e|20211120|S\nKL-00-6562667|Apex Legal Associates Pvt Ltd|i|5|9|20230213|M\nTS-00-6032381|Harmony Packaging Pvt Ltd|l|b|6|20210601|M\nDL-00-3378772|Kaveri Mobile Care|j|2|5|20220513|M\nMH-00-1654294|Ganga Sweets|w|7|d|20220726|M\nMP-00-6804662|Vindhya Stationers|v|6|2|20230525|M\nKL-00-0561983|Classic Insurance Advisors Pvt Ltd|g|5|9|20210105|S\nTN-00-6325026|Classic & Associates|7|a|4|20210210|M\nMP-00-0107675|Krishna Hardware|f|6|2|20210125|S\nTS-00-1167779|Classic Fitness|e|b|6|20220221|M\nTN-00-0200261|Green Leaf Diagnostics LLP|a|a|4|20250819|M\nRJ-00-2396103|Classic Unisex Salon|u|9|8|20250413|M\nMH-00-2836791|Star Hardware|f|7|g|20220629|M\nBR-00-6550007|Metro Dental Care LLP|9|1|h|20241006|M\nPB-00-8770335|Blue Lotus Dental Care LLP|9|8|c|20211116|M\nPB-00-6724774|Balaji Realty Pvt Ltd|s|8|c|20201201|S\nWB-00-4959874|Coral & Associates Pvt Ltd|7|d|a|20220501|S\nWB-00-2910901|Star Classes LLP|8|d|a|20230829|M\nTN-00-2350210|Balaji Mobile Care|j|a|3|20230220|D\nWB-00-0282684|Navkar Legal Associates Pvt Ltd|i|d|a|20201128|M\nMH-00-7062533|Lakshmi Sweets|w|7|d|20240106|M\nTN-00-5157491|Modern Design Studio Pvt Ltd|1|a|4|20230801|M\nMP-00-3303159|Trinity Legal Associates|i|6|7|20210831|M\nTS-00-0823342|Neelgiri & Associates Pvt Ltd|7|b|6|20250530|M\nWB-00-9689226|Trinity Opticals|k|d|a|20201223|M\nTS-00-2351791|Star Boutique|5|b|6|20241126|S\nMH-00-3193263|Trinity Kitchens|t|7|d|20210409|S\nGJ-00-8741728|Shree Electronics|b|3|j|20230911|M\nMH-00-8313972|Balaji Boutique|5|7|d|20210807|S\nWB-00-5880675|Kaveri Kitchens|t|d|a|20230410|M\nMH-00-5040198|Orbit Diagnostics LLP|a|7|f|20230722|S\nTS-00-9933398|Riddhi Electronics|b|b|6|20250519|M\nMH-00-2232141|Zenith Kitchens|t|7|i|20240510|M\nMH-00-5098440|Krishna Bakers|3|7|f|20260130|M\nMH-00-6085155|Sunrise Textiles|x|7|i|20210915|S\nRJ-00-2957211|Krishna Sweets|w|9|8|20240101|M\nKR-00-3232909|Pearl Boutique|5|4|1|20230120|S\nKL-00-3373728|Apex Legal Associates|i|5|9|20220521|S\nWB-00-9782771|Trinity Textiles LLP|x|d|a|20230529|M\nDL-00-1354843|Prime Hardware|f|2|5|20220323|M\nRJ-00-5933420|Zenith Sweets|w|9|8|20231001|M\nMH-00-2542909|Sai Medicals|m|7|i|20230825|S\nTS-00-9962301|Silver Oak Unisex Salon|u|b|6|20250805|M\nGJ-00-8446423|Krishna Fashions LLP|0|3|0|20260125|M\nUP-00-6732195|Orbit Medicals|m|c|b|20220318|M\nTN-00-3193265|Shree Hardware|f|a|3|20241129|M\nUP-00-9247875|Galaxy Stationers|v|c|b|20210215|S\nKR-00-6929238|Royal Stationers|v|4|e|20230326|M\nTN-00-7867469|Coral Realty Pvt Ltd|s|a|4|20210502|S\nMH-00-6533499|Coral Fashions Pvt Ltd|0|7|i|20250207|M\nTS-00-0423913|Sai Kitchens Pvt Ltd|t|b|6|20240710|M\nKR-00-5911520|Sai Stationers|v|4|1|20230113|M\nMH-00-2709551|Sunrise Classes LLP|8|7|d|20211119|M\nMH-00-0829954|Evergreen Bakers|3|7|d|20201224|S\nWB-00-6682217|Ganga Diagnostics Pvt Ltd|a|d|a|20250806|M\nMH-00-2628368|Pearl Stationers|v|7|i|20251117|M\nKR-00-9410946|Unity Kids Academy LLP|q|4|1|20220824|M\nMH-00-5633368|New Stays|6|7|i|20210807|M\nTN-00-8864773|Ganga Mobile Care|j|a|4|20220212|S\nMH-00-3923912|Saffron Fashions Pvt Ltd|0|7|d|20220704|M\nMH-00-5837675|Krishna Kitchens LLP|t|7|f|20240128|M\nGJ-00-3438644|Royal Kitchens LLP|t|3|j|20220109|M\nMH-00-9262014|Vindhya Design Studio LLP|1|7|i|20250312|M\nKR-00-0009229|Ganesh Stays|6|4|e|20220523|M\nTN-00-0199662|Apex Bake House|4|a|3|20211013|S\nDL-00-8741548|Neelgiri Hardware|f|2|5|20201209|M\nDL-00-5182415|Saffron Diagnostics|a|2|5|20210909|M\nRJ-00-8787362|Galaxy & Associates Pvt Ltd|7|9|8|20230715|M\nMH-00-2263321|Shree Physio Clinic Pvt Ltd|o|7|i|20220802|M\nBR-00-4288521|Unity General Store|h|1|h|20220108|M\nWB-00-2190088|Krishna Medicals|m|d|a|20250301|M\nMH-00-9008133|Orbit Physio Clinic|o|7|d|20230505|M\nTN-00-9264868|Trinity Opticals|k|a|3|20211014|M\nWB-00-2804550|Amrit Design Studio Pvt Ltd|1|d|a|20230119|S\nGJ-00-9612737|New Mobile Care|j|3|j|20210428|M\nTN-00-8759407|Silver Oak Electronics|b|a|4|20241226|M\nKL-00-6770055|Annapurna Auto Components|2|5|9|20210302|S\nAP-00-1784752|Royal Bake House|4|0|l|20240612|M\nGJ-00-0076645|Star Mobile Care|j|3|k|20210206|M\nTN-00-2474690|Prime Hardware|f|a|3|20211103|S\nUP-00-9993618|Green Leaf Foods|c|c|b|20201210|S\nKR-00-0228454|Sahyadri Dental Care|9|4|1|20231108|M\nUP-00-7096090|Sahyadri Hardware|f|c|b|20220614|D\nKL-00-4147569|Star Bake House Pvt Ltd|4|5|9|20210120|M\nUP-00-3718469|Neelgiri Diagnostics|a|c|b|20230918|M\nMP-00-0911193|Sai Unisex Salon|u|6|2|20241110|M\nKL-00-7978145|Om Insurance Advisors|g|5|9|20260104|M\nMH-00-0126240|Silver Oak Unisex Salon|u|7|f|20210905|S\nMP-00-1393026|Royal Opticals|k|6|7|20230804|S\nBR-00-4476948|Trinity Stays LLP|6|1|h|20250804|M\nMP-00-4259645|Metro Realty|s|6|2|20201018|M\nKR-00-5699655|Navkar Opticals|k|4|1|20221220|M\nGJ-00-5010658|Lakshmi Electronics|b|3|j|20220219|S\nTN-00-8924648|Orbit Textiles Pvt Ltd|x|a|4|20221010|S\nMH-00-3220954|Annapurna Hardware|f|7|i|20250830|M\nGJ-00-5200601|Om Medicals|m|3|0|20240720|M\nPB-00-0075326|Apex Printers LLP|r|8|c|20211124|M\nUP-00-4017882|Royal Dental Care LLP|9|c|b|20201231|M\nPB-00-3914434|Kaveri Physio Clinic LLP|o|8|c|20210301|S\nGJ-00-4538846|Pearl Hardware|f|3|0|20240403|M\nMH-00-4095103|Riddhi Electronics|b|7|g|20251104|M\nTS-00-3102777|Trinity Realty|s|b|6|20230330|M\nTN-00-6713028|Neelgiri Opticals|k|a|4|20240207|M\nTN-00-6011348|Zenith Mobile Care|j|a|3|20250126|S\nMH-00-2675962|Vindhya Tours & Travels LLP|y|7|d|20210325|S\nAP-00-6143658|Blue Lotus General Store|h|0|l|20210516|S\nMP-00-6335307|Harmony Design Studio LLP|1|6|2|20241111|S\nMP-00-0345567|Annapurna Stationers|v|6|2|20240417|M\nKR-00-9176613|Krishna General Store|h|4|1|20220315|S\nMH-00-7068915|Modern Hardware|f|7|f|20240919|M\nGJ-00-5000682|Orbit Physio Clinic Pvt Ltd|o|3|k|20250208|M\nKR-00-9951477|Vindhya Bake House|4|4|1|20210923|M\nDL-00-7047763|Lakshmi Fashions|0|2|5|20241215|M\nWB-00-9582356|Sai Unisex Salon|u|d|a|20211009|M\nDL-00-7338259|New Medicals|m|2|5|20231008|S\nKR-00-2201408|Saffron Hardware|f|4|1|20210624|S\nMH-00-4105453|Green Leaf Sweets|w|7|d|20230410|M\nDL-00-6075292|New Electronics LLP|b|2|5|20250804|M\nKR-00-4581693|Coral General Store|h|4|1|20220419|M\nTN-00-4796660|New Fashions LLP|0|a|3|20230501|S\nMP-00-1597869|Ganga Design Studio|1|6|2|20240624|S\nGJ-00-6760776|Kaveri Stays Pvt Ltd|6|3|0|20220424|M\nGJ-00-9696889|Orbit Mobile Care|j|3|0|20211129|M\nMH-00-2980779|Green Leaf Realty LLP|s|7|f|20250509|S\nGJ-00-6987989|Sahyadri Textiles Pvt Ltd|x|3|j|20250730|M\nGJ-00-5495717|Sahyadri Diagnostics|a|3|0|20210601|M\nMH-00-1647063|Star Design Studio|1|7|g|20240618|M\nMH-00-9083707|Galaxy Diagnostics|a|7|g|20201202|M\nKL-00-4592369|Shree Tours & Travels|y|5|9|20250112|M\nTN-00-8226383|Modern Stationers|v|a|3|20230906|D\nTN-00-1266976|Sahyadri Dental Care Pvt Ltd|9|a|3|20210612|S\nGJ-00-1002432|Balaji Classes Pvt Ltd|8|3|0|20220504|M\nDL-00-2847470|Star Tours & Travels Pvt Ltd|y|2|5|20260115|S\nKR-00-7103556|Amrit Tours & Travels|y|4|1|20211125|M\nGJ-00-5710028|Navkar Hardware|f|3|j|20230129|M\nMP-00-9663549|Moonlight Medicals|m|6|2|20230417|M\nGJ-00-6528194|Om Stays Pvt Ltd|6|3|0|20221019|D\nMP-00-4621225|Saffron Hardware|f|6|7|20230803|S\nMH-00-3073844|Balaji Unisex Salon|u|7|i|20210614|M\nMP-00-2067043|Trinity Woodcraft LLP|d|6|7|20210812|M\nGJ-00-0066480|Lakshmi Opticals|k|3|k|20240726|M\nDL-00-7554899|Zenith Legal Associates LLP|i|2|5|20230609|M\nTN-00-5760327|Prime Mobile Care|j|a|3|20210510|M\nKR-00-1669884|Prime Textiles Pvt Ltd|x|4|1|20231216|S\nMP-00-8475009|City Bakers|3|6|7|20210614|M\nKL-00-9775953|Om Stationers|v|5|9|20210803|M\nTN-00-7299169|Classic Unisex Salon|u|a|4|20240508|M\nRJ-00-9544669|Silver Oak Mobile Care|j|9|8|20250910|S\nGJ-00-8994375|Amrit Boutique|5|3|0|20211214|M\nKR-00-2515069|Blue Lotus Fashions Pvt Ltd|0|4|1|20230107|M\nBR-00-9522983|Star Opticals|k|1|h|20240204|M\nAP-00-6413107|Evergreen Legal Associates|i|0|l|20220624|M\nDL-00-9778599|Royal Kids Academy LLP|q|2|5|20210307|M\nKR-00-0963602|Galaxy Diagnostics|a|4|1|20240903|S\nMH-00-6343119|Metro Sweets|w|7|d|20230726|S\nMP-00-0219720|Lakshmi Insurance Advisors|g|6|7|20230919|S\nTN-00-2972577|Vindhya Opticals|k|a|4|20221207|M\nTN-00-4593508|Riddhi Stays LLP|6|a|4|20210124|M\nDL-00-7314579|Riddhi Sweets|w|2|5|20240701|M\nKR-00-0912555|Moonlight Bakers|3|4|e|20230910|M\nBR-00-7880010|Green Leaf Legal Associates|i|1|h|20210706|S\nMH-00-4087807|Vindhya Electronics|b|7|d|20220820|S\nMH-00-0852183|Royal Tours & Travels Pvt Ltd|y|7|d|20250125|M\nTN-00-5678855|Kaveri Realty|s|a|4|20230626|M\nKR-00-1493630|Harmony Opticals|k|4|1|20230503|M\nTN-00-5506288|Harmony Design Studio|1|a|3|20250509|M\nBR-00-4581397|Modern Electronics|b|1|h|20250827|S\nKR-00-1204185|Royal Kids Academy|q|4|e|20231012|M\nGJ-00-2447413|Riddhi Bakers|3|3|j|20250409|M\nKR-00-0171357|Neelgiri Printers|r|4|1|20230920|S\nWB-00-1397903|Moonlight Physio Clinic|o|d|a|20210212|M\nWB-00-3802599|Unity Boutique|5|d|a|20251110|S\nMH-00-6397638|New Bake House|4|7|f|20201212|M\nMH-00-6185752|Moonlight Kids Academy LLP|q|7|g|20220810|M\nMH-00-1083535|Vindhya Sweets|w|7|i|20250315|M\nKR-00-4486095|Sunrise Hardware|f|4|1|20240521|M\nWB-00-0892379|Neelgiri Bakers|3|d|a|20220509|S\nKR-00-0089343|Lakshmi Pharma Retail Pvt Ltd|n|4|1|20250622|M\nMH-00-4705903|Royal Auto Components Pvt Ltd|2|7|i|20250914|S\nUP-00-7769172|Kaveri Fashions Pvt Ltd|0|c|b|20240711|M\nKR-00-5343973|Harmony Kids Academy|q|4|e|20240304|M\nRJ-00-5778079|Prime Realty LLP|s|9|8|20221230|M\nMH-00-3261912|Coral Bakers|3|7|i|20211203|S\nDL-00-0250462|Riddhi Stays|6|2|5|20210905|S\nKR-00-6539848|Green Leaf Pharma Retail Pvt Ltd|n|4|e|20240428|M\nMH-00-2813886|Sahyadri Tours & Travels Pvt Ltd|y|7|f|20221020|M\nMP-00-2523794|Star Tours & Travels|y|6|7|20241031|M\nKR-00-9895877|Krishna & Associates Pvt Ltd|7|4|1|20210320|S\nMH-00-4456280|Harmony Stays Pvt Ltd|6|7|d|20221223|M\nGJ-00-1261615|Lakshmi Stationers|v|3|k|20220221|M\nKR-00-3448282|Ganesh Fitness|e|4|e|20220518|S\nKR-00-6153376|Silver Oak Boutique|5|4|1|20220809|S\nMH-00-5286597|Zenith Stays LLP|6|7|f|20240712|S\nMH-00-5223112|Saffron Opticals|k|7|g|20230326|M\nPB-00-5544556|Classic & Associates|7|8|c|20250415|M\nDL-00-4035844|Ganga Physio Clinic|o|2|5|20221214|M\nKR-00-4345072|Metro & Associates Pvt Ltd|7|4|1|20241113|M\nTS-00-3610101|Prime & Associates|7|b|6|20230825|M\nDL-00-2736219|Neelgiri Stays LLP|6|2|5|20241019|M\nPB-00-5195393|Metro Kitchens LLP|t|8|c|20240717|M\nDL-00-3823957|Coral Tours & Travels Pvt Ltd|y|2|5|20210711|M\nKR-00-7837915|Krishna Bake House|4|4|1|20250728|M\nKR-00-2706041|Green Leaf Sweets|w|4|1|20230503|M\nUP-00-8180162|Zenith Mobile Care|j|c|b|20210220|M\nWB-00-1008278|Balaji Bakers|3|d|a|20231201|M\nTN-00-6451809|Ganesh Fashions|0|a|3|20210423|M\nMH-00-6341634|Ganesh Design Studio LLP|1|7|d|20210914|M\nMH-00-1564065|Silver Oak Printers LLP|r|7|d|20241010|M\nAP-00-1767734|Annapurna Design Studio|1|0|l|20210912|M\nTN-00-3667440|Coral Packaging|l|a|3|20220123|S\nMH-00-9811285|Lakshmi Fitness|e|7|i|20250620|M\nMH-00-4489202|Classic Sweets|w|7|i|20230710|S\nTN-00-7721484|Green Leaf Boutique|5|a|3|20220901|M\nTS-00-1984921|Sai Realty LLP|s|b|6|20220530|M\nKL-00-2865439|Prime Tours & Travels|y|5|9|20230201|M\nTN-00-8053889|Amrit Boutique|5|a|3|20210209|S\nKR-00-7913246|Unity Foods Pvt Ltd|c|4|1|20231115|S\nMH-00-6761165|Sahyadri Mobile Care|j|7|d|20210403|M\nTN-00-2894518|Classic Pharma Retail|n|a|3|20250915|D\nKL-00-9129736|Sai Mobile Care|j|5|9|20220705|S\nMP-00-8273532|Star Realty|s|6|7|20251125|M\nMH-00-9781430|Sunrise Unisex Salon|u|7|g|20211209|S\nMH-00-7689628|Sai Kitchens|t|7|i|20240401|M\nTN-00-8854829|City Realty|s|a|3|20221117|M\nAP-00-6515019|Balaji Legal Associates|i|0|l|20251029|M\nGJ-00-9975008|Star Stays|6|3|j|20240623|M\nGJ-00-5032090|Saffron Medicals|m|3|j|20230128|M\nKL-00-9144506|Green Leaf Kids Academy|q|5|9|20211001|M\nMP-00-7082162|Sahyadri General Store|h|6|7|20230108|M\nPB-00-2196030|Galaxy Pharma Retail LLP|n|8|c|20240823|S\nTN-00-2315605|Ganga Woodcraft|d|a|3|20220218|S\nMH-00-2586162|Orbit Hardware|f|7|d|20240421|M\nTN-00-6569608|Evergreen Diagnostics|a|a|3|20211225|S\nMH-00-0416140|Royal Sweets|w|7|d|20220714|M\nTN-00-3219916|Riddhi Pharma Retail Pvt Ltd|n|a|3|20211231|M\nMP-00-6444939|Amrit Design Studio|1|6|2|20251125|M\nDL-00-6548768|New Pharma Retail|n|2|5|20211204|M\nUP-00-7422553|Neelgiri Electronics|b|c|b|20241212|M\nPB-00-1326519|Royal Pharma Retail|n|8|c|20230122|M\nMP-00-2756405|Unity Fashions Pvt Ltd|0|6|7|20201206|M\nAP-00-8925574|Moonlight Textiles Pvt Ltd|x|0|l|20220827|M\nAP-00-9394527|Galaxy Realty|s|0|l|20240324|M\nDL-00-1425512|Silver Oak Electronics|b|2|5|20210407|S\nTN-00-5393999|Royal Unisex Salon|u|a|3|20220610|M\nMH-00-0750125|Om General Store|h|7|i|20230112|M\nMP-00-1404770|Blue Lotus Design Studio|1|6|7|20241205|M\nRJ-00-1642723|Balaji Fashions|0|9|8|20250531|S\nMH-00-5838211|Vindhya Bake House Pvt Ltd|4|7|d|20211010|D\nPB-00-1975243|Balaji Kitchens|t|8|c|20210117|M\nMH-00-1025947|Classic Kids Academy|q|7|d|20220111|M\nGJ-00-5962696|Ganesh Textiles|x|3|j|20210124|M\nMH-00-7917381|Shree Hardware|f|7|i|20240114|S\nBR-00-1279389|Coral Foods|c|1|h|20240926|D\nMP-00-1689044|Unity Kids Academy|q|6|2|20240521|M\nBR-00-8642527|Green Leaf Printers Pvt Ltd|r|1|h|20251225|S\nMH-00-3572884|Unity Design Studio Pvt Ltd|1|7|i|20240401|M\nMH-00-0758680|Vindhya Fitness LLP|e|7|i|20201015|D\nGJ-00-4458858|Orbit Kids Academy|q|3|0|20211109|M\nRJ-00-4527633|Moonlight Legal Associates Pvt Ltd|i|9|8|20220511|M\nGJ-00-4992105|Modern Bakers|3|3|k|20240629|D\nTS-00-2856055|Pearl Unisex Salon|u|b|6|20220514|M\nMH-00-9348381|Om Classes Pvt Ltd|8|7|d|20250228|M\nMH-00-6166763|Blue Lotus Stays LLP|6|7|d|20230604|M\nTN-00-4660826|Trinity Mobile Care|j|a|3|20230106|S\nTS-00-7868208|Silver Oak Polymers|p|b|6|20221018|M\nTN-00-5396104|Saffron Insurance Advisors|g|a|4|20211019|S\nDL-00-3326036|Galaxy Diagnostics|a|2|5|20210728|M\nKR-00-4826861|Sahyadri Auto Components|2|4|1|20220421|S\nMH-00-8255558|Zenith Fashions|0|7|i|20260102|S\nKR-00-5327083|Lakshmi Diagnostics|a|4|1|20251031|M\nMP-00-1207410|Balaji Fitness|e|6|7|20231027|M\nMH-00-7700400|Royal Diagnostics|a|7|d|20230122|M\nMP-00-4937256|Orbit Woodcraft Pvt Ltd|d|6|2|20250915|S\nGJ-00-4401351|Kaveri Mobile Care|j|3|k|20230519|M\nBR-00-4601414|Metro Medicals|m|1|h|20231030|M\nTN-00-0656998|Silver Oak Medicals|m|a|4|20220816|M\nTS-00-1490610|Star Sweets|w|b|6|20221208|M\nGJ-00-3202263|Sunrise Classes Pvt Ltd|8|3|0|20250415|M\nTS-00-6535315|Balaji Mobile Care|j|b|6|20220812|M\nGJ-00-9516577|Prime Sweets|w|3|k|20210407|M\nGJ-00-9626799|Ganga Boutique|5|3|j|20221030|S\nTN-00-3681844|Moonlight Boutique|5|a|3|20251214|M\nMP-00-0979194|Saffron Mobile Care|j|6|7|20240810|M\nMH-00-7595806|Kaveri Kids Academy|q|7|d|20240921|M\nGJ-00-7505424|City General Store|h|3|0|20230114|M\nGJ-00-6095435|Amrit Unisex Salon|u|3|k|20220719|M\nMH-00-5739389|Ganga Realty|s|7|f|20230307|S\nMH-00-3347860|Galaxy Sweets|w|7|g|20210801|M\nMH-00-7227755|City Legal Associates Pvt Ltd|i|7|g|20250225|M\nTN-00-6775128|Prime Boutique|5|a|3|20240722|M\nMH-00-4866341|Vindhya Sweets|w|7|g|20210722|M\nPB-00-2307042|Unity Mobile Care|j|8|c|20220206|M\nMH-00-3803898|Green Leaf Pharma Retail|n|7|f|20250422|S\nMH-00-8951269|Balaji Unisex Salon|u|7|d|20231013|M\nMH-00-4280958|Green Leaf Opticals|k|7|f|20220422|M\nRJ-00-8716682|Green Leaf General Store|h|9|8|20220326|M\nMH-00-5422113|Metro Unisex Salon|u|7|f|20221007|M\nMH-00-3162960|Prime Fitness|e|7|i|20220314|M\nWB-00-5472884|Orbit Auto Components LLP|2|d|a|20210813|S\nRJ-00-1293461|Silver Oak Realty|s|9|8|20210824|M\nKR-00-7721609|Annapurna & Associates|7|4|1|20240808|S\nMH-00-4486269|Silver Oak Boutique|5|7|d|20220315|M\nMH-00-2207636|Ganesh Bakers|3|7|d|20210526|M\nPB-00-1686030|New Tours & Travels|y|8|c|20210930|M\nKR-00-7015176|Annapurna Woodcraft Pvt Ltd|d|4|1|20231124|S\nPB-00-8143596|Green Leaf Tours & Travels Pvt Ltd|y|8|c|20241115|M\nMH-00-0197420|Unity Printers|r|7|i|20210101|S\nMH-00-7051764|Navkar Fashions|0|7|i|20230620|M\nKR-00-1716661|Modern Tours & Travels LLP|y|4|1|20230723|M\nMH-00-9479126|Krishna Unisex Salon|u|7|i|20220120|M\nDL-00-7487988|Sai Mobile Care|j|2|5|20220810|M\nPB-00-2883083|Unity Legal Associates|i|8|c|20250605|M\nTN-00-0087168|Harmony Tours & Travels LLP|y|a|3|20221113|S\nPB-00-4021943|Galaxy Unisex Salon|u|8|c|20211030|M\nDL-00-7949731|Amrit & Associates Pvt Ltd|7|2|5|20250222|M\nDL-00-0779845|Green Leaf General Store|h|2|5|20230506|M\nMH-00-5401124|Evergreen Boutique|5|7|d|20210917|M\nKR-00-2227518|Ganga Legal Associates|i|4|1|20251024|S\nKR-00-6589359|Royal Legal Associates|i|4|1|20250501|S\nGJ-00-0409221|Coral Realty Pvt Ltd|s|3|0|20201110|M\nUP-00-1181377|Blue Lotus Auto Components|2|c|b|20201008|S\nKR-00-7019081|Navkar Classes|8|4|1|20210125|M\nPB-00-8241658|Harmony Tours & Travels|y|8|c|20220802|M\nBR-00-0803688|Moonlight Fashions LLP|0|1|h|20230924|M\nDL-00-5383496|Star Sweets|w|2|5|20250915|M\nBR-00-1853402|Om Bake House|4|1|h|20250321|M\nTN-00-5467458|Ganga Tours & Travels Pvt Ltd|y|a|3|20210902|D\nKR-00-5565425|Neelgiri Design Studio Pvt Ltd|1|4|e|20240611|M\nMH-00-7335822|Vindhya Dental Care LLP|9|7|i|20250210|S\nMH-00-8698632|Sahyadri Classes|8|7|d|20241009|M\nMH-00-6371771|Vindhya Stationers|v|7|d|20210729|S\nTS-00-2423986|Vindhya General Store|h|b|6|20220312|M\nUP-00-4886738|Pearl Stationers|v|c|b|20201217|M\nMH-00-5776062|Coral Bake House Pvt Ltd|4|7|d|20230508|D\nTN-00-8871367|Modern Stays LLP|6|a|3|20240626|S\nMP-00-5636737|Sahyadri Dental Care|9|6|7|20201127|M\nMP-00-3923287|City Kitchens LLP|t|6|2|20241004|S\nAP-00-0345942|Modern Medicals|m|0|l|20210311|M\nTS-00-4454731|Galaxy Kids Academy|q|b|6|20230415|M\nMH-00-5094195|Annapurna Tours & Travels|y|7|f|20230816|M\nKR-00-2043370|Pearl Classes|8|4|1|20240815|M\nMH-00-7547056|Neelgiri Bake House Pvt Ltd|4|7|i|20201214|M\nTS-00-6110776|Unity Classes|8|b|6|20221023|M\nGJ-00-3278913|Metro Sweets|w|3|k|20241019|S\nMH-00-1861078|Amrit Bakers|3|7|d|20240412|M\nKR-00-6166625|Riddhi Classes|8|4|e|20260120|M\nPB-00-7133832|Pearl Physio Clinic LLP|o|8|c|20240115|M\nTN-00-9492262|Zenith Unisex Salon|u|a|4|20201019|S\nDL-00-6924258|Sahyadri Opticals|k|2|5|20220808|M\nKR-00-5314952|Amrit Legal Associates|i|4|1|20240723|S\nGJ-00-0094623|Moonlight Kitchens LLP|t|3|j|20240207|S\nWB-00-0852067|Ganesh Medicals|m|d|a|20250706|M\nMP-00-6919901|Prime Physio Clinic LLP|o|6|7|20240926|M\nTN-00-3690019|Zenith Sweets|w|a|4|20220115|S\nMH-00-4328506|Silver Oak & Associates Pvt Ltd|7|7|i|20240110|M\nMH-00-8857590|Star Bakers|3|7|g|20250728|D\nMP-00-5332492|Lakshmi Opticals|k|6|7|20250216|M\nKL-00-0107438|Sunrise Stationers|v|5|9|20220601|M\nPB-00-3416847|Ganesh Opticals|k|8|c|20220916|M\nTS-00-1725382|Moonlight Hardware|f|b|6|20201106|M\nMH-00-0426512|Green Leaf General Store|h|7|g|20221223|S\nMH-00-4358593|Evergreen Stationers|v|7|g|20220602|M\nMH-00-5907522|Metro Boutique|5|7|d|20201226|M\nTS-00-5158288|Annapurna Medicals|m|b|6|20230104|M\nPB-00-1676128|Neelgiri Dental Care LLP|9|8|c|20221005|M\nKL-00-9439686|Moonlight Pharma Retail|n|5|9|20240122|M\nGJ-00-7011755|Sunrise Unisex Salon|u|3|k|20201009|M\nRJ-00-4178948|Ganesh Bakers|3|9|8|20240806|M\nTN-00-4213977|City Fitness|e|a|4|20230930|M\nMP-00-7062248|Balaji Dental Care LLP|9|6|2|20240705|S\nPB-00-7601469|Saffron Woodcraft LLP|d|8|c|20241026|D\nKR-00-0693440|Star Medicals|m|4|1|20220404|M\nMP-00-9621484|Star Electronics|b|6|2|20230131|M\nKR-00-1621252|Neelgiri Hardware|f|4|1|20250219|M\nMH-00-8542355|Coral Woodcraft|d|7|d|20220509|S\nKR-00-5046558|City Physio Clinic LLP|o|4|1|20250203|S\nKR-00-3123669|Star Physio Clinic LLP|o|4|1|20240330|M\nGJ-00-2617659|Modern Tours & Travels|y|3|0|20210217|M\nMP-00-3139433|Prime Polymers Pvt Ltd|p|6|7|20250518|D\nMP-00-2319581|Sai Insurance Advisors LLP|g|6|7|20201229|M\nRJ-00-5384614|Annapurna Tours & Travels LLP|y|9|8|20230331|M\nKR-00-9084551|Harmony Electronics|b|4|1|20211119|M\nMP-00-5537234|Modern Dental Care|9|6|7|20221116|M\nDL-00-8167028|Classic Physio Clinic Pvt Ltd|o|2|5|20220629|S\nRJ-00-8932037|Zenith Opticals|k|9|8|20251027|M\nGJ-00-7042122|Neelgiri Bakers|3|3|k|20250811|M\nGJ-00-1142272|Unity Bake House|4|3|0|20210507|D\nMP-00-4164171|Lakshmi Legal Associates LLP|i|6|7|20231209|M\nMP-00-2166016|Royal Stays Pvt Ltd|6|6|7|20220412|M\nMH-00-0490540|Navkar Pharma Retail|n|7|g|20220603|M\nUP-00-8860880|Metro Packaging|l|c|b|20220605|M\nKR-00-0993806|Riddhi Insurance Advisors|g|4|1|20220221|M\nGJ-00-3591244|Riddhi Fashions LLP|0|3|k|20221027|M\nMH-00-3670841|Kaveri Stationers|v|7|d|20210807|M\nPB-00-5746493|Modern Classes|8|8|c|20250903|M\nKL-00-6380367|Neelgiri Hardware|f|5|9|20211206|M\nKR-00-1382819|Silver Oak Hardware|f|4|1|20230512|M\nPB-00-9182956|Galaxy Design Studio Pvt Ltd|1|8|c|20220417|S\nKR-00-8175415|Apex Mobile Care|j|4|e|20210429|M\nTN-00-3654425|Lakshmi Kids Academy LLP|q|a|4|20240330|S\nGJ-00-7210557|Kaveri Legal Associates|i|3|j|20230310|M\nUP-00-4783772|Pearl Bake House Pvt Ltd|4|c|b|20210317|M\nDL-00-4977784|Om Boutique|5|2|5|20241025|D\nUP-00-5378724|Saffron Fashions Pvt Ltd|0|c|b|20221025|M\nUP-00-2772717|Sahyadri Bakers|3|c|b|20220621|M\nKR-00-6887885|Apex Kids Academy Pvt Ltd|q|4|e|20250125|M\nMH-00-3232929|Vindhya Realty|s|7|f|20220702|S\nMH-00-2076603|Classic & Associates LLP|7|7|d|20210330|M\nGJ-00-6746435|Star Electronics Pvt Ltd|b|3|j|20230301|M\nMP-00-5702941|Ganga Realty Pvt Ltd|s|6|7|20251023|M\nBR-00-9449790|Ganga Boutique|5|1|h|20211118|M\nKR-00-2257708|Sunrise Stays|6|4|1|20211110|M\nTS-00-8986861|Riddhi Dental Care|9|b|6|20220521|M\nKL-00-3587492|Om Legal Associates LLP|i|5|9|20251004|M\nDL-00-1228109|Sunrise Physio Clinic Pvt Ltd|o|2|5|20221024|M\nMH-00-4111961|Annapurna Fitness|e|7|d|20210506|M\nMP-00-6202303|Orbit Legal Associates Pvt Ltd|i|6|2|20220822|M\nAP-00-9123294|Neelgiri Hardware|f|0|l|20220408|M\nMP-00-8714728|Saffron Electronics|b|6|7|20251208|M\nKR-00-1115424|Ganesh Woodcraft|d|4|1|20240925|S\nDL-00-6276629|Apex Realty Pvt Ltd|s|2|5|20251017|S\nMH-00-7445783|Lakshmi Textiles LLP|x|7|d|20211209|M\nTN-00-2823946|Blue Lotus Diagnostics LLP|a|a|4|20251204|M\nDL-00-1543681|Ganesh Medicals|m|2|5|20210525|M\nDL-00-8253869|Om Packaging|l|2|5|20210524|M\nTN-00-2294274|Sunrise Legal Associates Pvt Ltd|i|a|3|20240810|S\nGJ-00-7794393|Neelgiri Bake House Pvt Ltd|4|3|j|20211226|M\nMH-00-4587231|New Bake House|4|7|d|20210328|M\nTN-00-2649689|Trinity Bake House|4|a|4|20211111|S\nDL-00-1109755|Saffron Sweets|w|2|5|20250104|S\nGJ-00-0741952|Pearl Bakers|3|3|j|20230411|M\nMH-00-1471568|Prime Boutique|5|7|d|20250809|M\nGJ-00-9264284|Classic Diagnostics|a|3|0|20240917|M\nMH-00-1221777|New General Store|h|7|d|20210818|M\nKR-00-0661669|Balaji Bake House LLP|4|4|1|20250925|M\nWB-00-7844343|Amrit Fashions LLP|0|d|a|20250430|M\nMH-00-1367349|Pearl Boutique|5|7|i|20231003|M\nWB-00-0861857|Green Leaf Stationers|v|d|a|20210915|S\nGJ-00-7980411|Green Leaf Medicals|m|3|k|20210910|M\nTS-00-5712201|Unity Legal Associates Pvt Ltd|i|b|6|20240418|M\nMH-00-6131836|Saffron Dental Care LLP|9|7|f|20201024|M\nMP-00-8049061|Neelgiri Insurance Advisors Pvt Ltd|g|6|7|20230317|M\nGJ-00-2695483|Evergreen Mobile Care|j|3|j|20250829|S\nKR-00-4507900|Riddhi Classes Pvt Ltd|8|4|1|20210426|M\nRJ-00-8334294|Lakshmi Stays Pvt Ltd|6|9|8|20241017|M\nMP-00-7044647|Harmony Polymers LLP|p|6|7|20230714|D\nGJ-00-8002016|New Pharma Retail|n|3|0|20230906|M\nMH-00-4734948|Saffron Fitness Pvt Ltd|e|7|f|20230818|M\nMH-00-2393506|Sunrise Pharma Retail Pvt Ltd|n|7|d|20250801|M\nWB-00-3110075|Modern Unisex Salon|u|d|a|20220129|S\nMH-00-6579885|Kaveri Tours & Travels LLP|y|7|f|20250213|S\nTN-00-7078790|Orbit Polymers|p|a|3|20240220|S\nKL-00-1852255|Modern Classes|8|5|9|20250321|M\nKL-00-0824007|Coral Boutique|5|5|9|20220202|M\nTN-00-6867246|Classic Tours & Travels|y|a|3|20231013|M\nMH-00-3172853|Ganesh General Store|h|7|d|20241128|D\nKR-00-8187387|Ganga Bakers|3|4|1|20220507|D\nGJ-00-3182499|Ganga Medicals|m|3|k|20220213|S\nDL-00-3290178|Om Kids Academy LLP|q|2|5|20250419|D\nDL-00-2246222|Moonlight Boutique|5|2|5|20250330|S\nBR-00-1992044|Sai Pharma Retail LLP|n|1|h|20260125|M\nMH-00-7851733|Harmony Tours & Travels|y|7|d|20220213|S\nUP-00-5535050|Silver Oak Unisex Salon|u|c|b|20251214|M\nMH-00-3953747|Annapurna Stationers|v|7|d|20210731|S\nKL-00-8297560|Unity Dental Care|9|5|9|20210420|D\nWB-00-9061843|Unity Dental Care|9|d|a|20230503|M\nTS-00-9656857|Royal & Associates LLP|7|b|6|20230509|M\nBR-00-2933965|Royal Kids Academy|q|1|h|20250301|M\nUP-00-2738615|New Insurance Advisors|g|c|b|20250418|S\nMP-00-1169748|Orbit Stays Pvt Ltd|6|6|2|20230413|M\nTN-00-4837147|Ganga Physio Clinic Pvt Ltd|o|a|3|20210531|M\nAP-00-7249020|Amrit General Store|h|0|l|20230408|M\nGJ-00-1040368|Green Leaf Diagnostics Pvt Ltd|a|3|0|20220821|S\nPB-00-8838774|New General Store|h|8|c|20220604|M\nTN-00-6367525|Harmony Insurance Advisors|g|a|3|20250622|M\nMP-00-7233029|Pearl General Store|h|6|7|20220308|M\nMP-00-9045667|Pearl General Store|h|6|2|20220422|M\nPB-00-3391551|Balaji Sweets|w|8|c|20210310|M\nMH-00-6677199|Ganesh General Store|h|7|f|20220331|M\nTN-00-3048241|Moonlight Pharma Retail LLP|n|a|3|20210304|M\nTN-00-9307918|Blue Lotus Electronics|b|a|4|20240412|M\nWB-00-1347649|Lakshmi Hardware|f|d|a|20210812|M\nMH-00-5307058|Harmony Stationers|v|7|d|20250626|D\nTS-00-2968769|Harmony General Store|h|b|6|20220830|M\nGJ-00-3067381|Lakshmi Polymers Pvt Ltd|p|3|j|20231031|S\nAP-00-0813137|Sai Realty Pvt Ltd|s|0|l|20250629|M\nMH-00-6715918|Harmony Pharma Retail|n|7|d|20210111|D\nDL-00-1592928|Metro Stays LLP|6|2|5|20250408|M\nTN-00-8750843|Prime & Associates Pvt Ltd|7|a|3|20210629|M\nKR-00-8102033|Annapurna Diagnostics LLP|a|4|1|20240112|D\nMP-00-0896165|Om Opticals|k|6|7|20211103|M\nWB-00-1267399|Coral Opticals|k|d|a|20250605|M\nTN-00-9527833|Coral Bakers|3|a|3|20251105|M\nMP-00-7952764|Pearl Kids Academy LLP|q|6|7|20240120|M\nMH-00-1022321|Evergreen Electronics Pvt Ltd|b|7|i|20220827|M\nTS-00-3254331|Kaveri Dental Care LLP|9|b|6|20201115|M\nGJ-00-5960129|Green Leaf Kitchens LLP|t|3|k|20220712|D\nBR-00-7800534|Annapurna Kitchens LLP|t|1|h|20210405|S\nKR-00-1202524|Zenith General Store|h|4|1|20241218|M\nUP-00-6331500|Evergreen General Store|h|c|b|20231210|D\nMP-00-2776465|Sahyadri & Associates|7|6|7|20230514|M\nGJ-00-4651485|Amrit Kitchens|t|3|0|20250813|S\nUP-00-1696127|Zenith Classes|8|c|b|20210303|M\nKL-00-8613866|Star Bakers|3|5|9|20221105|M\nGJ-00-7375035|Ganga Diagnostics Pvt Ltd|a|3|0|20210728|M\nMH-00-4242841|Krishna Electronics LLP|b|7|i|20220417|M\nPB-00-4578753|Royal Boutique|5|8|c|20230221|S\nTS-00-8850764|Lakshmi Opticals|k|b|6|20210322|D\nKR-00-9982620|Classic Insurance Advisors|g|4|1|20231206|M\nGJ-00-6049811|Sunrise Stays Pvt Ltd|6|3|j|20230422|D\nDL-00-9299156|Saffron Pharma Retail|n|2|5|20210727|M\nGJ-00-1722536|Navkar Printers Pvt Ltd|r|3|0|20230402|D\nRJ-00-1221654|Ganesh Tours & Travels Pvt Ltd|y|9|8|20240224|M\nMH-00-4520959|Ganga Legal Associates|i|7|d|20210209|M\nMH-00-0435249|Shree Stays|6|7|g|20240717|M\nMP-00-6278901|Metro Kitchens|t|6|2|20210105|S\nPB-00-2129928|Pearl Dental Care|9|8|c|20210712|S\nMH-00-3382966|Navkar Hardware|f|7|f|20210115|M\nDL-00-5497919|Evergreen Legal Associates|i|2|5|20221204|S\nMH-00-6196721|Saffron Sweets|w|7|i|20230730|M\nMH-00-2204341|Vindhya Textiles|x|7|i|20230804|M\nGJ-00-3846849|Prime General Store|h|3|k|20251020|M\nPB-00-6604107|Galaxy Boutique|5|8|c|20201214|M\nMP-00-9388541|Neelgiri Mobile Care|j|6|7|20241017|M\nGJ-00-5999654|Om Design Studio Pvt Ltd|1|3|0|20210810|M\nGJ-00-8654280|Neelgiri Legal Associates|i|3|k|20250823|M\nMH-00-6430770|Vindhya Bakers|3|7|d|20220820|M\nTS-00-6663172|New Dental Care|9|b|6|20240628|M\nDL-00-5383754|Vindhya Unisex Salon|u|2|5|20250317|M\nGJ-00-0135873|Saffron Medicals|m|3|0|20240518|M\nMH-00-7566413|Classic Tours & Travels|y|7|i|20230727|M\nKR-00-2092561|Trinity Tours & Travels Pvt Ltd|y|4|1|20230810|D\nAP-00-5499450|Zenith Unisex Salon|u|0|l|20230827|M\nMH-00-5095573|Galaxy Polymers Pvt Ltd|p|7|d|20211218|S\nGJ-00-0217443|Sahyadri Tours & Travels Pvt Ltd|y|3|j|20210725|M\nMH-00-9435858|Lakshmi Hardware|f|7|g|20220831|M\nGJ-00-9173938|Prime Stationers|v|3|j|20240707|M\nPB-00-7036602|Lakshmi Stays|6|8|c|20210220|M\nMH-00-2019945|Coral Unisex Salon|u|7|d|20231010|S\nWB-00-4450505|Evergreen Foods Pvt Ltd|c|d|a|20230430|M\nMH-00-8817353|Star Electronics Pvt Ltd|b|7|g|20250117|S\nMP-00-1209629|Evergreen Unisex Salon|u|6|7|20211204|M\nDL-00-2328424|Green Leaf Physio Clinic|o|2|5|20241003|M\nGJ-00-4922984|Neelgiri Hardware|f|3|j|20250210|S\nKR-00-7782635|Neelgiri Foods LLP|c|4|1|20210221|S\nKL-00-6379590|Zenith Sweets|w|5|9|20220419|D\nMH-00-8297212|City Foods|c|7|d|20230429|S\nKR-00-7658475|New Tours & Travels|y|4|e|20230205|S\nTN-00-2364836|Shree & Associates Pvt Ltd|7|a|3|20210730|M\nPB-00-3944436|Krishna Opticals|k|8|c|20240526|S\nPB-00-1668278|Blue Lotus Bakers|3|8|c|20210217|S\nMH-00-3331515|Apex Medicals|m|7|i|20220827|M\nMH-00-9101854|Unity Medicals|m|7|g|20230608|M\nMH-00-0466285|Annapurna Stays LLP|6|7|i|20230130|M\nTN-00-3819872|Classic Physio Clinic|o|a|4|20221022|M\nTS-00-3847950|Unity Stays LLP|6|b|6|20220619|S\nMH-00-4943794|Neelgiri Bake House|4|7|i|20210822|M\nMH-00-6036440|Ganga Stays|6|7|d|20220720|S\nKR-00-5350995|Blue Lotus Legal Associates|i|4|1|20240610|S\nPB-00-3890107|Pearl Boutique|5|8|c|20250831|M\nMH-00-7046563|Star Tours & Travels Pvt Ltd|y|7|d|20210112|S\nUP-00-7550920|Sahyadri Classes|8|c|b|20241206|M\nKR-00-2278281|Blue Lotus Boutique|5|4|1|20220223|M\nTN-00-3305792|Vindhya Kitchens LLP|t|a|3|20240528|S\nKR-00-0774672|Saffron Pharma Retail|n|4|1|20210826|M\nKR-00-2250021|Modern Packaging Pvt Ltd|l|4|e|20220804|S\nAP-00-8962255|Kaveri Fashions Pvt Ltd|0|0|l|20230423|M\nMH-00-1212651|Neelgiri Mobile Care|j|7|i|20250211|D\nMH-00-7397442|Amrit Bake House|4|7|i|20220624|M\nBR-00-7515861|Om General Store|h|1|h|20251213|M\nKR-00-4671535|Trinity Opticals|k|4|e|20250404|M\nKL-00-9491539|Ganesh Fitness|e|5|9|20250613|M\nTS-00-4510933|Vindhya Bake House|4|b|6|20250608|S\nMH-00-1081526|Lakshmi Boutique|5|7|i|20240715|M\nTN-00-1251790|Ganga Tours & Travels|y|a|3|20250914|M\nRJ-00-5057760|Classic General Store|h|9|8|20230211|M\nGJ-00-3458209|Apex Pharma Retail LLP|n|3|k|20260105|S\nWB-00-5053330|Harmony Dental Care|9|d|a|20220927|S\nTS-00-5939543|Sunrise Medicals|m|b|6|20251110|M\nGJ-00-5880129|Krishna Boutique|5|3|j|20240920|M\nBR-00-0648173|Riddhi & Associates LLP|7|1|h|20240731|M\nTN-00-5303965|Star Fitness|e|a|3|20250904|M\nTN-00-2992387|Ganesh Diagnostics|a|a|3|20251014|M\nTS-00-7867624|Silver Oak Stays|6|b|6|20220617|M\nRJ-00-2284960|Sunrise Diagnostics|a|9|8|20230917|M\nMH-00-8186741|Sunrise Boutique|5|7|i|20250917|M\nMP-00-6983010|Harmony & Associates|7|6|7|20230304|M\nTS-00-8138478|Blue Lotus Hardware|f|b|6|20240327|M\nWB-00-8133796|Coral Bakers|3|d|a|20250807|M\nMH-00-5243353|Sahyadri Textiles LLP|x|7|i|20230525|M\nKR-00-7175944|Om Bakers|3|4|1|20210618|M\nMH-00-4102664|Unity Packaging Pvt Ltd|l|7|d|20211114|M\nGJ-00-5309192|Sahyadri Dental Care LLP|9|3|j|20230612|M\nKR-00-3761030|Pearl Medicals|m|4|e|20221123|M\nGJ-00-3095332|Orbit Kitchens|t|3|0|20220928|S\nUP-00-2336139|New Polymers|p|c|b|20211124|S\nKR-00-6006281|Pearl Insurance Advisors Pvt Ltd|g|4|1|20230215|M\nMH-00-9481261|Riddhi Kids Academy|q|7|g|20250418|S\nUP-00-4439176|Vindhya Bakers|3|c|b|20220629|M\nMH-00-7228614|Amrit Unisex Salon|u|7|d|20250421|M\nMH-00-6125554|Apex Kids Academy Pvt Ltd|q|7|f|20231217|M\nTN-00-9477813|Ganesh Auto Components Pvt Ltd|2|a|3|20250515|M\nMP-00-4920055|Modern Diagnostics LLP|a|6|7|20230801|M\nTN-00-8130321|City Physio Clinic Pvt Ltd|o|a|4|20231107|S\nMP-00-6598603|Apex General Store|h|6|2|20250813|M\nRJ-00-0383073|Lakshmi Hardware|f|9|8|20241119|S\nPB-00-7346478|Apex Tours & Travels|y|8|c|20230503|M\nKR-00-7946644|Evergreen Realty LLP|s|4|e|20221115|M\nAP-00-1344803|Vindhya Boutique|5|0|l|20220201|S\nMH-00-6991361|Trinity General Store|h|7|d|20240831|S\nBR-00-6431645|Lakshmi Realty|s|1|h|20220908|S\nTN-00-1914633|Galaxy Stationers|v|a|3|20230109|M\nMH-00-9557582|Sai Dental Care|9|7|f|20230811|M\nKR-00-8288216|Prime Foods LLP|c|4|e|20230602|M\nDL-00-6686489|Apex Stationers|v|2|5|20230626|M\nAP-00-2999242|Orbit Diagnostics|a|0|l|20230825|S\nTN-00-5214584|Riddhi Legal Associates Pvt Ltd|i|a|4|20220815|M\nKR-00-2607848|Metro Insurance Advisors LLP|g|4|1|20211009|M\nPB-00-9073491|Galaxy Fashions|0|8|c|20241116|M\nDL-00-7151529|Kaveri Bakers|3|2|5|20230128|S\nMH-00-3721627|Metro Electronics Pvt Ltd|b|7|f|20240729|D\nPB-00-8141864|Riddhi Opticals|k|8|c|20240122|S\nMH-00-1800144|Kaveri Opticals|k|7|d|20210218|M\nMH-00-4560912|Annapurna Design Studio Pvt Ltd|1|7|g|20221005|S\nGJ-00-9357752|Riddhi General Store|h|3|0|20230405|D\nMH-00-7634364|Trinity Tours & Travels|y|7|g|20210218|M\nTS-00-9055828|Royal Tours & Travels Pvt Ltd|y|b|6|20231013|M\nMH-00-4290770|Classic Realty LLP|s|7|f|20220410|M\nGJ-00-8641561|Ganesh Unisex Salon|u|3|j|20220705|S\nMH-00-2135439|Ganga Physio Clinic|o|7|g|20210818|M\nMP-00-4071097|Riddhi Hardware|f|6|7|20210420|S\nMH-00-0851293|Galaxy Bakers|3|7|d|20210702|M\nMH-00-8789884|Metro Classes|8|7|i|20210409|S\nTN-00-8566126|Prime Insurance Advisors LLP|g|a|3|20240709|S\nKR-00-7148873|Om Mobile Care|j|4|e|20251208|S\nGJ-00-0818187|Shree Packaging|l|3|0|20260127|M\nTN-00-5605251|Ganesh Boutique|5|a|4|20221011|M\nMH-00-1702875|City Mobile Care|j|7|f|20221211|M\nDL-00-0649289|Star Fashions LLP|0|2|5|20241018|M\nPB-00-4854985|Om Realty|s|8|c|20240110|S\nKR-00-7842767|New Boutique|5|4|e|20210203|M\nGJ-00-7177345|Sunrise General Store|h|3|j|20230426|M\nMH-00-2669800|Lakshmi Realty|s|7|f|20210429|M\nGJ-00-9358393|Royal Printers|r|3|j|20240912|S\nKR-00-6838773|Classic Sweets|w|4|1|20230709|M\nMH-00-5213235|Vindhya Bake House|4|7|g|20251022|M\nUP-00-6425127|Ganesh Electronics|b|c|b|20210417|S\nMP-00-9362966|Green Leaf Stays Pvt Ltd|6|6|7|20231224|S\nKL-00-0095102|Orbit Mobile Care|j|5|9|20240630|S\nMH-00-4774805|Metro Printers|r|7|d|20260112|M\nDL-00-3210302|City Sweets|w|2|5|20221020|M\nDL-00-5898417|Prime Stationers|v|2|5|20211025|M\nAP-00-8990822|Metro Physio Clinic|o|0|l|20211030|M\nTS-00-1341773|Modern Realty Pvt Ltd|s|b|6|20210416|M\nMH-00-1460465|Moonlight Polymers|p|7|i|20201227|M\nKR-00-2796926|Navkar Auto Components Pvt Ltd|2|4|1|20250124|S\nKR-00-0396374|Green Leaf Fitness Pvt Ltd|e|4|e|20231014|M\nGJ-00-8813447|Sai Dental Care|9|3|j|20220829|M\nMH-00-3451731|New Stays Pvt Ltd|6|7|d|20240502|M\nKR-00-1293335|Metro Hardware|f|4|1|20231113|M\nPB-00-9073318|Coral Stays LLP|6|8|c|20241124|S\nKR-00-2331056|Metro & Associates|7|4|e|20240322|S\nMH-00-7831685|Pearl Boutique|5|7|f|20220202|M\nMH-00-7197422|Coral Boutique|5|7|d|20210904|M\nKR-00-1193667|Om Kids Academy|q|4|1|20250201|M\nMH-00-7788716|Moonlight & Associates LLP|7|7|d|20220630|M\nGJ-00-2440515|Sahyadri General Store|h|3|j|20220713|M\nKL-00-9427413|Pearl Design Studio|1|5|9|20221213|M\nMH-00-4267335|Riddhi Kids Academy|q|7|d|20241030|M\nKL-00-6284430|Lakshmi Realty Pvt Ltd|s|5|9|20210310|M\nMH-00-5962106|Blue Lotus Mobile Care|j|7|g|20230313|M\nWB-00-2423709|Royal Printers LLP|r|d|a|20201023|D\nTN-00-7294798|Sai Dental Care|9|a|3|20240225|M\nKR-00-4456132|Moonlight Dental Care Pvt Ltd|9|4|1|20251108|M\nTS-00-4994285|Shree Physio Clinic Pvt Ltd|o|b|6|20250107|M\nKR-00-5326308|Blue Lotus Bakers|3|4|1|20250621|M\nKR-00-0654366|Metro Kids Academy Pvt Ltd|q|4|1|20220227|M\nGJ-00-2727014|Unity Diagnostics|a|3|k|20230707|D\nKR-00-1500515|Prime Stays Pvt Ltd|6|4|1|20211106|M\nWB-00-5038212|Harmony Electronics LLP|b|d|a|20230209|S\nAP-00-9549925|Harmony Hardware|f|0|l|20230716|M\nGJ-00-7332056|Annapurna Fashions LLP|0|3|0|20231105|M\nBR-00-7680563|Sunrise Legal Associates Pvt Ltd|i|1|h|20251024|M\nKL-00-4570455|Annapurna Stays Pvt Ltd|6|5|9|20210807|D\nTN-00-6349294|Balaji Diagnostics LLP|a|a|3|20241010|M\nUP-00-8553137|Krishna Sweets|w|c|b|20210612|M\nGJ-00-4199654|Star Physio Clinic|o|3|0|20230803|M\nUP-00-4980595|Riddhi Classes Pvt Ltd|8|c|b|20221223|M\nKR-00-3122610|Ganga Diagnostics|a|4|1|20240226|M\nMP-00-2995267|Shree Auto Components Pvt Ltd|2|6|7|20220519|M\nTS-00-0828464|Green Leaf Hardware|f|b|6|20231024|M\nKR-00-8818903|City Stays Pvt Ltd|6|4|1|20240218|M\nTN-00-8826380|City Design Studio|1|a|4|20240625|M\nMH-00-6892178|Navkar Stationers|v|7|d|20220615|M\nKR-00-8117488|Royal Medicals|m|4|1|20210324|M\nMH-00-2824359|Pearl Tours & Travels Pvt Ltd|y|7|f|20251203|M\nMP-00-3177062|Saffron Boutique|5|6|7|20230727|M\nTN-00-8742631|Silver Oak Kids Academy|q|a|4|20250204|M\nDL-00-7773477|Metro Design Studio|1|2|5|20220504|M\nKR-00-4766861|Unity Fashions|0|4|e|20240403|M\nUP-00-0823013|City Packaging|l|c|b|20220328|S\nKR-00-8465232|Amrit Insurance Advisors Pvt Ltd|g|4|1|20250928|M\nTN-00-3815641|New General Store|h|a|3|20210316|M\nRJ-00-6542841|Apex Fashions|0|9|8|20220714|M\nKR-00-4965699|Evergreen Fashions Pvt Ltd|0|4|1|20210920|S\nKR-00-7641028|Trinity Mobile Care|j|4|1|20250525|M\nMH-00-2724992|Sahyadri Stays Pvt Ltd|6|7|i|20211209|M\nMH-00-5751456|Om Hardware|f|7|f|20221115|M\nMH-00-4685187|Krishna Bakers|3|7|i|20250202|M\nGJ-00-6644062|Navkar Fashions|0|3|0|20240915|M\nTN-00-3160942|Balaji Legal Associates Pvt Ltd|i|a|4|20210302|M\nMH-00-8698090|Green Leaf Medicals|m|7|f|20230416|M\nDL-00-5458358|Galaxy Auto Components LLP|2|2|5|20230424|S\nRJ-00-1238312|Annapurna Diagnostics LLP|a|9|8|20250707|M\nKL-00-9863199|Harmony Fitness Pvt Ltd|e|5|9|20250812|S\nMH-00-6043854|Royal Bake House Pvt Ltd|4|7|f|20240803|M\nMH-00-0292134|Harmony Fashions Pvt Ltd|0|7|d|20231112|M\nGJ-00-4229135|Annapurna Stays|6|3|k|20211023|D\nAP-00-5253380|Ganga Polymers Pvt Ltd|p|0|l|20250914|M\nMP-00-7534047|Krishna Design Studio Pvt Ltd|1|6|2|20210118|M\nKL-00-2366688|Trinity Insurance Advisors|g|5|9|20250310|M\nTN-00-8549110|Kaveri Kids Academy LLP|q|a|3|20210213|S\nWB-00-5985990|Moonlight General Store|h|d|a|20211006|S\nPB-00-8975857|New Boutique|5|8|c|20201129|M\nDL-00-1572325|Om Insurance Advisors Pvt Ltd|g|2|5|20250225|S\nMH-00-3724891|Modern Unisex Salon|u|7|i|20210907|M\nDL-00-2280446|Neelgiri Mobile Care|j|2|5|20220204|M\nMH-00-7795454|Lakshmi Opticals|k|7|g|20210121|D\nDL-00-5091072|Evergreen Hardware|f|2|5|20240128|M\nMH-00-3337809|Green Leaf Stationers|v|7|f|20210828|S\nUP-00-9270338|Lakshmi General Store|h|c|b|20221230|M\nTS-00-0958052|Saffron Fitness|e|b|6|20250730|S\nGJ-00-1295570|Saffron Insurance Advisors LLP|g|3|k|20250625|M\nTN-00-4820357|Modern Foods Pvt Ltd|c|a|3|20250202|M\nKL-00-5154918|Green Leaf Unisex Salon|u|5|9|20201029|M\nDL-00-6172088|Star Kitchens Pvt Ltd|t|2|5|20211024|S\nRJ-00-8063042|Galaxy Stationers|v|9|8|20221019|M\nAP-00-8014489|Orbit Bakers|3|0|l|20210407|S\nMH-00-5106497|City Mobile Care|j|7|d|20240202|M\nAP-00-7448759|Navkar Kids Academy Pvt Ltd|q|0|l|20221124|S\nKR-00-2770678|Apex Bakers|3|4|e|20250926|M\nBR-00-4095899|Pearl Printers|r|1|h|20220812|D\nDL-00-1887453|Galaxy & Associates|7|2|5|20241124|M\nTS-00-2494888|Vindhya Hardware|f|b|6|20221013|M\nKL-00-9221848|Star Legal Associates Pvt Ltd|i|5|9|20251123|M\nMH-00-6297988|Metro Auto Components|2|7|d|20250201|D\nPB-00-6152895|Prime Design Studio Pvt Ltd|1|8|c|20251013|M\nKR-00-1106621|Moonlight Textiles|x|4|1|20241214|M\nUP-00-3730630|Lakshmi Woodcraft LLP|d|c|b|20220108|S\nBR-00-0610286|Om Electronics|b|1|h|20220603|D\nDL-00-2001629|Green Leaf Insurance Advisors|g|2|5|20241230|M\nAP-00-4620527|Galaxy Mobile Care|j|0|l|20240715|S\nMH-00-8866398|Evergreen Realty|s|7|d|20240803|D\nTN-00-9934268|Evergreen Polymers|p|a|4|20250621|S\nDL-00-9013627|Apex Opticals|k|2|5|20230810|M\nTN-00-4760509|Galaxy Polymers Pvt Ltd|p|a|3|20210118|M\nMH-00-5565801|Amrit Opticals|k|7|i|20211018|S\nAP-00-5327947|Riddhi Mobile Care|j|0|l|20220420|S\nGJ-00-4472878|Blue Lotus General Store|h|3|k|20210706|M\nBR-00-0178181|Neelgiri Bakers|3|1|h|20220824|D\nTN-00-4980386|Lakshmi Stays|6|a|4|20230712|M\nKL-00-5332904|Vindhya Unisex Salon|u|5|9|20220907|M\nGJ-00-9158296|Green Leaf Legal Associates|i|3|j|20210818|M\nPB-00-7219265|Kaveri Legal Associates LLP|i|8|c|20210519|M\nGJ-00-0226482|Vindhya Stays|6|3|j|20240624|S\nGJ-00-0179836|Lakshmi General Store|h|3|k|20250605|S\nTS-00-0082483|Amrit Electronics|b|b|6|20230422|M\nGJ-00-3911040|Om Legal Associates Pvt Ltd|i|3|0|20230206|D\nMH-00-0400338|Amrit Physio Clinic|o|7|f|20230625|M\nGJ-00-6241160|Evergreen Packaging Pvt Ltd|l|3|k|20230525|S\nWB-00-1228380|Prime Boutique|5|d|a|20250607|S\nKR-00-0227348|Apex Fashions Pvt Ltd|0|4|1|20251007|M\nAP-00-9896858|Sahyadri Boutique|5|0|l|20250501|M\nMH-00-7256794|Harmony Kitchens|t|7|g|20221026|M\nGJ-00-6672118|Trinity Diagnostics Pvt Ltd|a|3|k|20230304|M\nDL-00-7042879|Annapurna Classes|8|2|5|20201129|M\nMP-00-8883982|Star General Store|h|6|2|20240616|M\nKL-00-6727338|Riddhi Unisex Salon|u|5|9|20211219|S\nGJ-00-3540845|Zenith Textiles LLP|x|3|k|20240920|S\nGJ-00-7336046|City Kitchens|t|3|j|20220616|M\nKL-00-7207663|Prime Fitness Pvt Ltd|e|5|9|20230127|M\nTN-00-6536938|Om & Associates LLP|7|a|3|20250420|M\nMP-00-1366101|City Printers|r|6|7|20201213|D\nDL-00-3088950|Kaveri Tours & Travels LLP|y|2|5|20211218|D\nKR-00-8008452|Ganga Polymers|p|4|1|20221010|M\nGJ-00-0116696|Moonlight Design Studio|1|3|0|20260119|M\nGJ-00-2132342|Modern Stationers|v|3|k|20250720|M\nDL-00-4051447|Amrit Opticals|k|2|5|20230112|M\nTN-00-6499392|Lakshmi Tours & Travels Pvt Ltd|y|a|3|20230125|M\nMH-00-9596598|Evergreen Kitchens|t|7|i|20240121|M\nMH-00-4729959|Trinity Realty|s|7|d|20210413|S\nKR-00-3883502|Om Pharma Retail|n|4|e|20220625|M\nTN-00-7918153|Krishna Pharma Retail Pvt Ltd|n|a|3|20210801|M\nGJ-00-5469311|Blue Lotus Fashions|0|3|k|20240809|M\nGJ-00-5130514|Orbit General Store|h|3|k|20251027|M\nTN-00-7695764|Riddhi Unisex Salon|u|a|3|20220930|M\nPB-00-5054454|Modern Electronics|b|8|c|20211108|S\nDL-00-3373053|Sunrise Physio Clinic LLP|o|2|5|20240514|M\nWB-00-6075746|Kaveri Bakers|3|d|a|20201022|S\nWB-00-0202272|Annapurna Stays Pvt Ltd|6|d|a|20240625|M\nGJ-00-5481762|Kaveri Bakers|3|3|k|20230627|D\nWB-00-7097996|Sahyadri Pharma Retail|n|d|a|20220911|M\nKL-00-1699445|Neelgiri Legal Associates|i|5|9|20250914|S\nAP-00-3557078|New Medicals|m|0|l|20211224|M\nDL-00-6588204|Balaji Kitchens|t|2|5|20201019|M\nGJ-00-5121736|Annapurna Design Studio Pvt Ltd|1|3|k|20201218|S\nMH-00-2297148|Unity Packaging|l|7|d|20220319|M\nMP-00-4766269|Neelgiri Kitchens|t|6|7|20250816|M\nTS-00-9765506|Royal Woodcraft Pvt Ltd|d|b|6|20260113|S\nTS-00-3150205|Evergreen Mobile Care|j|b|6|20210823|M\nGJ-00-3042571|Pearl Design Studio Pvt Ltd|1|3|k|20251102|M\nGJ-00-3619165|Prime Mobile Care|j|3|k|20251216|S\nDL-00-6955852|Vindhya Tours & Travels Pvt Ltd|y|2|5|20240110|M\nMP-00-0432634|Shree Diagnostics|a|6|7|20230110|M\nMH-00-9031077|Coral Legal Associates|i|7|f|20250213|M\nKR-00-3675079|Metro Bakers|3|4|1|20221124|M\nUP-00-5035687|New Stationers|v|c|b|20221217|M\nTN-00-1475437|Sai Fitness Pvt Ltd|e|a|3|20231122|M\nAP-00-9026770|Apex Tours & Travels Pvt Ltd|y|0|l|20230430|M\nMP-00-2927558|Harmony Bake House|4|6|2|20250306|S\nTN-00-8912607|Saffron Textiles|x|a|3|20240328|M\nMH-00-7316171|Galaxy Woodcraft Pvt Ltd|d|7|i|20240609|S\nAP-00-4495156|Saffron Tours & Travels LLP|y|0|l|20230122|S\nMP-00-4728964|Sai Dental Care|9|6|2|20220113|M\nMH-00-9743303|Pearl Legal Associates|i|7|g|20250403|S\nGJ-00-9954930|Prime Physio Clinic|o|3|0|20240817|S\nPB-00-4173786|Sai Legal Associates|i|8|c|20201029|M\nMH-00-5187395|Orbit Diagnostics LLP|a|7|i|20211228|M\nDL-00-1659707|Harmony Diagnostics|a|2|5|20210131|M\nDL-00-4764206|Krishna Tours & Travels LLP|y|2|5|20250124|M\nMH-00-7846849|Kaveri Fitness|e|7|d|20241021|M\nMH-00-2618525|Moonlight Pharma Retail LLP|n|7|g|20240505|M\nGJ-00-7515806|Evergreen Kids Academy|q|3|0|20260122|M\nMH-00-3786101|Balaji General Store|h|7|i|20220829|D\nKL-00-2621486|Apex Bakers|3|5|9|20220416|M\nMH-00-7318636|Neelgiri General Store|h|7|d|20241010|S\nGJ-00-7229646|Royal Mobile Care|j|3|k|20240315|M\nMP-00-7824283|Silver Oak Design Studio LLP|1|6|7|20230107|M\nMP-00-0620254|Apex Boutique|5|6|7|20221127|M\nTN-00-0256138|Zenith Fashions LLP|0|a|4|20231127|M\nRJ-00-2977050|Classic Diagnostics|a|9|8|20210307|M\nTN-00-9447832|Vindhya Printers|r|a|4|20210521|S\nPB-00-9046376|Neelgiri Design Studio Pvt Ltd|1|8|c|20230318|M\nWB-00-1741269|Silver Oak Insurance Advisors LLP|g|d|a|20201223|M\nAP-00-8699990|Annapurna Sweets|w|0|l|20250507|D\nBR-00-5097844|Navkar Boutique|5|1|h|20220327|M\nGJ-00-5848419|Amrit Hardware|f|3|0|20240831|M\nMH-00-6956506|Pearl Fitness LLP|e|7|d|20210821|M\nUP-00-9842004|Riddhi Fitness LLP|e|c|b|20230611|M\nKR-00-3425204|Om Classes|8|4|1|20210904|S\nPB-00-7931168|Annapurna Physio Clinic LLP|o|8|c|20220512|S\nMH-00-7522695|Green Leaf Pharma Retail|n|7|d|20230504|M\nMH-00-9991330|Unity Unisex Salon|u|7|d|20230519|M\nMH-00-6206747|Zenith Physio Clinic LLP|o|7|i|20240328|M\nTN-00-8435615|Metro Classes|8|a|4|20210815|S\nKR-00-9729112|Classic Mobile Care|j|4|1|20210224|M\nGJ-00-7436887|Trinity Kids Academy|q|3|0|20240721|M\nMP-00-5554375|Unity Diagnostics Pvt Ltd|a|6|7|20220502|S\nMH-00-1376064|Balaji Stationers|v|7|d|20210210|M\nMP-00-5208315|Krishna Diagnostics|a|6|7|20201107|S\nMH-00-0266122|Krishna Sweets|w|7|g|20240403|S\nTS-00-9481685|Sunrise Stationers|v|b|6|20240929|S\nUP-00-7621860|Moonlight Classes LLP|8|c|b|20230502|D\nWB-00-6319620|Apex General Store|h|d|a|20250625|M\nMH-00-1540978|Classic Stays|6|7|g|20251110|M\nTN-00-2049073|Krishna Foods|c|a|4|20250824|S\nTS-00-0967515|Classic Dental Care|9|b|6|20240323|M\nMH-00-4667051|Classic Fitness LLP|e|7|f|20250925|M\nKR-00-9607489|Sai Textiles Pvt Ltd|x|4|1|20240824|S\nAP-00-6931846|Unity Bake House Pvt Ltd|4|0|l|20250804|S\nGJ-00-9204185|Vindhya Bakers|3|3|j|20230925|M\nPB-00-9337666|Balaji General Store|h|8|c|20230323|S\nWB-00-9792054|Krishna Physio Clinic|o|d|a|20210609|M\nKR-00-8790231|Annapurna Electronics LLP|b|4|1|20210511|M\nGJ-00-6964519|Classic Bake House|4|3|k|20210806|M\nKL-00-3090824|Krishna Design Studio|1|5|9|20201021|M\nKR-00-6326107|Trinity Bake House Pvt Ltd|4|4|e|20230924|S\nGJ-00-3178775|Unity Bakers|3|3|j|20250311|S\nDL-00-4600194|Amrit Mobile Care|j|2|5|20201207|M\nDL-00-3785846|Harmony Printers Pvt Ltd|r|2|5|20211103|M\nUP-00-3707621|City Medicals|m|c|b|20210417|M\nMH-00-3240411|Shree Stays|6|7|f|20230909|S\nKL-00-9617929|Galaxy Design Studio Pvt Ltd|1|5|9|20220627|M\nTS-00-1815307|Royal Bakers|3|b|6|20220630|S\nRJ-00-7843322|Sunrise Unisex Salon|u|9|8|20201221|M\nMP-00-4051971|New Electronics|b|6|7|20240207|S\nMH-00-8515101|Evergreen Hardware|f|7|f|20201120|M\nGJ-00-6063522|Trinity Fashions LLP|0|3|k|20240909|M\nDL-00-8843357|Shree Classes LLP|8|2|5|20240602|S\nMP-00-5965711|Royal Unisex Salon|u|6|2|20240816|M\nMH-00-4735070|Om Unisex Salon|u|7|i|20210822|M\nRJ-00-4251721|Prime Sweets|w|9|8|20241231|S\nMH-00-1683184|Saffron Boutique|5|7|g|20220310|M\nGJ-00-4201881|Trinity Medicals|m|3|k|20220323|M\nTN-00-8041444|Pearl Hardware|f|a|3|20210514|M\nBR-00-1312081|Orbit Bake House Pvt Ltd|4|1|h|20221230|M\nDL-00-2971837|Saffron Stationers|v|2|5|20240108|D\nMH-00-0750228|Saffron Dental Care|9|7|f|20211206|M\nTS-00-9727287|Amrit Bakers|3|b|6|20220329|D\nMH-00-0306457|Shree Classes|8|7|g|20231224|S\nDL-00-4003741|Star & Associates|7|2|5|20230622|S\nTN-00-5200800|Galaxy Mobile Care|j|a|3|20250515|M\nBR-00-1192580|Harmony Hardware|f|1|h|20240919|M\nMH-00-4226297|Sunrise & Associates LLP|7|7|d|20221117|M\nKR-00-1958258|New Bakers|3|4|1|20251116|S\nDL-00-8142304|Saffron Hardware|f|2|5|20251130|M\nKR-00-3797720|Silver Oak Opticals|k|4|1|20201202|M\nWB-00-2295808|Modern Boutique|5|d|a|20211104|M\nTN-00-3634525|Amrit Tours & Travels|y|a|3|20240729|M\nMH-00-0332162|Green Leaf Tours & Travels Pvt Ltd|y|7|f|20210311|S\nMH-00-7776218|Amrit Sweets|w|7|d|20240515|M\nWB-00-6033859|Riddhi Opticals|k|d|a|20250711|M\nGJ-00-8057761|Galaxy Tours & Travels Pvt Ltd|y|3|k|20220719|M\nGJ-00-6367520|City & Associates Pvt Ltd|7|3|k|20250923|M\nMH-00-9828399|Moonlight Fashions Pvt Ltd|0|7|d|20250927|M\nRJ-00-9059483|Silver Oak General Store|h|9|8|20210418|S\nTN-00-6244884|Coral Unisex Salon|u|a|3|20201124|M\nPB-00-0114527|Krishna Fitness LLP|e|8|c|20250510|M\nUP-00-9784136|Trinity Diagnostics Pvt Ltd|a|c|b|20220217|S\nMP-00-3962751|Orbit Diagnostics|a|6|2|20240905|M\nMH-00-9239619|Star Dental Care|9|7|d|20241220|S\nKR-00-9802958|Sai Auto Components Pvt Ltd|2|4|1|20220223|S\nTS-00-9356914|Classic General Store|h|b|6|20240501|M\nRJ-00-5396995|Annapurna General Store|h|9|8|20250130|M\nAP-00-1016172|New Classes Pvt Ltd|8|0|l|20220207|M\nMH-00-1212796|Blue Lotus Auto Components LLP|2|7|i|20210113|S\nWB-00-1375150|Sahyadri Unisex Salon|u|d|a|20260124|M\nMH-00-6855045|Harmony Medicals|m|7|i|20240817|M\nTN-00-6951508|Krishna Hardware|f|a|3|20241031|S\nUP-00-4132492|New Physio Clinic Pvt Ltd|o|c|b|20221106|M\nWB-00-3884790|Sunrise Insurance Advisors|g|d|a|20210715|M\nRJ-00-4765862|Royal Boutique|5|9|8|20230629|S\nAP-00-8587578|Orbit Classes|8|0|l|20220731|S\nKR-00-7368353|Silver Oak Fashions Pvt Ltd|0|4|1|20220506|M\nMP-00-5172455|Apex Kitchens Pvt Ltd|t|6|7|20201118|M\nMH-00-9452178|Balaji Opticals|k|7|d|20250109|S\nMH-00-5637002|Shree Pharma Retail|n|7|i|20211107|M\nMH-00-1514531|Green Leaf Realty|s|7|i|20240313|S\nGJ-00-9882981|Amrit Pharma Retail|n|3|k|20220127|M\nMH-00-6489523|Galaxy Dental Care LLP|9|7|i|20220717|M\nMH-00-7626191|Harmony Classes|8|7|i|20230206|M\nTN-00-3122321|Krishna Hardware|f|a|4|20230720|M\nMH-00-0413575|Navkar Boutique|5|7|f|20230525|M\nKR-00-9046792|Unity Hardware|f|4|1|20221201|M\nMH-00-1788933|Lakshmi Bake House|4|7|d|20210128|S\nGJ-00-4929126|Moonlight Diagnostics LLP|a|3|j|20230313|M\nKL-00-3817681|Sahyadri Medicals|m|5|9|20220204|M\nPB-00-1741307|Classic Medicals|m|8|c|20230618|M\nMH-00-2221704|Saffron Design Studio LLP|1|7|i|20220113|S\nTN-00-9264710|Sai Sweets|w|a|3|20201230|M\nKL-00-8945821|Harmony Textiles|x|5|9|20220810|S\nRJ-00-0094497|Sai Legal Associates|i|9|8|20210403|M\nGJ-00-5705708|Silver Oak Kids Academy LLP|q|3|k|20250912|M\nMP-00-3929810|Annapurna Tours & Travels Pvt Ltd|y|6|2|20220225|S\nKL-00-4293698|Lakshmi Boutique|5|5|9|20230415|S\nAP-00-8988271|Navkar Sweets|w|0|l|20250912|S\nTS-00-9726727|Balaji General Store|h|b|6|20210202|S\nGJ-00-0512802|New Printers|r|3|j|20230830|S\nTN-00-9984594|Sunrise Polymers|p|a|3|20220604|M\nTN-00-2798480|Harmony Classes|8|a|3|20210504|M\nTN-00-5732895|Lakshmi Stays LLP|6|a|4|20251220|M\nKR-00-2859405|Kaveri Kids Academy LLP|q|4|1|20220507|M\nDL-00-0490822|Harmony Realty LLP|s|2|5|20251228|M\nWB-00-6824015|Blue Lotus Unisex Salon|u|d|a|20220621|M\nMH-00-9046756|Saffron Woodcraft Pvt Ltd|d|7|g|20220520|M\nTN-00-5070163|Amrit Auto Components Pvt Ltd|2|a|3|20251128|S\nBR-00-2917703|Unity Hardware|f|1|h|20221029|M\nDL-00-7220891|Navkar Bakers|3|2|5|20230406|S\nAP-00-8604208|Sunrise Diagnostics|a|0|l|20210510|M\nBR-00-5491373|Vindhya Realty|s|1|h|20231208|M\nGJ-00-7485897|Krishna Stays|6|3|k|20210302|M\nWB-00-7928061|Green Leaf Dental Care LLP|9|d|a|20230115|M\nKL-00-0266874|Blue Lotus Dental Care LLP|9|5|9|20250701|M\nTS-00-2949068|Coral Mobile Care|j|b|6|20240928|M\nMH-00-9264757|Navkar Electronics Pvt Ltd|b|7|i|20211113|D\nMH-00-8645477|Zenith Kids Academy|q|7|d|20220727|S\nMH-00-1809272|Star Bake House Pvt Ltd|4|7|i|20250114|M\nKL-00-0308663|Coral Opticals|k|5|9|20230724|M\nTS-00-5896448|Ganesh Medicals|m|b|6|20230914|M\nDL-00-5931111|Sai Sweets|w|2|5|20210508|M\nTS-00-7444643|Kaveri Medicals|m|b|6|20220209|M\nGJ-00-3510011|Ganesh Tours & Travels|y|3|0|20251207|M\nTS-00-9102735|Navkar Mobile Care|j|b|6|20230427|M\nTN-00-2685524|Metro & Associates|7|a|3|20250804|S\nTS-00-7089720|Vindhya Kids Academy|q|b|6|20211005|M\nGJ-00-4497312|Lakshmi Stationers|v|3|j|20250303|M\nMH-00-5362288|Saffron Opticals|k|7|i|20250702|M\nTS-00-1835413|Metro Pharma Retail|n|b|6|20250731|M\nWB-00-2241447|Neelgiri Physio Clinic LLP|o|d|a|20240924|S\nMP-00-4254717|Om Dental Care Pvt Ltd|9|6|7|20220119|M\nKR-00-4660657|Neelgiri Stationers|v|4|e|20210710|M\nMH-00-9905603|Unity Kitchens LLP|t|7|d|20240728|M\nGJ-00-4621791|Trinity Diagnostics|a|3|j|20201017|M\nDL-00-9892281|Silver Oak & Associates|7|2|5|20221119|M\nTS-00-3540887|Lakshmi Boutique|5|b|6|20220728|M\nMP-00-1156627|Balaji Polymers|p|6|2|20220124|D\nRJ-00-5548714|Sunrise Bakers|3|9|8|20250614|M\nMP-00-9851196|Neelgiri Kids Academy|q|6|7|20230215|M\nBR-00-2877492|Green Leaf Pharma Retail|n|1|h|20240304|M\nTS-00-1465406|Amrit Hardware|f|b|6|20220807|M\nTN-00-3491938|Saffron Tours & Travels Pvt Ltd|y|a|3|20220715|M\nTN-00-2216759|Amrit Pharma Retail LLP|n|a|4|20260123|M\nWB-00-1995578|Star Woodcraft|d|d|a|20250716|S\nKR-00-0016872|Orbit Sweets|w|4|1|20230831|S\nMP-00-4304611|Galaxy Sweets|w|6|2|20231020|M\nRJ-00-4347003|New Boutique|5|9|8|20250207|S\nMH-00-4454313|Sahyadri Sweets|w|7|f|20231215|M\nWB-00-4269582|New Opticals|k|d|a|20250317|M\nWB-00-8915223|Vindhya Medicals|m|d|a|20221229|M\nGJ-00-4343175|Riddhi Opticals|k|3|k|20240611|M\nTS-00-5005713|Galaxy Stationers|v|b|6|20230604|M\nMP-00-7469901|Sahyadri Medicals|m|6|7|20230805|D\nDL-00-0115234|Modern Pharma Retail|n|2|5|20211007|M\nPB-00-1893971|Balaji Opticals|k|8|c|20221103|M\nGJ-00-2107327|New & Associates Pvt Ltd|7|3|j|20240731|S\nMP-00-7794800|Prime Bake House|4|6|7|20210904|M\nDL-00-6410845|Kaveri Realty LLP|s|2|5|20210331|M\nRJ-00-5308217|Balaji Design Studio|1|9|8|20220628|M\nMH-00-7815076|Balaji Stationers|v|7|i|20231104|M\nGJ-00-6960624|Saffron Bake House|4|3|k|20220409|S\nKR-00-8220336|Unity General Store|h|4|e|20251002|M\nBR-00-5633383|Galaxy Sweets|w|1|h|20250503|M\nPB-00-5139998|Classic Sweets|w|8|c|20240319|M\nKL-00-5121737|Annapurna Physio Clinic Pvt Ltd|o|5|9|20230120|M\nTS-00-2865029|Navkar Boutique|5|b|6|20210717|M\nDL-00-6669383|Modern Physio Clinic|o|2|5|20250926|S\nGJ-00-8312825|Neelgiri Legal Associates|i|3|0|20220611|M\nMH-00-1309031|Ganga Fashions LLP|0|7|i|20220815|M\nDL-00-9454824|Krishna Legal Associates LLP|i|2|5|20220620|M\nDL-00-4950807|Sai Stays LLP|6|2|5|20250207|M\nMP-00-3278246|Classic General Store|h|6|2|20250329|M\nMH-00-5718654|Shree Opticals|k|7|f|20250430|M\nKR-00-2885474|Kaveri & Associates|7|4|1|20220328|M\nDL-00-8882144|Coral Hardware|f|2|5|20230317|M\nMH-00-4666290|Pearl Physio Clinic Pvt Ltd|o|7|d|20251021|M\nUP-00-4046690|Krishna Insurance Advisors|g|c|b|20210605|M\nAP-00-4092149|Classic General Store|h|0|l|20210821|S\nKR-00-8761064|Modern General Store|h|4|1|20241116|M\nTN-00-8832270|Royal & Associates LLP|7|a|3|20250123|S\nKR-00-6373030|Krishna Fitness LLP|e|4|1|20230215|M\nKL-00-3193714|Om Unisex Salon|u|5|9|20240119|M\nTN-00-5928478|Sai Kids Academy Pvt Ltd|q|a|4|20250817|M\nGJ-00-5502308|New Unisex Salon|u|3|j|20221106|M\nKR-00-9106613|Lakshmi Tours & Travels|y|4|1|20211103|M\nTS-00-9517715|Orbit Realty|s|b|6|20231013|S\nGJ-00-2265011|Om Tours & Travels Pvt Ltd|y|3|0|20221130|S\nKR-00-5139971|Amrit Physio Clinic Pvt Ltd|o|4|1|20240929|M\nKR-00-2360133|Sunrise Tours & Travels Pvt Ltd|y|4|e|20250616|D\nRJ-00-9918036|Saffron Sweets|w|9|8|20240821|M\nMP-00-3131021|Unity Physio Clinic Pvt Ltd|o|6|7|20230131|M\nTN-00-6445052|Shree Opticals|k|a|4|20210122|S\nMH-00-0069294|Navkar Diagnostics Pvt Ltd|a|7|d|20241209|D\nTS-00-2256107|Neelgiri Kitchens Pvt Ltd|t|b|6|20240330|S\nGJ-00-9078620|Riddhi Stays|6|3|j|20240716|S\nWB-00-6057678|Apex Diagnostics|a|d|a|20221027|S\nTS-00-1730340|Harmony Kitchens|t|b|6|20230929|M\nWB-00-6333644|Green Leaf Mobile Care|j|d|a|20210727|M\nGJ-00-3882616|Sunrise Kitchens LLP|t|3|0|20220618|S\nMH-00-9145558|Vindhya Realty Pvt Ltd|s|7|d|20240112|M\nMP-00-2126150|Lakshmi Stationers|v|6|2|20241015|M\nTS-00-7742653|Navkar Textiles|x|b|6|20211123|M\nDL-00-2804359|Zenith Polymers|p|2|5|20230929|S\nMH-00-4875174|Evergreen Sweets|w|7|g|20240419|M\nMH-00-1565508|Kaveri Kitchens LLP|t|7|i|20251010|M\nGJ-00-3955607|Krishna Electronics|b|3|j|20210711|S\nPB-00-3677194|Amrit General Store|h|8|c|20220804|M\nMH-00-3510033|Evergreen Pharma Retail|n|7|d|20241114|M\nTN-00-0810316|Vindhya & Associates|7|a|3|20231223|M\nGJ-00-8614914|Shree Stationers|v|3|j|20250829|S\nKL-00-1032051|Orbit Opticals|k|5|9|20201230|M\nMP-00-0151550|Metro & Associates Pvt Ltd|7|6|7|20220128|S\nKL-00-0839220|Om Bakers|3|5|9|20210813|M\nMH-00-7247171|Modern Polymers Pvt Ltd|p|7|i|20251224|S\nKR-00-8409425|Navkar Fitness Pvt Ltd|e|4|1|20230924|M\nRJ-00-1981586|Sunrise Diagnostics LLP|a|9|8|20211231|M\nWB-00-7023798|Sahyadri & Associates Pvt Ltd|7|d|a|20210929|M\nPB-00-4994346|Shree General Store|h|8|c|20201215|D\nMP-00-4168949|Annapurna Design Studio Pvt Ltd|1|6|2|20230712|M\nGJ-00-1068200|Apex Hardware|f|3|j|20260120|M\nGJ-00-2593856|Galaxy Bakers|3|3|j|20211007|M\nUP-00-7107181|Ganesh Kids Academy|q|c|b|20210331|S\nKL-00-6713366|Moonlight Auto Components|2|5|9|20220422|D\nDL-00-2401383|Galaxy Design Studio|1|2|5|20240531|M\nTS-00-1840033|Riddhi Fitness Pvt Ltd|e|b|6|20230530|M\nMH-00-8425649|Moonlight General Store|h|7|g|20211203|M\nKR-00-9488431|Star Stays LLP|6|4|1|20210921|M\nPB-00-1887058|Evergreen Realty LLP|s|8|c|20220421|S\nGJ-00-4033588|Ganga Diagnostics Pvt Ltd|a|3|k|20250916|M\nMP-00-9892218|Star Physio Clinic Pvt Ltd|o|6|2|20250205|M\nTN-00-6148486|Sahyadri General Store|h|a|3|20210518|M\nKR-00-1150820|Balaji Classes|8|4|e|20240101|S\nMH-00-9664533|Annapurna Stationers|v|7|g|20210607|M\nGJ-00-6150745|New Insurance Advisors|g|3|k|20250818|M\nMH-00-6916903|Trinity Kitchens Pvt Ltd|t|7|d|20210116|M\nKR-00-1768531|Krishna Electronics LLP|b|4|1|20250630|S\nDL-00-3152748|Galaxy Unisex Salon|u|2|5|20230301|M\nMH-00-2808765|Metro General Store|h|7|d|20210805|S\nMH-00-1545873|Harmony Kitchens|t|7|d|20240821|M\nPB-00-3609249|Coral Design Studio LLP|1|8|c|20201027|M\nTS-00-4799123|Lakshmi Dental Care|9|b|6|20240909|M\nMH-00-1687987|Harmony Medicals|m|7|g|20231225|M\nDL-00-8372621|Galaxy Hardware|f|2|5|20220328|M\nWB-00-5430396|Prime Pharma Retail Pvt Ltd|n|d|a|20250917|M\nKL-00-8827839|Harmony Sweets|w|5|9|20220815|S\nDL-00-6675124|Evergreen & Associates LLP|7|2|5|20201015|S\nGJ-00-6373928|Ganesh Bakers|3|3|0|20250731|S\nRJ-00-7801765|Om Legal Associates Pvt Ltd|i|9|8|20220223|M\nDL-00-4969033|City Dental Care LLP|9|2|5|20220918|M\nTS-00-6930912|Silver Oak Woodcraft|d|b|6|20231226|M\nDL-00-2483680|Zenith Woodcraft Pvt Ltd|d|2|5|20240510|M\nMH-00-8021658|Evergreen Kitchens|t|7|d|20250622|M\nTN-00-0276488|Modern Realty|s|a|4|20251120|M\nAP-00-7806053|Trinity Kids Academy|q|0|l|20240927|M\nMH-00-3644537|City Woodcraft LLP|d|7|d|20230425|S\nMP-00-4405699|Star Stays LLP|6|6|7|20220122|M\nKR-00-1320826|Classic Boutique|5|4|1|20220203|S\nKR-00-5810627|Shree Printers Pvt Ltd|r|4|1|20250707|S\nPB-00-9239083|Sai General Store|h|8|c|20240624|M\nTN-00-9990967|Vindhya Electronics|b|a|3|20250421|D\nWB-00-7745021|Prime Hardware|f|d|a|20250122|M\nMP-00-8866639|Balaji Auto Components|2|6|7|20231215|S\nTS-00-5227699|Ganga Medicals|m|b|6|20210521|M\nGJ-00-0030819|Om Boutique|5|3|k|20210514|M\nMH-00-7256076|Moonlight Electronics LLP|b|7|i|20230716|M\nBR-00-8554403|Balaji General Store|h|1|h|20210913|M\nMH-00-6531230|Metro Stays Pvt Ltd|6|7|d|20201216|S\nMH-00-8524097|Om Sweets|w|7|g|20251127|M\nTN-00-4457900|Kaveri Woodcraft LLP|d|a|3|20220211|M\nMH-00-3356782|Amrit Medicals|m|7|d|20241107|M\nMP-00-3896334|Blue Lotus Hardware|f|6|7|20250322|M\nGJ-00-5026131|Neelgiri Pharma Retail Pvt Ltd|n|3|j|20250831|M\nTS-00-1329695|Annapurna Textiles Pvt Ltd|x|b|6|20240406|M\nMH-00-4125311|Sunrise Dental Care|9|7|d|20210306|M\nRJ-00-7227710|Unity Packaging Pvt Ltd|l|9|8|20220318|S\nMH-00-1498176|Pearl Kitchens|t|7|d|20251104|D\nMH-00-5229500|Vindhya & Associates LLP|7|7|d|20230719|M\nMH-00-8377445|Sai Unisex Salon|u|7|d|20250209|S\nDL-00-7196879|Royal Hardware|f|2|5|20210921|S\nMH-00-3079899|Harmony Stationers|v|7|f|20230817|M\nTN-00-2629282|Amrit Sweets|w|a|4|20250914|S\nKR-00-1331075|City Kids Academy|q|4|1|20250510|M\nMH-00-0318118|New Fitness|e|7|d|20250622|M\nUP-00-9173131|Moonlight Boutique|5|c|b|20250406|M\nMH-00-5376728|Sunrise Foods Pvt Ltd|c|7|d|20220421|M\nTS-00-9728935|Pearl & Associates Pvt Ltd|7|b|6|20251128|D\nUP-00-0353704|Evergreen Medicals|m|c|b|20210727|M\nMP-00-5035732|Modern Textiles|x|6|7|20230408|S\nKR-00-8255822|Harmony Dental Care Pvt Ltd|9|4|e|20241103|M\nAP-00-5787226|Krishna & Associates Pvt Ltd|7|0|l|20230103|M\nDL-00-1720642|Galaxy General Store|h|2|5|20210909|M\nTS-00-9770548|Zenith General Store|h|b|6|20240731|M\nMH-00-3158659|Coral Stays|6|7|g|20210316|M\nTS-00-8751054|Vindhya Tours & Travels|y|b|6|20251123|S\nMH-00-3716279|Galaxy Design Studio Pvt Ltd|1|7|d|20210811|S\nKR-00-2299367|Harmony Opticals|k|4|e|20250215|S\nDL-00-0210318|New Fashions Pvt Ltd|0|2|5|20220816|S\nPB-00-4617560|Apex Mobile Care|j|8|c|20230728|M\nTN-00-2254742|Evergreen Fashions Pvt Ltd|0|a|3|20230302|M\nGJ-00-9004249|Annapurna Boutique|5|3|k|20230417|S\nMP-00-3987038|Trinity Bakers|3|6|7|20250210|M\nKR-00-5800155|Shree Kids Academy LLP|q|4|1|20230515|D\nAP-00-0533784|Trinity Classes|8|0|l|20210923|M\nGJ-00-5499597|Pearl Tours & Travels|y|3|j|20211114|S\nMH-00-8251105|Zenith Fitness LLP|e|7|f|20240420|M\nPB-00-0444592|Lakshmi Boutique|5|8|c|20211222|D\nMH-00-2204733|Sunrise Insurance Advisors|g|7|g|20231024|M\nMH-00-8241626|Om Kids Academy|q|7|g|20220708|S\nWB-00-1272223|New Fitness|e|d|a|20250106|M\nKR-00-9410140|Trinity Hardware|f|4|1|20240503|M\nBR-00-7768843|Riddhi Printers|r|1|h|20220727|M\nDL-00-5527618|Blue Lotus Sweets|w|2|5|20220222|M\nKL-00-6908543|Blue Lotus Mobile Care|j|5|9|20230627|M\nGJ-00-4067798|City Medicals|m|3|0|20241207|M\nTN-00-1013938|Sahyadri Hardware|f|a|3|20220905|M\nTN-00-8610236|New Stationers|v|a|4|20220412|M\nDL-00-5923086|Modern Tours & Travels|y|2|5|20240227|M\nGJ-00-8931310|Navkar Stationers|v|3|0|20240720|S\nUP-00-9940419|Ganesh Realty Pvt Ltd|s|c|b|20250117|S\nDL-00-4992009|Ganesh Stationers|v|2|5|20220824|M\nMH-00-6253436|Harmony Realty Pvt Ltd|s|7|i|20230629|M\nWB-00-9971943|Ganesh Sweets|w|d|a|20250101|M\nTN-00-9846245|Kaveri Unisex Salon|u|a|3|20220724|M\nDL-00-8117936|Apex Diagnostics|a|2|5|20250708|S\nKR-00-0076443|Orbit Medicals|m|4|e|20250303|M\nTS-00-1139484|Galaxy Auto Components LLP|2|b|6|20211030|D\nDL-00-7765382|Evergreen General Store|h|2|5|20241109|M\nGJ-00-0392005|Metro Auto Components Pvt Ltd|2|3|0|20230705|S\nKL-00-6851367|Silver Oak Bakers|3|5|9|20251207|D\nMH-00-2385292|Prime Physio Clinic|o|7|d|20240501|D\nKR-00-1865459|Pearl Kids Academy LLP|q|4|1|20230213|M\nMH-00-2271795|Navkar Medicals|m|7|g|20210319|D\nTN-00-3233659|Star Classes|8|a|3|20221109|M\nMH-00-7996114|Evergreen Insurance Advisors|g|7|d|20230629|M\nMH-00-6754009|Orbit Tours & Travels LLP|y|7|d|20220120|M\nUP-00-5215879|Annapurna Medicals|m|c|b|20250717|M\nDL-00-3531495|Orbit Stays|6|2|5|20230719|D\nMH-00-3057133|Kaveri Mobile Care|j|7|g|20251029|S\nMH-00-8850449|Krishna Legal Associates LLP|i|7|g|20210312|S\nMH-00-0433924|Shree Boutique|5|7|i|20210614|M\nMH-00-7133434|Orbit Classes|8|7|g|20250703|M\nMP-00-8975163|Pearl Electronics|b|6|7|20210709|M\nTN-00-1069419|Classic Dental Care LLP|9|a|3|20220703|M\nGJ-00-1405826|Unity Realty Pvt Ltd|s|3|k|20201202|S\nGJ-00-0387661|Evergreen Packaging Pvt Ltd|l|3|0|20250804|S\nRJ-00-2472685|Modern & Associates|7|9|8|20241015|S\nBR-00-3747263|Coral Sweets|w|1|h|20260110|S\nMH-00-4175595|Star Legal Associates LLP|i|7|d|20250319|D\nMH-00-1438937|Riddhi Realty LLP|s|7|g|20220630|M\nKL-00-2373887|Evergreen Stationers|v|5|9|20250201|M\nWB-00-1234898|Trinity Stationers|v|d|a|20240318|D\nMP-00-5677122|Metro Stationers|v|6|2|20230417|M\nPB-00-0413322|Modern Tours & Travels Pvt Ltd|y|8|c|20241026|S\nMH-00-4854309|Ganesh Boutique|5|7|d|20220115|M\nUP-00-7951032|Shree Kids Academy LLP|q|c|b|20211109|M\nTS-00-6689843|Star Insurance Advisors|g|b|6|20231017|M\nMH-00-8400632|Coral Pharma Retail|n|7|g|20231023|M\nKR-00-1478647|Orbit Insurance Advisors LLP|g|4|e|20210603|M\nRJ-00-9212256|Kaveri & Associates LLP|7|9|8|20230928|M\nMH-00-2827104|Amrit Classes Pvt Ltd|8|7|f|20230105|M\nDL-00-5757198|Balaji Dental Care|9|2|5|20211010|M\nTS-00-8542181|Kaveri Insurance Advisors Pvt Ltd|g|b|6|20211103|S\nMH-00-7842626|Pearl Kitchens Pvt Ltd|t|7|g|20240504|S\nAP-00-7837480|Trinity Realty LLP|s|0|l|20251129|M\nPB-00-5295830|Riddhi Kitchens Pvt Ltd|t|8|c|20210611|S\nKL-00-5530593|Moonlight Dental Care Pvt Ltd|9|5|9|20250617|M\nMH-00-6644925|Ganga Opticals|k|7|d|20220428|M\nMH-00-3231438|Saffron Sweets|w|7|d|20220330|M\nKR-00-3877170|Orbit Dental Care LLP|9|4|1|20220921|M\nGJ-00-3142195|Sahyadri Sweets|w|3|j|20251016|M\nMH-00-8491715|Unity General Store|h|7|i|20240128|M\nMH-00-7991725|Annapurna & Associates Pvt Ltd|7|7|d|20230227|S\nMH-00-3853710|Sahyadri Stays LLP|6|7|g|20240702|M\nKL-00-6348937|Om Fitness|e|5|9|20230828|M\nTN-00-2803300|Om Pharma Retail|n|a|3|20220104|M\nPB-00-2572966|Vindhya Design Studio|1|8|c|20201223|M\nDL-00-7195169|Navkar Design Studio|1|2|5|20210919|S\nMH-00-5634190|Green Leaf Medicals|m|7|i|20220321|S\nPB-00-4617969|Saffron Unisex Salon|u|8|c|20210614|M\nTN-00-2355464|Modern Pharma Retail|n|a|4|20240121|M\nRJ-00-3928146|Galaxy Bakers|3|9|8|20220427|M\nMH-00-7534464|City Unisex Salon|u|7|d|20230216|M\nPB-00-7181016|Coral Kids Academy LLP|q|8|c|20230207|M\nMH-00-8749211|Saffron Polymers Pvt Ltd|p|7|g|20250929|S\nKR-00-7734778|Amrit Bake House Pvt Ltd|4|4|1|20250212|M\nDL-00-6403062|Prime Bake House LLP|4|2|5|20250127|M\nRJ-00-0922725|Silver Oak Pharma Retail|n|9|8|20231221|M\nKR-00-9757189|Neelgiri Classes|8|4|1|20220830|M\nPB-00-8080170|Vindhya Classes LLP|8|8|c|20201227|S\nWB-00-0338770|Classic Classes LLP|8|d|a|20230627|M\nTS-00-8421787|Apex Opticals|k|b|6|20230626|S\nAP-00-0115334|Royal Stationers|v|0|l|20250820|M\nPB-00-0917941|Sahyadri Stationers|v|8|c|20210924|M\nTN-00-0297393|Moonlight Sweets|w|a|4|20210726|S\nTN-00-7812217|Navkar Stationers|v|a|4|20220425|M\nGJ-00-7295190|Sunrise Stationers|v|3|0|20240613|M\nAP-00-7509255|Classic Unisex Salon|u|0|l|20220214|M\nPB-00-0886544|New & Associates|7|8|c|20220616|M\nRJ-00-5489670|Royal & Associates|7|9|8|20230208|M\nMH-00-8692920|Modern General Store|h|7|d|20230723|M\nMH-00-4366529|Blue Lotus Fashions Pvt Ltd|0|7|f|20250820|S\nTN-00-0040748|Sunrise Sweets|w|a|4|20221102|S\nGJ-00-5805744|Blue Lotus Electronics|b|3|k|20230221|M\nUP-00-2363222|Vindhya Hardware|f|c|b|20221014|M\nTS-00-2933606|Saffron Design Studio|1|b|6|20231116|M\nUP-00-6501863|Harmony Pharma Retail LLP|n|c|b|20230927|M\nKR-00-4031127|Sai Bakers|3|4|1|20231212|M\nTN-00-2181786|Krishna Legal Associates Pvt Ltd|i|a|3|20221110|M\nTN-00-5733195|Royal Medicals|m|a|4|20230516|M\nKR-00-5519818|Sahyadri Fashions|0|4|e|20250816|M\nRJ-00-9723809|Ganesh Opticals|k|9|8|20230826|M\nDL-00-6612907|Amrit Auto Components|2|2|5|20230812|S\nKL-00-9908422|Lakshmi Stays|6|5|9|20211011|M\nKR-00-2151986|Prime Classes LLP|8|4|1|20230503|M\nGJ-00-9579632|Modern Bakers|3|3|0|20250601|M\nDL-00-6215384|Amrit Boutique|5|2|5|20201024|M\nWB-00-0079634|Zenith Foods Pvt Ltd|c|d|a|20260129|M\nKR-00-7231501|Lakshmi Stationers|v|4|1|20250328|M\nMH-00-9011132|Neelgiri Bakers|3|7|i|20210118|M\nKR-00-8901400|Blue Lotus Opticals|k|4|1|20221220|S\nMH-00-3053508|Ganesh Sweets|w|7|i|20250217|D\nTN-00-6618638|Sunrise Design Studio|1|a|4|20240804|M\nGJ-00-1532103|Blue Lotus Sweets|w|3|j|20221127|S\nWB-00-8691061|Coral Design Studio|1|d|a|20210913|M\nTN-00-5008276|Classic Mobile Care|j|a|3|20220417|M\nGJ-00-8779594|Navkar Fitness|e|3|k|20231106|M\nWB-00-8573311|Coral Classes Pvt Ltd|8|d|a|20220505|M\nKL-00-3252696|Galaxy Kids Academy Pvt Ltd|q|5|9|20210222|M\nKR-00-3888937|Classic Stays|6|4|1|20241201|S\nTN-00-5622010|Galaxy Boutique|5|a|4|20220316|M\nWB-00-4980614|Star Bakers|3|d|a|20250805|S\nMP-00-5252909|Amrit Sweets|w|6|2|20220819|D\nPB-00-1891884|Modern Bakers|3|8|c|20240309|S\nUP-00-8299066|Prime Unisex Salon|u|c|b|20241001|D\nTS-00-8042434|Trinity Bake House LLP|4|b|6|20231228|M\nTS-00-4745973|City Classes Pvt Ltd|8|b|6|20210220|M\nMP-00-3037817|Prime Polymers|p|6|7|20230305|D\nUP-00-1549440|Sunrise Classes|8|c|b|20210112|M\nKR-00-1972832|Coral Hardware|f|4|1|20250508|M\nMH-00-6713481|Metro Dental Care LLP|9|7|i|20240701|M\nDL-00-1880682|Sahyadri Hardware|f|2|5|20250716|D\nGJ-00-5648569|Riddhi General Store|h|3|j|20240724|M\nMH-00-6011855|Unity Classes LLP|8|7|d|20220815|M\nGJ-00-1211037|Coral Realty Pvt Ltd|s|3|j|20230801|M\nDL-00-7042931|Balaji Legal Associates LLP|i|2|5|20201027|S\nTN-00-8357254|Pearl Kitchens|t|a|3|20210228|M\nTN-00-4909691|Om Mobile Care|j|a|3|20211013|M\nMP-00-6465771|Coral Stationers|v|6|7|20230902|D\nTS-00-4496007|Royal Sweets|w|b|6|20230821|M\nTS-00-9136849|Blue Lotus Realty|s|b|6|20210730|M\nGJ-00-4316295|Star Sweets|w|3|0|20250228|D\nTN-00-0443034|Moonlight Design Studio|1|a|3|20240927|M\nTS-00-8904612|Annapurna Hardware|f|b|6|20221018|M\nMH-00-0255399|Royal General Store|h|7|d|20241002|M\nKR-00-9712317|Navkar Physio Clinic|o|4|e|20230414|M\nGJ-00-0502213|Coral Bakers|3|3|0|20240626|M\nGJ-00-9842651|Evergreen Bake House LLP|4|3|j|20241228|M\nGJ-00-9245570|Ganga Bakers|3|3|k|20230630|S\nMP-00-4704560|Blue Lotus Opticals|k|6|7|20230621|M\nKL-00-0391792|Ganga Boutique|5|5|9|20251003|D\nMH-00-3997078|Neelgiri Stationers|v|7|f|20210311|M\nWB-00-5190276|Annapurna Fashions|0|d|a|20251002|M\nKR-00-3043909|Krishna Kitchens Pvt Ltd|t|4|1|20240330|M\nMP-00-9893182|Harmony Fitness|e|6|7|20230302|M\nTS-00-3855603|Galaxy Physio Clinic|o|b|6|20230829|M\nMH-00-9128996|Riddhi Bake House|4|7|f|20201010|M\nMH-00-6870365|Amrit Legal Associates LLP|i|7|d|20240811|S\nTN-00-5157120|Ganesh Design Studio LLP|1|a|4|20250422|M\nUP-00-1194473|Sahyadri Stays LLP|6|c|b|20220401|S\nKL-00-5380354|Modern Medicals|m|5|9|20220512|D\nKR-00-6057068|Star Mobile Care|j|4|1|20231018|S\nMH-00-3092531|Pearl Kids Academy LLP|q|7|i|20230718|S\nUP-00-4805151|Apex Hardware|f|c|b|20211015|M\nMH-00-9534070|Evergreen Fitness LLP|e|7|d|20210201|M\nDL-00-0930154|Harmony Pharma Retail LLP|n|2|5|20230315|M\nDL-00-7323025|Orbit Diagnostics Pvt Ltd|a|2|5|20251013|M\nKR-00-2337987|Unity Boutique|5|4|1|20230615|M\nTN-00-9235833|Annapurna Kitchens|t|a|3|20220506|M\nMP-00-3754061|Amrit & Associates Pvt Ltd|7|6|2|20230519|M\nGJ-00-7940102|Royal General Store|h|3|k|20241228|D\nDL-00-3952049|New Dental Care Pvt Ltd|9|2|5|20231101|M\nTS-00-5628021|Coral Realty LLP|s|b|6|20250626|M\nGJ-00-8901032|Saffron Insurance Advisors|g|3|0|20250806|M\nDL-00-8280577|Navkar Opticals|k|2|5|20210601|M\nGJ-00-6319359|Saffron Stationers|v|3|j|20241014|M\nTS-00-2132658|Ganga Bake House LLP|4|b|6|20250308|M\nKL-00-7831223|Green Leaf & Associates Pvt Ltd|7|5|9|20210307|D\nKR-00-3002091|Neelgiri Woodcraft Pvt Ltd|d|4|1|20220212|D\nUP-00-6597154|Neelgiri & Associates|7|c|b|20230405|M\nKR-00-0828018|Annapurna Kitchens Pvt Ltd|t|4|1|20251109|M\nTS-00-1818795|Vindhya Realty LLP|s|b|6|20241028|S\nMH-00-1645823|Pearl Opticals|k|7|i|20221113|M\nGJ-00-3175405|Kaveri Fitness LLP|e|3|k|20221108|M\nDL-00-3349567|Om & Associates|7|2|5|20210527|M\nDL-00-6080307|Apex Realty|s|2|5|20240502|M\nKL-00-8910656|City Medicals|m|5|9|20220102|M\nWB-00-8576801|Ganga Woodcraft LLP|d|d|a|20240604|S\nWB-00-0799230|Royal Bakers|3|d|a|20240922|M\nDL-00-0225664|Trinity Sweets|w|2|5|20220720|S\nKL-00-4210258|City Bakers|3|5|9|20240514|M\nKL-00-7861363|Pearl Polymers|p|5|9|20240723|M\nUP-00-0450364|Neelgiri Medicals|m|c|b|20220723|S\nAP-00-9732272|Saffron Bakers|3|0|l|20210629|M\nTN-00-0683730|Apex General Store|h|a|4|20251101|M\nAP-00-2771201|Riddhi Hardware|f|0|l|20220824|M\nTN-00-3886880|Vindhya Bakers|3|a|4|20211227|S\nMH-00-5292794|Pearl Printers Pvt Ltd|r|7|d|20240613|S\nMH-00-5964006|Blue Lotus & Associates|7|7|g|20240722|S\nPB-00-5058816|Orbit Stationers|v|8|c|20240121|M\nMH-00-1629436|Green Leaf Classes|8|7|f|20211122|S\nMH-00-5221883|Saffron & Associates|7|7|f|20221225|M\nTN-00-4158862|Evergreen Boutique|5|a|3|20240128|M\nMP-00-0802477|Harmony Packaging Pvt Ltd|l|6|2|20250906|M\nKL-00-0176176|City Fashions|0|5|9|20240730|M\nTN-00-7994210|Pearl Hardware|f|a|4|20250716|S\nKR-00-6148961|Star Kids Academy|q|4|1|20250402|M\nTN-00-2421668|Orbit Mobile Care|j|a|4|20230728|S\nTN-00-3234548|Coral Design Studio|1|a|3|20240828|S\nMP-00-8671985|Classic Hardware|f|6|2|20240816|D\nKR-00-7535134|Kaveri Packaging|l|4|e|20231115|D\nMH-00-7052182|Zenith Bake House|4|7|d|20210225|S\nRJ-00-7895236|Modern Bake House Pvt Ltd|4|9|8|20210110|M\nMP-00-5627682|Amrit Hardware|f|6|7|20220219|M\nMP-00-2339946|Trinity Sweets|w|6|2|20221109|M\nMH-00-2897059|Riddhi Physio Clinic Pvt Ltd|o|7|d|20210427|S\nMH-00-6623073|Unity Bake House|4|7|d|20250515|M\nGJ-00-9303231|Lakshmi Opticals|k|3|j|20230413|M\nBR-00-3499276|Trinity Fitness|e|1|h|20250201|M\nMH-00-8312484|Royal Kids Academy|q|7|i|20220220|M\nMH-00-0866868|Zenith Design Studio LLP|1|7|i|20240629|M\nMH-00-4801436|Balaji Mobile Care|j|7|d|20240113|M\nMH-00-1482472|New & Associates LLP|7|7|d|20210105|M\nPB-00-2989489|Riddhi Printers LLP|r|8|c|20220502|M\nDL-00-0401018|Orbit Opticals|k|2|5|20240903|M\nTN-00-9713295|Unity General Store|h|a|3|20260103|M\nAP-00-3598038|New Stationers|v|0|l|20240314|M\nDL-00-1753034|Harmony Legal Associates LLP|i|2|5|20250211|S\nDL-00-4259792|Blue Lotus Opticals|k|2|5|20201214|M\nMH-00-0356967|Coral Opticals|k|7|i|20240502|M\nDL-00-3423140|Navkar Sweets|w|2|5|20210629|S\nMH-00-6274274|Shree Mobile Care|j|7|g|20230621|D\nTN-00-0060656|Unity Legal Associates|i|a|3|20211121|D\nGJ-00-6402482|Sai Kitchens|t|3|k|20210815|M\nKR-00-0241918|New Boutique|5|4|1|20221107|M\nDL-00-5269443|Metro Insurance Advisors|g|2|5|20240703|S\nPB-00-3375010|Apex & Associates|7|8|c|20230423|M\nKL-00-3980867|Annapurna Bakers|3|5|9|20230613|M\nMH-00-0229053|Navkar Woodcraft Pvt Ltd|d|7|d|20210203|D\nKR-00-2824508|Modern Stays|6|4|1|20250105|S\nKL-00-3930273|Pearl Foods|c|5|9|20240716|M\nTS-00-5175383|Galaxy & Associates LLP|7|b|6|20250922|D\nKR-00-6331497|Saffron Stationers|v|4|1|20250904|S\nMH-00-9635042|Harmony Diagnostics|a|7|d|20240220|M\nTN-00-1289535|Coral Classes LLP|8|a|3|20240129|M\nRJ-00-3131065|Zenith Printers Pvt Ltd|r|9|8|20210617|S\nTS-00-5013833|Balaji Opticals|k|b|6|20240522|S\nGJ-00-9733144|City Stays|6|3|j|20240126|M\nBR-00-4425006|Sunrise Design Studio Pvt Ltd|1|1|h|20220101|S\nMH-00-7158469|Metro Stationers|v|7|i|20250226|M\nGJ-00-2052875|Metro Medicals|m|3|0|20250110|M\nMH-00-0033111|Om Opticals|k|7|g|20231006|S\nAP-00-5993759|Apex Physio Clinic Pvt Ltd|o|0|l|20210520|M\nUP-00-7493650|Silver Oak Mobile Care|j|c|b|20211210|S\nMH-00-1532431|Classic Sweets|w|7|d|20230520|S\nGJ-00-1268764|Sunrise Textiles Pvt Ltd|x|3|j|20240106|S\nKR-00-9835722|Krishna Tours & Travels|y|4|1|20210927|D\nMH-00-8052080|Balaji Hardware|f|7|f|20250114|M\nUP-00-3649889|Coral Stationers|v|c|b|20231119|M\nDL-00-3117616|Coral Opticals|k|2|5|20211207|M\nMH-00-1353472|Sai Kitchens|t|7|d|20231016|M\nMP-00-4835225|Amrit Realty Pvt Ltd|s|6|2|20221107|S\nPB-00-6052849|Ganga Bakers|3|8|c|20250307|M\nKR-00-4180300|Green Leaf Classes|8|4|1|20211021|M\nDL-00-9916403|Kaveri Auto Components|2|2|5|20240102|S\nTN-00-8469110|Royal Opticals|k|a|3|20260101|M\nPB-00-6480461|Classic Textiles LLP|x|8|c|20210529|D\nMH-00-5718808|Blue Lotus Fashions LLP|0|7|f|20201227|M\nTS-00-3577772|Neelgiri Unisex Salon|u|b|6|20230408|M\nDL-00-9378936|Zenith & Associates|7|2|5|20220728|M\nMH-00-0095713|Om & Associates LLP|7|7|f|20240528|S\nTN-00-8029203|Coral Fitness|e|a|3|20220913|M\nKR-00-4033044|Navkar Boutique|5|4|1|20260125|D\nMH-00-9830175|Trinity General Store|h|7|i|20231207|S\nMH-00-5335896|New Physio Clinic|o|7|i|20240930|S\nTS-00-8678646|Neelgiri Diagnostics|a|b|6|20220124|S\nBR-00-8642702|Krishna Kitchens Pvt Ltd|t|1|h|20221122|D\nBR-00-0168416|Shree Opticals|k|1|h|20230729|D\nTN-00-8367366|Saffron Boutique|5|a|4|20240513|M\nGJ-00-2087309|Star Fashions LLP|0|3|j|20260122|M\nTN-00-7770093|Neelgiri Kitchens|t|a|3|20210126|M\nDL-00-7071732|Silver Oak Tours & Travels|y|2|5|20250109|S\nMH-00-6845556|Sunrise Design Studio LLP|1|7|f|20221027|M\nKR-00-4471382|Moonlight Fitness Pvt Ltd|e|4|1|20230622|M\nGJ-00-2449655|Amrit Design Studio|1|3|k|20250714|M\nTN-00-6597086|Om Mobile Care|j|a|4|20230128|S\nMH-00-1241656|City Stationers|v|7|d|20231123|D\nTS-00-4226514|Trinity Foods|c|b|6|20251210|S\nMP-00-9418408|Modern Mobile Care|j|6|7|20231004|M\nMH-00-8061921|Harmony Boutique|5|7|i|20250403|M\nRJ-00-6361306|Saffron Stationers|v|9|8|20221104|M\nMH-00-5173697|Unity Bakers|3|7|d|20210301|S\nMP-00-6333072|Shree Bakers|3|6|2|20240527|M\nRJ-00-1011300|Modern General Store|h|9|8|20251210|M\nDL-00-3907909|Evergreen Electronics|b|2|5|20210420|M\nTS-00-7535205|Harmony Medicals|m|b|6|20211016|S\nAP-00-2291528|Evergreen & Associates|7|0|l|20210622|M\nBR-00-2603022|Shree Design Studio Pvt Ltd|1|1|h|20241227|M\nMH-00-9402584|New Kids Academy Pvt Ltd|q|7|i|20210208|M\nGJ-00-9484533|Pearl Tours & Travels|y|3|k|20230920|M\nTN-00-8787308|Moonlight Pharma Retail|n|a|4|20240103|M\nDL-00-7670252|Navkar Unisex Salon|u|2|5|20240704|S\nTN-00-3994257|Sai Electronics|b|a|3|20240606|S\nMH-00-0421895|City Unisex Salon|u|7|i|20221008|M\nDL-00-2266595|Unity General Store|h|2|5|20220802|S\nMH-00-4629306|Evergreen Electronics|b|7|i|20230226|M\nTN-00-4527220|Classic Bake House Pvt Ltd|4|a|3|20230403|M\nGJ-00-3325915|Harmony Classes LLP|8|3|j|20201031|M\nTN-00-2887664|New Bake House|4|a|4|20210504|M\nMH-00-1686381|Om Stationers|v|7|d|20230731|M\nMH-00-9819061|Orbit Diagnostics LLP|a|7|d|20220806|M\nBR-00-6943701|Classic Fitness|e|1|h|20210816|M\nBR-00-3290763|Green Leaf Tours & Travels Pvt Ltd|y|1|h|20231110|S\nUP-00-8581610|Lakshmi Design Studio LLP|1|c|b|20220314|S\nMH-00-7629618|Royal Unisex Salon|u|7|g|20250521|S\nDL-00-3495153|New Bake House Pvt Ltd|4|2|5|20210106|M\nKR-00-0818958|Balaji Realty Pvt Ltd|s|4|1|20211104|M\nMH-00-4205808|Harmony Mobile Care|j|7|d|20201209|M\nMH-00-6948936|New Bakers|3|7|f|20220201|M\nDL-00-0083655|Shree & Associates|7|2|5|20240414|M\nGJ-00-3504190|Zenith Pharma Retail|n|3|j|20230515|M\nMP-00-0297447|Saffron Design Studio|1|6|2|20210823|M\nGJ-00-7286504|Om Opticals|k|3|0|20250620|M\nDL-00-6363369|Zenith Woodcraft|d|2|5|20240229|D\nTS-00-3815339|Zenith Tours & Travels Pvt Ltd|y|b|6|20240611|M\nKL-00-0495563|Zenith Fitness Pvt Ltd|e|5|9|20230521|M\nWB-00-9898516|Amrit Tours & Travels LLP|y|d|a|20230127|M\nGJ-00-6210544|Riddhi Dental Care Pvt Ltd|9|3|k|20250501|M\nMH-00-8213325|Silver Oak Bakers|3|7|f|20220721|S\nPB-00-3263062|Krishna Sweets|w|8|c|20230819|M\nKR-00-4378473|Annapurna Insurance Advisors Pvt Ltd|g|4|1|20250921|S\nGJ-00-7057802|Ganesh Diagnostics|a|3|0|20210711|M\nMH-00-9375492|Orbit Physio Clinic LLP|o|7|g|20220324|M\nMH-00-5564618|Classic Physio Clinic|o|7|d|20241020|M\nDL-00-6903564|Shree Sweets|w|2|5|20220531|M\nKL-00-3253499|Balaji Unisex Salon|u|5|9|20211212|M\nMP-00-0840793|Blue Lotus Polymers|p|6|2|20230118|S\nTS-00-4272962|Sahyadri Electronics|b|b|6|20220517|D\nRJ-00-8439707|Moonlight Opticals|k|9|8|20210201|M\nMH-00-4035052|Apex Design Studio LLP|1|7|i|20240316|M\nWB-00-3554037|Sunrise Bake House Pvt Ltd|4|d|a|20210507|M\nMH-00-7701854|Zenith Unisex Salon|u|7|d|20220323|M\nKR-00-4600714|Modern Polymers|p|4|1|20240518|S\nMH-00-8219569|Annapurna Stays|6|7|g|20240227|M\nKR-00-0986445|Royal Sweets|w|4|1|20220815|M\nMH-00-2103202|Shree Design Studio Pvt Ltd|1|7|i|20240719|S\nMH-00-2018950|Modern Auto Components LLP|2|7|i|20221219|D\nGJ-00-4889775|Saffron Bakers|3|3|k|20230726|M\nKL-00-4282697|New Mobile Care|j|5|9|20230725|M\nGJ-00-0145205|Kaveri Diagnostics|a|3|0|20211113|M\nTN-00-9999476|Apex Bakers|3|a|4|20241129|M\nMH-00-3309207|Silver Oak Bakers|3|7|d|20220508|S\nDL-00-1915579|Royal Bakers|3|2|5|20250126|M\nWB-00-7597298|Pearl Electronics Pvt Ltd|b|d|a|20231024|M\nRJ-00-9242995|Kaveri Stationers|v|9|8|20220528|S\nTS-00-7410530|Evergreen Legal Associates|i|b|6|20250404|M\nDL-00-3743217|Classic Auto Components Pvt Ltd|2|2|5|20220403|S\nPB-00-6035354|Neelgiri Boutique|5|8|c|20251108|S\nTS-00-0273563|New Fitness|e|b|6|20230312|M\nMH-00-5738799|Classic Electronics|b|7|d|20211020|S\nKR-00-7824280|Moonlight Printers|r|4|1|20260112|S\nKR-00-1515135|Galaxy Diagnostics LLP|a|4|1|20230918|S\nMH-00-3555541|Annapurna Medicals|m|7|i|20240422|M\nPB-00-5927712|Ganga Unisex Salon|u|8|c|20220717|M\nDL-00-4011619|Om Bakers|3|2|5|20240527|M\nKR-00-1115504|Amrit Stationers|v|4|1|20230623|M\nMP-00-0838608|Kaveri Tours & Travels Pvt Ltd|y|6|7|20231218|M\nAP-00-2062603|Sai Sweets|w|0|l|20240810|M\nTN-00-8059479|Pearl Stays|6|a|4|20210422|M\nDL-00-7683105|Vindhya Insurance Advisors|g|2|5|20221105|S\nGJ-00-9785401|City Unisex Salon|u|3|k|20220605|D\nAP-00-6795430|Harmony Stays LLP|6|0|l|20231013|M\nAP-00-0590568|Harmony Bakers|3|0|l|20241111|M\nDL-00-4170651|Lakshmi Medicals|m|2|5|20210501|M\nWB-00-0882880|Blue Lotus General Store|h|d|a|20250630|M\nUP-00-9798586|Sunrise Polymers|p|c|b|20251215|S\nGJ-00-5795299|Sahyadri Kids Academy Pvt Ltd|q|3|k|20210508|M\nDL-00-5358014|Trinity Unisex Salon|u|2|5|20240302|D\nDL-00-7818229|Om Stationers|v|2|5|20240406|M\nWB-00-1456158|Unity & Associates|7|d|a|20230826|M\nTN-00-0777362|Riddhi Sweets|w|a|4|20221106|M\nMH-00-5820858|Saffron Stationers|v|7|f|20210606|M\nTN-00-1450702|Harmony Physio Clinic Pvt Ltd|o|a|3|20220308|M\nWB-00-5085199|Coral Classes|8|d|a|20250610|M\nTN-00-1375219|Saffron Electronics LLP|b|a|3|20220816|S\nKR-00-2835530|Silver Oak Fashions LLP|0|4|1|20220426|M\nKL-00-7286231|Zenith Insurance Advisors Pvt Ltd|g|5|9|20250925|M\nDL-00-7564965|Shree Physio Clinic|o|2|5|20210723|M\nKL-00-2607036|Ganga Auto Components|2|5|9|20250615|S\nWB-00-2448220|Om Classes LLP|8|d|a|20230924|M\nPB-00-5736806|Annapurna Medicals|m|8|c|20201202|M\nMP-00-4820600|Sunrise Electronics|b|6|7|20251004|M\nTN-00-3101325|Harmony Bakers|3|a|3|20230509|M\nTN-00-0057245|Coral Medicals|m|a|3|20220720|S\nKR-00-6632700|Saffron Sweets|w|4|1|20250603|M\nTN-00-7860315|Om Pharma Retail|n|a|4|20230806|S\nAP-00-0355645|Classic Polymers|p|0|l|20211130|S\nKR-00-6113404|Zenith Physio Clinic Pvt Ltd|o|4|1|20250413|M\nMH-00-9713966|Neelgiri Sweets|w|7|i|20220410|M\nWB-00-9560106|Modern Kids Academy|q|d|a|20240214|M\nGJ-00-2319794|Amrit Legal Associates|i|3|k|20220425|M\nDL-00-7129801|Moonlight Foods|c|2|5|20210521|S\nAP-00-3946872|Saffron General Store|h|0|l|20220422|S\nWB-00-4568733|Shree Printers|r|d|a|20240823|S\nGJ-00-5803418|Harmony Bakers|3|3|k|20220221|S\nUP-00-8889864|Modern Tours & Travels Pvt Ltd|y|c|b|20250813|D\nKL-00-4337384|Balaji Electronics|b|5|9|20251028|S\nMH-00-0232494|Balaji Insurance Advisors|g|7|i|20240316|M\nUP-00-4179462|Royal Fashions LLP|0|c|b|20240417|S\nDL-00-0449265|Green Leaf Classes|8|2|5|20220521|M\nKR-00-7852685|Kaveri Realty Pvt Ltd|s|4|1|20230101|D\nGJ-00-7869437|Annapurna Bakers|3|3|k|20231101|M\nWB-00-6759045|Amrit Auto Components|2|d|a|20230322|M\nGJ-00-5662092|Pearl Kitchens LLP|t|3|k|20251127|M\nMH-00-9915981|Krishna Unisex Salon|u|7|g|20240526|M\nTN-00-3406506|New Realty Pvt Ltd|s|a|3|20210216|M\nBR-00-4959277|Silver Oak Fitness|e|1|h|20210728|M\nMP-00-1744403|Orbit Packaging LLP|l|6|2|20241225|S\nWB-00-2469196|Orbit Opticals|k|d|a|20210416|M\nAP-00-6284570|Prime Unisex Salon|u|0|l|20210716|M\nKR-00-9606024|Om Kids Academy|q|4|e|20210107|S\nWB-00-8884078|Sunrise Stays|6|d|a|20230725|S\nTS-00-1771483|Silver Oak Legal Associates|i|b|6|20251123|D\nWB-00-1926131|Galaxy Fitness Pvt Ltd|e|d|a|20220114|M\nTN-00-7636413|Balaji Packaging Pvt Ltd|l|a|3|20220111|D\nUP-00-8257514|Classic Mobile Care|j|c|b|20201027|S\nTS-00-0172090|Krishna Legal Associates LLP|i|b|6|20201015|S\nTN-00-1316781|Moonlight Opticals|k|a|3|20250215|M\nBR-00-4661298|Ganga Dental Care Pvt Ltd|9|1|h|20220708|M\nWB-00-9196845|Galaxy & Associates|7|d|a|20230423|S\nTS-00-4587720|Sahyadri Realty|s|b|6|20241231|D\nBR-00-8833267|Pearl Fashions Pvt Ltd|0|1|h|20250129|M\nTS-00-3932108|Moonlight Medicals|m|b|6|20230814|M\nDL-00-2054050|Krishna Mobile Care|j|2|5|20240705|M\nMH-00-9584340|Navkar Stays|6|7|d|20250820|S\nRJ-00-1129696|Pearl General Store|h|9|8|20240220|M\nKR-00-3394180|Royal & Associates|7|4|1|20240906|S\nMH-00-5661941|Metro Insurance Advisors Pvt Ltd|g|7|g|20220716|M\nTS-00-3322503|Trinity Kids Academy|q|b|6|20231127|M\nKR-00-5004179|Classic Medicals|m|4|1|20201121|M\nUP-00-4433034|Green Leaf Electronics|b|c|b|20220620|S\nKR-00-5363962|Vindhya Physio Clinic|o|4|e|20260128|M\nKR-00-4271114|Moonlight General Store|h|4|e|20240202|M\nGJ-00-6736142|Sai Bakers|3|3|j|20250127|M\nTN-00-7931968|Modern Bakers|3|a|3|20251129|M\nTN-00-3024465|Saffron Electronics Pvt Ltd|b|a|3|20240426|M\nTN-00-8709165|New Legal Associates|i|a|4|20220529|S\nGJ-00-6394058|Blue Lotus Legal Associates|i|3|0|20250824|M\nKR-00-5559582|Balaji Stays|6|4|1|20240323|D\nGJ-00-5134665|Amrit Bakers|3|3|j|20211028|S\nMH-00-9374581|Kaveri Sweets|w|7|d|20220504|M\nKL-00-7680735|Riddhi Classes Pvt Ltd|8|5|9|20240127|S\nMP-00-6927322|Green Leaf Fitness|e|6|7|20210723|M\nRJ-00-6580348|Classic Electronics|b|9|8|20210312|S\nMH-00-4633272|Amrit Stays|6|7|f|20231205|M\nMP-00-2280603|Metro Electronics Pvt Ltd|b|6|2|20231123|M\nUP-00-1435864|Neelgiri Bakers|3|c|b|20220319|M\nMH-00-1517142|City & Associates|7|7|d|20240923|M\nBR-00-7338728|Lakshmi Mobile Care|j|1|h|20210721|M\nMH-00-9647536|Ganga Foods LLP|c|7|g|20220731|M\nUP-00-0695466|Galaxy Mobile Care|j|c|b|20250722|M\nMH-00-7320223|Sai Woodcraft LLP|d|7|i|20211216|S\nWB-00-6767393|Modern Design Studio|1|d|a|20210603|S\nGJ-00-3492987|Metro Bakers|3|3|k|20220805|S\nGJ-00-9298508|Royal Unisex Salon|u|3|j|20231206|M\nKR-00-0449380|Green Leaf Mobile Care|j|4|1|20250125|M\nMH-00-3711738|Krishna Packaging|l|7|i|20221028|S\nGJ-00-8642776|Blue Lotus Pharma Retail|n|3|k|20241122|M\nKR-00-1326187|Sunrise Fashions|0|4|e|20210210|M\nAP-00-6199907|Royal Fitness|e|0|l|20251116|M\nTN-00-7548683|Green Leaf Pharma Retail|n|a|4|20220127|M\nTN-00-2216259|Metro Hardware|f|a|4|20240312|M\nKR-00-2020470|Neelgiri Kitchens|t|4|1|20240212|M\nTS-00-2775656|Modern Design Studio Pvt Ltd|1|b|6|20251019|M\nGJ-00-7768292|Amrit Diagnostics Pvt Ltd|a|3|0|20250820|S\nKR-00-7271389|Star Bakers|3|4|1|20251202|S\nMH-00-7272864|Trinity Insurance Advisors LLP|g|7|g|20240308|M\nMH-00-1527603|Zenith Stationers|v|7|d|20210630|M\nUP-00-2605501|Saffron & Associates|7|c|b|20220708|M\nUP-00-8508043|Zenith Stays LLP|6|c|b|20220810|M\nTS-00-3294853|Orbit Classes Pvt Ltd|8|b|6|20220101|D\nMH-00-2669934|Royal Diagnostics|a|7|f|20210801|M\nKR-00-8793757|Sunrise General Store|h|4|e|20250128|M\nTN-00-6359000|Silver Oak Insurance Advisors|g|a|3|20240323|M\nDL-00-6623592|Silver Oak Opticals|k|2|5|20211002|M\nMH-00-8853702|Royal Design Studio LLP|1|7|d|20241023|M\nUP-00-8842454|Harmony Medicals|m|c|b|20230312|M\nAP-00-0233169|Unity Physio Clinic LLP|o|0|l|20241015|S\nMH-00-2414882|Apex Electronics Pvt Ltd|b|7|f|20210618|M\nKL-00-3831087|Unity Packaging Pvt Ltd|l|5|9|20220910|M\nAP-00-8602169|Metro Diagnostics Pvt Ltd|a|0|l|20230914|S\nMP-00-8546401|Unity Woodcraft|d|6|2|20211001|M\nKL-00-8860485|Navkar Insurance Advisors Pvt Ltd|g|5|9|20230911|M\nKL-00-8092248|Prime Kitchens|t|5|9|20220926|M\nMP-00-5241637|Galaxy Legal Associates LLP|i|6|2|20210417|M\nDL-00-9569450|Harmony Electronics LLP|b|2|5|20250602|M\nAP-00-6525247|Evergreen Hardware|f|0|l|20240428|S\nMH-00-1826449|Sai Opticals|k|7|d|20210125|D\nTS-00-7251351|Blue Lotus Design Studio Pvt Ltd|1|b|6|20230301|S\nMH-00-4923138|Trinity Kids Academy LLP|q|7|d|20210502|M\nMH-00-3265848|Metro Electronics Pvt Ltd|b|7|i|20210616|M\nKR-00-4643195|Prime Legal Associates|i|4|1|20241125|M\nMH-00-9678710|Modern Unisex Salon|u|7|d|20220120|D\nGJ-00-5399625|Green Leaf Opticals|k|3|j|20210418|S\nTS-00-1483166|Unity Foods Pvt Ltd|c|b|6|20240320|S\nKL-00-2336175|Sai Opticals|k|5|9|20231207|D\nMP-00-2776604|Ganga Fashions|0|6|2|20230902|S\nDL-00-4109217|Kaveri Bake House|4|2|5|20250619|S\nGJ-00-1514681|Evergreen Boutique|5|3|0|20220227|M\nMH-00-0685623|Galaxy Dental Care|9|7|g|20250430|D\nMH-00-1252641|Krishna Kids Academy Pvt Ltd|q|7|i|20250227|S\nMH-00-4907488|Prime Boutique|5|7|f|20210928|M\nBR-00-9232853|Sahyadri Auto Components|2|1|h|20241213|S\nTS-00-6203493|Sunrise Diagnostics|a|b|6|20230501|M\nKR-00-0044316|Orbit Stationers|v|4|1|20250728|M\nGJ-00-5768857|Silver Oak Bakers|3|3|0|20221217|M\nAP-00-6672373|Saffron Unisex Salon|u|0|l|20220422|M\nWB-00-5380218|Moonlight Electronics Pvt Ltd|b|d|a|20231115|M\nBR-00-2323221|Shree General Store|h|1|h|20211231|M\nMH-00-3147645|Apex Pharma Retail LLP|n|7|d|20230819|S\nAP-00-9217517|Orbit Hardware|f|0|l|20241011|M\nPB-00-3542989|Prime Bake House|4|8|c|20210810|M\nBR-00-5672477|Saffron Sweets|w|1|h|20251111|S\nMP-00-8242370|Metro Boutique|5|6|2|20220615|M\nMH-00-6561511|Metro Auto Components Pvt Ltd|2|7|i|20230128|S\nAP-00-8360002|Silver Oak Dental Care Pvt Ltd|9|0|l|20240823|S\nPB-00-6037181|Prime Stays|6|8|c|20230225|M\nMH-00-6913086|Shree Packaging|l|7|g|20220830|S\nDL-00-0010349|Trinity Hardware|f|2|5|20220217|M\nDL-00-9565547|Neelgiri Physio Clinic|o|2|5|20230404|S\nMP-00-2478092|Ganesh Boutique|5|6|7|20211120|S\nGJ-00-8232012|Sahyadri Printers Pvt Ltd|r|3|k|20231122|D\nDL-00-6444817|Ganesh Pharma Retail Pvt Ltd|n|2|5|20220603|M\nDL-00-2208790|Sunrise Foods|c|2|5|20220902|S\nBR-00-7517069|Green Leaf Polymers|p|1|h|20210518|S\nMH-00-1034877|Modern Sweets|w|7|d|20241005|M\nMH-00-8578252|Vindhya Medicals|m|7|g|20220423|S\nMH-00-0924146|Green Leaf Fitness|e|7|i|20240310|S\nMP-00-4234191|Coral Auto Components Pvt Ltd|2|6|7|20221013|M\nKR-00-2353159|Balaji Insurance Advisors Pvt Ltd|g|4|1|20240927|S\nKR-00-8552914|Sunrise Unisex Salon|u|4|e|20220209|M\nDL-00-6654546|Annapurna Mobile Care|j|2|5|20240419|M\nTN-00-7062276|Balaji Pharma Retail|n|a|4|20210909|M\nKR-00-7796136|Amrit Bakers|3|4|1|20211110|M\nTN-00-1636817|Galaxy General Store|h|a|3|20230512|M\nPB-00-6387734|Ganga Insurance Advisors|g|8|c|20210724|M\nMH-00-1926121|New Mobile Care|j|7|d|20220928|S\nMP-00-6672076|Krishna Mobile Care|j|6|2|20250503|M\nGJ-00-4944260|Balaji Bake House LLP|4|3|0|20210214|M\nKR-00-9173453|Unity Bakers|3|4|1|20220903|S\nDL-00-8385888|Apex Mobile Care|j|2|5|20211216|M\nMH-00-6534341|Evergreen General Store|h|7|f|20210717|S\nKR-00-8803363|New Sweets|w|4|1|20220301|M\nMP-00-0887662|Navkar Stationers|v|6|7|20230824|M\nKR-00-7781408|Shree Hardware|f|4|e|20240301|M\nMH-00-1660580|Classic Insurance Advisors|g|7|i|20251027|M\nKR-00-1676589|Evergreen Fitness LLP|e|4|1|20260105|S\nGJ-00-4828149|Lakshmi Insurance Advisors LLP|g|3|k|20250729|M\nKR-00-9727096|Annapurna Medicals|m|4|e|20230328|S\nMH-00-1178785|Balaji General Store|h|7|d|20240104|M\nPB-00-5446426|Shree Hardware|f|8|c|20220206|S\nRJ-00-0873242|Green Leaf Insurance Advisors|g|9|8|20230812|M\nMH-00-3604410|Amrit Diagnostics LLP|a|7|d|20201026|M\nTN-00-9503470|New Boutique|5|a|3|20211208|S\nBR-00-4307077|Saffron Stays|6|1|h|20240520|S\nUP-00-6424500|Star Diagnostics LLP|a|c|b|20241218|M\nGJ-00-1498260|Shree Opticals|k|3|0|20230505|S\nRJ-00-1062081|Riddhi Stays|6|9|8|20231120|S\nMP-00-8187965|Om Bakers|3|6|7|20231224|S\nGJ-00-3180697|Silver Oak Polymers|p|3|0|20250331|M\nPB-00-5395278|Sai Stays|6|8|c|20220808|S\nKR-00-9714660|Lakshmi Diagnostics Pvt Ltd|a|4|1|20211009|M\nKR-00-6971688|Prime Realty|s|4|1|20250827|S\nGJ-00-8642638|Moonlight Stays LLP|6|3|0|20210602|M\nTN-00-1175460|Annapurna Stationers|v|a|3|20230624|S\nBR-00-5935853|Modern Pharma Retail|n|1|h|20250817|M\nTS-00-4315648|Saffron Pharma Retail|n|b|6|20250422|M\nKR-00-2095008|Krishna & Associates|7|4|e|20221202|M\nKR-00-5629498|Metro Pharma Retail|n|4|e|20211226|M\nUP-00-3232221|Sunrise Bake House LLP|4|c|b|20250810|S\nMH-00-4054605|Om Bake House|4|7|g|20221031|M\nRJ-00-3283668|Star Fitness|e|9|8|20231001|M\nWB-00-2209783|Shree Opticals|k|d|a|20220903|M\nKR-00-7844525|Kaveri Stationers|v|4|e|20220820|M\nBR-00-3939389|Sahyadri Design Studio Pvt Ltd|1|1|h|20250414|M\nGJ-00-1836602|Om Fashions Pvt Ltd|0|3|j|20230410|M\nTN-00-0888740|Kaveri Sweets|w|a|4|20231111|M\nUP-00-4206791|Coral Medicals|m|c|b|20231210|S\nPB-00-1893606|Zenith Fashions|0|8|c|20240105|M\nMH-00-4758386|Galaxy Sweets|w|7|f|20241002|S\nMH-00-1830050|Riddhi Physio Clinic|o|7|g|20211211|M\nMP-00-1896921|Ganesh Classes|8|6|2|20250213|M\nTN-00-8859864|Sai & Associates|7|a|3|20240623|M\nKR-00-7335396|Sunrise Polymers|p|4|e|20220227|S\nMH-00-1466948|Om Physio Clinic|o|7|f|20210604|M\nDL-00-3109523|Harmony Realty|s|2|5|20260129|M\nRJ-00-8800059|Prime Kids Academy Pvt Ltd|q|9|8|20240120|M\nMH-00-2268802|Prime Mobile Care|j|7|d|20241116|M\nGJ-00-0562295|Modern Hardware|f|3|j|20230124|M\nGJ-00-0786066|Royal Stationers|v|3|k|20230323|M\nTS-00-6770111|Apex Sweets|w|b|6|20250424|M\nMH-00-8041444|Shree Tours & Travels Pvt Ltd|y|7|i|20230727|S\nGJ-00-6660548|Pearl Legal Associates LLP|i|3|j|20230928|M\nTN-00-3409693|Ganesh Polymers|p|a|4|20210409|S\nGJ-00-1713763|Unity Medicals|m|3|k|20210413|M\nMH-00-8443132|Coral Stationers|v|7|d|20230717|S\nGJ-00-8477445|Green Leaf Legal Associates|i|3|k|20210428|S\nKR-00-3897931|Krishna Dental Care|9|4|1|20251117|D\nWB-00-3837416|Saffron Textiles LLP|x|d|a|20210207|S\nBR-00-6561393|Apex Bakers|3|1|h|20241226|M\nKL-00-7909045|Green Leaf Tours & Travels LLP|y|5|9|20220909|M\nMH-00-6102542|Trinity Stays Pvt Ltd|6|7|d|20220923|M\nTN-00-7573236|Classic Hardware|f|a|3|20240217|M\nMP-00-9086954|Prime Tours & Travels Pvt Ltd|y|6|2|20220329|S\nPB-00-9719478|Trinity Bake House Pvt Ltd|4|8|c|20220831|M\nTN-00-6770583|Classic Bakers|3|a|3|20221201|M\nKL-00-0307185|Lakshmi Tours & Travels|y|5|9|20231223|S\nMH-00-4694367|Prime Dental Care LLP|9|7|d|20221211|M\nMH-00-3504771|Green Leaf Medicals|m|7|d|20230305|M\nKR-00-9783562|Navkar Legal Associates Pvt Ltd|i|4|e|20240108|M\nTS-00-6886586|Vindhya Legal Associates|i|b|6|20210819|M\nTS-00-6643037|City Textiles LLP|x|b|6|20220907|M\nTN-00-6928773|Evergreen & Associates Pvt Ltd|7|a|4|20220522|S\nTN-00-8248519|Saffron Dental Care|9|a|3|20241110|M\nRJ-00-1595320|Royal Sweets|w|9|8|20221108|S\nMH-00-9362747|Neelgiri Kids Academy|q|7|i|20250913|M\nKR-00-4971656|Sai & Associates LLP|7|4|1|20250104|M\nTN-00-3116500|City Fashions Pvt Ltd|0|a|3|20220423|M\nMH-00-3707454|Prime Stationers|v|7|d|20210608|M\nWB-00-9102366|Krishna Stationers|v|d|a|20250719|M\nMH-00-8861429|Royal Sweets|w|7|f|20210227|M\nTS-00-9553248|Krishna Dental Care|9|b|6|20230715|M\nRJ-00-9702479|Sahyadri Stays|6|9|8|20220928|D\nWB-00-5452929|Shree Stays LLP|6|d|a|20230507|M\nKR-00-2685077|Shree Sweets|w|4|1|20250724|M\nTN-00-1590522|Evergreen Textiles|x|a|3|20251124|M\nTS-00-2186457|New Tours & Travels Pvt Ltd|y|b|6|20220125|S\nGJ-00-3021779|Star Insurance Advisors|g|3|0|20241021|M\nWB-00-8695866|City Kids Academy LLP|q|d|a|20210531|M\nRJ-00-3219534|Unity Tours & Travels|y|9|8|20220629|M\nKR-00-1877558|Navkar Pharma Retail LLP|n|4|1|20220113|M\nTN-00-4669473|Sai Stays Pvt Ltd|6|a|4|20201027|S\nWB-00-9152132|Moonlight Boutique|5|d|a|20250623|M\nKR-00-5778197|Metro Realty Pvt Ltd|s|4|1|20220605|D\nDL-00-9192246|Blue Lotus Tours & Travels|y|2|5|20211229|S\nDL-00-0019302|Silver Oak Textiles|x|2|5|20240625|M\nPB-00-7319913|Unity Bakers|3|8|c|20230913|M\nMH-00-3924128|Ganesh Packaging|l|7|i|20230122|S\nGJ-00-6234947|Sunrise Realty|s|3|k|20230424|M\nDL-00-7373330|Krishna Realty|s|2|5|20230512|M\nTN-00-3530347|Kaveri Stationers|v|a|4|20220720|M\nTS-00-1936990|Prime Diagnostics LLP|a|b|6|20240325|M\nGJ-00-9066492|Pearl Design Studio|1|3|0|20220815|M\nMH-00-5582317|Kaveri Boutique|5|7|d|20240129|M\nWB-00-8702903|Trinity Mobile Care|j|d|a|20240625|S\nGJ-00-3884029|Moonlight Bake House|4|3|k|20240115|M\nBR-00-6739973|Moonlight Design Studio Pvt Ltd|1|1|h|20230904|S\nAP-00-5186772|Star Electronics|b|0|l|20211017|M\nBR-00-9803526|New Mobile Care|j|1|h|20251211|S\nMH-00-4364769|Om Bakers|3|7|d|20250905|M\nDL-00-2368813|Saffron Fitness|e|2|5|20240225|S\nGJ-00-0721376|Shree Sweets|w|3|0|20240903|M\nKR-00-9063898|Galaxy Insurance Advisors Pvt Ltd|g|4|1|20240109|M\nTS-00-9685989|Ganga Fashions LLP|0|b|6|20220208|M\nBR-00-1572714|Lakshmi Textiles|x|1|h|20240323|S\nKR-00-7136861|Shree Classes Pvt Ltd|8|4|1|20250303|M\nTS-00-4379432|Modern Kitchens Pvt Ltd|t|b|6|20211020|M\nMH-00-9516696|Ganesh Woodcraft|d|7|f|20241001|M\nMP-00-1066900|Shree Classes|8|6|2|20221024|M\nWB-00-4756846|New Stationers|v|d|a|20210211|M\nMH-00-9447762|Star Textiles|x|7|f|20230918|D\nAP-00-6567823|Moonlight Unisex Salon|u|0|l|20221012|S\nKR-00-5247939|Ganesh Dental Care|9|4|e|20210720|M\nDL-00-5379600|Royal Bake House LLP|4|2|5|20240221|D\nDL-00-5681663|Ganga Unisex Salon|u|2|5|20210606|M\nRJ-00-0062569|Trinity Opticals|k|9|8|20241205|S\nMP-00-6292464|Silver Oak Boutique|5|6|7|20201107|S\nAP-00-4475060|Green Leaf Boutique|5|0|l|20250417|M\nWB-00-9018119|Shree Stationers|v|d|a|20231004|S\nWB-00-1244213|Harmony Packaging|l|d|a|20260129|M\nBR-00-0002853|Trinity Physio Clinic|o|1|h|20220325|M\nMP-00-3685712|Unity Fitness|e|6|7|20220423|M\nMH-00-1731313|Blue Lotus Electronics Pvt Ltd|b|7|d|20230513|S\nGJ-00-9444915|Sahyadri Bakers|3|3|k|20221231|M\nGJ-00-1308276|Green Leaf Bake House|4|3|k|20231128|M\nUP-00-0294042|Galaxy Electronics|b|c|b|20251219|S\nKR-00-4766302|Om Stationers|v|4|1|20201029|M\nPB-00-7373088|Vindhya Sweets|w|8|c|20220803|S\nDL-00-7187977|Ganesh Physio Clinic Pvt Ltd|o|2|5|20210829|M\nWB-00-7386807|Navkar Dental Care|9|d|a|20250929|S\nGJ-00-5217384|Evergreen Bakers|3|3|k|20230703|M\nKR-00-7632193|City Stays|6|4|1|20210517|M\nMH-00-2025167|Apex Mobile Care|j|7|f|20220126|M\nBR-00-9272608|Metro Sweets|w|1|h|20240806|M\nPB-00-7470213|Blue Lotus Sweets|w|8|c|20240808|M\nUP-00-6636543|Royal Sweets|w|c|b|20201027|M\nTN-00-7894972|Vindhya Classes|8|a|3|20250426|M\nTS-00-9763278|Zenith Woodcraft|d|b|6|20240828|M\nUP-00-2463180|Prime Kids Academy Pvt Ltd|q|c|b|20251226|M\nDL-00-7691471|Krishna Opticals|k|2|5|20240304|M\nGJ-00-2907265|Metro Hardware|f|3|k|20250302|M\nGJ-00-5708501|Star Diagnostics|a|3|j|20230425|M\nGJ-00-8902338|Classic Foods LLP|c|3|j|20210528|D\nTS-00-4747248|City Fashions|0|b|6|20250123|S\nDL-00-5797133|Lakshmi Insurance Advisors LLP|g|2|5|20210528|M\nGJ-00-3503014|Apex Realty|s|3|0|20220717|S\nTS-00-6619253|Apex Stays|6|b|6|20230713|M\nMP-00-2486778|Vindhya Electronics|b|6|7|20230130|M\nDL-00-0393054|Sahyadri General Store|h|2|5|20230109|M\nDL-00-0414000|Riddhi Design Studio|1|2|5|20221204|M\nTS-00-5481541|Trinity Insurance Advisors|g|b|6|20201203|S\nTN-00-1504886|Prime Hardware|f|a|4|20220620|M\nTN-00-4736946|Classic Design Studio LLP|1|a|4|20230126|S\nGJ-00-9821940|Blue Lotus Boutique|5|3|j|20201016|M\nTN-00-7748723|Saffron Stationers|v|a|3|20250813|S\nTS-00-7285871|Zenith Mobile Care|j|b|6|20240825|M\nMH-00-3528450|Balaji Bakers|3|7|i|20240803|S\nMP-00-2685453|Riddhi Bake House|4|6|7|20231228|S\nAP-00-4308344|Metro Hardware|f|0|l|20241006|M\nDL-00-7170935|Saffron Unisex Salon|u|2|5|20210629|M\nBR-00-4921905|Lakshmi Tours & Travels|y|1|h|20210818|M\nTS-00-9414623|Unity Hardware|f|b|6|20240601|M\nMH-00-2319375|Moonlight Boutique|5|7|i|20210224|M\nTS-00-6818146|Evergreen & Associates Pvt Ltd|7|b|6|20221005|M\nKR-00-0677764|Pearl Unisex Salon|u|4|1|20250613|M\nWB-00-7206992|Kaveri Realty|s|d|a|20210513|S\nMH-00-4654505|New Diagnostics|a|7|d|20230818|M\nTN-00-7948740|Amrit Sweets|w|a|3|20250418|M\nAP-00-4760297|Ganga General Store|h|0|l|20230425|M\nTS-00-7490204|City Fitness|e|b|6|20211225|S\nDL-00-5124721|Coral Electronics|b|2|5|20230625|S\nGJ-00-6745556|Shree Mobile Care|j|3|0|20241124|M\nMP-00-7164857|Evergreen Boutique|5|6|2|20230217|M\nKR-00-5719578|Silver Oak Design Studio LLP|1|4|e|20250707|M\nTN-00-9204494|Ganesh Physio Clinic Pvt Ltd|o|a|3|20240520|M\nTN-00-8051731|Lakshmi Foods Pvt Ltd|c|a|3|20250928|M\nMH-00-1269619|Krishna Stays LLP|6|7|d|20210115|M\nWB-00-7076591|Ganga Unisex Salon|u|d|a|20231228|M\nMP-00-3794635|Shree Classes Pvt Ltd|8|6|2|20201123|S\nKR-00-5903779|Harmony Mobile Care|j|4|1|20210620|D\nTS-00-6552260|Coral General Store|h|b|6|20210315|M\nTS-00-0013966|Balaji Legal Associates|i|b|6|20201227|S\nMH-00-9257120|Moonlight Tours & Travels LLP|y|7|i|20220329|M\nDL-00-2088138|Ganesh Bake House Pvt Ltd|4|2|5|20201012|M\nMH-00-5106481|Apex Stationers|v|7|i|20251103|M\nMH-00-4545706|Navkar Foods LLP|c|7|i|20240516|S\nGJ-00-4996981|Coral Legal Associates LLP|i|3|k|20241208|M\nMH-00-6962696|Zenith Woodcraft Pvt Ltd|d|7|g|20230603|S\nBR-00-9156992|Metro Woodcraft|d|1|h|20240423|S\nTS-00-6194203|Silver Oak Diagnostics LLP|a|b|6|20201027|M\nRJ-00-6145759|Lakshmi Sweets|w|9|8|20210616|S\nMP-00-2802074|Star Kids Academy Pvt Ltd|q|6|2|20250716|M\nDL-00-3050161|Pearl Stays|6|2|5|20240724|M\nKR-00-5819643|Saffron Realty LLP|s|4|e|20221022|S\nMH-00-9199185|Trinity Bakers|3|7|f|20210525|S\nTN-00-4919847|Pearl Mobile Care|j|a|4|20210207|M\nKL-00-1455207|Modern Dental Care LLP|9|5|9|20210228|S\nKL-00-0591537|New Electronics|b|5|9|20210312|M\nWB-00-2255302|Sahyadri Stationers|v|d|a|20211013|M\nDL-00-6286500|City Printers|r|2|5|20221202|M\nKR-00-2267038|Metro Pharma Retail Pvt Ltd|n|4|e|20220107|S\nAP-00-2908436|Vindhya Fashions LLP|0|0|l|20221223|M\nDL-00-0999714|Shree Legal Associates LLP|i|2|5|20230913|S\nKR-00-3297015|Sai Hardware|f|4|1|20210208|M\nAP-00-7564123|Orbit Boutique|5|0|l|20211007|M\nMP-00-8001125|Vindhya Unisex Salon|u|6|2|20220805|M\nGJ-00-4031206|Kaveri Insurance Advisors LLP|g|3|j|20241211|S\nMH-00-3084533|Royal Printers|r|7|i|20201024|S\nGJ-00-9756993|Saffron Realty|s|3|0|20220927|M\nGJ-00-8676371|Saffron Sweets|w|3|0|20211110|S\nPB-00-7727755|Sahyadri Tours & Travels LLP|y|8|c|20230504|M\nKL-00-7325985|Shree Diagnostics Pvt Ltd|a|5|9|20250704|M\nTS-00-6754568|Classic Fitness LLP|e|b|6|20201111|M\nGJ-00-4603819|Kaveri Dental Care|9|3|0|20220415|M\nMH-00-8047372|Vindhya General Store|h|7|g|20241031|M\nWB-00-9239071|Ganga General Store|h|d|a|20230405|S\nBR-00-7746416|Silver Oak Classes Pvt Ltd|8|1|h|20230916|M\nWB-00-9250792|Royal Hardware|f|d|a|20240427|M\nTN-00-9201071|Unity Auto Components|2|a|3|20210402|S\nMH-00-4938442|Sunrise Diagnostics LLP|a|7|d|20210321|M\nTN-00-8369022|Amrit Mobile Care|j|a|4|20251210|S\nMH-00-0390950|Navkar Tours & Travels Pvt Ltd|y|7|i|20230729|M\nKR-00-4059897|Harmony Diagnostics|a|4|e|20231022|M\nWB-00-2897849|Harmony Hardware|f|d|a|20220322|M\nMH-00-2039370|Neelgiri Electronics Pvt Ltd|b|7|g|20231220|S\nMH-00-8826426|Harmony Bake House LLP|4|7|d|20210815|S\nMH-00-8036028|City Textiles Pvt Ltd|x|7|g|20250128|S\nUP-00-4127968|Navkar Classes LLP|8|c|b|20210331|M\nTS-00-8044782|Navkar Packaging|l|b|6|20210705|M\nTN-00-4287261|Moonlight Classes Pvt Ltd|8|a|4|20240519|M\nKL-00-6462644|Apex Medicals|m|5|9|20230924|M\nPB-00-6713222|Green Leaf Pharma Retail LLP|n|8|c|20250523|M\nKR-00-6072565|Coral Polymers LLP|p|4|1|20220130|M\nGJ-00-3532671|Moonlight Fitness LLP|e|3|k|20221007|M\nKR-00-6836382|Orbit Realty|s|4|1|20220614|M\nPB-00-0271938|Sahyadri Insurance Advisors Pvt Ltd|g|8|c|20221005|S\nBR-00-4175089|Balaji Kitchens|t|1|h|20210723|M\nMH-00-7205626|Unity Stationers|v|7|d|20220126|M\nGJ-00-4056537|Saffron Stays Pvt Ltd|6|3|0|20230721|M\nTN-00-0362106|Lakshmi Sweets|w|a|3|20220213|D\nMH-00-8263317|Royal Physio Clinic|o|7|i|20221004|M\nMH-00-3540564|Amrit Insurance Advisors|g|7|d|20210819|M\nGJ-00-2258682|Sai Mobile Care|j|3|k|20220704|S\nGJ-00-4601838|Pearl Bakers|3|3|k|20230215|S\nMH-00-1340345|Harmony Unisex Salon|u|7|i|20210706|M\nMP-00-8358382|Prime Realty|s|6|7|20250423|M\nUP-00-0977372|Unity Bakers|3|c|b|20250404|M\nTS-00-5866127|New Design Studio|1|b|6|20250311|M\nKL-00-0361559|Ganesh Stays|6|5|9|20210419|S\nAP-00-6581233|City Opticals|k|0|l|20241022|D\nMH-00-6374126|Royal Bakers|3|7|d|20250710|S\nPB-00-8414408|Unity Stationers|v|8|c|20230218|M\nTS-00-1149819|Om Boutique|5|b|6|20230318|S\nDL-00-8610052|Shree Boutique|5|2|5|20250112|S\nTS-00-4538264|Pearl Boutique|5|b|6|20210410|M\nDL-00-2708786|New Realty|s|2|5|20250116|M\nTN-00-3557130|Zenith Sweets|w|a|3|20230118|M\nGJ-00-9229523|Evergreen Design Studio Pvt Ltd|1|3|k|20201222|M\nKR-00-6979913|Zenith Medicals|m|4|1|20230517|M\nGJ-00-6835591|Evergreen Unisex Salon|u|3|k|20211016|M\nDL-00-3254344|Om Opticals|k|2|5|20250220|M\nMH-00-3549673|Green Leaf Bakers|3|7|d|20220510|M\nMH-00-5010704|Zenith Packaging|l|7|d|20230805|D\nKL-00-0892554|Evergreen Hardware|f|5|9|20210611|S\nKR-00-6683095|Balaji Stays Pvt Ltd|6|4|e|20240920|S\nTN-00-2728235|Classic Printers Pvt Ltd|r|a|3|20240114|S\nMH-00-1391238|Modern Mobile Care|j|7|i|20241106|S\nRJ-00-9729531|Metro Design Studio Pvt Ltd|1|9|8|20210428|M\nRJ-00-4486549|Trinity Stationers|v|9|8|20211005|M\nAP-00-7592219|Classic Tours & Travels|y|0|l|20231112|M\nMH-00-5088127|Star Mobile Care|j|7|d|20240107|M\nTN-00-0222758|Metro Mobile Care|j|a|4|20210407|S\nKL-00-5946819|Sahyadri Auto Components Pvt Ltd|2|5|9|20240528|S\nGJ-00-8523344|Galaxy Textiles|x|3|j|20250515|M\nTN-00-1399631|Blue Lotus Design Studio LLP|1|a|4|20210920|M\nGJ-00-0359673|Royal Insurance Advisors|g|3|j|20250418|M\nKL-00-4936637|Apex Electronics|b|5|9|20211218|M\nKR-00-1855563|Vindhya Bake House Pvt Ltd|4|4|1|20230811|S\nGJ-00-2009056|Galaxy Opticals|k|3|j|20250304|M\nBR-00-7962486|Prime Bakers|3|1|h|20230607|M\nDL-00-4751287|Navkar Kitchens|t|2|5|20231117|M\nGJ-00-1347436|Shree Legal Associates LLP|i|3|k|20240530|S\nKR-00-3450235|Classic General Store|h|4|1|20201022|D\nKR-00-3986950|Orbit Realty Pvt Ltd|s|4|1|20250329|S\nGJ-00-2863388|Amrit Tours & Travels LLP|y|3|j|20210201|M\nUP-00-1751911|Ganga Foods LLP|c|c|b|20250323|S\nGJ-00-2859473|Neelgiri Packaging|l|3|j|20230609|S\nDL-00-6645036|Vindhya Classes Pvt Ltd|8|2|5|20220526|S\nUP-00-7559243|Neelgiri General Store|h|c|b|20220530|M\nKR-00-7999225|Zenith Sweets|w|4|e|20230901|D\nMP-00-6636511|Moonlight Opticals|k|6|2|20250711|M\nRJ-00-3712336|Apex Boutique|5|9|8|20210224|S\nRJ-00-3319511|Zenith Fashions Pvt Ltd|0|9|8|20230409|M\nMH-00-5940677|Balaji Medicals|m|7|d|20250108|M\nTS-00-0922033|Metro Mobile Care|j|b|6|20230319|M\nKR-00-2733936|Neelgiri Tours & Travels Pvt Ltd|y|4|1|20230115|M\nKR-00-9308529|Trinity Fitness|e|4|1|20210713|M\nAP-00-0351865|Classic Diagnostics Pvt Ltd|a|0|l|20220604|M\nTS-00-8445824|Riddhi General Store|h|b|6|20210709|S\nKR-00-7991475|Riddhi Unisex Salon|u|4|e|20210608|M\nPB-00-1298329|Balaji Tours & Travels|y|8|c|20220923|M\nBR-00-2202061|Royal Stationers|v|1|h|20220427|S\nPB-00-6075388|Galaxy General Store|h|8|c|20230317|M\nGJ-00-9246882|Lakshmi Legal Associates|i|3|k|20250504|M\nMH-00-1365497|Zenith Medicals|m|7|f|20250412|M\nPB-00-4493169|City Kids Academy Pvt Ltd|q|8|c|20240324|M\nMP-00-0429167|Zenith Mobile Care|j|6|2|20211125|S\nMH-00-8588410|Lakshmi Unisex Salon|u|7|d|20251107|S\nGJ-00-4388136|Ganesh Pharma Retail Pvt Ltd|n|3|k|20260102|S\nUP-00-0927009|Zenith Diagnostics Pvt Ltd|a|c|b|20210706|M\nDL-00-5757091|Vindhya Woodcraft|d|2|5|20250914|S\nKL-00-7540700|Moonlight Tours & Travels|y|5|9|20220324|S\nMH-00-1795600|Annapurna Medicals|m|7|g|20251103|M\nBR-00-1281443|Annapurna Realty|s|1|h|20220704|S\nUP-00-2020902|Moonlight Mobile Care|j|c|b|20221201|M\nMH-00-7096881|Sunrise Dental Care|9|7|i|20220529|M\nKL-00-4597785|Classic Mobile Care|j|5|9|20250409|M\nMP-00-2719181|City Legal Associates|i|6|7|20210427|M\nTS-00-6307171|Pearl Legal Associates|i|b|6|20221217|S\nKL-00-5287607|Green Leaf Electronics LLP|b|5|9|20230713|M\nMH-00-4113238|Shree Hardware|f|7|d|20240227|M\nKR-00-5149037|Riddhi Pharma Retail|n|4|e|20251004|M\nMH-00-4100599|Sunrise Stationers|v|7|i|20241030|S\nKL-00-1525181|City Unisex Salon|u|5|9|20220605|S\nGJ-00-4186621|Sai Fashions LLP|0|3|k|20240110|S\nMP-00-2243690|New Bake House|4|6|2|20210208|M\nTN-00-2953031|Modern Design Studio|1|a|3|20250405|M\nMH-00-5702163|New Sweets|w|7|g|20240928|M\nGJ-00-9083309|Krishna Printers Pvt Ltd|r|3|k|20240414|S\nDL-00-1851015|City Unisex Salon|u|2|5|20240325|M\nMH-00-9627639|Sunrise Design Studio LLP|1|7|g|20250208|D\nMH-00-5239065|Classic Diagnostics LLP|a|7|g|20240327|M\nBR-00-4900111|Navkar Physio Clinic LLP|o|1|h|20210111|M\nUP-00-0585535|Green Leaf Pharma Retail Pvt Ltd|n|c|b|20250110|M\nRJ-00-1329531|New Mobile Care|j|9|8|20250502|S\nTS-00-2884890|Krishna Kitchens LLP|t|b|6|20230509|S\nGJ-00-8689003|Star Stationers|v|3|0|20230616|M\nTN-00-5048352|Apex Electronics Pvt Ltd|b|a|3|20230201|M\nWB-00-5716798|Lakshmi Sweets|w|d|a|20241221|S\nTN-00-5073992|Krishna Bakers|3|a|3|20210330|M\nKR-00-8547299|New Physio Clinic|o|4|1|20210217|M\nGJ-00-1882443|Sunrise Fashions|0|3|k|20230922|M\nMP-00-7448666|Shree Dental Care|9|6|2|20221206|M\nKL-00-1142640|Green Leaf Foods|c|5|9|20201026|M\nGJ-00-3614845|Apex Physio Clinic|o|3|j|20250301|M\nAP-00-2627374|Green Leaf Insurance Advisors|g|0|l|20260126|S\nMP-00-5404719|Star Mobile Care|j|6|2|20240111|M\nKR-00-8811431|Apex Mobile Care|j|4|1|20210215|M\nTN-00-5455243|Riddhi Stationers|v|a|4|20240203|M\nMH-00-5924780|Neelgiri Unisex Salon|u|7|g|20201230|S\nMH-00-1501279|Zenith Legal Associates LLP|i|7|d|20250323|D\nMH-00-2774627|Balaji Classes Pvt Ltd|8|7|d|20230416|M\nGJ-00-9815676|Pearl Legal Associates LLP|i|3|k|20211210|M\nKL-00-5521886|Balaji Realty LLP|s|5|9|20221113|M\nBR-00-9628705|Zenith Kids Academy LLP|q|1|h|20231118|M\nGJ-00-7110962|Saffron Stationers|v|3|k|20251126|M\nMH-00-2567303|Saffron Bakers|3|7|d|20220801|M\nTN-00-9465055|City Pharma Retail LLP|n|a|3|20210605|M\nMH-00-3059886|Trinity Stays|6|7|f|20220609|M\nMP-00-2260142|Saffron Sweets|w|6|7|20230520|M\nDL-00-2889374|Metro Mobile Care|j|2|5|20230202|M\nGJ-00-5672929|Neelgiri Boutique|5|3|0|20250101|M\nPB-00-1422107|Sunrise Pharma Retail|n|8|c|20220624|S\nKR-00-2372513|Modern Packaging|l|4|1|20210812|S\nWB-00-1333917|Star Hardware|f|d|a|20230831|M\nMH-00-1255633|Ganesh Bakers|3|7|f|20251029|M\nGJ-00-4531506|Coral Diagnostics|a|3|k|20241217|M\nUP-00-7938408|Green Leaf Woodcraft Pvt Ltd|d|c|b|20240315|S\nTN-00-8349677|Star Stationers|v|a|4|20201129|M\nTN-00-3255184|Sai Stationers|v|a|4|20230121|M\nKR-00-2759622|Ganga Stays|6|4|e|20210823|M\nTS-00-4153824|Balaji & Associates|7|b|6|20210808|M\nKR-00-3399715|Moonlight Electronics Pvt Ltd|b|4|1|20240105|M\nMH-00-0211089|Lakshmi Legal Associates|i|7|g|20240514|M\nGJ-00-1385691|Vindhya Textiles|x|3|j|20250407|S\nRJ-00-5791752|Om Bakers|3|9|8|20251026|M\nDL-00-3817818|Royal Kids Academy Pvt Ltd|q|2|5|20210405|M\nTS-00-3643994|Kaveri Opticals|k|b|6|20211009|M\nDL-00-9297784|Apex Packaging|l|2|5|20230117|S\nGJ-00-4206027|Lakshmi Printers|r|3|j|20210425|S\nTN-00-4741242|Unity Diagnostics Pvt Ltd|a|a|3|20251027|M\nKR-00-9698959|Orbit Unisex Salon|u|4|1|20240130|M\nGJ-00-3105358|Metro Fashions Pvt Ltd|0|3|0|20220906|M\nGJ-00-6370434|Star Dental Care Pvt Ltd|9|3|k|20201023|M\nTN-00-8689935|Apex & Associates|7|a|4|20201230|S\nTN-00-7696754|Apex Opticals|k|a|3|20201108|M\nRJ-00-2505741|Shree & Associates|7|9|8|20210817|M\nTS-00-7852518|Riddhi Tours & Travels Pvt Ltd|y|b|6|20250512|M\nKR-00-6877304|Sai Mobile Care|j|4|1|20250712|D\nDL-00-9464181|Sai Packaging|l|2|5|20240922|S\nMP-00-2290224|Om Bake House|4|6|7|20220110|M\nDL-00-2743491|Silver Oak Insurance Advisors Pvt Ltd|g|2|5|20251204|M\nGJ-00-8412925|Saffron Mobile Care|j|3|0|20240628|S\nMH-00-7015140|Orbit Electronics Pvt Ltd|b|7|g|20201111|M\nMH-00-1208555|Sahyadri Unisex Salon|u|7|d|20230905|M\nTS-00-2301534|Kaveri Bake House|4|b|6|20240125|M\nMH-00-1301982|Sunrise Insurance Advisors Pvt Ltd|g|7|d|20210728|M\nAP-00-7931083|Modern Physio Clinic|o|0|l|20250827|M\nTS-00-9360522|Saffron Legal Associates Pvt Ltd|i|b|6|20210904|M\nDL-00-1628844|New Fitness Pvt Ltd|e|2|5|20211229|M\nTN-00-7079539|Moonlight Unisex Salon|u|a|4|20250506|D\nMH-00-4068461|Moonlight Realty Pvt Ltd|s|7|f|20211115|S\nPB-00-5152371|Amrit Pharma Retail|n|8|c|20211011|M\nTS-00-2887274|Galaxy Opticals|k|b|6|20240207|M\nGJ-00-6477648|Green Leaf General Store|h|3|j|20220426|M\nTN-00-1258986|Ganesh Medicals|m|a|3|20240823|M\nTS-00-9311420|Riddhi Diagnostics|a|b|6|20241001|M\nWB-00-6465739|City Packaging|l|d|a|20221202|M\nMH-00-4056843|Sahyadri Physio Clinic LLP|o|7|f|20210805|M\nTN-00-9612550|Annapurna Opticals|k|a|3|20241114|M\nTN-00-7844269|Unity Insurance Advisors|g|a|4|20250630|M\nDL-00-8530559|City Stationers|v|2|5|20220206|M\nMH-00-9763518|Silver Oak Physio Clinic LLP|o|7|g|20240811|S\nTS-00-1649650|Neelgiri Stays Pvt Ltd|6|b|6|20240224|M\nMH-00-5240443|Apex Sweets|w|7|d|20220404|M\nGJ-00-8393829|Kaveri Bake House Pvt Ltd|4|3|k|20211118|D\nDL-00-0720177|Amrit Bakers|3|2|5|20240807|M\nDL-00-5886050|Balaji Fitness|e|2|5|20251029|S\nGJ-00-1727091|Prime Pharma Retail LLP|n|3|0|20250620|M\nDL-00-3993277|Navkar Hardware|f|2|5|20240222|M\nMH-00-9111469|Star Polymers|p|7|d|20231202|S\nKR-00-9903120|Trinity Dental Care LLP|9|4|1|20220919|M\nBR-00-7741913|Amrit Medicals|m|1|h|20220423|S\nTS-00-5439534|Modern Unisex Salon|u|b|6|20221212|M\nMH-00-7246763|Annapurna General Store|h|7|i|20221124|M\nDL-00-8919069|Silver Oak Bakers|3|2|5|20240926|M\nRJ-00-1579751|Royal Dental Care Pvt Ltd|9|9|8|20220705|M\nAP-00-0996681|Ganga Mobile Care|j|0|l|20211128|M\nRJ-00-3841791|City Realty Pvt Ltd|s|9|8|20231219|S\nDL-00-8694264|Saffron Boutique|5|2|5|20220725|M\nKR-00-8737381|Sai Fashions|0|4|1|20210831|S\nDL-00-2338311|Metro Medicals|m|2|5|20230914|M\nKR-00-4854608|Coral Fitness Pvt Ltd|e|4|e|20240609|D\nKR-00-8645561|Ganesh Mobile Care|j|4|e|20250313|M\nMP-00-6187059|Green Leaf Boutique|5|6|2|20240131|S\nMH-00-4377086|Ganga Design Studio Pvt Ltd|1|7|g|20231010|M\nKR-00-1718775|Unity Stationers|v|4|e|20250308|M\nTS-00-4461598|Krishna & Associates|7|b|6|20250620|M\nMP-00-8864799|Galaxy Medicals|m|6|2|20230519|S\nDL-00-9957520|Apex Bakers|3|2|5|20211120|S\nMP-00-5744500|Sai & Associates|7|6|2|20210216|M\nUP-00-1030516|Sahyadri Kitchens|t|c|b|20210610|S\nTS-00-8296084|City Unisex Salon|u|b|6|20210416|S\nMP-00-0411039|Sunrise General Store|h|6|7|20260118|S\nKR-00-0658398|Trinity Sweets|w|4|1|20230516|M\nTS-00-9726111|Saffron Electronics Pvt Ltd|b|b|6|20240925|M\nKR-00-7993245|Riddhi Hardware|f|4|1|20211003|M\nKL-00-8131967|Sai Sweets|w|5|9|20210707|M\nMP-00-4480771|Moonlight Legal Associates Pvt Ltd|i|6|2|20231113|M\nMH-00-8993476|Sunrise Physio Clinic|o|7|d|20210412|S\nTN-00-8303012|Sai Bakers|3|a|4|20210308|M\nMH-00-9917833|Saffron Diagnostics|a|7|i|20210418|M\nGJ-00-2028481|Modern Physio Clinic|o|3|k|20211225|M\nTS-00-5153247|Star Medicals|m|b|6|20250322|M\nDL-00-1029764|City Boutique|5|2|5|20220724|M\nMP-00-0197648|City Legal Associates Pvt Ltd|i|6|2|20231215|M\nTS-00-0634227|Modern Hardware|f|b|6|20210505|M\nGJ-00-1908984|Unity Fitness Pvt Ltd|e|3|j|20220508|M\nDL-00-0700599|Kaveri Legal Associates|i|2|5|20240528|M\nMH-00-3983402|Metro Legal Associates Pvt Ltd|i|7|d|20230926|M\nMP-00-1036690|Kaveri Medicals|m|6|2|20250920|M\nTN-00-9997166|Metro Classes|8|a|3|20251114|M\nKR-00-2490168|Silver Oak Physio Clinic Pvt Ltd|o|4|1|20251122|S\nPB-00-7466291|Sunrise Legal Associates|i|8|c|20221117|M\nMH-00-3806355|Saffron Bake House Pvt Ltd|4|7|d|20250529|M\nWB-00-8588825|New Boutique|5|d|a|20230203|M\nTS-00-4588420|Shree Realty LLP|s|b|6|20250926|S\nGJ-00-2560804|Blue Lotus Woodcraft Pvt Ltd|d|3|k|20210510|S\nMH-00-3820347|Prime Sweets|w|7|f|20220225|M\nGJ-00-7495870|Vindhya Mobile Care|j|3|j|20210818|M\nMH-00-2723486|Balaji Design Studio|1|7|i|20250814|D\nBR-00-5497684|Pearl Hardware|f|1|h|20220223|M\nKR-00-9424282|Unity Sweets|w|4|e|20230726|M\nGJ-00-2544420|Green Leaf Realty Pvt Ltd|s|3|k|20220113|M\nKL-00-3973377|Sahyadri Legal Associates LLP|i|5|9|20230919|M\nKR-00-5036429|Modern Design Studio LLP|1|4|1|20211212|S\nRJ-00-0282630|Metro Bakers|3|9|8|20220421|D\nMH-00-5953606|Neelgiri Kitchens Pvt Ltd|t|7|d|20251016|S\nGJ-00-2551819|Lakshmi Textiles|x|3|0|20220504|S\nGJ-00-6511799|Sai Kitchens|t|3|0|20221204|S\nGJ-00-8271184|Moonlight Mobile Care|j|3|k|20210917|M\nMH-00-0119114|Orbit General Store|h|7|d|20260114|M\nTS-00-7962928|Modern Stays Pvt Ltd|6|b|6|20210517|M\nMH-00-7119920|Shree Fitness|e|7|d|20210702|M\nBR-00-2379357|Orbit Classes|8|1|h|20210320|M\nUP-00-4221580|Unity Sweets|w|c|b|20250501|M\nWB-00-8718750|Lakshmi Dental Care|9|d|a|20220728|S\nMH-00-6854926|Riddhi Foods|c|7|d|20240805|S\nMH-00-8968549|Blue Lotus Boutique|5|7|d|20220916|M\nMP-00-3923765|Trinity Textiles|x|6|2|20220106|M\nTS-00-9825720|Star Physio Clinic|o|b|6|20210610|S\nTN-00-4397824|Saffron Sweets|w|a|3|20201223|M\nWB-00-8627763|Sahyadri Physio Clinic|o|d|a|20241216|M\nMH-00-4062425|Sai Tours & Travels Pvt Ltd|y|7|f|20241220|S\nWB-00-1449748|Silver Oak General Store|h|d|a|20220311|S\nDL-00-8768415|Unity Fitness|e|2|5|20210425|S\nAP-00-1675498|Navkar Polymers LLP|p|0|l|20211219|S\nBR-00-4158787|Lakshmi Medicals|m|1|h|20220109|M\nGJ-00-5649371|Evergreen Diagnostics Pvt Ltd|a|3|j|20240812|M\nMH-00-7675391|Harmony Hardware|f|7|d|20230328|M\nMP-00-9454138|New Pharma Retail|n|6|7|20240701|M\nGJ-00-9056208|Zenith Foods|c|3|j|20220608|S\nMH-00-8416057|Pearl Stays LLP|6|7|d|20210321|M\nWB-00-2211528|Unity Pharma Retail Pvt Ltd|n|d|a|20220831|M\nMP-00-3660207|Neelgiri Auto Components|2|6|7|20201009|D\nTS-00-9764123|Coral Foods|c|b|6|20220913|S\nWB-00-0568207|Sahyadri Medicals|m|d|a|20230306|M\nPB-00-4939401|Sai Classes|8|8|c|20240128|S\nTS-00-8755662|Star Hardware|f|b|6|20210926|S\nGJ-00-8678386|Kaveri Sweets|w|3|k|20210321|M\nKR-00-3817723|New Stationers|v|4|e|20231223|D\nMH-00-2343773|Moonlight General Store|h|7|f|20240209|M\nMP-00-4220780|Modern Fashions Pvt Ltd|0|6|7|20221215|M\nTN-00-4178149|Pearl Tours & Travels|y|a|3|20240726|M\nMP-00-9644990|Evergreen Hardware|f|6|2|20240924|M\nTN-00-9330553|Sunrise General Store|h|a|3|20210813|D\nMH-00-1696810|Zenith Opticals|k|7|i|20210127|M\nDL-00-1913895|Krishna Woodcraft Pvt Ltd|d|2|5|20230825|M\nTS-00-6457397|Green Leaf Sweets|w|b|6|20220112|M\nKL-00-7113089|Blue Lotus Fashions|0|5|9|20240611|S\nMH-00-3963749|Lakshmi Auto Components Pvt Ltd|2|7|g|20250210|M\nGJ-00-0667370|Shree Polymers|p|3|0|20201102|M\nMP-00-6625604|Ganesh Diagnostics|a|6|2|20230521|M\nMH-00-8335318|Trinity Unisex Salon|u|7|d|20250828|M\nMH-00-3940192|Sahyadri Printers|r|7|i|20221120|M\nGJ-00-9030191|Sahyadri Opticals|k|3|j|20220608|M\nMH-00-5662803|Zenith Woodcraft LLP|d|7|d|20250524|M\nWB-00-3673991|Green Leaf Classes Pvt Ltd|8|d|a|20241122|S\nKL-00-2242092|Classic Sweets|w|5|9|20201118|S\nMH-00-1401358|Saffron Electronics|b|7|i|20210829|M\nMP-00-5342468|Riddhi Dental Care|9|6|2|20240218|M\nMH-00-9164589|Annapurna Fashions|0|7|d|20230720|M\nKR-00-1939807|Sai Kitchens|t|4|1|20240924|S\nGJ-00-3197578|Zenith Auto Components LLP|2|3|k|20210927|S\nRJ-00-2108316|Coral Stays Pvt Ltd|6|9|8|20220522|M\nMP-00-5740928|Vindhya Bake House LLP|4|6|7|20220413|M\nKR-00-5927453|Royal General Store|h|4|e|20240331|S\nRJ-00-5688066|Neelgiri Realty Pvt Ltd|s|9|8|20231128|M\nUP-00-9660165|Navkar Medicals|m|c|b|20230208|S\nBR-00-5562083|Shree Physio Clinic|o|1|h|20201026|M\nBR-00-3132649|Metro General Store|h|1|h|20230608|M\nDL-00-0038055|Coral Kids Academy Pvt Ltd|q|2|5|20230706|M\nWB-00-0308998|Classic Boutique|5|d|a|20240622|M\nMH-00-9517617|Neelgiri Physio Clinic LLP|o|7|g|20250403|D\nTS-00-7893257|Orbit Sweets|w|b|6|20231214|M\nKR-00-5257738|City Printers Pvt Ltd|r|4|1|20230513|S\nKR-00-0348926|Unity Mobile Care|j|4|1|20240914|M\nWB-00-6454694|Sai Mobile Care|j|d|a|20230804|M\nMH-00-0095588|Classic Unisex Salon|u|7|d|20221127|S\nTN-00-9919284|Metro Bakers|3|a|3|20210523|M\nWB-00-3984001|Prime Stationers|v|d|a|20210419|M\nDL-00-6155763|Ganesh Unisex Salon|u|2|5|20211031|S\nDL-00-6424510|Green Leaf Physio Clinic LLP|o|2|5|20230420|M\nWB-00-6554297|Om Stationers|v|d|a|20230217|M\nTN-00-3683999|Sahyadri Legal Associates Pvt Ltd|i|a|3|20260106|S\nGJ-00-1974623|Kaveri Dental Care Pvt Ltd|9|3|k|20210704|M\nAP-00-8901549|Coral Fitness|e|0|l|20220302|M\nMP-00-8316903|Sai Insurance Advisors Pvt Ltd|g|6|2|20230223|S\nRJ-00-5703345|Riddhi Bake House Pvt Ltd|4|9|8|20201113|M\nMH-00-3738447|Ganga Realty|s|7|d|20220811|S\nWB-00-3717076|Riddhi Pharma Retail LLP|n|d|a|20220414|M\nAP-00-5288325|Annapurna Foods Pvt Ltd|c|0|l|20240124|S\nUP-00-6510886|Trinity Unisex Salon|u|c|b|20230601|M\nUP-00-0524490|Trinity Kids Academy Pvt Ltd|q|c|b|20220702|M\nMH-00-2217710|Evergreen General Store|h|7|d|20210202|M\nDL-00-5015104|Annapurna Fashions|0|2|5|20201204|S\nRJ-00-8210517|Vindhya Printers|r|9|8|20251018|M\nKR-00-8116484|Moonlight Medicals|m|4|1|20240102|M\nDL-00-9192763|Star Dental Care Pvt Ltd|9|2|5|20220502|M\nGJ-00-9030923|Sunrise Foods Pvt Ltd|c|3|k|20250418|D\nBR-00-3466695|Navkar Legal Associates LLP|i|1|h|20231001|M\nMH-00-3253545|New Bake House LLP|4|7|d|20260125|M\nTS-00-4887309|City Foods LLP|c|b|6|20250301|M\nKR-00-0702862|Orbit Bakers|3|4|1|20230411|M\nMH-00-1828959|Silver Oak Classes Pvt Ltd|8|7|i|20220312|S\nKR-00-9068443|City Diagnostics|a|4|1|20251128|M\nMH-00-4419742|Galaxy Fashions Pvt Ltd|0|7|d|20240626|M\nBR-00-2518791|Moonlight Opticals|k|1|h|20231129|M\nKR-00-4447815|Vindhya Diagnostics|a|4|e|20250402|S\nBR-00-5588895|Orbit Fitness LLP|e|1|h|20211110|S\nGJ-00-0216108|New Bake House LLP|4|3|0|20240409|M\nDL-00-7690386|Coral Packaging LLP|l|2|5|20220624|S\nMP-00-3722776|Navkar Bakers|3|6|7|20240823|M\nKL-00-0063580|Annapurna Physio Clinic LLP|o|5|9|20221117|M\nGJ-00-2249584|Ganga General Store|h|3|j|20250825|M\nMH-00-5705878|City Fashions Pvt Ltd|0|7|i|20240217|M\nRJ-00-5643018|Kaveri Opticals|k|9|8|20210704|M\nMH-00-5309818|Balaji Stays Pvt Ltd|6|7|g|20220820|M\nKR-00-0639514|Apex Woodcraft|d|4|e|20210331|M\nMP-00-6695639|Metro Hardware|f|6|2|20231119|M\nMH-00-6431613|Zenith Mobile Care|j|7|d|20251121|D\nGJ-00-4592677|Metro Electronics Pvt Ltd|b|3|0|20210827|M\nMH-00-0460540|Green Leaf Unisex Salon|u|7|g|20230830|M\nGJ-00-4164430|Navkar Insurance Advisors Pvt Ltd|g|3|0|20240629|M\nMP-00-1830775|Sai General Store|h|6|7|20240530|S\nKR-00-2503231|Orbit Textiles|x|4|e|20210409|M\nMH-00-5873784|Metro Design Studio Pvt Ltd|1|7|i|20251130|M\nDL-00-7447106|Amrit Kitchens LLP|t|2|5|20250906|M\nKR-00-7125685|Sahyadri Medicals|m|4|1|20250119|M\nMH-00-9392463|Orbit Dental Care|9|7|g|20210629|S\nGJ-00-4867575|Classic Foods LLP|c|3|0|20220331|S\nGJ-00-2606239|Annapurna Woodcraft|d|3|j|20220702|S\nUP-00-5640231|Unity Diagnostics|a|c|b|20241010|M\nKR-00-2570751|Classic Bake House Pvt Ltd|4|4|1|20240114|S\nMH-00-8801667|Ganesh Fashions Pvt Ltd|0|7|f|20251105|M\nKR-00-7019557|Saffron Design Studio|1|4|e|20230422|M\nDL-00-5419860|Green Leaf Packaging|l|2|5|20221016|S\nMH-00-7326338|Neelgiri Kids Academy LLP|q|7|i|20220418|S\nTN-00-8751799|Annapurna Stays Pvt Ltd|6|a|3|20221204|M\nBR-00-4562895|Zenith Textiles Pvt Ltd|x|1|h|20201024|S\nKR-00-9938514|Classic Medicals|m|4|e|20241003|M\nKR-00-5733347|Harmony Design Studio|1|4|1|20250121|M\nTS-00-4541798|Coral Sweets|w|b|6|20230114|M\nGJ-00-4807773|City Packaging|l|3|k|20210625|S\nKR-00-8682554|Balaji Stationers|v|4|1|20210515|M\nDL-00-4375525|Harmony Hardware|f|2|5|20251031|S\nKL-00-4356857|Vindhya Stationers|v|5|9|20241031|M\nGJ-00-6201167|Pearl Opticals|k|3|0|20210407|M\nDL-00-1826147|City Hardware|f|2|5|20240610|M\nKR-00-9656594|Kaveri Diagnostics|a|4|1|20250210|S\nDL-00-9891514|Kaveri Dental Care|9|2|5|20250514|M\nBR-00-3052588|Galaxy Stationers|v|1|h|20221012|M\nMP-00-0912585|Neelgiri Hardware|f|6|2|20201030|M\nUP-00-6244813|Zenith Printers LLP|r|c|b|20221124|S\nGJ-00-2515440|Lakshmi Foods Pvt Ltd|c|3|0|20220304|S\nWB-00-0573732|Royal Stationers|v|d|a|20210424|M\nDL-00-1488761|New Kids Academy LLP|q|2|5|20250408|M\nUP-00-2219206|Classic Fitness LLP|e|c|b|20250904|M\nDL-00-0821903|Sunrise Mobile Care|j|2|5|20260104|M\nMH-00-7183141|Kaveri Stays LLP|6|7|d|20240202|S\nMH-00-6443789|Moonlight Medicals|m|7|i|20240518|M\nTS-00-7042905|Moonlight Dental Care Pvt Ltd|9|b|6|20230815|M\nUP-00-3756061|Pearl Insurance Advisors LLP|g|c|b|20250928|M\nKR-00-8115521|Coral Legal Associates Pvt Ltd|i|4|1|20210621|S\nGJ-00-5113555|Silver Oak Classes|8|3|0|20221030|M\nMP-00-7026520|Blue Lotus Kitchens Pvt Ltd|t|6|7|20240303|M\nDL-00-7576771|New Opticals|k|2|5|20230728|S\nKL-00-0111794|Pearl Printers|r|5|9|20210721|M\nMH-00-9196808|Ganga Stationers|v|7|f|20220112|M\nDL-00-3218561|Moonlight Hardware|f|2|5|20230522|M\nGJ-00-3175096|Galaxy Pharma Retail Pvt Ltd|n|3|0|20250423|M\nPB-00-1496037|Zenith Dental Care Pvt Ltd|9|8|c|20220624|M\nMH-00-5983796|Modern Realty|s|7|i|20230321|S\nKR-00-6452344|Green Leaf Classes Pvt Ltd|8|4|1|20240301|M\nKR-00-1421764|Sahyadri Boutique|5|4|e|20240114|M\nTS-00-9135010|Apex Stationers|v|b|6|20201026|S\nMH-00-9344920|Kaveri General Store|h|7|d|20231024|S\nMH-00-7486244|Evergreen Polymers LLP|p|7|d|20231111|S\nKL-00-3073796|Moonlight Textiles Pvt Ltd|x|5|9|20201016|S\nTN-00-7608046|Saffron Fashions Pvt Ltd|0|a|3|20210714|M\nRJ-00-6548039|Sai Medicals|m|9|8|20260128|M\nMH-00-1120263|Saffron Auto Components|2|7|d|20251110|S\nTN-00-3355252|Star Boutique|5|a|3|20241031|M\nRJ-00-6448278|Harmony Electronics|b|9|8|20251007|S\nTN-00-7369974|Vindhya Mobile Care|j|a|3|20251013|S\nMP-00-1505734|Classic & Associates|7|6|7|20220708|M\nMH-00-3071901|Sahyadri Tours & Travels|y|7|f|20230308|M\nTS-00-1264050|Navkar Opticals|k|b|6|20220417|M\nMH-00-1428024|Royal Bake House Pvt Ltd|4|7|i|20250602|M\nMH-00-1619151|Lakshmi Kitchens Pvt Ltd|t|7|g|20230218|S\nTN-00-9607051|Sahyadri Realty|s|a|3|20230212|M\nRJ-00-8381563|Kaveri Hardware|f|9|8|20211004|M\nMH-00-2859183|Silver Oak General Store|h|7|d|20240404|S\nMH-00-5272356|Royal Unisex Salon|u|7|d|20220802|M\nTN-00-1406078|Metro Unisex Salon|u|a|3|20250822|M\nGJ-00-7050938|Harmony Polymers Pvt Ltd|p|3|k|20230129|M\nMH-00-0807886|Classic Hardware|f|7|f|20201021|S\nPB-00-7032654|Harmony Hardware|f|8|c|20240423|M\nDL-00-2363750|Amrit Legal Associates LLP|i|2|5|20210715|M\nUP-00-7189065|Sunrise Hardware|f|c|b|20250627|S\nAP-00-3577367|Harmony Medicals|m|0|l|20240106|M\nMH-00-6247459|Trinity Medicals|m|7|i|20210719|M\nTN-00-1596494|Unity Boutique|5|a|3|20260129|M\nWB-00-3330429|Om Boutique|5|d|a|20221030|M\nMH-00-9776692|Galaxy General Store|h|7|f|20220319|M\nKR-00-0082039|Classic Packaging LLP|l|4|e|20260103|S\nMP-00-7609780|Sai Auto Components|2|6|2|20250415|S\nMH-00-9141349|Sahyadri Pharma Retail LLP|n|7|d|20230105|M\nGJ-00-8819618|Evergreen Sweets|w|3|j|20251009|M\nKL-00-3652433|Riddhi Packaging Pvt Ltd|l|5|9|20240118|S\nMP-00-4262543|Amrit Kids Academy Pvt Ltd|q|6|2|20231223|M\nMH-00-4344456|Zenith Stays|6|7|f|20240322|S\nTN-00-1872281|Zenith Kids Academy LLP|q|a|3|20240507|M\nAP-00-9762166|Modern Classes LLP|8|0|l|20211114|S\nKR-00-6375735|Royal Unisex Salon|u|4|1|20220528|S\nWB-00-8961916|Orbit Unisex Salon|u|d|a|20220430|M\nDL-00-3790180|Balaji Hardware|f|2|5|20221010|M\nKR-00-9930933|Coral Bakers|3|4|e|20241208|S\nKR-00-3997412|Evergreen General Store|h|4|1|20220408|M\nGJ-00-4974203|Balaji Bakers|3|3|k|20210910|M\nUP-00-4570206|Evergreen Kitchens LLP|t|c|b|20251128|M\nTS-00-7755743|Prime Realty Pvt Ltd|s|b|6|20250110|S\nDL-00-5794984|Shree Stays Pvt Ltd|6|2|5|20250623|M\nRJ-00-0654115|Zenith Stays LLP|6|9|8|20210704|M\nRJ-00-0726004|Balaji Sweets|w|9|8|20231226|M\nGJ-00-6838571|Moonlight Kitchens Pvt Ltd|t|3|0|20240112|S\nTS-00-9243322|Navkar Hardware|f|b|6|20240923|S\nMP-00-1439302|Green Leaf Stays|6|6|2|20240703|M\nMH-00-2706986|Galaxy Kitchens Pvt Ltd|t|7|i|20230624|M\nMH-00-5900509|Vindhya Legal Associates Pvt Ltd|i|7|d|20221025|M\nTN-00-9468010|Classic Electronics|b|a|3|20210528|S\nGJ-00-5260583|Navkar Sweets|w|3|j|20211227|M\nMH-00-9985340|Classic Hardware|f|7|d|20250303|S\nRJ-00-6190089|Zenith Unisex Salon|u|9|8|20230519|M\nKL-00-5402832|Amrit Opticals|k|5|9|20250224|M\nTN-00-5309220|City Sweets|w|a|3|20210601|S\nTN-00-1157245|Shree Boutique|5|a|3|20211108|S\nKR-00-1718785|Annapurna Physio Clinic|o|4|e|20220811|M\nUP-00-7814140|Galaxy Medicals|m|c|b|20201215|M\nMH-00-8072336|Blue Lotus Auto Components|2|7|i|20250412|S\nMH-00-8970768|Modern Textiles|x|7|d|20220606|S\nRJ-00-7992858|Sai Fashions Pvt Ltd|0|9|8|20240820|S\nWB-00-1009364|Royal Classes LLP|8|d|a|20211208|M\nMH-00-3920120|Evergreen Bakers|3|7|i|20210322|S\nWB-00-9712273|Om Foods|c|d|a|20230506|S\nTS-00-7079452|Harmony Hardware|f|b|6|20230127|M\nGJ-00-9917008|Apex Stationers|v|3|0|20241002|M\nTN-00-2002389|Lakshmi Boutique|5|a|3|20250225|M\nDL-00-0813686|City Physio Clinic|o|2|5|20220715|S\nGJ-00-9111090|Sai Sweets|w|3|0|20240229|M\nTS-00-1922845|Metro Stays|6|b|6|20210114|M\nGJ-00-5369481|Orbit Hardware|f|3|k|20241125|D\nGJ-00-3034560|Silver Oak Fashions|0|3|0|20240913|M\nAP-00-2373202|Annapurna Medicals|m|0|l|20230703|M\nTN-00-2929298|Om Hardware|f|a|3|20240618|M\nDL-00-9554985|Riddhi Textiles LLP|x|2|5|20210602|S\nTS-00-0356286|Navkar Dental Care|9|b|6|20240627|M\nDL-00-0436687|Ganesh Diagnostics LLP|a|2|5|20251017|S\nBR-00-7954443|Zenith Classes Pvt Ltd|8|1|h|20230831|D\nPB-00-0675427|Blue Lotus Mobile Care|j|8|c|20210717|M\nWB-00-9279056|Sunrise Hardware|f|d|a|20210805|M\nKR-00-6946581|Krishna Dental Care Pvt Ltd|9|4|1|20220214|S\nKR-00-7080084|Sai Diagnostics Pvt Ltd|a|4|1|20230110|M\nTN-00-0901999|Orbit Stationers|v|a|3|20201230|S\nKR-00-8822688|City Stationers|v|4|e|20210220|M\nTN-00-9666472|Saffron Packaging Pvt Ltd|l|a|4|20230720|S\nTS-00-8434256|Classic Medicals|m|b|6|20250406|M\nMH-00-1990031|Amrit & Associates|7|7|d|20240826|S\nGJ-00-5720955|Krishna Stationers|v|3|k|20201113|M\nKR-00-7467649|Orbit Mobile Care|j|4|1|20221104|M\nMH-00-4303631|Kaveri Packaging LLP|l|7|i|20240211|S\nKR-00-5425011|Ganesh Stationers|v|4|e|20220411|S\nTN-00-6395474|Vindhya Woodcraft Pvt Ltd|d|a|4|20220427|D\nDL-00-2862538|Neelgiri Realty|s|2|5|20230106|M\nAP-00-5388787|Silver Oak Electronics|b|0|l|20210809|M\nRJ-00-3139641|Unity Medicals|m|9|8|20201120|M\nDL-00-2712598|Balaji Stationers|v|2|5|20210515|M\nRJ-00-0110136|Evergreen Unisex Salon|u|9|8|20201019|S\nBR-00-3902504|Coral Stationers|v|1|h|20210309|M\nMP-00-8674504|Trinity Opticals|k|6|2|20220916|M\nGJ-00-0797401|Ganesh Insurance Advisors|g|3|0|20210918|M\nDL-00-0637642|Classic Bakers|3|2|5|20201204|M\nTN-00-6590592|Ganga Bake House Pvt Ltd|4|a|3|20210127|S\nKR-00-8472734|Neelgiri Bake House LLP|4|4|1|20251022|M\nDL-00-9293266|Blue Lotus Dental Care LLP|9|2|5|20231109|S\nMH-00-6779618|Zenith & Associates|7|7|d|20250902|M\nMH-00-1725974|Sai Stationers|v|7|f|20210409|S\nMH-00-9270291|Balaji Pharma Retail|n|7|i|20211216|M\nMP-00-2414212|Pearl Kids Academy|q|6|7|20240828|M\nWB-00-1313089|Royal & Associates Pvt Ltd|7|d|a|20230808|M\nGJ-00-3106557|Royal Sweets|w|3|j|20241110|M\nKR-00-0972210|Krishna Bakers|3|4|1|20250926|M\nKR-00-7583052|Kaveri Kids Academy Pvt Ltd|q|4|1|20201010|M\nKR-00-0065232|Vindhya Boutique|5|4|1|20210530|M\nAP-00-4546155|Galaxy Hardware|f|0|l|20231026|M\nUP-00-2443762|Amrit Medicals|m|c|b|20250602|M\nPB-00-5225926|Apex Printers|r|8|c|20230804|S\nPB-00-0035494|Om & Associates|7|8|c|20230924|M\nPB-00-0438743|Coral Physio Clinic|o|8|c|20240215|S\nKR-00-2049579|Lakshmi Realty|s|4|1|20220817|M\nMH-00-1428494|Apex Stationers|v|7|d|20250129|M\nGJ-00-4618463|Classic General Store|h|3|0|20260130|M\nDL-00-4475092|Ganga Stationers|v|2|5|20210807|M\nAP-00-9751562|Kaveri Insurance Advisors|g|0|l|20240824|M\nKR-00-6228837|Modern Boutique|5|4|1|20240421|M\nKR-00-8825024|Orbit Kitchens|t|4|1|20250703|M\nWB-00-5714288|New Medicals|m|d|a|20240624|S\nGJ-00-8779194|Green Leaf General Store|h|3|0|20220822|M\nWB-00-6366162|Green Leaf Medicals|m|d|a|20240713|S\nTN-00-1698637|Amrit Electronics|b|a|3|20210626|S\nTS-00-1917399|Krishna Realty LLP|s|b|6|20210602|M\nUP-00-0621417|Zenith Textiles Pvt Ltd|x|c|b|20250202|S\nDL-00-9318720|Orbit Kitchens|t|2|5|20230917|M\nKR-00-2537765|Krishna Electronics|b|4|e|20220222|M\nKR-00-5252547|Star Electronics Pvt Ltd|b|4|e|20230410|M\nMH-00-1300353|Moonlight Stationers|v|7|f|20230130|D\nMP-00-5750585|Galaxy Bakers|3|6|2|20250503|M\nAP-00-5225037|Prime Bake House|4|0|l|20201222|M\nPB-00-3541641|Moonlight Medicals|m|8|c|20251228|M\nGJ-00-6625370|Apex Polymers|p|3|j|20250126|S\nRJ-00-6642897|Green Leaf Boutique|5|9|8|20230718|M\nKL-00-1995177|Lakshmi Packaging Pvt Ltd|l|5|9|20210409|S\nBR-00-4452034|Classic Opticals|k|1|h|20220620|M\nKR-00-6343549|Vindhya Bakers|3|4|1|20250112|M\nMH-00-4776642|Saffron Boutique|5|7|i|20221101|S\nKR-00-9207563|Coral Stationers|v|4|1|20210519|S\nMH-00-4203165|City Legal Associates|i|7|f|20210620|S\nMH-00-7412499|Royal Polymers|p|7|d|20221029|S\nDL-00-7318182|Sunrise Stationers|v|2|5|20230519|D\nMP-00-2761864|Silver Oak Pharma Retail|n|6|7|20210826|M\nDL-00-7281875|Star Diagnostics LLP|a|2|5|20231005|M\nDL-00-9794040|Royal Bake House|4|2|5|20210210|M\nTN-00-8519504|Annapurna Medicals|m|a|3|20230727|D\nGJ-00-3624446|Zenith Printers|r|3|k|20201217|S\nDL-00-8982632|Harmony Design Studio Pvt Ltd|1|2|5|20250328|M\nMH-00-6318751|Evergreen & Associates LLP|7|7|d|20230215|M\nGJ-00-2650737|Royal Diagnostics Pvt Ltd|a|3|k|20250529|M\nGJ-00-2536408|Sunrise Mobile Care|j|3|k|20250420|M\nAP-00-3102173|Evergreen Printers Pvt Ltd|r|0|l|20240401|S\nPB-00-1199660|Moonlight Sweets|w|8|c|20211028|M\nMH-00-3100721|Orbit Physio Clinic Pvt Ltd|o|7|d|20230123|M\nMH-00-3554357|Amrit Fitness Pvt Ltd|e|7|g|20201104|S\nMH-00-5394981|Modern Tours & Travels|y|7|d|20220708|S\nMH-00-4308471|Moonlight Polymers LLP|p|7|d|20221227|S\nKL-00-8937341|Classic Hardware|f|5|9|20241125|S\nDL-00-1456296|Green Leaf Fashions Pvt Ltd|0|2|5|20221111|M\nTS-00-7372861|Prime Dental Care LLP|9|b|6|20250708|M\nKL-00-5189876|Pearl Realty Pvt Ltd|s|5|9|20230610|S\nKL-00-6309524|Coral Dental Care LLP|9|5|9|20221218|S\nBR-00-8639550|Unity Electronics Pvt Ltd|b|1|h|20230128|M\nKR-00-3422543|Modern Opticals|k|4|e|20211029|M\nMH-00-0672638|Silver Oak Medicals|m|7|d|20201206|M\nKR-00-8003605|Blue Lotus Sweets|w|4|1|20230202|M\nDL-00-6684980|Ganga Electronics LLP|b|2|5|20220201|S\nWB-00-3969122|Sunrise Electronics|b|d|a|20220322|M\nTS-00-0354696|Ganesh Auto Components Pvt Ltd|2|b|6|20230517|S\nGJ-00-7056246|Silver Oak Sweets|w|3|j|20250129|S\nDL-00-5578169|Apex Kitchens LLP|t|2|5|20250528|M\nDL-00-5892450|Om Legal Associates|i|2|5|20220103|S\nKR-00-2444595|Royal Diagnostics LLP|a|4|1|20210509|M\nTN-00-3199869|Royal Realty|s|a|3|20230228|D\nTS-00-7651013|Navkar General Store|h|b|6|20231120|M\nRJ-00-6205791|Evergreen Medicals|m|9|8|20220208|M\nTN-00-4348980|Amrit Electronics LLP|b|a|3|20230417|S\nTN-00-5681411|Om Kids Academy|q|a|3|20250520|M\nMH-00-0420885|Sahyadri Tours & Travels LLP|y|7|i|20240924|D\nMP-00-5515546|Silver Oak General Store|h|6|2|20260128|M\nDL-00-7341792|Classic Fashions Pvt Ltd|0|2|5|20240821|M\nTN-00-8043262|Ganesh Unisex Salon|u|a|4|20250221|M\nTS-00-6689396|Moonlight Mobile Care|j|b|6|20250614|S\nGJ-00-4952609|Sai Kitchens LLP|t|3|k|20211219|M\nBR-00-6576463|Annapurna Fashions LLP|0|1|h|20220104|M\nMH-00-3877164|Amrit Kitchens|t|7|g|20240519|M\nMH-00-0907991|Lakshmi Insurance Advisors|g|7|f|20250926|S\nDL-00-3337581|Krishna Classes|8|2|5|20230714|S\nWB-00-1806547|City Bake House|4|d|a|20250515|M\nGJ-00-4391375|Royal Kitchens LLP|t|3|0|20221218|M\nMH-00-0182805|Silver Oak Sweets|w|7|i|20210911|M\nTN-00-7924606|Modern Boutique|5|a|4|20210428|M\nDL-00-6036692|Navkar Tours & Travels LLP|y|2|5|20211207|M\nKR-00-5920003|Navkar Hardware|f|4|1|20220221|M\nGJ-00-0093011|Zenith Sweets|w|3|j|20250201|M\nTS-00-2433887|Sai Kitchens|t|b|6|20241113|M\nMH-00-7832316|Coral Pharma Retail Pvt Ltd|n|7|d|20230625|M\nKR-00-2069600|Unity Hardware|f|4|e|20211006|M\nDL-00-7208712|Star Opticals|k|2|5|20210319|S\nTS-00-5172215|Classic Sweets|w|b|6|20240109|M\nMH-00-2672320|Zenith Realty|s|7|f|20240821|M\nPB-00-7954210|Annapurna Kitchens Pvt Ltd|t|8|c|20240316|M\nTN-00-8250266|Silver Oak Auto Components Pvt Ltd|2|a|3|20230107|D\nTN-00-5486449|Saffron Pharma Retail Pvt Ltd|n|a|4|20211103|S\nTS-00-1825541|Amrit General Store|h|b|6|20201023|M\nMH-00-6640387|Vindhya Stays Pvt Ltd|6|7|d|20241225|M\nGJ-00-3242798|Riddhi Medicals|m|3|j|20240309|M\nWB-00-3455588|Evergreen Classes|8|d|a|20230322|M\nTN-00-8789510|Sahyadri Classes LLP|8|a|3|20230407|S\nBR-00-3080201|Kaveri General Store|h|1|h|20240115|M\nTN-00-0720606|Green Leaf Bakers|3|a|3|20221013|M\nTS-00-2388998|Silver Oak Mobile Care|j|b|6|20241115|M\nPB-00-3950656|Ganga Stays|6|8|c|20231030|S\nMH-00-4179870|Classic Kitchens Pvt Ltd|t|7|d|20251014|M\nMP-00-6630898|Moonlight Polymers Pvt Ltd|p|6|7|20220720|M\nMH-00-4290596|Blue Lotus Fashions|0|7|i|20260125|M\nMH-00-8027987|Prime Realty Pvt Ltd|s|7|d|20230927|M\nMP-00-5118671|Silver Oak Hardware|f|6|2|20250929|M\nMP-00-8767933|Om Bake House|4|6|2|20210313|M\nDL-00-7659807|Krishna Stationers|v|2|5|20241116|M\nWB-00-7615804|Pearl Opticals|k|d|a|20221003|M\nTN-00-6968249|Evergreen Sweets|w|a|3|20240104|M\nMH-00-8496986|Shree General Store|h|7|d|20240919|M\nDL-00-4764543|Saffron Opticals|k|2|5|20211022|S\nMP-00-0200312|Apex Stationers|v|6|2|20250922|S\nMH-00-7942592|Harmony Legal Associates|i|7|i|20230607|M\nGJ-00-0051000|Modern Design Studio LLP|1|3|j|20201114|S\nTS-00-8199565|Navkar Kitchens|t|b|6|20250825|M\nPB-00-2442981|Pearl Auto Components|2|8|c|20221208|M\nPB-00-4096754|Metro Tours & Travels|y|8|c|20241122|S\nUP-00-5534873|Galaxy Boutique|5|c|b|20240925|M\nDL-00-1627026|Modern Boutique|5|2|5|20240723|M";
const UDYAM_NUMBER_PREFIX = "UDYAM-";
let udyamRegistryIndex = null;

/**
 * Finds a Udyam number ("UDYAM-KL-00-3078801") in the embedded registry (index built on first use). Returns a record
 * shaped like a GST record so the rest of onboarding works the same: no constitution, and status Active because the
 * Udyam registry has no status field. Returns null when the number isn't there.
 */
function findUdyamRecord(udyamNumber) {
  if (!udyamRegistryIndex) {
    udyamRegistryIndex = {};
    UDYAM_REGISTRY_TEXT.split("\n").forEach((line) => {
      if (!line) return;
      const fields = line.split("|");
      udyamRegistryIndex[UDYAM_NUMBER_PREFIX + fields[0]] = fields;
    });
  }
  const fields = udyamRegistryIndex[udyamNumber];
  if (!fields) return null;
  const date = fields[5];
  return {
    entryType: ENTRY_TYPE.UDYAM,
    tradeName: fields[1],
    status: STATUS.ACTIVE,
    constitution: "",
    nicDescription: NIC_DESCRIPTIONS[parseInt(fields[2], 36)][0],
    state: STATE_NAMES[parseInt(fields[3], 36)] || "",
    city: CITY_NAMES[parseInt(fields[4], 36)] || "",
    registrationDate: new Date(
      Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))),
    ),
  };
}

/**
 * The real pricing function (price_bundle main), embedded unchanged by the build in its own scope. Every bundle
 * and price in this file comes from it. Never write prices here.
 */
const priceBundleMain = (function embeddedPriceBundle() {
/*
 * price_bundle.js: Voiceflow function tool "price_bundle" (TEMPLATE; the build injects the catalogue).
 *
 * What it does: turns what Saathi learned about a business (type, size, city, needs, GST status) into ONE
 * recommended bundle with exact quantities, monthly price, setup fee, plan length and install time.
 *
 * How it fits: the "Bundle advisor" playbook calls it for every recommendation and every change (cheaper,
 * add, remove). It is the ONLY source of prices in the chatbot ("rules decide, GenAI explains"), so the AI can
 * never invent a number. _build/gen_kit.py injects the 25-product catalogue from the case pack
 * (product_catalogue.csv, synthetic data) and writes the finished file to 3_function_tools/.
 *
 * Pricing rules (from the deck and the case data):
 *  - Price = catalogue floor price (price_min) for the committed term.
 *  - Plan length = the longest minimum term among the items (or longer if the owner asks).
 *  - Install time = the slowest item's typical install days.
 *  - Activation promise (STRATEGY.md §11), decided here at quote time and shown on the card: "Connected in 72 hours,
 *    guaranteed" only for orders inside GUARANTEE_SCOPE; every other order gets a firm number of days from the case
 *    data (ACTIVATION_PROMISE_DATA, injected by the build). Missing either one makes month one free. order_status
 *    reads the promise from this quote, so the tracker always enforces what the card showed.
 */

/**
 * Voiceflow entry point: builds the quote and shows it as a chat card.
 *
 * @param {{inputVars?: Object<string, string>}} args  Voiceflow passes every input as text. All are optional;
 *   the useful ones are business_type, city, employees, sites, has_gstin and needs. See 3_function_tools/TOOL_SETUP.md.
 * @returns {{outputVars: Object, trace: Array}}  Always returns every declared output; `error` is filled on failure.
 * @example
 *   await main({ inputVars: { business_type: "Diagnostic lab", city: "Delhi", employees: "16", has_gstin: "yes",
 *     needs: "failover, email, storage, security", lang: "hi" } })
 *   // → outputVars.bundle_name "Office Pro", outputVars.monthly_total 6138, promise_type "firm_date" (16 people is
 *   //   above the 72-hour scope), promise_days 7
 */
async function main(args) {
  const inputVars = (args && args.inputVars) || {};
  const outputVars = {
    bundle_name: "",
    monthly_total: 0,
    setup_total: 0,
    contract_months: 0,
    install_days: 0,
    quote_text: "",
    why_text: "",
    blocked_text: "",
    budget_note: "",
    items_json: "[]",
    segment_code: "",
    promise_type: "",
    promise_hours: 0,
    promise_days: 0,
    promise_text: "",
    promise_reasons: "",
    error: "",
  };
  try {
    const quote = buildQuote(inputVars);
    outputVars.promise_type = quote.promise.type;
    outputVars.promise_hours = quote.promise.hours;
    outputVars.promise_days = quote.promise.days;
    outputVars.promise_text = quote.promise.text;
    outputVars.promise_reasons = quote.promise.reasonsText;
    outputVars.bundle_name = quote.bundleName;
    outputVars.monthly_total = quote.monthlyTotalInRupees;
    outputVars.setup_total = quote.setupTotalInRupees;
    outputVars.contract_months = quote.contractMonths;
    outputVars.install_days = quote.installDays;
    outputVars.quote_text = quote.quoteText;
    outputVars.why_text = quote.whyText;
    outputVars.blocked_text = quote.blockedText;
    outputVars.budget_note = quote.budgetNote;
    outputVars.items_json = JSON.stringify(
      quote.items.map((item) => ({
        id: item.productId,
        name: item.product.name,
        qty: item.quantity,
        monthly: item.quantity * item.product.monthlyPriceFloorInRupees,
      })),
    );
    outputVars.segment_code = quote.segment;
    const shouldShowCard = String(inputVars.show_card || "yes").toLowerCase() !== "no";
    return {
      outputVars,
      trace: shouldShowCard ? [{ type: "text", payload: { message: quote.quoteText } }] : [],
    };
  } catch (error) {
    outputVars.error = MESSAGES.errorPrefix + (error && error.message ? error.message : String(error));
    return { outputVars, trace: [] };
  }
}

// ================================================================ CONFIG

/** Catalogue product IDs (product_catalogue.csv). Named so the rules below read as words, not codes. */
const PRODUCT = {
  BIZ_FIBRE_100: "P01",
  BIZ_FIBRE_300: "P02",
  BIZ_FIBRE_1G: "P03",
  AIRFIBER_5G: "P04",
  LEASED_LINE_20: "P05",
  LEASED_LINE_100: "P06",
  POSTPAID_299: "P07",
  POSTPAID_599: "P08",
  FAILOVER_4G_5G: "P09",
  MANAGED_SD_WAN: "P10",
  STATIC_IP: "P11",
  CLOUD_TELEPHONY: "P12",
  TOLL_FREE_NUMBER: "P13",
  BUSINESS_SMS: "P14",
  WHATSAPP_API: "P15",
  CLOUD_EMAIL: "P16",
  CLOUD_BACKUP_1TB: "P17",
  WEBSITE_DOMAIN: "P18",
  CLOUD_POS: "P19",
  ENDPOINT_SECURITY: "P20",
  MANAGED_FIREWALL: "P21",
  SECURE_WIFI: "P22",
  CLOUD_CCTV: "P23",
  MACHINE_IOT: "P24",
  FLEET_TRACKER: "P25",
};

/** Segment codes used across the kit (match the case's four segments, Appendix A2). */
const SEGMENT = { MICRO: "micro", PROFESSIONAL: "prof", MULTI_SITE: "multi", MANUFACTURER: "mfg" };

/** Bundle names shown to owners; defined in the submission deck (slide "Who we win first"). */
const BUNDLE_NAME_BY_SEGMENT = {
  micro: "Dukaan Digital",
  prof: "Office Pro",
  multi: "Chain Connect",
  mfg: "Factory Assured",
};

/** Tier-1 cities in smb_leads.csv (city_tier = 1) plus their common alternative spellings. */
const TIER_1_CITY_NAMES = [
  "delhi",
  "new delhi",
  "mumbai",
  "bombay",
  "bengaluru",
  "bangalore",
  "chennai",
  "madras",
  "hyderabad",
  "kolkata",
  "calcutta",
  "pune",
  "ahmedabad",
];

/**
 * Scope of "Connected in 72 hours, guaranteed" (STRATEGY.md §11). Decided at quote time from what is known then; an
 * order qualifies only when EVERY condition holds. Evidence: the 368 activated leads in smb_leads.csv, days from KYC
 * complete (order confirmed) to activation:
 *  - cityTiers: tier-1 cities went live within 3 days 57% of the time, tier-2 cities 31%.
 *  - maxEmployees, maxSites: in tier 1, businesses with ≤ 10 people on 1 site went live within 3 days 73% of the time
 *    (99 orders); bigger tier-1 businesses 44%. This is the best group known at quote time; none reaches 90%.
 *  - connectionProductIds: fibre up to 300 Mbps and 5G AirFiber install at street level (catalogue: 2–5 days, and
 *    AirFiber can bridge fibre). 1 Gbps fibre and leased lines need a site survey (catalogue: 7–30 days).
 *  - requiresAirFiberCoverage: AirFiber is the bridge when the fibre install slips, and the fallback when the site
 *    turns out not to be feasible for fibre (41 confirmed orders in the case data dropped for that reason).
 * Expected cost (6_tests/measure_promise_scope.mjs): 23.5% of confirmed orders qualify. The guarantee is missed on
 * 27% of qualifying activated orders, but their bills are the smallest (median ₹2,620/month). Credits per 1,000
 * orders fall from ₹93 lakh (72 hours for everyone) to ₹52 lakh.
 */
const GUARANTEE_SCOPE = {
  hours: 72,
  cityTiers: [1],
  maxEmployees: 10,
  maxSites: 1,
  connectionProductIds: [PRODUCT.BIZ_FIBRE_100, PRODUCT.BIZ_FIBRE_300, PRODUCT.AIRFIBER_5G],
  requiresAirFiberCoverage: true,
};

/** promise_type values. firm_date = a number of days from the case data, with the same month-one-free promise. */
const PROMISE_TYPE = { GUARANTEED_72H: "guaranteed_72h", FIRM_DATE: "firm_date" };
/** Why an order is outside the 72-hour scope (codes in promise_reasons, read by the agent and the tests). */
const PROMISE_SCOPE_REASON = {
  CITY_TIER: "city_tier",
  TEAM_SIZE: "team_size",
  SITES: "sites",
  CONNECTION: "connection",
  AIRFIBER_COVERAGE: "airfiber_coverage",
};
const HOURS_PER_DAY = 24;

/**
 * SIMULATED: cities with 5G AirFiber coverage. The case pack has no coverage data and the leads have no pincode (the
 * registry's pincodes are random), so this lists every city in the case data: the catalogue sells AirFiber in both
 * tiers. Production replaces it with a pincode-level coverage lookup; the airfiber_available input ("no") already
 * lets a feasibility check overrule it.
 */
const AIRFIBER_COVERAGE_CITY_NAMES = TIER_1_CITY_NAMES.concat([
  "kochi",
  "cochin",
  "ludhiana",
  "nagpur",
  "jaipur",
  "visakhapatnam",
  "vizag",
  "lucknow",
  "bhopal",
  "indore",
  "surat",
  "vadodara",
  "baroda",
  "nashik",
  "patna",
  "coimbatore",
  "mysuru",
  "mysore",
]);

/** Thresholds that decide segment and connectivity. Design choices, tuned against the bundles in smb_leads.csv. */
const THRESHOLDS = {
  /** 3+ sites makes a business "multi-site" (case Appendix A2: "3–10 store retailer"). */
  sitesForMultiSite: 3,
  /** With no recognisable business type, this many employees or more → treated as a professional office. */
  employeesForProfessionalWhenTypeUnknown: 6,
  /** Team size assumed only for the segment guess when the employee count is missing. */
  employeesAssumedForSegmentGuess: 3,
  /** Offices this size or smaller get Biz Fibre 100 instead of 300. */
  maxEmployeesForBizFibre100InOffices: 5,
  /** Multi-site: more than this many employees per site → Biz Fibre 300 per site. */
  employeesPerSiteNeedingBizFibre300: 15,
  /** Offices this size or bigger get 4G/5G failover even if they didn't ask (downtime hurts a whole team). */
  officeTeamSizeForDefaultFailover: 8,
  /** Factories this size or bigger can get the 100 Mbps leased line when they ask for speed. */
  employeesForLeasedLine100: 25,
  /** City tier assumed when no city is given (tier 2 is the conservative choice: fewer products). */
  defaultCityTier: 2,
};

/**
 * Quantity sizing. Ratios fitted to the median quantities bought by activated leads in smb_leads.csv,
 * e.g. professional offices: ~3 business lines and ~7 email users for ~14 employees.
 */
const SIZING = {
  defaultEmployeesBySegment: { micro: 2, prof: 8, multi: 40, mfg: 40 },
  microMaxEmployeesForOneLine: 2,
  microLinesForTinyShop: 1,
  microLinesOtherwise: 2,
  employeesPerLine: { prof: 5, multi: 18, mfg: 20 },
  minLines: { prof: 2, multi: 2, mfg: 2 },
  maxLines: { prof: 8, multi: 10, mfg: 10 },
  emailShareOfStaff: { prof: 0.6, mfg: 0.13, multi: 0.15 },
  minimumEmailUsers: 3,
  minimumEmailUsersMicro: 1,
  securedDeviceShareOfStaff: { prof: 0.4, mfg: 0.1 },
  minimumSecuredDevices: { prof: 2, mfg: 3 },
  maxSecuredDevicesOtherSegments: 3,
  multiSiteCamerasPerSite: 1.5,
  defaultCameras: { mfg: 5, other: 2 },
  defaultCountersPerSite: 1,
  defaultMachines: 10,
  defaultVehicles: 4,
  employeesPerTelephonyChannel: 6,
  minTelephonyChannels: 2,
  maxTelephonyChannels: 3,
};

/** Order in which optional items are removed to fit a budget: nice-to-haves first; connection and lines never. */
const BUDGET_TRIM_ORDER = [
  PRODUCT.CLOUD_BACKUP_1TB,
  PRODUCT.ENDPOINT_SECURITY,
  PRODUCT.WEBSITE_DOMAIN,
  PRODUCT.SECURE_WIFI,
  PRODUCT.CLOUD_CCTV,
  PRODUCT.TOLL_FREE_NUMBER,
  PRODUCT.WHATSAPP_API,
  PRODUCT.BUSINESS_SMS,
  PRODUCT.FAILOVER_4G_5G,
  PRODUCT.CLOUD_TELEPHONY,
  PRODUCT.STATIC_IP,
  PRODUCT.CLOUD_EMAIL,
  PRODUCT.CLOUD_POS,
  PRODUCT.MACHINE_IOT,
  PRODUCT.FLEET_TRACKER,
  PRODUCT.MANAGED_SD_WAN,
  PRODUCT.MANAGED_FIREWALL,
];

/** Words recognised in the owner's answers. Short words (≤ 4 letters) only match as whole words. */
const YES_WORDS = ["yes", "y", "true", "1", "haan", "ha", "हाँ", "हां", "han", "active"];
const NO_WORDS = ["no", "n", "false", "0", "nahi", "nahin", "नहीं", "na"];
const SHORT_KEYWORD_MAX_LENGTH = 4;

const SEGMENT_KEYWORDS = {
  segmentInputMicro: ["micro", "retail & services", "kirana", "shop"],
  segmentInputProfessional: ["prof", "office"],
  segmentInputMultiSite: ["multi", "chain"],
  segmentInputManufacturer: ["mfg", "manufactur", "factory"],
  multiSite: ["chain", "branches", "outlets", "group", "franchise"],
  manufacturer: [
    "factory",
    "manufactur",
    "unit",
    "plant",
    "workshop",
    "textile",
    "auto-part",
    "auto part",
    "fabricat",
    "packaging",
    "moulding",
    "molding",
    "printing press",
    "food processing",
    "furniture",
  ],
  professional: [
    "clinic",
    "dental",
    "dentist",
    "doctor",
    "diagnostic",
    "lab",
    "physio",
    "ca firm",
    "chartered",
    "accountant",
    "law",
    "legal",
    "advocate",
    "lawyer",
    "coaching",
    "tuition",
    "institute",
    "insurance",
    "travel",
    "architect",
    "studio",
    "real estate",
    "consult",
    "agency",
    "office",
  ],
  micro: [
    "kirana",
    "grocery",
    "general store",
    "salon",
    "parlour",
    "parlor",
    "pharmacy",
    "chemist",
    "medical store",
    "bakery",
    "boutique",
    "hardware",
    "mobile",
    "optician",
    "stationery",
    "sweet",
    "shop",
    "store",
    "cafe",
    "tea",
    "dhaba",
  ],
  /** Multi-site businesses that sell at a counter get Cloud POS by default. */
  retailOrFood: [
    "retail",
    "restaurant",
    "bakery",
    "pharmacy",
    "apparel",
    "electronics",
    "store",
    "outlet",
    "shop",
    "cafe",
    "sweet",
  ],
};

/** Need keywords the agent passes in `needs` (see TOOL_SETUP.md), with the everyday words owners use. */
const NEED_KEYWORDS = {
  failover: [
    "failover",
    "uptime",
    "never stop",
    "never down",
    "always on",
    "outage",
    "downtime",
    "redundan",
    "backup internet",
    "backup line",
    "backup connection",
    "net backup",
  ],
  email: ["email", "e-mail", "mail", "office suite", "workspace", "microsoft", "outlook"],
  storage: ["storage", "cloud backup", "data backup", "records", "files", "backup"],
  security: ["security", "antivirus", "virus", "cyber", "endpoint", "malware"],
  firewall: ["firewall"],
  pos: ["pos", "billing", "invoice", "counter", "point of sale"],
  cctv: ["cctv", "camera", "surveillance"],
  wifi: ["wifi", "wi-fi", "guest"],
  whatsapp: ["whatsapp", "catalogue", "catalog", "broadcast"],
  sms: ["sms", "reminder", "text message"],
  website: ["website", "domain", "online presence", "web site"],
  telephony: ["telephony", "calls", "ivr", "call centre", "call center", "landline", "extension", "sip"],
  tollfree: ["toll-free", "toll free", "tollfree", "1800"],
  staticip: ["static ip", "staticip", "remote access", "server", "cctv remote"],
  iot: ["iot", "machine", "sensor", "monitoring"],
  fleet: ["fleet", "vehicle", "gps", "truck", "delivery bike", "tracking van"],
  sdwan: ["sd-wan", "sdwan", "central management", "one network", "centrally"],
  leased: ["leased", "dedicated", "ill"],
  highspeed: ["1 gbps", "1gbps", "gigabit", "heavy files", "large files", "high speed", "fastest"],
};

/** "backup" + one of these words means a backup INTERNET line (failover), not data backup. */
const BACKUP_INTERNET_WORDS = ["internet", "line", "connection", "net", "4g", "5g"];
/** Words that mean "mobile lines" when the owner asks to add some. */
const MOBILE_LINE_WORDS = ["sim", "line", "mobile", "postpaid"];

/** Which product a need keyword adds (used when the owner says "add cctv"). */
const PRODUCT_BY_NEED = {
  failover: PRODUCT.FAILOVER_4G_5G,
  email: PRODUCT.CLOUD_EMAIL,
  storage: PRODUCT.CLOUD_BACKUP_1TB,
  security: PRODUCT.ENDPOINT_SECURITY,
  firewall: PRODUCT.MANAGED_FIREWALL,
  pos: PRODUCT.CLOUD_POS,
  cctv: PRODUCT.CLOUD_CCTV,
  wifi: PRODUCT.SECURE_WIFI,
  whatsapp: PRODUCT.WHATSAPP_API,
  sms: PRODUCT.BUSINESS_SMS,
  website: PRODUCT.WEBSITE_DOMAIN,
  telephony: PRODUCT.CLOUD_TELEPHONY,
  tollfree: PRODUCT.TOLL_FREE_NUMBER,
  staticip: PRODUCT.STATIC_IP,
  iot: PRODUCT.MACHINE_IOT,
  fleet: PRODUCT.FLEET_TRACKER,
  sdwan: PRODUCT.MANAGED_SD_WAN,
};

/** How many reasons appear in the "Why:" line. */
const MAX_REASONS_SHOWN = 3;

// ================================================================ MESSAGES (all user-facing text)

const MESSAGES = {
  errorPrefix: "price_bundle failed: ",
  en: {
    perMonth: "/month",
    oneTimeSetup: "One-time setup",
    noSetupFee: "No setup fee",
    monthPlanSuffix: "-month plan",
    liveInDays: "live in about {days} days",
    gstExtra: "GST extra",
    notAdded: "Not added",
    whyPrefix: "Why: ",
    budgetFitted: "To fit {budget} we removed/changed: ",
    budgetLowestPossible: "Lowest possible: {total}/month (essentials only)",
    promiseGuaranteed72h: "✅ Connected in 72 hours, guaranteed, or month one is free",
    promiseFirmDate: "✅ Connected within {days} days of your order, guaranteed, or month one is free",
  },
  hi: {
    perMonth: "/माह",
    oneTimeSetup: "एक बार का सेटअप",
    noSetupFee: "कोई सेटअप शुल्क नहीं",
    monthPlanSuffix: " महीने का प्लान",
    liveInDays: "लगभग {days} दिनों में चालू",
    gstExtra: "GST अलग",
    notAdded: "शामिल नहीं",
    whyPrefix: "क्यों: ",
    budgetFitted: "बजट {budget} में फिट करने के लिए हटाया/बदला: ",
    budgetLowestPossible: "सबसे कम संभव: {total}/माह (सिर्फ़ ज़रूरी चीज़ें)",
    promiseGuaranteed72h: "✅ 72 घंटे में कनेक्शन की गारंटी, वरना पहला महीना मुफ़्त",
    promiseFirmDate: "✅ ऑर्डर के {days} दिनों के अंदर कनेक्शन की गारंटी, वरना पहला महीना मुफ़्त",
  },
  /**
   * Why an order is outside the 72-hour scope, in English inside promise_reasons (like blocked_text): the agent
   * explains it in the owner's language only if asked, and never promises 72 hours instead.
   */
  promiseScopeReasons: {
    city_tier: "the 72-hour guarantee covers tier-1 cities only",
    team_size: "the 72-hour guarantee covers businesses of up to {count} people",
    sites: "the 72-hour guarantee covers single-site businesses",
    connection: "{name} needs a site survey before installation",
    airfiber_coverage: "5G AirFiber, the 72-hour bridge, doesn't cover the address",
  },
  /** Eligibility problems are shown in English inside blocked_text; the agent explains them in the owner's language. */
  eligibility: {
    cityTier: "not sold in tier-{tier} cities yet",
    minimumEmployees: "needs at least {count} employees",
    minimumSites: "needs at least {count} sites",
    gstin: "needs an active GSTIN",
    connection: "needs a broadband or leased line in the same bundle",
  },
  switchedToAirFiber: " → 5G AirFiber",
  /** One reason per product: [English, Hindi]. {quantity} is replaced by the item quantity. */
  reasonByProductId: {
    P01: ["100 Mbps business fibre", "100 Mbps बिज़नेस फाइबर"],
    P02: ["300 Mbps fibre for the whole team", "पूरी टीम के लिए 300 Mbps फाइबर"],
    P03: ["1 Gbps fibre for heavy files", "भारी फ़ाइलों के लिए 1 Gbps फाइबर"],
    P04: ["plug-and-play 5G, live in about 2 days", "प्लग-एंड-प्ले 5G, लगभग 2 दिन में चालू"],
    P05: ["a dedicated line with 99.5% uptime", "99.5% अपटाइम वाली डेडिकेटेड लाइन"],
    P06: ["a dedicated 100 Mbps line with 99.9% uptime", "99.9% अपटाइम वाली 100 Mbps डेडिकेटेड लाइन"],
    P07: ["{quantity} business SIM(s) on the same bill", "उसी बिल पर {quantity} बिज़नेस सिम"],
    P08: ["{quantity} business lines with priority care", "प्रायोरिटी केयर के साथ {quantity} बिज़नेस लाइन"],
    P09: ["auto-switch to 4G/5G if the fibre drops", "फाइबर रुके तो अपने-आप 4G/5G पर"],
    P10: ["one managed network across all branches", "सभी ब्रांच के लिए एक मैनेज्ड नेटवर्क"],
    P11: ["a static IP for remote access", "रिमोट एक्सेस के लिए स्टैटिक IP"],
    P12: ["cloud calling with {quantity} lines", "{quantity} लाइन के साथ क्लाउड कॉलिंग"],
    P13: ["one toll-free number for customers", "ग्राहकों के लिए एक टोल-फ्री नंबर"],
    P14: ["SMS reminders to customers", "ग्राहकों को SMS रिमाइंडर"],
    P15: ["WhatsApp catalogue and broadcasts", "WhatsApp पर कैटलॉग और मैसेज"],
    P16: ["business email for {quantity} staff", "{quantity} लोगों के लिए बिज़नेस ईमेल"],
    P17: ["1 TB cloud backup for records", "रिकॉर्ड के लिए 1 TB क्लाउड बैकअप"],
    P18: ["a website with your own domain", "अपने डोमेन के साथ वेबसाइट"],
    P19: ["billing at {quantity} counter(s)", "{quantity} काउंटर पर बिलिंग"],
    P20: ["virus protection on {quantity} devices", "{quantity} डिवाइस पर वायरस सुरक्षा"],
    P21: ["a managed firewall", "मैनेज्ड फ़ायरवॉल"],
    P22: ["secure Wi-Fi with a guest network", "गेस्ट नेटवर्क के साथ सुरक्षित Wi-Fi"],
    P23: ["{quantity} cloud cameras you can watch on your phone", "फोन पर दिखने वाले {quantity} क्लाउड कैमरे"],
    P24: ["{quantity} machine-monitoring sensors", "{quantity} मशीन-मॉनिटरिंग सेंसर"],
    P25: ["{quantity} vehicle trackers", "{quantity} वाहन ट्रैकर"],
  },
};

// ================================================================ LOGIC: small helpers

/** Reads a positive number from free text ("16 people" → 16); returns `fallback` when there isn't one. */
function parsePositiveNumber(value, fallback) {
  const text = String(value === undefined || value === null ? "" : value);
  const number = parseFloat(text.replace(/[^0-9.]/g, ""));
  return isFinite(number) && number > 0 ? number : fallback;
}

/** True when the owner's answer means yes (English, Hinglish or Hindi). */
function isYes(value) {
  const answer = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  return YES_WORDS.indexOf(answer) >= 0;
}

/** True when the owner's answer means no (English, Hinglish or Hindi). */
function isNo(value) {
  const answer = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  return NO_WORDS.indexOf(answer) >= 0;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** True when `text` contains any keyword. Short keywords must stand alone, so "lab" doesn't match "label". */
function containsAnyKeyword(text, keywords) {
  const paddedText = " " + String(text || "").toLowerCase() + " ";
  return keywords.some((keyword) =>
    keyword.length <= SHORT_KEYWORD_MAX_LENGTH
      ? new RegExp("[^a-z]" + keyword + "[^a-z]").test(paddedText)
      : paddedText.indexOf(keyword) >= 0,
  );
}

/** Formats rupees with Indian digit grouping: 123456 → "₹1,23,456". */
function formatRupees(amount) {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return "₹" + digits;
  const lastThree = digits.slice(-3);
  const leading = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return "₹" + leading + "," + lastThree;
}

function fillTemplate(template, values) {
  return Object.keys(values).reduce((text, key) => text.split("{" + key + "}").join(values[key]), template);
}

// ================================================================ LOGIC: understanding the business

/**
 * Decides which of the four case segments the business belongs to.
 * Order matters: an explicit segment wins, then 3+ sites, then keywords, then team size.
 */
function detectSegment(inputVars, siteCount) {
  const segmentInput = String(inputVars.segment || "").toLowerCase();
  if (segmentInput) {
    if (containsAnyKeyword(segmentInput, SEGMENT_KEYWORDS.segmentInputMicro)) return SEGMENT.MICRO;
    if (containsAnyKeyword(segmentInput, SEGMENT_KEYWORDS.segmentInputProfessional)) return SEGMENT.PROFESSIONAL;
    if (containsAnyKeyword(segmentInput, SEGMENT_KEYWORDS.segmentInputMultiSite)) return SEGMENT.MULTI_SITE;
    if (containsAnyKeyword(segmentInput, SEGMENT_KEYWORDS.segmentInputManufacturer)) return SEGMENT.MANUFACTURER;
  }
  const businessType = String(inputVars.business_type || "").toLowerCase();
  if (siteCount >= THRESHOLDS.sitesForMultiSite) return SEGMENT.MULTI_SITE;
  if (containsAnyKeyword(businessType, SEGMENT_KEYWORDS.multiSite)) return SEGMENT.MULTI_SITE;
  if (containsAnyKeyword(businessType, SEGMENT_KEYWORDS.manufacturer)) return SEGMENT.MANUFACTURER;
  if (containsAnyKeyword(businessType, SEGMENT_KEYWORDS.professional)) return SEGMENT.PROFESSIONAL;
  if (containsAnyKeyword(businessType, SEGMENT_KEYWORDS.micro)) return SEGMENT.MICRO;
  const employeesForGuess = parsePositiveNumber(inputVars.employees, THRESHOLDS.employeesAssumedForSegmentGuess);
  return employeesForGuess >= THRESHOLDS.employeesForProfessionalWhenTypeUnknown ? SEGMENT.PROFESSIONAL : SEGMENT.MICRO;
}

/** Turns "Internet that never stops, billing" into flags like { failover: true, pos: true }. */
function parseNeeds(needsText) {
  const phrases = String(needsText || "")
    .toLowerCase()
    .split(/[,;\n|/]+/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
  const needs = {};
  phrases.forEach((phrase) => {
    if (containsAnyKeyword(phrase, ["backup"]) && containsAnyKeyword(phrase, BACKUP_INTERNET_WORDS)) {
      needs.failover = true;
      return;
    }
    Object.keys(NEED_KEYWORDS).forEach((needName) => {
      // "backup internet" is failover, not storage; "cctv" alone is not a static-IP request.
      if (needName === "storage" && containsAnyKeyword(phrase, NEED_KEYWORDS.failover)) return;
      if (needName === "staticip" && phrase.indexOf("cctv") >= 0 && phrase.indexOf("remote") < 0) return;
      if (containsAnyKeyword(phrase, NEED_KEYWORDS[needName])) needs[needName] = true;
    });
  });
  return needs;
}

/** Lists why a product can't be sold to this business (empty list = eligible). Rules from product_catalogue.csv. */
function getEligibilityProblems(product, business, includedProductIds) {
  const problems = [];
  if (product.availableCityTiers.indexOf(business.cityTier) < 0) {
    problems.push(fillTemplate(MESSAGES.eligibility.cityTier, { tier: business.cityTier }));
  }
  if (business.employeeCount < product.minimumEmployees) {
    problems.push(fillTemplate(MESSAGES.eligibility.minimumEmployees, { count: product.minimumEmployees }));
  }
  if (business.siteCount < product.minimumSites) {
    problems.push(fillTemplate(MESSAGES.eligibility.minimumSites, { count: product.minimumSites }));
  }
  if (product.requiresGstin && !business.hasGstin) problems.push(MESSAGES.eligibility.gstin);
  if (
    product.requiresOneOfProductIds.length &&
    !product.requiresOneOfProductIds.some((productId) => includedProductIds[productId])
  ) {
    problems.push(MESSAGES.eligibility.connection);
  }
  return problems;
}

/** Finds a catalogue product from an ID ("P20"), a name ("static ip") or a need word ("cctv"). Null if unknown. */
function findProductByText(text) {
  const searchText = String(text || "")
    .trim()
    .toLowerCase();
  if (!searchText) return null;
  const idMatch = searchText.toUpperCase().match(/^P\d{2}$/);
  if (idMatch && PRODUCTS_BY_ID[idMatch[0]]) return PRODUCTS_BY_ID[idMatch[0]];
  let shortestNameMatch = null;
  PRODUCT_CATALOGUE.forEach((product) => {
    const productName = product.name.toLowerCase();
    const isMatch =
      productName === searchText || productName.indexOf(searchText) >= 0 || searchText.indexOf(productName) >= 0;
    if (isMatch && (!shortestNameMatch || product.name.length < shortestNameMatch.name.length)) {
      shortestNameMatch = product;
    }
  });
  if (shortestNameMatch) return shortestNameMatch;
  const needs = parseNeeds(searchText);
  for (const needName in PRODUCT_BY_NEED) {
    if (needs[needName]) return PRODUCTS_BY_ID[PRODUCT_BY_NEED[needName]];
  }
  if (containsAnyKeyword(searchText, MOBILE_LINE_WORDS)) return PRODUCTS_BY_ID[PRODUCT.POSTPAID_299];
  return null;
}

// ================================================================ LOGIC: building the quote
// TODO(CODE_REVIEW.md): buildQuote still does several jobs (sizing, candidates, edits, eligibility, budget,
// formatting). Splitting it is planned; this cleanup only renamed things and moved numbers into CONFIG.

/** Builds the full quote for one business. Returns plain data; main() maps it to Voiceflow outputs. */
function buildQuote(inputVars) {
  const language = /^(hi|hindi|हिंदी|hinglish)/i.test(String(inputVars.lang || "")) ? "hi" : "en";
  const siteCount = Math.round(parsePositiveNumber(inputVars.sites, 1));
  const segment = detectSegment(inputVars, siteCount);
  const employeeCount = Math.round(parsePositiveNumber(inputVars.employees, SIZING.defaultEmployeesBySegment[segment]));
  const cityName = String(inputVars.city || "")
    .trim()
    .toLowerCase();
  const cityTier = cityName
    ? TIER_1_CITY_NAMES.indexOf(cityName) >= 0
      ? 1
      : 2
    : parsePositiveNumber(inputVars.city_tier, THRESHOLDS.defaultCityTier);
  const hasGstin = isYes(inputVars.has_gstin);
  const fibreUnavailable = isNo(inputVars.fibre_available);
  const needs = parseNeeds(inputVars.needs);
  const business = { segment, employeeCount, siteCount, cityTier, hasGstin };
  const businessType = String(inputVars.business_type || "").toLowerCase();

  const mobileLineCount = Math.round(
    parsePositiveNumber(inputVars.lines, defaultMobileLineCount(segment, employeeCount)),
  );
  const emailUserCount = Math.round(
    parsePositiveNumber(inputVars.email_users, defaultEmailUserCount(segment, employeeCount)),
  );
  const securedDeviceCount = defaultSecuredDeviceCount(segment, employeeCount);
  const cameraCount = Math.round(
    parsePositiveNumber(
      inputVars.cameras,
      segment === SEGMENT.MULTI_SITE
        ? Math.round(SIZING.multiSiteCamerasPerSite * siteCount)
        : segment === SEGMENT.MANUFACTURER
          ? SIZING.defaultCameras.mfg
          : SIZING.defaultCameras.other,
    ),
  );
  const counterCount = Math.round(parsePositiveNumber(inputVars.counters, SIZING.defaultCountersPerSite));
  const machineCount = Math.round(parsePositiveNumber(inputVars.machines, SIZING.defaultMachines));
  const vehicleCount = Math.round(parsePositiveNumber(inputVars.vehicles, SIZING.defaultVehicles));

  // Candidates in order; the first one is always the connection (eligibility of later items depends on it).
  const candidates = [];
  const addCandidate = (productId, quantity, ownerAskedForIt, isOptional) =>
    candidates.push({
      productId,
      quantity: Math.max(1, Math.round(quantity)),
      ownerAskedForIt: !!ownerAskedForIt,
      isOptional: !!isOptional,
    });

  /** First product in the list this business may buy; falls back to the last one. */
  function pickFirstEligible(productIds) {
    for (const productId of productIds) {
      if (getEligibilityProblems(PRODUCTS_BY_ID[productId], business, {}).length === 0) return productId;
    }
    return productIds[productIds.length - 1];
  }

  const connectionProductId = chooseConnection(
    segment,
    employeeCount,
    siteCount,
    needs,
    fibreUnavailable,
    pickFirstEligible,
  );
  addCandidate(connectionProductId, segment === SEGMENT.MULTI_SITE ? siteCount : 1, false, false);

  const isRetailOrFood = containsAnyKeyword(businessType, SEGMENT_KEYWORDS.retailOrFood);
  if (segment === SEGMENT.MICRO) {
    addCandidate(PRODUCT.POSTPAID_299, mobileLineCount, false, false);
    if (needs.pos) addCandidate(PRODUCT.CLOUD_POS, counterCount, true, true);
    if (needs.cctv) addCandidate(PRODUCT.CLOUD_CCTV, cameraCount, true, true);
    if (needs.wifi) addCandidate(PRODUCT.SECURE_WIFI, 1, true, true);
    if (needs.whatsapp) addCandidate(PRODUCT.WHATSAPP_API, 1, true, true);
    if (needs.website) addCandidate(PRODUCT.WEBSITE_DOMAIN, 1, true, true);
    if (needs.sms) addCandidate(PRODUCT.BUSINESS_SMS, 1, true, true);
    if (needs.email) addCandidate(PRODUCT.CLOUD_EMAIL, emailUserCount, true, true);
    if (needs.security) addCandidate(PRODUCT.ENDPOINT_SECURITY, securedDeviceCount, true, true);
    if (needs.failover) addCandidate(PRODUCT.FAILOVER_4G_5G, 1, true, true);
  } else if (segment === SEGMENT.PROFESSIONAL) {
    if (needs.failover || employeeCount >= THRESHOLDS.officeTeamSizeForDefaultFailover) {
      addCandidate(PRODUCT.FAILOVER_4G_5G, 1, !!needs.failover, true);
    }
    addCandidate(PRODUCT.POSTPAID_599, mobileLineCount, false, false);
    addCandidate(PRODUCT.CLOUD_EMAIL, emailUserCount, !!needs.email, true);
    addCandidate(PRODUCT.ENDPOINT_SECURITY, securedDeviceCount, !!needs.security, true);
    addCandidate(PRODUCT.CLOUD_BACKUP_1TB, 1, !!needs.storage, true);
    if (needs.telephony) {
      const channelCount = Math.min(
        SIZING.maxTelephonyChannels,
        Math.max(SIZING.minTelephonyChannels, Math.round(employeeCount / SIZING.employeesPerTelephonyChannel)),
      );
      addCandidate(PRODUCT.CLOUD_TELEPHONY, channelCount, true, true);
    }
    if (needs.staticip) addCandidate(PRODUCT.STATIC_IP, 1, true, true);
    if (needs.sms) addCandidate(PRODUCT.BUSINESS_SMS, 1, true, true);
    if (needs.tollfree) addCandidate(PRODUCT.TOLL_FREE_NUMBER, 1, true, true);
    if (needs.website) addCandidate(PRODUCT.WEBSITE_DOMAIN, 1, true, true);
    if (needs.whatsapp) addCandidate(PRODUCT.WHATSAPP_API, 1, true, true);
    if (needs.wifi) addCandidate(PRODUCT.SECURE_WIFI, 1, true, true);
    if (needs.cctv) addCandidate(PRODUCT.CLOUD_CCTV, cameraCount, true, true);
    if (needs.firewall) addCandidate(PRODUCT.MANAGED_FIREWALL, 1, true, true);
  } else if (segment === SEGMENT.MULTI_SITE) {
    addCandidate(PRODUCT.FAILOVER_4G_5G, siteCount, !!needs.failover, true);
    addCandidate(PRODUCT.SECURE_WIFI, siteCount, !!needs.wifi, true);
    if (needs.pos || isRetailOrFood) addCandidate(PRODUCT.CLOUD_POS, siteCount * counterCount, !!needs.pos, true);
    if (needs.cctv) addCandidate(PRODUCT.CLOUD_CCTV, cameraCount, true, true);
    addCandidate(PRODUCT.POSTPAID_599, mobileLineCount, false, false);
    addCandidate(PRODUCT.TOLL_FREE_NUMBER, 1, !!needs.tollfree, true);
    if (needs.sdwan) addCandidate(PRODUCT.MANAGED_SD_WAN, siteCount, true, true);
    if (needs.whatsapp) addCandidate(PRODUCT.WHATSAPP_API, 1, true, true);
    if (needs.email) addCandidate(PRODUCT.CLOUD_EMAIL, emailUserCount, true, true);
    if (needs.fleet) addCandidate(PRODUCT.FLEET_TRACKER, vehicleCount, true, true);
    if (needs.security) addCandidate(PRODUCT.ENDPOINT_SECURITY, securedDeviceCount, true, true);
  } else {
    const isFibreOrAirFiber =
      connectionProductId === PRODUCT.BIZ_FIBRE_300 ||
      connectionProductId === PRODUCT.BIZ_FIBRE_1G ||
      connectionProductId === PRODUCT.AIRFIBER_5G;
    if (isFibreOrAirFiber) addCandidate(PRODUCT.FAILOVER_4G_5G, 1, !!needs.failover, true);
    addCandidate(PRODUCT.MANAGED_FIREWALL, 1, !!needs.firewall, true);
    addCandidate(PRODUCT.POSTPAID_599, mobileLineCount, false, false);
    addCandidate(PRODUCT.CLOUD_EMAIL, emailUserCount, !!needs.email, true);
    if (needs.iot) addCandidate(PRODUCT.MACHINE_IOT, machineCount, true, true);
    if (needs.fleet) addCandidate(PRODUCT.FLEET_TRACKER, vehicleCount, true, true);
    if (needs.security) addCandidate(PRODUCT.ENDPOINT_SECURITY, securedDeviceCount, true, true);
    if (needs.staticip) addCandidate(PRODUCT.STATIC_IP, 1, true, true);
    if (needs.cctv) addCandidate(PRODUCT.CLOUD_CCTV, cameraCount, true, true);
  }

  applyOwnerEdits(candidates, inputVars, addCandidate);

  // Eligibility pass, in order, so add-ons see the connection that came before them.
  const includedProductIds = {};
  const items = [];
  const blockedItems = [];
  candidates.forEach((candidate) => {
    const product = PRODUCTS_BY_ID[candidate.productId];
    const problems = getEligibilityProblems(product, business, includedProductIds);
    if (problems.length === 0) {
      items.push({
        productId: candidate.productId,
        quantity: candidate.quantity,
        ownerAskedForIt: candidate.ownerAskedForIt,
        isOptional: candidate.isOptional,
        product,
      });
      includedProductIds[candidate.productId] = true;
    } else {
      blockedItems.push({ productId: candidate.productId, name: product.name, reason: problems.join(", ") });
    }
  });

  const budgetNote = fitToBudget(items, parsePositiveNumber(inputVars.budget, 0), segment, business, language);

  const monthlyTotalInRupees = sumMonthlyPrice(items);
  const setupTotalInRupees = items.reduce((sum, item) => sum + item.quantity * item.product.oneTimeSetupInRupees, 0);
  const preferredContractMonths = parsePositiveNumber(inputVars.contract_months, 0);
  const contractMonths = Math.max(
    preferredContractMonths,
    items.reduce((longest, item) => Math.max(longest, item.product.minimumContractMonths), 1),
  );
  const installDays = items.reduce((slowest, item) => Math.max(slowest, item.product.typicalInstallDays), 1);
  const bundleName = BUNDLE_NAME_BY_SEGMENT[segment];
  const promise = decideActivationPromise(business, items, cityName, inputVars, language);

  const blockedText = blockedItems.map((blocked) => blocked.name + " (" + blocked.reason + ")").join("; ");
  const quoteText = formatQuoteText({
    bundleName,
    items,
    monthlyTotalInRupees,
    setupTotalInRupees,
    contractMonths,
    installDays,
    promiseText: promise.text,
    blockedText,
    budgetNote,
    language,
  });
  const whyText = formatWhyText(items, language);

  return {
    segment,
    bundleName,
    monthlyTotalInRupees,
    setupTotalInRupees,
    contractMonths,
    installDays,
    promise,
    quoteText,
    whyText,
    blockedText,
    budgetNote,
    items,
  };
}

/** Business postpaid lines by segment (see SIZING). */
function defaultMobileLineCount(segment, employeeCount) {
  if (segment === SEGMENT.MICRO) {
    return employeeCount <= SIZING.microMaxEmployeesForOneLine
      ? SIZING.microLinesForTinyShop
      : SIZING.microLinesOtherwise;
  }
  return clamp(
    Math.round(employeeCount / SIZING.employeesPerLine[segment]),
    SIZING.minLines[segment],
    SIZING.maxLines[segment],
  );
}

/** Cloud email users by segment (see SIZING). */
function defaultEmailUserCount(segment, employeeCount) {
  if (segment === SEGMENT.PROFESSIONAL) {
    return Math.max(SIZING.minimumEmailUsers, Math.ceil(employeeCount * SIZING.emailShareOfStaff.prof));
  }
  if (segment === SEGMENT.MANUFACTURER) {
    return Math.max(SIZING.minimumEmailUsers, Math.round(employeeCount * SIZING.emailShareOfStaff.mfg));
  }
  if (segment === SEGMENT.MULTI_SITE) {
    return Math.max(SIZING.minimumEmailUsers, Math.round(employeeCount * SIZING.emailShareOfStaff.multi));
  }
  return Math.max(SIZING.minimumEmailUsersMicro, employeeCount);
}

/** Devices that get endpoint security, by segment (see SIZING). */
function defaultSecuredDeviceCount(segment, employeeCount) {
  if (segment === SEGMENT.PROFESSIONAL) {
    return Math.max(
      SIZING.minimumSecuredDevices.prof,
      Math.round(employeeCount * SIZING.securedDeviceShareOfStaff.prof),
    );
  }
  if (segment === SEGMENT.MANUFACTURER) {
    return Math.max(SIZING.minimumSecuredDevices.mfg, Math.round(employeeCount * SIZING.securedDeviceShareOfStaff.mfg));
  }
  return Math.max(1, Math.min(employeeCount, SIZING.maxSecuredDevicesOtherSegments));
}

/**
 * Picks the main connection. No fibre → 5G AirFiber (installs in ~2 days). Factories prefer a leased line
 * (99.5% SLA) when they have a GSTIN; otherwise the best eligible fibre.
 */
function chooseConnection(segment, employeeCount, siteCount, needs, fibreUnavailable, pickFirstEligible) {
  if (segment === SEGMENT.MICRO) return fibreUnavailable ? PRODUCT.AIRFIBER_5G : PRODUCT.BIZ_FIBRE_100;
  if (segment === SEGMENT.PROFESSIONAL) {
    if (fibreUnavailable) return PRODUCT.AIRFIBER_5G;
    if (needs.highspeed) return pickFirstEligible([PRODUCT.BIZ_FIBRE_1G, PRODUCT.BIZ_FIBRE_300]);
    return employeeCount <= THRESHOLDS.maxEmployeesForBizFibre100InOffices
      ? PRODUCT.BIZ_FIBRE_100
      : PRODUCT.BIZ_FIBRE_300;
  }
  if (segment === SEGMENT.MULTI_SITE) {
    if (fibreUnavailable) return PRODUCT.AIRFIBER_5G;
    return employeeCount / siteCount > THRESHOLDS.employeesPerSiteNeedingBizFibre300
      ? PRODUCT.BIZ_FIBRE_300
      : PRODUCT.BIZ_FIBRE_100;
  }
  if (fibreUnavailable) return pickFirstEligible([PRODUCT.LEASED_LINE_20, PRODUCT.AIRFIBER_5G]);
  if ((needs.leased || needs.highspeed) && employeeCount >= THRESHOLDS.employeesForLeasedLine100) {
    return pickFirstEligible([
      PRODUCT.LEASED_LINE_100,
      PRODUCT.LEASED_LINE_20,
      PRODUCT.BIZ_FIBRE_1G,
      PRODUCT.BIZ_FIBRE_300,
    ]);
  }
  return pickFirstEligible([PRODUCT.LEASED_LINE_20, PRODUCT.BIZ_FIBRE_1G, PRODUCT.BIZ_FIBRE_300]);
}

/**
 * Reads one "add" request ("P20 5", "Business Postpaid 599", "cctv x6", "4 cctv") into a product and a quantity.
 * Order matters (CODE_REVIEW.md L2): the catalogue ID and the full product name are found BEFORE any number is
 * read as a quantity, because IDs and some names contain digits. Stripping digits first turned "P20" into "P"
 * (→ Static IP ×20) and "Business Postpaid 599" into Postpaid 299 ×599.
 * Returns { product, quantity } with quantity null when no number was given, or null for an unknown product.
 * Example: parseAddRequest("P20 5") → { product: Endpoint Security, quantity: 5 }.
 */
function parseAddRequest(request) {
  // "x5", "x 5", "5x" and "×5" all mean 5.
  const text = String(request || "")
    .trim()
    .replace(/(^|\s)[x×]\s*(\d)/gi, "$1$2")
    .replace(/(\d)\s*[x×](?=\s|$)/gi, "$1");
  if (!text) return null;
  let product = null;
  let rest = text;
  const idMatch = text.match(/\bp-?(\d{1,2})\b/i);
  if (idMatch) {
    product = PRODUCTS_BY_ID["P" + idMatch[1].padStart(2, "0")];
    if (!product) return null; // an ID that isn't in the catalogue: never guess another product
    rest = text.replace(idMatch[0], " ");
  } else {
    const lowerText = text.toLowerCase();
    PRODUCT_CATALOGUE.forEach((candidate) => {
      const isLongerFullNameMatch =
        lowerText.indexOf(candidate.name.toLowerCase()) >= 0 &&
        (!product || candidate.name.length > product.name.length);
      if (isLongerFullNameMatch) product = candidate;
    });
    if (product) {
      const nameStart = lowerText.indexOf(product.name.toLowerCase());
      rest = text.slice(0, nameStart) + " " + text.slice(nameStart + product.name.length);
    }
  }
  const quantityMatch = rest.match(/(\d+)\s*$/) || rest.match(/^\s*(\d+)/);
  if (!product) product = findProductByText(rest.replace(/\d+/g, " "));
  if (!product) return null;
  return { product, quantity: quantityMatch ? parseInt(quantityMatch[1], 10) : null };
}

/**
 * Applies the owner's "remove …" and "add …" requests to the candidate list.
 * The connection (first candidate) can never be removed.
 */
function applyOwnerEdits(candidates, inputVars, addCandidate) {
  String(inputVars.remove || "")
    .split(/[,;]+/)
    .forEach((request) => {
      const product = findProductByText(request);
      if (!product) return;
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (candidates[i].productId === product.id && i > 0) candidates.splice(i, 1);
      }
    });
  String(inputVars.add || "")
    .split(/[,;]+/)
    .forEach((request) => {
      const parsed = parseAddRequest(request);
      if (!parsed) return;
      const existing = candidates.find((candidate) => candidate.productId === parsed.product.id);
      if (existing) existing.quantity = parsed.quantity === null ? existing.quantity : parsed.quantity;
      else addCandidate(parsed.product.id, parsed.quantity === null ? 1 : parsed.quantity, true, true);
    });
}

function sumMonthlyPrice(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.product.monthlyPriceFloorInRupees, 0);
}

/**
 * Shrinks the bundle to a monthly budget, in this order: drop optional items (BUDGET_TRIM_ORDER), swap fibre
 * for 5G AirFiber (shops and offices only), cut mobile lines down to one. Changes `items` in place and returns
 * the note for the owner ("" when no budget was given or it already fits). Targets the case's top drop reason:
 * "Price too high", 414 leads lost after needs assessment.
 */
function fitToBudget(items, monthlyBudget, segment, business, language) {
  if (!(monthlyBudget > 0 && sumMonthlyPrice(items) > monthlyBudget)) return "";
  const removedForBudget = [];
  for (const productId of BUDGET_TRIM_ORDER) {
    if (sumMonthlyPrice(items) <= monthlyBudget) break;
    const index = items.findIndex((item) => item.productId === productId && item.isOptional);
    if (index >= 0) {
      removedForBudget.push(items[index].product.name);
      items.splice(index, 1);
    }
  }
  // Evaluated only when still over budget (same short-circuit order as before the cleanup).
  const canSwitchToAirFiber = () =>
    (segment === SEGMENT.MICRO || segment === SEGMENT.PROFESSIONAL) &&
    items[0].productId !== PRODUCT.AIRFIBER_5G &&
    getEligibilityProblems(PRODUCTS_BY_ID[PRODUCT.AIRFIBER_5G], business, {}).length === 0;
  if (sumMonthlyPrice(items) > monthlyBudget && canSwitchToAirFiber()) {
    removedForBudget.push(items[0].product.name + MESSAGES.switchedToAirFiber);
    items[0] = {
      productId: PRODUCT.AIRFIBER_5G,
      quantity: items[0].quantity,
      ownerAskedForIt: false,
      isOptional: false,
      product: PRODUCTS_BY_ID[PRODUCT.AIRFIBER_5G],
    };
  }
  const mobileLineItem = items.find(
    (item) => item.productId === PRODUCT.POSTPAID_299 || item.productId === PRODUCT.POSTPAID_599,
  );
  while (sumMonthlyPrice(items) > monthlyBudget && mobileLineItem && mobileLineItem.quantity > 1) {
    mobileLineItem.quantity -= 1;
  }
  const text = MESSAGES[language];
  return sumMonthlyPrice(items) <= monthlyBudget
    ? fillTemplate(text.budgetFitted, { budget: formatRupees(monthlyBudget) }) + (removedForBudget.join(", ") || "-")
    : fillTemplate(text.budgetLowestPossible, { total: formatRupees(sumMonthlyPrice(items)) });
}

/** The quote card shown to the owner: one line per item, then setup, plan length, install time and GST. */
function formatQuoteText(quote) {
  const text = MESSAGES[quote.language];
  const itemLines = quote.items.map(
    (item) =>
      "• " +
      item.product.name +
      (item.quantity > 1 ? " ×" + item.quantity : "") +
      " · " +
      formatRupees(item.quantity * item.product.monthlyPriceFloorInRupees),
  );
  let quoteText =
    quote.bundleName +
    " · " +
    formatRupees(quote.monthlyTotalInRupees) +
    text.perMonth +
    "\n" +
    itemLines.join("\n") +
    "\n" +
    (quote.setupTotalInRupees > 0
      ? text.oneTimeSetup + " " + formatRupees(quote.setupTotalInRupees)
      : text.noSetupFee) +
    " · " +
    quote.contractMonths +
    text.monthPlanSuffix +
    " · " +
    fillTemplate(text.liveInDays, { days: quote.installDays }) +
    " · " +
    text.gstExtra +
    "\n" +
    quote.promiseText;
  if (quote.blockedText) quoteText += "\n" + text.notAdded + ": " + quote.blockedText;
  if (quote.budgetNote) quoteText += "\n" + quote.budgetNote;
  return quoteText;
}

/** The quote's connection item: the first item that is a connection product, or null. */
function findConnectionItem(items) {
  return items.find((item) => ACTIVATION_PROMISE_DATA.connectionTypeByProduct[item.productId]) || null;
}

/**
 * Why this quote is outside GUARANTEE_SCOPE: a list of PROMISE_SCOPE_REASON codes, empty when it qualifies.
 * Uses only what is known at quote time: city tier and AirFiber coverage, team size, sites and the connection.
 */
function findGuaranteeScopeProblems(business, connectionItem, cityName, inputVars) {
  const problems = [];
  if (GUARANTEE_SCOPE.cityTiers.indexOf(business.cityTier) < 0) problems.push(PROMISE_SCOPE_REASON.CITY_TIER);
  if (business.employeeCount > GUARANTEE_SCOPE.maxEmployees) problems.push(PROMISE_SCOPE_REASON.TEAM_SIZE);
  if (business.siteCount > GUARANTEE_SCOPE.maxSites) problems.push(PROMISE_SCOPE_REASON.SITES);
  if (!connectionItem || GUARANTEE_SCOPE.connectionProductIds.indexOf(connectionItem.productId) < 0) {
    problems.push(PROMISE_SCOPE_REASON.CONNECTION);
  }
  const isAirFiberCovered = AIRFIBER_COVERAGE_CITY_NAMES.indexOf(cityName) >= 0 && !isNo(inputVars.airfiber_available);
  if (GUARANTEE_SCOPE.requiresAirFiberCoverage && !isAirFiberCovered) {
    problems.push(PROMISE_SCOPE_REASON.AIRFIBER_COVERAGE);
  }
  return problems;
}

/**
 * The activation promise shown on the quote card: "Connected in 72 hours, guaranteed" inside GUARANTEE_SCOPE,
 * otherwise a firm number of days for the quote's city tier and connection type (ACTIVATION_PROMISE_DATA, from the
 * case data). Never shorter than the 72-hour guarantee. Returns { type, hours, days, text, reasons, reasonsText }.
 * Example: Delhi kirana, 3 people, Biz Fibre 100 → { type: "guaranteed_72h", hours: 72, days: 3, reasons: [] }.
 */
function decideActivationPromise(business, items, cityName, inputVars, language) {
  const text = MESSAGES[language];
  const connectionItem = findConnectionItem(items);
  const reasons = findGuaranteeScopeProblems(business, connectionItem, cityName, inputVars);
  const reasonsText = reasons
    .map((reason) =>
      fillTemplate(MESSAGES.promiseScopeReasons[reason], {
        count: GUARANTEE_SCOPE.maxEmployees,
        name: connectionItem ? connectionItem.product.name : "",
      }),
    )
    .join("; ");
  const guaranteeDays = Math.ceil(GUARANTEE_SCOPE.hours / HOURS_PER_DAY);
  if (reasons.length === 0) {
    return {
      type: PROMISE_TYPE.GUARANTEED_72H,
      hours: GUARANTEE_SCOPE.hours,
      days: guaranteeDays,
      text: text.promiseGuaranteed72h,
      reasons,
      reasonsText,
    };
  }
  const connectionType = connectionItem
    ? ACTIVATION_PROMISE_DATA.connectionTypeByProduct[connectionItem.productId]
    : ACTIVATION_PROMISE_DATA.anyConnectionType;
  const firmDaysByType =
    ACTIVATION_PROMISE_DATA.firmDays[String(business.cityTier)] ||
    ACTIVATION_PROMISE_DATA.firmDays[String(THRESHOLDS.defaultCityTier)];
  const days = Math.max(firmDaysByType[connectionType].days, guaranteeDays);
  return {
    type: PROMISE_TYPE.FIRM_DATE,
    hours: days * HOURS_PER_DAY,
    days,
    text: fillTemplate(text.promiseFirmDate, { days }),
    reasons,
    reasonsText,
  };
}

/** "Why:" line: the connection first, then what the owner asked for, then the rest (top MAX_REASONS_SHOWN). */
function formatWhyText(items, language) {
  const languageIndex = language === "hi" ? 1 : 0;
  const itemsByImportance = items
    .slice()
    .sort((first, second) =>
      first === items[0] ? -1 : second === items[0] ? 1 : second.ownerAskedForIt - first.ownerAskedForIt,
    );
  return (
    MESSAGES[language].whyPrefix +
    itemsByImportance
      .slice(0, MAX_REASONS_SHOWN)
      .map((item) => MESSAGES.reasonByProductId[item.productId][languageIndex].replace("{quantity}", item.quantity))
      .join("; ")
  );
}

// ================================================================ DATA (injected by _build/gen_kit.py)

/**
 * The 25 products from product_catalogue.csv (case pack, synthetic). Fields per product:
 * id, category, name, unit, monthlyPriceFloorInRupees, monthlyPriceCeilingInRupees, oneTimeSetupInRupees,
 * minimumContractMonths, availableCityTiers, minimumEmployees, minimumSites, requiresGstin,
 * requiresOneOfProductIds, typicalInstallDays.
 */
const PRODUCT_CATALOGUE = [{"id":"P01","category":"Connectivity","name":"Biz Fibre 100","unit":"per site","monthlyPriceFloorInRupees":999,"monthlyPriceCeilingInRupees":1199,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":5},{"id":"P02","category":"Connectivity","name":"Biz Fibre 300","unit":"per site","monthlyPriceFloorInRupees":1499,"monthlyPriceCeilingInRupees":1799,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":5},{"id":"P03","category":"Connectivity","name":"Biz Fibre 1G","unit":"per site","monthlyPriceFloorInRupees":3999,"monthlyPriceCeilingInRupees":4499,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1],"minimumEmployees":5,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":7},{"id":"P04","category":"Connectivity","name":"Biz 5G AirFiber 100","unit":"per site","monthlyPriceFloorInRupees":899,"monthlyPriceCeilingInRupees":1099,"oneTimeSetupInRupees":0,"minimumContractMonths":6,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":2},{"id":"P05","category":"Connectivity","name":"Internet Leased Line 20","unit":"per site","monthlyPriceFloorInRupees":8000,"monthlyPriceCeilingInRupees":12000,"oneTimeSetupInRupees":10000,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":10,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":21},{"id":"P06","category":"Connectivity","name":"Internet Leased Line 100","unit":"per site","monthlyPriceFloorInRupees":25000,"monthlyPriceCeilingInRupees":35000,"oneTimeSetupInRupees":15000,"minimumContractMonths":24,"availableCityTiers":[1,2],"minimumEmployees":25,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":30},{"id":"P07","category":"Connectivity","name":"Business Postpaid 299","unit":"per line","monthlyPriceFloorInRupees":299,"monthlyPriceCeilingInRupees":399,"oneTimeSetupInRupees":0,"minimumContractMonths":1,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P08","category":"Connectivity","name":"Business Postpaid 599","unit":"per line","monthlyPriceFloorInRupees":599,"monthlyPriceCeilingInRupees":799,"oneTimeSetupInRupees":0,"minimumContractMonths":1,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P09","category":"Connectivity","name":"Backup 4G/5G Failover","unit":"per site","monthlyPriceFloorInRupees":499,"monthlyPriceCeilingInRupees":599,"oneTimeSetupInRupees":1500,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":["P01","P02","P03","P05","P06"],"typicalInstallDays":3},{"id":"P10","category":"Connectivity","name":"Managed SD-WAN","unit":"per site","monthlyPriceFloorInRupees":2500,"monthlyPriceCeilingInRupees":3500,"oneTimeSetupInRupees":5000,"minimumContractMonths":24,"availableCityTiers":[1,2],"minimumEmployees":10,"minimumSites":3,"requiresGstin":true,"requiresOneOfProductIds":["P01","P02","P03","P05","P06"],"typicalInstallDays":14},{"id":"P11","category":"Connectivity","name":"Static IP","unit":"per IP","monthlyPriceFloorInRupees":200,"monthlyPriceCeilingInRupees":300,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":["P01","P02","P03"],"typicalInstallDays":1},{"id":"P12","category":"Communication","name":"Cloud Telephony / SIP","unit":"per channel","monthlyPriceFloorInRupees":1000,"monthlyPriceCeilingInRupees":1500,"oneTimeSetupInRupees":2000,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":3,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":["P01","P02","P03","P04","P05","P06"],"typicalInstallDays":5},{"id":"P13","category":"Communication","name":"Toll-free Number","unit":"per number","monthlyPriceFloorInRupees":1500,"monthlyPriceCeilingInRupees":2000,"oneTimeSetupInRupees":1000,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":3},{"id":"P14","category":"Communication","name":"Business SMS 10k","unit":"per pack","monthlyPriceFloorInRupees":1500,"monthlyPriceCeilingInRupees":2000,"oneTimeSetupInRupees":0,"minimumContractMonths":1,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":4},{"id":"P15","category":"Communication","name":"WhatsApp Business API Starter","unit":"per account","monthlyPriceFloorInRupees":999,"monthlyPriceCeilingInRupees":1499,"oneTimeSetupInRupees":0,"minimumContractMonths":3,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":3},{"id":"P16","category":"Cloud & Productivity","name":"Cloud Email & Office Suite","unit":"per user","monthlyPriceFloorInRupees":125,"monthlyPriceCeilingInRupees":150,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P17","category":"Cloud & Productivity","name":"Cloud Backup 1 TB","unit":"per account","monthlyPriceFloorInRupees":499,"monthlyPriceCeilingInRupees":699,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P18","category":"Cloud & Productivity","name":"Website + Domain Starter","unit":"per account","monthlyPriceFloorInRupees":299,"monthlyPriceCeilingInRupees":499,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":2},{"id":"P19","category":"Cloud & Productivity","name":"Cloud POS & Billing","unit":"per counter","monthlyPriceFloorInRupees":599,"monthlyPriceCeilingInRupees":899,"oneTimeSetupInRupees":2500,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":3},{"id":"P20","category":"Security","name":"Endpoint Security","unit":"per device","monthlyPriceFloorInRupees":99,"monthlyPriceCeilingInRupees":149,"oneTimeSetupInRupees":0,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":1},{"id":"P21","category":"Security","name":"Managed Firewall","unit":"per site","monthlyPriceFloorInRupees":1999,"monthlyPriceCeilingInRupees":2999,"oneTimeSetupInRupees":4000,"minimumContractMonths":24,"availableCityTiers":[1,2],"minimumEmployees":10,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":["P01","P02","P03","P05","P06"],"typicalInstallDays":10},{"id":"P22","category":"Security","name":"Secure Wi-Fi with Guest Network","unit":"per site","monthlyPriceFloorInRupees":399,"monthlyPriceCeilingInRupees":599,"oneTimeSetupInRupees":1000,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":["P01","P02","P03","P04"],"typicalInstallDays":3},{"id":"P23","category":"IoT & Physical","name":"Cloud CCTV","unit":"per camera","monthlyPriceFloorInRupees":199,"monthlyPriceCeilingInRupees":299,"oneTimeSetupInRupees":1800,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":["P01","P02","P03","P04","P05","P06"],"typicalInstallDays":4},{"id":"P24","category":"IoT & Physical","name":"Machine Monitoring IoT","unit":"per device","monthlyPriceFloorInRupees":149,"monthlyPriceCeilingInRupees":249,"oneTimeSetupInRupees":3000,"minimumContractMonths":24,"availableCityTiers":[1,2],"minimumEmployees":10,"minimumSites":1,"requiresGstin":true,"requiresOneOfProductIds":[],"typicalInstallDays":10},{"id":"P25","category":"IoT & Physical","name":"Fleet Tracker","unit":"per vehicle","monthlyPriceFloorInRupees":199,"monthlyPriceCeilingInRupees":299,"oneTimeSetupInRupees":1500,"minimumContractMonths":12,"availableCityTiers":[1,2],"minimumEmployees":1,"minimumSites":1,"requiresGstin":false,"requiresOneOfProductIds":[],"typicalInstallDays":3}];

/**
 * Activation-promise data from smb_leads.csv (case pack, synthetic), built by _build/gen_kit.py
 * (compute_activation_promise_data): connectionTypeByProduct (connection product → type) and firmDays[tier][type] =
 * { days, observedDays, catalogueDays, orders, basis }. days = the day by which 9 in 10 past activated orders of that
 * tier and connection were live, never shorter than the catalogue's install time.
 */
const ACTIVATION_PROMISE_DATA = {"connectionTypeByProduct":{"P01":"fibre","P02":"fibre","P03":"fibre_1g","P04":"airfiber","P05":"leased_line","P06":"leased_line"},"anyConnectionType":"any","firmDays":{"1":{"airfiber":{"days":8,"observedDays":8,"catalogueDays":2,"orders":221,"basis":"tier, all connections"},"fibre":{"days":7,"observedDays":7,"catalogueDays":5,"orders":180,"basis":"tier and connection"},"fibre_1g":{"days":7,"observedDays":7,"catalogueDays":7,"orders":27,"basis":"tier and connection"},"leased_line":{"days":21,"observedDays":14,"catalogueDays":21,"orders":27,"basis":"connection, both tiers"},"any":{"days":8,"observedDays":8,"catalogueDays":1,"orders":221,"basis":"tier, all connections"}},"2":{"airfiber":{"days":11,"observedDays":11,"catalogueDays":2,"orders":147,"basis":"tier, all connections"},"fibre":{"days":10,"observedDays":10,"catalogueDays":5,"orders":101,"basis":"tier and connection"},"fibre_1g":{"days":9,"observedDays":9,"catalogueDays":7,"orders":24,"basis":"tier and connection"},"leased_line":{"days":21,"observedDays":14,"catalogueDays":21,"orders":27,"basis":"connection, both tiers"},"any":{"days":11,"observedDays":11,"catalogueDays":1,"orders":147,"basis":"tier, all connections"}}}};
const PRODUCTS_BY_ID = {};
PRODUCT_CATALOGUE.forEach((product) => {
  PRODUCTS_BY_ID[product.id] = product;
});

  return main;
})();

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

/**
 * Shared Udyam reading, format check, masking and owner-facing problem messages (_build/udyam_input.js), embedded
 * unchanged by the build. verify_udyam runs the same code.
 */
const udyamInput = (function embeddedUDYAM_INPUT_API() {
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

const UDYAM_INPUT_API = {
  UDYAM_PROBLEM,
  UDYAM_MESSAGES,
  readUdyam,
  maskUdyam,
  mentionsUdyam,
  problemMessage,
};

  return UDYAM_INPUT_API;
})();
