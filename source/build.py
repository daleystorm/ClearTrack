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
os.makedirs(site, exist_ok=True)

body = src.replace('/*ENGINE*/', engine).replace('/*STANDALONE*/false', 'true')
title_m = re.match(r'\s*<title>.*?</title>\s*', body, re.S)
body = body[title_m.end():] if title_m else body
version = hashlib.sha1((body + open(__file__, encoding='utf-8').read()).encode()).hexdigest()[:10]  # changes when the page or the icons change

head = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ClearTrack</title>
<meta name="description" content="Personal debt and spending tracker. Your data stays on this device.">
<meta name="theme-color" content="#f1f3f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1218" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ClearTrack">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="icon-192.png">
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
    "background_color": "#f1f3f7",
    "theme_color": "#14305a",
    "categories": ["finance", "productivity"],
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
    "shortcuts": [
        {"name": "Add a transaction", "url": "./#add", "icons": [{"src": "icon-192.png", "sizes": "192x192"}]},
        {"name": "Payday checklist", "url": "./#payday", "icons": [{"src": "icon-192.png", "sizes": "192x192"}]},
    ],
}
json.dump(manifest, open(os.path.join(site, 'manifest.webmanifest'), 'w'), indent=2)

sw = '''// ClearTrack service worker: offline app shell, plus reminder notifications.
const CACHE = 'cleartrack-__VERSION__';
const DATA = 'cleartrack-data';   // written by the app: reminders.json; kept by this worker: notified.json
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './maskable-512.png', './badge-96.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('cleartrack-') && k !== CACHE && k !== DATA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  if (url.origin === location.origin || url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })));
  }
});

// ---------- reminders ----------
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
async function readJSON(key) { try { const r = await (await caches.open(DATA)).match(key); return r ? await r.json() : null; } catch (e) { return null; } }
async function writeJSON(key, v) { try { await (await caches.open(DATA)).put(key, new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })); } catch (e) {} }
function todayISO(now) { const d = now || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function days(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }
function nice(iso) { const [y, m, d] = iso.split('-').map(Number); return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] + ' ' + d + ' ' + MON[m - 1]; }
function when(n) { return n < 0 ? Math.abs(n) + (n === -1 ? ' day' : ' days') + ' late' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days'; }
function money(sym, n) { return (sym || 'J$') + Math.round(n).toLocaleString('en-US'); }
// Decide what to notify about today. Each item notifies at most once a day; backups at most once a week.
function dueNotifications(data, today, sent) {
  const out = [];
  for (const it of data.items || []) {
    const n = days(today, it.date); let note = null;
    if (it.kind === 'bill' && n <= 3) note = { title: it.title + (n < 0 ? ' is overdue' : ' due ' + when(n)), body: money(data.sym, it.amount) + ' · due ' + nice(it.date) + '. Mark it paid in ClearTrack when it’s done.', route: 'home' };
    if (it.kind === 'due' && n >= 0 && n <= 3 && !it.covered && !it.payroll) note = { title: it.title + ' due ' + when(n), body: money(data.sym, it.amount) + ' · ' + nice(it.date) + ' · not logged yet', route: 'home' };
    if (it.kind === 'payday' && (n === 0 || n === 1)) note = { title: n === 0 ? 'Payday today' : 'Payday tomorrow', body: 'Work through the payday checklist before sending any extra to debt.', route: 'payday' };
    if (it.kind === 'snapshot') note = { title: 'Record month-end balances', body: 'Enter your statement balances' + (it.label ? ' for ' + it.label : '') + ' to keep your trend line going.', route: 'debts' };
    if (it.kind === 'budget') note = { title: it.title + (it.level === 'over' ? ' is over budget' : ' is at ' + Math.round(it.amount / it.budget * 100) + '% of budget'), body: money(data.sym, it.amount) + ' spent of ' + money(data.sym, it.budget) + ' this month.', route: 'plan' };
    if (it.kind === 'recurring' && n === 0) note = { title: it.title + ' due today', body: money(data.sym, it.amount) + ' · monthly. Tap Log in ClearTrack once it’s paid.', route: 'home' };
    if (it.kind === 'rollover') note = { title: 'New pay cycle', body: 'Move your plan to ' + it.label + ' and update cash on hand. It takes one tap in ClearTrack.', route: 'home' };
    if (!note) continue;
    const key = it.once ? it.key : it.key + '@' + today; if (sent[key]) continue;
    out.push({ ...note, tag: it.key, key });
  }
  if (data.hasData && (!data.lastBackup || days(data.lastBackup, today) >= 14)) {
    const key = 'backup@' + today.slice(0, 8) + Math.floor((+today.slice(8) - 1) / 7);
    if (!sent[key]) out.push({ title: 'Back up ClearTrack', body: 'Your data lives only on this phone. Save a backup file and keep a copy somewhere safe.', route: 'setup', tag: 'backup', key });
  }
  return out;
}
async function checkReminders() {
  const data = await readJSON('./reminders.json'); if (!data) return 0;
  const today = todayISO(), sent = (await readJSON('./notified.json')) || {};
  const notes = dueNotifications(data, today, sent);
  let shown = 0;
  for (const n of notes) {
    try { await self.registration.showNotification(n.title, { body: n.body, tag: n.tag, icon: 'icon-192.png', badge: 'badge-96.png', data: { route: n.route } }); sent[n.key] = today; shown++; } catch (e) { break; }
  }
  for (const k of Object.keys(sent)) if (days(sent[k], today) > 40) delete sent[k];
  await writeJSON('./notified.json', sent);
  return shown;
}
self.addEventListener('periodicsync', e => { if (e.tag === 'ct-reminders') e.waitUntil(checkReminders()); });
self.addEventListener('message', e => {
  const t = e.data && e.data.type;
  if (t === 'check') e.waitUntil(checkReminders());
  if (t === 'test') e.waitUntil(self.registration.showNotification('ClearTrack notifications are on', { body: 'You’ll get reminders for payday, bills and payments due soon.', tag: 'test', icon: 'icon-192.png', badge: 'badge-96.png', data: { route: 'home' } }).catch(() => {}));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL('./#' + ((e.notification.data && e.notification.data.route) || 'home'), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.navigate(url).then(w => (w || c).focus()).catch(() => c.focus());
    return self.clients.openWindow(url);
  }));
});
'''.replace('__VERSION__', version)
open(os.path.join(site, 'sw.js'), 'w').write(sw)

# Icons: logo B — a "C" for ClearTrack completed by a gold tick, on deep harbour blue.
NAVY, BLUE, GOLD, WHITE = (20, 48, 90, 255), (29, 88, 168, 255), (242, 181, 68, 255), (255, 255, 255, 255)
def draw_mark(d, ox, oy, size, c_col=WHITE, tick_col=GOLD):
    u = lambda v: v * size
    cx, cy, r, w = ox + u(0.5), oy + u(0.5), u(0.286), u(0.095)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=50, end=310, fill=c_col, width=int(w))
    import math
    for ang in (50, 310):  # round caps on the C
        x = cx + r * math.cos(math.radians(ang)) - 0.0; y = cy + r * math.sin(math.radians(ang))
        rr = w / 2; xr = cx + (r - w / 2) * math.cos(math.radians(ang)); yr = cy + (r - w / 2) * math.sin(math.radians(ang))
        d.ellipse([xr - rr, yr - rr, xr + rr, yr + rr], fill=c_col)
    pts = [(ox + u(0.381), oy + u(0.5)), (ox + u(0.5), oy + u(0.619)), (ox + u(0.762), oy + u(0.333))]
    tw = int(u(0.083)); d.line(pts, fill=tick_col, width=tw, joint='curve')
    for x, y in (pts[0], pts[-1]): d.ellipse([x - tw / 2, y - tw / 2, x + tw / 2, y + tw / 2], fill=tick_col)
def background(d, W, rounded):
    from PIL import ImageFilter
    if rounded: d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.23), fill=NAVY)
    else: d.rectangle([0, 0, W, W], fill=NAVY)
    # one soft lighter glow towards the top-right, blurred so it has no visible steps
    layer = Image.new('RGBA', (W, W), (0, 0, 0, 0)); rr = W * 0.9
    ImageDraw.Draw(layer).ellipse([W - rr * 0.55, -rr * 0.6, W + rr * 0.9, rr * 0.75], fill=BLUE[:3] + (190,))
    yield layer.filter(ImageFilter.GaussianBlur(W * 0.16))
def icon(size, maskable=False):
    s = 4; W = size * s
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    for layer in background(d, W, not maskable): im.alpha_composite(layer)
    if not maskable:  # keep the glow inside the rounded square
        mask = Image.new('L', (W, W), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.23), fill=255); im.putalpha(mask)
    d = ImageDraw.Draw(im)
    k = 0.66 if maskable else 0.86
    draw_mark(d, W * (1 - k) / 2, W * (1 - k) / 2, W * k)
    return im.resize((size, size), Image.LANCZOS)

icon(192).save(os.path.join(site, 'icon-192.png'))
icon(512).save(os.path.join(site, 'icon-512.png'))
icon(512, True).save(os.path.join(site, 'maskable-512.png'))

def badge(size=96):
    W = size * 4; im = Image.new('RGBA', (W, W), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    draw_mark(d, W * 0.04, W * 0.04, W * 0.92, WHITE, WHITE)
    return im.resize((size, size), Image.LANCZOS)
badge().save(os.path.join(site, 'badge-96.png'))

open(os.path.join(site, '.nojekyll'), 'w').close()
if len(sys.argv) == 1: shutil.copy(os.path.join(HERE, 'README.md'), os.path.join(site, 'README.md'))
print('built cleartrack.html and site/ (cache', version + ')')
