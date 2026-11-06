"""
browser_kyc_check.py: browser test of the Smart KYC fallback on 7_demo_site/index.html, with REAL OCR.

What it checks (43 checks): the consent screen asks separately for three purposes with nothing pre-selected; the
certificate reader stays locked until KYC consent; Tesseract.js reads each SAMPLE certificate in the browser; the
GSTIN goes through the same onboarding function as the chat (verified / review / blocked); the GSTIN field takes
a sentence, reports two GSTINs and never shows a status code; Hindi and Kannada;
withdrawing KYC consent deletes what was read; the consent record survives a reload; no horizontal scroll at 375 px;
no console errors.

Needs: Python with Playwright (pip install playwright; python -m playwright install chromium) and an internet
connection (Tesseract.js and its English language data load from the jsDelivr CDN). Run the build first.
Usage: python 6_tests/browser_kyc_check.py . <folder for screenshots>
Sample data: the certificates are SAMPLE images of synthetic registry records (fictional businesses).
"""

import pathlib
import sys

from playwright.sync_api import sync_playwright

kit = pathlib.Path(sys.argv[1]).resolve()
shots = pathlib.Path(sys.argv[2])
shots.mkdir(parents=True, exist_ok=True)
page_url = (kit / "7_demo_site" / "index.html").as_uri()
results = []


def check(name, passed, detail=""):
    results.append((name, passed, detail))
    print(("PASS " if passed else "FAIL ") + name + (f"  [{detail}]" if detail and not passed else ""))


def read_sample(page, sample_id):
    page.click(f"button[data-sample='{sample_id}']")
    page.wait_for_selector("#fields-form:not([hidden])", timeout=180000)
    return {
        "gstin": page.input_value("#field-gstin"),
        "legal": page.input_value("#field-legal-name"),
        "trade": page.input_value("#field-trade-name"),
        "address": page.input_value("#field-address"),
        "notes": page.inner_text("#field-notes"),
    }


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="en-US")
    page = context.new_page()
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(page_url)
    page.wait_for_selector("#consent-purposes fieldset")

    # Consent screen: three separate purposes, nothing pre-selected, reader locked.
    check("consent screen shows three separate purposes", page.locator("#consent-purposes fieldset").count() == 3)
    check("no consent is pre-selected", page.locator("#consent-purposes input:checked").count() == 0)
    check(
        "reader is locked without KYC consent", page.is_disabled("#certificate-file") and page.is_visible("#kyc-gate")
    )
    check("sample buttons are locked without KYC consent", page.is_disabled("button[data-sample='metro_diagnostics']"))
    check(
        "three SAMPLE certificates are offered",
        page.locator("button.sample").count() == 3 and "SAMPLE" in page.inner_text("#samples"),
    )

    page.check("input[name='consent-kyc_verification'][value='yes']")
    check("KYC yes unlocks the reader", page.is_enabled("#certificate-file") and page.is_hidden("#kyc-gate"))
    check("consent change is recorded with a message", "KYC verification: yes" in page.inner_text("#consent-status"))
    check(
        "withdraw button appears for the granted purpose",
        page.locator("fieldset[data-purpose='kyc_verification'] .withdraw").count() == 1,
    )
    page.screenshot(path=str(shots / "kyc_consent_desktop.png"), full_page=False)

    # Real OCR on the active company certificate.
    fields = read_sample(page, "metro_diagnostics")
    print("  OCR metro:", fields)
    check("OCR reads the GSTIN of the Metro sample", fields["gstin"] == "07PUTXM1153M1Z9", fields["gstin"])
    check("OCR reads the legal name", "Metro Diagnostics" in fields["legal"], fields["legal"])
    check("OCR reads the address with the city", "Delhi" in fields["address"], fields["address"])

    # Registry check without registry consent is refused.
    page.click("#verify-button")
    check("registry check needs registry-lookup consent", "registry lookup" in page.inner_text("#verdict").lower())
    page.check("input[name='consent-registry_lookup'][value='yes']")
    page.click("#verify-button")
    page.wait_for_selector("#verdict[data-verdict]")
    verdict_text = page.inner_text("#verdict")
    check(
        "Metro certificate is verified against the registry",
        page.get_attribute("#verdict", "data-verdict") == "verified",
        verdict_text[:120],
    )
    check(
        "verdict shows Saathi's onboarding proposal",
        "Metro Diagnostics" in verdict_text and "Namaste" in verdict_text,
        verdict_text[:200],
    )
    page.screenshot(path=str(shots / "kyc_verified_desktop.png"), full_page=True)

    # The GSTIN field takes what an owner would type (shared gstin_input reader); status codes never reach the page.
    status_codes = ("INVALID_FORMAT", "INVALID_STATE", "CHECKSUM_FAILED", "NOT_FOUND", "MULTIPLE_GSTINS", "FORMAT_OK")
    shown_texts = []

    def run_registry_check(gstin_text):
        page.fill("#field-gstin", gstin_text)
        page.evaluate("document.querySelector('#verdict').removeAttribute('data-verdict')")
        page.click("#verify-button")
        page.wait_for_selector("#verdict[data-verdict]")
        shown_texts.append(page.inner_text("body"))
        return page.get_attribute("#verdict", "data-verdict"), page.inner_text("#verdict")

    verdict, text = run_registry_check("my gstin is 07putxm1153m1z9")
    check("a GSTIN typed in a sentence in the field is verified", verdict == "verified", text[:120])
    check("the registry status is shown as a word", "Registry status: Active" in text, text[:200])
    verdict, text = run_registry_check("07PUTXM1153M1Z9 or 29OKAXP4077P1ZL")
    check(
        "two GSTINs in the field are listed masked and the owner is asked which one",
        verdict == "fix_gstin" and "07PUT•••••••1Z9" in text and "29OKA•••••••1ZL" in text and "M1153M" not in text,
        text[:200],
    )
    verdict, text = run_registry_check("")
    check(
        "an empty GSTIN field asks for the GSTIN in plain words",
        verdict == "fix_gstin" and "couldn't find a complete GSTIN" in text,
        text[:200],
    )
    leaked = sorted({code for shown in shown_texts for code in status_codes if code in shown})
    check("no status code appears anywhere on the page", not leaked, ", ".join(leaked))
    page.fill("#field-gstin", "07PUTXM1153M1Z9")

    # Edited field that doesn't match the registry goes to review, not a guess.
    page.fill("#field-legal-name", "Sunrise Traders")
    page.fill("#field-trade-name", "Sunrise Traders")
    page.click("#verify-button")
    page.wait_for_function("document.querySelector('#verdict').getAttribute('data-verdict') === 'review'")
    check("a name that doesn't match goes to an advisor", "advisor" in page.inner_text("#verdict").lower())

    # Proprietorship: legal name is a person, trade name is the shop.
    fields = read_sample(page, "saffron_bakers")
    print("  OCR saffron:", fields)
    check("OCR reads the Saffron GSTIN", fields["gstin"] == "03PJNXS4821G1ZB", fields["gstin"])
    page.click("#verify-button")
    page.wait_for_selector("#verdict[data-verdict]")
    check(
        "proprietorship certificate is verified by its trade name",
        page.get_attribute("#verdict", "data-verdict") == "verified",
        page.inner_text("#verdict")[:160],
    )

    # Cancelled registration: blocked, never activated.
    fields = read_sample(page, "prime_general_store_cancelled")
    print("  OCR prime:", fields)
    check("OCR reads the cancelled GSTIN", fields["gstin"] == "29OKAXP4077P1ZL", fields["gstin"])
    page.click("#verify-button")
    page.wait_for_selector("#verdict[data-verdict]")
    check(
        "cancelled registration is blocked",
        page.get_attribute("#verdict", "data-verdict") == "blocked" and "Cancelled" in page.inner_text("#verdict"),
    )

    # Files that aren't photos: a clear message, no uncaught error, and the reader still works afterwards.
    errors_before_uploads = len(errors)
    page.set_input_files(
        "#certificate-file", files=[{"name": "notes.txt", "mimeType": "text/plain", "buffer": b"not a photo"}]
    )
    page.wait_for_function("document.querySelector('#verdict').innerText.includes(\"isn't a photo\")", timeout=10000)
    check("a non-image file is refused with a clear message, before any OCR", page.is_hidden("#ocr-progress"))
    page.set_input_files(
        "#certificate-file", files=[{"name": "broken.png", "mimeType": "image/png", "buffer": b"this is not a PNG"}]
    )
    page.wait_for_function("document.querySelector('#verdict').innerText.includes(\"Couldn't read\")", timeout=120000)
    page.wait_for_timeout(1000)
    check(
        "a corrupt image fails gracefully: message shown, no uncaught page error",
        len(errors) == errors_before_uploads,
        " | ".join(errors[errors_before_uploads:]),
    )
    fields = read_sample(page, "prime_general_store_cancelled")
    page.click("#verify-button")
    page.wait_for_selector("#verdict[data-verdict]")
    check(
        "the reader still works after the failed files",
        fields["gstin"] == "29OKAXP4077P1ZL" and page.get_attribute("#verdict", "data-verdict") == "blocked",
        fields["gstin"],
    )

    # The sample FILES on disk are real certificates: OCR of each file finds the GSTIN it was drawn for.
    samples = page.evaluate("window.SAMPLE_CERTIFICATES.map((sample) => ({ file: sample.file, gstin: sample.gstin }))")
    for sample in samples:
        page.set_input_files("#certificate-file", str(kit / "7_demo_site" / sample["file"]))
        page.wait_for_selector("#fields-form:not([hidden])", timeout=180000)
        read_gstin = page.input_value("#field-gstin")
        check(f"OCR of the file {sample['file']} finds its GSTIN", read_gstin == sample["gstin"], read_gstin)
    read_sample(page, "prime_general_store_cancelled")
    page.click("#verify-button")
    page.wait_for_selector("#verdict[data-verdict]")

    # Language switch: consent and reader texts follow; the verdict is re-checked in the new language.
    page.select_option("#kyc-language", "hi")
    check("Hindi consent screen", "आपका डेटा" in page.inner_text("#consent-title"))
    check("Hindi reader texts", "सर्टिफ़िकेट" in page.inner_text("#kyc-title"))
    check("Hindi verdict after switching", "रजिस्ट्री" in page.inner_text("#verdict"), page.inner_text("#verdict")[:120])
    page.select_option("#kyc-language", "kn")
    check("Kannada consent screen", "ನಿಮ್ಮ ಡೇಟಾ" in page.inner_text("#consent-title"))
    check("Kannada withdraw button", page.inner_text("fieldset[data-purpose='kyc_verification'] .withdraw") == "ಹಿಂಪಡೆ")
    page.screenshot(path=str(shots / "kyc_kannada_desktop.png"), full_page=False)

    # Withdraw KYC: the document and verdict are deleted and the reader locks again.
    page.click("fieldset[data-purpose='kyc_verification'] .withdraw")
    check(
        "withdrawing KYC deletes what was read",
        page.is_hidden("#fields-form") and page.is_hidden("#verdict") and page.is_hidden("#certificate-preview"),
    )
    check("withdrawing KYC locks the reader again", page.is_disabled("#certificate-file"))
    check("withdraw message in Kannada", "ಆಯಿತು" in page.inner_text("#consent-status"))
    page.click("#consent-record-heading")
    check("consent log keeps the history", page.locator("#consent-log li").count() >= 3)

    # Record survives a reload in the same tab.
    page.reload()
    page.wait_for_selector("#consent-purposes fieldset")
    check(
        "consent record survives a reload (same tab)",
        page.is_checked("input[name='consent-registry_lookup'][value='yes']")
        and page.is_checked("input[name='consent-kyc_verification'][value='no']"),
    )
    check("language survives a reload", page.input_value("#kyc-language") == "kn")

    # Mobile 375px: no horizontal scroll.
    mobile = browser.new_context(viewport={"width": 375, "height": 812}, locale="en-US")
    mobile_page = mobile.new_page()
    mobile_page.on("pageerror", lambda error: errors.append(str(error)))
    mobile_page.goto(page_url + "#kyc")
    mobile_page.wait_for_selector("#consent-purposes fieldset")
    mobile_page.check("input[name='consent-kyc_verification'][value='yes']")
    mobile_page.check("input[name='consent-registry_lookup'][value='yes']")
    read_sample(mobile_page, "metro_diagnostics")
    mobile_page.click("#verify-button")
    mobile_page.wait_for_selector("#verdict[data-verdict]")
    scroll_width = mobile_page.evaluate("document.documentElement.scrollWidth")
    check("no horizontal scroll at 375px", scroll_width <= 375, str(scroll_width))
    mobile_page.locator("#kyc").screenshot(path=str(shots / "kyc_mobile_375.png"))

    check("no console errors", not errors, " | ".join(errors[:5]))
    browser.close()

failed = [name for name, passed, _ in results if not passed]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
