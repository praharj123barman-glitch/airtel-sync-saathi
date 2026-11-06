# Accel Saathi in Voiceflow: build guide

This kit turns the deck's Saathi design into a working chatbot. It follows the method from the YouTube course
you saved (`Downloads/chatbot.txt`): **Voiceflow, no code**, with a global prompt, a knowledge base, playbooks with
variables, function tools, Google Sheets lead capture, buttons and a website widget.

One deliberate change from the course: in the course, the AI reads prices from the knowledge base. Here, every
bundle and price comes from a **function tool**, `price_bundle`, so the AI can't invent a number. That is the
deck's "rules decide, GenAI explains" claim, made real.

**No API key needed.** Voiceflow runs the AI model (Claude or GPT) on its own free credits.

---

## Before you start (≈ 15 min)

**Time.** Building takes **about 4 hours** of focused work; testing all 51 conversations takes **about 3 more
hours**. Do it in two sittings: build (steps 1–9) and run the top-5 tests, then the full test sheet the next day.

| Step | Time |
|---|---|
| Before you start | 15 min |
| 1–3 Project, global prompt, knowledge base | 25 min (+ the knowledge base's own processing) |
| 4 Variables and the referral code | 10 min |
| 5 Google Sheet | 10 min |
| 6 Function tools (11 tools, 106 inputs, 180 outputs) | 2 h 15 min |
| 7–8 Playbooks and agent-level tools | 35 min |
| 9 The top-5 tests | 25 min |
| 10 Publish and the widget | 10 min |
| Full test sheet (51 conversations, 3–4 min each, plus fixes) | ≈ 3 h |

**Accounts.**
- A **Voiceflow** account (free plan). Check the free credits are available; testing 51 conversations uses some.
- A **Google** account for the back-office sheet, the same one you will connect in Voiceflow.
- Optional: Vercel, only to put the demo page online at the end.

**Make sure the files are current.** Run `npm test` in this folder: it must say **308 passed, 0 failed**. If you
rebuilt anything since your last Voiceflow session, the function tools and `4_knowledge_base/saathi_bundles_and_rules.txt`
changed: paste and upload the new versions.

**Have these open** (a second screen helps):
1. This file, at "Tool reference" below: it is the exact list of names to type.
2. `1_agent_global_prompt.txt` and the five files in `2_playbooks/`.
3. The `3_function_tools/` folder (you paste each `.js` file from here). `TOOL_SETUP.md` has the longer
   explanations if a tool behaves unexpectedly.
4. `5_google_sheet/back_office_leads_template.csv` (the header row).
5. `6_tests/conversation_results.csv` in Excel or Google Sheets, to tick off the tests.

Tip: open each `.js` file in a plain editor (VS Code or Notepad), press Ctrl+A, Ctrl+C. Don't copy from a browser
preview: it can change quotes and lose characters.

---

## What's in the folder

| Folder | What it is | Where it goes in Voiceflow |
|---|---|---|
| `1_agent_global_prompt.txt` | Saathi's identity, language rules, hard rules (including the activation guarantee), routing | Agent → **Instructions** |
| `2_playbooks/` | 5 playbooks: GSTIN-first onboarding (the start; also takes a Udyam number), Bundle advisor, Business verification, Callback & lead capture, Order tracker | **Playbooks** |
| `3_function_tools/` | 12 files for **11 tools** (`verify_gstin_lite.js` is a smaller stand-in for `verify_gstin.js`, never both) + `TOOL_SETUP.md` | **Tools → Function** |
| `4_knowledge_base/` | Product catalogue (CSV table), bundles & rules (with the generated sizing and activation-guarantee sections), FAQ, privacy notice | **Knowledge base** |
| `5_google_sheet/` | Header row (45 columns) and the column guide for the back-office lead sheet | Google Sheets |
| `6_tests/` | 51 test conversations (`test_conversations.md`) and the sheet to record them (`conversation_results.csv`), the local test runner (308 checks, all passing) and the browser checks | Test panel |
| `7_demo_site/` | Demo page that hosts the chat widget, plus the Smart KYC fallback (consent screen + GST certificate reader with 3 SAMPLE certificates) | Widget snippet; the KYC section works on its own |
| `8_back_office/` | Back-office page: unclosed leads, rep callbacks, rewards (reads the Google Sheet) | Open in a browser |

---

## Step-by-step (in this order: each step needs the one before it)

### 1. Create the project (≈ 5 min)
1. Go to voiceflow.com and sign up (free plan, free credits).
2. **Projects → New project → Start from scratch**. Name it **Accel Saathi**. Type: **Chat**.
3. Open the agent's model settings and pick a **Claude** model (as in the course). It runs on Voiceflow credits.

### 2. Global prompt (≈ 5 min)
1. Open the agent's **Instructions** and delete Voiceflow's default text (the course does this too).
2. Paste everything from `1_agent_global_prompt.txt` **below the dashed line** (not the "PASTE INTO" line above it).

### 3. Knowledge base (≈ 15 min, mostly waiting)
1. Left sidebar → **Knowledge base → Add data source**.
2. **Table**: upload `4_knowledge_base/accel_product_catalogue.csv` (each product becomes one chunk). Use this file,
   not the case pack's `product_catalogue.csv`: its columns are written for the AI.
3. **Docs**: upload `saathi_bundles_and_rules.txt`, `saathi_faq.txt` and `saathi_privacy_notice.txt`. For the FAQ,
   tick **FAQ optimization** if it's offered.
4. Wait until all four show as ready.
5. Upload nothing else. `STRATEGY.md`, `CODE_REVIEW.md`, `TOOL_SETUP.md` and the playbooks are for people, not for
   Saathi's answers.

`saathi_bundles_and_rules.txt` holds two sections generated from the pricing code (bundle sizing, and **ACTIVATION
PROMISE**: who gets "Connected in 72 hours" and the firm days for everyone else). After any rebuild, delete it in
Voiceflow and upload it again.

### 4. Variables and the referral code (≈ 10 min)
1. Create a variable `referral_code`. At the very start of the conversation (an initialization workflow), add a
   Code step: `referral_code = (last_event && last_event.payload && last_event.payload.referral_code) || "";`
2. The playbooks pass these values between steps. Whenever Voiceflow asks which variable a tool output or a
   collected answer goes to, create one with **exactly** this name (lower case, underscores):
   - consent: `consent_record_json`, `consent_registry_lookup`, `consent_kyc_verification`, `consent_marketing`,
     `consent_version`, `consent_updated_at`
   - onboarding and quote: `entry_type`, `gstin_masked`, `udyam_masked`, `gstin_status`, `gst_city`, `gst_state`,
     `segment_code`, `pricing_inputs_json`, `bundle_name`, `monthly_total`, `setup_total`, `contract_months`,
     `install_days`, `promise_type`, `promise_hours`, `promise_days`, `promise_text`, `promise_reasons`,
     `pre_approved`, `pre_approval_reason`
   - conversation: `quote_accepted`, `has_gstin`, `has_udyam`, `stage`, `reason_not_closed`, `contact_name`,
     `contact_phone`, `callback_time`, `order_id`, `chase_count`, `guarantee_status`
   - lead: `ref_id`, `lead_score`, `priority`, `expected_live_date`, `created_at`, and the REACH outputs listed under
     `reach_tag_lead` below (they go to the sheet)

### 5. Google Sheet for the back office (≈ 10 min)
Done before the playbooks, because Playbook C needs the sheet connected.
1. Create a Google Sheet called **Saathi leads**. Paste the header row from
   `5_google_sheet/back_office_leads_template.csv` into row 1 (45 columns; check the last one is `churned`). The
   columns are explained in `5_google_sheet/COLUMNS.md`. Don't rename, reorder or translate the headers.
2. Optional, for the demo: conditional formatting so `priority = Hot` turns red. This sheet is the case's stretch
   goal, "a back-office view of leads the advisor could not close, with a propensity score".
3. In Voiceflow: **Tools → Integrations → Google Sheets → connect your Google account → Add row** → pick the sheet.

### 6. Function tools (≈ 2 h 15 min)
For each tool in the **Tool reference** below: **Tools → New tool → Function** → name it exactly as given → paste the
whole file → add every input and output with the exact names → copy the tool description from `TOOL_SETUP.md` →
press **Run** with the sample input and compare with the expected result. Don't go on until the Run matches.
Do them in the order listed: `price_bundle` first (it is the simplest check that pasting works).

### 7. Playbooks (≈ 30 min)
For each file in `2_playbooks/`: **Playbooks → New playbook**. Copy the **Name** and **Trigger** from the top of the
file, paste everything **below the dashed line** into **Instructions**, then attach the tools:

| Playbook (create in this order) | Tools to attach | Required variables |
|---|---|---|
| 0 · GSTIN-first onboarding (the default start; also Udyam entry) | consent_manager, onboard_from_gstin, price_bundle, bill_swap, readiness_score, Buttons | none |
| A · Bundle advisor | price_bundle, readiness_score, bill_swap, Buttons | none |
| B · Business verification | consent_manager, verify_gstin, verify_udyam, Buttons | quote_accepted |
| C · Callback & lead capture | register_lead, reach_tag_lead, Google Sheets: Add row, Buttons | none |
| D · Order tracker | order_status, downtime_credit, reach_tag_lead, Buttons | none |

### 8. Agent-level tools (≈ 5 min)
1. Turn on the **Buttons** system tool so Saathi can show quick replies.
2. Attach `consent_manager` to the **agent** as well: an owner can withdraw consent in any playbook.

### 9. Test the top five (≈ 25 min)
Open `6_tests/conversation_results.csv`. Run rows 1–5 first in the test panel: GSTIN-first in English, Hindi and
Kannada, a cancelled GSTIN, and Udyam entry. Start a **new conversation** for each row. After each one, open
**Transcripts**, check which tools ran with which inputs, and write pass/fail and notes in the sheet. When something
is off, fix the playbook wording first and change the model last (Voiceflow's advice and the course's). Then run the
rest of the sheet in order.

### 10. Publish and share (≈ 10 min)
1. **Publish**. Then:
   - **Share prototype link**: the quickest way to send the bot to the judges, as in the course.
   - **Widget tab** → copy the installation code → paste it into `7_demo_site/index.html` where the comment says,
     and add the one `launch:` line shown in that comment (it passes `?ref=` referral codes to Saathi).
2. Open `index.html` in a browser. The "Chat with Saathi" button opens the widget. A referral link is the page
   address plus `?ref=<code>`, e.g. `…/index.html?ref=CA-7K2P9-X`; codes for the demo's partners, reps and customers
   are in the back-office sample.
3. Back office: open `8_back_office/index.html`. It starts with the SIMULATED sample. To see real leads, publish the
   sheet (File → Share → Publish to web → CSV) and paste the link into the page.
4. Optional: deploy the demo page to Vercel for a public link (`vercel` from the `7_demo_site` folder).

---

## Tool reference (exact names; a test checks this list against the code)

11 tools from 12 files. Inputs reach a tool as text, whatever their type: write numbers as digits and yes/no as
"yes" or "no". "Fill" says when the playbook passes it: **Required** (the tool can't work without it), **Usually**,
**Optional**, or **Leave empty**. Outputs are what the tool returns every time (empty when not relevant), with
their type. Declare all of them: the playbooks read many and the sheet row uses most.

#### 1. `price_bundle`

- **Voiceflow tool name:** `price_bundle`
- **Paste:** `3_function_tools/price_bundle.js`
- **Called by:** Playbook 0 (add-ons, "We're bigger") and Playbook A (every quote and change)
- **Inputs (22)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `business_type` | text | Usually | Type of business in a few words: "kirana store", "dental clinic", "restaurant chain" |
| `segment` | one of: micro, prof, multi, mfg | Optional | Only if known (onboarding's segment_code) |
| `city` | text | Usually | City name, e.g. "Delhi". Decides the city tier and the 72-hour scope |
| `city_tier` | number: 1 or 2 | Optional | Only when the city is unknown |
| `employees` | number (digits) | Usually | People working there |
| `sites` | number (digits) | Usually | Locations or branches (1 for one shop) |
| `has_gstin` | yes/no | Usually | Whether the business has a GST registration |
| `needs` | text: comma-separated keywords | Optional | From: failover, email, storage, security, firewall, pos, cctv, wifi, whatsapp, sms, website, telephony, tollfree, staticip, iot, fleet, sdwan, leased, highspeed |
| `fibre_available` | yes/no | Optional | "no" if there is no fibre at the location or they want it working within 2 days |
| `airfiber_available` | yes/no | Optional | "no" if 5G AirFiber does not work at the address (takes the order out of the 72-hour guarantee) |
| `budget` | number (rupees) | Optional | Only if the owner asked for cheaper |
| `add` | text | Optional | Items to add, comma-separated, with a quantity if given: "cctv 4, static ip" |
| `remove` | text | Optional | Items to remove, comma-separated: "cloud backup" |
| `contract_months` | number: 12 or 24 | Optional | Only if the owner asks for a longer contract |
| `lines` | number (digits) | Optional | Only if the owner states an exact number of mobile lines |
| `email_users` | number (digits) | Optional | Only if stated |
| `cameras` | number (digits) | Optional | Only if stated |
| `counters` | number (digits) | Optional | Only if stated |
| `machines` | number (digits) | Optional | Only if stated |
| `vehicles` | number (digits) | Optional | Only if stated |
| `lang` | one of: en, hi | Optional | "hi" for Hindi/Hinglish chats, otherwise "en" (Kannada falls back to English here) |
| `show_card` | yes/no | Leave empty | Empty = the tool shows its message itself. "no" hides it |

- **Outputs (17):** `bundle_name` (text), `monthly_total` (number), `setup_total` (number), `contract_months` (number), `install_days` (number), `quote_text` (text), `why_text` (text), `blocked_text` (text), `budget_note` (text), `items_json` (text), `segment_code` (text), `promise_type` (text), `promise_hours` (number), `promise_days` (number), `promise_text` (text), `promise_reasons` (text), `error` (text)
- **Run to check:** `business_type` Diagnostic lab · `city` Delhi · `employees` 16 · `has_gstin` yes · `needs` failover, email, storage, security · `lang` hi → Office Pro · ₹6,138/माह; `promise_type` firm_date, `promise_days` 7

#### 2. `verify_gstin`

- **Voiceflow tool name:** `verify_gstin`
- **Paste:** `3_function_tools/verify_gstin.js` (≈ 270 KB). **Only if** the editor refuses it: `verify_gstin_lite.js` instead, under the SAME tool name `verify_gstin`. Never add both
- **Called by:** Playbook B (Business verification)
- **Inputs (4)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `gstin` | text | Required | The owner's whole message containing the GSTIN, unchanged |
| `consent_given` | yes/no | Required | "yes" only when consent_registry_lookup is true; otherwise nothing is looked up |
| `business_name` | text | Optional | The name the owner gave, for the name match |
| `lang` | one of: en, hi | Optional | "hi" for Hindi/Hinglish chats, otherwise "en" (Kannada falls back to English here) |

- **Outputs (10):** `gstin_ok` (true/false), `gstin_status` (text), `gstin_masked` (text), `legal_name` (text), `trade_name` (text), `gst_state` (text), `constitution` (text), `name_match` (text), `kyc_message` (text), `error` (text)
- **Run to check:** `gstin` 07PUTXM1153M1Z9 · `consent_given` yes → `gstin_ok` true, `gstin_status` Active, `gstin_masked` 07PUT•••••••1Z9 (lite: try 29OKAXP4077P1ZL → Cancelled)

#### 3. `verify_udyam`

- **Voiceflow tool name:** `verify_udyam`
- **Paste:** `3_function_tools/verify_udyam.js`
- **Called by:** Playbook B (optional Udyam step)
- **Inputs (3)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `udyam_number` | text | Required | The owner's message containing the Udyam number, unchanged |
| `business_name` | text | Optional | The name the owner gave, for the name match |
| `lang` | one of: en, hi | Optional | "hi" for Hindi/Hinglish chats, otherwise "en" (Kannada falls back to English here) |

- **Outputs (9):** `udyam_ok` (true/false), `udyam_masked` (text), `enterprise_name` (text), `enterprise_type` (text), `major_activity` (text), `udyam_city` (text), `name_match` (text), `kyc_message` (text), `error` (text)
- **Run to check:** `udyam_number` UDYAM-DL-00-7084760 → `udyam_ok` true, `udyam_masked` UDYAM-DL-••-•••4760, Metro Diagnostics Pvt Ltd

#### 4. `register_lead`

- **Voiceflow tool name:** `register_lead`
- **Paste:** `3_function_tools/register_lead.js`
- **Called by:** Playbook C (Callback & lead capture), right before the Google Sheets row
- **Inputs (14)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `segment` | one of: micro, prof, multi, mfg | Usually | segment_code |
| `business_type` | text | Usually | As collected |
| `city` | text | Usually | gst_city or the advisor's city |
| `language` | text: a language name | Optional | The owner's language in English: "Hindi", "Kannada", "English" |
| `employees` | number (digits) | Optional | If known |
| `sites` | number (digits) | Optional | If known |
| `has_gstin` | yes/no | Usually | From the conversation |
| `has_udyam` | yes/no | Optional | "yes" when the owner started with a Udyam number |
| `current_internet` | text | Optional | If mentioned |
| `current_provider` | text | Optional | If mentioned |
| `contact_role` | text | Optional | If mentioned ("Owner", "Manager") |
| `monthly_spend` | number (rupees) | Optional | Today's telecom spend, if mentioned |
| `needs` | text: comma-separated keywords | Optional | Same keywords as price_bundle |
| `install_days` | number (digits) | Optional | install_days from the quote (for the go-live date) |

There is **no** `stage` or lead-source input: the score uses business attributes only. The stage goes to `reach_tag_lead` and the sheet.

- **Outputs (7):** `ref_id` (text), `lead_score` (number), `priority` (text), `activation_probability` (number), `expected_live_date` (text), `created_at` (text), `error` (text)
- **Run to check:** `segment` prof · `city` Delhi · `employees` 16 · `has_gstin` yes · `install_days` 5 → `priority` Hot, `lead_score` 85, a `ref_id` like SA-XXXXXX

#### 5. `order_status`

- **Voiceflow tool name:** `order_status`
- **Paste:** `3_function_tools/order_status.js`
- **Called by:** Playbook D (Order tracker)
- **Inputs (4)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `order_id` | text | Required | The order number, e.g. UD-0068 |
| `lang` | one of: en, hi, kn | Optional | "hi" Hindi/Hinglish, "kn" Kannada, otherwise "en" |
| `is_chase` | yes/no | Usually | "yes" if the owner asked about the order on their own |
| `previous_chases` | number (digits) | Optional | chase_count from an earlier call in this conversation; empty the first time |

- **Outputs (19):** `order_found` (true/false), `order_stage` (text), `next_step` (text), `tracker_text` (text), `is_demo` (true/false), `promise_type` (text), `promise_hours` (number), `order_confirmed_at` (text), `guarantee_deadline` (text), `hours_to_deadline` (number), `guarantee_status` (text), `connected_at` (text), `monthly_total` (number), `month_one_credit` (number), `proactive_messages_json` (text), `next_proactive_message` (text), `chase_count` (number), `retention_flag` (true/false), `error` (text)
- **Run to check:** `order_id` UD-0001 · `is_chase` yes · `previous_chases` 1 → `guarantee_status` breached, `promise_type` firm_date (10 days), `month_one_credit` 7185, `retention_flag` true

#### 6. `onboard_from_gstin`

- **Voiceflow tool name:** `onboard_from_gstin`
- **Paste:** `3_function_tools/onboard_from_gstin.js` (≈ 490 KB: the biggest; see Common mistakes)
- **Called by:** Playbook 0 (GSTIN-first onboarding, the default start), for a GSTIN or a Udyam number
- **Inputs (8)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `gstin` | text | Required (or udyam_number) | The owner's whole message containing the GSTIN, unchanged |
| `udyam_number` | text | Required (or gstin) | Only when the owner has NO GSTIN: their message with the Udyam number. Leave gstin empty |
| `consent_given` | yes/no | Required | "yes" only when consent_registry_lookup is true |
| `lang` | one of: en, hi, kn | Optional | "hi" Hindi/Hinglish, "kn" Kannada, otherwise "en" |
| `answer_business_type` | text | Optional | Second call only: the owner's answer to the business-type question |
| `answer_sites` | text | Optional | Second call only: the answer to the locations question ("1", "2", "3–5", "6–10", "10+") |
| `as_of_date` | text: YYYY-MM-DD | Leave empty | Tests only: fixes "today" |
| `show_card` | yes/no | Leave empty | Empty = the tool shows its message itself. "no" hides it |

- **Outputs (45):** `entry_type` (text), `gstin_valid` (true/false), `gstin_status` (text), `gstin_masked` (text), `udyam_valid` (true/false), `udyam_status` (text), `udyam_masked` (text), `is_blocked` (true/false), `next_action` (text), `business_name` (text), `gst_city` (text), `gst_state` (text), `city_tier` (number), `constitution` (text), `registration_date` (text), `registration_age_years` (number), `business_category` (text), `category_label` (text), `segment_code` (text), `segment_confidence` (number), `evidence_fields` (text), `assumptions` (text), `assumptions_json` (text), `clarifying_question` (text), `question_type` (text), `question_options` (text), `pricing_inputs_json` (text), `bundle_name` (text), `monthly_total` (number), `setup_total` (number), `contract_months` (number), `install_days` (number), `promise_type` (text), `promise_hours` (number), `promise_days` (number), `promise_text` (text), `quote_text` (text), `why_text` (text), `blocked_text` (text), `items_json` (text), `suggested_addons_json` (text), `pre_approved` (true/false), `pre_approval_reason` (text), `greeting` (text), `error` (text)
- **Run to check:** `gstin` 07PUTXM1153M1Z9 · `consent_given` yes. Then `udyam_number` UDYAM-DL-00-0779845 · `consent_given` yes → `next_action` show_proposal, Office Pro ₹3,269, `promise_type` guaranteed_72h. Udyam: `entry_type` udyam, Dukaan Digital ₹1,298

#### 7. `bill_swap`

- **Voiceflow tool name:** `bill_swap`
- **Paste:** `3_function_tools/bill_swap.js`
- **Called by:** Playbooks 0 and A ("Compare with my bills")
- **Inputs (11)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `bills` | text: one bill per line | Required | "category | vendor | monthly amount", e.g. "Mobile | Jio | 3 x 799" |
| `business_context_json` | JSON text | Usually | pricing_inputs_json from onboard_from_gstin |
| `business_type` | text | Optional | Advisor path only (overrides the JSON) |
| `segment` | one of: micro, prof, multi, mfg | Optional | Advisor path only |
| `city` | text | Optional | Advisor path only |
| `employees` | number (digits) | Optional | Advisor path only |
| `sites` | number (digits) | Optional | Advisor path only |
| `has_gstin` | yes/no | Optional | Advisor path only |
| `fibre_available` | yes/no | Optional | Advisor path only, if the quote used it |
| `lang` | one of: en, hi, kn | Optional | "hi" Hindi/Hinglish, "kn" Kannada, otherwise "en" |
| `show_card` | yes/no | Leave empty | Empty = the tool shows its message itself. "no" hides it |

- **Outputs (22):** `next_action` (text), `bills_read` (number), `unreadable_lines` (text), `needs_confirmation` (true/false), `current_monthly_total` (number), `not_compared_monthly_total` (number), `not_compared_text` (text), `comparison_text` (text), `pricing_inputs_json` (text), `assumptions` (text), `accel_bundle_name` (text), `accel_monthly_total` (number), `accel_setup_total` (number), `accel_items_json` (text), `accel_quote_text` (text), `monthly_saving` (number), `yearly_saving` (number), `first_year_saving` (number), `is_accel_cheaper` (true/false), `extra_value_text` (text), `message` (text), `error` (text)
- **Run to check:** `bills` Broadband | Local ISP | ₹2,500 (new line) Mobile | Competitor A | 3 x 799 · `business_type` Clinic · `city` Delhi · `employees` 14 · `has_gstin` yes → `current_monthly_total` 4897, `accel_monthly_total` 3296, `monthly_saving` 1601

#### 8. `readiness_score`

- **Voiceflow tool name:** `readiness_score`
- **Paste:** `3_function_tools/readiness_score.js`
- **Called by:** Playbooks 0 and A ("Check my digital score", start of discovery)
- **Inputs (7)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `current_products` | text | Usually | What the business already uses, comma-separated ("none" is valid; empty → it asks) |
| `segment` | text | Usually | segment_code, business_category or the business type |
| `staff_count` | number (digits) | Optional | ONLY if the owner stated it |
| `sites` | number (digits) | Optional | If known |
| `has_gstin` | yes/no | Optional | If known |
| `lang` | one of: en, hi, kn | Optional | "hi" Hindi/Hinglish, "kn" Kannada, otherwise "en" |
| `show_card` | yes/no | Leave empty | Empty = the tool shows its message itself. "no" hides it |

- **Outputs (14):** `next_action` (text), `readiness_score` (number), `segment_used` (text), `segment_assumed` (true/false), `recognised_products` (text), `unrecognised_items` (text), `top_gaps` (text), `gaps_json` (text), `add_ons_json` (text), `add_on_path_text` (text), `score_after_add_ons` (number), `suggested_needs` (text), `message` (text), `error` (text)
- **Run to check:** `current_products` home broadband, 2 jio sims, gmail · `segment` prof · `staff_count` 12 → `readiness_score` 19, `score_after_add_ons` 65, `suggested_needs` security, failover, email

#### 9. `reach_tag_lead`

- **Voiceflow tool name:** `reach_tag_lead`
- **Paste:** `3_function_tools/reach_tag_lead.js`
- **Called by:** Playbook C (tag every lead, after register_lead) and Playbook D ("Refer a business", mode issue_code)
- **Inputs (21)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `mode` | one of: (empty), issue_code | Optional | Empty = tag a lead; "issue_code" = give a live customer their code |
| `referral_code` | text | Optional | The variable set at launch, or a code the owner typed |
| `city` | text | Usually | gst_city or the advisor's city |
| `gst_city` | text | Optional | Alternative to city (onboarding's name for it) |
| `state` | text | Optional | gst_state |
| `gst_state` | text | Optional | Alternative to state |
| `gstin_masked` | text | Optional | From onboarding or verify_gstin |
| `gstin_status` | text | Optional | From onboarding or verify_gstin |
| `lead_score` | number | Usually | From register_lead |
| `priority` | one of: Hot, Warm, Cold | Usually | From register_lead |
| `stage` | text | Usually | Where the conversation ended, e.g. "callback_requested", "proposal_shown", "retention" |
| `reason_not_closed` | text | Optional | Why it didn't close, in a few words |
| `business_name` | text | Optional | What the owner saw |
| `segment_code` | text | Optional | What the owner saw |
| `bundle_name` | text | Optional | What the owner saw |
| `monthly_total` | number | Optional | What the owner saw |
| `closed_by` | text | Leave empty | = "saathi" |
| `order_id` | text | Optional | Mode issue_code only: the live order, e.g. UD-0002 |
| `customer_id` | text | Optional | Mode issue_code only, instead of order_id |
| `lang` | one of: en, hi, kn | Optional | "hi" Hindi/Hinglish, "kn" Kannada, otherwise "en" |
| `show_card` | yes/no | Leave empty | Empty = the tool shows its message itself. "no" hides it |

- **Outputs (17):** `referral_code` (text), `referral_valid` (true/false), `referral_problem` (text), `referrer_type` (text), `referrer_id` (text), `territory_id` (text), `territory_label` (text), `territory_rep_id` (text), `territory_matched_by` (text), `closed_by` (text), `drop_off_stage` (text), `handoff_flag` (true/false), `handoff_owner_id` (text), `handoff_summary` (text), `owner_message` (text), `share_text` (text), `error` (text)
- **Run to check:** `city` Delhi · `priority` Hot · `stage` proposal_shown. Then `mode` issue_code · `order_id` UD-0002 → `territory_id` T-DEL, `territory_rep_id` REP-DEL, `handoff_flag` true. Issue code: a CU-… code

#### 10. `downtime_credit`

- **Voiceflow tool name:** `downtime_credit`
- **Paste:** `3_function_tools/downtime_credit.js`
- **Called by:** Playbook D ("internet is down", demo outages)
- **Inputs (4)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `order_id` | text | Required | The order number, e.g. UD-0002 |
| `outage_duration` | text | Required | As the owner said it: "3 hours", "3h 20m", "90 minutes", "2 घंटे 15 मिनट" |
| `lang` | one of: en, hi, kn | Optional | "hi" Hindi/Hinglish, "kn" Kannada, otherwise "en" |
| `show_card` | yes/no | Leave empty | Empty = the tool shows its message itself. "no" hides it |

- **Outputs (10):** `order_found` (true/false), `is_demo` (true/false), `is_live` (true/false), `outage_minutes` (number), `monthly_total` (number), `has_failover` (true/false), `credit_amount` (number), `credit_rule` (text), `message` (text), `error` (text)
- **Run to check:** `order_id` UD-0002 · `outage_duration` 3h 20m → `credit_amount` 73, `is_live` true

#### 11. `consent_manager`

- **Voiceflow tool name:** `consent_manager`
- **Paste:** `3_function_tools/consent_manager.js`
- **Called by:** Playbooks 0, B and C, AND the agent itself (withdrawals can come in any playbook): attach it at agent level too
- **Inputs (8)**, all sent as text by Voiceflow (the tool converts them):

| Input | Type | Fill | What to pass |
|---|---|---|---|
| `mode` | one of: show, record, withdraw, check | Usually | Empty = "show" |
| `lang` | one of: en, hi, kn | Optional | "hi" Hindi/Hinglish, "kn" Kannada, otherwise "en" |
| `consent_record_json` | JSON text | Usually | The record from the previous call; empty the first time. ALWAYS pass it back |
| `registry_lookup` | yes/no | Optional | Mode "record": as the owner answered; empty = not answered |
| `kyc_verification` | yes/no | Optional | Mode "record" |
| `marketing` | yes/no | Optional | Mode "record" |
| `purpose` | text | Optional | Mode "withdraw": the owner's words ("stop offers") |
| `show_card` | yes/no | Leave empty | Empty = the tool shows its message itself. "no" hides it |

- **Outputs (10):** `consent_screen_text` (text), `consent_options_json` (text), `consent_record_json` (text), `consent_registry_lookup` (true/false), `consent_kyc_verification` (true/false), `consent_marketing` (true/false), `consent_version` (text), `consent_updated_at` (text), `message` (text), `error` (text)
- **Run to check:** `mode` show · `lang` kn → The Kannada consent screen; `consent_registry_lookup` false

---

## Common mistakes (and how to spot them)

**Names and variables**
- **A name that's almost right.** `has_gstin` is not `hasGstin`, `has_GSTIN`, `has gstin` or `has_gstin ` (trailing
  space). A misspelt input is never filled, so the tool silently uses its default; a misspelt output never reaches
  the next step. Copy names from the Tool reference and check them in the Run panel.
- **An output not declared or not saved.** If `pricing_inputs_json` isn't saved, "Add CCTV" and "We're bigger"
  re-quote the wrong business. If `promise_type` isn't saved, Saathi can't tell 72 hours from a firm date. If
  `consent_record_json` isn't passed back into the next `consent_manager` call, the consent history is lost.
- **Two different variables for one thing**, e.g. `gstin_masked` from onboarding and `gstin_masked_2` from
  verification. Use the one name everywhere.
- **Sample values left in as defaults.** If an input's default is "07PUTXM1153M1Z9" or "yes", every owner gets it.
  Leave defaults empty. In particular `show_card` must be empty, or the owner sees no quote card.

**Pasting the tools**
- **Part of a big file pasted.** `onboard_from_gstin.js` is ≈ 490 KB and `verify_gstin.js` ≈ 270 KB. If the paste
  stops early, Run fails with something like "Unexpected end of input". Paste again from a plain editor, and check
  the last line in Voiceflow's editor is the same as the last line of the file in your own editor (for
  onboarding: `return UDYAM_INPUT_API;` then `})();`). If Voiceflow refuses
  the size, use `verify_gstin_lite.js` for verification; for onboarding there is no lite version yet (tell me).
- **Editing the code.** Keep the first line `export default async function main(args) {` and change nothing:
  every file is generated and tested as it is.
- **Both GSTIN tools added.** Add `verify_gstin.js` OR `verify_gstin_lite.js`, always named `verify_gstin`.
- **An old copy.** After a rebuild, seven tools change together. Check with Run: if `price_bundle` has no
  `promise_type` output or `onboard_from_gstin` has no `entry_type`, it's an old copy.
- **Missing required inputs.** `onboard_from_gstin` without `consent_given` = yes always answers `ask_consent` (a
  loop that looks like a bug). It also needs `gstin` OR `udyam_number`: a Udyam number goes in `udyam_number`, with
  `gstin` left empty.

**Knowledge base**
- The catalogue uploaded as a **Doc** instead of a **Table** (answers about products get vague), or the case pack's
  `product_catalogue.csv` instead of `4_knowledge_base/accel_product_catalogue.csv`.
- An old `saathi_bundles_and_rules.txt` left after a rebuild: Saathi may then quote an outdated guarantee.
- Internal documents uploaded (STRATEGY, CODE_REVIEW, playbooks): Saathi starts quoting internal figures to owners.
- Testing before all four sources show as ready.

**Playbooks and routing**
- **The header pasted into Instructions.** Paste only what is below the dashed line. Name and Trigger go in their
  own fields; a missing Trigger means the playbook never starts.
- **Playbook 0 isn't the start.** It must catch "Get my plan" and any GSTIN or Udyam number. If the advisor's
  questions come first, check Playbook 0's Trigger and the routing section of the global prompt.
- **A tool not attached to the playbook that calls it.** Most common: `reach_tag_lead` missing from D ("Refer a
  business" fails), `consent_manager` missing from B (verification asks for a GSTIN without consent) or from the
  agent (withdrawals fail mid-chat), Google Sheets missing from C (no row appears).
- **The Buttons tool off.** Consent then turns into free text and "accept all" answers slip in.
- **Testing in one long conversation.** Variables (consent, referral code, order chases) carry over. Start a new
  conversation for every row of the test sheet.
- **Changing the model first.** When a test fails, read the transcript, fix the playbook wording, test again.

**Google Sheet**
- A header renamed, translated or reordered, or a missing column (there are 45; `activated_date` and `churned` stay
  empty: the back office fills them). The Add row step maps by header name.
- A different Google account connected than the one that owns the sheet.

---

## How this covers the case's build challenge

| Case requirement | In this kit |
|---|---|
| **Advisor**: GenAI assistant asks about type, size, locations and tools; recommends from the catalogue and explains | GSTIN-first onboarding (zero questions for 73% of registry GSTINs; Udyam entry for owners without a GSTIN) + Playbook A + `price_bundle` (25 products, all eligibility rules) + `why_text` |
| **Quote and checkout**: one transparent monthly price, add-ons you can toggle | `price_bundle` card with its activation guarantee; add, remove and budget re-quotes; checkout is "Accept quote" |
| **Smart KYC**: extraction, validation, GSTIN/Udyam lookups, consent screen | `consent_manager` (three separate purposes, EN/HI/KN, withdrawable) · Playbook B: `verify_gstin` (format, checksum, registry, status, name match), `verify_udyam` · **Document extraction** on the demo page: Tesseract.js reads a GST certificate photo in the browser, then the same onboarding validation |
| **Tracker**: order status instead of calling support | Playbook D + `order_status`: the guarantee shown on the quote (72 hours in scope, a firm number of days otherwise) with automatic month-one credit, a proactive message per stage, chases counted (2nd → retention) · `downtime_credit` |
| Stretch: voice / WhatsApp front end | Voiceflow can publish to voice and WhatsApp channels (not set up in this kit) |
| Stretch: back-office view of unclosed leads | Google Sheet filled by Playbook C + `8_back_office/index.html` |
| Stretch: propensity score | `register_lead`: model trained on the 5,000 leads (AUC 0.71) |

**Honest gaps.** These are mocked or missing in this kit:
- **Document OCR** runs on the demo page, not inside the Voiceflow chat (the chat can't read images), and it
  reads GST certificates only; the case's 47 KYC images are not processed. The reader was checked on the 3
  generated SAMPLE certificates, not on real phone photos.
- **DigiLocker, e-Sign and UPI Autopay**: described in the chat but simulated.
- **Order tracker, proactive WhatsApp messages and outages**: 5 SIMULATED demo orders; the stage messages are
  shown in the tracker, not sent; an outage is typed in instead of coming from network monitoring.
- **5G AirFiber coverage** is SIMULATED (every city in the case data counts as covered).
- **Kannada**: greetings, consent and tracker texts are in Kannada; the quote card from `price_bundle` is in English.

---

## Rebuilding the functions
The functions embed the case data: the 25-product catalogue, 3,534 GSTINs, 2,723 Udyam records, the firm activation
days and the trained lead-score model. `_build/gen_kit.py` regenerates them from the case CSVs:

```
python _build/gen_kit.py "<path to YTL_TrackA_Udyam_Digital_Data>" .
npm test
```

After a rebuild, paste every changed tool into Voiceflow again (when in doubt, all of them) and re-upload
`4_knowledge_base/saathi_bundles_and_rules.txt`.
