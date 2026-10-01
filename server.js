const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { readDb, writeDb } = require('./db');

const ADMIN_CODE = process.env.ADMIN_CODE || '9126';
const ONLINE_WINDOW_MS = 90 * 1000;
const ADMIN_TOKEN_TTL = 2 * 60 * 60 * 1000;
const ROLES = ['', 'Разработчик', 'Администратор', 'Модератор'];

function validUsername(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.\-\u0400-\u04FF]{3,20}$/.test(name);
}

function validPassword(pass) {
  return typeof pass === 'string' && pass.length >= 6 && pass.length <= 100;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makeToken(bytes) {
  return crypto.randomBytes(bytes || 20).toString('hex');
}

function findUser(db, name) {
  const lower = String(name).toLowerCase();
  return db.users.find(u => String(u.username).toLowerCase() === lower);
}

function isBanned(user) {
  if (!user.banned) return false;
  if (user.bannedUntil && user.bannedUntil <= Date.now()) return false;
  return true;
}

async function clearExpiredBan(db, user) {
  if (user.banned && user.bannedUntil && user.bannedUntil <= Date.now()) {
    user.banned = false;
    user.bannedUntil = 0;
    user.bannedReason = '';
    await writeDb(db);
  }
}

function publicUser(u) {
  const online = !!(u.showOnline !== false && u.lastSeenAt && (Date.now() - u.lastSeenAt) < ONLINE_WINDOW_MS);
  return {
    username: u.username,
    avatar: u.avatar || '',
    showOnline: u.showOnline !== false,
    showAvatar: u.showAvatar !== false,
    online: online,
    verified: !!u.verified,
    role: u.role || '',
    createdAt: u.createdAt,
    banned: isBanned(u),
    bannedUntil: u.bannedUntil || 0,
    bannedReason: u.bannedReason || ''
  };
}

function adminUser(u) {
  const p = publicUser(u);
  p.lastSeenAt = u.lastSeenAt || 0;
  return p;
}

function renameEverywhere(db, oldName, newName) {
  db.items.forEach(i => { if (i.author === oldName) i.author = newName; });
  db.chats.forEach(m => {
    if (m.sender === oldName) m.sender = newName;
    if (m.receiver === oldName) m.receiver = newName;
  });
  if (db.carts[oldName]) {
    db.carts[newName] = db.carts[oldName];
    delete db.carts[oldName];
  }
  db.verifications.forEach(v => { if (v.username === oldName) v.username = newName; });
}

function ensureCollections(db) {
  if (!db.verifications) db.verifications = [];
  if (!db.adminTokens) db.adminTokens = {};
  return db;
}

function checkAdmin(db, req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expiry = db.adminTokens[token];
  return !!(token && expiry && expiry > Date.now());
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end('<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GaLink shop</title></head><body style="font-family:sans-serif;background:#111;color:#fff;padding:32px;text-align:center;">' + html + '</body></html>');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 30 * 1024 * 1024) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const routes = [];

function route(method, pattern, handler) {
  const paramNames = [];
  const regexStr = pattern.replace(/:[^/]+/g, (m) => {
    paramNames.push(m.slice(1));
    return '([^/]+)';
  });
  const regex = new RegExp('^' + regexStr + '$');
  routes.push({ method, regex, paramNames, handler });
}

route('POST', '/api/users/register', async (req, res) => {
  const body = await readBody(req);
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  if (!validUsername(username)) return send(res, 400, { error: 'invalid_username' });
  if (!validPassword(password)) return send(res, 400, { error: 'invalid_password' });
  const db = ensureCollections(await readDb());
  if (findUser(db, username)) return send(res, 409, { error: 'taken' });
  const salt = makeToken(16);
  const user = {
    username, passwordSalt: salt, passwordHash: hashPassword(password, salt),
    avatar: '', showOnline: true, showAvatar: true, verified: false, role: '',
    banned: false, bannedUntil: 0, bannedReason: '', createdAt: Date.now(), lastSeenAt: Date.now()
  };
  db.users.push(user);
  await writeDb(db);
  send(res, 201, { user: publicUser(user) });
});

route('POST', '/api/users/login', async (req, res) => {
  const body = await readBody(req);
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  const db = ensureCollections(await readDb());
  const user = findUser(db, username);
  if (!user) return send(res, 404, { error: 'not_found' });
  await clearExpiredBan(db, user);
  if (isBanned(user)) return send(res, 403, { error: 'banned', permanent: !user.bannedUntil, until: user.bannedUntil, reason: user.bannedReason || '' });
  if (!user.passwordHash) return send(res, 401, { error: 'password_required' });
  const attempt = hashPassword(password, user.passwordSalt);
  if (attempt !== user.passwordHash) return send(res, 401, { error: 'wrong_password' });
  user.lastSeenAt = Date.now();
  await writeDb(db);
  send(res, 200, { user: publicUser(user) });
});

route('POST', '/api/users/:username/heartbeat', async (req, res, params) => {
  const db = await readDb();
  const user = findUser(db, params.username);
  if (!user) return send(res, 404, { error: 'not_found' });
  await clearExpiredBan(db, user);
  user.lastSeenAt = Date.now();
  await writeDb(db);
  send(res, 200, { user: publicUser(user) });
});

route('GET', '/api/users/:username', async (req, res, params) => {
  const db = ensureCollections(await readDb());
  const user = findUser(db, params.username);
  if (!user) return send(res, 404, { error: 'not_found' });
  await clearExpiredBan(db, user);
  send(res, 200, { user: publicUser(user) });
});

route('PATCH', '/api/users/:username', async (req, res, params) => {
  const db = ensureCollections(await readDb());
  const user = findUser(db, params.username);
  if (!user) return send(res, 404, { error: 'not_found' });
  const body = await readBody(req);
  const { newUsername, avatar, showOnline, showAvatar, password, currentPassword } = body || {};
  if (password) {
    if (!currentPassword || hashPassword(currentPassword, user.passwordSalt) !== user.passwordHash) {
      return send(res, 403, { error: 'wrong_password' });
    }
    if (!validPassword(password)) return send(res, 400, { error: 'invalid_password' });
    user.passwordSalt = makeToken(16);
    user.passwordHash = hashPassword(password, user.passwordSalt);
  }
  if (newUsername && newUsername !== user.username) {
    if (!validUsername(newUsername)) return send(res, 400, { error: 'invalid_username' });
    const clash = findUser(db, newUsername);
    if (clash && clash.username !== user.username) return send(res, 409, { error: 'taken' });
    renameEverywhere(db, user.username, newUsername);
    user.username = newUsername;
  }
  if (typeof avatar === 'string') user.avatar = avatar;
  if (typeof showOnline === 'boolean') user.showOnline = showOnline;
  if (typeof showAvatar === 'boolean') user.showAvatar = showAvatar;
  await writeDb(db);
  send(res, 200, { user: publicUser(user) });
});

route('GET', '/api/state', async (req, res) => {
  const db = ensureCollections(await readDb());
  send(res, 200, {
    users: db.users.map(publicUser),
    items: db.items,
    chats: db.chats,
    serverTime: Date.now()
  });
});

route('GET', '/api/items', async (req, res) => {
  const db = await readDb();
  const items = db.items.slice().sort((a, b) => b.createdAt - a.createdAt);
  send(res, 200, items);
});

route('POST', '/api/items', async (req, res) => {
  const body = await readBody(req);
  const { title, price, category, author, desc, photos } = body || {};
  const db = ensureCollections(await readDb());
  const authorUser = findUser(db, author);
  if (!title || !author || !authorUser) return send(res, 400, { error: 'invalid_input' });
  await clearExpiredBan(db, authorUser);
  if (isBanned(authorUser)) return send(res, 403, { error: 'banned' });
  const priceNum = Number(price);
  const item = {
    id: 'prod_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    title: String(title).slice(0, 80),
    price: isFinite(priceNum) ? priceNum : 0,
    category: category || 'Разное',
    author,
    desc: String(desc || '').slice(0, 2000),
    photos: Array.isArray(photos) ? photos.slice(0, 3) : [],
    sold: false,
    soldAt: 0,
    createdAt: Date.now()
  };
  db.items.unshift(item);
  await writeDb(db);
  send(res, 201, item);
});

route('PATCH', '/api/items/:id', async (req, res, params) => {
  const db = await readDb();
  const item = db.items.find(i => i.id === params.id);
  if (!item) return send(res, 404, { error: 'not_found' });
  const body = await readBody(req);
  const { author, sold } = body || {};
  if (item.author !== author) return send(res, 403, { error: 'forbidden' });
  if (typeof sold === 'boolean') {
    item.sold = sold;
    item.soldAt = sold ? Date.now() : 0;
  }
  await writeDb(db);
  send(res, 200, item);
});

route('DELETE', '/api/items/:id', async (req, res, params, query) => {
  const db = await readDb();
  const item = db.items.find(i => i.id === params.id);
  if (!item) return send(res, 404, { error: 'not_found' });
  if (item.author !== query.get('author')) return send(res, 403, { error: 'forbidden' });
  db.items = db.items.filter(i => i.id !== params.id);
  Object.keys(db.carts).forEach(u => {
    db.carts[u] = (db.carts[u] || []).filter(id => id !== params.id);
  });
  await writeDb(db);
  send(res, 200, { ok: true });
});

route('GET', '/api/chats/dialogs/:username', async (req, res, params) => {
  const db = await readDb();
  const user = params.username;
  const last = {};
  const unread = {};
  db.chats.forEach(m => {
    let partner = '';
    if (m.sender === user) partner = m.receiver;
    else if (m.receiver === user) partner = m.sender;
    if (!partner) return;
    if (!last[partner] || m.timestamp >= last[partner].timestamp) last[partner] = m;
    if (m.receiver === user && !m.read) unread[partner] = (unread[partner] || 0) + 1;
  });
  const list = Object.keys(last)
    .map(p => ({ partner: p, text: last[p].text, timestamp: last[p].timestamp, unread: unread[p] || 0 }))
    .sort((a, b) => b.timestamp - a.timestamp);
  send(res, 200, list);
});

route('GET', '/api/chats/:userA/:userB', async (req, res, params, query) => {
  const since = Number(query.get('since') || 0);
  const db = await readDb();
  const dialogue = db.chats
    .filter(m =>
      ((m.sender === params.userA && m.receiver === params.userB) ||
       (m.sender === params.userB && m.receiver === params.userA)) &&
      m.timestamp > since
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  send(res, 200, dialogue);
});

route('POST', '/api/chats/:userA/:userB/read', async (req, res, params) => {
  const body = await readBody(req);
  const reader = body && body.reader;
  if (reader !== params.userA && reader !== params.userB) return send(res, 400, { error: 'invalid_input' });
  const other = reader === params.userA ? params.userB : params.userA;
  const db = await readDb();
  let changed = false;
  db.chats.forEach(m => {
    if (m.sender === other && m.receiver === reader && !m.read) {
      m.read = true;
      changed = true;
    }
  });
  if (changed) await writeDb(db);
  send(res, 200, { ok: true });
});

route('POST', '/api/chats', async (req, res) => {
  const body = await readBody(req);
  const { sender, receiver, text } = body || {};
  if (!sender || !receiver || !String(text || '').trim()) return send(res, 400, { error: 'invalid_input' });
  const db = ensureCollections(await readDb());
  const senderUser = findUser(db, sender);
  if (!senderUser) return send(res, 400, { error: 'invalid_input' });
  await clearExpiredBan(db, senderUser);
  if (isBanned(senderUser)) return send(res, 403, { error: 'banned' });
  const msg = {
    id: 'msg_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    sender,
    receiver,
    text: String(text).slice(0, 2000),
    timestamp: Date.now(),
    read: false
  };
  db.chats.push(msg);
  await writeDb(db);
  send(res, 201, msg);
});

route('DELETE', '/api/chats/:userA/:userB', async (req, res, params) => {
  const db = await readDb();
  db.chats = db.chats.filter(m =>
    !((m.sender === params.userA && m.receiver === params.userB) ||
      (m.sender === params.userB && m.receiver === params.userA))
  );
  await writeDb(db);
  send(res, 200, { ok: true });
});

route('GET', '/api/cart/:username', async (req, res, params) => {
  const db = await readDb();
  send(res, 200, db.carts[params.username] || []);
});

route('POST', '/api/cart/:username/toggle', async (req, res, params) => {
  const body = await readBody(req);
  const itemId = body && body.itemId;
  if (!itemId) return send(res, 400, { error: 'invalid_input' });
  const db = await readDb();
  let list = db.carts[params.username] || [];
  if (list.indexOf(itemId) !== -1) list = list.filter(id => id !== itemId);
  else list = list.concat(itemId);
  db.carts[params.username] = list;
  await writeDb(db);
  send(res, 200, list);
});

route('POST', '/api/verify/apply', async (req, res) => {
  const body = await readBody(req);
  const username = String((body && body.username) || '').trim();
  const db = ensureCollections(await readDb());
  const user = findUser(db, username);
  if (!user) return send(res, 404, { error: 'not_found' });
  if (user.verified) return send(res, 409, { error: 'already_verified' });
  const pending = db.verifications.find(v => v.username === user.username && v.status === 'pending');
  if (pending) return send(res, 409, { error: 'already_pending' });
  const record = {
    id: 'ver_' + Date.now(),
    token: makeToken(20),
    username: user.username,
    fullName: String((body && body.fullName) || '').slice(0, 100),
    reason: String((body && body.reason) || '').slice(0, 1000),
    links: String((body && body.links) || '').slice(0, 500),
    status: 'pending',
    createdAt: Date.now()
  };
  db.verifications.push(record);
  await writeDb(db);
  send(res, 201, { token: record.token });
});

route('GET', '/api/verify/approve/:token', async (req, res, params) => {
  const db = ensureCollections(await readDb());
  const record = db.verifications.find(v => v.token === params.token);
  if (!record) return sendHtml(res, 404, '<h2>Заявка не найдена</h2>');
  if (record.status !== 'pending') return sendHtml(res, 200, '<h2>Эта заявка уже обработана: ' + record.status + '</h2>');
  const user = findUser(db, record.username);
  if (user) user.verified = true;
  record.status = 'approved';
  await writeDb(db);
  sendHtml(res, 200, '<h2>Готово! @' + record.username + ' теперь верифицирован(а) ✅</h2>');
});

route('GET', '/api/verify/decline/:token', async (req, res, params) => {
  const db = ensureCollections(await readDb());
  const record = db.verifications.find(v => v.token === params.token);
  if (!record) return sendHtml(res, 404, '<h2>Заявка не найдена</h2>');
  if (record.status !== 'pending') return sendHtml(res, 200, '<h2>Эта заявка уже обработана: ' + record.status + '</h2>');
  record.status = 'declined';
  await writeDb(db);
  sendHtml(res, 200, '<h2>Заявка @' + record.username + ' отклонена</h2>');
});

route('GET', '/api/admin/verifications', async (req, res) => {
  const db = ensureCollections(await readDb());
  if (!checkAdmin(db, req)) return send(res, 401, { error: 'unauthorized' });
  const pending = db.verifications.filter(v => v.status === 'pending').sort((a, b) => b.createdAt - a.createdAt);
  send(res, 200, pending);
});

route('POST', '/api/admin/login', async (req, res) => {
  const body = await readBody(req);
  const code = String((body && body.code) || '');
  if (code !== ADMIN_CODE) return send(res, 403, { error: 'wrong_code' });
  const db = ensureCollections(await readDb());
  const token = makeToken(24);
  db.adminTokens[token] = Date.now() + ADMIN_TOKEN_TTL;
  Object.keys(db.adminTokens).forEach(t => {
    if (db.adminTokens[t] <= Date.now()) delete db.adminTokens[t];
  });
  await writeDb(db);
  send(res, 200, { token });
});

route('GET', '/api/admin/users', async (req, res) => {
  const db = ensureCollections(await readDb());
  if (!checkAdmin(db, req)) return send(res, 401, { error: 'unauthorized' });
  for (const u of db.users) await clearExpiredBan(db, u);
  send(res, 200, db.users.map(adminUser));
});

route('POST', '/api/admin/users/:username/ban', async (req, res, params) => {
  const db = ensureCollections(await readDb());
  if (!checkAdmin(db, req)) return send(res, 401, { error: 'unauthorized' });
  const user = findUser(db, params.username);
  if (!user) return send(res, 404, { error: 'not_found' });
  const body = await readBody(req);
  const permanent = !!(body && body.permanent);
  const minutes = Number((body && body.minutes) || 0);
  user.banned = true;
  user.bannedUntil = permanent ? 0 : Date.now() + Math.max(1, minutes) * 60000;
  user.bannedReason = String((body && body.reason) || '');
  await writeDb(db);
  send(res, 200, adminUser(user));
});

route('POST', '/api/admin/users/:username/unban', async (req, res, params) => {
  const db = ensureCollections(await readDb());
  if (!checkAdmin(db, req)) return send(res, 401, { error: 'unauthorized' });
  const user = findUser(db, params.username);
  if (!user) return send(res, 404, { error: 'not_found' });
  user.banned = false;
  user.bannedUntil = 0;
  user.bannedReason = '';
  await writeDb(db);
  send(res, 200, adminUser(user));
});

route('POST', '/api/admin/users/:username/role', async (req, res, params) => {
  const db = ensureCollections(await readDb());
  if (!checkAdmin(db, req)) return send(res, 401, { error: 'unauthorized' });
  const user = findUser(db, params.username);
  if (!user) return send(res, 404, { error: 'not_found' });
  const body = await readBody(req);
  const role = String((body && body.role) || '');
  if (ROLES.indexOf(role) === -1) return send(res, 400, { error: 'invalid_role' });
  user.role = role;
  await writeDb(db);
  send(res, 200, adminUser(user));
});

route('GET', '/api/health', async (req, res) => {
  send(res, 200, { status: 'ok', time: Date.now() });
});

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.regex.exec(url.pathname);
    if (!match) continue;
    const params = {};
    r.paramNames.forEach((name, idx) => { params[name] = decodeURIComponent(match[idx + 1]); });
    try {
      await r.handler(req, res, params, url.searchParams);
    } catch (e) {
      send(res, 500, { error: 'server_error' });
    }
    return;
  }
  send(res, 404, { error: 'not_found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('GaLink server running on port ' + PORT);
});
