# The Gardens · Court Finance

A Next.js finance workspace for a pickleball court, with Philippine peso reports, daily income, one business-payment log, recurring bills, installment agreements, and monthly owner settlements.

## Run locally

Use Node.js 24.

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

`npm start` runs the production Next.js server at `http://127.0.0.1:3000`. Deployment instructions are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Daily operation

1. In **Income**, enter one end-of-day total for each date and income category. Edit an existing row to correct it; duplicate date/category entries are rejected.
2. In **Fixed bills**, register court rent and other recurring obligations. Reference codes are generated automatically. Select the first effective month and due day. Use **Change terms** to start a different amount in a later month while preserving previous terms.
3. In **Installments**, register the total payable including interest, regular monthly payment, and first due date. Final payments and shorter months adjust automatically.
4. Record each business payment **once in Expenses**. Choose Operating expense, Fixed bill, or Installment. For linked payments, choose the agreement and the month being settled. Partial and multiple payments are supported. Trackers read this single log.
5. Choose Daily, Weekly, or Monthly and a reference date for transaction reports. Weeks are Monday–Sunday. Fixed bills and owner settlements always use the selected calendar month; their **Paid through** date controls which payments have been included. Installment balances use the as-of date across the entire agreement.
6. Record owner withdrawals in **Owner payouts**, choosing the settlement month even when paid later. Withdrawals do not reduce business profit.
7. Add or archive categories in **Settings**. Archived categories remain available on existing records to preserve history.

## ROI tracker

Open **ROI tracker** to record the actual capital contributed by Genesis, Ken, and Jeremy, including later additions. Enter the original contribution dates. Capital is funding, so recording it does not create income or an expense. No live capital amounts or opening returns are assumed.

The report runs from the earliest recorded capital contribution through the chosen **As of** date. **Business cash ROI = cumulative cash return ÷ contributed capital × 100**. Cash return is actual income less actual expenses, plus any explicitly marked capital purchases. Losses remain negative and increase the capital still to recover; 100% means the business has earned a capital-equivalent amount of cash, not that money has necessarily been paid to owners. This is a cash tracking measure, not an asset valuation, annualized investment return, or profit forecast.

If initial construction or setup purchases are already in **Expenses** and form part of the investment being recovered, mark those existing payments under **Setup costs already in Expenses**, with a reason. They are added back only in the ROI calculation; the original expenses, finance net income, payroll, and owner shares stay unchanged. Do not mark routine operating costs. Linked payroll payments cannot be marked. If setup costs were recorded separately, leave the adjustment section empty.

Owner recovery compares each owner's actual capital with actual **Owner payouts** received by payment date, regardless of settlement month. Funding is not assumed to follow the 40/40/20 profit-share split. Owner payouts do not reduce business cash ROI. Use the monthly cumulative chart, expandable figures, and CSV export to review progress. Finance admins can manage records, finance viewers can report, and employee/staff-only roles have no ROI access.

## Calculation rules

- Integer centavos are used for calculations and storage. Amounts display as PHP with two decimals.
- Net income is actual income less actual operating, bill, and installment payments by payment date.
- Distributable income is `MAX(net income, 0)`. A loss produces zero shares, with no loss carryforward.
- Genesis receives 40%, Ken 40%, and Jeremy the remainder after rounding the first two shares to centavos. This reconciles exactly.
- Daily/weekly shares are indicative. Final owner entitlements use the entire calendar month's net income. The current month's entitlement can change until all its transactions are recorded.
- Bill balances match payments by obligation and due month. Installment progress applies total actual payments to the schedule from the earliest unpaid installment.
- Overpayments remain visible. Record corrections by editing the erroneous entry; the system does not infer refunds or loan renegotiations.

## Shared access

Open **Settings → Accounts & permissions** to create administrator or finance-viewer accounts, invite registered employees, resend password setup emails, and enable/disable access. Administrators never choose or see another user's password. The original Jeremy account is the protected owner.

Administrator permissions are independent: **Finance management**, **Employees & payroll**, and **Account management**. Grant Account management to admins who should invite and manage accounts. Delegated managers cannot grant permissions they do not hold or modify an account outside their permission scope; nobody can demote/disable the owner or edit their own access. Employee accounts cannot be converted into administrator/viewer accounts; use a separate email for dual responsibilities. Disabling an account blocks database reads and writes even with an existing login session. Re-enabling preserves its history. Account changes are audited.

Register employees and workdays in **Employees & payroll**, then invite them either there (Account management permission required) or from Settings. A staff manager without finance access opens the staff workspace; an account manager without finance access can still open `/settings/`. Finance-only admins cannot read private staff records, including HR audit snapshots. Genesis and Ken retain their existing viewer access.

Supabase provides authentication and PostgreSQL. Only explicitly provisioned members can read business data. Row-level security enforces permissions in the database, independently of buttons in the browser. Admin changes generate a server-written audit history. Never put a service-role key or database password into a `NEXT_PUBLIC_` variable.

The migration seeds categories only. Live transaction logs begin empty. There is no automatic Excel import or opening balance; the sample records are separate.

## Employees, attendance, and payroll

Open **Employees & payroll** from Jeremy's finance sidebar, or visit `/team/`.

1. **Employees:** add each person's name, email, employment start, schedule effective date, and recurring workdays. Unchecked days are rest days. Save, then choose **Invite / resend**. The employee uses the email link to set their own password. An invited employee automatically opens `/employee/` after sign-in and cannot access finance or another person's records.
2. **Court QR & settings:** print or download the court QR and display it at the court. Replacing it invalidates the previous printout. Employees scan it with their phone's Camera app, or with **Scan court QR** inside their portal. Scanning opens an action menu; only selecting **Time In** or **Time Out** records attendance. Requests do not create punches. An internet connection is required; device time is never used for live punches. A printed QR is an identifier, not location verification.
3. **Attendance:** choose an employee and payroll period. Correct missing punches with a reason, void accidental attendance, and add dated workday/rest-day overrides. Changes have an audit trail. An open shift cannot be finalized. Review extra time after 11:30 PM; approve all, approve a smaller amount, or approve zero to reject it.
4. **Requests & advances:** approve or reject leave, sick leave, and salary advances. Approving leave requires an explicit paid/unpaid choice. A leave range pays only scheduled workdays. After an advance is approved, **Release cash** records the amount actually paid; approval itself creates no expense.
5. **Payroll:** the periods are 1st–15th and 16th–month-end. Resolve the listed blockers, then finalize each employee's statement. Finalization freezes attendance/rates and recovers outstanding released advances oldest first, capped at earned pay. Excess advance balances carry forward. Record actual salary payments, including partial payments; the unpaid balance stays visible. Finalized statements are locked, so review all corrections before finalizing. Payslips can be exported as CSV.

The standard shift is **3:30–11:30 PM, ₱650**, with an hourly calculation rate of **₱81.25**. Regular pay is ₱650 less the rounded deduction for scheduled time missed, capped at zero. Approved overtime uses actual time after the scheduled finish. Early arrival earns no extra pay. Deductions and overtime are rounded separately to centavos per shift. Paid leave earns the scheduled ₱650; unpaid leave and absences earn zero. Eight hours plus one approved overtime hour earns **₱731.25**. The shift includes all eight hours without a separate unpaid break deduction.

Every actual advance release or salary payment creates exactly one protected **Wages** expense. Advance recovery creates no expense. Finance records use actual payment dates, independently of the period when salary was earned. For example, ₱1,000 advanced and ₱5,500 paid later equals ₱6,500 cash expenses in total. These are manual cash-payment records, not bank transfers. The agreed tracker does not calculate statutory contributions, other pay premiums, or leave quotas.

Genesis and Ken retain finance reports, including cash wage expenses, but cannot read employee requests, personal attendance, or payroll statements. Deactivated employees retain their own history and cannot submit requests or punches.

## Verification

The automated suite covers peso precision, date/week/month boundaries, actual payment dates, owner rounding/losses, late settlements, overpayments, partial/final/completed installments, month-end due dates, CSV escaping, and database security. PGlite executes the production SQL migration and verifies admin/viewer/outsider policies, immutable membership roles, bill-version overlaps, transaction rollback, audit permissions, and snapshots exceeding 1,000 records.

The application refreshes shared data on database notifications, window focus, and manual Refresh. A disconnected browser cannot save live changes. CSV exports contain the current filtered report, not a full database backup.
