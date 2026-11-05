'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 5000);
const databasePath = path.resolve(process.env.GDROP_DB || path.join(__dirname, 'data', 'gdrop.db'));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL,
    national_id TEXT, plate TEXT, license_no TEXT, vetting_status TEXT,
    odpc_consent_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS otps (
    id TEXT PRIMARY KEY, payload TEXT NOT NULL, code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES users(id),
    rider_id TEXT REFERENCES users(id), service_type TEXT NOT NULL, direction TEXT,
    origin TEXT NOT NULL, destination TEXT NOT NULL, recipient_name TEXT,
    recipient_phone TEXT, distance_km REAL NOT NULL, weight_tier TEXT,
    stops TEXT NOT NULL DEFAULT '[]', items TEXT NOT NULL DEFAULT '[]',
    goods_estimate REAL NOT NULL DEFAULT 0, tip REAL NOT NULL DEFAULT 0,
    fare REAL NOT NULL, total REAL NOT NULL, rider_payout REAL NOT NULL,
    payment_method TEXT NOT NULL, payment_status TEXT NOT NULL,
    status TEXT NOT NULL, pod_pin TEXT NOT NULL, mpesa_receipt TEXT,
    cancel_fee REAL NOT NULL DEFAULT 0, scheduled_for TEXT,
    receipt_image TEXT, receipt_amount REAL, variance_status TEXT,
    rider_lat REAL, rider_lng REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
    amount REAL NOT NULL, phone TEXT NOT NULL, status TEXT NOT NULL,
    mode TEXT NOT NULL, checkout_request_id TEXT, receipt TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS erasure_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, erased_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id, created_at);
  CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at);
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
`);

const tariff = {
  baseFare: 150,
  ratePerKm: 35,
  minimumFare: 250,
  shoppingCommissionRate: 0.08,
  multiStopFeePerStop: 120,
  cancellationFee: 100,
  weightSurcharge: { light: 0, medium: 60, heavy: 140 },
  podUnlockAfter: 3,
  varianceThresholdPct: 10,
};
const MAX_RADIUS_KM = 40;
const SESSION_IDLE_MS = 20 * 60 * 1000;
const OTP_LIFETIME_MS = 10 * 60 * 1000;
const events = new Map();
const attempts = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, message, code) {
  throw new HttpError(status, message, code);
}

function now() {
  return Date.now();
}

function onlineVerifiedCouriers() {
  return db.prepare(`
    SELECT count(DISTINCT u.id) AS count FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE u.role = 'rider' AND u.vetting_status = 'VERIFIED' AND s.last_seen >= ?
  `).get(now() - 2 * 60 * 1000).count;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function mpesaPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  return digits;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    nationalId: user.national_id || null,
    plate: user.plate || null,
    licenseNo: user.license_no || null,
    vettingStatus: user.vetting_status || null,
  };
}

function tokenFrom(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function authenticate(req, _res, next) {
  try {
    if (req.originalUrl.startsWith('/api/mpesa/callback')) return next();
    const token = tokenFrom(req) || (req.originalUrl.startsWith('/api/events') ? String(req.query.token || '') : '');
    if (!token) fail(401, 'Please sign in to continue.', 'AUTH_REQUIRED');
    const session = db.prepare(`
      SELECT s.token_hash, s.last_seen, u.* FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
    `).get(hash(token));
    if (!session) fail(401, 'Your session is no longer valid. Please sign in again.', 'SESSION_EXPIRED');
    if (now() - session.last_seen > SESSION_IDLE_MS) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
      fail(401, 'Your session expired after inactivity. Please sign in again.', 'SESSION_EXPIRED');
    }
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), session.token_hash);
    req.user = session;
    req.sessionHash = session.token_hash;
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission to do that.', 'FORBIDDEN'));
    next();
  };
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const timestamp = now();
  db.prepare('INSERT INTO sessions(token_hash, user_id, last_seen, created_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), user.id, timestamp, timestamp);
  return { token, user: publicUser(user) };
}

function emit(eventName, data = {}) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [response, userId] of events) {
    if (!data.userId || data.userId === userId) response.write(message);
  }
}

function readOrder(row, viewerId, includeReceipt = false) {
  if (!row) return null;
  const rider = row.rider_id
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(row.rider_id)
    : null;
  const order = {
    id: row.id,
    customerId: row.customer_id,
    serviceType: row.service_type,
    direction: row.direction,
    origin: row.origin,
    destination: row.destination,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    distanceKm: row.distance_km,
    weightTier: row.weight_tier,
    stops: JSON.parse(row.stops),
    items: JSON.parse(row.items),
    goodsEstimate: row.goods_estimate,
    tip: row.tip,
    fare: row.fare,
    total: row.total,
    riderPayout: row.rider_payout,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    status: row.status,
    mpesaReceipt: row.mpesa_receipt,
    cancelFee: row.cancel_fee,
    scheduledFor: row.scheduled_for,
    hasReceipt: !!row.receipt_image,
    receiptAmount: row.receipt_amount,
    varianceStatus: row.variance_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.customer_id === viewerId) order.podPin = row.pod_pin;
  if (rider) {
    order.rider = { name: rider.name, phone: rider.phone, plate: rider.plate };
    if (row.rider_lat != null && row.rider_lng != null) {
      order.riderLocation = { lat: row.rider_lat, lng: row.rider_lng };
    }
  }
  if (includeReceipt) order.receiptImage = row.receipt_image;
  return order;
}

function getOrder(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function authorizedOrder(req, orderId) {
  const order = getOrder(orderId);
  if (!order) fail(404, 'Order not found.', 'NOT_FOUND');
  if (req.user.role === 'admin') return order;
  if (order.customer_id !== req.user.id && order.rider_id !== req.user.id) {
    fail(403, 'This order does not belong to your account.', 'FORBIDDEN');
  }
  return order;
}

function ensureDemoAccounts() {
  if (process.env.NODE_ENV === 'production' && process.env.GDROP_SEED_DEMO !== 'true') return;
  const seeds = [
    { name: 'George Otieno', email: 'george@gdrop.co.ke', phone: '0712345678', password: 'Password123', role: 'customer' },
    { name: 'Sharon Achieng', email: 'sharon@gdrop.co.ke', phone: '0712345679', password: 'Password123', role: 'customer' },
    { name: 'Jared Ochieng', email: 'jared@gdrop.co.ke', phone: '0712345680', password: 'RiderPass1', role: 'rider', plate: 'KMDG 123A', licenseNo: 'DL-001', nationalId: 'DEMO-001', vettingStatus: 'VERIFIED' },
    { name: 'Maurice Onyango', email: 'maurice@gdrop.co.ke', phone: '0712345681', password: 'RiderPass2', role: 'rider', plate: 'KMDG 456B', licenseNo: 'DL-002', nationalId: 'DEMO-002', vettingStatus: 'PENDING_VETTING' },
    { name: 'GDrop Admin', email: 'admin@gdrop.co.ke', phone: '0712345682', password: 'AdminPass2026', role: 'admin' },
  ];
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users
    (id, name, email, phone, password_hash, role, national_id, plate, license_no, vetting_status, odpc_consent_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const user of seeds) {
    insertUser.run(id('usr'), user.name, user.email, user.phone, hashPassword(user.password), user.role,
      user.nationalId || null, user.plate || null, user.licenseNo || null, user.vettingStatus || null, now(), now());
  }
  const customer = db.prepare('SELECT id FROM users WHERE email = ?').get('george@gdrop.co.ke');
  const rider = db.prepare('SELECT id FROM users WHERE email = ?').get('jared@gdrop.co.ke');
  const completed = db.prepare('SELECT count(*) AS count FROM orders WHERE customer_id = ? AND status = ?').get(customer.id, 'delivered').count;
  const insertOrder = db.prepare(`
    INSERT INTO orders
    (id, customer_id, rider_id, service_type, direction, origin, destination, recipient_name,
     recipient_phone, distance_km, weight_tier, stops, items, goods_estimate, tip, fare,
     total, rider_payout, payment_method, payment_status, status, pod_pin, mpesa_receipt,
     created_at, updated_at)
    VALUES (?, ?, ?, 'courier', 'send', ?, ?, ?, ?, 3, 'light', '[]', '[]', 0, 0,
     255, 255, 204, 'mpesa_prepay', 'PAID', 'delivered', '1234', ?, ?, ?)
  `);
  for (let i = completed; i < 3; i += 1) {
    const timestamp = now() - (3 - i) * 86400000;
    insertOrder.run(`GD-DEMO-${i + 1}`, customer.id, rider.id, 'Homa Bay Town', 'Homa Bay Market',
      'Demo Recipient', '0712345678', `GD${String(i + 1).padStart(8, '0')}`, timestamp, timestamp);
  }
}

ensureDemoAccounts();

async function sendOtp(phone, code) {
  const hasApiKey = !!process.env.AT_API_KEY;
  const hasUsername = !!process.env.AT_USERNAME;
  if (!hasApiKey && !hasUsername) return false;
  if (!hasApiKey || !hasUsername) fail(503, 'Africa\'s Talking configuration is incomplete.', 'SMS_CONFIG_INCOMPLETE');
  const response = await fetch('https://api.africastalking.com/version1/messaging', {
    method: 'POST',
    headers: {
      apiKey: process.env.AT_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      username: process.env.AT_USERNAME,
      to: phone,
      message: `Your GDrop verification code is ${code}. It expires in 10 minutes.`,
      ...(process.env.AT_SENDER_ID ? { from: process.env.AT_SENDER_ID } : {}),
    }),
  });
  if (!response.ok) throw new HttpError(502, 'The SMS provider could not send your verification code.', 'SMS_FAILED');
  return true;
}

async function mpesaRequest(order, payment) {
  const keys = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_URL', 'MPESA_CALLBACK_TOKEN'];
  const configured = keys.filter((key) => process.env[key]).length;
  if (!configured) return { mode: 'simulation', status: 'PENDING' };
  if (configured !== keys.length) fail(503, 'M-Pesa configuration is incomplete.', 'MPESA_CONFIG_INCOMPLETE');
  const host = process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
  const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const authResponse = await fetch(`${host}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  const auth = await authResponse.json();
  if (!authResponse.ok || !auth.access_token) throw new HttpError(502, 'Could not authenticate with M-Pesa.', 'MPESA_AUTH_FAILED');
  const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  const callbackUrl = new URL(process.env.MPESA_CALLBACK_URL);
  callbackUrl.searchParams.set('token', process.env.MPESA_CALLBACK_TOKEN);
  const response = await fetch(`${host}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(payment.amount),
      PartyA: mpesaPhone(payment.phone),
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: mpesaPhone(payment.phone),
      CallBackURL: callbackUrl.toString(),
      AccountReference: order.id,
      TransactionDesc: 'GDrop delivery',
    }),
  });
  const result = await response.json();
  if (!response.ok || result.ResponseCode !== '0') {
    throw new HttpError(502, result.errorMessage || 'M-Pesa could not start the payment prompt.', 'MPESA_PUSH_FAILED');
  }
  return { mode: 'daraja', status: 'PENDING', checkoutRequestId: result.CheckoutRequestID };
}

function startPayment(order) {
  const paymentId = id('pay');
  const payment = { id: paymentId, amount: order.total, phone: order.phone };
  db.prepare(`
    INSERT INTO payments(id, order_id, amount, phone, status, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'PENDING', 'starting', ?, ?)
  `).run(paymentId, order.id, payment.amount, payment.phone, now(), now());
  return mpesaRequest(order, payment).then((result) => {
    db.prepare('UPDATE payments SET mode = ?, checkout_request_id = ?, updated_at = ? WHERE id = ?')
      .run(result.mode, result.checkoutRequestId || null, now(), paymentId);
    db.prepare("UPDATE orders SET status = 'pending_payment', payment_status = 'PENDING', updated_at = ? WHERE id = ?")
      .run(now(), order.id);
    emit('orders');
    return { ...payment, mode: result.mode, status: 'PENDING' };
  }).catch((error) => {
    db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
    throw error;
  });
}

function priceOrder(body) {
  const distance = Number(body.distanceKm);
  const tip = Number(body.tip || 0);
  if (!Number.isFinite(distance) || distance <= 0 || distance > MAX_RADIUS_KM) fail(400, 'Route must be within the 40 km service area.', 'INVALID_DISTANCE');
  if (!Number.isFinite(tip) || tip < 0 || tip > 10000) fail(400, 'Enter a valid tip amount.', 'INVALID_TIP');
  const serviceType = body.serviceType;
  if (!['courier', 'shopping'].includes(serviceType)) fail(400, 'Choose a supported service type.', 'INVALID_SERVICE');
  const stops = Array.isArray(body.stops) ? body.stops.map(String).map((value) => value.trim()).filter(Boolean) : [];
  if (stops.length > 10) fail(400, 'An order can include no more than 10 stops.', 'TOO_MANY_STOPS');
  const items = Array.isArray(body.items) ? body.items.map((item) => {
    if (!item || typeof item !== 'object') fail(400, 'Shopping items must be valid objects.', 'INVALID_ITEMS');
    const qty = Number(item.qty || 1);
    const price = Number(item.price || 0);
    if (!Number.isFinite(qty) || qty < 1 || qty > 100 || !Number.isInteger(qty) || !Number.isFinite(price) || price < 0 || price > 1000000) {
      fail(400, 'Enter valid shopping quantities and estimated prices.', 'INVALID_ITEMS');
    }
    return { name: String(item.name || '').slice(0, 120), qty, price };
  }) : [];
  const goodsEstimate = serviceType === 'shopping'
    ? items.reduce((sum, item) => sum + item.qty * item.price, 0)
    : 0;
  let fare = Math.max(tariff.minimumFare, tariff.baseFare + distance * tariff.ratePerKm);
  if (serviceType === 'shopping') fare += goodsEstimate * tariff.shoppingCommissionRate;
  fare += Math.max(0, stops.length - 1) * tariff.multiStopFeePerStop;
  if (serviceType === 'courier') {
    if (!['light', 'medium', 'heavy'].includes(body.weightTier)) fail(400, 'Choose a valid parcel weight tier.', 'INVALID_WEIGHT');
    fare += tariff.weightSurcharge[body.weightTier];
  }
  fare = Math.round(fare * 100) / 100;
  return { serviceType, distance, tip, fare, total: fare + tip, stops, items, goodsEstimate };
}

app.get('/api/config', (_req, res) => {
  res.json({
    tariff,
    maxRadiusKm: MAX_RADIUS_KM,
    live: {
      onlineCouriers: onlineVerifiedCouriers(),
      openJobs: db.prepare("SELECT count(*) AS count FROM orders WHERE status = 'placed'").get().count,
    },
  });
});

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const password = String(body.password || '');
    const role = body.role;
    if (name.split(/\s+/).filter(Boolean).length < 2) fail(400, 'Enter your full legal name.', 'INVALID_NAME');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.', 'INVALID_EMAIL');
    if (!/^(?:\+254|254)[17]\d{8}$/.test(phone) && !/^0[17]\d{8}$/.test(phone)) fail(400, 'Enter a valid Kenyan phone number.', 'INVALID_PHONE');
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) fail(400, 'Password must be at least 8 characters and contain letters and numbers.', 'WEAK_PASSWORD');
    if (!body.odpcConsent) fail(400, 'Consent is required to create an account.', 'CONSENT_REQUIRED');
    if (!['customer', 'rider'].includes(role)) fail(400, 'Admins cannot self-register.', 'INVALID_ROLE');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'An account with that email already exists.', 'EMAIL_EXISTS');
    if (role === 'rider' && (!body.nationalId?.trim?.() || !body.plate?.trim?.() || !body.licenseNo?.trim?.())) {
      fail(400, 'Courier registration requires National ID, vehicle plate, and licence number.', 'VETTING_REQUIRED');
    }
    const otpId = id('otp');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const payload = {
      id: id('usr'), name, email, phone,
      passwordHash: hashPassword(password), role,
      nationalId: role === 'rider' ? String(body.nationalId).trim() : null,
      plate: role === 'rider' ? String(body.plate).trim().toUpperCase() : null,
      licenseNo: role === 'rider' ? String(body.licenseNo).trim() : null,
    };
    try {
      await sendOtp(phone, code);
    } catch (error) {
      return next(error);
    }
    db.prepare('INSERT INTO otps(id, payload, code_hash, expires_at) VALUES (?, ?, ?, ?)')
      .run(otpId, JSON.stringify(payload), hash(code), now() + OTP_LIFETIME_MS);
    res.status(201).json({
      otpId,
      phone,
      ...(!process.env.AT_API_KEY && !process.env.AT_USERNAME ? { demoCode: code } : {}),
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return next(new HttpError(409, 'An account with that email already exists.', 'EMAIL_EXISTS'));
    next(error);
  }
});

app.post('/api/auth/verify-otp', (req, res, next) => {
  try {
    const otp = db.prepare('SELECT * FROM otps WHERE id = ?').get(String(req.body?.otpId || ''));
    if (!otp || otp.expires_at < now() || otp.attempts >= 5) fail(400, 'That verification code expired. Please register again.', 'OTP_EXPIRED');
    if (hash(String(req.body?.code || '')) !== otp.code_hash) {
      db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(otp.id);
      fail(400, 'That verification code is incorrect.', 'OTP_INVALID');
    }
    const user = JSON.parse(otp.payload);
    db.prepare(`
      INSERT INTO users(id, name, email, phone, password_hash, role, national_id, plate,
        license_no, vetting_status, odpc_consent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.name, user.email, user.phone, user.passwordHash, user.role,
      user.nationalId, user.plate, user.licenseNo, user.role === 'rider' ? 'PENDING_VETTING' : null, now(), now());
    db.prepare('DELETE FROM otps WHERE id = ?').run(otp.id);
    const result = createSession(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
    res.status(201).json(result);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return next(new HttpError(409, 'An account with that email already exists.', 'EMAIL_EXISTS'));
    next(error);
  }
});

app.post('/api/auth/login', (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const key = `${req.ip}:${email}`;
    const entry = attempts.get(key) || { count: 0, until: 0 };
    if (entry.until > now() && entry.count >= 10) fail(429, 'Too many sign-in attempts. Try again later.', 'RATE_LIMITED');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(String(req.body?.password || ''), user.password_hash)) {
      entry.count += 1;
      if (entry.count >= 10) entry.until = now() + 15 * 60 * 1000;
      attempts.set(key, entry);
      fail(401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS');
    }
    attempts.delete(key);
    res.json(createSession(user));
  } catch (error) {
    next(error);
  }
});

app.use('/api', authenticate);

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/auth/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  res.json({ ok: true });
});
app.delete('/api/me', requireRole('customer', 'rider'), (req, res) => {
  const transaction = db.transaction(() => {
    db.prepare('INSERT INTO erasure_log(user_id, erased_at) VALUES (?, ?)').run(req.user.id, now());
    db.prepare('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ? OR rider_id = ?)')
      .run(req.user.id, req.user.id);
    db.prepare('DELETE FROM orders WHERE customer_id = ? OR rider_id = ?').run(req.user.id, req.user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  });
  transaction();
  emit('session', { userId: req.user.id });
  res.json({ ok: true });
});

app.post('/api/orders', requireRole('customer'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const priced = priceOrder(body);
    const paymentMethod = body.paymentMethod === 'mpesa_pod' ? 'mpesa_pod' : 'mpesa_prepay';
    const paidCount = db.prepare("SELECT count(*) AS count FROM orders WHERE customer_id = ? AND status = 'delivered'").get(req.user.id).count;
    if (paymentMethod === 'mpesa_pod' && (paidCount < tariff.podUnlockAfter || priced.serviceType === 'shopping')) {
      fail(400, 'Pay on delivery is available after three completed orders and not for shopping.', 'POD_NOT_AVAILABLE');
    }
    const timestamp = now();
    const orderId = `GD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const status = paymentMethod === 'mpesa_pod' ? 'placed' : 'pending_payment';
    const order = {
      id: orderId, customer_id: req.user.id, service_type: priced.serviceType,
      direction: body.direction === 'receive' ? 'receive' : 'send',
      origin: String(body.origin || priced.stops[0] || '').trim(),
      destination: String(body.destination || '').trim(),
      recipient_name: String(body.recipientName || '').trim(),
      recipient_phone: String(body.recipientPhone || '').trim(),
      distance_km: priced.distance,
      weight_tier: priced.serviceType === 'courier' ? body.weightTier : null,
      stops: JSON.stringify(priced.stops),
      items: JSON.stringify(priced.items),
      goods_estimate: priced.goodsEstimate,
      tip: priced.tip,
      fare: priced.fare,
      total: priced.total,
      rider_payout: Math.round((priced.fare * 0.8 + priced.tip) * 100) / 100,
      payment_method: paymentMethod,
      payment_status: paymentMethod === 'mpesa_pod' ? 'DUE_ON_DELIVERY' : 'PENDING',
      status,
      pod_pin: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
      scheduled_for: body.scheduledFor ? String(body.scheduledFor).slice(0, 100) : null,
      created_at: timestamp, updated_at: timestamp,
    };
    if (!order.origin || !order.destination) fail(400, 'Pickup and destination are required.', 'LOCATIONS_REQUIRED');
    if (priced.serviceType === 'shopping' && !priced.items.some((item) => item.price > 0)) {
      fail(400, 'Add at least one shopping item with an estimated price.', 'ITEMS_REQUIRED');
    }
    if (priced.serviceType === 'courier' && order.recipient_name.split(/\s+/).filter(Boolean).length < 2) {
      fail(400, 'Enter the recipient\'s full name.', 'INVALID_RECIPIENT');
    }
    db.prepare(`
      INSERT INTO orders(id, customer_id, service_type, direction, origin, destination, recipient_name,
        recipient_phone, distance_km, weight_tier, stops, items, goods_estimate, tip, fare, total,
        rider_payout, payment_method, payment_status, status, pod_pin, scheduled_for, created_at, updated_at)
      VALUES (@id, @customer_id, @service_type, @direction, @origin, @destination, @recipient_name,
        @recipient_phone, @distance_km, @weight_tier, @stops, @items, @goods_estimate, @tip, @fare, @total,
        @rider_payout, @payment_method, @payment_status, @status, @pod_pin, @scheduled_for, @created_at, @updated_at)
    `).run(order);
    let payment = null;
    if (paymentMethod !== 'mpesa_pod') {
      const phone = req.user.phone;
      try {
        payment = await startPayment({ ...order, phone });
      } catch (error) {
        db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
        throw error;
      }
    }
    emit('orders');
    res.status(201).json({ order: readOrder(getOrder(orderId), req.user.id), payment });
  } catch (error) {
    next(error);
  }
});

app.get('/api/orders/mine', requireRole('customer'), (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ orders: rows.map((row) => readOrder(row, req.user.id)) });
});

app.get('/api/orders/:id', (req, res, next) => {
  try {
    const order = authorizedOrder(req, req.params.id);
    res.json({ order: readOrder(order, req.user.id) });
  } catch (error) { next(error); }
});

app.post('/api/orders/:id/pay', requireRole('customer'), async (req, res, next) => {
  try {
    const order = authorizedOrder(req, req.params.id);
    if (order.status !== 'pending_payment') fail(400, 'This order is not awaiting payment.', 'INVALID_ORDER_STATE');
    const payment = await startPayment({ ...order, phone: req.user.phone });
    res.status(201).json({ payment });
  } catch (error) { next(error); }
});

app.get('/api/payments/:id', (req, res, next) => {
  const payment = db.prepare(`
    SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.id = ? AND (o.customer_id = ? OR ? = 'admin')
  `).get(req.params.id, req.user.id, req.user.role);
  if (!payment) return next(new HttpError(404, 'Payment not found.', 'NOT_FOUND'));
  res.json({ payment: { id: payment.id, orderId: payment.order_id, amount: payment.amount, phone: payment.phone, mode: payment.mode, status: payment.status, receipt: payment.receipt } });
});

app.post('/api/payments/:id/simulate', requireRole('customer'), (req, res, next) => {
  try {
    const payment = db.prepare(`
      SELECT p.*, o.customer_id, o.id AS order_id FROM payments p
      JOIN orders o ON o.id = p.order_id WHERE p.id = ?
    `).get(req.params.id);
    if (!payment || payment.customer_id !== req.user.id) fail(404, 'Payment not found.', 'NOT_FOUND');
    if (payment.mode !== 'simulation') fail(403, 'Simulation is disabled for live M-Pesa payments.', 'FORBIDDEN');
    if (payment.status !== 'PENDING') fail(400, 'This payment is no longer pending.', 'INVALID_PAYMENT_STATE');
    const order = getOrder(payment.order_id);
    if (!order || order.status === 'cancelled') fail(400, 'This order has already been cancelled.', 'INVALID_ORDER_STATE');
    if (!['success', 'cancel'].includes(req.body?.outcome)) fail(400, 'Choose a valid simulation outcome.', 'INVALID_OUTCOME');
    const success = req.body.outcome === 'success';
    const receipt = success ? `SIM${crypto.randomBytes(5).toString('hex').toUpperCase()}` : null;
    const status = success ? 'SUCCESS' : 'FAILED';
    const orderStatus = success ? 'placed' : 'pending_payment';
    db.prepare('UPDATE payments SET status = ?, receipt = ?, updated_at = ? WHERE id = ?').run(status, receipt, now(), payment.id);
    db.prepare('UPDATE orders SET payment_status = ?, status = ?, mpesa_receipt = ?, updated_at = ? WHERE id = ?')
      .run(success ? 'PAID' : 'FAILED', orderStatus, receipt, now(), payment.order_id);
    emit('orders');
    res.json({ payment: { id: payment.id, amount: payment.amount, status, receipt } });
  } catch (error) { next(error); }
});

app.post('/api/orders/:id/cancel', requireRole('customer'), (req, res, next) => {
  try {
    const order = authorizedOrder(req, req.params.id);
    if (!['pending_payment', 'placed', 'assigned', 'at_store'].includes(order.status)) fail(400, 'This order can no longer be cancelled.', 'INVALID_ORDER_STATE');
    const fee = order.rider_id ? tariff.cancellationFee : 0;
    db.prepare("UPDATE orders SET status = 'cancelled', cancel_fee = ?, updated_at = ? WHERE id = ?")
      .run(fee, now(), order.id);
    emit('orders');
    res.json({ cancellationFee: fee });
  } catch (error) { next(error); }
});

app.get('/api/rider/dashboard', requireRole('rider'), (req, res) => {
  const activeRow = db.prepare("SELECT * FROM orders WHERE rider_id = ? AND status IN ('assigned', 'at_store', 'in_transit') ORDER BY updated_at DESC LIMIT 1").get(req.user.id);
  const available = req.user.vetting_status === 'VERIFIED'
    ? db.prepare("SELECT * FROM orders WHERE status = 'placed' ORDER BY created_at ASC LIMIT 30").all()
    : [];
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayPayout = db.prepare("SELECT COALESCE(sum(rider_payout), 0) AS total FROM orders WHERE rider_id = ? AND status = 'delivered' AND updated_at >= ?").get(req.user.id, todayStart.getTime()).total;
  res.json({
    rider: publicUser(req.user),
    active: activeRow ? readOrder(activeRow, req.user.id) : null,
    open: available.map((row) => readOrder(row, req.user.id)),
    todayPayout,
  });
});

app.post('/api/orders/:id/accept', requireRole('rider'), (req, res, next) => {
  try {
    if (req.user.vetting_status !== 'VERIFIED') fail(403, 'Your courier account must be verified before accepting jobs.', 'VETTING_REQUIRED');
    const order = getOrder(req.params.id);
    if (!order || order.status !== 'placed') fail(409, 'This dispatch is no longer available.', 'JOB_UNAVAILABLE');
    const active = db.prepare("SELECT id FROM orders WHERE rider_id = ? AND status IN ('assigned', 'at_store', 'in_transit')").get(req.user.id);
    if (active) fail(409, 'Finish your active job before accepting another.', 'ACTIVE_JOB_EXISTS');
    const result = db.prepare("UPDATE orders SET rider_id = ?, status = 'assigned', updated_at = ? WHERE id = ? AND status = 'placed'")
      .run(req.user.id, now(), order.id);
    if (!result.changes) fail(409, 'Another courier has already accepted this job.', 'JOB_UNAVAILABLE');
    emit('orders');
    res.json({ order: readOrder(getOrder(order.id), req.user.id) });
  } catch (error) { next(error); }
});

app.post('/api/orders/:id/status', requireRole('rider'), (req, res, next) => {
  try {
    const order = authorizedOrder(req, req.params.id);
    const target = req.body?.status;
    if (order.rider_id !== req.user.id) fail(403, 'Only the assigned courier can update this order.', 'FORBIDDEN');
    if (target === 'at_store' && order.service_type === 'shopping' && order.status === 'assigned') {
      db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(target, now(), order.id);
    } else if (target === 'in_transit' && ['assigned', 'at_store'].includes(order.status)) {
      if (order.variance_status === 'PENDING' || order.variance_status === 'REJECTED') fail(400, 'Resolve the shopping receipt variance before starting transit.', 'VARIANCE_UNRESOLVED');
      if (order.service_type === 'shopping' && order.status !== 'at_store') fail(400, 'Shopping orders must be marked at the store first.', 'INVALID_ORDER_STATE');
      if (order.service_type === 'shopping' && !order.receipt_image) fail(400, 'Upload the store receipt before starting transit.', 'RECEIPT_REQUIRED');
      db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(target, now(), order.id);
    } else {
      fail(400, 'That delivery status transition is not allowed.', 'INVALID_ORDER_STATE');
    }
    emit('orders');
    res.json({ order: readOrder(getOrder(order.id), req.user.id) });
  } catch (error) { next(error); }
});

app.post('/api/orders/:id/deliver', requireRole('rider'), (req, res, next) => {
  try {
    const order = authorizedOrder(req, req.params.id);
    if (order.rider_id !== req.user.id || order.status !== 'in_transit') fail(400, 'Only the assigned courier can complete an order in transit.', 'INVALID_ORDER_STATE');
    if (String(req.body?.pin || '') !== order.pod_pin) fail(400, 'The handover PIN does not match.', 'INVALID_PIN');
    db.prepare("UPDATE orders SET status = 'delivered', updated_at = ? WHERE id = ?").run(now(), order.id);
    emit('orders');
    res.json({ order: readOrder(getOrder(order.id), req.user.id) });
  } catch (error) { next(error); }
});

app.post('/api/orders/:id/receipt', requireRole('rider'), (req, res, next) => {
  try {
    const order = authorizedOrder(req, req.params.id);
    if (order.rider_id !== req.user.id || order.service_type !== 'shopping' || !['at_store', 'in_transit'].includes(order.status)) {
      fail(400, 'A receipt can only be attached to your active shopping order.', 'INVALID_ORDER_STATE');
    }
    const image = req.body?.image;
    if (image && (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 1500000)) {
      fail(400, 'Upload a valid receipt image smaller than 1.1 MB.', 'INVALID_RECEIPT');
    }
    const amount = req.body?.amount == null ? order.receipt_amount : Number(req.body.amount);
    if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 1000000)) fail(400, 'Enter a valid receipt total.', 'INVALID_AMOUNT');
    let varianceStatus = order.variance_status;
    if (amount != null && order.goods_estimate > 0) {
      varianceStatus = (amount - order.goods_estimate) / order.goods_estimate > tariff.varianceThresholdPct / 100
        ? 'PENDING' : 'APPROVED';
    }
    db.prepare('UPDATE orders SET receipt_image = COALESCE(?, receipt_image), receipt_amount = ?, variance_status = ?, updated_at = ? WHERE id = ?')
      .run(image || null, amount, varianceStatus, now(), order.id);
    emit('orders');
    res.json({ order: readOrder(getOrder(order.id), req.user.id) });
  } catch (error) { next(error); }
});

app.get('/api/orders/:id/receipt', (req, res, next) => {
  try {
    const order = authorizedOrder(req, req.params.id);
    if (!order.receipt_image) fail(404, 'No receipt has been uploaded yet.', 'NOT_FOUND');
    res.json({ image: order.receipt_image, amount: order.receipt_amount });
  } catch (error) { next(error); }
});

app.post('/api/orders/:id/variance', requireRole('customer'), (req, res, next) => {
  try {
    const order = authorizedOrder(req, req.params.id);
    if (order.variance_status !== 'PENDING') fail(400, 'There is no receipt variance waiting for approval.', 'INVALID_VARIANCE_STATE');
    if (!['approve', 'reject'].includes(req.body?.decision)) fail(400, 'Choose approve or reject.', 'INVALID_DECISION');
    db.prepare('UPDATE orders SET variance_status = ?, updated_at = ? WHERE id = ?')
      .run(req.body.decision === 'approve' ? 'APPROVED' : 'REJECTED', now(), order.id);
    emit('orders');
    res.json({ order: readOrder(getOrder(order.id), req.user.id) });
  } catch (error) { next(error); }
});

app.post('/api/rider/location', requireRole('rider'), (req, res, next) => {
  const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return next(new HttpError(400, 'Enter valid GPS coordinates.', 'INVALID_LOCATION'));
  }
  const result = db.prepare("UPDATE orders SET rider_lat = ?, rider_lng = ?, updated_at = ? WHERE rider_id = ? AND status IN ('assigned', 'at_store', 'in_transit')")
    .run(lat, lng, now(), req.user.id);
  if (!result.changes) return next(new HttpError(404, 'You have no active delivery to update.', 'NO_ACTIVE_ORDER'));
  emit('orders');
  res.json({ ok: true });
});

app.get('/api/events', (req, res, next) => {
  const token = String(req.query.token || '');
  if (!token) return next(new HttpError(401, 'Sign in to receive live updates.', 'AUTH_REQUIRED'));
  const session = db.prepare('SELECT s.token_hash, s.last_seen, u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hash(token));
  if (!session || now() - session.last_seen > SESSION_IDLE_MS) return next(new HttpError(401, 'Your session expired.', 'SESSION_EXPIRED'));
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  events.set(res, session.id);
  const heartbeat = setInterval(() => {
    const currentSession = db.prepare('SELECT last_seen FROM sessions WHERE token_hash = ?').get(session.token_hash);
    if (!currentSession || now() - currentSession.last_seen > SESSION_IDLE_MS) {
      res.write('event: session\ndata: {}\n\n');
      res.end();
    } else {
      res.write(': heartbeat\n\n');
    }
  }, 15000);
  req.on('close', () => { clearInterval(heartbeat); events.delete(res); });
});

app.get('/api/admin/overview', requireRole('admin'), (_req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
  const ordersByStatus = {};
  for (const row of db.prepare('SELECT status, count(*) AS count FROM orders GROUP BY status').all()) {
    ordersByStatus[row.status] = row.count;
  }
  const verifiedCouriers = users.filter((user) => user.role === 'rider' && user.vetting_status === 'VERIFIED').length;
  const stats = {
    totalUsers: users.length,
    customers: users.filter((user) => user.role === 'customer').length,
    couriers: users.filter((user) => user.role === 'rider').length,
    activeRiders: db.prepare("SELECT count(DISTINCT rider_id) AS count FROM orders WHERE status IN ('assigned', 'at_store', 'in_transit')").get().count,
    onlineCouriers: onlineVerifiedCouriers(),
    verifiedCouriers,
    deliveredRevenue: db.prepare("SELECT COALESCE(sum(total), 0) AS total FROM orders WHERE status = 'delivered'").get().total,
    ordersByStatus,
  };
  const recentOrders = orders.map((row) => ({
    ...readOrder(row, 'admin'),
    customer: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.customer_id) || {}),
  }));
  const erasureLogs = db.prepare('SELECT user_id, erased_at FROM erasure_log ORDER BY erased_at DESC LIMIT 100').all()
    .map((row) => ({ createdAt: row.erased_at, message: `Account ${row.user_id} erased` }));
  res.json({ stats, users: users.map(publicUser), recentOrders, erasureLogs });
});

app.post('/api/admin/couriers/:id/approve', requireRole('admin'), (req, res, next) => {
  const result = db.prepare("UPDATE users SET vetting_status = 'VERIFIED' WHERE id = ? AND role = 'rider'").run(req.params.id);
  if (!result.changes) return next(new HttpError(404, 'Courier not found.', 'NOT_FOUND'));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  emit('radar');
  res.json({ user: publicUser(user) });
});

app.delete('/api/admin/users/:id', requireRole('admin'), (req, res, next) => {
  if (req.params.id === req.user.id) return next(new HttpError(400, 'Use a separate administrator account to remove this account.', 'SELF_ERASURE_BLOCKED'));
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return next(new HttpError(404, 'User not found.', 'NOT_FOUND'));
  const transaction = db.transaction(() => {
    db.prepare('INSERT INTO erasure_log(user_id, erased_at) VALUES (?, ?)').run(user.id, now());
    db.prepare('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ? OR rider_id = ?)')
      .run(user.id, user.id);
    db.prepare('DELETE FROM orders WHERE customer_id = ? OR rider_id = ?').run(user.id, user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });
  transaction();
  emit('session', { userId: user.id });
  res.json({ ok: true });
});

app.post('/api/mpesa/callback', (req, res, next) => {
  try {
    const expectedToken = process.env.MPESA_CALLBACK_TOKEN || '';
    const providedToken = String(req.query.token || '');
    if (!expectedToken || Buffer.byteLength(expectedToken) !== Buffer.byteLength(providedToken) ||
        !crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(providedToken))) {
      fail(403, 'M-Pesa callback authentication failed.', 'INVALID_CALLBACK_TOKEN');
    }
    const callback = req.body?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID) fail(400, 'Invalid M-Pesa callback payload.', 'INVALID_CALLBACK');
    const payment = db.prepare('SELECT * FROM payments WHERE checkout_request_id = ?').get(callback.CheckoutRequestID);
    if (!payment || payment.status !== 'PENDING') return res.json({ ResultCode: 0, ResultDesc: 'Callback acknowledged' });
    const order = getOrder(payment.order_id);
    if (!order || order.status === 'cancelled') {
      db.prepare("UPDATE payments SET status = 'FAILED', updated_at = ? WHERE id = ?").run(now(), payment.id);
      return res.json({ ResultCode: 0, ResultDesc: 'Callback acknowledged' });
    }
    const success = Number(callback.ResultCode) === 0;
    const metadata = callback.CallbackMetadata?.Item || [];
    const receipt = metadata.find((item) => item.Name === 'MpesaReceiptNumber')?.Value || null;
    db.prepare('UPDATE payments SET status = ?, receipt = ?, updated_at = ? WHERE id = ?')
      .run(success ? 'SUCCESS' : 'FAILED', receipt, now(), payment.id);
    db.prepare('UPDATE orders SET payment_status = ?, status = ?, mpesa_receipt = ?, updated_at = ? WHERE id = ?')
      .run(success ? 'PAID' : 'FAILED', success ? 'placed' : 'pending_payment', receipt, now(), payment.order_id);
    emit('orders');
    res.json({ ResultCode: 0, ResultDesc: 'Callback acknowledged' });
  } catch (error) { next(error); }
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/GDrop.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use((req, _res, next) => next(new HttpError(404, 'Not found.', 'NOT_FOUND')));
app.use((error, _req, res, _next) => {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: status === 500 ? 'The server could not complete that request.' : error.message,
    ...(error.code ? { code: error.code } : {}),
  });
});

const server = app.listen(port, () => {
  console.log(`GDrop listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    for (const response of events.keys()) response.end();
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
