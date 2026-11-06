"""Build the Airtel SYNC 2026 (Track A, Project Udyam Digital) 7-slide submission deck
on top of the official Submission Template_Sync.pptx backgrounds."""
import io
import pathlib
import sys

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

SP = pathlib.Path(__file__).parent
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else SP / "deck_raw.pptx"

TEAM = "buri buri zaimon"  # as registered on Unstop
MEMBERS = "Prohorj Babu Bormon  ·  Mubashir Afzal"
CAMPUS = "NIT Karnataka (NITK)"
REPO = "github.com/praharj123barman-glitch/airtel-sync-saathi"

# ---------- tokens ----------
RED = RGBColor(0xE4, 0x00, 0x00)
RED_SOFT = RGBColor(0xF6, 0xB4, 0xB4)
INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x5F, 0x63, 0x68)
LINE = RGBColor(0xE2, 0xE3, 0xE7)
TINT = RGBColor(0xFD, 0xEC, 0xEC)
PANEL = RGBColor(0xF4, 0xF5, 0xF7)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
PINKTXT = RGBColor(0xFF, 0xC2, 0xC2)

F, FM, FS = "Poppins", "Poppins Medium", "Poppins SemiBold"
I = Inches


# ---------- helpers ----------
def _run(p, t, size, color, font, bold=False, italic=False, spc=None):
    r = p.add_run()
    r.text = t
    f = r.font
    f.size = Pt(size)
    f.name = font
    f.bold = bold
    f.italic = italic
    f.color.rgb = color
    rpr = r._r.get_or_add_rPr()
    if spc:
        rpr.set("spc", str(spc))
    # make East-Asian / complex-script fall back to the same face
    for tag in ("a:ea", "a:cs"):
        el = rpr.find(qn(tag))
        if el is None:
            el = etree.SubElement(rpr, qn(tag))
        el.set("typeface", font)
    return r


def fill_tf(tf, paras, size=8, color=INK, font=F, bold=False, align=PP_ALIGN.LEFT,
            anchor=MSO_ANCHOR.TOP, ls=None, sa=0, margin=(0, 0, 0, 0)):
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left, tf.margin_top, tf.margin_right, tf.margin_bottom = (I(m) for m in margin)
    tf.vertical_anchor = anchor
    if isinstance(paras, (str, tuple)):
        paras = [paras]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        opts = {}
        if isinstance(para, dict):
            opts = para
            runs = para["runs"]
        else:
            runs = para if isinstance(para, list) else [para]
        p.alignment = opts.get("align", align)
        if opts.get("ls", ls):
            p.line_spacing = opts.get("ls", ls)
        p.space_after = Pt(opts.get("sa", sa))
        if opts.get("sb"):
            p.space_before = Pt(opts["sb"])
        for run in runs:
            if isinstance(run, str):
                _run(p, run, size, color, font, bold)
            else:
                t, o = run
                _run(p, t, o.get("size", size), o.get("color", color), o.get("font", font),
                     o.get("bold", bold), o.get("italic", False), o.get("spc"))


def text(slide, x, y, w, h, paras, **kw):
    tb = slide.shapes.add_textbox(I(x), I(y), I(w), I(h))
    fill_tf(tb.text_frame, paras, **kw)
    return tb


def rect(slide, x, y, w, h, fill=None, line=None, lw=0.75, radius=None, shape=None):
    st = shape or (MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE)
    s = slide.shapes.add_shape(st, I(x), I(y), I(w), I(h))
    if radius and st == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = min(0.5, radius / min(w, h))
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(lw)
    s.shadow.inherit = False
    s.text_frame.text = ""
    return s


def boxed(slide, x, y, w, h, paras, fill=None, line=None, radius=None, lw=0.75, shape=None, **kw):
    s = rect(slide, x, y, w, h, fill=fill, line=line, radius=radius, lw=lw, shape=shape)
    kw.setdefault("margin", (0.06, 0.03, 0.06, 0.03))
    fill_tf(s.text_frame, paras, **kw)
    return s


def alpha(shape, opacity_pct, which="fill"):
    if which == "fill":
        sf = shape.fill._xPr.find(qn("a:solidFill"))
    else:
        sf = shape.line._get_or_add_ln().find(qn("a:solidFill"))
    clr = sf[0]
    a = etree.SubElement(clr, qn("a:alpha"))
    a.set("val", str(int(opacity_pct * 1000)))


def hline(slide, x, y, w, color=LINE, weight=0.6):
    # thin filled rectangle: crisper than a themed connector (no inherited effects)
    return rect(slide, x, y - weight / 144, w, weight / 72, fill=color)


def arrow(slide, x1, y1, x2, y2, color=MUTED, weight=1.25):
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, I(x1), I(y1), I(x2), I(y2))
    c.line.color.rgb = color
    c.line.width = Pt(weight)
    ln = c.line._get_or_add_ln()
    te = etree.SubElement(ln, qn("a:tailEnd"))
    te.set("type", "triangle")
    te.set("w", "med")
    te.set("len", "med")
    return c


def dot(slide, cx, cy, d, level, accent=INK):
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, I(cx - d / 2), I(cy - d / 2), I(d), I(d))
    s.shadow.inherit = False
    if level == 2:
        s.fill.solid(); s.fill.fore_color.rgb = accent
        s.line.fill.background()
    elif level == 1:
        s.fill.solid(); s.fill.fore_color.rgb = RED_SOFT if accent == RED else RGBColor(0xB9, 0xBC, 0xC2)
        s.line.fill.background()
    else:
        s.fill.background()
        s.line.color.rgb = RGBColor(0xB9, 0xBC, 0xC2)
        s.line.width = Pt(0.9)
    return s


def strip_placeholders(slide):
    for ph in list(slide.placeholders):
        ph._element.getparent().remove(ph._element)


def header(slide, num, kicker, headline):
    text(slide, 0.45, 0.70, 6.0, 0.2,
         [[(f"{num}  ", {"color": RED, "font": FS, "spc": 60}),
           (kicker.upper(), {"color": MUTED, "font": FS, "spc": 120})]], size=7.5)
    text(slide, 0.45, 0.90, 9.1, 0.62, headline, size=15.5, font=F, bold=True, color=INK, ls=1.0)


def footer(slide, s):
    text(slide, 0.45, 5.19, 7.75, 0.3, s, size=6, color=MUTED, ls=1.05, anchor=MSO_ANCHOR.TOP)


def notes(slide, s):
    slide.notes_slide.notes_text_frame.text = s


# ---------- deck ----------
prs = Presentation(str(SP / "tpl" / "template.pptx"))
cover, s2 = prs.slides[0], prs.slides[1]
bg_blob = [sh for sh in s2.shapes if sh.shape_type == 13][0].image.blob
content_layout = s2.slide_layout


def new_content_slide():
    s = prs.slides.add_slide(content_layout)
    strip_placeholders(s)
    pic = s.shapes.add_picture(io.BytesIO(bg_blob), 0, 0, prs.slide_width, prs.slide_height)
    pic.name = "Background"
    return s


# ============ SLIDE 1 — COVER ============
s = cover
strip_placeholders(s)
text(s, 0.62, 2.72, 3.9, 0.2, "PROJECT UDYAM DIGITAL  ·  ENTERPRISE TRACK A",
     size=7.5, font=FS, color=PINKTXT)
text(s, 0.62, 2.92, 3.9, 0.55, "Accel Saathi", size=30, bold=True, color=WHITE)
text(s, 0.62, 3.47, 3.6, 0.62,
     "An AI business advisor that discovers, quotes, verifies and activates an MSME bundle "
     "in one sitting: on WhatsApp, in the owner's language.",
     size=9.5, color=WHITE, ls=1.12)
chips = ["7.4% → 16.5% activation", "Live in ≤5 days, not 17.6", "₹15k → ₹6.7k per SMB"]
cx = 0.62
for c in chips:
    w = 1.17
    b = boxed(s, cx, 4.18, w, 0.24, [[(c, {})]], fill=WHITE, line=WHITE, radius=0.12,
              size=6.4, font=FM, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE,
              margin=(0.02, 0, 0.02, 0))
    alpha(b, 14)
    alpha(b, 45, which="line")
    cx += w + 0.07
text(s, 0.62, 4.56, 4.0, 0.2, [[(f"Team {TEAM}", {"bold": True}), (f"  ·  {CAMPUS}", {})]], size=9, color=WHITE)
text(s, 0.62, 4.76, 4.0, 0.18, MEMBERS, size=7.5, color=PINKTXT)
text(s, 0.62, 4.94, 4.0, 0.18, f"Prototype + code: {REPO}", size=6.5, color=PINKTXT)
notes(s, "Accel Saathi: a digital-first acquisition and onboarding journey for Accel Business. "
         "One conversation on the owner's phone replaces a 17.6-day, field-led process. "
         "The prototype is built and tested: a Voiceflow agent with five playbooks and eleven tested function "
         "tools, a demo site and a back-office page; the code is public on GitHub. "
         "All numbers in this deck come from our analysis of the case data pack (smb_leads.csv, "
         "product_catalogue.csv, mock registries).")

# ============ SLIDE 2 — PROBLEM ============
s = s2
header(s, "01", "The problem",
       "Only 7 in 100 MSME leads get activated, and over a third of drop-offs come from "
       "our own process, not from price or demand")

# --- funnel (left)
text(s, 0.45, 1.62, 3.2, 0.22, "Lead funnel, Apr–Jun 2026", size=8.5, font=FS)
text(s, 3.55, 1.65, 1.3, 0.2, "% of previous stage", size=6.5, color=MUTED, align=PP_ALIGN.RIGHT)
stages = [("Leads generated", 5000, "—"), ("Contacted", 3406, "68%"), ("Needs assessed", 1974, "58%"),
          ("Quote accepted", 861, "44%"), ("KYC complete", 588, "68%"), ("Activated", 368, "63%")]
bx, maxw, y0, step, bh = 1.6, 2.1, 1.95, 0.365, 0.26
for i, (lab, n, pct) in enumerate(stages):
    y = y0 + i * step
    hi = lab == "Quote accepted"
    text(s, 0.45, y, 1.12, bh, lab, size=7.5, font=FS if hi else F, color=INK, anchor=MSO_ANCHOR.MIDDLE)
    w = maxw * n / 5000
    b = rect(s, bx, y, w, bh, fill=RED if hi else RGBColor(0xC9, 0xCB, 0xD0))
    text(s, bx + w + 0.06, y, 0.6, bh, f"{n:,}", size=7.5, font=FS, color=INK, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 4.3, y, 0.55, bh, pct, size=7.5, font=FS if hi else F, color=RED if hi else MUTED,
         align=PP_ALIGN.RIGHT, anchor=MSO_ANCHOR.MIDDLE)
text(s, 2.5, y0 + 3 * step, 1.75, bh, "← steepest drop in the funnel",
     size=6.4, color=RED, font=FM, anchor=MSO_ANCHOR.MIDDLE)

# KPI tiles
tiles = [("17.6 days", "average from lead to activation"),
         ("₹15,053", "to acquire one SMB, vs a ₹6,900/mo median bundle"),
         ("3×", "each customer chased status before going live")]
for i, (big, lab) in enumerate(tiles):
    x = 0.45 + i * 1.5
    rect(s, x, 4.32, 1.4, 0.74, fill=PANEL, radius=0.07)
    text(s, x + 0.1, 4.38, 1.25, 0.3, big, size=13, bold=True, color=INK)
    text(s, x + 0.1, 4.68, 1.25, 0.36, lab, size=6.4, color=MUTED, ls=1.05)

# --- leaks (right)
text(s, 5.1, 1.62, 4.45, 0.22,
     [[("1,652 of 4,632 drop-offs (36%) ", {"font": FS}),
       ("are process failures we can remove", {})]], size=8.5)
leaks = [
    ("827", "Stalled waiting for a sales visit", "Owner had no time 531 · visit never scheduled 296",
     "AI advisor, any time"),
    ("385", "Quote too slow or too complex", "3–5 day PDF full of product codes: 179 slow · 206 confusing",
     "Instant one-price quote"),
    ("273", "Stuck in KYC paperwork", "Missing GST/Udyam 94 · too long 79 · signatory away 53 · mismatch 47",
     "Smart KYC"),
    ("167", "Lost after KYC", "Install >21 days 98 · fibre not feasible 41 · first payment failed 28",
     "Feasibility check + tracker"),
]
for i, (n, title, det, fix) in enumerate(leaks):
    y = 1.92 + i * 0.585
    rect(s, 5.1, y, 4.45, 0.52, fill=WHITE, line=LINE, radius=0.06)
    text(s, 5.18, y, 0.62, 0.52, n, size=14, bold=True, color=INK, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 5.84, y + 0.06, 2.45, 0.2, title, size=7.8, font=FS)
    text(s, 5.84, y + 0.25, 2.45, 0.26, det, size=6.2, color=MUTED, ls=1.0)
    boxed(s, 8.33, y + 0.11, 1.14, 0.3, [[("→ " + fix, {})]], fill=TINT, radius=0.08, size=6.4,
          font=FS, color=RED, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=(0.04, 0, 0.04, 0))

callouts = [("54%", "of activated bundles held none of the products the owner asked about: "
                    "pitches follow targets, not needs"),
            ("22", "activations (6%) went live on cancelled or suspended GSTINs that manual KYC let through")]
for i, (big, lab) in enumerate(callouts):
    x = 5.1 + i * 2.28
    rect(s, x, 4.32, 2.17, 0.74, fill=TINT, radius=0.07)
    text(s, x + 0.1, 4.32, 0.62, 0.74, big, size=15, bold=True, color=RED, anchor=MSO_ANCHOR.MIDDLE)
    text(s, x + 0.72, 4.32, 1.37, 0.74, lab, size=6.4, color=INK, anchor=MSO_ANCHOR.MIDDLE, ls=1.05)
footer(s, "Source: team analysis of smb_leads.csv (5,000 synthetic leads, Apr–Jun 2026) and mock_gstin_registry.csv. "
          "Drop reasons grouped by the last stage reached; ‘process failures’ = reasons a digital journey removes directly.")
notes(s, "The demand is there: 5,000 leads a quarter. But only 368 activate. The biggest leak is between needs "
         "assessment and quote acceptance (44%). When we read the drop reasons, 1,652 of 4,632 losses are "
         "process failures: owners waiting for a visit, slow or confusing quotes, paperwork, and installs "
         "that slip past 21 days. Two hidden costs: in 54% of activations the bundle sold contained none of "
         "what the owner asked for, and 22 activations went live on cancelled or suspended GSTINs.")

# ============ SLIDE 3 — SEGMENTS & BUNDLES ============
s = new_content_slide()
header(s, "02", "Who we win first, with what bundle",
       "Go digital-first with offices and micro retail; point the field force at the 21% of leads "
       "that bring 73% of new revenue")
segs = [
    dict(name="Professional offices", sub="25% of leads · clinics, CA firms, coaching",
         chip="WAVE 1 · DIGITAL-FIRST", chipfill=RED, chiptxt=WHITE,
         m=[("Activation rate", "11.1%", 0), ("Median bundle / month", "₹6,575", 0),
            ("Cost per activation", "₹10,695", 0), ("Months of revenue to repay CAC", "1.6", 0),
            ("6-month churn", "13.8%", 0)],
         bname="Office Pro", price="₹4,815–6,138/mo",
         items="Biz Fibre 300 + 4G/5G failover · 2–3 business postpaid · cloud email and endpoint "
               "security per desk · 1 TB backup",
         term="12 months · ₹1,500 one-time", how="Saathi self-serve: WhatsApp + web"),
    dict(name="Micro retail & services", sub="54% of leads · kirana, salon, pharmacy",
         chip="WAVE 1 · ZERO-TOUCH", chipfill=RED, chiptxt=WHITE,
         m=[("Activation rate", "4.1%", 1), ("Median bundle / month", "₹2,470", 0),
            ("Cost per activation", "₹20,007", 1), ("Months of revenue to repay CAC", "8.1", 1),
            ("6-month churn", "22.7%", 1)],
         bname="Dukaan Digital", price="from ₹1,198/mo",
         items="5G AirFiber (live in 2 days) or Biz Fibre 100 · 1–2 business postpaid · add Cloud POS, "
               "CCTV, WhatsApp catalogue",
         term="6–12 months · ₹0 setup on core", how="Saathi self-serve + partner assist"),
    dict(name="Small multi-site", sub="15% of leads · 3–10 store chains",
         chip="WAVE 2 · DIGITAL-ASSISTED", chipfill=INK, chiptxt=WHITE,
         m=[("Activation rate", "11.0%", 0), ("Median bundle / month", "₹28,080", 0),
            ("Cost per activation", "₹15,614", 0), ("Months of revenue to repay CAC", "0.6", 0),
            ("6-month churn", "10.8%", 0)],
         bname="Chain Connect", price="≈₹2,500/site/mo",
         items="Per site: Biz Fibre 100, failover, secure Wi-Fi, Cloud POS · HQ: postpaid lines, "
               "toll-free · optional SD-WAN",
         term="12–24 months · 8 sites ≈ ₹23,900/mo", how="Saathi qualifies, specialist closes"),
    dict(name="Small manufacturers", sub="6% of leads · auto parts, textiles",
         chip="FIELD-LED · SAATHI TOOLS", chipfill=RGBColor(0xDA, 0xDC, 0xE0), chiptxt=INK,
         m=[("Activation rate", "12.8%", 0), ("Median bundle / month", "₹15,910", 0),
            ("Cost per activation", "₹15,324", 0), ("Months of revenue to repay CAC", "1.0", 0),
            ("6-month churn", "8.1%", 0)],
         bname="Factory Assured", price="₹15,260/mo",
         items="Leased line 20 Mbps (99.5% SLA) + managed firewall · 4 business postpaid · cloud email "
               "· machine-monitoring IoT",
         term="24 months · site survey first", how="Field-led; Saathi for quote + KYC"),
]
cw, gap, cy, ch = 2.155, 0.16, 1.62, 3.47
for i, d in enumerate(segs):
    x = 0.45 + i * (cw + gap)
    rect(s, x, cy, cw, ch, fill=WHITE, line=LINE, radius=0.08)
    text(s, x + 0.12, cy + 0.1, cw - 0.24, 0.24, d["name"], size=9.5, bold=True)
    text(s, x + 0.12, cy + 0.33, cw - 0.24, 0.2, d["sub"], size=6.3, color=MUTED)
    boxed(s, x + 0.12, cy + 0.58, 1.55, 0.21, [[(d["chip"], {"spc": 40})]], fill=d["chipfill"], radius=0.1,
          size=6, font=FS, color=d["chiptxt"], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE,
          margin=(0.03, 0, 0.03, 0))
    for j, (lab, val, bad) in enumerate(d["m"]):
        yy = cy + 0.9 + j * 0.21
        text(s, x + 0.12, yy, 1.45, 0.21, lab, size=6.3, color=MUTED, anchor=MSO_ANCHOR.MIDDLE)
        text(s, x + 1.4, yy, 0.63, 0.21, val, size=7.3, font=FS, color=RED if bad else INK,
             align=PP_ALIGN.RIGHT, anchor=MSO_ANCHOR.MIDDLE)
        if j < 4:
            hline(s, x + 0.12, yy + 0.21, cw - 0.24)
    by = cy + 2.0
    rect(s, x + 0.08, by, cw - 0.16, 1.0, fill=TINT, radius=0.07)
    text(s, x + 0.18, by + 0.06, cw - 0.36, 0.17, d["bname"].upper(), size=6.3, font=FS, color=INK)
    text(s, x + 0.18, by + 0.21, cw - 0.36, 0.24, d["price"], size=10, bold=True, color=RED)
    text(s, x + 0.18, by + 0.46, cw - 0.36, 0.36, d["items"], size=6, color=INK, ls=1.0)
    text(s, x + 0.18, by + 0.81, cw - 0.36, 0.16, d["term"], size=6, color=MUTED, font=FM)
    text(s, x + 0.12, cy + 3.06, cw - 0.24, 0.14, "HOW WE SELL", size=5.6, font=FS, color=MUTED)
    text(s, x + 0.12, cy + 3.2, cw - 0.24, 0.2, d["how"], size=6.8, font=FS, color=INK)
footer(s, "Metrics: smb_leads.csv, Apr–Jun 2026. Prices = catalogue floor price for the committed term (product_catalogue.csv); "
          "GST-only products are offered only to verified GSTINs. Months to repay CAC = cost per activation ÷ median monthly bundle.")
notes(s, "We prioritise by where a digital journey changes the economics. Professional offices convert well, "
         "standardise easily and repay acquisition cost in 1.6 months: that is our pilot. Micro retail is 54% "
         "of leads but costs ₹20k to acquire against a ₹2.5k bundle (8 months to repay), and it takes 40% of "
         "acquisition spend for 6% of new revenue. Only a zero-touch journey fixes that. Multi-site and "
         "manufacturers are 21% of leads but 73% of new monthly revenue: that is where the field force should "
         "spend its time, with Saathi handling quote, KYC and tracking.")

# ============ SLIDE 4 — SOLUTION JOURNEY ============
s = new_content_slide()
header(s, "03", "The solution: Saathi journey and prototype",
       "Saathi replaces a 17.6-day, field-led process with one 10-minute conversation on the owner's phone")
steps = [
    ("Advisor", "The owner shares a GSTIN (or Udyam number): Saathi reads the registries and proposes a "
                "bundle with zero questions for 73% of GSTINs; otherwise it asks 1–5.",
     "Targets 827 visit drop-offs", "phone1.png"),
    ("Quote & checkout", "One monthly price from a rules engine, never the LLM. Add-ons and term toggle live; "
                         "every quote carries a guarantee: 72 h or a firm date.",
     "Targets 385 slow / confusing quotes", "phone2.png"),
    ("Smart KYC", "Consent per purpose first. GSTIN checksum and registry status block dead GSTINs; a "
                  "certificate photo is read by OCR on the phone.",
     "Targets 273 paperwork drops", "phone3.png"),
    ("Tracker", "Counts down to the quote's guarantee and credits month one if missed. Proactive updates "
                "and outage credits replace the 3 chase calls.",
     "Targets 167 post-KYC losses", "phone4.png"),
]
top, bottom = 1.62, 4.5
pw = 1.32
ph_full = pw * 1740 / 840
for i, (title, desc, chip, img) in enumerate(steps):
    x = 0.45 + i * (cw + gap)
    rect(s, x, top, cw, bottom - top, fill=PANEL, radius=0.08)
    boxed(s, x + 0.12, top + 0.12, 0.26, 0.26, [[(str(i + 1), {})]], fill=RED, shape=MSO_SHAPE.OVAL,
          size=8, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=(0, 0, 0, 0))
    text(s, x + 0.46, top + 0.12, cw - 0.55, 0.26, title, size=9.5, bold=True, anchor=MSO_ANCHOR.MIDDLE)
    text(s, x + 0.12, top + 0.44, cw - 0.24, 0.52, desc, size=6.2, color=INK, ls=1.02)
    boxed(s, x + 0.12, top + 0.97, cw - 0.24, 0.2, [[(chip, {})]], fill=WHITE, radius=0.1, size=6,
          font=FS, color=RED, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=(0.03, 0, 0.03, 0))
    ptop = top + 1.24
    vis = bottom - ptop
    pic = s.shapes.add_picture(str(SP / "mock" / img), I(x + (cw - pw) / 2), I(ptop), I(pw), I(ph_full))
    pic.crop_bottom = 1 - vis / ph_full
    pic.height = I(vis)

# humans in the loop strip
boxed(s, 0.45, 4.6, 1.3, 0.5, [[("People stay in the loop", {})]], fill=INK, radius=0.07, size=7.5,
      bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE, margin=(0.1, 0, 0.08, 0))
loop = [("CA partners and customers ", "refer with a checked code; rewards are paid only after the "
                                      "business stays 90 days."),
        ("Field sales ", "focus on multi-site and factories (73% of new revenue); every Saathi hand-off "
                         "arrives with full context."),
        ("Back office ", "works a queue of leads Saathi couldn't close, ranked by a propensity model: "
                         "the top 20% hold 40% of activations.")]
for i, (b, t) in enumerate(loop):
    x = 1.88 + i * 2.57
    text(s, x, 4.6, 2.45, 0.5, [[(b, {"font": FS, "color": RED}), (t, {})]], size=6.3, color=INK,
         anchor=MSO_ANCHOR.MIDDLE, ls=1.05)
footer(s, "Built and tested in Voiceflow: 5 playbooks, 11 function tools, 308 automated tests. Zero-question share measured on all "
          "3,534 registry GSTINs; Udyam entry covers 42.6% of leads without a GSTIN. Screens: lead L00068, IDs masked. Lead score AUC 0.71.")
notes(s, "Four steps, one sitting. The journey starts from the GSTIN: Saathi reads the GST and Udyam registries "
         "and proposes a bundle with no questions for 73% of registered businesses; owners without a GSTIN can "
         "start with their Udyam number. Prices and eligibility come from a rules engine, never the LLM. Every "
         "quote carries an activation guarantee: 72 hours where the data supports it (small single-site "
         "businesses in tier-1 cities), a firm date elsewhere, month one free if missed. Smart KYC asks consent "
         "per purpose, blocks cancelled GSTINs and reads a certificate photo on the phone. The tracker replaces "
         "chase calls; in the data, customers who chased five times churned at 28% versus 6% for one.")

# ============ SLIDE 5 — ARCHITECTURE & PRIVACY ============
s = new_content_slide()
header(s, "04", "Architecture and trust",
       "Rules decide, GenAI explains: every price and KYC decision is deterministic, auditable and "
       "built for the DPDP Act, 2023")
LX, CX0, CW_ = 0.45, 1.27, 4.88
layer_lab = [("CHANNELS", 1.62, 0.36), ("CORE", 2.13, 0.38), ("SERVICES", 2.69, 1.1), ("DATA & APIs", 3.97, 1.1)]
for lab, y, h in layer_lab:
    text(s, LX, y, 0.78, h, lab, size=5.8, font=FS, color=MUTED, anchor=MSO_ANCHOR.MIDDLE)
chans = ["Web chat widget", "WhatsApp *", "Voice / IVR *", "Back-office page"]
pw_ = (CW_ - 3 * 0.08) / 4
for i, c in enumerate(chans):
    boxed(s, CX0 + i * (pw_ + 0.08), 1.62, pw_, 0.36, [[(c, {})]], fill=WHITE, line=RGBColor(0xC9, 0xCB, 0xD0),
          radius=0.08, size=7, font=FS, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
arrow(s, CX0 + CW_ / 2, 1.99, CX0 + CW_ / 2, 2.12)
boxed(s, CX0, 2.13, CW_, 0.38,
      [[("Voiceflow agent  ", {"font": FS}),
        ("global prompt · 5 playbooks · 11 tested function tools · consent checkpoint", {})]],
      fill=INK, radius=0.06, size=6.8, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
arrow(s, CX0 + CW_ / 2, 2.52, CX0 + CW_ / 2, 2.67)
svc = [("GenAI advisor", "LLM with tool calls: asks, explains, translates. Never sets a price."),
       ("Rules & pricing", "price_bundle: catalogue, eligibility and the quote's guarantee. Deterministic."),
       ("Smart KYC", "GSTIN checksum & status, Udyam entry, consent per purpose; OCR of a GST certificate."),
       ("Orders & tracker", "Counts down to the quoted guarantee; month-one and outage credits."),
       ("Lead routing", "Lead score (AUC 0.71), referral codes, territory rep for Hot leads.")]
sw = (CW_ - 4 * 0.07) / 5
for i, (t, d_) in enumerate(svc):
    x = CX0 + i * (sw + 0.07)
    rect(s, x, 2.69, sw, 1.1, fill=TINT, radius=0.06)
    rect(s, x, 2.69, sw, 0.04, fill=RED)
    text(s, x + 0.07, 2.78, sw - 0.12, 0.2, t, size=6.8, font=FS, color=INK)
    text(s, x + 0.07, 2.99, sw - 0.12, 0.78, d_, size=5.8, color=INK, ls=1.05)
arrow(s, CX0 + CW_ / 2, 3.8, CX0 + CW_ / 2, 3.95)
groups = [("In the prototype (case data)", ["Catalogue · 25 products", "GST registry · 3,534", "Udyam registry · 2,723",
                                            "Knowledge base · 4 docs", "Lead queue (Sheet)", "Consent record"]),
          ("Mocked now, real in production", ["DigiLocker", "Aadhaar e-Sign", "UPI Autopay", "WhatsApp Business API",
                                              "CRM / BSS-OSS", "Network monitoring"])]
gw = (CW_ - 0.08) / 2
for i, (gt, items) in enumerate(groups):
    gx = CX0 + i * (gw + 0.08)
    rect(s, gx, 3.97, gw, 1.1, fill=PANEL, radius=0.06)
    text(s, gx + 0.08, 4.02, gw - 0.16, 0.18, gt, size=6.5, font=FS, color=INK)
    iw = (gw - 0.16 - 0.06) / 2
    for k, it in enumerate(items):
        ix = gx + 0.08 + (k % 2) * (iw + 0.06)
        iy = 4.24 + (k // 2) * 0.27
        boxed(s, ix, iy, iw, 0.22, [[(it, {})]], fill=WHITE, line=LINE, radius=0.08, size=5.8,
              align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, margin=(0.02, 0, 0.02, 0))

# privacy panel
PX, PW = 6.38, 3.17
rect(s, PX, 1.62, PW, 3.45, fill=TINT, radius=0.08)
text(s, PX + 0.15, 1.72, PW - 0.3, 0.22, "Privacy by design · DPDP Act, 2023", size=8.5, bold=True)
priv = [("Consent", "Three purposes asked separately (registry lookup, KYC, offers), nothing pre-ticked, in "
                    "the owner's language; each withdrawable any time in the chat."),
        ("Purpose limitation", "KYC data is used only to verify and activate the order. Never for marketing, "
                               "never to train models."),
        ("Data minimisation", "Lookup before upload: if GSTIN and Udyam verify, no certificate is collected. "
                              "We store extracted fields, not images."),
        ("Masking & access", "GSTIN, Udyam and phone shown masked; the lead score sees business fields only, never "
                             "a name or phone; partners see only their own leads."),
        ("Retention", "A certificate photo is read on the owner's phone and never uploaded; the KYC record is "
                      "kept only as long as telecom KYC rules require.")]
for i, (t, d_) in enumerate(priv):
    y = 2.02 + i * 0.6
    text(s, PX + 0.15, y, PW - 0.3, 0.58,
         [{"runs": [(t, {"font": FS, "color": RED, "size": 7})], "sa": 1},
          {"runs": [(d_, {})], "ls": 1.05}], size=6.3, color=INK)
footer(s, "Built: Voiceflow agent + 11 JavaScript function tools (the rules, 308 automated tests) · demo site with in-browser OCR · back-office page. "
          f"* Voiceflow channels for the same agent, not switched on yet. Code: {REPO}")
notes(s, "The design principle is simple: the LLM never decides anything that has money or compliance attached. "
         "It asks questions, explains and translates; eleven tested function tools set eligibility, price and the "
         "activation guarantee from the catalogue and the case data, so every answer is reproducible and auditable. "
         "Smart KYC runs a GSTIN checksum and registry status check (which would have blocked the 22 cancelled or "
         "suspended GSTINs) and lets owners without a GSTIN start with their Udyam number. Privacy follows the DPDP "
         "Act: consent per purpose, lookup before upload, masking, and short retention. The prototype runs in "
         "Voiceflow today; WhatsApp and voice are channels of the same agent.")

# ============ SLIDE 6 — COMPETITIVE ANALYSIS ============
s = new_content_slide()
header(s, "05", "Competitive analysis",
       "Rivals offer either a bundle or a fast sign-up, never both: Saathi pairs Accel's install network "
       "with a zero-wait journey")
crit = ["Full stack on one bill", "Needs-based advice", "Instant, clear price", "Paperless KYC",
        "Regional languages", "Self-serve tracking", "On-ground install network"]
players = [("Saathi (prototype)", "Accel Business", [2, 2, 2, 2, 2, 2, 2]),
           ("Accel Business today", "field sales, one product at a time", [1, 0, 0, 0, 1, 0, 2]),
           ("JioBusiness", "7 fixed tiers from ₹901/mo (2021 launch)", [2, 0, 2, 1, 1, 1, 2]),
           ("Vi Business", "ReadyForNext self-assessment", [1, 1, 1, 0, 0, 0, 1]),
           ("Tata Tele Business", "Smartflo, Smart Internet", [1, 0, 0, 0, 0, 0, 1]),
           ("Digital-first SaaS", "WhatsApp API, cloud telephony, POS", [0, 1, 2, 1, 1, 2, 0]),
           ("Local ISP / reseller", "relationship-led, separate bills", [1, 1, 1, 0, 2, 0, 2])]
MX, MW, PCW = 0.45, 6.2, 1.78
ccw = (MW - PCW) / len(crit)
for j, c in enumerate(crit):
    text(s, MX + PCW + j * ccw, 1.62, ccw, 0.46, c, size=6.2, font=FS, color=INK,
         align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.BOTTOM, ls=1.0)
rh, ry0 = 0.385, 2.14
for i, (p, sub, sc) in enumerate(players):
    y = ry0 + i * rh
    us = i == 0
    if us:
        rect(s, MX, y + 0.02, MW, rh - 0.04, fill=TINT, line=RED, lw=1, radius=0.06)
    elif i % 2 == 0:
        rect(s, MX, y + 0.02, MW, rh - 0.04, fill=PANEL, radius=0.06)
    text(s, MX + 0.1, y + 0.04, PCW - 0.12, rh - 0.08,
         [{"runs": [(p, {"font": FS if not us else F, "bold": us, "color": RED if us else INK, "size": 7.2})]},
          {"runs": [(sub, {"size": 5.6, "color": MUTED})]}], anchor=MSO_ANCHOR.MIDDLE, ls=1.0)
    for j, lv in enumerate(sc):
        dot(s, MX + PCW + j * ccw + ccw / 2, y + rh / 2, 0.14, lv, accent=RED if us else INK)
ly = ry0 + len(players) * rh + 0.05
lx = MX + 0.1
for lv, lab in [(2, "offered"), (1, "partial"), (0, "not evident in public information")]:
    dot(s, lx + 0.06, ly + 0.08, 0.11, lv)
    text(s, lx + 0.16, ly, 2.0, 0.16, lab, size=6, color=MUTED, anchor=MSO_ANCHOR.MIDDLE)
    lx += 0.75 if lv else 0

WX, WW = 6.85, 2.7
text(s, WX, 1.62, WW, 0.22, "Where Saathi wins", size=8.5, bold=True)
wins = [("1", "Right-sized, not fixed tiers",
         "Saathi sizes the bundle to the business, which tackles the 414 ‘price too high’ drop-offs "
         "without a price war."),
        ("2", "Network + digital speed",
         "SaaS players sign up in minutes but can't lay fibre or fit CCTV. Accel can do both in one "
         "order, on one bill."),
        ("3", "A warm base to start from",
         "38% of leads already use Accel, mostly mobile-only: Saathi can reach them on WhatsApp and "
         "pre-fill identity.")]
for i, (n, t, d_) in enumerate(wins):
    y = 1.92 + i * 0.83
    text(s, WX, y, 0.3, 0.3, n, size=14, bold=True, color=RED)
    text(s, WX + 0.32, y + 0.02, WW - 0.32, 0.78,
         [{"runs": [(t, {"font": FS, "size": 7.4})], "sa": 1}, {"runs": [(d_, {})], "ls": 1.05}],
         size=6.4, color=INK)
boxed(s, WX, 4.43, WW, 0.64,
      [[("Watch-out: ", {"font": FS, "color": RED}),
        ("JioBusiness entry tier starts at ₹901/mo. We answer with value, not price: Dukaan Digital from "
         "₹1,198 includes a business line and a 2-day AirFiber install.", {})]],
      fill=PANEL, radius=0.07, size=6.2, color=INK, anchor=MSO_ANCHOR.MIDDLE, ls=1.05,
      margin=(0.1, 0.04, 0.1, 0.04))
footer(s, "Sources: JioBusiness launch coverage (Business Today, DQ India, Mar 2021); Vi Business ReadyForNext and PayU releases "
          "(2024–26); TTBS Smartflo / Smart Internet coverage; team assessment of public information, Nov 2026. "
          "Accel share of leads: smb_leads.csv.")
notes(s, "Every competitor gets one half of the problem right. JioBusiness has bundles and published prices "
         "but fixed tiers. Digital-first SaaS players sign up instantly but only for one product and can't "
         "install anything physical. Local resellers speak the owner's language but run on paper and separate "
         "bills. Saathi is the only model that combines a needs-based advisor, instant price, paperless KYC and "
         "tracking with an on-ground install network. Our warm start: 38% of leads already use Accel.")

# ============ SLIDE 7 — IMPACT & ROLLOUT ============
s = new_content_slide()
header(s, "06", "Impact, metrics and rollout",
       "Recovering half the process-driven drop-offs takes activation from 7.4% to 16.5% and cuts "
       "acquisition cost by 55%")
cols = [("Success metric", 2.3, PP_ALIGN.LEFT), ("Today", 0.88, PP_ALIGN.CENTER),
        ("6-month target", 0.92, PP_ALIGN.CENTER), ("12-month target", 0.95, PP_ALIGN.CENTER)]
TX, TY, RH = 0.45, 1.62, 0.3
tw = sum(c[1] for c in cols)
rect(s, TX, TY, tw, RH, fill=INK, radius=0.05)
cx = TX
for lab, w, al in cols:
    text(s, cx + (0.1 if al == PP_ALIGN.LEFT else 0), TY, w - 0.1 if al == PP_ALIGN.LEFT else w, RH, lab,
         size=6.8, font=FS, color=WHITE, align=al, anchor=MSO_ANCHOR.MIDDLE)
    cx += w
rows = [("Lead → activation conversion", "7.4%", "12%", "16%"),
        ("Days from lead to activation", "17.6", "≤ 7", "≤ 5"),
        ("Cost per activated SMB", "₹15,053", "₹9,100", "₹6,700"),
        ("Status chases per customer", "3.0", "1.0", "≤ 0.5"),
        ("6-month churn", "15.2%", "12%", "≤ 10%"),
        ("Guardrail: activations on invalid GSTIN", "22", "0", "0")]
for i, r in enumerate(rows):
    y = TY + RH * (i + 1)
    if i == len(rows) - 1:
        rect(s, TX, y + 0.02, tw, RH - 0.02, fill=PANEL, radius=0.04)
    cx = TX
    for k, (val, (lab, w, al)) in enumerate(zip(r, cols)):
        style = dict(size=7.2, color=INK, font=F)
        if k == 0:
            style.update(font=FM)
        if k == 1:
            style.update(color=MUTED)
        if k == 3:
            style.update(color=RED, font=FS)
        text(s, cx + (0.1 if k == 0 else 0), y, w - (0.1 if k == 0 else 0), RH, val,
             align=al, anchor=MSO_ANCHOR.MIDDLE, **style)
        cx += w
    if i < len(rows) - 2:
        hline(s, TX, y + RH, tw)

stats = [("2.2×", "activations per 5,000 leads", "368 today → 608 at 6 months → 823 at 12 months"),
         ("−55%", "cost per activated SMB", "₹15,053 → ₹6,729 at today's acquisition spend"),
         ("₹3.8 Cr", "extra annual revenue per quarter of leads", "455 extra activations × ₹6,900 median bundle × 12")]
SX, SW = 5.72, 3.83
for i, (big, lab, det) in enumerate(stats):
    y = 1.62 + i * 0.715
    rect(s, SX, y, SW, 0.64, fill=TINT, radius=0.07)
    text(s, SX + 0.14, y, 1.12, 0.64, big, size=16, bold=True, color=RED, anchor=MSO_ANCHOR.MIDDLE)
    text(s, SX + 1.28, y, SW - 1.38, 0.64,
         [{"runs": [(lab, {"font": FS, "size": 7.4})], "sa": 1}, {"runs": [(det, {})]}],
         size=6.3, color=MUTED, anchor=MSO_ANCHOR.MIDDLE, ls=1.05)

phases = [("PHASE 1 · PILOT · M0–3", RED,
           "2 tier-1 cities · Hindi + English · professional offices · WhatsApp + web · A/B test against a "
           "field-sales control group",
           "Gate: conversion ≥ 10% and CAC ≤ ₹10k"),
          ("PHASE 2 · SCALE · M4–9", INK,
           "Micro retail on Dukaan Digital · all 10 lead languages · voice front end · partner assist mode live",
           "Gate: micro CAC ≤ ₹3k"),
          ("PHASE 3 · EXPAND · M10–18", INK,
           "Multi-site and factories in assisted mode · propensity-routed field queue · national rollout",
           "Gate: 12-month targets met")]
PHW, PHY, PHH = 1.93, 3.9, 1.17
for i, (t, col, body, gate) in enumerate(phases):
    x = 0.45 + i * (PHW + 0.07)
    rect(s, x, PHY, PHW, PHH, fill=WHITE, line=LINE, radius=0.07)
    rect(s, x, PHY + 0.15, PHW, 0.12, fill=col)
    boxed(s, x, PHY, PHW, 0.27, [[(t, {"spc": 30})]], fill=col, radius=0.07, size=6.3, font=FS, color=WHITE,
          anchor=MSO_ANCHOR.MIDDLE, margin=(0.1, 0, 0.06, 0))
    text(s, x + 0.1, PHY + 0.33, PHW - 0.2, 0.56, body, size=6.2, color=INK, ls=1.05)
    text(s, x + 0.1, PHY + 0.92, PHW - 0.2, 0.2, gate, size=6, font=FS, color=RED if i == 0 else MUTED)
RX, RW = 6.55, 3.0
rect(s, RX, PHY, RW, PHH, fill=PANEL, radius=0.07)
text(s, RX + 0.12, PHY + 0.06, RW - 0.24, 0.2, "Key risks → mitigation", size=7.4, font=FS)
risks = [("GenAI mis-sells → ", "rules engine, not the LLM, sets price and eligibility; every answer logged"),
         ("Channel conflict → ", "referral codes credit the partner; paid after 90 days"),
         ("KYC fraud → ", "registry lookups, cross-checks, e-Sign, review queue"),
         ("Costly promises → ", "72 h only where data supports it: ₹93L → ₹52L credits per 1,000 orders")]
text(s, RX + 0.12, PHY + 0.29, RW - 0.24, 0.84,
     [{"runs": [(a, {"font": FS, "color": RED}), (b, {})], "sa": 2.5, "ls": 1.0} for a, b in risks],
     size=6, color=INK)
footer(s, "Model: stage conversion lifted by recovering 30% (6 months) or 50% (12 months) of the 1,652 process-driven drop-offs, "
          "cascaded through the funnel at the same acquisition spend; revenue at the ₹6,900 median bundle. Baselines: smb_leads.csv.")
notes(s, "We set five metrics with targets from a funnel model, not guesses. If Saathi recovers 30% of the "
         "process-driven drop-offs, activation reaches 12% in six months; at 50% it reaches 16.5% and cost per "
         "activated SMB falls from ₹15,053 to ₹6,729 at today's spend. That is about 455 extra customers and "
         "₹3.8 crore of annual revenue from every quarter of leads. We roll out in three gated phases, starting "
         "with professional offices in two cities against a field-sales control group.")

prs.save(str(OUT))
print("saved", OUT)
