import pathlib
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).parent
url = (here / "screens.html").resolve().as_uri()
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1400, "height": 700}, device_scale_factor=3)
    pg.goto(url)
    pg.wait_for_timeout(600)
    pg.evaluate("document.fonts.ready")
    for i in range(1, 5):
        pg.locator(f"#p{i}").screenshot(path=str(here / f"phone{i}.png"), omit_background=True)
    pg.screenshot(path=str(here / "all.png"), omit_background=False)
    b.close()
print("ok")
