# Accel Saathi: Voiceflow chatbot kit

Accel Saathi is a chatbot that helps a small Indian business owner pick a telecom and digital bundle, see one
clear monthly price, verify their business without paperwork and track their order, in their own language. It is
the working prototype for the Airtel SYNC 2026 case "Project Udyam Digital", built in Voiceflow (no code) plus
eleven small JavaScript function tools that hold all the business rules, so the AI never invents a price.
Accel Telecom is the case's fictional operator, and every business, identifier and price here is synthetic.

> New here? Read [CODING_STANDARDS.md](CODING_STANDARDS.md) before changing anything. Known problems and
> planned work are in [CODE_REVIEW.md](CODE_REVIEW.md). To build the bot in Voiceflow, follow
> [START_HERE.md](START_HERE.md).

## Folders

| Path | Purpose |
|---|---|
| `1_agent_global_prompt.txt` | The agent's main instructions: identity, language, hard rules, routing between playbooks |
| `2_playbooks/` | One file per Voiceflow playbook (GSTIN-first onboarding, advisor, verification, callback, tracker), ready to paste |
| `3_function_tools/` | **Generated.** The function tools pasted into Voiceflow. Never edit by hand: rebuild from `_build/` |
| `3_function_tools/TOOL_SETUP.md` | The input and output variables to declare for each function tool in Voiceflow |
| `4_knowledge_base/` | Files uploaded to Voiceflow's knowledge base (catalogue, bundle rules, FAQ, privacy notice). The sizing-rules and activation-promise sections of `saathi_bundles_and_rules.txt` are **generated** from `price_bundle` by `_build/kb_sizing_rules.mjs` and `_build/kb_promise_rules.mjs` |
| `5_google_sheet/` | Header row of the back-office lead sheet that the callback playbook writes to |
| `6_tests/` | Automated function tests (`npm test`), browser checks of the certificate reader (`browser_kyc_check.py`) and the back office (`browser_back_office_check.py`), the onboarding and Udyam-entry measurement (`measure_onboarding.mjs`), the activation-promise measurement (`measure_promise_scope.mjs`), the hand-run conversation tests for Voiceflow (`test_conversations.md`) and the sheet to record their results (`conversation_results.csv`, filled by hand; a test checks it lists every conversation) |
| `7_demo_site/` | Demo web page that hosts the Voiceflow chat widget (passes `?ref=` referral codes to Saathi) and the Smart KYC fallback (consent screen + GST certificate reader). `consent_rules.js`, `certificate_reader.js`, `onboard_from_gstin.js`, `sample_certificates.js` and `sample_certificates/` are generated |
| `8_back_office/` | Back-office page: unclosed leads with filters, rep-callback summaries, rewards earned on activation. `reach_rules.js` and `sample_leads.js` are generated |
| `_build/` | **Source code**: function-tool templates and `gen_kit.py`, which injects the case data into them |

## Where each feature lives

| Feature | Logic | Conversation |
|---|---|---|
| REACH: referral codes (CA partners, customers, field reps), territory credit, hot-lead handoff, rewards on activation (rates in `REACH_RATES`) | `_build/reach_rules.js` → embedded in `_build/reach_tag_lead.js` and `8_back_office/reach_rules.js` | playbooks `C_…` (tags every lead) and `D_…` (customer's own code) |
| Back-office view of unclosed leads | `8_back_office/index.html` (+ `_build/build_back_office_sample.mjs` for the SIMULATED sample) | reads the Google Sheet (`5_google_sheet/COLUMNS.md`) |
| Bill-swap calculator: today's bills vs the matching Accel bundle, savings or an honest "costs more" | `_build/bill_swap.js` (+ embedded `price_bundle`) | playbooks `0_…` and `A_…` ("Compare with my bills") |
| Digital-readiness score 0–100, top 3 gaps, add-ons with the new score (rules in one `READINESS_RULES` object) | `_build/readiness_score.js` | playbook `A_…` (start of discovery), `0_…` ("Check my digital score") |
| Zero-question onboarding from a GSTIN (category, scale, pre-approval, greeting in EN/HI/KN). The first quote is the base bundle for the smallest business in the segment, extras are switched-off add-ons, and every assumption is stated; `6_tests/measure_onboarding.mjs` measures it on the whole registry | `_build/onboard_from_gstin.js` (+ `gen_kit.py` embeds `price_bundle` into it) | `2_playbooks/0_gstin_first_onboarding.txt` |
| Reading a GSTIN from the owner's message ("my gstin is …", labels, spaces, lowercase), the format/state/checksum checks, masking, and a friendly message for every status code in EN/HI/KN | `_build/gstin_input.js` → embedded in `onboard_from_gstin`, `verify_gstin`, `verify_gstin_lite`, the certificate reader and `7_demo_site/gstin_input.js` (one implementation; a test checks every copy) | global prompt ("Passing a GSTIN to a tool"), playbooks `0_…` and `B_…` |
| Bundle recommendation and price | `_build/price_bundle.js` | `2_playbooks/A_bundle_advisor.txt` |
| Activation guarantee decided at quote time: "Connected in 72 hours, guaranteed" only inside `GUARANTEE_SCOPE` (tier-1 city, ≤ 10 people, one site, fibre ≤ 300 Mbps or AirFiber, AirFiber coverage), a firm number of days from the case data for every other order; the tracker enforces the promise the card showed (STRATEGY §11) | `_build/price_bundle.js` (rule) + `_build/gen_kit.py` (`compute_activation_promise_data`) → `_build/promise_rules.js` / `order_status.js` (deadline from the quote) | the quote card itself; global prompt hard rule 4, playbooks `0_…`, `A_…`, `D_…` |
| Udyam entry: an owner without a GSTIN starts with the Udyam number; zero-question proposal from the Udyam registry, same consent gate, prices from `price_bundle` (STRATEGY §12) | `_build/onboard_from_gstin.js` + the shared reader `_build/udyam_input.js` (also in `verify_udyam`) | `2_playbooks/0_gstin_first_onboarding.txt` ("If not, your Udyam number works too") |
| GSTIN check (format, checksum, registry, status) | `_build/verify_gstin.js` | `2_playbooks/B_business_verification.txt` |
| Udyam check (optional) | `_build/verify_udyam.js` | `2_playbooks/B_business_verification.txt` |
| Lead score, reference ID, back-office row | `_build/register_lead.js` | `2_playbooks/C_callback_lead_capture.txt` |
| PROMISE: 72-hour guarantee (deadline, breach → month one credited from `price_bundle`), a proactive message per stage, chase count with retention flag on the 2nd chase (rules in `PROMISE_RULES`) | `_build/promise_rules.js` → embedded in `_build/order_status.js` | `2_playbooks/D_order_tracker.txt` |
| PROMISE: downtime auto-credit by a documented rule, message sent before the customer complains | `_build/promise_rules.js` → embedded in `_build/downtime_credit.js` | `2_playbooks/D_order_tracker.txt` ("Internet down") |
| Consent per purpose (registry lookup, KYC verification, marketing), EN/HI/KN, withdrawable, recorded with history | `_build/consent_rules.js` → embedded in `_build/consent_manager.js` and `7_demo_site/consent_rules.js` | global prompt, playbooks `0_…` and `B_…`; demo page |
| Smart KYC fallback: read a GST certificate photo (Tesseract.js in the browser), then the same validation as zero-question onboarding | `_build/certificate_reader.js` → `7_demo_site/certificate_reader.js`; `7_demo_site/onboard_from_gstin.js` is the built onboarding function | `7_demo_site/index.html` ("Lookup didn't work?"); playbooks `0_…` and `B_…` point to it |
| Product facts, FAQ, privacy answers | `4_knowledge_base/` | answered by the agent |

## Set up

Requirements: **Node.js 18+**. **Python 3.10+** with `pandas`, `numpy`, `scikit-learn` and `Pillow` is needed
only to rebuild the function tools and the sample certificates from the case data. Ruff is used for Python
linting. Playwright is needed only for the optional browser check.

```bash
npm install            # installs the dev tools (ESLint, Prettier)
```

## Run the tests

```bash
npm test               # runs 6_tests/run_function_tests.mjs; all 308 tests must pass
```

Browser check of the Smart KYC fallback with real OCR (needs Playwright, Chromium and an internet connection for
Tesseract.js): `python 6_tests/browser_kyc_check.py . <folder for screenshots>` (43 checks; each sample certificate file is read by OCR). The back-office page:
`python 6_tests/browser_back_office_check.py . <folder for screenshots>` (12 checks, including WCAG contrast and
the 375 px layout).

Mutation testing (Stryker; about half an hour on 4 cores): `npm run test:mutation`. It changes the generated tools
one small step at a time, runs the suite against each change, and prints a score per tool
(`6_tests/mutation/summarise.mjs`; full report in `reports/mutation/mutation.html`). Which lines are mutated, and
why, is in `6_tests/mutation/scope.mjs`.

The conversation tests in `6_tests/test_conversations.md` are run by hand in Voiceflow's test panel.

## Lint and format

```bash
npm run lint           # ESLint on _build/ and 6_tests/
npm run format         # Prettier on _build/, 6_tests/, 7_demo_site/
ruff check _build      # Python lint
ruff format _build     # Python format
```

## Rebuild the function tools (after editing anything in `_build/`)

```bash
python _build/gen_kit.py "<path to YTL_TrackA_Udyam_Digital_Data>" .
npm test
```

The case data pack (`YTL_TrackA_Udyam_Digital_Data`) is not part of this folder. It comes from the case
organisers.

## Run the back-office page

Open `8_back_office/index.html` in a browser. It loads the SIMULATED sample, built from the 5,000 case leads by
`gen_kit.py`. To see your real leads, paste the Google Sheet's published CSV link, or choose a CSV file.

## Run the demo page

Open `7_demo_site/index.html` in a browser. Until you paste your Voiceflow widget snippet into it (see the comment
near the end of the file), the "Chat with Saathi" button shows a "not connected" note. The Smart KYC section
(consent screen + GST certificate reader) works without Voiceflow; it loads Tesseract.js from the jsDelivr CDN the
first time a certificate is read, so it needs an internet connection. To serve it locally instead:

```bash
python -m http.server 8000 --directory 7_demo_site     # then open http://localhost:8000
```

## Build the chatbot in Voiceflow

See [START_HERE.md](START_HERE.md): create the project, paste the global prompt, upload the knowledge base, add
the eleven function tools, create the five playbooks, connect the Google Sheet, test, publish.
