# Code review against CODING_STANDARDS.md (2026-11-04)

Scope: everything in this folder. The rule for this pass was to fix only low-risk problems (naming, comments,
file headers, magic numbers moved into named constants) and **not change behaviour**.

How "no behaviour change" was checked: every function tool was run on 20,534 inputs before and after the cleanup.
The inputs were all 5,000 case leads with varied needs, budgets, add/remove requests and languages, every GSTIN and
Udyam record plus typos, and every demo order. All 20,534 outputs were identical, and `npm test` passed (31/31).

## Fixed in this pass

| # | Problem | Where | Fix |
|---|---|---|---|
| F1 | Cryptic names (`iv`, `P`, `C`, `emp`, `seg`, `gst`, `q`, `L`, `num`, `has`, `inr`, `toks`, `o`, `s`…) | all `_build/*.js` | Renamed to descriptive names (`inputVars`, `PRODUCTS_BY_ID`, `employeeCount`, `containsAnyKeyword`, `formatRupees`…) |
| F2 | Magic numbers (sizing ratios, thresholds, IST offset, score bands, mask lengths, state-code range, checksum base) | all `_build/*.js`, `gen_kit.py` | Moved to named CONFIG constants, each with a comment on what it is and where it came from |
| F3 | Magic product IDs (`"P09"`) and status strings in the logic | `price_bundle.js`, `verify_gstin.js` | `PRODUCT.FAILOVER_4G_5G`, `STATUS.CANCELLED`, … |
| F4 | User-facing text mixed into the logic | all function tools | Moved into one MESSAGES section per file, English and Hindi side by side |
| F5 | Missing or thin file headers and doc comments | all code files | Every file has a header; every `main()` and Python function has a doc comment with an example |
| F6 | Business rules without a "why" | `verify_gstin.js`, `price_bundle.js`, `order_status.js` | Linked to the case findings (22 dead-GSTIN activations, "price too high" drop-offs, churn vs status chases) |
| F7 | Simulated parts not labelled | registries, demo orders | Labelled SIMULATED in code comments |
| F8 | Catalogue fields `min`, `max`, `gst`, `oneOf` | `gen_kit.py` → `price_bundle.js` | `monthlyPriceFloorInRupees`, `monthlyPriceCeilingInRupees`, `requiresGstin`, `requiresOneOfProductIds`, … |
| F9 | `gen_kit.py` was one long script | `_build/gen_kit.py` | Split into small documented functions; `inject()` now fails loudly if a template loses its placeholder |
| F10 | Test names weren't sentences | `6_tests/run_function_tests.mjs` | e.g. "blocks activation when the GSTIN is cancelled"; header notes that the sample data is synthetic |
| F11 | No formatter or linter | project | Added Prettier, ESLint (with a rule that forbids imports in Voiceflow functions) and a Ruff config; everything is clean |
| F12 | ESLint `no-misleading-character-class` on the Devanagari name regex | `verify_gstin.js`, `verify_udyam.js` | Kept the regex (intended); disabled the rule on that line with a reason |
| F13 | No README or standards | project | Added `README.md`, `CODING_STANDARDS.md` and this file |

## Left for later (would change behaviour, or bigger than "low-risk")

Ordered by priority.

| # | Problem | Why it matters | Suggested fix |
|---|---|---|---|
| L1 | **Simulated steps are presented as real to the owner.** Playbook B tells the bot to say the DigiLocker/e-Sign "link is sent on WhatsApp". The order tracker shows demo orders and the FAQ describes UPI Autopay without a "demo" label. | Breaks the SIMULATED-label rule in user-facing output; a judge could be misled | **Fixed 2026-11-04 (PROMISE step):** playbook B now says the DigiLocker/e-Sign step is simulated and no link is sent; `order_status` and `downtime_credit` end every message with "(Demo order: simulated data.)"; the FAQ marks payment and WhatsApp updates as simulated |
| L2 | **Bug: adding a product by ID picks the wrong product.** `add: "P20 5"` strips the digits before matching, so "P20" becomes "P". Verified: it adds **Static IP ×5** instead of Endpoint Security ×5. | Wrong item and price in the quote when the agent passes product IDs | **Fixed 2026-11-07.** It was worse than noted: "P20" alone gave Static IP ×20, and a name with a number in it ("Business Postpaid 599") gave Postpaid 299 ×599 (₹1,79,101/month). New `parseAddRequest` in `_build/price_bundle.js` reads the catalogue ID first (an unknown ID adds nothing), then the full product name including its digits, then the quantity ("5", "x5", "5x", "×5"), and falls back to the old word matching. 3 new tests (275 pass). Old vs new `price_bundle` on 1,470 ordinary add requests (5 contexts × EN/HI): 0 differences |
| L3 | **Silent guesses.** `price_bundle` fills a missing team size, city tier or segment with defaults and doesn't say so. | Breaks "never guess silently"; the agent can't ask a follow-up | Add an `assumptions` output listing what was assumed; update TOOL_SETUP and playbook A |
| L4 | `buildQuote` is still long and does several jobs (sizing, candidates, owner edits, eligibility, budget, formatting) | Hard to read and test in parts | Split into `chooseItems`, `applyEligibility`, `summariseQuote`; add unit tests per part |
| L5 | Little input validation at the boundary: e.g. `employees: "-4"` reads as 4; garbage text becomes a default | Inputs can be misread without anyone knowing | Validate ranges and types; report problems through `error` or the new `assumptions` output |
| L6 | Helpers are repeated in several files (name matching, `fillTemplate`, date formatting) | They can drift apart | Required by Voiceflow (no imports); have `gen_kit.py` inject one shared helper block |
| L7 | User-facing text is per file, not in one place | The standard asks for one place | Keep a single `_build/messages.json` and let `gen_kit.py` inject each file's part |
| L8 | No unit tests for the internal helpers (checksum, masking, Indian number grouping, segment detection) | Only end-to-end checks exist | Export helpers in a test build, or test them through `main()` with targeted inputs |
| L9 | `npm audit`: 5 moderate advisories in ESLint's dependency `minimatch` (dev-only, not shipped) | Only matters on developer machines | Run `npm audit fix` when ESLint ships a compatible update; avoid `--force` |
| L10 | Lead-score percentiles are extreme (office 98, kirana 0) because the training data has strong GSTIN effects | Many leads end up as Hot or Cold, few as Warm | Calibrate the bands on the score distribution of real chatbot leads once data exists |

## Added 2026-11-04: `onboard_from_gstin` (zero-question onboarding)

New function built to CODING_STANDARDS.md. 21 new tests; all 52 pass. The six existing functions were compared
before and after on 20,534 inputs: 0 differences.

Known limits of the new function (not bugs; decide before going live):

| # | Limit | Why it matters | Next step |
|---|---|---|---|
| N1 | Kannada text was written for the prototype, not by a native speaker | Wording may sound unnatural | Native-speaker review of the `kn` block in MESSAGES |
| N2 | Confidence values were calibrated on synthetic data, where trade names are very regular (clear name words are capped at 0.85 for that reason) | Real names are messier, so expect more questions in real use | Re-calibrate on real pilot data; keep the 0.7 threshold until then |
| N3 | The Udyam link is SIMULATED by business name + state at build time (production would follow the PAN inside the GSTIN) | 8% of GSTINs have several possible matches and get no link | Use a PAN-based Udyam lookup in production |
| N4 | Consent is taken as given when the owner shares the GSTIN right after the one-line notice | Fine for a prototype; DPDP needs a clear, recorded affirmative action | **Fixed 2026-11-04 (PROMISE step):** `consent_manager` asks three purposes separately (no default, no "accept all"), records each answer with time, version and history, and withdraws per purpose; `onboard_from_gstin` is called with consent_given = yes only when registry-lookup consent is true |
| N5 | File size ≈ 295 KB (registry + embedded price_bundle) | Voiceflow's editor may refuse it | Serve the registry from a small API, or ship a reduced registry |
| N6 | GSTIN checks, masking and rupee formatting are copied from verify_gstin / price_bundle (Voiceflow allows no imports) | Copies can drift | Same fix as L6: inject one shared helper block from gen_kit.py |

## Added 2026-11-04: `bill_swap` and `readiness_score`

Both built to CODING_STANDARDS.md, with 28 new tests; all 80 pass. The six original functions show 0 differences
on 20,534 inputs, and onboarding's calibration is unchanged.

Found and fixed while building them:
- **readiness_score:** for a factory with unknown GSTIN and staff, the first draft suggested a Fleet Tracker to close
  "machine monitoring" and gave it full credit.
  - It now keeps the intended product and states the unknown facts as conditions.
  - Each add-on earns its real credit (AirFiber 80%; fibre 60% for a factory).
- **Wiring:** passing readiness add-ons to price_bundle by product name would have hit L2 (names like "Business
  Postpaid 299" read as quantity 299). readiness_score now returns `suggested_needs` (need keywords) instead.

Known limits (decide before going live):

| # | Limit | Why it matters | Next step |
|---|---|---|---|
| B1 | Bill reading is rule-based ("category \| vendor \| amount", "3 x 799", "per user", "per year") | Unusual wording may be misread; it's flagged rather than guessed, but not every misreading is detectable | Log unreadable lines in the pilot and extend the patterns |
| B2 | Like-for-like removes defaults the owner doesn't pay for, so the comparison can understate what the recommended bundle would cost | The proposal and the bill swap can show different Accel prices | Show both in the playbook: "your proposal ₹X; like for like ₹Y" |
| B3 | A bill with no stated quantity (email users, cameras) is priced at Saathi's default quantity | Savings depend on that default | It's listed in `assumptions`; ask for the quantity if savings are close to zero |
| R1 | Readiness weights and partial credits are design choices based on the case's Appendix A2, not fitted to outcomes (the case data has no "products already used" field) | The score is defensible but not validated | Validate against pilot outcomes (activation, churn) and re-weight |
| R2 | Words are matched literally (e.g. "fibre" alone counts as home broadband, 50%) | A business fibre described only as "fibre" is under-credited | The credit is shown per item in `recognised_products`, so the owner can correct it |

## Added 2026-11-04: REACH layer (`reach_rules`, `reach_tag_lead`, back-office page)

Built to CODING_STANDARDS.md, with 25 new tests; all 105 pass. The original six functions still show 0 differences
on 20,534 inputs, and onboarding's calibration is unchanged. The page was checked in a browser at 1280 px and 375 px:
filters work, there are no console errors and no horizontal scroll (a filter-grid overflow at 1280 px was found and
fixed).

Found and fixed while building:
- **Paying reps for their normal job.** The first rules version paid a field rep the referral incentive on leads they
  sold in person. Now `notWhenClosedBy: ["field_rep"]`: the incentive is paid only when Saathi closes a lead the rep
  referred.
- **Paying the same rep twice.** A rep's own referral in their own territory, closed by Saathi, earned both the
  referral incentive and territory credit. Now it's one reward.

Known limits (decide before going live):

| # | Limit | Why it matters | Next step |
|---|---|---|---|
| RE1 | The referrer directory (2 CA partners per city, a rep per city) and the territory map are SIMULATED from the case cities | Real partner and sales-territory data will differ | Load them from the partner and sales systems; the rules don't change |
| RE2 | Territory is matched by city (as the district) and state, not pincode: the mock registry's pincodes are synthetic | Real districts need a pincode → district table | Add a pincode → territory table when real addresses exist |
| RE3 | Rates (100% / 50% / 25% / 10% of the first bill, caps, 90-day hold) are design choices, justified against the case's acquisition costs, not tested | They decide the economics of the channel | Pilot them; they're one object (`REACH_RATES`) to change |
| RE4 | The back-office sample is SIMULATED: referral attribution, "bundle viewed" and "closed by Saathi" are assumptions on historical leads | Reward and handoff totals on the sample are illustrations | Point the page at the real sheet |
| RE5 | Rewards are computed in the page, not written back to the sheet, and there is no payout ledger | Fine for a view; payouts need an auditable ledger | Add a settlement export (CSV) or a payouts sheet before paying anyone |
| RE6 | The referral code reaches Saathi only if the widget snippet gets the launch payload line (see `7_demo_site/index.html`) | Without it, the code from the link is lost (owners can still type it) | Verify in Voiceflow when the agent is assembled |

## Added 2026-11-04: PROMISE (72-hour guarantee, downtime credit), consent per purpose, Smart KYC fallback

Built to CODING_STANDARDS.md. New: `_build/promise_rules.js` (rules in one `PROMISE_RULES` object, embedded in
`order_status` and `downtime_credit`), `_build/consent_rules.js` (embedded in `consent_manager` and the demo page),
`_build/certificate_reader.js` (demo page), the browser copy of the built onboarding function, and 3 SAMPLE
certificate images. 55 new tests; all 160 pass. The five functions this step didn't touch (`price_bundle`,
`verify_gstin`, `verify_gstin_lite`, `verify_udyam`, `register_lead`) show 0 differences on 20,520 inputs;
`order_status` was rewritten on purpose (its two original tests still pass). Onboarding calibration is unchanged
(73.1% zero-question, 98.3% segment right). The demo page was checked in Chromium with real Tesseract.js OCR on all
three samples: 32 checks pass (`6_tests/browser_kyc_check.py`), including 375 px with no horizontal scroll and no
console errors.

Found and fixed while building:
- **A missed promise said "Promise kept".** A late connection got the on-time "connected" text. Now any connection
  after the deadline gets the neutral "You're live" text in all three languages (test added).
- **A missed promise showed a green tick** in the tracker, and the order's stage became "72-hour promise missed".
  Now it shows ⚠️, and `order_stage` stays the order's real stage.
- **Hindi and Kannada minutes were dropped silently.** "2 घंटे 15 मिनट" read as 120 minutes because JavaScript's `\b`
  doesn't work after Devanagari or Kannada letters. Fixed, and negative durations are now refused.
- **The rule text didn't add up** ("8 × ₹73" next to a ₹586 credit). The daily bill is now rounded first.
- **The guarantee only worked for demo orders** (hours "ago"). It now takes a stored `confirmedAt`, as a real order has.
- **Tracker stages counted as "Contacted"** in the funnel (retention, reschedule, support, AirFiber bridge). They now
  map to "KYC complete" in `reach_rules.js`: an order exists.
- **Consent radios rendered above their labels** on the demo page (a shared `.fields label` rule). Fixed and re-checked.

Known limits (decide before going live):

| # | Limit | Why it matters | Next step |
|---|---|---|---|
| P1 | Orders, stage events and outages are SIMULATED (4 demo orders timed relative to now; an outage is typed in) | Nothing is connected to a real order or network-monitoring system | Feed `order_status` from the order system (it already accepts a stored `confirmedAt`) and call `downtime_credit` from network alarms |
| P2 | Proactive messages are listed in the tracker, not sent | "Never needs to chase" depends on actually sending them | Send `next_proactive_message` by WhatsApp template at each stage event |
| P3 | Chases are counted within one conversation (`previous_chases` is passed back by the agent) | A chase in a new conversation starts again from the order's stored count | Store `chase_count` on the order record (the sheet column exists) |
| P4 | Credit amounts are design choices (month one = 100% of the monthly bill; 1 day per started 4 h after 60 min; ×0.5 with failover; cap 50%) | They decide the cost of the promise | Pilot them; they are one object (`PROMISE_RULES`) |
| P5 | The "72 hours" covers connectivity (fibre, or 5G AirFiber as a bridge); other items keep the install times in the quote | Owners could read "72 hours" as the whole bundle | Keep the FAQ wording; show the bridge in the quote when fibre takes longer |
| C1 | Hindi and Kannada consent and reader texts were written for the prototype | DPDP needs the notice to be clear in the owner's language | Native-speaker review of `CONSENT_TEXT` and `READER_TEXT` |
| C2 | A withdrawal in the chat isn't written back to an existing sheet row | The back office could act on a withdrawn consent | Update the row (or a consent log sheet) on every `consent_manager` record/withdraw |
| C3 | The demo page keeps its consent record in the browser tab (sessionStorage) | Fine for a demo; not an audit trail | Store consent records server-side with the conversation ID |
| K1 | The certificate reader runs on the demo page, not inside the Voiceflow chat, and reads GST certificates only | The chat can't read images; the case's other KYC documents aren't covered | Add an upload step in a custom chat front end that calls the same `certificate_reader.js` |
| K2 | OCR was tested on 3 generated SAMPLE certificates (clean, printed text), not phone photos of real certificates | Real photos are skewed, dim or folded; accuracy will be lower | Test on real photos; keep the "check and correct" step and the checksum-gated corrections |
| K3 | Tesseract.js and its language data load from the jsDelivr CDN | Needs internet; a CDN outage stops the reader (the page then shows only its generic "couldn't read that image" message; the chat path still works) | Self-host the worker, core and `eng` data for production |

## Fixed 2026-11-04: a GSTIN typed inside a sentence was rejected (outside review)

**Found by:** the outside review. "my gstin is 07PUTXM1153M1Z9" and "GSTIN: 07PUT…" both returned INVALID_FORMAT with
the wrong message ("doesn't look complete"), while TOOL_SETUP told the AI to pass the GSTIN "exactly as the owner
typed it". The demo page also showed the owner "Registry status: INVALID_FORMAT".

**Fix:** one shared reader, `_build/gstin_input.js`, embedded unchanged in `onboard_from_gstin`, `verify_gstin`,
`verify_gstin_lite`, the certificate reader and the demo page (a test checks every copy matches the source). It
removes separators, upper-cases, finds every GSTIN-shaped run, and reports zero (`INVALID_FORMAT`) or several
(`MULTIPLE_GSTINS`, listed masked) instead of guessing. It also holds the one copy of the format, state-code and
checksum checks and of the masking, which used to be repeated (partly closes L6 and N6). Every status code has a
short, friendly message in English, Hindi and Kannada; codes never reach the owner. The AI now passes the owner's
whole message (global prompt, playbooks 0 and B, TOOL_SETUP).

**Deviation from the request, on purpose:** besides spaces and dashes, dots and slashes are also removed. The old
code removed all punctuation, so "07.PUTXM.1153.M1Z9" and "07/PUTXM/1153/M1Z9" worked; keeping them avoids a
regression (1,200 of the comparison inputs used them).

**Checked:**
- 19 new tests; all 179 pass.
- Mutation checks on scratch copies: reverting to the old reading fails 9 tests, leaking a code into the message
  fails 2, silently picking the first of two GSTINs fails 3.
- Before/after on 9,323 inputs × 3 tools: 7,500 identical per tool (every plain GSTIN and the dot/slash forms);
  1,803 now read correctly (after a label, in an English or Hindi sentence); 3 now report two GSTINs; 17 get the new
  "no complete GSTIN" wording. Nothing else changed. `price_bundle`, `verify_udyam` and `register_lead`: 0
  differences; onboarding calibration unchanged.
- Browser (37 checks): found that the page's GSTIN field had `maxlength="20"`, which cut a pasted sentence short.
  Raised to 120.

**Still open:** a letter O typed for a zero ("O7PUTXM…") is still reported as "no complete GSTIN". The
certificate reader corrects look-alikes for OCR, but typed text isn't corrected.

## Fixed 2026-11-04: zero-question proposals overshot for small businesses (outside review)

**Found by:** the outside review. Onboarding sized the first quote at the segment-and-constitution MEDIAN team and
added the segment's default extras (POS for shops, failover for offices, CCTV for chains, machine sensors for
factories). A 1-person kirana was quoted ₹2,196 against ₹1,298 at its true size; a 5-person insurance agency ₹5,789
against ₹3,269. The greeting stated the size guess but not the added POS.

**Fix (`_build/onboard_from_gstin.js`, `_build/gen_kit.py`):**
- The first quote is the BASE bundle for the smallest sensible business in the segment: the smallest team in
  smb_leads.csv (shops and services 1, offices 3, chains 15, factories 12; injected by the build), at least one person
  per site, and the lowest number of a locations answer ("6–10" → 6). price_bundle only goes up with size, so the
  first quote is at most the true-size price.
- Extras are `suggested_addons_json`: switched off, each priced by price_bundle (with the need minus without), with a
  one-line reason. The greeting names them with prices, "not in the price above".
- The greeting states every assumption in plain words: business type, team size (the range the same quote covers,
  e.g. "1–2"), locations and the connection the quote needs (`assumptions_json`).

**Measured** with the new `6_tests/measure_onboarding.mjs` on all 3,534 registry GSTINs (before → after):
- zero-question proposals 73.1% → **73.1%** (2,584). The share depends only on confidence; the 0.7 threshold was not
  touched.
- first quotes above the true-size price: 1,995 of 2,584 (77.2%) → **0**; after one answer: 516 of 682 → **0**.
- average first quote ₹4,886 → ₹3,053 (true-size average ₹4,333).

**Tests:** 11 new (all 190 pass), including a scan of all 3,266 active registry GSTINs for extras in the first total.
Mutation checks on scratch copies: median sizing again fails 4 tests, an extra back in the total fails 5, a dropped
assumption fails 2, a wrong add-on price fails 1. Two existing tests were updated on purpose: the greeting wording,
and "6–10 locations" now means 6 sites, not 8.

**Trade-off, by design:** first quotes now undershoot for most businesses (₹3,053 against ₹4,333 on average). The
greeting says so in plain words and the owner's real size re-quotes upwards. In the pilot, measure how often owners
correct the size.

## Fixed 2026-11-04: four items from the outside review

1. **The knowledge base contradicted the pricing code** ("about one line per 5 people", "Biz Fibre 100 per site";
   the code uses a minimum of 2 lines and Biz Fibre 300 above 15 people per site). The pricing code is now the single
   source of truth: `_build/kb_sizing_rules.mjs` loads the generated `price_bundle.js`, reads its `THRESHOLDS`,
   `SIZING`, product IDs and catalogue, writes every sizing rule from them, and prices the worked examples by calling
   `price_bundle` itself. `gen_kit.py` runs it on every build; only the text between the `=== BEGIN GENERATED` and
   `=== END GENERATED` lines is replaced. The hand-written bundle descriptions no longer state quantities or prices.
   Tests: the section must equal what the code writes today; no sizing claim or rupee amount may remain in the
   hand-written part; four rules are spot-checked against price_bundle's behaviour. Mutation checks on scratch copies:
   a hand-edited section fails; a pricing change without the knowledge-base step fails; a pricing change with the
   normal build updates the knowledge base by itself ("at least 3 lines") and the sync test passes.
   Still hand-written: the ELIGIBILITY RULES and install-time lines (from the catalogue); they could be generated the
   same way.
2. **verify_gstin had no consent check in code.** It now refuses, exactly like onboard_from_gstin, unless
   `consent_given` is a clear yes ("yes"/"true", what consent_manager reports when granted): missing, "no", "false"
   or "withdrawn" → `CONSENT_NEEDED`, nothing read or looked up, and a friendly request in English or Hindi. Same in
   the lite build. Before/after on 9,323 inputs × 2 builds: with consent 0 differences; without consent all refused.
   Tests: missing, withdrawn/unclear (5 values × 2 builds), granted ("yes" and "true"), Hindi. Existing test calls
   now pass consent, as the playbook does. **Still open:** `verify_udyam` is also a registry lookup and has no consent
   check in code yet.
3. **Uncaught Tesseract error on non-image uploads.** Tesseract.js v5 re-throws a failed read as a global error
   unless `createWorker` gets an `errorHandler`; the page now passes one (the failed promise was already handled).
   Files that aren't images are also refused before OCR with their own message ("That file isn't a photo", EN/HI/KN).
   Browser check (now 40): a text file and a corrupt "PNG" both fail gracefully with no page error, and the reader
   works afterwards; with the handler removed in a scratch copy the check fails with the original error.
4. **Back-office cosmetics.** The data-source fields can shrink with the panel (the native file input overflowed it at
   375 px: 32–366 px against a 16–359 px panel). Red text on tinted boxes uses a new `--red-text` token: #b80000 in
   light mode (4.28:1 → over 4.5:1) and #ff8a80 in dark mode (3.31:1 → about 7:1). New
   `6_tests/browser_back_office_check.py` (12 checks) measures WCAG contrast from the rendered colours and the 375 px
   layout; it fails 6 checks on the old stylesheet and passes all 12 now.

## Fixed 2026-11-05: bill amounts and quantities; checksum-guided GSTIN reading (outside review)

**Found by:** the outside review. `bill_swap` read "₹799 x 3" as 799 mobile lines (an Accel quote of ₹2,39,900 a
month), "3 SIMs x ₹799" as ₹799, "₹999 for 100 Mbps" as ₹100 and "₹1,000 + 18% GST" as ₹18. The certificate reader
got the GSTIN right on 8 of the 12 case GST certificates, and built a "GSTIN" out of the "Bill date" line on 4 of the
case's electricity bills.

**Fix 1: bill amounts (`_build/bill_swap.js`).**
- The amount is read from the last field after the category that has a digit, so a plan name ("Biz Fibre 100") is
  never money.
- Every number is classified: money (₹, Rs, Rs., INR, rupees, "/-", or no mark), a quantity (a quantity word right
  after it: "3 SIMs") or not money (%, Mbps/GB, months, or a letter stuck to it: "5G").
- "A x B", "A × B", "A*B", "3 lines at 799", "3 SIMs @ ₹799": the ₹ mark or the quantity word decides which number is
  the quantity. With neither, the number under `MIN_UNIT_PRICE_IN_RUPEES` (₹50) is the quantity.
- "each" and "per line" multiply by the quantity stated on the line.
- **Asks instead of guessing** (line left out of the totals, question in `unreadable_lines`): either number could be
  the quantity ("120 x 100"), the quantity is over `MAX_STATED_QUANTITY` (150, the largest team in smb_leads.csv),
  two amounts on one line ("₹500 + ₹300"), or "each" with no quantity.
- "₹1,000 + 18% GST" is read as ₹1,000: the amount before GST, the same basis as Accel's own prices.
- Before/after: all 5,000 lead bills (each lead's spend as an internet bill) give identical output. In a grid of 168
  lines (7 categories × 24 ways of writing an amount), 111 are identical and the 57 that changed are exactly the
  9 writings this fix is about.
- Tests: 14 new, one per format, plus every currency writing, quantity word and non-money unit through the real tool.
- Mutation testing (Stryker, 2026-11-05): bill_swap 43.6% → 50.4% of mutants killed (553 of 1,097); the new parsing
  logic 73.5% (180 of 245); its CONFIG patterns only 42.4% (28 of 66). The surviving pattern mutants point at
  writings with no test yet: "2 lakhs", decimals ("₹799.50"), "1 rupee", a trailing comma ("799,"), and two-field
  lines ("Broadband | 999"). All tools together: 59.3% → 60.1% of 5,945.

**Fix 2: checksum-guided GSTIN correction (`_build/certificate_reader.js`).**
- For each position: the character as read if the GSTIN layout allows it there, the existing look-alike fix, and
  the swaps in `OCR_CONFUSION_PAIRS` (O/0, I/1, L/1, S/5, B/8, Z/2, G/6) that the layout allows there. Every reading
  is checked (at most `MAX_READINGS_TRIED`, 64). Exactly one passes → accepted, corrections listed for the owner.
  Several pass → nothing is filled in and the readings are listed (`gstin_ambiguous`, EN/HI/KN). None → shown as
  read and the owner is asked to confirm or type it (message reworded).
- Corrections are tried only on the GSTIN line (the line with its label, or the line under a label that stands
  alone). Elsewhere only a GSTIN that is valid exactly as read counts.
- **Deviation from the request, on purpose:** at the entity number (13th character) swaps go one way only, a letter
  to its look-alike digit. Trying I and L for a "1" there gave the kit's own SAMPLE certificate a second valid
  reading (a test failed). Never trying "1" for an I or L let a wrong GSTIN through in 206 of 30,945 simulated
  misreads. The entity number is "1" in all 3,534 registry GSTINs.
- The demo page lists the candidate readings in the field note.
- Before/after (old and new page script): all 3,534 registry GSTINs read right in both. One OCR confusion injected
  on the GSTIN line, 30,945 cases: right 21,768 → 30,711, wrong accepted 0 → 0, right → asked 11 (two readings
  pass, so the owner chooses). The same misreads on a line without the GSTIN label: right 21,779 → 0, asked instead,
  by design. The 47 case OCR texts: GSTIN right on 8 of 12 certificates before and after; GSTINs invented from other
  documents 4 → 0.
- Tests: 9 new. Browser check (43) passes with real OCR.

**Image preprocessing: tried, not adopted.** Measured on the 47 case images with the page's Tesseract.js:

| Before OCR | GSTIN right | Printed fields found in the raw text |
|---|---|---|
| Nothing (today) | 8 of 12 | 283 of 305 |
| Greyscale + contrast stretch | 8 of 12 | 284 of 305 |
| 2× upscale | 7 of 12 | 285 of 305 |
| 2× upscale + greyscale + contrast | 8 of 12 | 284 of 305 |

**Still open:**
- K02 is photographed at an angle and needs deskewing. K04 is too blurred for Tesseract. K10's "J" is read as "I",
  which is not one of the requested pairs: adding ["I", "J"] would let the checksum fix it, at the cost of more
  candidate readings. K06's printed GSTIN was altered on purpose, so asking the owner is the right result.
- Udyam certificates, signatory IDs and address proofs are not parsed, although Tesseract reads all 35 of them in
  full; their planted problems (a blank Udyam number, a bill older than 90 days) are not checked.
- The certificate reader is not in the mutation-testing scope (it is a page script, not a function tool).
- The new bill questions are in English, like the existing problem texts; the agent may translate them.

## Added 2026-11-07: scoped activation guarantee (STRATEGY §11) and Udyam entry (STRATEGY §12)

Built to CODING_STANDARDS.md. 304 tests pass (29 new). Browser checks: KYC 43/43, back office 12/12. Lint, Prettier
and Ruff clean. Before/after comparison against the kit as it was before this step: `price_bundle` on all 5,000
leads × EN/HI (10,000 calls), `verify_udyam` on every registry number in four spellings plus bad inputs (21,796
calls) and `onboard_from_gstin` on all 3,534 GSTINs: **0 differences** apart from the intended ones (the new promise
outputs, the one promise line on the quote card, the guarantee sentence in the greeting, and `verify_udyam` now
finding a number inside a longer message).

**Found by that comparison and fixed before release:** the new Udyam reader searched inside the text, so
`UDYAM-KL-00-30788011` (one digit too many) was silently read as the different, registered number
`UDYAM-KL-00-3078801`. The serial now may not be followed by another digit; a test pins it.

Known limits (decide before going live):

| # | Limit | Why it matters | Next step |
|---|---|---|---|
| G1 | **AirFiber coverage is SIMULATED**: every city in the case data. The pack has no coverage data, the leads have no pincode and the registry's pincodes are random | The coverage condition of the 72-hour scope never excludes anyone in the measurement | Replace `AIRFIBER_COVERAGE_CITY_NAMES` with a pincode-level coverage lookup; `airfiber_available` = "no" already overrules it per order |
| G2 | **The 72-hour scope is still missed on 27% of qualifying activated orders** (as operated in the case data, which has no AirFiber bridge) | It is the best group known at quote time; none reaches 90% | Pilot the AirFiber bridge in tier-1 cities and re-measure with `6_tests/measure_promise_scope.mjs`; tighten `GUARANTEE_SCOPE` if the miss rate stays high |
| G3 | Observed activation times are **survivor-biased**: 139 of 507 confirmed orders were never installed (98 "delayed beyond 21 days", 41 "not feasible") and have no activation date | The firm dates (P90 of installed orders) look shorter than the whole process; the never-installed orders are most of the remaining credit cost | Count them as misses in every estimate (done); fix the installation backlog, not the dates |
| G4 | The firm dates use whole days (the case data has dates, not times) and a group of ≥ 20 orders; AirFiber has 9 orders, so it falls back to the tier's all-connection figure | AirFiber's firm date (8 / 11 days) comes from other connections | Re-derive per connection once real AirFiber orders exist |
| G5 | `onboard_from_gstin.js` is now ≈ 490 KB (was ≈ 295 KB): it embeds the Udyam registry too | Worsens N5: Voiceflow's editor may refuse it | Serve both registries from a small API, or ship a Udyam-only onboarding function |
| G6 | Hindi and Kannada texts of the guarantee and Udyam entry were written for the prototype | Wording may sound unnatural | Native-speaker review with N1 |
| G7 | A Udyam entry has no registration status (the registry has no status field), so a closed enterprise can't be blocked the way a cancelled GSTIN is | Pre-approval is by age only, and the reason says so | Use the Udyam portal's status in production |
| G8 | The Google Sheet has no `promise_type` column | The back office can't filter by guarantee type yet | Add `promise_type` and `promise_days` to the sheet header, COLUMNS.md and playbook C together (interface change) |
