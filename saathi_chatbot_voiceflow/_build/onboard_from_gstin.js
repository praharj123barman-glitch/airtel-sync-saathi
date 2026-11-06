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
const STATE_NAMES = /*__STATES__*/ [];
/** City names parsed from principal_place_of_business; records store the index in base 36. */
const CITY_NAMES = /*__CITIES__*/ [];
/** Udyam business types (nic_description) with their case segment; records store the index in base 36. */
const NIC_DESCRIPTIONS = /*__NIC_DESCRIPTIONS__*/ [];
const NIC_SEGMENT_BY_DESCRIPTION = {};
NIC_DESCRIPTIONS.forEach(([description, segment]) => {
  NIC_SEGMENT_BY_DESCRIPTION[description] = segment;
});
/** City (lower case) → tier 1 or 2, from smb_leads.csv. */
const CITY_TIER_BY_NAME = /*__CITY_TIERS__*/ {};
/** Smallest employee_count per segment in smb_leads.csv (the first-quote sizing rule; see MIN_PEOPLE_PER_SITE). */
const SMALLEST_TEAM_BY_SEGMENT = /*__SMALLEST_TEAM__*/ {};
/**
 * SIMULATED: mock GST registry joined with the Udyam registry (synthetic case data).
 * One record per line: GSTIN|trade name|status A/C/S|constitution P/C/L|state index|city index|registration date
 * (YYYYMMDD)|Udyam business-type index (blank = no unique Udyam match)
 */
const REGISTRY_TEXT = /*__ONBOARDING_REGISTRY__*/ "";
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
const UDYAM_REGISTRY_TEXT = /*__ONBOARDING_UDYAM_REGISTRY__*/ "";
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
const priceBundleMain = /*__PRICE_BUNDLE_MAIN__*/ null;

/**
 * Shared GSTIN reading, checks, masking and owner-facing problem messages (_build/gstin_input.js), embedded
 * unchanged by the build. The same code runs in verify_gstin, verify_gstin_lite and the demo page.
 */
const gstinInput = /*__GSTIN_INPUT__*/ null;

/**
 * Shared Udyam reading, format check, masking and owner-facing problem messages (_build/udyam_input.js), embedded
 * unchanged by the build. verify_udyam runs the same code.
 */
const udyamInput = /*__UDYAM_INPUT__*/ null;
