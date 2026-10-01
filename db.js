const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DB_KEY = 'galink_db';

function emptyDb() {
  return { users: [], items: [], chats: [], carts: {}, verifications: [], adminTokens: {} };
}

function ensureLocalDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(emptyDb(), null, 2));
}

function readLocalDb() {
  ensureLocalDb();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch (e) {
    return emptyDb();
  }
}

function writeLocalDb(data) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

async function upstashCommand(command) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + UPSTASH_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function readDb() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return readLocalDb();
  const raw = await upstashCommand(['GET', DB_KEY]);
  if (!raw) return emptyDb();
  try {
    return JSON.parse(raw);
  } catch (e) {
    return emptyDb();
  }
}

async function writeDb(data) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    writeLocalDb(data);
    return;
  }
  await upstashCommand(['SET', DB_KEY, JSON.stringify(data)]);
}

module.exports = { readDb, writeDb, usingUpstash: !!(UPSTASH_URL && UPSTASH_TOKEN) };
