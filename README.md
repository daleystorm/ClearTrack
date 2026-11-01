# ClearTrack

A phone-first personal debt and spending tracker, built from the ClearTrack Debt Tracker workbook's App Spec.

Log spending in seconds and always know your **Safe to Spend**, **Safe Extra Payment**, credit card status and **debt-free date**.

## Your data stays on your phone

This repository contains only the app. There are no accounts and no server: everything you enter is saved in your phone's browser storage and never leaves the device. Use **Setup → Export and backup → Back up now** every week or two, and keep the backup file somewhere safe, such as Google Drive. A backup can be restored on any device with **Restore from a backup**.

Never commit a backup file, a CSV export or the original workbook to this repository: GitHub Pages repositories on a free plan are public.

## Install on Android (Chrome or Samsung Internet)

1. Open the GitHub Pages address for this repository on the phone.
2. Chrome: tap ⋮ → **Add to home screen** → **Install**. Samsung Internet: tap ☰ → **Add page to** → **Home screen**.
3. Open ClearTrack from the home screen. It runs full screen and works offline.

## What's in it

- **Home**: Safe to Spend, cash on hand, Safe Extra Payment, card ceiling meter, coming-up reminders, save-or-pay advice, debt-free date and follow-through score.
- **Spending**: quick add, search and filters, bank/card statement import with merchant rules, CSV export.
- **Plan**: monthly budget vs actual, month-over-month comparison, savings and goals, payday checklist, weekly check-in.
- **Debts**: live balances, priority (avalanche or snowball), loan progress against schedule, month-end balance trend, and a payoff plan with an extra-payment slider.
- **Setup**: pay, cash, card ceilings, savings, budget categories, debts, bills, savings accounts, payroll deductions, goals, merchant rules, backup and restore.

## Building

`source/` holds the app source. `python3 source/build.py` (needs Pillow) regenerates the files at the repository root: `index.html`, `manifest.webmanifest`, `sw.js` and `icons/`.

Not financial advice: ClearTrack is an organisational and calculation tool. Check balances, rates and payments against your statements.
