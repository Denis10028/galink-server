const http = require('http');
const { URL } = require('url');
const { readDb, writeDb } = require('./db');

function validUsername(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.\-\u0400-\u04FF]{3,20}$/.test(name);
}

function findUser(db, name) {
  const lower = String(name).toLowerCase();
  return db.users.find(u => String(u.username).toLowerCase() === lower);
}

function publicUser(u) {
  return { username: u.username, avatar: u.avatar || '', showOnline: u.showOnline !== false, createdAt: u.createdAt };
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
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(payload);
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
  if (!validUsername(username)) return send(res, 400, { error: 'invalid_username' });
  const db = readDb();
  if (findUser(db, username)) return send(res, 409, { error: 'taken' });
  const user = { username, avatar: '', showOnline: true, createdAt: Date.now() };
  db.users.push(user);
  writeDb(db);
  send(res, 201, { user: publicUser(user) });
});

route('POST', '/api/users/login', async (req, res) => {
  const body = await readBody(req);
  const username = String((body && body.username) || '').trim();
  const db = readDb();
  const user = findUser(db, username);
  if (!user) return send(res, 404, { error: 'not_found' });
  send(res, 200, { user: publicUser(user) });
});

route('GET', '/api/users/:username', async (req, res, params) => {
  const db = readDb();
  const user = findUser(db, params.username);
  if (!user) return send(res, 404, { error: 'not_found' });
  send(res, 200, { user: publicUser(user) });
});

route('PATCH', '/api/users/:username', async (req, res, params) => {
  const db = readDb();
  const user = findUser(db, params.username);
  if (!user) return send(res, 404, { error: 'not_found' });
  const body = await readBody(req);
  const { newUsername, avatar, showOnline } = body || {};
  if (newUsername && newUsername !== user.username) {
    if (!validUsername(newUsername)) return send(res, 400, { error: 'invalid_username' });
    const clash = findUser(db, newUsername);
    if (clash && clash.username !== user.username) return send(res, 409, { error: 'taken' });
    renameEverywhere(db, user.username, newUsername);
    user.username = newUsername;
  }
  if (typeof avatar === 'string') user.avatar = avatar;
  if (typeof showOnline === 'boolean') user.showOnline = showOnline;
  writeDb(db);
  send(res, 200, { user: publicUser(user) });
});

route('GET', '/api/state', async (req, res) => {
  const db = readDb();
  send(res, 200, {
    users: db.users.map(publicUser),
    items: db.items,
    chats: db.chats,
    serverTime: Date.now()
  });
});

route('GET', '/api/items', async (req, res) => {
  const db = readDb();
  const items = db.items.slice().sort((a, b) => b.createdAt - a.createdAt);
  send(res, 200, items);
});

route('POST', '/api/items', async (req, res) => {
  const body = await readBody(req);
  const { title, price, category, author, desc, photos } = body || {};
  const db = readDb();
  if (!title || !author || !findUser(db, author)) return send(res, 400, { error: 'invalid_input' });
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
  writeDb(db);
  send(res, 201, item);
});

route('PATCH', '/api/items/:id', async (req, res, params) => {
  const db = readDb();
  const item = db.items.find(i => i.id === params.id);
  if (!item) return send(res, 404, { error: 'not_found' });
  const body = await readBody(req);
  const { author, sold } = body || {};
  if (item.author !== author) return send(res, 403, { error: 'forbidden' });
  if (typeof sold === 'boolean') {
    item.sold = sold;
    item.soldAt = sold ? Date.now() : 0;
  }
  writeDb(db);
  send(res, 200, item);
});

route('DELETE', '/api/items/:id', async (req, res, params, query) => {
  const db = readDb();
  const item = db.items.find(i => i.id === params.id);
  if (!item) return send(res, 404, { error: 'not_found' });
  if (item.author !== query.get('author')) return send(res, 403, { error: 'forbidden' });
  db.items = db.items.filter(i => i.id !== params.id);
  Object.keys(db.carts).forEach(u => {
    db.carts[u] = (db.carts[u] || []).filter(id => id !== params.id);
  });
  writeDb(db);
  send(res, 200, { ok: true });
});

route('GET', '/api/chats/dialogs/:username', async (req, res, params) => {
  const db = readDb();
  const user = params.username;
  const last = {};
  db.chats.forEach(m => {
    let partner = '';
    if (m.sender === user) partner = m.receiver;
    else if (m.receiver === user) partner = m.sender;
    if (!partner) return;
    if (!last[partner] || m.timestamp >= last[partner].timestamp) last[partner] = m;
  });
  const list = Object.keys(last)
    .map(p => ({ partner: p, text: last[p].text, timestamp: last[p].timestamp }))
    .sort((a, b) => b.timestamp - a.timestamp);
  send(res, 200, list);
});

route('GET', '/api/chats/:userA/:userB', async (req, res, params, query) => {
  const since = Number(query.get('since') || 0);
  const db = readDb();
  const dialogue = db.chats
    .filter(m =>
      ((m.sender === params.userA && m.receiver === params.userB) ||
       (m.sender === params.userB && m.receiver === params.userA)) &&
      m.timestamp > since
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  send(res, 200, dialogue);
});

route('POST', '/api/chats', async (req, res) => {
  const body = await readBody(req);
  const { sender, receiver, text } = body || {};
  if (!sender || !receiver || !String(text || '').trim()) return send(res, 400, { error: 'invalid_input' });
  const db = readDb();
  const msg = {
    id: 'msg_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    sender,
    receiver,
    text: String(text).slice(0, 2000),
    timestamp: Date.now()
  };
  db.chats.push(msg);
  writeDb(db);
  send(res, 201, msg);
});

route('DELETE', '/api/chats/:userA/:userB', async (req, res, params) => {
  const db = readDb();
  db.chats = db.chats.filter(m =>
    !((m.sender === params.userA && m.receiver === params.userB) ||
      (m.sender === params.userB && m.receiver === params.userA))
  );
  writeDb(db);
  send(res, 200, { ok: true });
});

route('GET', '/api/cart/:username', async (req, res, params) => {
  const db = readDb();
  send(res, 200, db.carts[params.username] || []);
});

route('POST', '/api/cart/:username/toggle', async (req, res, params) => {
  const body = await readBody(req);
  const itemId = body && body.itemId;
  if (!itemId) return send(res, 400, { error: 'invalid_input' });
  const db = readDb();
  let list = db.carts[params.username] || [];
  if (list.indexOf(itemId) !== -1) list = list.filter(id => id !== itemId);
  else list = list.concat(itemId);
  db.carts[params.username] = list;
  writeDb(db);
  send(res, 200, list);
});

route('GET', '/api/health', async (req, res) => {
  send(res, 200, { status: 'ok', time: Date.now() });
});

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
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
