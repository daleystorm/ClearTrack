// ClearTrack service worker: offline app shell, plus reminder notifications.
const CACHE = 'cleartrack-3ce1deacf0';
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
    if (!note) continue;
    const key = it.key + '@' + today; if (sent[key]) continue;
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
