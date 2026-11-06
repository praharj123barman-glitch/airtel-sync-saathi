# Back-office Google Sheet: columns

One row per lead. Saathi adds the row (playbook C: `register_lead`, then `reach_tag_lead`, then the Google Sheets
"Add row" tool). The back office edits the last columns as the sale progresses. The back-office page
(`8_back_office/index.html`) reads this sheet (File → Share → Publish to web → CSV). It recomputes territory, handoff
and rewards with the same rules as the chatbot, so a row stays correct even after a manual edit.

The header row is in `back_office_leads_template.csv`; paste it into row 1. Column order doesn't matter, but names do.

## Existing columns (written by Saathi)

| Column | What it holds |
|---|---|
| `created_at` | When the row was created (IST), from `register_lead` |
| `ref_id` | Saathi reference, e.g. `SA-15FTHB` |
| `stage` | Where the conversation ended. Saathi stages (`proposal_shown`, `question_asked`, `callback_requested`, `kyc_done`, …) or a funnel stage. The back office sets `Activated` on go-live |
| `priority`, `lead_score` | From `register_lead`: Hot / Warm / Cold and the 0–100 percentile. Hot = top 20% of scores |
| `contact_name`, `contact_phone`, `callback_time`, `language` | Collected for the callback. The phone is personal data: share it only with the person calling |
| `business_name`, `business_type`, `segment_code`, `city`, `employees`, `sites`, `has_gstin`, `gstin_masked`, `gstin_status` | Business details. The GSTIN is always masked |
| `bundle_name`, `monthly_total`, `setup_total`, `contract_months`, `expected_live_date` | The bundle the owner viewed, priced by `price_bundle` |
| `reason_not_closed` | Why the owner didn't go ahead, in a few words |

## New columns: REACH layer (2026-11-04)

| Column | Written by | Values | Meaning |
|---|---|---|---|
| `state` | Saathi | e.g. `Karnataka` | State from the GST registry (`gst_state`). Territory falls back to it when the city isn't a territory |
| `referral_code` | Saathi | `CA-7K2P9-X` style or empty | The code from the referral link (`?ref=`) or typed by the owner |
| `referrer_type` | Saathi | `ca_partner` · `customer` · `field_rep` · `none` | Who referred the lead. `customer` = an existing customer acting as micro-agent |
| `referrer_id` | Saathi | e.g. `CA-DEL-1`, `L00002`, `REP-PUN` | The referrer. Empty if the code was mistyped or unknown (then nobody is credited until it's fixed) |
| `territory_id` | Saathi | e.g. `T-DEL`, `UNASSIGNED` | Territory from the city (district), else the state, else the GSTIN's state code |
| `territory_rep_id` | Saathi | e.g. `REP-DEL`, `CENTRAL-DESK` | The field rep who owns that territory and gets its territory credit |
| `closed_by` | Saathi, then back office | `saathi` · `field_rep` · `partner` | Who closed the sale. Saathi writes `saathi`; the back office changes it if a rep or partner closes it in person. Territory credit applies only to `saathi` (digital) activations |
| `drop_off_stage` | Saathi | `Lead` · `Contacted` · `Needs assessed` · `Quote accepted` · `KYC complete` · `Activated` | `stage` mapped to the case funnel (a proposal shown counts as needs assessed) |
| `handoff_flag` | Saathi | `TRUE` / `FALSE` | TRUE = Hot (top 20%), not activated, GSTIN not blocked: a rep must call back |
| `handoff_owner_id` | Saathi | rep ID | Who calls back: the field rep who referred the lead, else the territory rep |
| `handoff_summary` | Saathi | one line | Business, segment and city · bundle viewed and price · drop-off stage and reason · score · referrer |
| `activated_date` | Back office | `YYYY-MM-DD` | Go-live date. **Rewards are earned only once this is set and `stage` = `Activated`** |
| `churned` | Back office | `Y` / `N` | `Y` if the customer left within the hold period. Their rewards become void |

## New columns: consent record and PROMISE layer (2026-11-04)

| Column | Written by | Values | Meaning |
|---|---|---|---|
| `consent_registry_lookup` | Saathi (`consent_manager`) | `TRUE` / `FALSE` | The owner said yes to looking up their GSTIN / Udyam number. FALSE = never answered or said no |
| `consent_kyc_verification` | Saathi (`consent_manager`) | `TRUE` / `FALSE` | Yes to verification for activation: reading shared documents and checking the signatory's ID |
| `consent_marketing` | Saathi (`consent_manager`) | `TRUE` / `FALSE` | Yes to offers on WhatsApp. **Never send offers to a row where this is FALSE** |
| `consent_version` | Saathi | e.g. `2026-11-04` | Version of the consent text the owner saw (`CONSENT_RULES.version` in `_build/consent_rules.js`) |
| `consent_updated_at` | Saathi | ISO time (UTC) | When the owner last gave or withdrew a consent. The full history stays in the conversation's `consent_record_json` |
| `order_id` | Saathi | e.g. `UD-0001` | Only for rows that come from the Order tracker (reschedule, support, AirFiber bridge, retention) |
| `chase_count` | Saathi (`order_status`) | number | How many times the owner asked about the order unprompted. Saathi messages every stage, so each chase is a miss |
| `guarantee_status` | Saathi (`order_status`) | `on_track` · `met` · `breached` | The activation guarantee shown on the order's quote (72 hours inside the scope, a firm number of days otherwise). `breached` = month one is credited automatically |

A row with `stage` = `retention` means the owner chased a second time: call them first, the same day. Tracker
stages (`retention`, `reschedule`, `support`, `airfiber_bridge`) count as `KYC complete` in the funnel: the
order exists but isn't live yet. If the owner withdraws a consent later in the chat, Saathi says so, but the row
isn't updated automatically in this prototype: update the three `consent_*` columns by hand (see CODE_REVIEW.md).

## How rewards are worked out (not stored: the page computes them)

All rates are in `REACH_RATES` in `_build/reach_rules.js`. Shares are of the customer's first monthly bill
(`monthly_total`), capped:

| Who | Reward | Rate | Cap |
|---|---|---|---|
| CA partner | Commission | 100% of the first bill | ₹10,000 |
| Customer (micro-agent) | Bill credit | 50% | ₹3,000 |
| Field rep who referred a lead Saathi closed | Referral incentive | 25% (not paid if the rep closed it in person) | ₹5,000 |
| Field rep who owns the territory, for a digital (`closed_by` = `saathi`) activation | Territory credit + 1 activation toward target | 10% (not paid twice to a rep already earning the referral incentive) | ₹2,000 |

The status runs **held** (first 90 days after `activated_date`) → **payable**. It is **void** if `churned` = `Y`.
The 90-day hold exists because referred customers churned the most in the case data (24.6% within 6 months,
against 15.2% overall).
