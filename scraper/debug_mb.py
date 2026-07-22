"""
debug_mb.py — Run this ONCE to dump MagicBricks HTML for inspection.
Shows us exactly what structure the page has so we can fix the scraper.

Run: python debug_mb.py
Creates: mb_debug.html and mb_debug.txt
"""
import asyncio, re
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False, slow_mo=60)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1366, "height": 900},
            locale="en-IN",
        )
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)
        page = await context.new_page()

        # Visit homepage first
        await page.goto("https://www.magicbricks.com", wait_until="domcontentloaded", timeout=20000)
        await asyncio.sleep(2)

        # Now search for Kasa Isles specifically
        url = (
            "https://www.magicbricks.com/property-for-rent/residential-real-estate"
            "?proptype=Multistorey-Apartment&cityName=Noida&keyword=Kasa%20Isles"
        )
        print(f"Loading: {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=25000)

        # Wait for ₹ to appear
        try:
            await page.wait_for_function("document.body.innerText.includes('₹')", timeout=12000)
        except:
            print("No ₹ appeared")

        await asyncio.sleep(3)
        await page.evaluate("window.scrollTo(0, 1000)")
        await asyncio.sleep(2)

        html = await page.content()
        text = await page.inner_text("body")

        with open("mb_debug.html", "w", encoding="utf-8") as f:
            f.write(html)
        with open("mb_debug.txt", "w", encoding="utf-8") as f:
            f.write(text)

        print(f"Saved mb_debug.html ({len(html):,} bytes)")
        print(f"Saved mb_debug.txt ({len(text):,} bytes)")

        # Show all ₹ contexts
        print("\n--- ALL ₹ CONTEXTS (first 40) ---")
        chunks = text.split("₹")
        for i, chunk in enumerate(chunks[1:41], 1):
            line = chunk[:80].replace("\n", " ").strip()
            print(f"  [{i}] ₹{line}")

        # Also show what property names appear
        print("\n--- LINES CONTAINING 'Kasa' or 'Isles' ---")
        for line in text.split("\n"):
            if "kasa" in line.lower() or "isles" in line.lower():
                print(f"  {line.strip()[:120]}")

        await browser.close()

asyncio.run(main())