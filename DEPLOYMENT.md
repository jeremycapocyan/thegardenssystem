# Vercel and Supabase setup

Production: [thegardenssystem.vercel.app](https://thegardenssystem.vercel.app). The Vercel project is connected to `jeremycapocyan/thegardenssystem`; pushes to `main` deploy automatically. A dedicated Supabase Free project in Singapore stores the shared workspace.

## 1. Supabase

For a new installation, create a dedicated Supabase project. The current production database is already initialized. To apply versioned migrations from a trusted private local environment, put `POSTGRES_URL_NON_POOLING` in `.env.local`, download the CA certificate from Supabase's **Database → Settings → SSL configuration**, and set `PGSSLROOTCERT` to that certificate's absolute path. Run:

```sh
npm run database:migrate
```

The runner verifies the TLS certificate and hostname, applies migrations atomically, and checks stored migration checksums on subsequent runs. Never modify an applied migration; add another SQL file. Database credentials stay in the ignored environment file and are not needed by the frontend build.

Alternatively, on a fresh project only, use its SQL Editor to run all files under `supabase/migrations/` in filename order.

Use one initialization method; a manual SQL Editor installation does not create the local runner's migration history. The schema creates tables, indexes, functions, row-level policies, audit triggers, starter categories, and realtime publication entries where supported.

## 2. Approved accounts

Create or invite each user in Supabase **Authentication → Users**. Use the intended email privately. The app does not grant membership through public signup.

Then run the following in the Supabase SQL Editor, replacing placeholders with the corresponding Authentication user UUIDs:

```sql
insert into public.garden_profiles (id, display_name, role) values
  ('JEREMY_AUTH_USER_UUID', 'Jeremy', 'admin'),
  ('GENESIS_AUTH_USER_UUID', 'Genesis', 'viewer'),
  ('KEN_AUTH_USER_UUID', 'Ken', 'viewer');
```

Add only rows for users whose addresses have been supplied. Genesis and Ken can be added later; do not invent their emails. Users establish their own passwords using Supabase's account invitation/recovery flow. Set the Auth Site URL to the deployed app URL and allow `https://thegardenssystem.vercel.app/account/` as the invitation/recovery redirect before sending invitations. The `/account/` page lets each person choose their own password. Do not commit real addresses, credentials, or user IDs to this repository.

## 3. Public application configuration

Find the project's URL and publishable key in Supabase's Connect/API settings. Copy `.env.example` to `.env.local` and set:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

These public values identify the project; database policies provide authorization. A legacy anon key also works in the publishable-key variable. Never use the secret/service-role key in either public variable.

Employee invitation requests use `POST /api/team/invite/`. Configure `SUPABASE_SERVICE_ROLE_KEY` as a **server-only** environment variable in local development and Vercel. The route verifies the caller with Supabase Auth and checks their database admin role before inviting or linking an employee. A key named `SUPABASE_SECRET_KEY` is accepted as a server-only alternative. The Supabase/Vercel integration already supplies these private values for the connected deployment. Do not copy them into browser code or Git.

Invitations use the canonical `APP_URL`, defaulting to `https://thegardenssystem.vercel.app`, so an invitation sent from a preview does not lead to an unapproved preview callback. Set `APP_URL` and the corresponding Supabase `/account/` redirect allowlist together when using a different domain.

In Vercel, add these same variables to the project for the intended environments and redeploy. `NEXT_PUBLIC_` values are included at build time, so changing settings without rebuilding does not update an existing deployment. The Supabase marketplace integration may create `NEXT_PUBLIC_SUPABASE_ANON_KEY`; map that public value to the name used above if needed. Keep server-only credentials private.

## 4. GitHub and Vercel

Connect the Vercel project to `jeremycapocyan/thegardenssystem`, with root directory set to the repository root. The repository contains the app at its root; the local parent folder is only a workspace location.

- Framework: Next.js
- Install: `npm ci`
- Build: `npm run build`
- Output: leave the Vercel override unset; its Next.js adapter handles prerendered pages and server endpoints in `.next`.
- Production branch: `main`
- Node: 24.x (pinned in `package.json`)

The app uses the Next.js runtime for authenticated employee invitations and Supabase transactions/RLS for business records. It has no external spreadsheet connection or server secret in the frontend. If public Supabase variables are missing, shared login is disabled and the isolated demo remains available.

## 5. Acceptance check

1. Sign in as Jeremy and confirm existing finance records are preserved. A fresh installation contains starter categories and court QR configuration, with no sample transactions or employees.
2. Add a daily income row and a bill payment. Confirm the dashboard counts the payment once and the bill tracker reflects the selected due month.
3. Sign in as an approved viewer and confirm reports are visible and editing is unavailable. Database policy tests also exercise direct rejected writes.
4. Confirm password invitation redirects use the production URL, and test a second device for shared data synchronization.
5. Keep the demo separate from real records. Establish database backups using Supabase's available backup/export facilities; CSV report exports are not a complete restore source.
6. Register a real employee only when their details are supplied. Invite them through **Employees**, print the court QR, and verify their own-account attendance menu on a phone. Allow camera permission when using the portal scanner; the phone's Camera app can also open the printed QR URL. Confirm that account links return to `/account/` before the employee opens their portal.
7. Apply employee migrations before deploying the employee UI. The migration narrows old finance membership policies before enabling employee roles. Existing finance tests run against every migration, and additional tests cover private HR access, payroll rounding, advance allocations, idempotent cash posting, and QR decoding. Production smoke checks must not insert fictional attendance or salary payments.
