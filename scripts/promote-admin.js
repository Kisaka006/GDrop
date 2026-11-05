'use strict';

require('dotenv').config();
const path = require('node:path');
const Database = require('better-sqlite3');

const email = String(process.env.GDROP_ADMIN_EMAIL || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Set GDROP_ADMIN_EMAIL to the email address of your verified customer account.');
  process.exit(1);
}

const databasePath = path.resolve(process.env.GDROP_DB || path.join(__dirname, '..', 'data', 'gdrop.db'));
const db = new Database(databasePath);
try {
  const userTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!userTable) throw new Error('Users table not found. Start the GDrop service once to initialize its database.');

  const promote = db.transaction(() => {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) throw new Error(`No account found for ${email}. Sign up and verify its phone number first.`);
    if (user.role !== 'customer') throw new Error('Only a customer account can be promoted to admin.');
    if (!user.phone_verified_at) throw new Error('Verify this account phone number before promoting it.');
    if (!user.odpc_consent_at) throw new Error('The account must have recorded signup consent before promotion.');
    const admin = db.prepare("SELECT email FROM users WHERE role = 'admin' LIMIT 1").get();
    if (admin) throw new Error(`An admin account already exists (${admin.email}). Promotion is limited to the initial bootstrap.`);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    return user.email;
  });

  console.log(`Promoted verified account ${promote()} to admin.`);
} catch (error) {
  console.error(`Admin promotion failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
