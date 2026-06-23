'use strict';

/**
 * 内存会话与 Cookie 工具。会话仅存内存：服务重启后用户需重新登录。
 */

const crypto = require('crypto');

const COOKIE = 'zjh_sid';
const TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

const sessions = new Map(); // sid -> { userId, username, createdAt, lastSeen }

/** 创建会话，返回 sid。 */
function create(user) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { userId: user.id, username: user.username, createdAt: Date.now(), lastSeen: Date.now() });
  return sid;
}

/** 取出会话并刷新活跃时间。 */
function get(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.lastSeen > TTL) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeen = Date.now();
  return s;
}

function destroy(sid) {
  if (sid) sessions.delete(sid);
}

/** 从请求头解析指定 cookie 值。 */
function parseCookie(req, name = COOKIE) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** 解析请求所属的登录用户会话（含 userId/username），未登录返回 null。 */
function fromRequest(req) {
  return get(parseCookie(req));
}

function setCookieHeader(sid) {
  const maxAge = Math.floor(TTL / 1000);
  return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// 定期清理过期会话
const timer = setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > TTL) sessions.delete(sid);
  }
}, 60 * 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { create, get, destroy, fromRequest, parseCookie, setCookieHeader, clearCookieHeader, COOKIE };
