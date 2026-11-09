# Vercel and Supabase setup

## 1. Supabase

Create a dedicated Supabase project. Use its SQL Editor to run the complete file:

`supabase/migrations/202611090001_gardens_finance.sql`

Run this initial migration once on the new project. It creates tables, indexes, functions, row-level policies, audit triggers, starter categories, and realtime publication entries where supported. For future changes, add a new migration instead of rerunning this file.

## 2. Approved accounts

Create or invite each user in Supabase **Authentication → Users**. Use the intended email privately. The app does not grant membership through public signup.

Then run the following in the Supabase SQL Editor, replacing placeholders with the corresponding Authentication user UUIDs:

```sql
insert into public.garden_profiles (id, display_name, role) values
  ('JEREMY_AUTH_USER_UUID', 'Jeremy', 'admin'),
  ('GENESIS_AUTH_USER_UUID', 'Genesis', 'viewer'),
  ('KEN_AUTH_USER_UUID', 'Ken', 'viewer');
```

Add only rows for users whose addresses have been supplied. Genesis and Ken can be added later; do not invent their emails. Users establish their own passwords using Supabase's account invitation/recovery flow. Set the Auth Site URL to the deployed app URL and allow its redirect URL before sending invitations. Do not commit real addresses, credentials, or user IDs to this repository.

## 3. Public application configuration

Find the project's URL and publishable key in Supabase's Connect/API settings. Copy `.env.example` to `.env.local` and set:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

These public values identify the project; database policies provide authorization. A legacy anon key also works in the publishable-key variable. Never use the secret/service-role key here.

In Vercel, add these same variables to the project for the intended environments and redeploy. `NEXT_PUBLIC_` values are included at build time, so changing settings without rebuilding does not update an existing deployment. The Supabase marketplace integration may create `NEXT_PUBLIC_SUPABASE_ANON_KEY`; map that public value to the name used above if needed. Keep server-only credentials private.

## 4. GitHub and Vercel

Connect the Vercel project to `jeremycapocyan/thegardenssystem`, with root directory set to the repository root. The repository contains the app at its root; the local parent folder is only a workspace location.

- Framework: Next.js
- Install: `npm ci`
- Build: `npm run build`
- Output: leave the Vercel override unset; its Next.js adapter handles the static export. The local exported files are in `out`.
- Production branch: `main`
- Node: 24.x (pinned in `package.json`)

The app exports static routes and uses Supabase directly with RLS. It has no external spreadsheet connection or server secret in the frontend. If Supabase variables are missing, shared login is disabled and the isolated demo remains available.

## 5. Acceptance check

1. Sign in as Jeremy and confirm live logs are empty apart from starter categories.
2. Add a daily income row and a bill payment. Confirm the dashboard counts the payment once and the bill tracker reflects the selected due month.
3. Sign in as an approved viewer and confirm reports are visible and editing is unavailable. Database policy tests also exercise direct rejected writes.
4. Confirm password invitation redirects use the production URL, and test a second device for shared data synchronization.
5. Keep the demo separate from real records. Establish database backups using Supabase's available backup/export facilities; CSV report exports are not a complete restore source.
