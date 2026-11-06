"""
browser_back_office_check.py: browser test of the back-office page (8_back_office/index.html).

What it checks: the SIMULATED sample loads with no console errors; filters, search and "Rep callbacks only" work;
at 375 px nothing overflows (the CSV file box stays inside its panel, no horizontal scroll); red text on the tinted
tiles and rep-callback boxes meets WCAG AA contrast (4.5:1) in light and dark mode, computed from the colours the
browser actually renders.

Needs: Python with Playwright (pip install playwright; python -m playwright install chromium). Run the build first.
Usage: python 6_tests/browser_back_office_check.py . <folder for screenshots>
Sample data: the back-office sample is SIMULATED from the case's synthetic leads.
"""

import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

# WCAG 2.2 AA minimum contrast for normal-size text.
MINIMUM_TEXT_CONTRAST = 4.5
MOBILE_WIDTH = 375
# Pixels of rounding the browser may report on box edges.
EDGE_TOLERANCE = 0.5

kit = pathlib.Path(sys.argv[1]).resolve()
shots = pathlib.Path(sys.argv[2])
shots.mkdir(parents=True, exist_ok=True)
page_url = (kit / "8_back_office" / "index.html").as_uri()
results = []


def check(name, passed, detail=""):
    results.append((name, passed, detail))
    print(("PASS " if passed else "FAIL ") + name + (f"  [{detail}]" if detail and not passed else ""))


def relative_luminance(css_colour):
    """WCAG relative luminance of an "rgb(r, g, b)" colour."""
    channels = [int(value) / 255 for value in re.findall(r"\d+", css_colour)[:3]]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast_ratio(foreground, background):
    lighter, darker = sorted((relative_luminance(foreground), relative_luminance(background)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def open_with_sample(context, errors):
    page = context.new_page()
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(page_url)
    page.wait_for_load_state("networkidle")
    if page.locator("article.lead").count() == 0:
        page.click("#load-sample")
    page.wait_for_selector("article.lead")
    return page


def red_text_contrasts(page):
    """Contrast of each red-text element against the tinted box it sits on: [(label, ratio)]."""
    pairs = page.evaluate(
        """() => [['.tile b', '.tile'], ['.handoff b', '.handoff']].map(([text, box]) => {
             const element = document.querySelector(text);
             return [text, getComputedStyle(element).color, getComputedStyle(element.closest(box)).backgroundColor];
           })"""
    )
    return [(label, contrast_ratio(colour, background)) for label, colour, background in pairs]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    errors = []

    desktop = open_with_sample(browser.new_context(viewport={"width": 1280, "height": 900}), errors)
    check("the SIMULATED sample loads", "SIMULATED" in desktop.inner_text("#status"), desktop.inner_text("#status"))
    total = desktop.inner_text("#count")
    desktop.select_option("#filter-band", "Hot")
    check("the score-band filter changes the list", desktop.inner_text("#count") != total, desktop.inner_text("#count"))
    desktop.select_option("#filter-band", "all")
    desktop.fill("#filter-search", "Delhi")
    check("search finds leads", desktop.locator("article.lead").count() > 0, desktop.inner_text("#count"))
    desktop.fill("#filter-search", "")
    tile_callbacks = desktop.inner_text("#tile-handoffs").replace(",", "")
    desktop.check("#filter-handoff")
    check(
        "'Rep callbacks only' matches the callbacks tile",
        desktop.inner_text("#count").replace(",", "").startswith(tile_callbacks + " "),
        f"tile {tile_callbacks}, list {desktop.inner_text('#count')!r}",
    )
    desktop.uncheck("#filter-handoff")
    for label, ratio in red_text_contrasts(desktop):
        check(f"light mode: {label} contrast is at least 4.5:1", ratio >= MINIMUM_TEXT_CONTRAST, f"{ratio:.2f}:1")

    dark = open_with_sample(browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark"), errors)
    for label, ratio in red_text_contrasts(dark):
        check(f"dark mode: {label} contrast is at least 4.5:1", ratio >= MINIMUM_TEXT_CONTRAST, f"{ratio:.2f}:1")
    dark.screenshot(path=str(shots / "back_office_dark.png"))

    mobile = open_with_sample(browser.new_context(viewport={"width": MOBILE_WIDTH, "height": 812}), errors)
    panel = mobile.locator("section.source").bounding_box()
    file_box = mobile.locator("#csv-file").bounding_box()
    check(
        "at 375 px the CSV file box stays inside its panel",
        file_box["x"] >= panel["x"] - EDGE_TOLERANCE
        and file_box["x"] + file_box["width"] <= panel["x"] + panel["width"] + EDGE_TOLERANCE,
        f"file box {file_box['x']:.0f}–{file_box['x'] + file_box['width']:.0f}, panel {panel['x']:.0f}–"
        f"{panel['x'] + panel['width']:.0f}",
    )
    overflowing = mobile.evaluate(
        """() => [...document.querySelectorAll('section.source > *')]
             .filter((element) => element.getBoundingClientRect().right >
                                  element.parentElement.getBoundingClientRect().right + 0.5)
             .map((element) => element.id || element.tagName)"""
    )
    check("at 375 px no data-source control overflows its panel", not overflowing, ", ".join(overflowing))
    width = mobile.evaluate("document.documentElement.scrollWidth")
    check("at 375 px there is no horizontal scroll", width <= MOBILE_WIDTH, str(width))
    mobile.screenshot(path=str(shots / "back_office_mobile.png"))

    check("no console errors", not errors, " | ".join(errors[:5]))
    browser.close()

failed = [name for name, passed, _ in results if not passed]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
