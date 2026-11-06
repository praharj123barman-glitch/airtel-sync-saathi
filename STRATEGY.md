# Strategy: Airtel SYNC 2026, Enterprise Track A

**Case:** "Project Udyam Digital: making small businesses go digital in one sitting". The operator,
Accel Telecom / Accel Business, is fictional, and all data is synthetic.

**Problem statement:** design and build a digital-first acquisition and onboarding journey that lets a small
business owner discover the right bundle, buy it and get it activated with minimal human effort, on a phone, in
their preferred language.

Status on 2026-11-07: **all three directions are built** as a tested prototype. **§10 is the final summary of
every feature: which direction it serves, and what is real versus simulated.** Added on 2026-11-07: the
activation guarantee is scoped at quote time (§11) and owners without a GSTIN can start with their Udyam number
(§12).
- CORE: zero-question onboarding from a GSTIN (§6), the bill-swap calculator (§7), consent per purpose and the
  Smart KYC document-reading fallback (§9)
- REACH: referral codes, territory credit, hot-lead handoff and the back-office view (§8)
- PROMISE: the digital-readiness score (§7), the 72-hour guarantee with proactive messages and chase tracking, and
  the downtime auto-credit (§9)

Not yet done: assembling and testing the bot in Voiceflow (the 50 conversation tests), and the case deliverables
beyond the deck (§4). The submitted 7-slide deck is frozen and must not be changed.

---

## 1. The strategy

The three directions rank in this order: **CORE** is the product, **REACH** is how owners arrive, and **PROMISE**
is why they trust it.

### 1. CORE: "Your GSTIN is your application"
Onboarding starts from the GSTIN alone. Segment, bundle and KYC are inferred from registry data, and businesses
with clean filings get pre-approved offers.

What the data says (§4 has the detail):
- **The GST registry has no nature-of-business, HSN/SAC, turnover or filing fields.** The business *type* can still
  be read from the trade name: names follow conventions such as "Medicals", "Classes", "Diagnostics" and
  "Associates". The first measurement (64%) used the pricing function's keyword list, which wasn't built for
  names. A naming vocabulary does much better (§6). What a name can't tell is single shop vs chain: that needs the
  Udyam business type, the constitution, or one question.
- **The Udyam registry fills the gap.** Its `nic_description` gives the segment correctly for 100% of linked
  leads. The two registries can be linked by name and state for 93% of true pairs, without asking the owner.
- **Recommended form:** "Your GSTIN **or Udyam number** is your application", plus **one question** ("how many
  locations do you have?"). This covers 83% of leads (GSTIN 71%, Udyam 54%, at least one of them 83%). The
  remaining 17% have neither and use the existing question-based advisor.
- **"Clean filings" can't be measured with the case data.** There is no filing or return history. A
  pre-approval rule needs a SIMULATED filing-status source, or a proxy such as Active status plus registration
  age plus constitution.
- **Privacy:** 69% of GST legal names embed the proprietor's personal name, for example "Sneha Rao (Prop. Saffron
  Bakers)". Under the DPDP Act, a registry lookup returns personal data, so consent must come **before** the lookup.
  The current kit asks for the GSTIN only after a quote is accepted (global prompt, hard rule 2), so CORE
  reverses that order: consent first, then GSTIN, then quote.
- ✅ **Built:** GSTIN-first onboarding (§6); consent asked separately per purpose and recorded, and a document-reading
  fallback when the lookup fails (§9); Udyam entry for owners without a GSTIN (§12: 42.6% of them now get a
  zero-question proposal).

### 2. REACH: "One million salespeople"
Three channels: CA referrals, customer micro-agents earning bill credits, and territory credit for field reps on
digital sales.

What the data says:
| Lead source | Leads | Activation | Cost per activation |
|---|---|---|---|
| **Referral** | 413 | **14.8%** | **₹4,099** |
| Inbound call | 504 | 9.5% | ₹5,113 |
| Channel partner | 1,010 | 8.0% | ₹20,851 |
| Field sales | 1,720 | 7.3% | ₹24,335 |
| Website form | 995 | 4.3% | ₹6,352 |
| WhatsApp campaign | 358 | 2.8% | ₹4,026 |

- Referrals are the best channel on both conversion (2× the average) and cost (one-sixth of field sales). This
  supports REACH.
- **Caveat: referred customers churned the most (24.6% within 6 months, against 15.2% overall).** Pay
  micro-agent credits after the customer stays (for example at month 3 or month 6), not at sign-up.
- There's no CA-specific data. "Referral" doesn't say who referred, so the CA channel is a hypothesis to test in
  the pilot.
- ✅ **Built (§8).** Referral codes, territory credit, rep callbacks for Hot leads, and rewards earned on activation
  and held 90 days because of the churn caveat above.

### 3. PROMISE: "Outcomes, not products"
A 72-hour activation guarantee or month one free, automatic credit for downtime, and a digital-readiness score.

What the data says:
- **As sold today, only 1.9% of activated bundles could go live in 72 hours.** For 66% of bundles the slowest
  item takes 5 days (mostly fibre). Leased lines take 21–30 days, SD-WAN 14, managed firewall and machine IoT 10.
- **Bridging fibre with 5G AirFiber (2 days) raises this to 45%.** The rest are held back by slower add-ons
  (cloud telephony 5 days, CCTV 4, SMS 4) or by enterprise products.
- **Superseded on 2026-11-07 (§11):** both figures above use catalogue install days and assume AirFiber everywhere;
  the observed data says 66% of orders would miss a 72-hour promise. The guarantee is now scoped at quote time
  (23.5% of orders get 72 hours, the rest a firm number of days): credits fall from ₹93 lakh to ₹52 lakh per 1,000
  orders.
- **So define the promise as "connected in 72 hours"**: the internet connection plus business SIMs, with
  AirFiber as the bridge. "Every product live in 72 hours" isn't achievable. 5G coverage data is not in the
  case pack, so the bridge itself is an assumption.
- The baseline is 17.6 days from lead to activation, with 4.8 days from completed KYC to activation.
- A missed promise costs one month free: ₹6,900 at the median bundle and ₹2,470 at the median micro bundle.
- **Downtime auto-credit:** there is no uptime or outage data in the pack, so it can only be SIMULATED.
- ✅ **72-hour guarantee and downtime credit built (§9):** deadline, breach → month one credited (the monthly bill
  from `price_bundle`), a proactive message at every stage, chases counted (2nd → retention), and an outage credit
  by a documented rule. Orders and outages are SIMULATED.
- **Digital-readiness score:** ✅ built (§7). It scores what the business already uses, with weights per segment
  taken from the case's Appendix A2 "key needs". The case data has no "products already used" field, so the
  weights are defensible design choices, not fitted to outcomes.

---

## 2. Where everything lives

| What | Path | Notes |
|---|---|---|
| **Case PDF** and submission template | `Downloads\6ae1873397bc1_digital\6ad9d4887d445_airtel_sync\` | `Airtel_SYNC_Case.pdf`, `Submission Template_Sync.pptx` |
| **Case data pack** | `Downloads\6ae1873397bc1_digital\YTL_TrackA_Udyam_Digital_Data\` | Outside this folder; synthetic |
| ↳ leads | `smb_leads.csv` | 5,000 leads, Apr–Jun 2026, 40 columns |
| ↳ product catalogue | `product_catalogue.csv` | 25 products with eligibility rules |
| ↳ GST registry | `mock_gstin_registry.csv` | 3,534 records (§3) |
| ↳ Udyam registry | `mock_udyam_registry.csv` | 2,723 records (§3) |
| ↳ KYC images | `kyc_documents\` | 47 PNGs for applicants K01–K12; some have planted problems. **Still unused**: the certificate reader (§9) was built and tested on 3 generated SAMPLE GST certificates instead |
| ↳ data README | `README.md` | Column guide; "today" = 2026-07-15 |
| **Submitted deck (do not touch)** | `AirtelSync_Submission\TeamName_CampusName.pptx` and `.pdf` | 7 slides; placeholders for team/campus still open |
| Deck build and analysis scripts | `AirtelSync_Submission\source\` | `analyze.py` (funnel), `reg.py` (registry checks), `model.py` (lead-score experiments), `build_deck.py`, `export.ps1`, `mock\` (phone screens), `tpl\`, `fonts\` |
| **Chatbot kit** | `AirtelSync_Submission\saathi_chatbot_voiceflow\` | Read its `README.md`, `CODING_STANDARDS.md` and `CODE_REVIEW.md` first |
| ↳ agent prompt | `1_agent_global_prompt.txt` | Identity, language, hard rules, routing |
| ↳ playbooks | `2_playbooks\0_…` and `A_…` to `D_…` | GSTIN-first onboarding (the start), advisor, business verification, callback & lead capture, order tracker |
| ↳ **code functions: source** | `_build\*.js` | 11 function templates (`price_bundle`, `verify_gstin`, `verify_udyam`, `register_lead`, `order_status`, `onboard_from_gstin`, `bill_swap`, `readiness_score`, `reach_tag_lead`, `downtime_credit`, `consent_manager`) and 4 shared rule files embedded by the build (`reach_rules`, `promise_rules`, `consent_rules`, `certificate_reader`) |
| ↳ code functions: generated | `3_function_tools\*.js` | Built by `_build\gen_kit.py`; never hand-edited. Includes `verify_gstin_lite.js` |
| ↳ **lead-score model** | trained in `_build\gen_kit.py`, runs in `3_function_tools\register_lead.js` | Logistic regression, CV AUC 0.71, top 20% of leads hold 40% of activations |
| ↳ knowledge base | `4_knowledge_base\` | Catalogue CSV, bundle rules, FAQ, privacy notice |
| ↳ lead sheet | `5_google_sheet\back_office_leads_template.csv` | Header row of the back-office sheet |
| ↳ **tests** | `6_tests\run_function_tests.mjs` (200 automated), `6_tests\browser_kyc_check.py` (40 browser checks with real OCR), `6_tests\browser_back_office_check.py` (12), `6_tests\test_conversations.md` (39 manual) | `npm test` |
| ↳ **demo page** | `7_demo_site\index.html` | Hosts the Voiceflow widget once its snippet is pasted in, and the Smart KYC fallback (consent screen + GST certificate reader; works without Voiceflow) |
| ↳ SAMPLE certificates | `7_demo_site\sample_certificates\*.png` | 3 generated GST certificates of synthetic registry records, marked SAMPLE (active company, active proprietorship, cancelled) |
| ↳ **back office** | `8_back_office\index.html` | Unclosed leads, rep callbacks, rewards (REACH) |
| Not part of this entry | `Downloads\MajorProject\` | Unrelated university project |

---

## 3. Registry fields available

### Mock GST registry: `mock_gstin_registry.csv` (3,534 rows)

| Field | Example | Infers | Evidence from the case data |
|---|---|---|---|
| `gstin` | 07PUTXM1153M1Z9 | **Location** (state code, first 2 digits) and validity (checksum) | State code matches `state` in 100% of rows. The embedded PAN's 4th character is always "X" in the mock, so entity type can't be read from it |
| `legal_name` | Sneha Rao (Prop. Saffron Bakers) | Owner name for proprietorships | 69% embed a personal name, so this is **personal data under DPDP** |
| `trade_name` | Saffron Bakers | **Segment, weakly** (keywords) | 64% segment accuracy using the kit's keyword rules; chains 0% |
| `constitution` | Proprietorship / Private Limited Company / LLP | **Size** | Median employees: proprietorship 5, LLP 23, Pvt Ltd 24. No micro shops among companies or LLPs; 59% of proprietorships are micro |
| `principal_place_of_business` | Shop/Unit 83, Market Yard, Ludhiana, Punjab - 416059 | **Location**: city, state and PIN (so city tier) | Parses in 100% of rows; city matches the lead 100%. PINs are synthetic |
| `state` | Punjab | **Location** | 14 states |
| `registration_date` | 2019-04-15 | Business age | 2016-05 to 2025-11. GSTINs under 1 year old activated more (14.6%) than 5+ years (9.0%), so age is not a conversion-risk signal |
| `status` | Active / Cancelled / Suspended | **Eligibility / risk** | 3,266 / 167 / 101. Blocks the 268 non-active GSTINs; 22 such businesses were activated in the case data |

**Not in the GST registry:** nature of business, HSN/SAC codes, turnover, filing or return history, additional
places of business (so no site count), contact details.

### Mock Udyam registry: `mock_udyam_registry.csv` (2,723 rows)

| Field | Example | Infers | Evidence |
|---|---|---|---|
| `udyam_number` | UDYAM-DL-00-7084760 | Location (state letters) | District code is always 00 (synthetic) |
| `enterprise_name` | Metro Diagnostics Pvt Ltd | Link to the GST record | Name + state finds the right GSTIN for 93% of true pairs; 281 GSTINs have more than one candidate |
| `enterprise_type` | Micro / Small / Medium | **Size, weakly** | Median employees: Micro 9, Small 15, Medium 13. No clear link to turnover band in this data |
| `major_activity` | Trading / Services / Manufacturing | **Segment, coarse** | Separates manufacturers; doesn't separate shops from chains |
| `nic_description` | Diagnostic lab | **Segment, exactly** | 35 values, identical to the leads' business types, so **100% segment accuracy**. Caveat: real NIC entries are 5-digit codes with official text, so real-world accuracy will be lower |
| `state`, `city` | Delhi, Delhi | **Location**: city, so city tier | City matches the lead 100% |
| `date_of_registration` | 2023-12-25 | Business age | |

### What each registry can infer (measured against the 5,000 leads)

| Needed for onboarding | GSTIN only | GSTIN + Udyam | Still ask the owner |
|---|---|---|---|
| Segment | 64% right (chains never) | 100% right (synthetic) | "How many locations?" separates shops from chains |
| Size | Constitution gives a rough band | + enterprise type (weak) | Number of staff (sets lines and email seats) |
| Location and city tier | Yes (address, state code) | Yes | Installation address, if it differs |
| Number of sites | No | No | Yes, always |
| KYC status | Active / Cancelled / Suspended, name | + Udyam verified | Signatory ID, address proof if needed |
| Filing record ("clean filings") | **No** | **No** | Not available: needs a SIMULATED source |

**Coverage of the 5,000 leads:** GSTIN 3,534 (71%) · Udyam 2,723 (54%) · both 2,087 (42%) · GSTIN only 1,447 (29%) ·
Udyam only 636 (13%) · neither 830 (17%).

---

## 4. Gap list against the case's build challenge

Status: ✅ exists · 🟡 partial · ❌ missing. "Kit" means `saathi_chatbot_voiceflow\`.

| Case requirement | Today | Gap | Strategy link |
|---|---|---|---|
| **AI advisor**: asks about type, size, locations and tools; recommends from the catalogue and explains | 🟡 **GSTIN-first onboarding** (`onboard_from_gstin` + playbook 0): proposal with zero questions for 73% of registry GSTINs, at most one question otherwise. Playbook A + `price_bundle` as fallback | Not yet assembled or tested in Voiceflow. Udyam entry built (§12). The quote card is EN/HI; the greeting is EN/HI/KN | CORE ✅ step 1 |
| **Transparent monthly price with add-on toggles** | 🟡 `price_bundle`: one monthly price, add/remove/budget by chat, buttons | No real toggle UI. **L3:** defaults used silently. No checkout or payment (Bug L2, adding by product ID, fixed 2026-11-07) | PROMISE ✅ the quote card shows its activation guarantee (§11) |
| **Smart KYC: document reading** | 🟡 GST certificate reader on the demo page (§9): Tesseract.js in the browser, fields extracted, look-alike characters corrected only when the checksum confirms, then the same validation as onboarding (verified / review / blocked) | Not inside the Voiceflow chat; GST certificates only; tested on 3 generated SAMPLE images, not real photos. The 47 KYC images and their planted problems are still unused; the 90-day address-proof rule is only in text | CORE |
| **Smart KYC: GSTIN / Udyam lookup** | ✅ `onboard_from_gstin` checks the GSTIN *first* (format, checksum, registry, status) and infers category, scale and location; `verify_gstin` / `verify_udyam` remain for the verification step | Udyam link is SIMULATED by name + state (production: by PAN) | CORE |
| **Smart KYC: consent screen** | ✅ `consent_manager` (§9): three purposes asked separately (registry lookup, KYC verification, marketing), EN/HI/KN, nothing pre-selected, each withdrawable, recorded with time, version and history; the same screen on the demo page | Hindi/Kannada need native review (C1); a withdrawal isn't written back to an existing sheet row (C2); the page's record lives in the browser tab (C3) | CORE ✅ |
| **Order tracker** | 🟡 `order_status` (§9): 72-hour countdown, breach → month one credited, a proactive message per stage, chase count with retention flag on the 2nd chase, labelled "Demo order". `downtime_credit` for outages | 4 SIMULATED demo orders, not linked to registered leads; messages shown, not sent; outages typed in (P1–P3) | PROMISE ✅ |
| **Back-office view of unclosed leads** | ✅ `8_back_office/index.html`: reads the sheet (or the SIMULATED sample), filters by score band, segment, territory, drop-off stage and referrer type, and shows the rep-callback summary and the rewards earned on activation. The sheet has 13 new columns (`5_google_sheet/COLUMNS.md`) | Sheet integration not yet tested in Voiceflow; no payout ledger (RE5) | REACH ✅ |
| **Lead scoring** | ✅ `register_lead` (AUC 0.71, Hot/Warm/Cold), now driving the rep-callback handoff (Hot = top 20%) | Uses no registry signals (constitution, GST status); percentiles are extreme (L10) | CORE: use registry fields; REACH ✅ handoff |
| Stretch: voice / WhatsApp front end | ❌ | Not configured | CORE/REACH |
| Case deliverables beyond the deck: 3-min demo video, architecture diagram, 1-page privacy note | ❌ | Not produced | All |

**Gaps that come from the strategy itself** (not from the case list):
- **CORE:**
  - ✅ a function that turns a GSTIN (and Udyam, if found) into segment, size band, location and eligibility (§6)
  - 🟡 a pre-approval rule: built as "Active + registered 6+ months"; still no filing source, SIMULATED or real
  - ✅ consent-first wording in the global prompt and playbooks
  - ✅ consent log: `consent_manager` records each purpose with time, version and history; 5 consent columns in the
    sheet (§9)
  - ✅ document-reading fallback when the lookup fails (§9)
  - ✅ Udyam entry for owners without a GSTIN (§12)
  - ❌ `pre_approved` and `business_category` columns in the back-office sheet
- **REACH:** ✅ built in §8
  - referral codes for CA partners, customers and field reps
  - attribution in the lead sheet
  - rewards earned on activation and held 90 days
  - territory credit for digital sales
  - Still to do: a real partner and territory directory (RE1), a pincode → district table (RE2), piloting the
    rates (RE3) and a payout ledger (RE5)
- **PROMISE:**
  - ✅ activation-promise logic: "connected in 72 hours", AirFiber bridge stage, free-month trigger in the tracker (§9)
  - ✅ SIMULATED downtime-credit rule (§9)
  - ✅ digital-readiness score (§7); still to do: validate the weights against pilot outcomes
  - Still to do: send the stage messages for real (P2), feed orders and outages from real systems (P1), pilot the
    credit amounts (P4). ✅ The quote card shows the scoped guarantee (§11)

Known code issues and limits are listed in `saathi_chatbot_voiceflow\CODE_REVIEW.md` (L1 and N4 are now fixed; new
limits P1–P5, C1–C3, K1–K3).

---

## 5. Current test status (2026-11-04)

- `npm test` in the kit: **200 passed, 0 failed** (31 original + 21 onboarding + 14 bill swap + 14 readiness +
  25 REACH + 55 PROMISE, consent and Smart KYC + 19 reading a GSTIN from the owner's message + 11 first quote
  never overshoots + 10 knowledge base generated from pricing and verify_gstin consent)
- The knowledge base's sizing rules and worked examples are now generated from `price_bundle` at build time, and
  a test fails if they differ; `verify_gstin` enforces registry-lookup consent in code (`CODE_REVIEW.md`, last
  section)
- After the outside review: a GSTIN inside a sentence ("my gstin is …", "GSTIN: …") is now read by one shared
  reader in every tool and the demo page, two GSTINs are reported, and no status code reaches the owner
  (`saathi_chatbot_voiceflow\CODE_REVIEW.md`, last section)
- Regression: `price_bundle`, `verify_gstin`, `verify_gstin_lite`, `verify_udyam` and `register_lead` compared before
  and after on 20,520 inputs: **0 differences**. `order_status` was rewritten on purpose for the 72-hour promise;
  its two original tests still pass. Onboarding's calibration (73.1% zero-question, 98.3% segment accuracy) is
  unchanged.
- Browser: `6_tests\browser_back_office_check.py`, **12 of 12** (WCAG contrast in light and dark mode, 375 px
  layout, filters, no console errors). `6_tests\browser_kyc_check.py`, **40 of 40 checks pass** in Chromium with real Tesseract.js OCR on the 3
  SAMPLE certificates. All three GSTINs were read correctly, and one OCR misread (0 for O) was corrected and shown.
  It also checks consent gating, the verdicts, Hindi and Kannada, withdrawal, the 375 px layout and that there are
  no console errors.
- ESLint: clean · Prettier: clean · Ruff: clean
- The 39 conversation tests in `6_tests\test_conversations.md` need the bot assembled in Voiceflow, so they haven't
  been run yet.
- The back-office page was checked in a browser at 1280 px and 375 px: filters work, no console errors, no
  horizontal scroll.

---

## 6. What changed: zero-question onboarding (2026-11-04)

**What was built:** `onboard_from_gstin`, a new function tool in the kit. Its input is a GSTIN. Its outputs:

| Output | How |
|---|---|
| Validity and status | Format, state code, checksum, registry lookup. **Cancelled/Suspended → `human_review`: no quote, never activated** |
| Business name, location, registration age | Trade name (not the legal name, which may contain a personal name), city parsed from the address, state, city tier, years since registration |
| Category and confidence | `kirana_retail`, `clinic`, `ca_firm`, `coaching_centre`, `restaurant`, `small_factory`, `other`, plus `segment_confidence` and `evidence_fields` (the registry fields used) |
| Bundle and monthly price | **Only from `price_bundle`**: the build embeds the generated `price_bundle.js` unchanged, and a test re-prices `pricing_inputs_json` to prove the numbers match |
| Pre-approved flag | Active and registered 6+ months, with a one-line reason. Filing history is not in the case data |
| Greeting | English, Hindi and Kannada: who we found, the proposal, pre-approval, the stated assumptions (team size, locations) |
| Low confidence | **One** clarifying question (business type, or number of locations) instead of a guess |

**How it infers:**
- **Category:** the Udyam business type first, linked to the GSTIN by name + state (SIMULATED; production links by
  PAN). Then trade-name words.
- **Scale (single shop or chain):** the Udyam type, or the constitution. 87.8% of proprietor retailers were single
  shops, and every company or LLP retailer was a chain.
- **Price:** chains always get the locations question, because the price scales with sites.
- **Confidence:** below 0.7 triggers a question.

**Measured on all 3,534 registry GSTINs** (synthetic data, as of the case's "today" 2026-07-15; each lead's true
type and size used to check, and to simulate the owner's answer):

| Outcome | Share | Accuracy |
|---|---|---|
| Proposal with zero questions | **73.1%** (2,584) | Segment right **98.3%**, category right 100% |
| One question, then proposal | 19.3% (682): 647 locations, 35 business type | Segment right 100%; nobody needed a second question |
| Blocked for human review | 7.6% (268 cancelled/suspended) | All blocked, none quoted |

**Re-measured 2026-11-04, after the first-quote sizing change** (outside review: 77% of first quotes were above
the price at the business's true size). The first quote is now the base bundle for the SMALLEST sensible business
in the segment (smallest team in the case data: shops and services 1, offices 3, chains 15, factories 12; the
lowest number of a locations answer), extras (POS, failover, CCTV, machine sensors) are switched-off add-ons with
their price, and the greeting states every assumption. Computed with `6_tests/measure_onboarding.mjs`: every
registry GSTIN through the generated `onboard_from_gstin`, compared with the lead's true team size and sites in
smb_leads.csv (joined by GSTIN), re-priced by `price_bundle` with no extras.

| Measure (3,534 GSTINs) | Before | After |
|---|---|---|
| **Proposal with zero questions** | 73.1% (2,584) | **73.1% (2,584)**, unchanged: it depends only on confidence, and the 0.7 threshold was not touched |
| Segment / category right on those | 98.3% / 100% | 98.3% / 100% |
| First quotes above the true-size price | 1,995 of 2,584 (77.2%) | **0** |
| Quotes after one answer above it | 516 of 682 (75.7%) | **0** |
| Extras in a first total | in every shop, office, chain and factory quote | **0** |
| Average first quote (true-size average ₹4,333) | ₹4,886 | ₹3,053 |

The trade-off is deliberate: most first quotes are now below the true-size price, and the greeting says what was
assumed ("I've assumed a shop, a team of 1–2…") so the owner's real size re-quotes upwards.

The 45 wrong zero-question proposals are proprietor-owned chains with no Udyam link, read as single shops (the 12%
chain rate among proprietors). **Caveat:** synthetic trade names are far more regular than real ones. Clear name
words are capped at 0.85 confidence for this reason, but expect more questions on real data.

**Conversation changes:**
- The global prompt now opens by asking for the GSTIN, with a one-line consent notice. Hard rule 2 now reads:
  consent before any lookup, and no personal ID before a quote.
- New playbook `0_gstin_first_onboarding.txt` greets with the proposal before asking anything else.
- Playbook A is now the fallback (no GSTIN, not found, "Other", or changes).
- Playbook B skips re-verifying a GSTIN that onboarding already checked.

**Files changed (kit):**
- New: `_build/onboard_from_gstin.js` (generated into `3_function_tools/`) and
  `2_playbooks/0_gstin_first_onboarding.txt`
- Changed:
  - `_build/gen_kit.py`: new build step that embeds `price_bundle`, plus the GST↔Udyam link
  - `1_agent_global_prompt.txt`
  - `2_playbooks/A_…` and `B_…`
  - `6_tests/run_function_tests.mjs` (+21 tests) and `6_tests/test_conversations.md` (+6)
  - `3_function_tools/TOOL_SETUP.md`, `START_HERE.md`, `README.md`
  - `CODE_REVIEW.md` (limits N1–N6: Kannada review, calibration on synthetic data, simulated Udyam link,
    implied consent, file size ≈ 295 KB, copied helpers)
- Not touched: the deck, and the six existing functions (0 behaviour differences).

---

## 7. What changed: bill-swap calculator and digital-readiness score (2026-11-04)

### `bill_swap`: "will switching save me money?"
- **Input:** the owner's current monthly bills typed in chat ("category | vendor | amount", one per line, or JSON),
  plus the business context from onboarding (`pricing_inputs_json`) or from the advisor.
- **Output:**
  - the current total
  - the **matching** Accel bundle price, from `price_bundle` (embedded unchanged by the build; a test re-prices
    its inputs and gets the same total)
  - monthly, yearly and first-year saving (after the one-time setup fee)
  - a short message in EN/HI/KN
- **Honest by construction:**
  - **Like for like.** It prices only what the owner pays for today; anything extra the bundle includes is shown
    as extra value, never counted as a saving.
  - **When Accel costs more**, the message says so first ("To be honest: … ₹600 more") and then lists what the extra
    buys (catalogue descriptions, one bill and one support number).
  - **Out of the totals:** bills Accel doesn't sell (electricity, rent) or can't sell to this business (WhatsApp API
    without GSTIN) are listed separately.
  - **Never guessed:** unreadable or implausible amounts (over ₹1,00,000 a month; the biggest activated bundle in
    the case data was ₹72,950) are listed for confirmation.
- **Wired in:** a "Compare with my bills" button right after the bundle proposal, in playbooks 0 and A.

### `readiness_score`: digital-readiness score 0–100
- **Input:** what the business already uses ("home broadband, 2 Jio SIMs, UPI QR"), segment, staff count if known,
  GSTIN status if known.
- **Output:**
  - the score
  - the top 3 gaps
  - the Accel add-ons that close them, with the **new score after each** (cumulative, e.g. 19 → 39 → 54 → 65)
  - `suggested_needs`, so the add-ons can be priced by `price_bundle`
- **Rules in one object:** all scoring rules live in `READINESS_RULES`: capabilities, credits for partial
  solutions (home broadband 50%, personal SIM 50%, free WhatsApp app 50%), and weights per segment from the case's
  Appendix A2. A test checks that every segment's weights add up to 100.
- **Eligibility comes from the catalogue.** Unknown facts (GSTIN, staff) are stated as conditions, not assumed.
  Gaps no product can close for this business are shown with the reason ("needs an active GSTIN").
- **Wired in:** at the start of discovery in the advisor (playbook A, step 1, before the needs question, whose buttons
  it pre-fills), and as "Check my digital score" after the GSTIN lookup in playbook 0.

### Problems found while building, and fixed
- **Wrong add-on swap in the readiness draft.** For a factory with unknown GSTIN and staff, the draft suggested a
  Fleet Tracker to close "machine monitoring" and gave it full credit. It now keeps the intended product and states
  the unknown facts as conditions. Each add-on earns its real credit (AirFiber 80%; business fibre 60% for a factory).
- **Bug path avoided.** Passing add-ons to the pricing function by product name would have hit the known
  `price_bundle` parser bug (L2): "Business Postpaid 299" would be read as 299 lines. The readiness score passes
  need keywords (`suggested_needs`) instead.

### Files changed (kit)
- New: `_build/bill_swap.js`, `_build/readiness_score.js` (both generated into `3_function_tools/`)
- Changed:
  - `_build/gen_kit.py`: builds both; embeds `price_bundle` in `bill_swap`
  - `2_playbooks/0_gstin_first_onboarding.txt` and `A_bundle_advisor.txt`
  - `1_agent_global_prompt.txt` (routing line)
  - `6_tests/run_function_tests.mjs` (+28 tests) and `test_conversations.md` (+4)
  - `TOOL_SETUP.md` (sections 7–8), `START_HERE.md`, `README.md`
  - `CODE_REVIEW.md` (limits B1–B3, R1–R2)
- Not touched: the deck; the six original functions and onboarding (0 behaviour differences).

---

## 8. What changed: the REACH layer (2026-11-04)

**One set of rules.** `_build/reach_rules.js` holds every REACH rule. The build embeds it unchanged in the chatbot
(`reach_tag_lead`) and in the back-office page (`8_back_office/reach_rules.js`), and a test checks the two copies
are identical. All rates are in one object, `REACH_RATES`.

### 1. Referral codes
- **Who gets a code:** CA partners, existing customers (micro-agents) and field reps.
- **Format:** `CA-7K2P9-X` / `CU-…` / `FR-…`, using no look-alike characters, plus a check character that catches
  typos. Codes are derived from the referrer ID, so they never need storing. All 434 demo codes are unique (tested).
- **Getting into the lead:** a referral link (`…/index.html?ref=CODE`) passes the code into Voiceflow's launch
  payload. The lead row stores `referral_code`, `referrer_type` and `referrer_id`. A mistyped code is caught and asked
  about once. A well-formed but unknown code is saved, but credits nobody.
- **Earned on activation only:** nothing is earned when a lead is created. Rewards are earned when the row reaches
  `Activated`, held 90 days, then payable, and void if the customer leaves. The hold exists because referred
  customers churned the most (24.6%).

| Who | Reward | Rate (of the first monthly bill) | Cap |
|---|---|---|---|
| CA partner | commission | 100% | ₹10,000 |
| Customer (micro-agent) | bill credit | 50% | ₹3,000 |
| Field rep, for a referral Saathi closed | incentive | 25% | ₹5,000 |

Even the highest (₹6,900 at the median bundle) is far below the case's field-sales cost per activation (₹24,335).

### 2. Territory credit
- **Matching a lead to a territory:** every lead maps to the field rep who owns its district. That's the city from
  the GST registry address, then the state, then the GSTIN's state code. A state with no territory goes to the
  central desk.
- **Digital activations** (`closed_by` = `saathi`) earn the territory rep credit even though Saathi closed them
  alone: 1 activation toward target plus 10% of the first bill, capped at ₹2,000.
- **No double pay:** a rep is never paid twice for one activation, and isn't paid a referral incentive for a sale
  they closed in person.
- **Pincodes aren't used:** the mock pincodes are synthetic.

### 3. Hot-lead handoff
- **Who gets flagged:** leads the existing model rates Hot (top 20% of scores) that Saathi didn't close, unless the
  GSTIN is blocked (those go to human review).
- **Who calls back:** the referring rep, else the territory rep.
- **The summary**, one line: business, segment and city · bundle viewed and price · drop-off stage and reason ·
  score · referrer.
- **What the owner hears:** only "an Accel specialist from your area will call". Never the score.
- **In the sample:** 831 of 4,632 unclosed leads are flagged. The other 87 Hot unclosed leads have cancelled or
  suspended GSTINs.

### 4. Back-office view (`8_back_office/index.html`)
- **Stack:** the same as the demo page (one static HTML file, Poppins, the same tokens and dark mode, vanilla
  JavaScript).
- **Data:** it reads the Google Sheet (published CSV link or a CSV file) or the SIMULATED sample of all 5,000 case
  leads. The sample is built with the real `register_lead` and `price_bundle`.
- **Filters:** score band, segment, territory, drop-off stage, referrer type, "rep callbacks only" and search.
- **What each lead shows:** owner, stage and reason, and the handoff summary.
- **Summary and rewards:** tiles for unclosed leads, callbacks, rewards (held, payable, void) and territory
  credits, plus a rewards table.

### Sheet
13 new columns, documented in `5_google_sheet/COLUMNS.md`:
- **Written by Saathi:** `state`, `referral_code`, `referrer_type`, `referrer_id`, `territory_id`,
  `territory_rep_id`, `closed_by`, `drop_off_stage`, `handoff_flag`, `handoff_owner_id`, `handoff_summary`
- **Filled by the back office:** `activated_date`, `churned`

### Problems found while building, and fixed
- **Paying reps for their normal job:** reps would have been paid the referral incentive on their own field sales.
- **Paying the same rep twice:** referral incentive plus territory credit for the same activation.
- **Desktop overflow:** the filter grid overflowed the page at 1280 px.

### Files (kit)
- New:
  - `_build/reach_rules.js`, `_build/reach_tag_lead.js`, `_build/build_back_office_sample.mjs`
  - `8_back_office/index.html` (plus the generated `reach_rules.js` and `sample_leads.js`)
  - `5_google_sheet/COLUMNS.md`
- Changed:
  - `_build/gen_kit.py`
  - playbooks `C_…` and `D_…`, `1_agent_global_prompt.txt`
  - `7_demo_site/index.html` (`?ref=` → launch payload)
  - the sheet header
  - `6_tests/run_function_tests.mjs` (+25) and `test_conversations.md` (+4)
  - `TOOL_SETUP.md` (§9), `START_HERE.md`, `README.md`, `CODE_REVIEW.md` (RE1–RE6)
  - `package.json` / `eslint.config.js` (lint and format now cover the new files)
- Not touched: the deck. The original six functions and onboarding behave exactly as before.

---

## 9. What changed: PROMISE, consent per purpose, Smart KYC fallback (2026-11-04)

**One set of rules each.** `_build/promise_rules.js` (rules in `PROMISE_RULES`) is embedded unchanged in
`order_status` and `downtime_credit`. `_build/consent_rules.js` is embedded in `consent_manager` and in the demo
page. `_build/certificate_reader.js` runs on the demo page and in the tests. Every user-facing text is in English,
Hindi and Kannada; tests check that no consent, reader or promise text is missing in Hindi or Kannada.

### 1. 72-hour guarantee (`order_status`, PROMISE)
- **Stored per order:** when it was confirmed and the deadline (confirmed + 72 h). Real orders pass an absolute
  `confirmedAt`; demo orders are timed relative to now so the demo always looks current.
- **Status:** `on_track` (with hours left) · `met` (connected within 72 h) · `breached` (deadline passed without a
  connection, also when it connects late).
- **Breach → month one credited:** `month_one_credit` = the whole monthly bill, taken from the embedded
  `price_bundle` (₹7,185 for the delayed Office Pro demo order).
- **Saathi messages every stage** (order confirmed, business verified, AirFiber bridge, installer booked,
  connected, fibre installed, live, first bill) plus the breach apology at the deadline with the credit. The tracker
  shows what was sent and the next message. A late connection never says "promise kept".
- **Chases:** when the owner asks on their own (`is_chase` = yes), `chase_count` goes up; **the 2nd chase sets
  `retention_flag`**. Playbook D then apologises and hands over to Callback & lead capture with stage `retention`.
  Why the 2nd: the case data shows churn rising with each chase (5.9% after 1 chase, 27.9% after 5).
- Every tracker message ends with "(Demo order: simulated data.)", which closes CODE_REVIEW L1.

### 2. Downtime auto-credit (`downtime_credit`, PROMISE)
- **Input:** a SIMULATED outage (order ID, duration as the owner says it: "3h 20m", "2 घंटे 15 मिनट", "90 ನಿಮಿಷ").
- **The documented rule** (`PROMISE_RULES.downtime`, also in the FAQ):

| Outage | Credit |
|---|---|
| Under 60 minutes | none (the owner is still told) |
| Each started 4-hour block | one day's bill (monthly bill ÷ 30, rounded to the rupee) |
| Bundle with 4G/5G failover | × 0.5 (the owner stayed online) |
| Cap | 50% of the monthly bill |
| Order not live yet | none (the 72-hour promise covers it) |

- **Message before the complaint:** "We know your internet was down for 3 h 20 min today. Sorry about that. ₹73 has
  been credited to your next bill automatically." Unreadable durations and unknown orders return an error; nothing
  is guessed.

### 3. Smart KYC fallback: reading a GST certificate (CORE)
- **When:** the GSTIN or Udyam lookup fails (typo twice, not found). Playbooks 0 and B offer "Read my GST
  certificate".
- **Where:** the demo page, section "Lookup didn't work?". Tesseract.js v5.1.1 from the jsDelivr CDN, no API key.
  The photo is read in the browser and never uploaded.
- **Extraction:** GSTIN, legal name, trade name, constitution and address, found by their labels. OCR look-alikes
  (O/0, I/1, S/5, B/8) are corrected **by position** and kept only if the official checksum then passes. Each
  correction is listed for the owner, who can edit every field.
- **Same validation as onboarding:** the build wraps the generated `onboard_from_gstin` for the browser, and a test
  checks it returns exactly the same outputs as the Voiceflow function. The verdict compares the read name with the
  registry (a proprietor's legal name counts through the trade name) and the city with the address:
  `verified` · `review` (advisor) · `blocked` (Cancelled/Suspended) · `fix_gstin`.
- **SAMPLE data:** 3 generated certificates of synthetic registry records, each marked SAMPLE in a watermark, the
  title and the footer: Metro Diagnostics (active company), Saffron Bakers (active proprietorship) and Prime General
  Store (cancelled).

### 4. Consent: three purposes, separately (CORE, DPDP Act 2023)
- **One screen, three separate questions:** registry lookup, KYC verification, offers on WhatsApp. Each has its
  own yes/no; nothing is pre-selected; there is no "accept all".
- **Languages:** the owner's language (EN/HI/KN), in the chat (`consent_manager`) and on the demo page (same code).
- **Withdraw:** each purpose can be withdrawn at any time by saying so in the chat, or with a Withdraw button on
  the page. Withdrawing KYC deletes what was read.
- **Recorded:** each answer is stored with its time, the version of the text and the full history. The 5 consent
  columns go to the sheet. Only an explicit yes counts; "maybe" or silence changes nothing.
- **Enforced:** `onboard_from_gstin` gets `consent_given` = yes only when registry lookup is yes. The reader is locked
  until KYC verification is yes. Offers need marketing = yes. This closes CODE_REVIEW N4.

### Problems found while building, and fixed
- A late connection said "Promise kept"; a missed promise showed a green tick.
- Hindi and Kannada minutes were silently dropped by the duration parser (`\b` doesn't work after non-Latin letters).
- The downtime rule text didn't add up, because the daily bill wasn't rounded first.
- The guarantee only worked for demo orders, and tracker stages counted as "Contacted" in the REACH funnel.
- The consent radio buttons rendered above their labels on the page.

### Files (kit)
- New:
  - `_build/promise_rules.js`, `_build/downtime_credit.js`, `_build/consent_rules.js`,
    `_build/consent_manager.js`, `_build/certificate_reader.js`
  - generated: `3_function_tools/downtime_credit.js`, `consent_manager.js`; `7_demo_site/consent_rules.js`,
    `certificate_reader.js`, `onboard_from_gstin.js`, `sample_certificates.js`, `sample_certificates/*.png`
  - `6_tests/browser_kyc_check.py`
- Changed:
  - `_build/order_status.js` (rewritten), `_build/gen_kit.py` (embed and sample steps), `_build/reach_rules.js`
    (tracker stages in the funnel)
  - `7_demo_site/index.html` (Smart KYC section)
  - `1_agent_global_prompt.txt`, playbooks `0_…`, `B_…`, `C_…`, `D_…`
  - FAQ and privacy notice
  - sheet header + `COLUMNS.md` (8 new columns)
  - tests (+55; conversations #30–#35, and #7–#10, #16, #17 updated)
  - `TOOL_SETUP.md` (§5, §10, §11), `START_HERE.md`, `README.md`, `CODE_REVIEW.md` (L1 and N4 fixed; P1–P5, C1–C3, K1–K3)
- Not touched: the deck.

---

## 10. Final summary: every feature, its direction, and what is real vs simulated

**Real** means working, tested code that does what it says on any input. **Simulated** means the data or the
outside system it depends on is a stand-in. Every business, GSTIN, price and order is synthetic: the operator is
fictional and the case data is synthetic by design.

| # | Feature | Direction | Where | Real | Simulated / not yet real |
|---|---|---|---|---|---|
| 1 | Zero-question onboarding from a GSTIN: validity, status, category, scale, proposal, pre-approval, greeting EN/HI/KN | **CORE** | `onboard_from_gstin`, playbook 0 | GSTIN checks (format, state, checksum), blocking of Cancelled/Suspended, inference (73.1% zero-question, 98.3% segment right on 3,534 GSTINs), pricing through `price_bundle`; the first quote is the base bundle for the smallest business in the segment (0 of 2,584 above the true-size price), extras are switched-off add-ons, every assumption is stated | The registry is the case's mock; the Udyam link is by name + state (production: PAN); "clean filings" = Active + 6 months (no filing data) |
| 2 | Bundle advisor and one monthly price | **CORE** | `price_bundle`, playbook A | All catalogue and eligibility rules; the AI never invents a price | The catalogue is the case's; checkout and UPI Autopay are not built |
| 3 | GSTIN and Udyam verification | **CORE** | `verify_gstin`, `verify_udyam`, playbook B | Format, checksum, registry status, name match | Mock registries; DigiLocker and e-Sign are described, not connected |
| 4 | Consent per purpose (registry lookup, KYC verification, marketing), EN/HI/KN, withdrawable, recorded | **CORE** (trust) | `consent_manager`, demo page, global prompt | Separate answers, no defaults, history and version, withdrawal per purpose, enforced before lookups and document reading | The record lives in the conversation and the browser tab (no server log); HI/KN need native review; a withdrawal isn't written back to the sheet row |
| 5 | Smart KYC fallback: GST certificate reading | **CORE** | demo page, `certificate_reader` | Real OCR (Tesseract.js) on real images in the browser; field extraction; checksum-gated corrections; the same validation as onboarding; verified / review / blocked | Tested on 3 generated SAMPLE certificates, not real photos; not inside the Voiceflow chat; the 47 case KYC images aren't processed |
| 6 | Bill-swap calculator, honest when Accel costs more | **CORE** (conversion) | `bill_swap`, playbooks 0 and A | Like-for-like comparison, prices from `price_bundle`, unreadable amounts flagged | Nothing beyond the synthetic catalogue (the owner types their own bills) |
| 7 | Lead score (Hot / Warm / Cold) and back-office row | **CORE / REACH** | `register_lead`, playbook C | Logistic regression trained on the 5,000 case leads (CV AUC 0.71) | Trained on synthetic data; percentiles are extreme (L10) |
| 8 | Referral codes for CA partners, customers and field reps; rewards only on activation, held 90 days | **REACH** | `reach_tag_lead`, `reach_rules`, demo page `?ref=` | Code generation with a check character, attribution, reward rules (one `REACH_RATES` object), no double pay | The referrer directory is invented from the case cities; rates are design choices; no payout ledger |
| 9 | Territory credit for digital sales | **REACH** | `reach_rules` | Territory matching by city → state → GSTIN state code, rep credit rules | The territory map and reps are invented; no pincode table |
| 10 | Hot-lead handoff to the right rep, with a one-line summary | **REACH** | `reach_tag_lead`, playbook C | Uses the real model's top 20%; never tells the owner the score | Rep directory as in 8 |
| 11 | Back-office view of unclosed leads | **REACH** | `8_back_office/index.html` | Reads the real sheet (CSV link or file); filters; rewards computed with the same rules | The default sample is built from historical case leads with assumed attribution |
| 12 | Digital-readiness score 0–100, top 3 gaps, add-ons with new scores | **PROMISE** | `readiness_score`, playbooks 0 and A | Scoring rules in one object; eligibility from the catalogue | Weights are design choices from the case appendix, not fitted to outcomes |
| 13 | Activation guarantee decided at quote time (§11): 72 hours inside the scope, a firm number of days from the case data otherwise; deadline, breach → month one credited, a proactive message per stage, chases counted, retention flag on the 2nd chase | **PROMISE** | `price_bundle` (rule), `order_status`, playbooks A, D | Scope rule and firm days from observed activations, the tracker enforces the quote's promise, credit = the `price_bundle` monthly bill, messages in 3 languages, chase rule | AirFiber coverage (every case city); 5 demo orders and their events; the messages are shown, not sent on WhatsApp; chases are remembered within one conversation |
| 14 | Downtime auto-credit by a documented rule, message before the complaint | **PROMISE** | `downtime_credit`, playbook D, FAQ | The rule, the arithmetic and the message (EN/HI/KN); durations in 3 languages | The outage is typed in (no network monitoring); the credit isn't posted to a real bill; the amounts are design choices to pilot |
| 15 | Demo page hosting the chat widget | channel | `7_demo_site/index.html` | Static page, mobile-safe, referral links | Needs the Voiceflow widget snippet pasted in |
| 16 | Udyam entry for owners without a GSTIN (§12) | **CORE** | `onboard_from_gstin`, `udyam_input`, playbook 0 | Format check, masking, registry lookup, category and scale from `nic_description` (42.6% of GSTIN-less leads zero-question, segment right 100%), the same consent gate and pricing | The Udyam registry is the case's mock; no status field, so no blocking of closed enterprises |

**Not built:** the voice and WhatsApp front ends, the 3-minute demo video, the architecture diagram and the 1-page
privacy note (case deliverables), and a payout ledger. The bot itself still has to be assembled in Voiceflow and
its 50 conversation tests run. The deck's
team-name and campus placeholders are still open (the deck is not touched by this work).

---

## 11. What changed: the activation guarantee is scoped at quote time (2026-11-07)

**Why.** The 72-hour promise was built for every order (§9), but the figures behind it came from the catalogue, not
from what happened. Measured first (`6_tests/measure_promise_scope.mjs`, nothing changed before this):

**How the old figures were computed** (no script had recorded them; both reproduced exactly):
- **1.9%** = 7 of 368 activated bundles whose slowest item installs in ≤ 3 catalogue days. "Live" there means every
  product in the bundle, using `typical_install_days`, not observed times.
- **45.1%** = 166 of 368 under the same rule with Biz Fibre 100/300 counted at AirFiber's 2 catalogue days. 1 Gbps
  fibre and leased lines were not bridged; slow add-ons (telephony 5 days, CCTV 4, SMS 4) still counted.
- **Pincodes: none.** AirFiber was assumed at every address in both tiers. The data can't do better: the leads have
  no pincode, the pack has no coverage data, and the registry's pincodes are random (every city has pincodes
  starting with 8 different first digits).
- **The 2-day AirFiber figure is not what happened:** the 9 AirFiber orders went live in 2–7 days after KYC
  (median 5); 1 of 9 within 3 days.

**What actually happened** (an order = a lead that reached KYC complete, the moment the promise clock starts;
dates only, so "72 hours" = within 3 days):
- 46.5% of activated orders went live within 3 days: tier-1 cities 57%, tier-2 cities 31%.
- 220 of 588 confirmed orders never went live: 98 "installation delayed beyond 21 days", 41 "site not feasible
  for fibre" (both counted as missed promises), 53 cancelled and 28 failed payments (left out: no installation
  outcome).
- The add-ons hardly change the observed times; city tier, team size, sites and the connection do.

**Cost of the unscoped promise** (month one = the order's monthly bill; never-installed orders at their segment's
median bill, as if the promise had kept them):

| | Orders | Missed | Free-month credits per 1,000 orders |
|---|---|---|---|
| Every confirmed order | 507 | **66.3%** | **₹93.0 lakh** (≈ ₹9,300 per order) |
| Activated orders only | 368 | 53.5% | ₹79.4 lakh |
| Tier 1 / tier 2 | 275 / 232 | 54.5% / 80.2% | ₹85.0 / ₹102.4 lakh |

**The rule** (config `GUARANTEE_SCOPE` in `_build/price_bundle.js`; decided at quote time from what is known then).
"Connected in 72 hours, guaranteed" only when ALL hold:
- a **tier-1 city** (57% vs 31% within 3 days);
- **≤ 10 people on one site** (tier 1: 73% within 3 days, 99 orders, against 44% for bigger businesses; the best
  group known at quote time, none reaches 90%);
- the connection is **Biz Fibre 100/300 or 5G AirFiber** (street-level installs; 1 Gbps fibre and leased lines need
  a site survey, 7–30 catalogue days);
- **AirFiber covers the address**: the bridge if fibre slips, and the fallback when the site isn't feasible for fibre.
  SIMULATED coverage (every case city) until a pincode coverage table exists; `airfiber_available` = "no" overrules.

Every other order gets a **firm number of days** with the same month-one-free promise: the day by which 9 in 10 past
activated orders of the same city tier and connection were live (`compute_activation_promise_data` in
`gen_kit.py`, groups of ≥ 20 orders, otherwise the connection in both tiers, then the tier), never sooner than the
catalogue's install time:

| City tier | Fibre ≤ 300 Mbps | 1 Gbps fibre | 5G AirFiber* | Leased line |
|---|---|---|---|---|
| Tier 1 | 7 days | 7 days | 8 days | 21 days (catalogue; observed 14) |
| Tier 2 | 10 days | 9 days | 11 days | 21 days (catalogue; observed 14) |

\* only 9 AirFiber orders: the tier's all-connection figure is used.

**Re-estimated with the scoped rule** (the generated `price_bundle` quoting each confirmed order from what was known
at quote time; same definitions as above):

| | Unscoped | **Scoped** |
|---|---|---|
| Orders that get the 72-hour guarantee | 100% | **23.5%** (119 of 507) |
| Missed (all confirmed orders) | 66.3% | **37.9%** |
| Missed (activated orders) | 53.5% | **14.4%** |
| Credits per 1,000 orders | ₹93.0 lakh | **₹52.2 lakh** |
| Credits per 1,000 activated orders | ₹79.4 lakh | **₹23.4 lakh** |

- The 72-hour group still misses 27.3% of activated orders, but its bills are the smallest (median ₹2,620): ₹10.7
  lakh per 1,000 of them. Firm-date orders miss 9.7% once installed, as designed.
- Most of what is left is the never-installed orders (27% of confirmed orders today): fixing the installation
  backlog saves more than any change to the dates.
- Of all 5,000 leads quoted at their true size, 31.9% would see the 72-hour guarantee.

**Built:**
- `price_bundle`: new outputs `promise_type` (guaranteed_72h · firm_date), `promise_hours`, `promise_days`,
  `promise_text` (the card's last line, EN/HI), `promise_reasons`; new input `airfiber_available`.
- `order_status` / `promise_rules`: the deadline is the promise from the order's own quote (`promise_hours`), never a
  fixed 72 h; tracker lines name it ("72-hour guarantee", "7-day guarantee") in EN/HI/KN. Demo orders: UD-0782 (a
  qualifying Delhi kirana, connected on AirFiber in 40 h) added; UD-0001 and UD-1460 re-timed to their firm dates.
- Onboarding's greeting states the quote's guarantee in EN/HI/KN instead of "live in about N days".
- Knowledge base: an "ACTIVATION PROMISE" section generated from the code (`_build/kb_promise_rules.mjs`); the FAQ,
  global prompt (hard rule 4), playbooks 0, A and D, TOOL_SETUP and the demo page no longer promise 72 hours to
  everyone, and a test fails if any of them does again.

---

## 12. What changed: Udyam entry for owners without a GSTIN (2026-11-07)

**Why.** 1,466 of the 5,000 leads (29.3%) have no GSTIN: micro retail 47.2%, professional offices 13.9%, multi-site
1.7%, manufacturers 0.7%. 636 of them (43.4%) have a Udyam number, and every one is in the mock Udyam registry.
830 leads (16.6% of all) have neither. Above the 10% bar, so built.

**How.** `onboard_from_gstin` takes `udyam_number` (or recognises a Udyam number typed where the GSTIN goes):
- reads, checks and masks it with the shared `_build/udyam_input.js`, now also embedded in `verify_udyam` (one
  implementation; a test checks both copies);
- looks it up in the embedded Udyam registry: `nic_description` gives category and scale (direct evidence,
  confidence 1, not a name + state link), the registry gives city and state;
- the rest is the GSTIN flow: the same consent gate (nothing is looked up without `consent_given` = yes), chains get
  the locations question, the base bundle for the smallest business, prices only from `price_bundle` (with
  `has_gstin` = "no", so GST-only products are left out), the quote's activation guarantee, and pre-approval by
  registration age (the Udyam registry has no status field);
- new outputs `entry_type`, `udyam_valid`, `udyam_status`, `udyam_masked`; new next action `fix_udyam`.
- Playbook 0 now asks: "Do you have a GST number? If not, your Udyam number works too."

**Result** (`node 6_tests/measure_onboarding.mjs`, every GSTIN-less lead):

| | Leads | Share of GSTIN-less leads |
|---|---|---|
| Zero-question proposal | **625** | **42.6%** (98.3% of those with a Udyam number); segment right 100% |
| Proposal within one question (the 11 chains answer "how many locations") | 636 | 43.4% |
| Neither number: question-based advisor | 830 | 56.6% |

The GSTIN path is unchanged: 73.1% zero-question on the 3,534 registry GSTINs, segment right 98.3%.

**Checks:** 304 tests pass (29 new: scope boundaries one condition at a time, firm days, the tracker using the
quote's promise, "never 72 hours on a firm-date order" in every language, Udyam entry for valid, typed-in-the-GSTIN-
field, both-numbers, invalid, two-numbers, extra-digit, unknown, no-consent, chain and new-registration cases). Before
and after on 10,000 `price_bundle`, 21,796 `verify_udyam` and 3,534 onboarding calls: no differences beyond the
intended ones. Known limits G1–G8 are in CODE_REVIEW.md.
