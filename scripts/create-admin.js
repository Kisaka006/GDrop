'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const readline = require('node:readline');
const Database = require('better-sqlite3');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const stdin = process.stdin;
const stdout = process.stdout;

function prompt(label, secret = false) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command from an interactive Render Shell terminal.'));
  }
  stdout.write(label);
  if (!secret) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    return new Promise((resolve) => rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim());
    }));
  }

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  let answer = '';
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      stdin.removeListener('keypress', onKeypress);
      stdin.setRawMode(false);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(answer);
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        finish(new Error('Admin setup cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'backspace' || key.name === 'delete') {
        answer = answer.slice(0, -1);
      } else if (character && !key.ctrl && !key.meta && character.length === 1) {
        answer += character;
      }
    };
    stdin.on('keypress', onKeypress);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('Run initial admin setup only in the production service shell (NODE_ENV=production).');
  }
  const email = (await prompt('Admin email: ')).toLowerCase();
  if (!emailPattern.test(email)) throw new Error('Enter a valid admin email address.');
  const name = await prompt('Admin display name: ');
  if (name.split(/\s+/).filter(Boolean).length < 2) throw new Error('Enter your first and last name.');
  const password = await prompt('Choose a new password (hidden): ', true);
  if (password.length < 14 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Use a unique password with at least 14 characters, including letters and numbers.');
  }
  const confirmation = await prompt('Confirm password (hidden): ', true);
  if (password !== confirmation) throw new Error('Passwords do not match.');

  const databasePath = path.resolve(process.env.GDROP_DB || path.join(__dirname, '..', 'data', 'gdrop.db'));
  const db = new Database(databasePath);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!table) throw new Error('Users table not found. Start the GDrop service once to initialize its database.');
    const insertAdmin = db.transaction(() => {
      if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
        throw new Error('An admin already exists. This initial admin setup can only run once.');
      }
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
        throw new Error('That email is already in use. Choose another email or use the existing account.');
      }
      const timestamp = Date.now();
      db.prepare(`
        INSERT INTO users(id, name, email, phone, password_hash, role, odpc_consent_at,
          phone_verified_at, created_at)
        VALUES (?, ?, ?, '', ?, 'admin', ?, NULL, ?)
      `).run(`usr_${crypto.randomBytes(8).toString('hex')}`, name, email, hashPassword(password), timestamp, timestamp);
    });
    insertAdmin();
    console.log(`Initial admin ${email} created. Sign in with the password you just chose.`);
    console.log('The password is stored as a hash; save it in your password manager.');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`Admin setup failed: ${error.message}`);
  process.exitCode = 1;
});
