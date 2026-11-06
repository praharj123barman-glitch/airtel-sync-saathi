"""gen_kit.py: builds the Voiceflow function tools from the templates in _build/ and the case data.

How it fits: Voiceflow function tools must be single self-contained files, so the case data can't be loaded at
run time. This script injects it at build time:

    product_catalogue.csv      → 3_function_tools/price_bundle.js     (25 products)
    smb_leads.csv              → 3_function_tools/price_bundle.js     (firm activation days per tier and connection)
    mock_gstin_registry.csv    → 3_function_tools/verify_gstin.js     (3,534 records) and verify_gstin_lite.js
    mock_udyam_registry.csv    → 3_function_tools/verify_udyam.js     (2,723 records) and onboard_from_gstin.js
                                 (Udyam entry for owners without a GSTIN)
    _build/udyam_input.js      → embedded in verify_udyam.js and onboard_from_gstin.js (one Udyam reader)
    smb_leads.csv              → 3_function_tools/register_lead.js    (trained lead-score model)
    _build/promise_rules.js + the built price_bundle
                               → 3_function_tools/order_status.js and downtime_credit.js (72-hour promise, credits)
    _build/consent_rules.js    → 3_function_tools/consent_manager.js and 7_demo_site/consent_rules.js
    _build/gstin_input.js      → embedded in onboard_from_gstin.js, verify_gstin(_lite).js and the certificate
                                 reader, and 7_demo_site/gstin_input.js (one GSTIN reader for everything)
    _build/certificate_reader.js and the built onboard_from_gstin
                               → 7_demo_site/certificate_reader.js and 7_demo_site/onboard_from_gstin.js (browser)
    3_function_tools/price_bundle.js → the sizing-rules and activation-promise sections of
                                 4_knowledge_base/saathi_bundles_and_rules.txt
    mock_gstin_registry.csv    → 7_demo_site/sample_certificates/*.png (SAMPLE GST certificates for the OCR demo)
    GST + Udyam registries, lead statistics and the built price_bundle
                               → 3_function_tools/onboard_from_gstin.js (zero-question onboarding)
    product_catalogue.csv + the built price_bundle
                               → 3_function_tools/bill_swap.js        (bill-swap calculator)
    product_catalogue.csv      → 3_function_tools/readiness_score.js  (digital-readiness score)
    leads + GST registry       → _build/reach_rules.js embedded in 3_function_tools/reach_tag_lead.js and in
                                 8_back_office/reach_rules.js (one set of REACH rules for chatbot and back office)
    leads + all of the above   → 8_back_office/sample_leads.js (SIMULATED sample for the back-office page,
                                 built by _build/build_back_office_sample.mjs with Node)
    product_catalogue.csv      → 4_knowledge_base/accel_product_catalogue.csv (readable columns for Voiceflow)

All case data is synthetic (fictional operator and businesses).

Usage:
    python _build/gen_kit.py "<path to YTL_TrackA_Udyam_Digital_Data>" "<path to this kit>"
"""

import base64
import json
import pathlib
import re
import subprocess
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

TEMPLATE_DIR = pathlib.Path(__file__).parent

# Lead-score model settings. C=0.3 (mild regularisation) gave the best 5-fold CV AUC (0.71) in the analysis.
LOGISTIC_REGRESSION_C = 0.3
LOGISTIC_REGRESSION_MAX_ITERATIONS = 3000
# 101 cut points → a lead score from 0 to 100 (percentile of the training predictions).
QUANTILE_CUT_POINT_COUNT = 101
# The model's input fields (columns of smb_leads.csv).
MODEL_CATEGORICAL_COLUMNS = [
    "segment",
    "city_tier",
    "preferred_language",
    "has_gstin",
    "has_udyam",
    "current_internet",
    "current_provider",
    "contact_role",
]
MODEL_NUMERIC_COLUMNS = ["employee_count", "num_sites", "monthly_telecom_spend_inr", "n_interest"]
DUMMY_SEPARATOR = "="

# One-letter codes keep the embedded registries small enough for Voiceflow's code editor.
GSTIN_STATUS_CODE = {"Active": "A", "Cancelled": "C", "Suspended": "S"}
CONSTITUTION_CODE = {"Proprietorship": "P", "Private Limited Company": "C", "Limited Liability Partnership": "L"}
ENTERPRISE_TYPE_CODE = {"Micro": "M", "Small": "S", "Medium": "D"}
MAJOR_ACTIVITY_CODE = {"Trading": "T", "Services": "S", "Manufacturing": "F"}
BASE_36_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
FIELD_SEPARATOR = "|"

SEGMENT_NAME_BY_CODE = {
    "micro": "Micro retail & services",
    "prof": "Professional offices",
    "multi": "Small multi-site businesses",
    "mfg": "Small manufacturers",
}

# Placeholders in the templates, replaced with data.
PLACEHOLDER_CATALOGUE = "/*__CATALOGUE__*/ []"
PLACEHOLDER_ACTIVATION_PROMISE_DATA = "/*__ACTIVATION_PROMISE_DATA__*/ {}"
PLACEHOLDER_STATES = "/*__STATES__*/ []"
PLACEHOLDER_LITE_FLAG = "/*__LITE__*/ false"
PLACEHOLDER_GSTIN_REGISTRY = '/*__GSTIN_REGISTRY__*/ ""'
PLACEHOLDER_UDYAM_REGISTRY = '/*__UDYAM_REGISTRY__*/ ""'
PLACEHOLDER_MODEL = "/*__MODEL__*/ {}"
PLACEHOLDER_CITIES = "/*__CITIES__*/ []"
PLACEHOLDER_NIC_DESCRIPTIONS = "/*__NIC_DESCRIPTIONS__*/ []"
PLACEHOLDER_CITY_TIERS = "/*__CITY_TIERS__*/ {}"
PLACEHOLDER_SMALLEST_TEAM = "/*__SMALLEST_TEAM__*/ {}"
PLACEHOLDER_ONBOARDING_REGISTRY = '/*__ONBOARDING_REGISTRY__*/ ""'
PLACEHOLDER_PRICE_BUNDLE_MAIN = "/*__PRICE_BUNDLE_MAIN__*/ null"
PLACEHOLDER_PRODUCT_DESCRIPTIONS = "/*__PRODUCT_DESCRIPTIONS__*/ {}"
PLACEHOLDER_PRODUCT_RULES = "/*__PRODUCT_RULES__*/ {}"
PLACEHOLDER_REFERRER_DIRECTORY = "/*__REFERRER_DIRECTORY__*/ []"
PLACEHOLDER_TERRITORIES = "/*__TERRITORIES__*/ []"
PLACEHOLDER_STATE_DEFAULT_TERRITORY = "/*__STATE_DEFAULT_TERRITORY__*/ {}"
PLACEHOLDER_STATE_NAME_BY_CODE = "/*__STATE_NAME_BY_CODE__*/ {}"
PLACEHOLDER_REACH_RULES = "/*__REACH_RULES__*/ null"
PLACEHOLDER_PROMISE_RULES = "/*__PROMISE_RULES__*/ null"
PLACEHOLDER_CONSENT_RULES = "/*__CONSENT_RULES__*/ null"
PLACEHOLDER_GSTIN_INPUT = "/*__GSTIN_INPUT__*/ null"
GSTIN_INPUT_EXPORT_LINE = "export const GSTIN_INPUT_API = {"
PLACEHOLDER_UDYAM_INPUT = "/*__UDYAM_INPUT__*/ null"
UDYAM_INPUT_EXPORT_LINE = "export const UDYAM_INPUT_API = {"
PLACEHOLDER_ONBOARDING_UDYAM_REGISTRY = '/*__ONBOARDING_UDYAM_REGISTRY__*/ ""'
# Udyam numbers in the onboarding registry are stored without this prefix ("KL-00-3078801"), to keep the file small.
UDYAM_NUMBER_PREFIX = "UDYAM-"
DEMO_SITE_DIR_NAME = "7_demo_site"
# GSTINs drawn as SAMPLE certificates: an active company, an active proprietorship, a cancelled registration.
SAMPLE_CERTIFICATE_GSTINS = {
    "07PUTXM1153M1Z9": "metro_diagnostics",
    "03PJNXS4821G1ZB": "saffron_bakers",
    "29OKAXP4077P1ZL": "prime_general_store_cancelled",
}
# Sample certificate layout (pixels). Large, plain text so Tesseract.js reads it reliably.
CERTIFICATE_SIZE = (1600, 1100)
CERTIFICATE_MARGIN = 80
CERTIFICATE_FONT_SIZES = {"title": 44, "subtitle": 24, "field": 34, "footer": 22, "watermark": 260}
CERTIFICATE_LINE_HEIGHT = 74

# reach_rules.js exports its API; inside an embedding it becomes a plain constant returned by the wrapper.
REACH_EXPORT_LINE = "export const REACH_RULES_API = {"
REACH_EMBEDDED_LINE = "const REACH_RULES_API = {"
# SIMULATED referrer directory: two CA partners per city (no CA data in the case pack; a pilot assumption).
CA_PARTNERS_PER_CITY = 2
# Field-rep and territory IDs use the first letters of the city: REP-DEL, T-DEL.
CITY_CODE_LENGTH = 3
BACK_OFFICE_DIR_NAME = "8_back_office"
# The case's "today" (data README): the sample's reward hold periods are measured from here.
CASE_TODAY = "2026-07-15"

# Firm activation dates (STRATEGY.md §11): the promise on quotes outside the 72-hour guarantee's scope.
# "Activated" = days from kyc_complete_date (the order is confirmed: the promise clock starts) to activated_date.
# The firm date is the day by which this share of past activated orders in the same group were live (design choice:
# the promise is missed about 1 time in 10 when installation goes ahead).
FIRM_DATE_QUANTILE = 0.9
# Groups smaller than this fall back to the same connection type in both tiers, then to every order in the tier.
FIRM_DATE_MIN_ORDERS = 20
# Connection product → connection type. The firm-date groups are city tier × connection type. Fibre up to 300 Mbps
# and AirFiber are self-installed or street-level; 1 Gbps fibre and leased lines need a site survey (7–30 days in
# the catalogue). The one place this mapping lives: price_bundle reads it from the injected data.
CONNECTION_TYPE_BY_PRODUCT = {
    "P01": "fibre",
    "P02": "fibre",
    "P03": "fibre_1g",
    "P04": "airfiber",
    "P05": "leased_line",
    "P06": "leased_line",
}
# The firm-date group for a quote with no connection item (should not happen; kept so a promise is always shown).
ANY_CONNECTION_TYPE = "any"

# price_bundle's entry point, turned into a plain function when it is embedded in another function tool.
PRICE_BUNDLE_EXPORT_LINE = "export default async function main(args) {"
PRICE_BUNDLE_EMBEDDED_LINE = "async function main(args) {"
# Segment codes used by the function tools, keyed by the case's segment names.
SEGMENT_CODE_BY_NAME = {name: code for code, name in SEGMENT_NAME_BY_CODE.items()}
# Business-name words dropped when linking a GST record to a Udyam record (legal-form suffixes).
LEGAL_FORM_WORDS = {"pvt", "ltd", "private", "limited", "llp"}


def read_template(file_name: str) -> str:
    """Returns a template's text from _build/."""
    return (TEMPLATE_DIR / file_name).read_text(encoding="utf-8")


def inject(template: str, placeholder: str, value: str) -> str:
    """Replaces one placeholder; fails loudly if the template no longer contains it (catches template edits)."""
    if placeholder not in template:
        raise ValueError(f"placeholder {placeholder!r} not found in template")
    return template.replace(placeholder, value)


def to_compact_json(value) -> str:
    """JSON without spaces, keeping Hindi and ₹ as readable characters."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def days_from_kyc_to_activation(activated_leads: pd.DataFrame) -> pd.Series:
    """Whole days from KYC complete (order confirmed) to activation, per activated lead. Dates only, no times."""
    return (pd.to_datetime(activated_leads.activated_date) - pd.to_datetime(activated_leads.kyc_complete_date)).dt.days


def connection_type_of_bundle(bundle_products: str) -> str:
    """The connection type of a bought bundle ("P01x1;P07x2" → "fibre"); ANY_CONNECTION_TYPE if it has none."""
    for item in bundle_products.split(";"):
        product_id = item.split("x")[0]
        if product_id in CONNECTION_TYPE_BY_PRODUCT:
            return CONNECTION_TYPE_BY_PRODUCT[product_id]
    return ANY_CONNECTION_TYPE


def compute_activation_promise_data(leads: pd.DataFrame, catalogue: pd.DataFrame) -> dict:
    """Firm activation days per city tier and connection type, from the activated leads in smb_leads.csv.

    days = the FIRM_DATE_QUANTILE of observed KYC → activation days in the group, but never shorter than the
    catalogue's own install time for that connection (the data README: "use typical_install_days … for expected
    activation dates"). Small groups fall back as FIRM_DATE_MIN_ORDERS says; "basis" records which data was used.
    Returns {"connectionTypeByProduct": {...}, "anyConnectionType": "any",
             "firmDays": {"1": {"fibre": {"days": 7, ...}, ...}, "2": {...}}}.
    Example: firmDays["2"]["fibre"] = {"days": 10, "observedDays": 10, "catalogueDays": 5, "orders": 101, ...}.
    """
    activated = leads[leads.outcome == "Activated"]
    observed_days = days_from_kyc_to_activation(activated)
    connection_types = activated.bundle_products.map(connection_type_of_bundle)
    install_days = dict(zip(catalogue.product_id, catalogue.typical_install_days, strict=True))
    firm_days = {}
    for tier in sorted(leads.city_tier.unique()):
        in_tier = activated.city_tier == tier
        firm_days[str(tier)] = {}
        for connection_type in sorted(set(CONNECTION_TYPE_BY_PRODUCT.values())) + [ANY_CONNECTION_TYPE]:
            if connection_type == ANY_CONNECTION_TYPE:
                group, basis = observed_days[in_tier], "tier, all connections"
                catalogue_days = 1
            else:
                group, basis = observed_days[in_tier & (connection_types == connection_type)], "tier and connection"
                if len(group) < FIRM_DATE_MIN_ORDERS:
                    group, basis = observed_days[connection_types == connection_type], "connection, both tiers"
                if len(group) < FIRM_DATE_MIN_ORDERS:
                    group, basis = observed_days[in_tier], "tier, all connections"
                catalogue_days = min(
                    int(install_days[product_id])
                    for product_id, product_type in CONNECTION_TYPE_BY_PRODUCT.items()
                    if product_type == connection_type
                )
            observed = int(np.quantile(group, FIRM_DATE_QUANTILE, method="higher"))
            firm_days[str(tier)][connection_type] = {
                "days": max(observed, catalogue_days),
                "observedDays": observed,
                "catalogueDays": catalogue_days,
                "orders": int(len(group)),
                "basis": basis,
            }
    return {
        "connectionTypeByProduct": CONNECTION_TYPE_BY_PRODUCT,
        "anyConnectionType": ANY_CONNECTION_TYPE,
        "firmDays": firm_days,
    }


def write_price_bundle(catalogue: pd.DataFrame, leads: pd.DataFrame, functions_dir: pathlib.Path) -> str:
    """Injects the product catalogue and the firm activation days into price_bundle.js; returns the finished script.

    Example product: {"id": "P01", "name": "Biz Fibre 100", "monthlyPriceFloorInRupees": 999, ...}
    """
    products = []
    for row in catalogue.itertuples():
        products.append(
            {
                "id": row.product_id,
                "category": row.category,
                "name": row.product_name,
                "unit": row.unit,
                "monthlyPriceFloorInRupees": int(row.price_min_inr_per_month),
                "monthlyPriceCeilingInRupees": int(row.price_max_inr_per_month),
                "oneTimeSetupInRupees": int(row.one_time_setup_inr),
                "minimumContractMonths": int(row.min_contract_months),
                "availableCityTiers": [int(tier) for tier in str(row.available_city_tiers).split(";")],
                "minimumEmployees": int(row.min_employees),
                "minimumSites": int(row.min_sites),
                "requiresGstin": row.requires_gstin == "Y",
                "requiresOneOfProductIds": [] if pd.isna(row.requires_one_of) else str(row.requires_one_of).split("|"),
                "typicalInstallDays": int(row.typical_install_days),
            }
        )
    script = inject(read_template("price_bundle.js"), PLACEHOLDER_CATALOGUE, to_compact_json(products))
    script = inject(
        script,
        PLACEHOLDER_ACTIVATION_PROMISE_DATA,
        to_compact_json(compute_activation_promise_data(leads, catalogue)),
    )
    (functions_dir / "price_bundle.js").write_text(script, encoding="utf-8")
    return script


def write_gstin_verifiers(registry: pd.DataFrame, functions_dir: pathlib.Path) -> None:
    """Writes verify_gstin.js (whole registry) and verify_gstin_lite.js (only cancelled/suspended records).

    Record line: GSTIN|legal name|trade name (blank if same)|status code|constitution code|state index (base 36)
    """
    state_names = sorted(registry.state.unique())
    state_index = {state: index for index, state in enumerate(state_names)}
    record_lines = []
    for row in registry.itertuples():
        trade_name = "" if row.trade_name == row.legal_name else row.trade_name
        record_lines.append(
            FIELD_SEPARATOR.join(
                [
                    row.gstin,
                    row.legal_name.replace(FIELD_SEPARATOR, "/"),
                    trade_name.replace(FIELD_SEPARATOR, "/"),
                    GSTIN_STATUS_CODE[row.status],
                    CONSTITUTION_CODE[row.constitution],
                    BASE_36_DIGITS[state_index[row.state]],
                ]
            )
        )
    template = inject(read_template("verify_gstin.js"), PLACEHOLDER_STATES, json.dumps(state_names, ensure_ascii=False))
    template = inject(template, PLACEHOLDER_GSTIN_INPUT, embed_gstin_input())

    full_script = inject(template, PLACEHOLDER_LITE_FLAG, "false")
    full_script = inject(
        full_script, PLACEHOLDER_GSTIN_REGISTRY, json.dumps("\n".join(record_lines), ensure_ascii=False)
    )
    (functions_dir / "verify_gstin.js").write_text(full_script, encoding="utf-8")

    blocked_lines = [line for line in record_lines if line.split(FIELD_SEPARATOR)[3] != GSTIN_STATUS_CODE["Active"]]
    lite_script = inject(template, PLACEHOLDER_LITE_FLAG, "true")
    lite_script = inject(
        lite_script, PLACEHOLDER_GSTIN_REGISTRY, json.dumps("\n".join(blocked_lines), ensure_ascii=False)
    )
    lite_script = lite_script.replace(
        'verify_gstin.js: Voiceflow function tool "verify_gstin"',
        "verify_gstin_lite.js: LITE build, use only if the full verify_gstin.js is too big for Voiceflow's editor."
        ' Voiceflow function tool "verify_gstin"',
        1,
    )
    (functions_dir / "verify_gstin_lite.js").write_text(lite_script, encoding="utf-8")


def write_udyam_verifier(registry: pd.DataFrame, functions_dir: pathlib.Path) -> None:
    """Injects the Udyam registry into verify_udyam.js. Record line: number|name|type code|activity code|city."""
    record_lines = [
        FIELD_SEPARATOR.join(
            [
                row.udyam_number,
                row.enterprise_name.replace(FIELD_SEPARATOR, "/"),
                ENTERPRISE_TYPE_CODE[row.enterprise_type],
                MAJOR_ACTIVITY_CODE[row.major_activity],
                row.city,
            ]
        )
        for row in registry.itertuples()
    ]
    script = inject(
        read_template("verify_udyam.js"),
        PLACEHOLDER_UDYAM_REGISTRY,
        json.dumps("\n".join(record_lines), ensure_ascii=False),
    )
    script = inject(script, PLACEHOLDER_UDYAM_INPUT, embed_udyam_input())
    (functions_dir / "verify_udyam.js").write_text(script, encoding="utf-8")


def train_lead_score_model(leads: pd.DataFrame) -> dict:
    """Trains the logistic-regression lead score on smb_leads.csv and returns it as plain data for JavaScript.

    Returns keys: features, mean, scale, coef, intercept, quantiles, tier1.
    """
    activated = (leads.outcome == "Activated").astype(int)
    leads = leads.assign(n_interest=leads.products_of_interest.fillna("").str.count(";") + 1)
    features = (
        pd.get_dummies(leads[MODEL_CATEGORICAL_COLUMNS].astype(str), prefix_sep=DUMMY_SEPARATOR)
        .astype(float)
        .join(leads[MODEL_NUMERIC_COLUMNS].astype(float))
    )
    scaler = StandardScaler().fit(features)
    model = LogisticRegression(max_iter=LOGISTIC_REGRESSION_MAX_ITERATIONS, C=LOGISTIC_REGRESSION_C).fit(
        scaler.transform(features), activated
    )
    probabilities = model.predict_proba(scaler.transform(features))[:, 1]

    feature_list = []
    for column in features.columns:
        if DUMMY_SEPARATOR in column:
            group, value = column.split(DUMMY_SEPARATOR, 1)
            feature_list.append({"group": group, "value": value})
        else:
            feature_list.append({"name": column})

    top_fifth = len(activated) // 5
    capture = activated.values[np.argsort(-probabilities)][:top_fifth].sum() / activated.sum()
    print(
        f"lead-score model: top 20% of leads capture {capture:.1%} of activations (in-sample), "
        f"{len(feature_list)} features"
    )

    return {
        "features": feature_list,
        "mean": [round(float(value), 6) for value in scaler.mean_],
        "scale": [round(float(value), 6) for value in scaler.scale_],
        "coef": [round(float(value), 6) for value in model.coef_[0]],
        "intercept": round(float(model.intercept_[0]), 6),
        "quantiles": [
            round(float(value), 6) for value in np.quantile(probabilities, np.linspace(0, 1, QUANTILE_CUT_POINT_COUNT))
        ],
        "tier1": sorted(leads.loc[leads.city_tier == 1, "city"].str.lower().unique().tolist()),
    }


def write_lead_scorer(leads: pd.DataFrame, functions_dir: pathlib.Path) -> None:
    """Injects the trained model into register_lead.js."""
    model = train_lead_score_model(leads)
    script = inject(read_template("register_lead.js"), PLACEHOLDER_MODEL, to_compact_json(model))
    (functions_dir / "register_lead.js").write_text(script, encoding="utf-8")


def write_knowledge_base_catalogue(catalogue: pd.DataFrame, knowledge_base_dir: pathlib.Path) -> None:
    """Writes the catalogue with plain-English column names for Voiceflow's knowledge base (one row = one chunk)."""
    readable = pd.DataFrame(
        {
            "Product ID": catalogue.product_id,
            "Category": catalogue.category,
            "Product name": catalogue.product_name,
            "What it is": catalogue.description,
            "Charged per": catalogue.unit.str.replace("per ", "", regex=False),
            "Monthly price from (INR, committed term)": catalogue.price_min_inr_per_month,
            "Monthly list price up to (INR)": catalogue.price_max_inr_per_month,
            "One-time setup (INR)": catalogue.one_time_setup_inr,
            "Minimum contract (months)": catalogue.min_contract_months,
            "Sold in city tiers": catalogue.available_city_tiers.str.replace(";", " and ", regex=False),
            "Minimum employees": catalogue.min_employees,
            "Minimum sites": catalogue.min_sites,
            "Needs an active GSTIN": catalogue.requires_gstin.map({"Y": "Yes", "N": "No"}),
            "Must be bought with one of": catalogue.requires_one_of.fillna("-").str.replace("|", " or ", regex=False),
            "Typical install time (days)": catalogue.typical_install_days,
            "Best for": catalogue.target_segments.map(
                lambda codes: ", ".join(SEGMENT_NAME_BY_CODE[code] for code in codes.split(";"))
            ),
        }
    )
    readable.to_csv(knowledge_base_dir / "accel_product_catalogue.csv", index=False, encoding="utf-8")


def normalise_business_name(name: str) -> str:
    """Lower-case name without punctuation or legal-form words; "(Prop. Saffron Bakers)" keeps "saffron bakers"."""
    text = re.sub(r"\(prop\.\s*([^)]*)\)", r"\1", str(name).lower())
    text = re.sub(r"[^a-z0-9 ]", " ", text)
    return " ".join(word for word in text.split() if word not in LEGAL_FORM_WORDS)


def link_gstin_to_udyam_business_type(gstin_registry: pd.DataFrame, udyam_registry: pd.DataFrame) -> pd.Series:
    """SIMULATED link: the Udyam nic_description for each GSTIN when exactly one Udyam record has the same name + state.

    Production would follow the PAN inside the GSTIN to the Udyam record; the mock registries have no PAN.
    Ambiguous (several matches) and missing matches give an empty string.
    """
    udyam_keys = udyam_registry.enterprise_name.map(normalise_business_name) + "|" + udyam_registry.state
    matches_per_key = udyam_keys.value_counts()
    business_type_by_key = pd.Series(udyam_registry.nic_description.values, index=udyam_keys).groupby(level=0).first()
    gst_keys = gstin_registry.trade_name.map(normalise_business_name) + "|" + gstin_registry.state
    is_unique = gst_keys.map(matches_per_key).fillna(0).eq(1)
    return gst_keys.map(business_type_by_key).where(is_unique, "").fillna("")


def embed_price_bundle(price_bundle_script: str) -> str:
    """Wraps the built price_bundle.js in its own scope and returns an expression that evaluates to its main().

    This keeps one source of truth for prices: onboarding calls the very same code Voiceflow runs as price_bundle.
    """
    if price_bundle_script.count(PRICE_BUNDLE_EXPORT_LINE) != 1:
        raise ValueError("price_bundle.js entry point not found: update PRICE_BUNDLE_EXPORT_LINE")
    body = price_bundle_script.replace(PRICE_BUNDLE_EXPORT_LINE, PRICE_BUNDLE_EMBEDDED_LINE)
    return "(function embeddedPriceBundle() {\n" + body + "\n  return main;\n})()"


def compute_smallest_teams(leads: pd.DataFrame) -> dict:
    """Smallest employee_count per segment code in smb_leads.csv: the first-quote sizing rule in onboarding.

    Pricing the first quote for the smallest real business in the segment means it never overshoots what the
    business pays at its true size (price_bundle only goes up with team size)."""
    segment_codes = leads.segment.map(SEGMENT_CODE_BY_NAME)
    return {segment: int(group.min()) for segment, group in leads.employee_count.groupby(segment_codes)}


def write_onboarding(
    gstin_registry: pd.DataFrame,
    udyam_registry: pd.DataFrame,
    leads: pd.DataFrame,
    price_bundle_script: str,
    functions_dir: pathlib.Path,
) -> None:
    """Builds onboard_from_gstin.js: GST registry joined with Udyam business types, case statistics, price_bundle.

    Record line: GSTIN|trade name|status code|constitution code|state index|city index|YYYYMMDD|business-type index
    """
    address_parts = gstin_registry.principal_place_of_business.str.extract(r",\s*([^,]+),\s*([^,]+?)\s*-\s*\d{6}$")
    if address_parts[0].isna().any():
        raise ValueError("some principal_place_of_business values have an unexpected format")
    cities = address_parts[0].str.strip()
    city_names = sorted(cities.unique())
    state_names = sorted(gstin_registry.state.unique())
    nic_descriptions = sorted(udyam_registry.nic_description.unique())
    for values in (city_names, state_names, nic_descriptions):
        if len(values) > len(BASE_36_DIGITS):
            raise ValueError("too many values for a one-character index; widen the record format")
    segment_by_business_type = leads.drop_duplicates("business_type").set_index("business_type").segment
    nic_entries = [[nic, SEGMENT_CODE_BY_NAME[segment_by_business_type[nic]]] for nic in nic_descriptions]

    linked_business_types = link_gstin_to_udyam_business_type(gstin_registry, udyam_registry)
    record_lines = []
    for row, city, business_type in zip(gstin_registry.itertuples(), cities, linked_business_types, strict=True):
        record_lines.append(
            FIELD_SEPARATOR.join(
                [
                    row.gstin,
                    row.trade_name.replace(FIELD_SEPARATOR, "/"),
                    GSTIN_STATUS_CODE[row.status],
                    CONSTITUTION_CODE[row.constitution],
                    BASE_36_DIGITS[state_names.index(row.state)],
                    BASE_36_DIGITS[city_names.index(city)],
                    str(row.registration_date).replace("-", ""),
                    BASE_36_DIGITS[nic_descriptions.index(business_type)] if business_type else "",
                ]
            )
        )
    city_tiers = {city.lower(): int(tier) for city, tier in leads.drop_duplicates("city")[["city", "city_tier"]].values}

    script = read_template("onboard_from_gstin.js")
    script = inject(script, PLACEHOLDER_STATES, json.dumps(state_names, ensure_ascii=False))
    script = inject(script, PLACEHOLDER_CITIES, json.dumps(city_names, ensure_ascii=False))
    script = inject(script, PLACEHOLDER_NIC_DESCRIPTIONS, to_compact_json(nic_entries))
    script = inject(script, PLACEHOLDER_CITY_TIERS, to_compact_json(city_tiers))
    script = inject(script, PLACEHOLDER_SMALLEST_TEAM, to_compact_json(compute_smallest_teams(leads)))
    script = inject(script, PLACEHOLDER_ONBOARDING_REGISTRY, json.dumps("\n".join(record_lines), ensure_ascii=False))
    udyam_lines = build_onboarding_udyam_lines(udyam_registry, state_names, city_names, nic_descriptions)
    script = inject(
        script, PLACEHOLDER_ONBOARDING_UDYAM_REGISTRY, json.dumps("\n".join(udyam_lines), ensure_ascii=False)
    )
    script = inject(script, PLACEHOLDER_GSTIN_INPUT, embed_gstin_input())
    script = inject(script, PLACEHOLDER_UDYAM_INPUT, embed_udyam_input())
    script = inject(script, PLACEHOLDER_PRICE_BUNDLE_MAIN, embed_price_bundle(price_bundle_script))
    (functions_dir / "onboard_from_gstin.js").write_text(script, encoding="utf-8")
    linked_share = (linked_business_types != "").mean()
    print(
        f"onboarding: {len(record_lines)} GSTINs, {linked_share:.1%} with a unique Udyam business type; "
        f"{len(udyam_lines)} Udyam numbers for Udyam entry"
    )


def build_onboarding_udyam_lines(
    udyam_registry: pd.DataFrame, state_names: list, city_names: list, nic_descriptions: list
) -> list:
    """The Udyam registry for Udyam entry in onboarding (STRATEGY.md §12), one record per line:
    number without "UDYAM-"|enterprise name|business-type index|state index|city index|YYYYMMDD|enterprise type code.
    Indices point into the same STATE_NAMES, CITY_NAMES and NIC_DESCRIPTIONS lists as the GST records.
    Example: "KL-00-3078801|Balaji Dental Care LLP|8|f|b|20231225|M"."""
    lines = []
    for row in udyam_registry.itertuples():
        if row.state not in state_names or row.city not in city_names:
            raise ValueError(f"Udyam record {row.udyam_number}: state or city missing from the GST lists")
        lines.append(
            FIELD_SEPARATOR.join(
                [
                    row.udyam_number.removeprefix(UDYAM_NUMBER_PREFIX),
                    row.enterprise_name.replace(FIELD_SEPARATOR, "/"),
                    BASE_36_DIGITS[nic_descriptions.index(row.nic_description)],
                    BASE_36_DIGITS[state_names.index(row.state)],
                    BASE_36_DIGITS[city_names.index(row.city)],
                    str(row.date_of_registration).replace("-", ""),
                    ENTERPRISE_TYPE_CODE[row.enterprise_type],
                ]
            )
        )
    return lines


def write_bill_swap(catalogue: pd.DataFrame, price_bundle_script: str, functions_dir: pathlib.Path) -> None:
    """Builds bill_swap.js: product names and descriptions from the catalogue, plus the embedded price_bundle."""
    descriptions = {
        row.product_id: {"name": row.product_name, "description": row.description} for row in catalogue.itertuples()
    }
    script = read_template("bill_swap.js")
    script = inject(script, PLACEHOLDER_PRODUCT_DESCRIPTIONS, to_compact_json(descriptions))
    script = inject(script, PLACEHOLDER_PRICE_BUNDLE_MAIN, embed_price_bundle(price_bundle_script))
    (functions_dir / "bill_swap.js").write_text(script, encoding="utf-8")


def write_readiness_score(catalogue: pd.DataFrame, functions_dir: pathlib.Path) -> None:
    """Builds readiness_score.js with each product's eligibility rules (no prices: the score never quotes)."""
    rules = {
        row.product_id: {
            "name": row.product_name,
            "requiresGstin": row.requires_gstin == "Y",
            "minimumEmployees": int(row.min_employees),
            "minimumSites": int(row.min_sites),
        }
        for row in catalogue.itertuples()
    }
    script = inject(read_template("readiness_score.js"), PLACEHOLDER_PRODUCT_RULES, to_compact_json(rules))
    (functions_dir / "readiness_score.js").write_text(script, encoding="utf-8")


def build_reach_data(leads: pd.DataFrame, gstin_registry: pd.DataFrame) -> dict:
    """SIMULATED REACH directory from the case data: a territory and field rep per city, two CA partners per city,
    every activated lead as a customer micro-agent, and GST state codes. Returns the four injected structures."""
    cities = leads.drop_duplicates("city")[["city", "state"]].sort_values("city")
    city_codes = {city: city[:CITY_CODE_LENGTH].upper() for city in cities.city}
    if len(set(city_codes.values())) != len(city_codes):
        raise ValueError("two cities share a code: lengthen CITY_CODE_LENGTH")
    territories = [
        {
            "id": "T-" + city_codes[row.city],
            "city": row.city,
            "state": row.state,
            "repId": "REP-" + city_codes[row.city],
            "repLabel": "Field rep · " + row.city,
        }
        for row in cities.itertuples()
    ]
    territory_by_city = {territory["city"]: territory for territory in territories}
    busiest_city_by_state = leads.groupby(["state", "city"]).size().reset_index(name="leads")
    busiest_city_by_state = busiest_city_by_state.sort_values("leads", ascending=False).drop_duplicates("state")
    state_default_territory = {
        row.state: territory_by_city[row.city]["id"] for row in busiest_city_by_state.itertuples()
    }

    directory = [
        {"type": "field_rep", "id": territory["repId"], "label": territory["repLabel"], "territoryId": territory["id"]}
        for territory in territories
    ]
    for territory in territories:
        for number in range(1, CA_PARTNERS_PER_CITY + 1):
            directory.append(
                {
                    "type": "ca_partner",
                    "id": f"CA-{territory['id'][2:]}-{number}",
                    "label": f"CA partner {number} · {territory['city']}",
                    "territoryId": territory["id"],
                }
            )
    activated = leads[leads.outcome == "Activated"]
    for row in activated.itertuples():
        directory.append(
            {
                "type": "customer",
                "id": row.lead_id,
                "label": row.business_name,
                "territoryId": territory_by_city[row.city]["id"],
            }
        )
    state_name_by_code = (
        gstin_registry.assign(code=gstin_registry.gstin.str[:2])
        .drop_duplicates("code")
        .set_index("code")
        .state.to_dict()
    )
    return {
        "directory": directory,
        "territories": territories,
        "state_default_territory": state_default_territory,
        "state_name_by_code": state_name_by_code,
    }


def embed_reach_rules(rules_script: str) -> str:
    """Wraps the built reach_rules.js in its own scope; returns an expression that evaluates to its API object."""
    if rules_script.count(REACH_EXPORT_LINE) != 1:
        raise ValueError("reach_rules.js export not found: update REACH_EXPORT_LINE")
    body = rules_script.replace(REACH_EXPORT_LINE, REACH_EMBEDDED_LINE)
    return "(function embeddedReachRules() {\n" + body + "\n  return REACH_RULES_API;\n})()"


def write_reach(
    leads: pd.DataFrame, gstin_registry: pd.DataFrame, functions_dir: pathlib.Path, kit_dir: pathlib.Path
) -> None:
    """Builds the REACH rules once and embeds them in the Voiceflow function and the back-office page."""
    data = build_reach_data(leads, gstin_registry)
    rules = read_template("reach_rules.js")
    rules = inject(rules, PLACEHOLDER_REFERRER_DIRECTORY, to_compact_json(data["directory"]))
    rules = inject(rules, PLACEHOLDER_TERRITORIES, to_compact_json(data["territories"]))
    rules = inject(rules, PLACEHOLDER_STATE_DEFAULT_TERRITORY, to_compact_json(data["state_default_territory"]))
    rules = inject(rules, PLACEHOLDER_STATE_NAME_BY_CODE, to_compact_json(data["state_name_by_code"]))
    embedded = embed_reach_rules(rules)

    script = inject(read_template("reach_tag_lead.js"), PLACEHOLDER_REACH_RULES, embedded)
    (functions_dir / "reach_tag_lead.js").write_text(script, encoding="utf-8")

    back_office_dir = kit_dir / BACK_OFFICE_DIR_NAME
    back_office_dir.mkdir(parents=True, exist_ok=True)
    header = (
        "/* GENERATED by _build/gen_kit.py from _build/reach_rules.js: do not edit here.\n"
        " * The same rules are embedded in 3_function_tools/reach_tag_lead.js (the chatbot). */\n"
    )
    (back_office_dir / "reach_rules.js").write_text(
        header + "window.ReachRules = " + embedded + ";\n", encoding="utf-8"
    )
    counts = pd.Series([entry["type"] for entry in data["directory"]]).value_counts().to_dict()
    print(f"reach: {len(data['territories'])} territories, referrers {counts}")


def write_knowledge_base_sizing_rules(kit_dir: pathlib.Path) -> None:
    """Writes the sizing-rules section of 4_knowledge_base/saathi_bundles_and_rules.txt from the generated
    price_bundle.js (its THRESHOLDS, SIZING and catalogue), so the knowledge base and the pricing never drift."""
    script = TEMPLATE_DIR / "kb_sizing_rules.mjs"
    subprocess.run(["node", str(script), str(kit_dir)], check=True)


def write_knowledge_base_promise_rules(kit_dir: pathlib.Path) -> None:
    """Writes the activation-promise section of 4_knowledge_base/saathi_bundles_and_rules.txt from the generated
    price_bundle.js (GUARANTEE_SCOPE and the firm activation days), so Saathi's knowledge base can never promise
    72 hours to an order the pricing code doesn't qualify."""
    script = TEMPLATE_DIR / "kb_promise_rules.mjs"
    subprocess.run(["node", str(script), str(kit_dir)], check=True)


def write_back_office_sample(case_data_dir: pathlib.Path, kit_dir: pathlib.Path) -> None:
    """Runs the Node script that turns smb_leads.csv into the back-office sample with the real function tools."""
    script = TEMPLATE_DIR / "build_back_office_sample.mjs"
    subprocess.run(["node", str(script), str(case_data_dir), str(kit_dir), CASE_TODAY], check=True)


def embed_module(script: str, export_line: str, api_name: str) -> str:
    """Wraps an ES-module rules file in its own scope; returns an expression that evaluates to its exported API.

    Used for every shared rules file, so the Voiceflow function and the browser page run the very same code.
    """
    if script.count(export_line) != 1:
        raise ValueError(f"export not found: {export_line!r}")
    body = script.replace(export_line, export_line.replace("export const ", "const ", 1))
    return f"(function embedded{api_name}() {{\n{body}\n  return {api_name};\n}})()"


def write_browser_script(path: pathlib.Path, global_name: str, expression: str, source_name: str) -> None:
    """Writes a classic browser script (works from file://) that sets window.<global_name> to the embedded module."""
    header = f"/* GENERATED by _build/gen_kit.py from _build/{source_name}: do not edit here. */\n"
    path.write_text(header + f"window.{global_name} = {expression};\n", encoding="utf-8")


def embed_udyam_input() -> str:
    """The shared Udyam reader (_build/udyam_input.js) as an expression, for every file that reads a Udyam number."""
    return embed_module(read_template("udyam_input.js"), UDYAM_INPUT_EXPORT_LINE, "UDYAM_INPUT_API")


def embed_gstin_input() -> str:
    """The shared GSTIN reader (_build/gstin_input.js) as an expression, for every file that reads a GSTIN."""
    return embed_module(read_template("gstin_input.js"), GSTIN_INPUT_EXPORT_LINE, "GSTIN_INPUT_API")


def write_promise(price_bundle_script: str, functions_dir: pathlib.Path) -> None:
    """Builds order_status.js and downtime_credit.js: the PROMISE rules plus the embedded price_bundle."""
    embedded_rules = embed_module(
        read_template("promise_rules.js"), "export const PROMISE_RULES_API = {", "PROMISE_RULES_API"
    )
    embedded_pricing = embed_price_bundle(price_bundle_script)
    for name in ("order_status.js", "downtime_credit.js"):
        script = inject(read_template(name), PLACEHOLDER_PROMISE_RULES, embedded_rules)
        script = inject(script, PLACEHOLDER_PRICE_BUNDLE_MAIN, embedded_pricing)
        (functions_dir / name).write_text(script, encoding="utf-8")


def write_consent(functions_dir: pathlib.Path, kit_dir: pathlib.Path) -> None:
    """Builds consent_manager.js and the demo page's consent_rules.js from one source."""
    embedded = embed_module(
        read_template("consent_rules.js"), "export const CONSENT_RULES_API = {", "CONSENT_RULES_API"
    )
    script = inject(read_template("consent_manager.js"), PLACEHOLDER_CONSENT_RULES, embedded)
    (functions_dir / "consent_manager.js").write_text(script, encoding="utf-8")
    write_browser_script(
        kit_dir / DEMO_SITE_DIR_NAME / "consent_rules.js", "ConsentRules", embedded, "consent_rules.js"
    )


def write_demo_site_scripts(functions_dir: pathlib.Path, kit_dir: pathlib.Path) -> None:
    """The demo page's certificate reader and a browser copy of the built onboarding function (same validation)."""
    demo_dir = kit_dir / DEMO_SITE_DIR_NAME
    reader_template = inject(read_template("certificate_reader.js"), PLACEHOLDER_GSTIN_INPUT, embed_gstin_input())
    reader = embed_module(reader_template, "export const CERTIFICATE_READER_API =", "CERTIFICATE_READER_API")
    write_browser_script(demo_dir / "gstin_input.js", "GstinInput", embed_gstin_input(), "gstin_input.js")
    write_browser_script(demo_dir / "certificate_reader.js", "CertificateReader", reader, "certificate_reader.js")
    onboarding = (functions_dir / "onboard_from_gstin.js").read_text(encoding="utf-8")
    if onboarding.count(PRICE_BUNDLE_EXPORT_LINE) != 1:
        raise ValueError("onboard_from_gstin.js entry point not found")
    body = onboarding.replace(PRICE_BUNDLE_EXPORT_LINE, PRICE_BUNDLE_EMBEDDED_LINE, 1)
    write_browser_script(
        demo_dir / "onboard_from_gstin.js",
        "SaathiOnboard",
        "(function embeddedOnboarding() {\n" + body + "\n  return main;\n})()",
        "onboard_from_gstin.js (via 3_function_tools)",
    )


def write_sample_certificates(gstin_registry: pd.DataFrame, kit_dir: pathlib.Path) -> None:
    """Draws SAMPLE GST certificates (REG-06-style text, no emblems) for the OCR demo and tests.

    Every image says SAMPLE in a watermark, the title and the footer; the businesses and GSTINs are the case's
    synthetic registry records (the 4th PAN character is always X, so they can't match a real taxpayer).
    """
    from PIL import Image, ImageDraw, ImageFont

    output_dir = kit_dir / DEMO_SITE_DIR_NAME / "sample_certificates"
    output_dir.mkdir(parents=True, exist_ok=True)
    fonts = {role: ImageFont.load_default(size=size) for role, size in CERTIFICATE_FONT_SIZES.items()}
    records = gstin_registry.set_index("gstin")
    samples = []
    for gstin, file_stem in SAMPLE_CERTIFICATE_GSTINS.items():
        record = records.loc[gstin]
        image = Image.new("RGB", CERTIFICATE_SIZE, "white")
        watermark = Image.new("L", CERTIFICATE_SIZE, 0)
        ImageDraw.Draw(watermark).text((260, 380), "SAMPLE", fill=255, font=fonts["watermark"])
        watermark = watermark.rotate(18, center=(CERTIFICATE_SIZE[0] // 2, CERTIFICATE_SIZE[1] // 2))
        image.paste(Image.new("RGB", CERTIFICATE_SIZE, (238, 238, 238)), mask=watermark)
        draw = ImageDraw.Draw(image)
        draw.rectangle([20, 20, CERTIFICATE_SIZE[0] - 20, CERTIFICATE_SIZE[1] - 20], outline=(60, 60, 60), width=3)
        left = CERTIFICATE_MARGIN
        draw.text((left, 60), "GST REGISTRATION CERTIFICATE (SAMPLE)", fill="black", font=fonts["title"])
        draw.text(
            (left, 120),
            "Sample data for testing the Saathi prototype. Fictional business. Not a government document.",
            fill=(90, 90, 90),
            font=fonts["subtitle"],
        )
        lines = [
            f"Registration Number: {gstin}",
            f"1. Legal Name: {record.legal_name}",
            f"2. Trade Name, if any: {record.trade_name}",
            f"3. Constitution of Business: {record.constitution}",
            "4. Address of Principal Place of Business:",
            f"    {record.principal_place_of_business}",
            f"5. Date of Liability: {record.registration_date}",
            "6. Type of Registration: Regular",
        ]
        for index, line in enumerate(lines):
            draw.text((left, 200 + index * CERTIFICATE_LINE_HEIGHT), line, fill="black", font=fonts["field"])
        draw.text(
            (left, CERTIFICATE_SIZE[1] - 90),
            "SAMPLE DATA · Airtel SYNC 2026 prototype (Accel Saathi) · synthetic registry record",
            fill=(90, 90, 90),
            font=fonts["footer"],
        )
        file_name = f"sample_gst_certificate_{file_stem}.png"
        # Greyscale + optimise: a third of the size, and OCR doesn't need colour.
        image.convert("L").save(output_dir / file_name, optimize=True)
        samples.append(
            {
                "id": file_stem,
                "gstin": gstin,
                "label": f"{record.trade_name} · {record.status} (SAMPLE)",
                "file": f"sample_certificates/{file_name}",
                "dataUrl": "data:image/png;base64,"
                + base64.b64encode((output_dir / file_name).read_bytes()).decode("ascii"),
            }
        )
    # The page reads the samples from this script: browsers block fetch() of local files when it is opened as file://.
    (kit_dir / DEMO_SITE_DIR_NAME / "sample_certificates.js").write_text(
        "/* GENERATED by _build/gen_kit.py: SAMPLE GST certificates (fictional businesses, synthetic registry). */\n"
        + "window.SAMPLE_CERTIFICATES = "
        + json.dumps(samples, indent=1)
        + ";\n",
        encoding="utf-8",
    )
    print(
        f"sample certificates: {len(SAMPLE_CERTIFICATE_GSTINS)} images in {output_dir.name}/ and sample_certificates.js"
    )


def main(case_data_dir: pathlib.Path, kit_dir: pathlib.Path) -> None:
    """Builds every generated file of the kit from the case data."""
    functions_dir = kit_dir / "3_function_tools"
    knowledge_base_dir = kit_dir / "4_knowledge_base"
    for directory in (functions_dir, knowledge_base_dir):
        directory.mkdir(parents=True, exist_ok=True)

    catalogue = pd.read_csv(case_data_dir / "product_catalogue.csv")
    leads = pd.read_csv(case_data_dir / "smb_leads.csv")
    gstin_registry = pd.read_csv(case_data_dir / "mock_gstin_registry.csv")
    udyam_registry = pd.read_csv(case_data_dir / "mock_udyam_registry.csv")

    price_bundle_script = write_price_bundle(catalogue, leads, functions_dir)
    write_gstin_verifiers(gstin_registry, functions_dir)
    write_udyam_verifier(udyam_registry, functions_dir)
    write_lead_scorer(leads, functions_dir)
    write_promise(price_bundle_script, functions_dir)
    write_knowledge_base_sizing_rules(kit_dir)
    write_knowledge_base_promise_rules(kit_dir)
    write_onboarding(gstin_registry, udyam_registry, leads, price_bundle_script, functions_dir)
    write_bill_swap(catalogue, price_bundle_script, functions_dir)
    write_readiness_score(catalogue, functions_dir)
    write_reach(leads, gstin_registry, functions_dir, kit_dir)
    write_consent(functions_dir, kit_dir)
    write_demo_site_scripts(functions_dir, kit_dir)
    write_sample_certificates(gstin_registry, kit_dir)
    write_knowledge_base_catalogue(catalogue, knowledge_base_dir)

    write_back_office_sample(case_data_dir, kit_dir)

    for script in sorted(functions_dir.glob("*.js")):
        print(f"{script.name:<24} {script.stat().st_size / 1024:>5.0f} KB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit('usage: python _build/gen_kit.py "<case data folder>" "<kit folder>"')
    main(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
