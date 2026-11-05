# GDrop Website

GDrop is an on-demand delivery and concierge web app for Homa Bay, Kenya.

## Layout
- `site/index.html`: the original single-file prototype (localStorage only, kept for reference).
- `gdrop-app/`: the full-stack app (current).
  - `server.js`: Express + SQLite (better-sqlite3) backend. It serves `public/` and the `/api/*` routes.
  - `public/index.html`: the UI (Tailwind CDN, Font Awesome, Leaflet with Esri street tiles) connected to the API.
  - `FLOWS.md`: the main user flows for QA.

## Run
```
cd gdrop-app && npm install && PORT=5000 node server.js
```
The database is `data.db` (override with `GDROP_DB`). Demo data is seeded on the first run.

## Demo accounts
- Customer: george@gdrop.co.ke / Password123 (3 completed orders, so pay-on-delivery is unlocked), sharon@gdrop.co.ke / Password123
- Courier (verified): jared@gdrop.co.ke / RiderPass1
- Courier (pending vetting): maurice@gdrop.co.ke / RiderPass2
- Admin: admin@gdrop.co.ke / AdminPass2026

## Backend features
- Accounts: signup with 6-digit SMS OTP (10 min, 5 attempts), scrypt-hashed passwords, bearer sessions with a 20-minute idle timeout, and ODPC consent plus self-service erasure. Admins cannot self-register.
- Server-side pricing: base KES 150 + 35/km, minimum KES 250, 8% shopping commission, KES 120 per extra stop, weight surcharges, tips, 40 km zone. The courier payout is 80% of the fare plus the tip.
- Orders: pending_payment -> placed -> assigned -> at_store (shopping) -> in_transit -> delivered / cancelled. The KES 100 cancellation fee applies only after a courier is assigned.
- M-Pesa STK push (Daraja), with a callback at `/api/mpesa/callback`. Pay-on-delivery unlocks after 3 completed orders and is never available for shopping.
- Shopping receipts: the courier uploads a till photo and enters the amount. A variance over 10% blocks transit until the customer approves.
- Proof of delivery: a 4-digit PIN, visible only to the customer.
- Live updates over Server-Sent Events (`/api/events`), with a polling fallback. Courier GPS location updates are included.
- Admin: GPV and order stats, a live dispatch ledger, courier vetting approval, and user erasure with a log.

## Integrations (env vars)
- M-Pesa: `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_URL`, `MPESA_ENV=production`. Without these, it runs in simulation mode with a "Simulate PIN" button.
- SMS (Africa's Talking): `AT_API_KEY`, `AT_USERNAME`, `AT_SENDER_ID`. Without these, it runs in demo mode and shows the OTP on screen.

## Notes
- The preview iframe blocks browser storage, so the session token is kept in memory and a page refresh requires signing in again.
- SQLite lives on the host running the server. Use a hosted DB (e.g. Supabase/Postgres) for durable production data.
- Preview app (Computer): https://www.perplexity.ai/computer/a/gdrop-byA2cvxhRWqbOpZk3S0OXg (asset 6f203672-fc61-456a-9b3a-9664dd2d0e5e).
