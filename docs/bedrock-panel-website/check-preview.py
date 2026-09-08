"""Responsive browser checks for the review prototype (not WordPress validation)."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent
output = root / 'review'
output.mkdir(exist_ok=True)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    for filename in ['design-preview.html', 'demos-preview.html', 'docs-preview.html', 'download-preview.html']:
        for width in [320, 390, 768, 1024, 1440]:
            page.set_viewport_size({'width': width, 'height': 960})
            print(filename, width, flush=True)
            page.goto((root / filename).as_uri())
            page.locator('img').evaluate_all('(images) => images.forEach(i => i.loading = "eager")')
            page.locator('img').evaluate_all('(images) => Promise.all(images.map(img => img.decode().catch(() => {})))')
            data = page.evaluate('''() => ({
                overflow: document.documentElement.scrollWidth > innerWidth,
                brokenImages: [...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src),
                missingAnchors: [...document.querySelectorAll('a[href^="#"]')].filter(a => !document.getElementById(a.hash.slice(1))).map(a => a.hash),
                h1Count: document.querySelectorAll('h1').length
            })''')
            assert not data['overflow'], (filename, width, data)
            assert not data['brokenImages'], (filename, width, data)
            assert not data['missingAnchors'], (filename, width, data)
            assert data['h1Count'] == 1, (filename, width, data)
            if width == 390:
                page.locator('.mobile-nav summary').click()
                assert page.locator('.mobile-nav').get_attribute('open') is not None
                assert page.locator('.mobile-nav nav').is_visible()
                page.locator('.mobile-nav summary').click()
            if filename == 'design-preview.html':
                page.locator('.faq-list summary').first.click()
                assert page.locator('.faq-list details').first.get_attribute('open') is not None
                page.locator('.faq-list summary').first.click()
            if width in [390, 1440]:
                page.evaluate('window.scrollTo({top: 0, behavior: "instant"})')
                page.screenshot(path=str(output / f'{Path(filename).stem}-{width}-viewport.png'))
                page.screenshot(path=str(output / f'{Path(filename).stem}-{width}.png'), full_page=True)
            results.append({'page': filename, 'width': width, **data})
    assert not errors, errors
    browser.close()
(output / 'checks.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(f'Passed {len(results)} page/viewport checks; menu and FAQ tested. Screenshots in {output}')
