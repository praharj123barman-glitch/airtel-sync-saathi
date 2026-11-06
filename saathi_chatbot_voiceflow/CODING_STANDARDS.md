# Coding standards

These rules apply to every change in this project. They are written for someone joining later who has never seen
the code. If a rule and the code disagree, the code is wrong. Fix it, or note it in [CODE_REVIEW.md](CODE_REVIEW.md).

## 0. What this project is made of (read first)

| Language | Where | Runs in |
|---|---|---|
| JavaScript (ES2020 modules) | `_build/*.js`: the source of the Voiceflow function tools | Voiceflow's function runtime (V8) |
| JavaScript (Node 18+ ES modules) | `6_tests/*.mjs`, `eslint.config.js` | Node.js on your machine |
| Python 3.10+ | `_build/gen_kit.py`: injects the case data into the function tools | Your machine |
| HTML + CSS + a little JavaScript | `7_demo_site/index.html` | A browser |
| Plain text / Markdown / CSV | prompts, playbooks, knowledge base | Pasted or uploaded into Voiceflow |

### Platform constraints that shape these rules
- **One file per Voiceflow function, no imports.** Voiceflow runs each function tool as one self-contained file:
  no `import`, no `require`, no browser APIs. Only `fetch` is available. So shared helpers are repeated in each
  function file. Keep the copies identical and update them together.
- **Never edit `3_function_tools/` by hand.** Those files are *generated*: `_build/gen_kit.py` takes the templates in
  `_build/` and injects the case data (catalogue, registries, trained model). Edit the template in `_build/`, then
  rebuild (see [README.md](README.md)). The same goes for the section of
  `4_knowledge_base/saathi_bundles_and_rules.txt` between the `=== BEGIN GENERATED` and `=== END GENERATED` lines:
  `_build/kb_sizing_rules.mjs` writes it from `price_bundle`'s config, and a test fails if the two differ.
- **Voiceflow variable names are an interface.** Input and output variables (`has_gstin`, `monthly_total`, …) are
  `snake_case` because the playbooks, the Google Sheet and Voiceflow refer to them. Don't rename them unless you
  also update the playbooks, `TOOL_SETUP.md`, the sheet header and the tests in the same change.

## 1. Readability

- **Names say what things are.** `getEligibilityProblems`, `monthlyPriceFloorInRupees`, `employeeCount`. Not
  `elig`, `min`, `emp`, `iv`, `p`. Allowed abbreviations: well-known domain terms (GSTIN, KYC, OTP, UPI, POS, CCTV,
  SD-WAN, IST, ID, URL, CSV, JSON) and loop indices `i`, `j`.
- **Casing.**
  - JavaScript: `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for module-level constants, `snake_case`
    only for Voiceflow input/output variables.
  - Python: PEP 8 (`snake_case` functions and variables, `UPPER_SNAKE_CASE` constants).
- **Small functions that do one thing.** If you need "and" to describe a function, split it.
- **No magic numbers or strings.** Prices, thresholds, ratios, scoring weights, time limits, product IDs and status
  codes live in named constants or config objects near the top of the file. Each has a comment saying what it is
  and where the value came from (the case PDF, a data finding, or "design choice").
- **Plain, boring code over clever code.** A loop a newcomer understands beats a one-liner they have to decode.

## 2. Comments and documentation

- **Every file starts with a header:** what the file does, and how it fits into the system (who calls it, what it
  calls).
- **Every exported or entry-point function** (each Voiceflow `main`, every Python function) has a doc comment with
  purpose, inputs, outputs and a short example. In JavaScript use JSDoc (`/** … */`); in Python use docstrings.
- **Comments explain WHY, not WHAT.** Link business rules to the case or a data finding, for example:
  `// Block cancelled/suspended GSTINs: 22 of 368 activations in smb_leads.csv went live on dead registrations.`
- **Label anything simulated as SIMULATED**, both in a code comment and, where relevant, in what the user sees.
  That covers DigiLocker, e-Sign, UPI Autopay, demo orders and sample certificates.

## 3. Structure

- **Folders** are listed with a one-line purpose in [README.md](README.md). New folders get a line there.
- **Keep data, config, logic and presentation separate.** Inside a function file the order is always:
  1. file header
  2. `main()` (the Voiceflow entry point)
  3. **CONFIG**: named constants (thresholds, ratios, IDs)
  4. **MESSAGES**: all user-facing text, in every language
  5. **LOGIC**: small named functions
  6. **DATA**: injected by the build (catalogue, registries, model)
- **User-facing text lives in the MESSAGES section of its file**, never inline in the logic. English and Hindi sit
  side by side so they can't drift apart. (Text for the AI itself lives in `1_agent_global_prompt.txt` and
  `2_playbooks/`.)

## 4. Errors and edge cases

- **Validate inputs at the boundary.** Every `main()` reads `args.inputVars` defensively: treat missing, blank or
  garbage values explicitly and never let them throw.
- **Fail clearly.** Every function returns all of its declared outputs, always. On failure, fill the `error` output
  with a message a developer can act on (`"price_bundle failed: <reason>"`) instead of crashing the chat.
- **Never guess silently.** If the function had to assume something (a missing team size, an unknown city tier),
  say so in an output the agent can read, so it can ask a question or tell the owner.
- **Never invent prices.** Every price, quantity, plan length and install time comes from `price_bundle`. Prompts
  must never ask the AI to calculate.

## 5. Tests

- **Every new function gets tests** for the normal case, edge cases and invalid input.
- **Test names read as sentences:** `blocks activation when the GSTIN is cancelled`.
- **All tests must pass before a step is done:** `npm test`.
- **A successful call must return no error.** Call tools through `runTool`, which fails the suite (naming the tool
  and inputs) whenever a call returns an `error`; a crash returns empty defaults, so a test that only checks for
  `false` or `0` would otherwise pass on a crash. Only tests of bad input use `runToolExpectingError`, and must then
  assert the error.
- **Test what the claim says, not a proxy for it.** Check quantities and prices, not just that an item is present;
  check that an image has readable content, not just that it has a label.
- **Test every entry of a rule table, not one example.** Keyword and name lists are data: loop over every entry
  through the real tool (read the table from the generated file, as `readInternals` does). Rule words must be
  normalised the same way as the text they are matched against. A single example per rule left 329 keyword entries
  that could be blanked without any test failing, and hid one that could never match ("pre-school").
- **Mutation testing** (`npm run test:mutation`, Stryker) shows which code changes no test notices. Run it after
  larger changes and add tests for surviving mutants in the core tools first.
- **Refactors must not change behaviour.** For any "no behaviour change" cleanup, compare every function's
  output on a large input set before and after (the case leads and both registries, as was done for the
  2026-11-04 cleanup), and only then call it done.
- **Conversation tests** (`6_tests/test_conversations.md`) are run by hand in Voiceflow after any prompt or
  playbook change.

## 6. Privacy (DPDP Act, 2023)

- **Collect and log only what is needed.** Functions never `console.log` personal data (names, phone numbers, full
  GSTINs or IDs). Show identifiers masked (`07PUT•••••••1Z9`, `98•••••210`).
- **Lead scoring gets no personal data.** `register_lead` receives business attributes only, never name or phone.
- **Sample data is fake and marked as such.** Everything in the case pack is synthetic (fictional operator,
  fictional businesses, identifiers that can't match real taxpayers). Say so wherever sample data appears.

## 7. Formatting and linting

| Language | Tool | Command |
|---|---|---|
| JavaScript / HTML | Prettier (`.prettierrc.json`) | `npm run format` |
| JavaScript | ESLint (`eslint.config.js`) | `npm run lint` |
| Python | Ruff (`pyproject.toml`) | `ruff format _build` and `ruff check _build` |

Run the formatter and the linter on everything you touch. Generated files in `3_function_tools/` are excluded
because the build creates them.

## 8. Definition of done (checklist)

- [ ] Names are clear; no new magic numbers or strings
- [ ] File header and doc comments present; business rules explain *why*
- [ ] Simulated parts are labelled SIMULATED
- [ ] Function tools rebuilt from `_build/` (never hand-edited)
- [ ] `npm run lint`, `npm run format` and `ruff check _build` are clean
- [ ] `npm test` passes, and any refactor was compared before and after
- [ ] README / TOOL_SETUP / playbooks updated if an interface changed
