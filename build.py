"""Build ClearTrack from one source.

  python3 build.py            -> cleartrack.html (claude.ai version) + site/ (phone version)
  python3 build.py <outdir>   -> writes the phone version's files into <outdir> (e.g. the repo root)
"""
import hashlib, json, os, re, shutil, sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'app.src.html'), encoding='utf-8').read()
engine = open(os.path.join(HERE, 'engine.js'), encoding='utf-8').read()

# 1) Artifact version
artifact = src.replace('/*ENGINE*/', engine)
open(os.path.join(HERE, 'cleartrack.html'), 'w', encoding='utf-8').write(artifact)

# 2) Phone (PWA) version
if len(sys.argv) > 1:
    site = os.path.abspath(sys.argv[1])
else:
    site = os.path.join(HERE, 'site'); shutil.rmtree(site, ignore_errors=True)
os.makedirs(os.path.join(site, 'icons'), exist_ok=True)

body = src.replace('/*ENGINE*/', engine).replace('/*STANDALONE*/false', 'true')
title_m = re.match(r'\s*<title>.*?</title>\s*', body, re.S)
body = body[title_m.end():] if title_m else body
version = hashlib.sha1((body + 'v1').encode()).hexdigest()[:10]

head = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ClearTrack</title>
<meta name="description" content="Personal debt and spending tracker. Your data stays on this device.">
<meta name="theme-color" content="#eef2ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1513" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ClearTrack">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="icons/icon-192.png">
<style>
:root {{ color-scheme: light; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px) }}
body {{ margin: 0; font: 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif }}
img {{ max-width: 100% }}
[hidden] {{ display: none !important }}
</style>
</head>
<body>
'''
tail = f'''
<script>
if ('serviceWorker' in navigator) {{
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {{}}));
}}
</script>
</body>
</html>
'''
open(os.path.join(site, 'index.html'), 'w', encoding='utf-8').write(head + body + tail)

manifest = {
    "name": "ClearTrack",
    "short_name": "ClearTrack",
    "description": "Log spending in seconds and always know Safe to Spend, Safe Extra Payment, your card status and your debt-free date.",
    "id": "./",
    "start_url": "./#home",
    "scope": "./",
    "display": "standalone",
    "orientation": "portrait",
    "background_color": "#eef2ef",
    "theme_color": "#0b6a4c",
    "categories": ["finance", "productivity"],
    "icons": [
        {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
    "shortcuts": [
        {"name": "Add a transaction", "url": "./#add", "icons": [{"src": "icons/icon-192.png", "sizes": "192x192"}]},
        {"name": "Payday checklist", "url": "./#payday", "icons": [{"src": "icons/icon-192.png", "sizes": "192x192"}]},
    ],
}
json.dump(manifest, open(os.path.join(site, 'manifest.webmanifest'), 'w'), indent=2)

sw = f'''// ClearTrack service worker: the app works offline after the first visit.
const CACHE = 'cleartrack-{version}';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];
self.addEventListener('install', e => {{ e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); }});
self.addEventListener('activate', e => {{
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('cleartrack-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
}});
self.addEventListener('fetch', e => {{
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {{
    // Network first so updates arrive; fall back to the cached app offline.
    e.respondWith(fetch(req).then(r => {{ const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r; }}).catch(() => caches.match('./index.html')));
    return;
  }}
  if (url.origin === location.origin || url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {{
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {{ const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; }})));
  }}
}});
'''
open(os.path.join(site, 'sw.js'), 'w').write(sw)

# Icons: a falling balance line ending at zero, on the app's sea-green.
def icon(size, maskable=False):
    s = 4  # supersample
    W = size * s
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    green = (11, 106, 76, 255)
    if maskable:
        d.rectangle([0, 0, W, W], fill=green); pad = W * 0.22
    else:
        d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.23), fill=green); pad = W * 0.2
    x0, x1, y0, y1 = pad, W - pad, pad + W * 0.04, W - pad
    pts = [(x0, y0), (x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.22), (x0 + (x1 - x0) * 0.55, y0 + (y1 - y0) * 0.55), (x0 + (x1 - x0) * 0.78, y0 + (y1 - y0) * 0.86), (x1, y1)]
    lw = int(W * 0.085)
    d.line([(x0, y1), (x1, y1)], fill=(255, 255, 255, 90), width=int(lw * 0.45))
    d.line(pts, fill=(255, 255, 255, 255), width=lw, joint='curve')
    for p in pts[:1]:
        r = lw * 0.5; d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255, 255))
    r = lw * 0.95; d.ellipse([x1 - r, y1 - r, x1 + r, y1 + r], fill=(239, 176, 76, 255), outline=(255, 255, 255, 255), width=int(lw * 0.35))
    return im.resize((size, size), Image.LANCZOS)

icon(192).save(os.path.join(site, 'icons', 'icon-192.png'))
icon(512).save(os.path.join(site, 'icons', 'icon-512.png'))
icon(512, True).save(os.path.join(site, 'icons', 'maskable-512.png'))

open(os.path.join(site, '.nojekyll'), 'w').close()
if len(sys.argv) == 1: shutil.copy(os.path.join(HERE, 'README.md'), os.path.join(site, 'README.md'))
print('built cleartrack.html and site/ (cache', version + ')')
