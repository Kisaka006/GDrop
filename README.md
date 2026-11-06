# GDrop

GDrop is an on-demand delivery and concierge web app for Homa Bay, Kenya. The
`index.html` interface is served by an Express API backed by SQLite.

## Run locally

Requires Node.js 22 or newer.

```powershell
npm install
npm start
```

Open [http://localhost:5000](http://localhost:5000). Set `PORT` to change the
port, or `GDROP_DB` to choose a different SQLite database file. By default the
database is created under `data/`.

## Push changes to GitHub

Open PowerShell in the project folder and check which files have changed:

```powershell
git status
```

Stage the files you want to publish, review them, commit, and push to `main`:

```powershell
git add README.md
git diff --cached
git commit -m "Describe your changes"
git push origin main
```

Replace `README.md` with the paths of the files you changed. To stage all
changes instead, use `git add -A`, but review `git status` and `git diff
--cached` first. Never commit `.env` files, passwords, API keys, or other
secrets. If Render is connected to this GitHub repository, it may deploy
automatically after the push.

## Host on Render

GitHub Pages only hosts the static page and cannot run this backend or receive
Daraja callbacks. To host the full app on Render:

1. Push the repository to GitHub and create a Render **Web Service** from it.
2. Select the `main` branch, **Node** runtime, build command `npm install`, and
   start command `npm start`.
3. Set `NODE_ENV=production` and `GDROP_DB=/var/data/gdrop.db`. Attach a
   persistent disk mounted at `/var/data`; otherwise SQLite data will be lost
   when the service is replaced.
4. Wait for the service to deploy and note its `https://<service>.onrender.com`
   URL. Use that URL for the Daraja callback:
   `https://<service>.onrender.com/api/mpesa/callback`.
5. Add the provider variables below in Render's private **Environment**
   settings, save, and redeploy. Do not commit credentials or paste them into
   GitHub.

The public GitHub Pages URL is not the backend or callback URL. The callback
must reach the deployed Node service over HTTPS. The `/health` endpoint can be
used as the Render health check path.

## Production account setup

Demo accounts are deliberately disabled on the public production service. To
create the first production admin without Render Shell access:

1. Generate a long random setup key (at least 32 characters) using a password
   manager. Add it as `GDROP_ADMIN_SETUP_TOKEN` in Render's private environment
   settings and deploy.
2. Visit `https://<your-service>.onrender.com/admin/setup`. Enter the setup
   key, your admin email and name, and a unique password of at least 14
   characters. The password is sent only over HTTPS and stored as a scrypt
   hash.
3. Visit `https://<your-service>.onrender.com/admin` and sign in with the admin
   email and password. Admins use this separate login and dashboard; admin
   credentials cannot sign in through the customer and courier page. Initial
   setup closes as soon as the first admin is created.
4. Remove `GDROP_ADMIN_SETUP_TOKEN` from Render only after confirming the
   database is on persistent storage. Do not set `GDROP_SEED_DEMO=true` on
   the public production service.

The admin password cannot be recovered by the app; save it in a password
manager. Render's free web-service filesystem is ephemeral. If the SQLite
database is stored there, a later deploy or restart can erase accounts and
orders. Use persistent storage or a durable hosted database before treating
this as a permanent production service. Do not remove the bootstrap setting
until the database persists across deploys.

## Protected demo staging

For demos, create a second Render Web Service from the same GitHub repository
and branch. Configure its own persistent disk and a separate `GDROP_DB`, then
set these variables on the staging service only:

```text
NODE_ENV=staging
GDROP_SEED_DEMO=true
GDROP_DB=/var/data/gdrop-staging.db
GDROP_STAGING_USERNAME=your-private-staging-username
GDROP_STAGING_PASSWORD=a-long-unique-random-password
```

Do not add Daraja credentials to the demo staging service: it uses simulated
payments. The app requires HTTP Basic authentication for every staging page
and API request, so share both the staging URL and its access credentials only
with trusted testers.

Demo accounts are seeded outside production:

| Role | Email | Password |
|---|---|---|
| Customer | george@gdrop.co.ke | Password123 |
| Customer | sharon@gdrop.co.ke | Password123 |
| Verified courier | jared@gdrop.co.ke | RiderPass1 |
| Pending courier | maurice@gdrop.co.ke | RiderPass2 |
| Admin | admin@gdrop.co.ke | AdminPass2026 |

Set `GDROP_SEED_DEMO=true` to explicitly seed these accounts in production;
never use demo credentials for a live deployment.

## Included backend flows

- Email-based signup, SQLite-backed accounts, scrypt password hashes, bearer
  sessions with a 20-minute idle timeout, and self-service account erasure.
- Server-calculated order fares: KES 150 base + KES 35/km, KES 250 minimum,
  shopping commission, extra-stop fees, weight surcharges, and tips.
- Customer order tracking, courier dispatch/acceptance, status transitions,
  delivery PINs, shopping receipt uploads, variance approvals, and GPS updates.
- M-Pesa STK push and callback support when Daraja credentials are configured;
  otherwise, local payments run in simulation mode.
- Server-Sent Events for order updates, plus the frontend polling fallback.
- Admin dispatch overview, courier approval, and user erasure.

## Optional integrations

Copy `.env.example` to `.env` for local development, or set these variables in
your host's environment settings:

```text
MPESA_CONSUMER_KEY=
MPESA_CONSUMER_SECRET=
MPESA_SHORTCODE=174379
MPESA_PARTYB=174379
MPESA_PASSKEY=
MPESA_CALLBACK_URL=https://your-public-host/api/mpesa/callback
MPESA_CALLBACK_TOKEN=use-a-long-random-secret
MPESA_ENV=sandbox
MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline
```

Accounts are created with the supplied email and password; phone numbers are
not verified during signup. The phone number is retained for M-Pesa payment
prompts.

Set `NODE_ENV=production` in the hosting provider's environment settings so
production safeguards are enabled.

For real M-Pesa payments, configure all Daraja variables with a valid callback
URL reachable over HTTPS and a long random callback token. The STK prompt is
sent to the phone number on the account. Without Daraja settings, local
payments run in simulation mode and no money moves. Partial provider
configuration is reported as an error instead of silently switching to demo
mode.

Create a Daraja app in the Safaricom Daraja developer portal and start with
sandbox credentials and the sandbox test shortcode/passkey. Set
`MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline` for the confirmed sandbox
Buy Goods/Till setup, or `CustomerPayBillOnline` for a PayBill shortcode. Set
`MPESA_PARTYB` to the PayBill shortcode or Buy Goods Till number (it defaults
to `MPESA_SHORTCODE` when they are the same). Set
`MPESA_CALLBACK_URL` to this deployed app's HTTPS `/api/mpesa/callback` URL and
generate a long random `MPESA_CALLBACK_TOKEN`. Test successful, cancelled, and
timed-out STK prompts in sandbox before switching `MPESA_ENV` to `production`
and replacing all sandbox values with credentials issued for the live
Safaricom shortcode. Never put Daraja secrets in frontend code or commit them
to GitHub.
