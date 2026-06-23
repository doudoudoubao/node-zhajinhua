'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const zjhStore = require('./src/zhajinhua/store');
const rooms = require('./src/zhajinhua/rooms');
const userStore = require('./src/auth/store');
const sessions = require('./src/auth/sessions');
const presence = require('./src/zhajinhua/presence');

const PORT = process.env.PORT || 25500;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  if (file.endsWith('/')) file += 'index.html'; // 目录访问回退到 index.html
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    const ext = path.extname(full).toLowerCase();
    send(res, 200, data, MIME[ext] || 'application/octet-stream');
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

/** 新建一局炸金花。 */
async function handleZjhNew(req, res) {
  let payload = {};
  try {
    const body = await readBody(req);
    payload = JSON.parse(body || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: '无效的 JSON 请求体' });
  }
  const table = zjhStore.create({
    botCount: payload.botCount,
    ante: payload.ante,
    startChips: payload.startChips,
    maxStake: payload.maxStake,
    maxRounds: payload.maxRounds,
    playerName: payload.playerName,
  });
  sendJson(res, 200, table.getView());
}

/** 你的一次动作（look/call/raise/compare/fold/next）。 */
async function handleZjhAction(req, res) {
  let payload = {};
  try {
    const body = await readBody(req);
    payload = JSON.parse(body || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: '无效的 JSON 请求体' });
  }
  const table = zjhStore.get(payload.gameId);
  if (!table) return sendJson(res, 404, { error: '对局不存在或已过期，请重新开始' });
  const r = table.playerAction(payload.action, payload.arg);
  if (r && r.error) return sendJson(res, 400, { error: r.error, ...table.getView() });
  sendJson(res, 200, table.getView());
}

/** 查询对局当前状态。 */
function handleZjhState(res, params) {
  const table = zjhStore.get(params.get('gameId'));
  if (!table) return sendJson(res, 404, { error: '对局不存在或已过期' });
  sendJson(res, 200, table.getView());
}

// ===== 用户系统 =====

function currentUser(req) {
  const s = sessions.fromRequest(req);
  if (!s) return null;
  return userStore.getById(s.userId);
}

function sendJsonWithCookie(res, status, obj, cookie) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Set-Cookie': cookie,
  });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  const body = await readBody(req);
  return JSON.parse(body || '{}');
}

async function handleRegister(req, res) {
  let p;
  try { p = await readJson(req); } catch (e) { return sendJson(res, 400, { error: '无效的请求体' }); }
  try {
    const user = userStore.register(p.username, p.password);
    const sid = sessions.create(user);
    sendJsonWithCookie(res, 200, { user }, sessions.setCookieHeader(sid));
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

async function handleLogin(req, res) {
  let p;
  try { p = await readJson(req); } catch (e) { return sendJson(res, 400, { error: '无效的请求体' }); }
  const user = userStore.verify(p.username, p.password);
  if (!user) return sendJson(res, 401, { error: '用户名或密码错误' });
  const sid = sessions.create(user);
  sendJsonWithCookie(res, 200, { user }, sessions.setCookieHeader(sid));
}

function handleLogout(req, res) {
  const sid = sessions.parseCookie(req);
  sessions.destroy(sid);
  sendJsonWithCookie(res, 200, { ok: true }, sessions.clearCookieHeader());
}

function handleMe(req, res) {
  const user = currentUser(req);
  sendJson(res, 200, { user: user || null });
}

// ===== 个人资料 / 金币 / 战绩 / 排行榜 =====

function handleProfile(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  sendJson(res, 200, { profile: userStore.getProfile(user.id) });
}

async function handleSetAvatar(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  let p = {};
  try { p = await readJson(req); } catch (e) { /* ignore */ }
  try {
    const avatar = userStore.setAvatar(user.id, p.avatar);
    sendJson(res, 200, { ok: true, avatar });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

function handleCheckin(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  sendJson(res, 200, userStore.checkin(user.id));
}

function handleLeaderboard(req, res) {
  sendJson(res, 200, { leaderboard: userStore.leaderboard(20) });
}

// ===== 联机大厅 =====

async function handleRoomCreate(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  let p = {};
  try { p = await readJson(req); } catch (e) { /* 用默认值 */ }
  try {
    const room = rooms.create(user, p);
    sendJson(res, 200, { roomId: room.id, room: room.summary() });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

function handleRoomList(req, res) {
  sendJson(res, 200, { rooms: rooms.list() });
}

/** 房间内的各类操作（join/leave/start/addbot/removebot/action）。 */
async function handleRoomOp(req, res, op) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  let p = {};
  try { p = await readJson(req); } catch (e) { /* 允许空体 */ }
  const room = rooms.get(p.roomId);
  if (!room) return sendJson(res, 404, { error: '房间不存在或已解散' });

  let r;
  switch (op) {
    case 'enter': r = room.enter(user, p.password); break;
    case 'sit': r = room.sit(user); break;
    case 'stand': r = room.stand(user); break;
    case 'leave': r = room.leave(user.id); break;
    case 'start': r = room.start(user.id); break;
    case 'addbot': r = room.addBot(user.id); break;
    case 'removebot': r = room.removeBot(user.id); break;
    case 'action': r = room.action(user.id, p.action, p.arg); break;
    case 'chat': r = room.sendChat(user, p.text); break;
    case 'auto': r = room.setAuto(user.id, p.on); break;
    case 'kick': r = room.kick(user.id, parseInt(p.seat, 10)); break;
    default: r = { error: '未知操作' };
  }
  if (r && r.error) return sendJson(res, 400, { error: r.error });
  sendJson(res, 200, { ok: true, ...r, view: room.viewFor(user.id) });
}

// ===== 好友系统 =====

function handleFriendsList(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  const friends = userStore.listFriends(user.id).map((f) => ({
    id: f.id,
    username: f.username,
    online: presence.isOnline(f.id),
    room: rooms.findByUser(f.id),
  }));
  const requests = userStore.listRequests(user.id);
  sendJson(res, 200, { friends, requests });
}

async function handleFriendRequest(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  let p = {};
  try { p = await readJson(req); } catch (e) { /* ignore */ }
  try {
    const r = userStore.sendFriendRequest(user.id, p.username);
    if (r.mutual) {
      presence.notify(r.to.id, { type: 'friend_accepted', user: { id: user.id, username: user.username } });
    } else {
      presence.notify(r.to.id, { type: 'friend_request', from: { id: user.id, username: user.username } });
    }
    sendJson(res, 200, { ok: true, mutual: !!r.mutual });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

async function handleFriendAccept(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  let p = {};
  try { p = await readJson(req); } catch (e) { /* ignore */ }
  try {
    userStore.acceptFriend(user.id, p.fromId);
    presence.notify(p.fromId, { type: 'friend_accepted', user: { id: user.id, username: user.username } });
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

async function handleFriendDecline(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  let p = {};
  try { p = await readJson(req); } catch (e) { /* ignore */ }
  userStore.declineFriend(user.id, p.fromId);
  sendJson(res, 200, { ok: true });
}

async function handleFriendRemove(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  let p = {};
  try { p = await readJson(req); } catch (e) { /* ignore */ }
  userStore.removeFriend(user.id, p.friendId);
  sendJson(res, 200, { ok: true });
}

async function handleInvite(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  let p = {};
  try { p = await readJson(req); } catch (e) { /* ignore */ }
  const room = rooms.get(p.roomId);
  if (!room) return sendJson(res, 404, { error: '房间不存在' });
  if (!userStore.friendIds(user.id).includes(p.friendId)) {
    return sendJson(res, 400, { error: '对方不是你的好友' });
  }
  room.authorize(p.friendId); // 被邀请者免密进入
  const sent = presence.notify(p.friendId, {
    type: 'invite',
    room: { id: room.id, name: room.name },
    from: { username: user.username },
  });
  sendJson(res, 200, { ok: true, delivered: sent });
}

/** 全局通知 SSE：好友上下线、好友申请、房间邀请。 */
function handleNotifyStream(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  presence.register(user.id, res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    presence.unregister(user.id, res);
  });
}

/** SSE 实时推送房间状态。 */
function handleRoomStream(req, res, params) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: '请先登录' });
  const room = rooms.get(params.get('roomId'));
  if (!room) return sendJson(res, 404, { error: '房间不存在或已解散' });
  if (!room.authorized.has(user.id) && !room.memberByUser(user.id)) {
    return sendJson(res, 403, { error: '请先进入房间' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲，保证实时推送
  });
  res.write('retry: 3000\n\n');

  room.addSubscriber(user.id, res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    room.removeSubscriber(user.id, res);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (req.method === 'POST' && pathname === '/zhajinhua/api/new') {
      return await handleZjhNew(req, res);
    }
    if (req.method === 'POST' && pathname === '/zhajinhua/api/action') {
      return await handleZjhAction(req, res);
    }
    if (req.method === 'GET' && pathname === '/zhajinhua/api/state') {
      return handleZjhState(res, parsed.searchParams);
    }

    // 用户系统
    if (req.method === 'POST' && pathname === '/auth/register') return await handleRegister(req, res);
    if (req.method === 'POST' && pathname === '/auth/login') return await handleLogin(req, res);
    if (req.method === 'POST' && pathname === '/auth/logout') return handleLogout(req, res);
    if (req.method === 'GET' && pathname === '/auth/me') return handleMe(req, res);

    // 个人资料 / 金币 / 排行榜
    if (req.method === 'GET' && pathname === '/zhajinhua/api/profile') return handleProfile(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/profile/avatar') return await handleSetAvatar(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/checkin') return handleCheckin(req, res);
    if (req.method === 'GET' && pathname === '/zhajinhua/api/leaderboard') return handleLeaderboard(req, res);

    // 联机大厅与房间
    if (req.method === 'GET' && pathname === '/zhajinhua/api/rooms') return handleRoomList(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/create') return await handleRoomCreate(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/enter') return await handleRoomOp(req, res, 'enter');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/sit') return await handleRoomOp(req, res, 'sit');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/stand') return await handleRoomOp(req, res, 'stand');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/leave') return await handleRoomOp(req, res, 'leave');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/start') return await handleRoomOp(req, res, 'start');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/addbot') return await handleRoomOp(req, res, 'addbot');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/removebot') return await handleRoomOp(req, res, 'removebot');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/action') return await handleRoomOp(req, res, 'action');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/chat') return await handleRoomOp(req, res, 'chat');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/auto') return await handleRoomOp(req, res, 'auto');
    if (req.method === 'POST' && pathname === '/zhajinhua/api/room/kick') return await handleRoomOp(req, res, 'kick');
    if (req.method === 'GET' && pathname === '/zhajinhua/api/room/stream') return handleRoomStream(req, res, parsed.searchParams);

    // 好友系统与全局通知
    if (req.method === 'GET' && pathname === '/zhajinhua/api/friends') return handleFriendsList(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/friends/request') return await handleFriendRequest(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/friends/accept') return await handleFriendAccept(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/friends/decline') return await handleFriendDecline(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/friends/remove') return await handleFriendRemove(req, res);
    if (req.method === 'POST' && pathname === '/zhajinhua/api/friends/invite') return await handleInvite(req, res);
    if (req.method === 'GET' && pathname === '/zhajinhua/api/notify/stream') return handleNotifyStream(req, res);
    if (req.method === 'GET' && pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
    }
    // 根路径与 /zhajinhua 直接进入游戏
    if (req.method === 'GET' && (pathname === '/' || pathname === '/zhajinhua')) {
      res.writeHead(302, { Location: '/zhajinhua/' });
      return res.end();
    }
    if (req.method === 'GET') {
      return serveStatic(res, pathname);
    }
    send(res, 404, 'Not Found');
  } catch (e) {
    send(res, 500, 'Server Error: ' + e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`炸金花服务已启动: http://${HOST}:${PORT}`);
  console.log(`游戏入口:  http://localhost:${PORT}/`);
});

module.exports = server;
