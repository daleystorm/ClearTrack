/* ClearTrack calculation engine — rules R1–R19 from the App Spec sheet.
   Pure functions; full precision; rounding only at display.
   Dates are ISO strings 'YYYY-MM-DD' handled in UTC. */
(function (root) {
  'use strict';

  // ---------- date helpers ----------
  const DAY = 86400000;
  function D(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function iso(t) { return new Date(t).toISOString().slice(0, 10); }
  function ymd(iso_) { const [y, m, d] = iso_.split('-').map(Number); return { y, m, d }; }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m = 1..12
  function mk(y, m, d) { // normalises month overflow, d capped later by caller
    const t = new Date(Date.UTC(y, m - 1, 1)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d };
  }
  function dateCapped(y, m, day) { const n = mk(y, m, 1); return iso(Date.UTC(n.y, n.m - 1, Math.min(day, daysInMonth(n.y, n.m)))); }
  function backToFriday(isoDate) { // WORKDAY(date+1,-1): weekend → Friday before
    const t = D(isoDate); const wd = new Date(t).getUTCDay();
    if (wd === 6) return iso(t - DAY); if (wd === 0) return iso(t - 2 * DAY); return isoDate;
  }
  function edate(isoDate, n) { // Excel EDATE: same day, capped at month length
    const { y, m, d } = ymd(isoDate); return dateCapped(y, m + n, d);
  }
  function monthStart(isoDate) { return isoDate.slice(0, 8) + '01'; }
  function monthKey(isoDate) { return isoDate.slice(0, 4) + isoDate.slice(5, 7); }
  function addDays(isoDate, n) { return iso(D(isoDate) + n * DAY); }
  function monthsBetween(a, b) { const A = ymd(a), B = ymd(b); return (B.y - A.y) * 12 + B.m - A.m; }

  const PERIODS = { 'Monthly': 1, 'Semi-Monthly': 2, 'Biweekly': 26 / 12, 'Weekly': 52 / 12 };
  function periodsPerMonth(s) { return PERIODS[s.payFrequency] || 1; }

  // ---------- R1 next payday ----------
  function payDateInMonth(y, m, usualDay) { return backToFriday(dateCapped(y, m, usualDay)); }
  function nextPayday(s, today) {
    const { y, m } = ymd(today);
    const p = payDateInMonth(y, m, s.usualPayday);
    return p >= today ? p : payDateInMonth(y, m + 1, s.usualPayday);
  }
  function paydayAfterNext(s, today) {
    const b5 = nextPayday(s, today); const { y, m, d } = ymd(b5);
    switch (s.payFrequency) {
      case 'Weekly': return addDays(b5, 7);
      case 'Biweekly': return addDays(b5, 14);
      case 'Semi-Monthly': return d <= 15 ? dateCapped(y, m, 31) : dateCapped(y, m + 1, 15);
      default: return payDateInMonth(y, m + 1, s.usualPayday);
    }
  }
  function lastPayday(s, today) { // Payday Checklist B5 inner date
    const b5 = nextPayday(s, today);
    if (s.payFrequency === 'Monthly' || !s.payFrequency) { const { y, m } = ymd(b5); return payDateInMonth(y, m - 1, s.usualPayday); }
    return iso(2 * D(b5) - D(paydayAfterNext(s, today)));
  }

  // ---------- categories ----------
  function paymentCat(debt) { return debt.name + ' Payment'; }
  function interestCat(debt) { return debt.isRevolving ? 'Card Interest' : debt.name + ' Interest'; }
  function cardDebt(state) { return state.debts.find(d => d.isRevolving) || null; }

  // ---------- R2 flow type ----------
  function flowType(t, state) {
    const c = t.category;
    if (c === 'Net Pay') return 'Income';
    if (c === 'Extra Credit Card Payment' || state.debts.some(d => paymentCat(d) === c)) return 'Debt Payment';
    if (c === 'Outside Savings') return 'Savings';
    if (state.debts.some(d => interestCat(d) === c)) return 'Interest';
    return 'Expense';
  }
  const CASHLIKE = m => m === 'Debit/Cash' || m === 'Bank Transfer';

  // ---------- R3 live cash ----------
  function liveCash(state) {
    const s = state.settings;
    let out = 0;
    for (const t of state.transactions) {
      if (!t.date || !CASHLIKE(t.paymentMethod)) continue;
      if (flowType(t, state) === 'Income') continue;
      if (t.date >= s.cashAsOfDate) out += +t.amount;
    }
    return Math.max(s.cashOnHand - out, 0);
  }

  // ---------- R4 card impact / live balances ----------
  function cardImpact(t, state) {
    const card = cardDebt(state); if (!card || !t.date || t.date <= card.balanceAsOf) return 0;
    if (t.paymentMethod === 'Credit Card') return +t.amount;
    if (t.category === paymentCat(card) || t.category === 'Extra Credit Card Payment') return -t.amount;
    if (t.category === interestCat(card)) return +t.amount; // interest posted by another method
    return 0;
  }
  function liveBalance(debt, state) {
    if (debt.isRevolving) {
      let b = +debt.balance; for (const t of state.transactions) b += cardImpact(t, state); return b;
    }
    let paid = 0, interest = 0;
    for (const t of state.transactions) {
      if (!t.date || t.date <= debt.balanceAsOf) continue;
      if (t.category === paymentCat(debt)) paid += +t.amount;
      if (t.category === interestCat(debt)) interest += +t.amount;
    }
    return Math.max(+debt.balance + interest - paid, 0);
  }

  // ---------- R5–R11 payday waterfall ----------
  function netPayReceived(s, today) { return s.cashAsOfDate < lastPayday(s, today) ? +s.netPayPerPeriod : 0; }
  function cycleStart(s) { const a = s.cashAsOfDate, b = s.planningMonth; return a > b ? a : b; }
  function budgetStillToSpend(state) { // R7
    const s = state.settings, per = periodsPerMonth(s), from = cycleStart(s);
    let total = 0;
    for (const c of state.categories) {
      const bud = (+c.monthlyBudget || 0) / per;
      let paid = 0;
      for (const t of state.transactions) {
        if (t.category === c.name && t.date >= from && CASHLIKE(t.paymentMethod) && flowType(t, state) === 'Expense') paid += +t.amount;
      }
      total += Math.max(bud - paid, 0);
    }
    return Math.max(total, 0);
  }
  function takeHomeDebtStillDue(state) { // R8
    const s = state.settings, per = periodsPerMonth(s), from = cycleStart(s);
    let total = 0;
    for (const d of state.debts) {
      if (d.paymentSource !== 'Take-home') continue;
      const req = (+d.requiredPayment || 0) / per;
      let paid = 0;
      for (const t of state.transactions) {
        if (t.category === paymentCat(d) && t.date >= from && CASHLIKE(t.paymentMethod)) paid += +t.amount;
      }
      total += paid > req ? 0 : req - paid;
    }
    return total;
  }
  function billsBeforePayday(state, today) { // R9
    const np = nextPayday(state.settings, today);
    return state.bills.filter(b => !b.paid && b.dueDate && b.dueDate <= np).reduce((a, b) => a + +b.amount, 0);
  }

  // ---------- R13 card status ----------
  function cardStatus(balance, s) {
    const hard = +s.cardHardCeiling, soft = +s.cardSoftCeiling;
    let status = 'WITHIN LIMIT';
    if (balance >= hard) status = 'HARD LIMIT REACHED';
    else if (balance >= hard * s.criticalPct) status = 'CRITICAL';
    else if (balance >= soft) status = 'CAUTION';
    else if (balance >= hard * s.watchPct) status = 'WATCH';
    const level = { 'HARD LIMIT REACHED': 'red', 'CRITICAL': 'red', 'CAUTION': 'amber', 'WATCH': 'amber', 'WITHIN LIMIT': 'green' }[status];
    return { status, level, used: hard ? balance / hard : 0, room: Math.max(hard - balance, 0) };
  }

  // ---------- R14–R16 debts ----------
  function priorities(state, balances) {
    const method = state.settings.payoffMethod;
    const idx = state.debts.map((d, i) => i);
    idx.sort((a, b) => {
      const A = state.debts[a], B = state.debts[b];
      const diff = method === 'Snowball' ? balances[a] - balances[b] : B.apr - A.apr;
      return diff !== 0 ? diff : a - b;
    });
    const rank = []; idx.forEach((i, r) => rank[i] = r + 1); return rank;
  }
  function nextDueDate(dueDay, today) { // R15
    if (!dueDay) return null; const { y, m } = ymd(today);
    const p = dateCapped(y, m, dueDay); return p >= today ? p : dateCapped(y, m + 1, dueDay);
  }

  // ---------- R17 payoff projection ----------
  function projectPayoff(state, balances, extra, maxMonths = 96) {
    const debts = state.debts, n = debts.length;
    const rank = priorities(state, balances);
    const req = debts.map(d => +d.requiredPayment || 0);
    let bal = balances.slice(); let cum = 0;
    const start = state.settings.planningMonth;
    const rows = [{ month: 0, date: start, balances: bal.slice(), total: bal.reduce((a, b) => a + b, 0), cumInterest: 0 }];
    let found = rows[0].total <= 0 ? rows[0] : null;
    for (let m = 1; m <= maxMonths && !found; m++) {
      const pool = extra + bal.reduce((a, b, i) => a + (b <= 0 ? req[i] : 0), 0);
      const after = [], interest = [];
      for (let i = 0; i < n; i++) {
        const b = bal[i]; const int = b <= 0 ? 0 : b * debts[i].apr / 12;
        const r = b <= 0 ? 0 : Math.min(req[i], b + int);
        interest[i] = int; after[i] = Math.max(b + int - r, 0);
      }
      const next = [];
      for (let i = 0; i < n; i++) {
        let ahead = 0; for (let j = 0; j < n; j++) if (rank[j] < rank[i]) ahead += after[j];
        const applied = Math.min(after[i], Math.max(0, pool - ahead));
        next[i] = Math.max(after[i] - applied, 0);
      }
      bal = next; cum += interest.reduce((a, b) => a + b, 0);
      const row = { month: m, date: edate(start, m), balances: bal.slice(), total: bal.reduce((a, b) => a + b, 0), cumInterest: cum };
      rows.push(row); if (row.total <= 0) found = row;
    }
    const last = rows[rows.length - 1];
    return { debtFree: !!found, months: found ? found.month : null, date: found ? found.date : null,
      totalInterest: found ? found.cumInterest : last.cumInterest, rows };
  }

  // ---------- R19 loan progress ----------
  function pmt(r, n, pv) { return r === 0 ? pv / n : pv * r / (1 - Math.pow(1 + r, -n)); }
  function pv(r, n, p) { return r === 0 ? p * n : p * (1 - Math.pow(1 + r, -n)) / r; }
  function nper(r, p, b) { if (r === 0) return b / p; const x = 1 - b * r / p; return x <= 0 ? Infinity : -Math.log(x) / Math.log(1 + r); }
  function loanProgress(debt, balance, today) {
    if (debt.isRevolving || !debt.startDate || !debt.endDate || !debt.originalAmount) return null;
    const term = monthsBetween(debt.startDate, debt.endDate), r = debt.apr / 12;
    const elapsed = Math.max(monthsBetween(debt.startDate, today), 0);
    const sched = pmt(r, term, +debt.originalAmount);
    const schedBal = Math.max(pv(r, Math.max(term - elapsed, 0), sched), 0);
    const ahead = schedBal - balance, half = (+debt.requiredPayment) / 2;
    const n = nper(r, +debt.requiredPayment, balance);
    return { term, monthsElapsed: elapsed, pctTerm: Math.min(elapsed / term, 1), pctPaid: (debt.originalAmount - balance) / debt.originalAmount,
      scheduledPayment: sched, scheduledBalance: schedBal, ahead,
      pace: ahead > half ? 'AHEAD' : ahead < -half ? 'BEHIND' : 'ON TRACK',
      projectedPayoff: isFinite(n) ? edate(today, Math.ceil(n)) : null,
      termsCheck: Math.abs(sched - debt.requiredPayment) / debt.requiredPayment > 0.05 ? 'CHECK TERMS' : 'OK' };
  }

  // ---------- everything at once ----------
  function compute(state, today) {
    const s = state.settings, per = periodsPerMonth(s);
    const r1 = nextPayday(s, today), r1b = paydayAfterNext(s, today);
    const cash = liveCash(state);
    const r5 = netPayReceived(s, today);
    const r6 = r5 + (+s.otherIncome || 0) + cash;
    const r7 = budgetStillToSpend(state), r8 = takeHomeDebtStillDue(state), r9 = billsBeforePayday(state, today);
    const savings = (+s.monthlyOutsideSavings || 0) / per, buffer = +s.cashBufferTarget || 0;
    const r10 = Math.max(r6 - (r7 + r8 + r9 + savings) - buffer, 0);
    const r11 = Math.max(r6 - (r8 + r9 + savings + buffer), 0);
    const monthlyNet = Math.round(s.netPayPerPeriod * per * 100) / 100;
    const budgetTotal = state.categories.reduce((a, c) => a + (+c.monthlyBudget || 0), 0);
    const plannedDebt = state.debts.filter(d => d.paymentSource === 'Take-home').reduce((a, d) => a + (+d.requiredPayment || 0), 0);
    const r12 = monthlyNet - (budgetTotal + plannedDebt + (+s.monthlyOutsideSavings || 0));
    const balances = state.debts.map(d => liveBalance(d, state));
    const card = cardDebt(state); const cardBal = card ? balances[state.debts.indexOf(card)] : 0;
    const r13 = cardStatus(cardBal, s);
    const rank = priorities(state, balances), maxRank = state.debts.length;
    const debts = state.debts.map((d, i) => ({ ...d, liveBalance: balances[i], priority: rank[i],
      action: rank[i] === 1 ? 'ATTACK FIRST' : rank[i] === maxRank ? 'MAINTAIN' : 'NEXT',
      nextDue: nextDueDate(d.dueDay, today), estInterest: balances[i] * d.apr / 12,
      progress: loanProgress(d, balances[i], today) }));
    const extra = +s.monthlyExtraPayment || 0;
    const r17 = projectPayoff(state, balances, extra);
    const r18base = projectPayoff(state, balances, extra + 10000);
    const r18 = { step: 10000, monthsSaved: (r17.months != null && r18base.months != null) ? r17.months - r18base.months : null,
      interestSaved: r17.totalInterest - r18base.totalInterest, alt: r18base };
    const uncategorised = state.transactions.filter(t => !t.category);
    return { today, nextPayday: r1, paydayAfterNext: r1b, lastPayday: lastPayday(s, today), periodsPerMonth: per,
      cash, netPayReceived: r5, otherIncome: +s.otherIncome || 0, totalAvailable: r6, budgetStillToSpend: r7, takeHomeDebtDue: r8,
      billsBeforePayday: r9, savingsThisCycle: savings, cashBuffer: buffer, safeExtra: r10, safeToSpend: r11,
      plannedCushion: r12, monthlyNet, budgetTotal, plannedDebt,
      card: card ? { name: card.name, balance: cardBal, ...r13, hard: +s.cardHardCeiling, soft: +s.cardSoftCeiling } : null,
      debts, totalDebt: balances.reduce((a, b) => a + b, 0), payoff: r17, insight: r18,
      uncategorised: uncategorised.length, uncategorisedAmount: uncategorised.reduce((a, t) => a + +t.amount, 0) };
  }

  // ---------- S4 Monthly Plan (workbook Monthly Plan sheet) ----------
  function actualFor(state, category, mk) {
    let a = 0; for (const t of state.transactions) if (t.date && t.category === category && monthKey(t.date) === mk) a += +t.amount; return a;
  }
  function spendStatus(budget, actual) { return actual === 0 ? 'Not started' : actual <= budget ? 'On plan' : 'Over'; }
  function monthlyPlan(state, monthIso, calc) {
    const s = state.settings, mk = monthKey(monthIso), per = periodsPerMonth(s);
    const monthlyNet = Math.round(s.netPayPerPeriod * per * 100) / 100;
    const netActual = actualFor(state, 'Net Pay', mk);
    const income = { name: 'Net Pay', group: 'Income', budget: monthlyNet, actual: netActual, remaining: netActual === 0 ? 0 : netActual - monthlyNet,
      status: netActual === 0 ? 'Waiting for payday' : netActual >= monthlyNet ? 'On plan' : 'Below plan' };
    const groupOf = t => (t === 'Subscription' || t === 'Utility') ? 'Living' : (t || 'Other');
    const spending = state.categories.map(c => {
      const budget = +c.monthlyBudget || 0, actual = actualFor(state, c.name, mk);
      const interest = state.debts.some(d => interestCat(d) === c.name);
      return { name: c.name, group: groupOf(c.type), budget, actual, remaining: budget - actual,
        status: interest ? (actual === 0 ? 'Nothing posted' : 'Posted') : spendStatus(budget, actual), interest };
    });
    const catNames = new Set(state.categories.map(c => c.name));
    const debtRows = state.debts.filter(d => !catNames.has(paymentCat(d))).map(d => {
      const budget = +d.requiredPayment || 0, actual = actualFor(state, paymentCat(d), mk);
      return { name: paymentCat(d), group: d.paymentSource === 'Payroll' ? 'Debt (payroll)' : 'Debt', budget, actual, remaining: budget - actual, status: spendStatus(budget, actual) };
    });
    const extraBudget = calc ? calc.safeExtra : 0, extraActual = actualFor(state, 'Extra Credit Card Payment', mk);
    debtRows.push({ name: 'Extra Credit Card Payment', group: 'Debt', budget: extraBudget, actual: extraActual, remaining: extraBudget - extraActual, status: spendStatus(extraBudget, extraActual) });
    const savBudget = +s.monthlyOutsideSavings || 0, savActual = actualFor(state, 'Outside Savings', mk);
    const savings = { name: 'Outside Savings', group: 'Savings', budget: savBudget, actual: savActual, remaining: savBudget - savActual, status: spendStatus(savBudget, savActual) };
    const interestRows = state.debts.filter(d => !catNames.has(interestCat(d))).map(d => {
      const actual = actualFor(state, interestCat(d), mk);
      return { name: interestCat(d), group: 'Interest (non-cash)', budget: 0, actual, remaining: -actual, status: actual === 0 ? 'Nothing posted' : 'Posted' };
    });
    const livingTotal = spending.reduce((a, r) => a + r.budget, 0);                       // C94
    const plannedDebt = debtRows.filter(r => r.group === 'Debt').reduce((a, r) => a + r.budget, 0); // C95
    const cushion = monthlyNet - (livingTotal + (plannedDebt - extraBudget) + savBudget); // C97
    return { month: monthIso, income, spending, debts: debtRows, savings, interest: interestRows,
      totals: { monthlyNet, livingTotal, plannedDebt, plannedSavings: savBudget, cushion,
        spentLiving: spending.filter(r => !r.interest).reduce((a, r) => a + r.actual, 0) } };
  }

  // ---------- R20 month comparison (workbook Month History) ----------
  function monthFlows(state, mk) {
    const f = { 'Income': 0, 'Total Spend': 0, 'Essential': 0, 'Non-Essential': 0, 'Debt Payments': 0, 'Savings': 0, 'Interest Posted': 0 };
    for (const t of state.transactions) {
      if (!t.date || monthKey(t.date) !== mk) continue;
      const ft = flowType(t, state), a = +t.amount;
      if (ft === 'Income') f['Income'] += a;
      else if (ft === 'Expense') { f['Total Spend'] += a; if (t.essential) f['Essential'] += a; }
      else if (ft === 'Debt Payment') f['Debt Payments'] += a;
      else if (ft === 'Savings') f['Savings'] += a;
      else if (ft === 'Interest') f['Interest Posted'] += a;
    }
    f['Non-Essential'] = f['Total Spend'] - f['Essential'];
    return f;
  }
  const BETTER = { 'Income': 'up', 'Total Spend': 'down', 'Essential': null, 'Non-Essential': 'down', 'Debt Payments': 'up', 'Savings': 'up', 'Interest Posted': 'down' };
  function compareMonths(state, monthIso) {
    const cur = monthFlows(state, monthKey(monthIso)), prevIso = edate(monthIso, -1), prev = monthFlows(state, monthKey(prevIso));
    const prevSum = Object.values(prev).reduce((a, b) => a + b, 0);
    const notLogged = cur['Total Spend'] + cur['Debt Payments'] === 0;
    const rows = Object.keys(cur).map(k => {
      const change = cur[k] - prev[k];
      let direction = prevSum === 0 ? 'no prior data' : (k !== 'Income' && notLogged) ? 'not logged yet' : Math.round(change) === 0 ? 'flat' : change > 0 ? 'up' : 'down';
      const good = BETTER[k] && (direction === 'up' || direction === 'down') ? direction === BETTER[k] : null;
      return { metric: k, current: cur[k], previous: prev[k], change, direction, good };
    });
    return { month: monthIso, previousMonth: prevIso, rows, status: prevSum === 0 ? 'no prior data' : notLogged ? 'not logged yet' : 'ok' };
  }

  // ---------- Payoff Sensitivity ----------
  function sensitivity(state, balances, extra, step = 10000) {
    const sc = [['Base less ' + (2 * step).toLocaleString('en-US'), -2], ['Base less ' + step.toLocaleString('en-US'), -1], ['Your plan', 0],
      ['Base plus ' + step.toLocaleString('en-US'), 1], ['Base plus ' + (2 * step).toLocaleString('en-US'), 2]];
    const base = projectPayoff(state, balances, extra);
    return sc.map(([label, k]) => {
      const x = Math.max(extra + k * step, 0), p = k === 0 ? base : projectPayoff(state, balances, x);
      return { label, extra: x, months: p.months, date: p.date, totalInterest: p.totalInterest,
        interestVsBase: p.totalInterest - base.totalInterest, monthsVsBase: (p.months != null && base.months != null) ? p.months - base.months : null };
    });
  }

  // ---------- R21 statement import (workbook Statement Import + Merchant Rules) ----------
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function validDate(y, m, d) { if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m))) return null; return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  function parseStatementDate(raw, dayFirst = true) {
    if (raw == null) return null; let s = String(raw).trim(); if (!s) return null;
    if (/^\d{5}(\.\d+)?$/.test(s)) { const t = Date.UTC(1899, 11, 30) + Math.floor(+s) * DAY; return iso(t); } // Excel serial
    if (s.includes(',') && /^[A-Za-z]{3,}/.test(s)) s = s.slice(s.indexOf(',') + 1).trim();          // "Thu, 02 Oct 2026"
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) return validDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return dayFirst ? validDate(y, +m[2], +m[1]) : validDate(y, +m[1], +m[2]); }
    m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s,-]+(\d{2,4})/);                                  // 02 Oct 2026
    if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return validDate(y, mo, +m[1]); } }
    m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);                                       // Oct 2, 2026
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return validDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    return null;
  }
  function parseAmount(raw) {
    if (raw == null) return null; if (typeof raw === 'number') return raw;
    let s = String(raw).toUpperCase().replace(/JMD|J\$|\$|,|\s/g, '');
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/CR$/.test(s)) { neg = true; s = s.slice(0, -2); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
    if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
    const n = parseFloat(s); return neg ? -Math.abs(n) : n;
  }
  function matchRule(rules, desc) {
    const d = String(desc || '').toLowerCase();
    for (const r of rules || []) if (r.keyword && d.includes(String(r.keyword).toLowerCase())) return r.category;
    return '';
  }
  function importPreview(state, rows, opts = {}) {
    const method = opts.method || 'Credit Card', dayFirst = opts.dayFirst !== false;
    const card = cardDebt(state);
    const seen = new Set(state.transactions.map(t => t.date + '|' + Math.round(+t.amount * 100)));
    // Pay is often logged on the 1st of the month it funds, a few days after it lands in the bank:
    // a statement line with the same amount within 7 days of a Net Pay entry is the same pay.
    const pay = state.transactions.filter(t => t.category === 'Net Pay' && t.date).map(t => ({ t: D(t.date), c: Math.round(+t.amount * 100) }));
    const nearPay = (date, amount) => pay.some(p => p.c === Math.round(amount * 100) && Math.abs(D(date) - p.t) <= 7 * DAY);
    return rows.map((r, i) => {
      const date = parseStatementDate(r.date, dayFirst), signed = parseAmount(r.amount);
      const description = String(r.description || '').trim();
      const amount = signed == null ? null : Math.abs(signed);
      const isCredit = signed != null && signed < 0 && method === 'Credit Card'; // workbook rule is for card statements
      const suggested = matchRule(state.merchantRules, description);
      const category = r.category ? r.category : (isCredit && card ? paymentCat(card) : suggested);
      const paymentMethod = isCredit ? 'Bank Transfer' : method;
      const cat = state.categories.find(c => c.name === category);
      const essential = cat ? !!cat.essential : !!category;
      let status;
      if (!date || amount == null) status = 'Fix date / amount';
      else if (seen.has(date + '|' + Math.round(amount * 100)) || nearPay(date, amount)) status = 'Already logged';
      else if (!category) status = 'Pick a category';
      else status = 'Ready';
      return { index: i, raw: r, date, description, amount, signed, category, suggested, paymentMethod, essential,
        notes: 'Imported from statement', status, matched: !!suggested && !r.category && !isCredit };
    });
  }
  function splitDelimited(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim() !== '');
    if (!lines.length) return [];
    const delim = lines[0].includes('\t') ? '\t' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ',');
    return lines.map(line => {
      if (delim === '\t') return line.split('\t').map(x => x.trim());
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      out.push(cur.trim()); return out;
    });
  }

  // ---------- reminders (Phase 3) ----------
  function reminders(state, today, calc, horizonDays = 7) {
    const s = state.settings, out = [], horizon = addDays(today, horizonDays);
    const np = calc.nextPayday, dPay = Math.round((D(np) - D(today)) / DAY);
    out.push({ kind: 'payday', date: np, days: dPay, title: dPay === 0 ? 'Payday today' : 'Payday', detail: 'Open the payday breakdown before sending any extra payment.' });
    const from = (s.cashAsOfDate > s.planningMonth ? s.cashAsOfDate : s.planningMonth), per = periodsPerMonth(s);
    for (const d of calc.debts) {
      if (!d.nextDue || d.nextDue > horizon || d.liveBalance <= 0) continue;
      let paid = 0;
      for (const t of state.transactions) if (t.category === paymentCat(d) && t.date >= from) paid += +t.amount;
      const due = (+d.requiredPayment || 0) / per;
      out.push({ kind: 'due', date: d.nextDue, days: Math.round((D(d.nextDue) - D(today)) / DAY), title: d.name + ' payment',
        amount: +d.requiredPayment || 0, payroll: d.paymentSource === 'Payroll', covered: d.paymentSource === 'Payroll' || paid >= due - 0.005, paid });
    }
    for (const b of state.bills) {
      if (b.paid || !b.dueDate) continue;
      if (b.dueDate > np && b.dueDate > horizon) continue;
      out.push({ kind: 'bill', id: b.id, date: b.dueDate, days: Math.round((D(b.dueDate) - D(today)) / DAY), title: b.name, amount: +b.amount, overdue: b.dueDate < today });
    }
    const snapMonth = snapshotDue(state, today);
    if (snapMonth) out.push({ kind: 'snapshot', date: today, days: 0, month: snapMonth, title: 'Record month-end balances', detail: 'for ' + snapMonth.slice(0, 7) });
    return out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  }

  // ---------- R22–R25 savings (workbook Savings tab) ----------
  function payrollSavingsAmount(p, state) {
    // A payroll deduction counts as savings when its kind is Savings, or when part of it is a loan payment
    // (lessDebtId): the rest goes to savings, e.g. a credit union deduction less the loan payment = shares.
    if (p.lessDebtId) { const d = state.debts.find(x => x.id === p.lessDebtId); return Math.max((+p.monthlyAmount || 0) - (d ? +d.requiredPayment || 0 : 0), 0); }
    return String(p.category).toLowerCase() === 'savings' ? (+p.monthlyAmount || 0) : 0;
  }
  function goalNeededPerMonth(stillNeeded, targetDate, today) {
    if (!targetDate || stillNeeded === 0) return null;
    return stillNeeded / Math.max(1, monthsBetween(today, targetDate));
  }
  function savings(state, today, calc) {
    const s = state.settings, accts = state.savingsAccounts || [];
    const total = accts.reduce((a, x) => a + (+x.balance || 0), 0);                                   // R22
    const accessible = accts.filter(x => x.accessible).reduce((a, x) => a + (+x.balance || 0), 0);
    // R23 monthly flow
    const flow = [];
    for (const p of state.payrollDeductions || []) { const amt = payrollSavingsAmount(p, state); if (amt > 0) flow.push({ name: p.name, amount: amt, from: 'Payroll', to: p.savesTo || '', payroll: true }); }
    const em = accts.find(x => x.id === s.emergencyAccountId) || accts.find(x => x.accessible) || null;
    if (+s.monthlyOutsideSavings) flow.push({ name: 'Outside savings', amount: +s.monthlyOutsideSavings, from: 'Take-home', to: em ? em.name : '' });
    for (const c of state.categories) if (c.type === 'Sinking Fund' && +c.monthlyBudget) flow.push({ name: c.name, amount: +c.monthlyBudget, from: 'Take-home', to: c.notes && c.notes.startsWith('→') ? c.notes.slice(1).trim() : '' });
    const monthlySaved = flow.reduce((a, f) => a + f.amount, 0);
    const payrollSaved = flow.filter(f => f.payroll).reduce((a, f) => a + f.amount, 0);
    const savingsRate = (+s.netPayPerPeriod + payrollSaved) ? monthlySaved / (+s.netPayPerPeriod + payrollSaved) : 0;
    // R24 goals
    const goals = (state.savingsGoals || []).map(g => {
      let target = +g.target || 0, targetDate = g.targetDate || null, saved = +g.savedSoFar || 0, planned = +g.plannedPerMonth || 0;
      if (g.targetFrom === 'emergency') target = +s.emergencyFundTarget || 0;
      if (g.targetFrom && g.targetFrom.startsWith('bill:')) { const b = state.bills.find(x => x.id === g.targetFrom.slice(5)); if (b) { target = +b.amount || 0; targetDate = b.dueDate ? edate(b.dueDate, 12) : null; } }
      if (g.savedFrom === 'accessible') saved = accessible;
      if (g.plannedFrom === 'outside') planned = +s.monthlyOutsideSavings || 0;
      if (g.plannedFrom && g.plannedFrom.startsWith('category:')) { const c = state.categories.find(x => x.name === g.plannedFrom.slice(9)); planned = c ? +c.monthlyBudget || 0 : 0; }
      const still = Math.max(target - saved, 0);
      const need = goalNeededPerMonth(still, targetDate, today);
      const projected = still === 0 || planned <= 0 ? null : edate(today, Math.ceil(still / planned));
      const status = still === 0 ? 'Reached' : planned <= 0 ? 'Not funded' : !targetDate ? 'No deadline' : planned >= need * 1.25 ? 'Over-funding' : planned >= need ? 'On track' : 'Behind';
      return { ...g, target, targetDate, saved, planned, stillNeeded: still, neededPerMonth: need, projectedDate: projected, status, progress: target ? Math.min(saved / target, 1) : 0 };
    });
    // R25 emergency cover & save-or-pay
    const essentialBudget = state.categories.filter(c => c.essential && c.type !== 'Sinking Fund').reduce((a, c) => a + (+c.monthlyBudget || 0), 0);
    const takeHomeDebt = state.debts.filter(d => d.paymentSource === 'Take-home').reduce((a, d) => a + (+d.requiredPayment || 0), 0);
    const outgo = essentialBudget + takeHomeDebt;
    const monthsCovered = outgo ? accessible / outgo : 0;
    const minMonths = s.minCoverMonths != null ? +s.minCoverMonths : 1;
    const coverStatus = monthsCovered >= 6 ? 'Strong (6+ months)' : monthsCovered >= 3 ? 'Adequate (3-6 months)' : monthsCovered >= minMonths ? 'Thin' : 'Below minimum';
    const top = state.debts.reduce((best, d) => (!best || d.apr > best.apr) ? d : best, null);
    const shortfall = Math.max(minMonths * outgo - accessible, 0);
    const safeExtra = calc ? calc.safeExtra : 0;
    const toSavings = Math.min(shortfall, safeExtra), toDebt = safeExtra - toSavings;
    const fmt = n => Math.round(n).toLocaleString('en-US');
    const emName = em ? em.name : 'savings';
    const recommendation = safeExtra === 0 ? 'No Safe Extra Payment this cycle - keep the planned savings and minimum payments.'
      : toSavings === 0 ? `Savings cover is at your minimum: put the full ${fmt(safeExtra)} Safe Extra Payment on ${top ? top.name : 'your highest-rate debt'}.`
      : `Move ${fmt(toSavings)} to ${emName} to reach ${minMonths} month(s) of cover, and put ${fmt(toDebt)} on ${top ? top.name : 'your highest-rate debt'}.`;
    return { accounts: accts, total, accessible, flow, monthlySaved, savingsRate, goals,
      cover: { essentialBudget, takeHomeDebt, outgo, monthsCovered, minMonths, status: coverStatus },
      saveOrPay: { topDebt: top ? top.name : null, topApr: top ? top.apr : 0, interestIfOutsideToCard: (+s.monthlyOutsideSavings || 0) * (top ? top.apr : 0),
        shortfall, safeExtra, toSavings, toDebt, emergencyAccount: emName, recommendation } };
  }

  // ---------- S7 payday checklist & S10 weekly check-in ----------
  function weekOfMonth(isoDate) { // WEEKNUM(date) - WEEKNUM(first of month) + 1, weeks starting Sunday
    const { y, m, d } = ymd(isoDate); const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return Math.floor((d - 1 + firstDow) / 7) + 1;
  }
  function cyclePayday(state, today) { const np = nextPayday(state.settings, today); return np === today ? today : lastPayday(state.settings, today); }
  function paydaySteps(state) {
    const s = state.settings, card = cardDebt(state), sym = s.currencySymbol || 'J$';
    const steps = [
      { key: 'salary', label: 'Salary received', why: 'Use actual net pay, not an estimate' },
      { key: 'bills', label: 'Next month bills funded', why: 'Protect essentials before extra debt' }];
    if (card) steps.push({ key: 'card-min', label: 'Credit card minimum protected', why: 'Keep the card minimum covered first' });
    for (const d of state.debts) if (!d.isRevolving && d.paymentSource === 'Take-home') steps.push({ key: 'debt-' + d.id, label: d.name.replace(/ Loan$/, '') + ' payment protected', why: 'Protect the scheduled loan payment' });
    steps.push(
      { key: 'savings', label: 'Emergency savings transfer made', why: 'Build toward ' + sym + Math.round(+s.emergencyFundTarget || 0).toLocaleString('en-US') },
      { key: 'buffer', label: 'Cash buffer kept aside', why: 'Avoid borrowing back from the card' },
      { key: 'safe', label: 'Safe extra payment calculated', why: 'Use the calculator above' },
      { key: 'extra', label: 'Extra debt payment made', why: 'Only after the other steps are complete' });
    return steps;
  }
  function paydayChecklist(state, today) {
    const pd = cyclePayday(state, today), saved = ((state.paydayChecklists || {})[pd]) || {};
    const steps = paydaySteps(state).map(st => ({ ...st, status: saved[st.key] || 'Not Yet' }));
    const done = steps.filter(x => x.status === 'Done').length;
    return { payday: pd, steps, done, score: steps.length ? done / steps.length : 0 };
  }
  function checkInStats(state, monthIso) {
    const mk = monthKey(monthIso), all = state.weeklyCheckIns || [];
    const month = all.filter(c => c.date && monthKey(c.date) === mk);
    const logged = month.length, within = month.filter(c => c.stayedWithinPlan === true).length;
    const noNonEss = month.filter(c => c.nonEssentialCardUse === false).length;
    const clean = month.filter(c => c.stayedWithinPlan === true && c.nonEssentialCardUse === false).length;
    const allLogged = all.filter(c => c.date).length;
    const allScore = allLogged ? (all.filter(c => c.stayedWithinPlan === true).length + all.filter(c => c.nonEssentialCardUse === false).length) / (allLogged * 2) : 0;
    return { logged, within, noNonEss, clean, consistency: logged ? (within + noNonEss) / (logged * 2) : 0,
      allLogged, allConsistency: allScore, monthsWithCheckIn: new Set(all.filter(c => c.date).map(c => monthKey(c.date))).size };
  }
  function followThrough(state, today) {
    const pc = paydayChecklist(state, today), ci = checkInStats(state, monthStart(today));
    const score = (pc.done + ci.logged) / (pc.steps.length + 5);
    const target = state.settings.followThroughTarget != null ? +state.settings.followThroughTarget : 0.8;
    const next = ci.logged === 0 ? 'Log your first weekly check-in' : score >= target ? 'On track — keep showing up' : 'Close out the payday checklist';
    return { score, target, paydayDone: pc.done, paydaySteps: pc.steps.length, checkIns: ci.logged, cleanWeeks: ci.clean, next };
  }
  function checkInDefaults(state, today, calc) {
    // Pre-fill from the log: last 7 days of spending, and any non-essential card purchase.
    const from = addDays(today, -6); let spent = 0, nonEss = false;
    for (const t of state.transactions) {
      if (!t.date || t.date < from || t.date > today || flowType(t, state) !== 'Expense') continue;
      spent += +t.amount; if (t.paymentMethod === 'Credit Card' && !t.essential) nonEss = true;
    }
    return { date: today, spendableCash: calc.cash, cardBalance: calc.card ? calc.card.balance : 0, spentThisWeek: spent, nonEssentialCardUse: nonEss };
  }

  // ---------- D9 month-end balances & trend (workbook Month History K–O) ----------
  function monthEnd(monthIso) { const { y, m } = ymd(monthIso); return dateCapped(y, m, 31); }
  function snapshotSeries(state) {
    const snaps = (state.monthSnapshots || []).filter(x => x.month).slice().sort((a, b) => a.month < b.month ? -1 : 1);
    let prev = null;
    return snaps.map(sn => {
      const per = state.debts.map(d => ({ id: d.id, name: d.name, balance: sn.balances && sn.balances[d.id] != null ? +sn.balances[d.id] : null }));
      const recorded = per.filter(x => x.balance != null);
      const total = recorded.length ? recorded.reduce((a, x) => a + x.balance, 0) : null;          // N = SUM of entered balances
      const change = total != null && prev != null ? total - prev : null;                          // O = N - previous N
      prev = total != null ? total : prev;
      return { month: sn.month, monthKey: monthKey(sn.month), monthEnd: monthEnd(sn.month), debts: per, total, change, note: sn.note || '' };
    });
  }
  function snapshotDue(state, today) {
    // Ask for last month's figures in the first 10 days of a month, or this month's in its last 3 days.
    const { d } = ymd(today), dim = daysInMonth(ymd(today).y, ymd(today).m), have = new Set((state.monthSnapshots || []).map(x => monthKey(x.month)));
    if (!state.debts.length) return null;
    if (d >= dim - 2 && !have.has(monthKey(today))) return monthStart(today);
    if (d <= 10) { const last = edate(monthStart(today), -1); if (!have.has(monthKey(last))) return last; }
    return null;
  }
  function trend(state, calc) {
    const series = snapshotSeries(state).filter(x => x.total != null);
    const pts = series.map(x => ({ date: x.monthEnd, total: x.total, kind: 'recorded' }));
    // Projection continues from today's live balances (Payoff Plan, R17), one point per month-end.
    const proj = calc.payoff.rows.map(r => ({ date: addDays(r.date, -1), total: r.total, kind: 'projected' })); // row m = balance after m months = end of the month before
    const lastRec = pts.length ? pts[pts.length - 1].date : null;
    return { recorded: pts, projected: lastRec ? proj.filter(p => p.date > lastRec) : proj, series };
  }

  // ---------- CSV export (N4) ----------
  function csvCell(v) { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCSV(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
  function transactionsCSV(state) {
    const card = cardDebt(state); let running = card ? +card.balance : 0;
    const rows = [['Date', 'Description', 'Category', 'Amount', 'Payment Method', 'Essential?', 'Notes', 'Month Key', 'CC Impact', 'Projected CC Balance', 'Flow Type']];
    const list = state.transactions.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    for (const t of list) {
      const imp = cardImpact(t, state); running += imp;
      rows.push([t.date, t.description, t.category, (+t.amount).toFixed(2), t.paymentMethod, t.essential ? 'Yes' : 'No', t.notes, monthKey(t.date), imp.toFixed(2), card ? running.toFixed(2) : '', flowType(t, state)]);
    }
    return toCSV(rows);
  }
  function balancesCSV(state, calc) {
    const rows = [['As of', calc.today], [], ['Debt', 'Live Balance', 'APR', 'Required Payment', 'Payment Source', 'Next Due', 'Priority', 'Action', 'Est. Monthly Interest']];
    for (const d of calc.debts) rows.push([d.name, d.liveBalance.toFixed(2), d.apr, (+d.requiredPayment).toFixed(2), d.paymentSource, d.nextDue || '', d.priority, d.action, d.estInterest.toFixed(2)]);
    rows.push([], ['Measure', 'Value'],
      ['Cash on hand (live)', calc.cash.toFixed(2)], ['Safe to spend', calc.safeToSpend.toFixed(2)], ['Safe extra payment', calc.safeExtra.toFixed(2)],
      ['Total debt', calc.totalDebt.toFixed(2)], ['Next payday', calc.nextPayday],
      ['Debt-free date', calc.payoff.date || 'beyond 96 months'], ['Months to debt-free', calc.payoff.months ?? ''], ['Total interest to debt-free', calc.payoff.totalInterest.toFixed(2)]);
    if (calc.card) rows.push(['Card ceiling status', calc.card.status], ['Card ceiling used', calc.card.used.toFixed(4)]);
    rows.push([], ['Savings account', 'Balance', 'Currency', 'Accessible?']);
    for (const a of state.savingsAccounts) rows.push([a.name, (+a.balance).toFixed(2), a.currency, a.accessible ? 'Yes' : 'No']);
    return toCSV(rows);
  }

  const api = { compute, monthlyPlan, monthFlows, compareMonths, sensitivity, savings, payrollSavingsAmount, weekOfMonth, cyclePayday, paydaySteps, paydayChecklist, checkInStats, followThrough, checkInDefaults, snapshotSeries, snapshotDue, trend, monthEnd,
    parseStatementDate, parseAmount, matchRule, importPreview, splitDelimited, reminders, transactionsCSV, balancesCSV, flowType, cardImpact, liveBalance, liveCash, nextPayday, paydayAfterNext, lastPayday, nextDueDate,
    projectPayoff, loanProgress, cardStatus, priorities, periodsPerMonth, paymentCat, interestCat, monthKey, monthStart, edate, addDays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CTEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
