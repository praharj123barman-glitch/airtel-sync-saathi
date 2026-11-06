# Function tools: how to add each one in Voiceflow

For each file: **Tools → + New tool → Function**. Paste the whole `.js` file into the code editor, then add the input
and output variables **exactly as named below**. The **description** is what the AI reads to decide what to pass,
so copy it word for word.

Every function returns all of its outputs every time (empty when not relevant) and never crashes the chat. If
something goes wrong, the `error` output is filled instead.

Test any function inside Voiceflow with the **Run** button using the sample inputs below. The same cases run
locally with `node 6_tests/run_function_tests.mjs`; all of them pass.

**GSTIN inputs (`onboard_from_gstin`, `verify_gstin`, `verify_gstin_lite`): pass the owner's whole message.** The
tools read the GSTIN out of it with one shared reader (`_build/gstin_input.js`): "my gstin is 07PUTXM1153M1Z9",
"GSTIN: 07PUT…", "07 putxm 1153 m1z9" and "07-PUTXM-1153-M1Z9" all work. Spaces, dashes, dots and slashes are
ignored and letters are upper-cased. If the message holds no GSTIN, or two different ones, the tool says so in the
owner's language (two GSTINs are listed masked, and the owner is asked which one) and never guesses.

**Status codes are for the playbooks, never for the owner.** `gstin_status` can be `Active`, `Cancelled`,
`Suspended`, `NOT_FOUND`, `FORMAT_OK` (lite only), `CONSENT_NEEDED` (verify_gstin: no registry-lookup consent, so
nothing was looked up) or a problem: `INVALID_FORMAT` (no complete GSTIN in the message),
`MULTIPLE_GSTINS`, `INVALID_STATE`, `CHECKSUM_FAILED`. Every problem comes with a short, friendly message in
`kyc_message` / `greeting` (English, Hindi; Kannada in onboarding). Show that message, never the code.

---

## 1. `price_bundle`: the only source of bundles and prices

**Tool description:** *Builds the recommended Accel Business bundle and its exact monthly price from the product
catalogue. Always call this to recommend, quote or change a bundle. Never quote prices without it. It shows the
quote card to the owner itself.*

| Input | Description for the AI |
|---|---|
| `business_type` | Type of business in a few words, e.g. "kirana store", "dental clinic", "restaurant chain", "textile unit" |
| `segment` | Leave empty unless known: micro, prof, multi or mfg |
| `city` | City name, e.g. "Delhi" |
| `employees` | Number of people working, digits only |
| `sites` | Number of locations or branches, digits only (1 if one shop) |
| `has_gstin` | "yes" or "no": whether the business has a GST registration |
| `needs` | Comma-separated keywords from: failover, email, storage, security, firewall, pos, cctv, wifi, whatsapp, sms, website, telephony, tollfree, staticip, iot, fleet, sdwan, leased, highspeed |
| `fibre_available` | "no" if there is no fibre at the location or they want it working within 2 days, else leave empty |
| `airfiber_available` | "no" if the owner (or a coverage check) says 5G AirFiber doesn't work at the address, else leave empty. It takes the order out of the 72-hour guarantee |
| `budget` | Monthly budget in rupees, digits only, only if the owner asked for cheaper |
| `add` | Items to add, comma-separated, with a quantity if given, e.g. "cctv 4, static ip" |
| `remove` | Items to remove, comma-separated, e.g. "cloud backup" |
| `contract_months` | Only if the owner asks for a longer contract: 12 or 24 |
| `lang` | "hi" for Hindi or Hinglish conversations, otherwise "en" |
| `lines` / `email_users` / `cameras` / `counters` / `machines` / `vehicles` | Only if the owner states an exact number |
| `show_card` | Leave empty (the card is shown). "no" hides it |

**Outputs:** `bundle_name`, `monthly_total`, `setup_total`, `contract_months`, `install_days`, `quote_text`,
`why_text`, `blocked_text`, `budget_note`, `items_json`, `segment_code`, `promise_type`, `promise_hours`,
`promise_days`, `promise_text`, `promise_reasons`, `error`

**The activation guarantee** (STRATEGY.md §11) is decided here, at quote time, and is the last line of the card:
- `promise_type` = `guaranteed_72h` ("Connected in 72 hours, guaranteed, or month one is free") only when ALL of
  `GUARANTEE_SCOPE` holds: tier-1 city, up to 10 people, one site, Biz Fibre 100/300 or 5G AirFiber, and AirFiber
  covers the address (SIMULATED coverage: every case city; `airfiber_available` = "no" overrules it).
- Otherwise `firm_date`: `promise_days` = the day by which 9 in 10 past orders of the same city tier and connection
  were live (from `smb_leads.csv`, injected by the build), never sooner than the catalogue's install time. Same
  month-one-free promise.
- `promise_hours` is what `order_status` counts down to. `promise_reasons` says in English why an order isn't in the
  72-hour scope (empty when it is); the agent uses it only if the owner asks, and never promises 72 hours instead.
- The knowledge base's "ACTIVATION PROMISE" section is generated from the same values (`_build/kb_promise_rules.mjs`).

Sample run: `business_type` = Diagnostic lab · `city` = Delhi · `employees` = 16 · `has_gstin` = yes ·
`needs` = failover, email, storage, security · `lang` = hi → **Office Pro · ₹6,138/माह**, guarantee 7 days (16 people
is above the 72-hour scope). Kirana in Delhi, 3 people → `promise_type` = guaranteed_72h.

---

## 2. `verify_gstin`: GSTIN check without a certificate upload

**Tool description:** *Checks a GSTIN's format and checksum and looks it up in the GST registry. Blocks Cancelled
or Suspended GSTINs. Only call after the owner has accepted a quote and given consent; pass consent_given = yes
only when consent_registry_lookup is true (the tool refuses otherwise). Show kyc_message to the
owner as it is.*

| Input | Description |
|---|---|
| `gstin` | The owner's message that contains the GSTIN, unchanged (e.g. "my gstin is 07PUTXM1153M1Z9"). The tool finds the GSTIN in it; don't retype or "fix" it |
| `consent_given` | "yes" only when consent_registry_lookup (consent_manager) is true. Missing, "no" or "false" → nothing is looked up, `gstin_status` = CONSENT_NEEDED and kyc_message asks for consent |
| `business_name` | The business name the owner gave, if any |
| `lang` | "hi" or "en" |

**Outputs:** `gstin_ok`, `gstin_status`, `gstin_masked`, `legal_name`, `trade_name`, `gst_state`, `constitution`,
`name_match`, `kyc_message`, `error`

Try: `07PUTXM1153M1Z9` (Active) · `29OKAXP4077P1ZL` (Cancelled) · `23QYBXS1811Q1ZD` (Suspended) · `07PUTXM1153M1Z8` (typo)
· `my gstin is 07putxm1153m1z9` (Active, read from the sentence) · `07PUTXM1153M1Z9 or 29OKAXP4077P1ZL` (asks which one)

> **Too big for the editor?** The full file embeds the case's 3,534-record mock registry (258 KB). If Voiceflow
> rejects it, use `verify_gstin_lite.js` (33 KB) instead. It keeps the format and checksum checks and still blocks
> all 268 cancelled and suspended GSTINs, but it can't show the registered name.

---

## 3. `verify_udyam`: optional Udyam check

**Tool description:** *Looks up a Udyam registration number in the Udyam registry. Optional step; if it fails,
continue without it.*

Inputs: `udyam_number`, `business_name`, `lang` · Outputs: `udyam_ok`, `udyam_masked`, `enterprise_name`,
`enterprise_type`, `major_activity`, `udyam_city`, `name_match`, `kyc_message`, `error`

`udyam_number` may be the owner's whole message ("my Udyam no. is …"): the number is read out of it by the shared
`_build/udyam_input.js`, the same code `onboard_from_gstin` uses for Udyam entry.

Try: `UDYAM-DL-00-7084760`

---

## 4. `register_lead`: lead score, reference ID, go-live date

**Tool description:** *Creates a reference ID, a lead score (0–100) and a priority (Hot, Warm or Cold) for the
back-office queue, and the expected go-live date. Call once, right before adding the Google Sheets row.*

Inputs: `segment`, `business_type`, `city`, `language`, `employees`, `sites`, `has_gstin`, `has_udyam`,
`current_internet`, `current_provider`, `contact_role`, `monthly_spend`, `needs`, `install_days` (no `stage`: the
stage goes to `reach_tag_lead` and the sheet)

Outputs: `ref_id`, `lead_score`, `priority`, `activation_probability`, `expected_live_date`, `created_at`, `error`

The score is a logistic-regression model trained on the case's 5,000 leads (5-fold CV AUC 0.71; the top 20% of
scored leads held 40% of activations). Fields the chat doesn't know are treated as average.

---

## 5. `order_status`: tracker with the activation guarantee from the quote (demo orders)

**Tool description:** *Shows an order's timeline, its activation guarantee as shown on its quote (on track, met or
breached, with the automatic month-one credit) and the proactive messages Saathi has sent. Call when the owner asks about an order,
installation, technician visit or activation. Set is_chase = "yes" when the owner asked on their own. It shows
the timeline itself.*

| Input | Description for the AI |
|---|---|
| `order_id` | The order number, e.g. UD-0068 |
| `lang` | "hi", "kn" or "en" |
| `is_chase` | "yes" if the owner asked about the order unprompted; "no" if Saathi brought it up |
| `previous_chases` | chase_count from an earlier call in this conversation; empty the first time |

**Outputs:** `order_found`, `order_stage`, `next_step`, `tracker_text`, `is_demo`, `promise_type`, `promise_hours`
(the guarantee on the order's quote card: `guaranteed_72h` / 72, or `firm_date` / days × 24), `order_confirmed_at`,
`guarantee_deadline` (confirmed + `promise_hours`), `hours_to_deadline`, `guarantee_status` (on_track · met · breached),
`connected_at`, `monthly_total`, `month_one_credit` (the whole monthly bill from `price_bundle` when breached, else
0), `proactive_messages_json` (stage messages already sent), `next_proactive_message`, `chase_count`,
`retention_flag` (true from the 2nd chase), `error`.

The deadline is never decided here: the tool asks the embedded `price_bundle` for the order's quote (its stored
pricing inputs) and uses that quote's `promise_hours`, so the tracker enforces exactly what the card showed. The other
rules (credit share, chase threshold) are in one object, `PROMISE_RULES` in `_build/promise_rules.js`, embedded
unchanged here and in `downtime_credit`. The monthly bill comes from the same quote.

Demo orders (SIMULATED, timed relative to now, so the demo always looks current; the tracker says "Demo order"):
`UD-0782` 72-hour guarantee, connected on AirFiber in 40 h · `UD-0068` 7-day guarantee, on track · `UD-0002` 10-day
guarantee, kept · `UD-0001` 10-day guarantee missed, month one credited, 1 earlier chase (try `is_chase` = yes,
`previous_chases` = 1 → `retention_flag` true) · `UD-1460` 7-day guarantee, connected late, has 4G failover.

---

## 6. `onboard_from_gstin`: zero-question onboarding (the default start)

**Tool description:** *Turns the owner's GSTIN, or their Udyam number if they have no GSTIN, into a greeting with a
priced proposal, or ONE clarifying question, or a block for human review. Call it right after the owner shares a
GSTIN or Udyam number with consent. It shows its greeting and quote card itself. Act on next_action.*

| Input | Description for the AI |
|---|---|
| `gstin` | The owner's message that contains the GSTIN, unchanged (e.g. "GSTIN: 07PUTXM1153M1Z9"). The tool finds the GSTIN in it; don't retype or "fix" it. A Udyam number typed here is recognised too |
| `udyam_number` | Only when the owner has NO GSTIN: their message with the Udyam number, unchanged (e.g. "UDYAM-KL-00-3078801"). Leave gstin empty. If both are given, the GSTIN is used |
| `consent_given` | "yes" only when consent_registry_lookup is true. Without it the tool looks nothing up (GST or Udyam) |
| `lang` | "hi" for Hindi/Hinglish, "kn" for Kannada, otherwise "en" |
| `answer_business_type` | Only on the second call: the owner's answer to the business-type question (a button label or free text) |
| `answer_sites` | Only on the second call: the owner's answer to the locations question ("1", "2", "3–5", "6–10", "10+" or a number) |
| `as_of_date` | Leave empty (tests use it to fix "today", YYYY-MM-DD) |
| `show_card` | Leave empty. "no" hides the greeting and card |

**Outputs:** `entry_type` (gstin · udyam), `gstin_valid`, `gstin_status`, `gstin_masked`, `udyam_valid`, `udyam_status`
(FOUND · NOT_FOUND · INVALID_FORMAT · MULTIPLE_UDYAM; empty on the GSTIN path), `udyam_masked`, `is_blocked`,
`next_action`, `business_name`, `gst_city` (the registry city, GST or Udyam),
`gst_state`, `city_tier`, `constitution`, `registration_date`, `registration_age_years`, `business_category`,
`category_label`, `segment_code`, `segment_confidence`, `evidence_fields`, `assumptions`, `assumptions_json`,
`clarifying_question`, `question_type`, `question_options`, `pricing_inputs_json`, `bundle_name`, `monthly_total`,
`setup_total`, `contract_months`, `install_days`, `promise_type`, `promise_hours`, `promise_days`, `promise_text`
(the quote's activation guarantee; the greeting states the same one), `quote_text`, `why_text`, `blocked_text`,
`items_json`, `suggested_addons_json`, `pre_approved`, `pre_approval_reason`, `greeting`, `error`

- `assumptions`: the assumption sentence shown in the greeting, in the owner's language ("I've assumed a shop, a team
  of 1–2, 1 location and business fibre reaching your address. Tell me if you're bigger…").
- `assumptions_json`: the same as a list, `[{ key, value, text }]`, keys `business_type`, `team_size` (the range the
  same quote covers, e.g. "1–2"), `locations`, `connection` (when the quote needs fibre or a leased line).
- `suggested_addons_json`: the segment's extras, switched off: `[{ need, items, monthly_price, setup_price, reason,
  included: false }]`. Each price is price_bundle's total with that need minus the base total. **Not in
  `monthly_total`.** To switch one on, call price_bundle with `pricing_inputs_json` plus `needs` = the add-ons' needs.

`next_action` is one of `show_proposal` · `ask_question` · `human_review` (Cancelled/Suspended: never quoted or
activated) · `fix_gstin` · `fix_udyam` (no or several Udyam numbers in the message) · `use_advisor` · `ask_consent`.

**Udyam entry** (STRATEGY.md §12): with `udyam_number` (and no GSTIN) the tool reads the number with the shared
`udyam_input` reader, looks it up in the embedded Udyam registry and takes the business type (`nic_description`,
direct evidence, confidence 1), city and state from it. The rest is the same as for a GSTIN: chains get the
locations question, prices come only from `price_bundle` (with `has_gstin` = "no", so GST-only products are left
out), and pre-approval is by registration age (the Udyam registry has no status field). Unknown number →
`use_advisor`; malformed → `fix_udyam`.

How it decides:
- **Category:**
  - The Udyam business type is used first (linked to the GSTIN by name + state; SIMULATED, production would link
    by PAN).
  - Then trade-name words, e.g. "Diagnostics" → clinic, "Associates" → CA firm or law office, which is ambiguous.
  - Both are reported in `evidence_fields`.
- **Scale (single shop or chain):**
  - The Udyam business type comes first, e.g. "Pharmacy chain".
  - Otherwise the constitution: 87.8% of proprietor retailers in the case data were single shops, while every
    company and LLP was a chain.
  - Restaurants, gyms and hotels always get the locations question.
- **Confidence below 0.7** → one question instead of a guess.
- **Price:** always from `price_bundle`. The build embeds the generated `price_bundle.js` unchanged.
  `pricing_inputs_json` shows exactly what was sent, and the test suite re-prices it to prove the numbers match.
- **First quote never overshoots:** it is the base bundle (no extras) for the SMALLEST sensible business in the
  segment: the smallest team in the case data (shops and services 1, offices 3, chains 15, factories 12), at least one
  person per site, and the lowest number in a locations answer ("6–10" → 6). price_bundle's price only grows with
  size, so telling Saathi the real size can only move it up. Measured on all 3,534 registry GSTINs
  (`node 6_tests/measure_onboarding.mjs <case data>`): 0 first quotes above the price at the business's true size
  (77.2% were before).
- **Extras** (POS for shops, failover for offices, CCTV for chains, machine sensors for factories) are suggested
  add-ons, switched off, each with a one-line reason and its price, named in the greeting but never in the total.
- **Pre-approved** = Active GSTIN registered at least 6 months ago. Filing history is not in the case data, so it
  isn't checked.

Try: `07PUTXM1153M1Z9` (proposal) · `27VBLXG7653G1ZE` (kirana: ₹1,298 base, POS offered as an add-on) ·
`29OKAXP4077P1ZL` (cancelled) · `07BSWXR0494W1ZP` (asks business type) ·
`27LRRXS3617L1ZA` (asks locations) · `27ABCXE9999F1ZR` (valid but not registered → advisor) · Udyam entry:
`UDYAM-KL-00-3078801` (clinic, 10-day guarantee) · `UDYAM-DL-00-0779845` (Delhi kirana, 72-hour guarantee) ·
`UDYAM-TN-00-3866196` (chain: asks locations)

> **Size:** ≈ 490 KB, because it embeds the GST registry joined with Udyam business types, the Udyam registry for
> Udyam entry and the pricing function.
> If Voiceflow's editor rejects it, tell me. A lighter build would need the registry served by a small API instead.

---

## 7. `bill_swap`: bill-swap calculator (offered right after a proposal)

**Tool description:** *Compares the owner's current monthly bills with the matching Accel bundle, priced by the
pricing function. Shows monthly and yearly savings, or says plainly that Accel costs more and what the extra buys.
It shows its message itself. Never restate or change its numbers.*

| Input | Description for the AI |
|---|---|
| `bills` | The owner's bills, one per line, as typed: "category \| vendor \| monthly amount" (e.g. "Mobile \| Jio \| 3 x 799") |
| `business_context_json` | From onboarding: pass `pricing_inputs_json` from onboard_from_gstin |
| `business_type`, `segment`, `city`, `employees`, `sites`, `has_gstin` | From the advisor, if there was no onboarding (these override the JSON) |
| `lang` | "hi", "kn" or "en" |
| `show_card` | Leave empty |

**Outputs:** `next_action` (show_comparison · ask_bills), `bills_read`, `unreadable_lines`, `needs_confirmation`,
`current_monthly_total`, `not_compared_monthly_total`, `not_compared_text`, `comparison_text`, `pricing_inputs_json`,
`assumptions`, `accel_bundle_name`, `accel_monthly_total`, `accel_setup_total`, `accel_items_json`, `accel_quote_text`,
`monthly_saving` (negative = Accel costs more), `yearly_saving`, `first_year_saving` (after the setup fee),
`is_accel_cheaper`, `extra_value_text`, `message`, `error`

How it stays honest:
- **Like for like.** The Accel bundle is priced for what the owner pays for today. Default extras the owner doesn't
  have (backup, security, failover) are removed. If the bundle still includes something they don't pay for today
  (e.g. a connection), it's shown as extra value, not hidden.
- **Out of the totals.** Bills Accel doesn't sell (electricity, rent, accounting software) or can't sell to this
  business (e.g. WhatsApp API without a GSTIN) are listed separately and not counted.
- **Never guessed.** Unreadable amounts and amounts over ₹1,00,000 a month are listed for the owner to confirm and
  left out. Yearly amounts are ÷ 12, and quantities nobody stated are reported in `assumptions`.
- **Amounts as people write them.** The amount is read from the last field after the category, so a plan name like
  "Biz Fibre 100" is never money. Understood: "₹1,299", "Rs 1299", "Rs. 1,299/-", "INR 1299", "1299 rupees", "1299";
  "₹799 x 3", "₹799 ×3", "3 x ₹799", "3 lines at 799", "3 SIMs @ ₹799", "3 SIMs, ₹799 each". Speeds, data sizes,
  shares and plan names ("100 Mbps", "18% GST", "5G") are not money; "₹1,000 + 18% GST" is read as ₹1,000, the
  amount before GST, like Accel's own prices.
- **Asks when it's unclear.** With no ₹ or unit word, the number under ₹50 is the quantity ("799 x 3"). When either
  number could be the quantity ("120 x 100"), a quantity is over 150 (the largest team in the case data), a line
  holds two amounts ("₹500 + ₹300"), or "each" has no quantity, the line is left out and `unreadable_lines` holds the
  question to ask ("which number is the quantity? Please write it like 3 x ₹799"). These questions are in English,
  like the other problems; the agent may translate them.
- **Setup fee.** The one-time setup fee is counted against year one (`first_year_saving`).

Try: `Broadband | Local ISP | ₹2,500` + `Mobile | Competitor A | 3 x 799` for a 14-person clinic in Delhi (saves) ·
`Mobile hotspot recharge | Jio | ₹399` for a kirana (Accel costs ₹600 more, said plainly)

---

## 8. `readiness_score`: digital-readiness score (start of discovery, or after the GSTIN lookup)

**Tool description:** *Scores how digitally ready the business is (0–100) from what it already uses, names the top
3 gaps, and lists the Accel add-ons that close them with the new score after each. It shows its message itself. It
never quotes prices: to price the add-ons, pass suggested_needs to price_bundle.*

| Input | Description for the AI |
|---|---|
| `current_products` | What the business already uses, comma-separated, as the owner said it ("none" is valid; empty → it asks) |
| `segment` | segment_code (micro/prof/multi/mfg) or business_category from onboarding, or the business type |
| `staff_count` | Only if the owner stated it (estimates make conditions look met when they may not be) |
| `sites`, `has_gstin` | If known; unknown facts are shown as conditions ("needs an active GSTIN"), not assumed |
| `lang` | "hi", "kn" or "en" |
| `show_card` | Leave empty |

**Outputs:** `next_action` (show_score · ask_products), `readiness_score`, `segment_used`, `segment_assumed`,
`recognised_products` (each item, the capability it counts for, and its credit), `unrecognised_items`, `top_gaps`,
`gaps_json`, `add_ons_json` (step, product, conditions, new_score), `add_on_path_text`, `score_after_add_ons`,
`suggested_needs` (price_bundle need keywords for the add-ons), `message`, `error`

**The rules live in one object, `READINESS_RULES`, in `_build/readiness_score.js`:**
- **Capabilities.** Each one lists the words that recognise it, the credit each earns (e.g. home broadband 50%,
  personal SIM 50%, free WhatsApp app 50%) and the add-ons that close it.
- **Weights per segment, out of 100.** They follow the case's Appendix A2 "key needs" (micro: internet,
  billing/UPI, WhatsApp; offices: uptime, cloud email/storage, data security; multi-site: failover, central
  management, CCTV; factories: dedicated bandwidth, machine IoT).

A test checks that every segment's weights add up to 100.

Try: `home broadband, 2 jio sims, gmail` for a clinic with 12 staff → 19/100; add-ons → 39, 54, 65

---

## 9. `reach_tag_lead`: referral, territory and rep-callback tags (REACH)

**Tool description:** *Mode "tag" (default): call right after register_lead and before adding the Google Sheet
row. It checks the referral code, finds the territory and its field rep, and flags Hot leads Saathi couldn't close
for a rep callback with a summary. It may show a one-line thank-you or a mistyped-code question; it never shows the
score or the handoff. Mode "issue_code": gives a live customer their own referral code.*

| Input | Description for the AI |
|---|---|
| `mode` | Empty (tag) or "issue_code" |
| `referral_code` | From the referral link (variable set at launch) or typed by the owner; empty if none |
| `city`, `state`, `gstin_masked` | gst_city / gst_state / gstin_masked from onboarding (or the advisor's city). The tool also accepts the onboarding names `gst_city` and `gst_state` directly |
| `lead_score`, `priority` | From register_lead |
| `stage`, `reason_not_closed` | Where the conversation ended and why |
| `business_name`, `segment_code`, `bundle_name`, `monthly_total`, `gstin_status` | What the owner saw |
| `closed_by` | Leave empty (= "saathi") |
| `order_id` | Mode "issue_code" only: the live order, e.g. UD-0002 |
| `customer_id` | Mode "issue_code" only, instead of order_id when the customer ID is known; leave empty otherwise |
| `lang` | "hi", "kn" or "en" |
| `show_card` | Leave empty. "no" hides the message |

**Outputs:** `referral_code`, `referral_valid`, `referral_problem` (none · format · checksum · unknown_referrer),
`referrer_type`, `referrer_id`, `territory_id`, `territory_label`, `territory_rep_id`, `territory_matched_by`,
`closed_by`, `drop_off_stage`, `handoff_flag`, `handoff_owner_id`, `handoff_summary`, `owner_message`, `share_text`,
`error`. They map one-to-one to the new sheet columns in `5_google_sheet/COLUMNS.md`.

**No rewards here.** Nothing is earned when a lead is created. Rewards are earned only when the back office marks the
row `Activated` and sets `activated_date`; the back-office page computes them with the same rules.

**One set of rules.** The rules come from `_build/reach_rules.js`, embedded unchanged here and in
`8_back_office/reach_rules.js`, and a test checks that the two copies are identical. Rates live in one object,
`REACH_RATES`.

Try: `referral_code` = the code of `CA-DEL-1` (the back-office sample shows codes), `city` Delhi, `priority` Hot,
`stage` proposal_shown → thank-you message, territory T-DEL / REP-DEL, `handoff_flag` true.

---

## 10. `downtime_credit`: automatic credit for an outage (PROMISE)

**Tool description:** *Applies the documented downtime credit for an outage on a live order and shows the apology
and the amount itself, so the owner never has to complain. Call when the owner says the internet was down (or for
the demo command "Simulate a 3-hour outage on UD-0002").*

| Input | Description for the AI |
|---|---|
| `order_id` | The order number, e.g. UD-0002 |
| `outage_duration` | How long it was down, as the owner said it: "3 hours", "3h 20m", "90 minutes", "1:30", "2 घंटे 15 मिनट", "90 ನಿಮಿಷ" |
| `lang` | "hi", "kn" or "en" |
| `show_card` | Leave empty. "no" hides the message |

**Outputs:** `order_found`, `is_demo`, `is_live`, `outage_minutes`, `monthly_total`, `has_failover`, `credit_amount`,
`credit_rule` (the rule applied, in words), `message`, `error`.

**The rule** (`PROMISE_RULES.downtime` in `_build/promise_rules.js`): under 60 minutes → no credit (the owner is
still told). Otherwise each started 4-hour block credits one day's bill (monthly bill from `price_bundle` ÷ 30,
rounded to the rupee). Bundle with 4G failover (P09) → × 0.5, because the owner stayed online. Capped at 50% of the
monthly bill. An order that isn't live yet gets no downtime credit (the activation guarantee covers that period). An
unreadable duration or an unknown order returns `error`; nothing is guessed.

SIMULATED: in production the network monitoring system calls this when an outage ends, before the owner complains.
Here the outage is typed in.

Try: `UD-0002`, "3h 20m" → ₹73 · `UD-1460`, "5 hours" → ₹240 (failover, halved) · `UD-0068`, "2h" → not live yet.

---

## 11. `consent_manager`: consent per purpose, with withdrawal (DPDP)

**Tool description:** *Shows the consent screen (three separate purposes: registry lookup, KYC verification,
offers on WhatsApp) in the owner's language, records each answer, withdraws one purpose, or checks what is
allowed. Always pass consent_record_json back in. It shows its message itself.*

| Input | Description for the AI |
|---|---|
| `mode` | "show" (default), "record", "withdraw" or "check" |
| `lang` | "hi", "kn" or "en" |
| `consent_record_json` | The record from the previous call; empty the first time |
| `registry_lookup`, `kyc_verification`, `marketing` | Mode "record": "yes" or "no" as the owner answered; empty = not answered (stays not granted) |
| `purpose` | Mode "withdraw": the owner's words ("stop offers", "kyc", "registry lookup") |
| `show_card` | Leave empty. "no" hides the message |

**Outputs:** `consent_screen_text`, `consent_options_json` (one entry per purpose with its yes/no labels, for
buttons), `consent_record_json` (answers, timestamps and full history), `consent_registry_lookup`,
`consent_kyc_verification`, `consent_marketing` (true/false), `consent_version`, `consent_updated_at`, `message`,
`error`.

Nothing is granted by default; only an explicit yes ("yes", "haan", "हाँ", "ಹೌದು") grants a purpose; "maybe" or
silence changes nothing. Withdrawing one purpose leaves the others alone. The texts are in `_build/consent_rules.js`
(English, Hindi, Kannada; have native speakers review Hindi and Kannada before going live). The demo page's consent
screen embeds the same file.

Try: mode "show", lang "kn" → the Kannada screen · mode "record", registry_lookup "yes" → only registry lookup is
granted · mode "withdraw", purpose "stop the whatsapp offers" → marketing withdrawn, history kept.
