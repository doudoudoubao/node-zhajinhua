'use strict';

/**
 * 极简用户系统：基于 JSON 文件持久化，使用 Node 内置 crypto.scrypt 加盐哈希密码。
 * 零外部依赖，适合单机自托管的小型联机游戏。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.ZJH_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const USERNAME_RE = /^[A-Za-z0-9_一-龥]{2,16}$/;

const DEFAULT_COINS = 10000;
const CHECKIN_AMOUNT = 2000;
const RELIEF_FLOOR = 1000; // 签到时余额低于此值则补足到此值
const AVATARS = ['😀', '😎', '🤠', '🥳', '😏', '🤓', '👿', '🐯', '🦊', '🐼', '🐲', '🦁', '🐵', '🐷', '👑', '💰'];

let users = new Map(); // id -> { id, username, lower, salt, hash, createdAt, coins, avatar, stats, ... }
let byName = new Map(); // lowercase username -> id
let nextId = 1;
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      for (const u of raw.users || []) {
        users.set(u.id, u);
        byName.set(u.lower, u.id);
        if (u.id >= nextId) nextId = u.id + 1;
      }
    }
  } catch (e) {
    console.error('[auth] 读取用户数据失败，将从空库开始:', e.message);
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = { users: Array.from(users.values()) };
    const tmp = USERS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, USERS_FILE); // 原子替换，避免写入中断损坏文件
  } catch (e) {
    console.error('[auth] 写入用户数据失败:', e.message);
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** 注册新用户。成功返回公开信息，失败抛错。 */
function register(username, password) {
  ensureLoaded();
  username = String(username || '').trim();
  password = String(password || '');
  if (!USERNAME_RE.test(username)) {
    throw new Error('用户名需为 2-16 位字母、数字、下划线或中文');
  }
  if (password.length < 6 || password.length > 64) {
    throw new Error('密码长度需为 6-64 位');
  }
  const lower = username.toLowerCase();
  if (byName.has(lower)) {
    throw new Error('该用户名已被注册');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const isFirst = users.size === 0; // 首个注册用户自动成为管理员
  const user = {
    id: nextId++,
    username,
    lower,
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
    friends: [],
    requests: [],
    coins: DEFAULT_COINS,
    avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
    lastCheckin: 0,
    stats: { games: 0, wins: 0, net: 0 },
    banned: false,
    admin: isFirst,
  };
  users.set(user.id, user);
  byName.set(lower, user.id);
  persist();
  return publicUser(user);
}

// ---- 好友系统 ----

function rawById(id) {
  ensureLoaded();
  const u = users.get(id);
  if (u) {
    if (!Array.isArray(u.friends)) u.friends = [];
    if (!Array.isArray(u.requests)) u.requests = [];
    if (typeof u.coins !== 'number') u.coins = DEFAULT_COINS;
    if (!u.avatar) u.avatar = AVATARS[0];
    if (!u.stats) u.stats = { games: 0, wins: 0, net: 0 };
    if (typeof u.lastCheckin !== 'number') u.lastCheckin = 0;
    if (!Array.isArray(u.recentGames)) u.recentGames = [];
    if (typeof u.banned !== 'boolean') u.banned = false;
    if (typeof u.admin !== 'boolean') u.admin = false;
  }
  return u || null;
}

/** 按用户名查找（公开信息）。 */
function findByUsername(name) {
  ensureLoaded();
  const id = byName.get(String(name || '').trim().toLowerCase());
  return id == null ? null : publicUser(users.get(id));
}

/** 发起好友申请。 */
function sendFriendRequest(fromId, toUsername) {
  const from = rawById(fromId);
  const target = findByUsername(toUsername);
  if (!target) throw new Error('找不到该用户');
  if (target.id === fromId) throw new Error('不能添加自己为好友');
  const to = rawById(target.id);
  if (from.friends.includes(to.id)) throw new Error('你们已经是好友了');
  if (from.requests.includes(to.id)) {
    // 对方此前已申请过你 → 直接互加为好友
    acceptFriend(fromId, to.id);
    return { to: publicUser(to), mutual: true };
  }
  if (!to.requests.includes(fromId)) {
    to.requests.push(fromId);
    persist();
  }
  return { to: publicUser(to), mutual: false };
}

/** 接受好友申请。 */
function acceptFriend(userId, fromId) {
  const me = rawById(userId);
  const other = rawById(fromId);
  if (!other) throw new Error('用户不存在');
  if (!me.requests.includes(fromId)) throw new Error('没有该好友申请');
  me.requests = me.requests.filter((x) => x !== fromId);
  if (!me.friends.includes(fromId)) me.friends.push(fromId);
  if (!other.friends.includes(userId)) other.friends.push(userId);
  // 清除可能存在的反向申请
  other.requests = other.requests.filter((x) => x !== userId);
  persist();
  return { friend: publicUser(other) };
}

/** 拒绝好友申请。 */
function declineFriend(userId, fromId) {
  const me = rawById(userId);
  if (!me) return;
  me.requests = me.requests.filter((x) => x !== fromId);
  persist();
}

/** 删除好友（双向）。 */
function removeFriend(userId, otherId) {
  const me = rawById(userId);
  const other = rawById(otherId);
  if (me) me.friends = me.friends.filter((x) => x !== otherId);
  if (other) other.friends = other.friends.filter((x) => x !== userId);
  persist();
}

/** 好友 id 列表。 */
function friendIds(userId) {
  const me = rawById(userId);
  return me ? me.friends.slice() : [];
}

/** 好友列表（公开信息）。 */
function listFriends(userId) {
  return friendIds(userId).map((id) => publicUser(users.get(id))).filter(Boolean);
}

/** 收到的好友申请列表（公开信息）。 */
function listRequests(userId) {
  const me = rawById(userId);
  if (!me) return [];
  return me.requests.map((id) => publicUser(users.get(id))).filter(Boolean);
}

/** 校验用户名 / 密码，成功返回公开信息，否则返回 null。 */
function verify(username, password) {
  ensureLoaded();
  const lower = String(username || '').trim().toLowerCase();
  const id = byName.get(lower);
  if (id == null) return null;
  const user = users.get(id);
  const candidate = hashPassword(String(password || ''), user.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return publicUser(user);
}

function getById(id) {
  ensureLoaded();
  const u = users.get(id);
  return u ? publicUser(u) : null;
}

function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt, avatar: u.avatar || AVATARS[0] };
}

function count() {
  ensureLoaded();
  return users.size;
}

// ---- 金币 / 头像 / 战绩 / 签到 / 排行榜 ----

/** 完整个人资料（含金币与战绩，仅供本人）。 */
function getProfile(id) {
  const u = rawById(id);
  if (!u) return null;
  return {
    id: u.id, username: u.username, avatar: u.avatar, coins: u.coins,
    stats: { ...u.stats }, checkedInToday: u.lastCheckin === dateNum(),
    avatars: AVATARS.slice(),
    recent: u.recentGames.slice(-20).reverse(),
    isAdmin: isAdmin(u.id),
  };
}

function dateNum() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function setAvatar(id, avatar) {
  const u = rawById(id);
  if (!u) throw new Error('用户不存在');
  if (!AVATARS.includes(avatar)) throw new Error('头像无效');
  u.avatar = avatar;
  persist();
  return u.avatar;
}

function balance(id) {
  const u = rawById(id);
  return u ? u.coins : 0;
}

/** 扣除金币（足额才扣，返回是否成功）。 */
function take(id, amount) {
  const u = rawById(id);
  if (!u || amount < 0 || u.coins < amount) return false;
  u.coins -= amount;
  persist();
  return true;
}

/** 增加金币。 */
function give(id, amount) {
  const u = rawById(id);
  if (!u || amount <= 0) return;
  u.coins += amount;
  persist();
}

/** 每日签到（每天一次；余额过低则补足到救济线）。 */
function checkin(id) {
  const u = rawById(id);
  if (!u) throw new Error('用户不存在');
  if (u.lastCheckin === dateNum()) return { claimed: false, coins: u.coins };
  u.lastCheckin = dateNum();
  let gain = CHECKIN_AMOUNT;
  if (u.coins + gain < RELIEF_FLOOR) gain = RELIEF_FLOOR - u.coins; // 破产救济
  u.coins += gain;
  persist();
  return { claimed: true, gain, coins: u.coins };
}

/** 记录一局战绩 + 最近对局历史。 */
function recordResult(id, net, won, extra) {
  const u = rawById(id);
  if (!u) return;
  net = Math.round(net || 0);
  u.stats.games += 1;
  if (won) u.stats.wins += 1;
  u.stats.net += net;
  u.recentGames.push({ ts: Date.now(), net, won: !!won, room: (extra && extra.room) || '' });
  if (u.recentGames.length > 20) u.recentGames.shift();
  persist();
}

/** 金币排行榜。 */
function leaderboard(limit = 20) {
  ensureLoaded();
  return Array.from(users.values())
    .map((u) => ({ username: u.username, avatar: u.avatar || AVATARS[0], coins: u.coins || 0, games: (u.stats || {}).games || 0, wins: (u.stats || {}).wins || 0, net: (u.stats || {}).net || 0 }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, limit);
}

// ---- 后台管理 ----

/** 是否管理员：账户标记 admin，或环境变量 ZJH_ADMIN 指定的用户名。 */
function isAdmin(id) {
  const u = rawById(id);
  if (!u) return false;
  if (u.admin) return true;
  const env = (process.env.ZJH_ADMIN || '').trim().toLowerCase();
  return !!env && u.lower === env;
}

function isBanned(id) {
  const u = rawById(id);
  return u ? !!u.banned : false;
}

/** 全部用户的管理视图（不含密码哈希）。 */
function adminListUsers() {
  ensureLoaded();
  return Array.from(users.values()).map((u) => ({
    id: u.id,
    username: u.username,
    avatar: u.avatar || AVATARS[0],
    coins: u.coins || 0,
    banned: !!u.banned,
    admin: isAdmin(u.id),
    createdAt: u.createdAt,
    friends: (u.friends || []).length,
    stats: u.stats || { games: 0, wins: 0, net: 0 },
    recent: (u.recentGames || []).slice(-5).reverse(),
  })).sort((a, b) => a.id - b.id);
}

function adminSetCoins(id, coins) {
  const u = rawById(id);
  if (!u) throw new Error('用户不存在');
  u.coins = Math.max(0, Math.min(1e12, Math.round(Number(coins) || 0)));
  persist();
  return u.coins;
}

function adminAdjustCoins(id, delta) {
  const u = rawById(id);
  if (!u) throw new Error('用户不存在');
  u.coins = Math.max(0, (u.coins || 0) + Math.round(Number(delta) || 0));
  persist();
  return u.coins;
}

function adminSetBanned(id, banned) {
  const u = rawById(id);
  if (!u) throw new Error('用户不存在');
  u.banned = !!banned;
  persist();
  return u.banned;
}

function adminSetAdmin(id, on) {
  const u = rawById(id);
  if (!u) throw new Error('用户不存在');
  u.admin = !!on;
  persist();
  return u.admin;
}

function adminResetPassword(id, newPassword) {
  const u = rawById(id);
  if (!u) throw new Error('用户不存在');
  newPassword = String(newPassword || '');
  if (newPassword.length < 6 || newPassword.length > 64) throw new Error('密码长度需为 6-64 位');
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashPassword(newPassword, u.salt);
  persist();
}

function adminDeleteUser(id) {
  const u = users.get(id);
  if (!u) return;
  for (const o of users.values()) {
    if (Array.isArray(o.friends)) o.friends = o.friends.filter((x) => x !== id);
    if (Array.isArray(o.requests)) o.requests = o.requests.filter((x) => x !== id);
  }
  byName.delete(u.lower);
  users.delete(id);
  persist();
}

function adminStats() {
  ensureLoaded();
  let totalCoins = 0, banned = 0, admins = 0;
  for (const u of users.values()) {
    totalCoins += u.coins || 0;
    if (u.banned) banned += 1;
    if (isAdmin(u.id)) admins += 1;
  }
  return { users: users.size, totalCoins, banned, admins };
}

module.exports = {
  register, verify, getById, count, USERS_FILE, DATA_DIR, AVATARS,
  findByUsername, sendFriendRequest, acceptFriend, declineFriend, removeFriend,
  friendIds, listFriends, listRequests,
  getProfile, setAvatar, balance, take, give, checkin, recordResult, leaderboard,
  isAdmin, isBanned, adminListUsers, adminSetCoins, adminAdjustCoins,
  adminSetBanned, adminSetAdmin, adminResetPassword, adminDeleteUser, adminStats,
};
