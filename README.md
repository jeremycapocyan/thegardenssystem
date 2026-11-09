# The Gardens · Court Finance

A Next.js finance workspace for a pickleball court, with Philippine peso reports, daily income, one business-payment log, recurring bills, installment agreements, and monthly owner settlements.

## Run locally

Use Node.js 22 or later.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. **Explore sample workspace** works without configuration. Its fictional records are stored only in that browser; they are never copied into the shared database. Reset them in Settings. The sample permission selector affects only the demo.

```sh
npm test
npm run typecheck
npm run build
npm start
```

`npm start` serves the production export at `http://127.0.0.1:3000`. Deployment instructions are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Daily operation

1. In **Income**, enter one end-of-day total for each date and income category. Edit an existing row to correct it; duplicate date/category entries are rejected.
2. In **Fixed bills**, register court rent and other recurring obligations. Reference codes are generated automatically. Select the first effective month and due day. Use **Change terms** to start a different amount in a later month while preserving previous terms.
3. In **Installments**, register the total payable including interest, regular monthly payment, and first due date. Final payments and shorter months adjust automatically.
4. Record each business payment **once in Expenses**. Choose Operating expense, Fixed bill, or Installment. For linked payments, choose the agreement and the month being settled. Partial and multiple payments are supported. Trackers read this single log.
5. Choose Daily, Weekly, or Monthly and a reference date for transaction reports. Weeks are Monday–Sunday. Fixed bills and owner settlements always use the selected calendar month; their **Paid through** date controls which payments have been included. Installment balances use the as-of date across the entire agreement.
6. Record owner withdrawals in **Owner payouts**, choosing the settlement month even when paid later. Withdrawals do not reduce business profit.
7. Add or archive categories in **Settings**. Archived categories remain available on existing records to preserve history.

## Calculation rules

- Integer centavos are used for calculations and storage. Amounts display as PHP with two decimals.
- Net income is actual income less actual operating, bill, and installment payments by payment date.
- Distributable income is `MAX(net income, 0)`. A loss produces zero shares, with no loss carryforward.
- Genesis receives 40%, Ken 40%, and Jeremy the remainder after rounding the first two shares to centavos. This reconciles exactly.
- Daily/weekly shares are indicative. Final owner entitlements use the entire calendar month's net income. The current month's entitlement can change until all its transactions are recorded.
- Bill balances match payments by obligation and due month. Installment progress applies total actual payments to the schedule from the earliest unpaid installment.
- Overpayments remain visible. Record corrections by editing the erroneous entry; the system does not infer refunds or loan renegotiations.

## Shared access

Supabase provides authentication and PostgreSQL. Only explicitly provisioned members can read business data. Jeremy is an admin; Genesis and Ken are viewers. Row-level security enforces these permissions in the database, independently of buttons in the browser. Admin changes generate a server-written audit history. Never put a service-role key or database password into a `NEXT_PUBLIC_` variable.

The migration seeds categories only. Live transaction logs begin empty. There is no automatic Excel import or opening balance; the sample records are separate.

## Verification

The automated suite covers peso precision, date/week/month boundaries, actual payment dates, owner rounding/losses, late settlements, overpayments, partial/final/completed installments, month-end due dates, CSV escaping, and database security. PGlite executes the production SQL migration and verifies admin/viewer/outsider policies, immutable membership roles, bill-version overlaps, transaction rollback, audit permissions, and snapshots exceeding 1,000 records.

The application refreshes shared data on database notifications, window focus, and manual Refresh. A disconnected browser cannot save live changes. CSV exports contain the current filtered report, not a full database backup.
