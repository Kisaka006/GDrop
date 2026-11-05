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
create the first production admin without shared demo credentials:

1. Configure Africa's Talking SMS variables in Render and redeploy.
2. Register a customer from the live site and complete the SMS phone
   verification.
3. Open the Render Shell for the production service. Run
   `GDROP_ADMIN_EMAIL=your-signup-email@example.com npm run admin:promote`.
   The command uses the service's configured `GDROP_DB`, verifies the account
   is a consented, phone-verified customer, and promotes it once. It does not
   print or change the account password.
4. Sign in with that email and the password chosen at signup. Create other
   users through the verified signup flow.

Run the promotion command only in the production service's shell. Do not set
`GDROP_SEED_DEMO=true` on the public production service.

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

Do not add Daraja or SMS credentials to the demo staging service: it uses
simulated payments and demo OTPs. The app requires HTTP Basic authentication
for every staging page and API request, so share both the staging URL and its
access credentials only with trusted testers.

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

- SQLite-backed accounts, scrypt password hashes, bearer sessions with a
  20-minute idle timeout, OTP verification, and self-service account erasure.
- Server-calculated order fares: KES 150 base + KES 35/km, KES 250 minimum,
  shopping commission, extra-stop fees, weight surcharges, and tips.
- Customer order tracking, courier dispatch/acceptance, status transitions,
  delivery PINs, shopping receipt uploads, variance approvals, and GPS updates.
- M-Pesa STK push and callback support when Daraja credentials are configured;
  otherwise, local payments run in simulation mode.
- Africa's Talking OTP delivery when credentials are configured; otherwise
  the signup response includes a demo verification code.
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
AT_API_KEY=
AT_USERNAME=
AT_SENDER_ID=
```

For phone verification, configure Africa's Talking credentials. The account is
created only after its 6-digit SMS code is verified; orders and M-Pesa payments
are blocked for unverified phone numbers. In local development, missing SMS
credentials enable a visible demo code. On production, signup fails closed
unless SMS is configured; `GDROP_DEMO_OTP=true` is only for explicitly
authorized testing and must not be used by a public service.

Set `NODE_ENV=production` in the hosting provider's environment settings so
production safeguards are enabled.

For real M-Pesa payments, configure all Daraja variables with a valid callback
URL reachable over HTTPS and a long random callback token. The STK prompt is
sent to the account's verified phone number. Without Daraja settings, local
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
