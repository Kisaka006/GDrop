# GDrop

GDrop is an on-demand delivery and concierge web app for Homa Bay, Kenya. The
`index.html` interface is served by an Express API backed by SQLite.

## Run locally

Requires Node.js 18 or newer.

```powershell
npm install
npm start
```

Open [http://localhost:5000](http://localhost:5000). Set `PORT` to change the
port, or `GDROP_DB` to choose a different SQLite database file. By default the
database is created under `data/`.

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

Create a `.env` file or set environment variables in the process environment:

```text
MPESA_CONSUMER_KEY=
MPESA_CONSUMER_SECRET=
MPESA_SHORTCODE=
MPESA_PASSKEY=
MPESA_CALLBACK_URL=https://your-public-host/api/mpesa/callback
MPESA_CALLBACK_TOKEN=use-a-long-random-secret
MPESA_ENV=sandbox
AT_API_KEY=
AT_USERNAME=
AT_SENDER_ID=
```

Use real provider credentials, a long callback token, and an HTTPS callback URL
for deployment. Without M-Pesa settings, payments are simulated and no money
moves. Without SMS settings, OTPs are returned to the frontend for local
testing. Partial provider configuration is reported as an error rather than
silently switching to demo mode.
