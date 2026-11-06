# Accel Saathi: 3-minute demo video script

For the case brief's "working prototype (demo video of 3 minutes max + code repository)". Team buri buri zaimon ·
Prohorj Babu Bormon · Mubashir Afzal · NIT Karnataka (NITK).

**Record:** Voiceflow's test chat (or the demo page `saathi_chatbot_voiceflow/7_demo_site/index.html` once the widget is
published) at 1920×1080, with the voice-over recorded live or added after. Start a **new conversation** for each
scene, so consent and earlier answers don't carry over. Rehearse each scene once first: every chat reply uses Voiceflow
credits, so check the credits counter (bottom-left in Voiceflow) before recording.

**Before recording:** zoom the browser to 125% so the chat is readable; close other tabs and notifications; have the
GitHub repo and `8_back_office/index.html` open in two more tabs.

| Time | Scene | Type exactly (tap = press the button) | What must be on screen | Say |
|---|---|---|---|---|
| 0:00–0:15 | Title | (show the deck's cover, slide 1) | Accel Saathi · team and campus | "Small businesses wait 17.6 days to get Accel connected, and only 7 in 100 leads activate. Accel Saathi does it in one conversation." |
| 0:15–0:35 | Consent first | `Hi` · tap `Get my plan` · tap `Registry lookup: Yes` · tap `KYC verification: Yes` · tap `Offers on WhatsApp (optional): No` | Three separate consent questions, nothing pre-ticked | "Before we look anything up, Saathi asks consent for each purpose separately, as the DPDP Act expects." |
| 0:35–1:05 | GSTIN is the application | `07PUTXM1153M1Z9` | Greeting "I found Metro Diagnostics Pvt Ltd, Delhi…", Office Pro ₹3,269/month, quote card ending "Connected in 72 hours, guaranteed", GSTIN masked | "One GSTIN, zero questions. Saathi reads the GST and Udyam registries, picks the right bundle and prices it with a rules engine: the AI never invents a price. 73% of registered businesses get a plan like this with no questions at all." |
| 1:05–1:30 | No GSTIN: Udyam entry, in Hindi | New chat: `नमस्ते` · tap `Get my plan` · consent (हाँ / हाँ / नहीं) · `मेरे पास GST नहीं है। Udyam नंबर UDYAM-DL-00-0779845 है` | Hindi reply, "found on the Udyam registry", Dukaan Digital ₹1,298 | "29% of leads have no GSTIN. They start with their Udyam number, in their own language, and still get a plan without a single question." |
| 1:30–1:50 | Fraud stopped | New chat: consent as before · `29OKAXP4077P1ZL` | "…as CANCELLED, so I can't set up a connection on it", no quote | "22 activations in the case data went live on cancelled GSTINs. Saathi blocks them and hands the case to a person." |
| 1:50–2:15 | Tracker and the promise | `where is my order UD-0001` | Timeline, "10-day guarantee missed: month one is free (₹7,185 …)", retention handoff | "Every quote carries a guarantee: 72 hours where our data says we can keep it, a firm date everywhere else. Miss it and month one is credited automatically, and a second chase goes straight to retention." |
| 2:15–2:35 | Back office and REACH | Switch to the `8_back_office/index.html` tab; click a Hot lead | Unclosed leads ranked by score, rep callback, referral rewards | "Leads Saathi can't close go to a back-office queue ranked by a propensity model, with referral codes for CA partners and customers." |
| 2:35–2:50 | Built and tested | Switch to the GitHub tab; show `saathi_chatbot_voiceflow/` and the test run (`npm test` → 308 passed) | 308 passed, 0 failed | "Behind the chat are eleven function tools with 308 automated tests, deployed to Voiceflow from the same files." |
| 2:50–3:00 | Close | (show the deck's impact slide, slide 7) | 7.4% → 16.5% activation, −55% cost per SMB | "Recovering half the process drop-offs more than doubles activations and cuts acquisition cost by 55%. Thank you." |

**If a scene goes wrong while recording:** stop, start a new conversation and record that scene again; join the clips
afterwards. Don't show a reply that invents a price or promises 72 hours on a firm-date order: those are exactly the
failures the judges will look for.

**Upload:** export at 1080p, under 3:00, and add the video link next to the repository link wherever the submission asks.
