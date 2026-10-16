import sys, json, os
sys.path.insert(0, r'C:\Users\hacke\AppData\Roaming\Python\Python314\site-packages')

from cloakbrowser import launch

print("[cloak] launching headless...", flush=True)
browser = launch(headless=True)
print("[cloak] launched ok", flush=True)

page = browser.new_page()
print("[cloak] loading pinterest...", flush=True)
page.goto('https://www.pinterest.com/search/pins/?q=photobooth+photo+strip+template+trending+2025+colorful', timeout=45_000)
print(f"[cloak] title: {page.title()}", flush=True)

# scrape image urls
imgs = page.evaluate('''() => {
  const pins = document.querySelectorAll('img[src*="pinimg.com"]');
  return Array.from(pins).map(img => img.src).slice(0, 12);
}''')
print("[cloak] found images:", len(imgs), flush=True)
for i, url in enumerate(imgs):
    print(f"  [{i}] {url}")

browser.close()
print("[cloak] done", flush=True)