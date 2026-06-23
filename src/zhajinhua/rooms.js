'use strict';

/**
 * 联机房间管理器（大厅）：创建 / 查询 / 列表 / 回收房间。
 * 房间仅存内存，单进程即可，适合 VPS 自托管。
 */

const { Room } = require('./room');
const userStore = require('../auth/store');

// 金币钱包：把房间经济接到用户金币
const wallet = {
  balance: (id) => userStore.balance(id),
  take: (id, amt) => userStore.take(id, amt),
  give: (id, amt) => userStore.give(id, amt),
};
const onResult = (id, net, won, roomName) => userStore.recordResult(id, net, won, { room: roomName });

const MAX_ROOMS = 200;
const IDLE_TTL = 60 * 60 * 1000; // 1 小时无人则回收

const rooms = new Map(); // id -> Room
let seq = 0;

function genId() {
  seq += 1;
  return seq.toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

/** 创建房间，host 为房主用户。 */
function create(host, opts = {}) {
  if (rooms.size >= MAX_ROOMS) {
    throw new Error('房间数量已达上限，请稍后再试');
  }
  const id = genId();
  const room = new Room({
    id,
    name: opts.name || `${host.username} 的房间`,
    hostUserId: host.id,
    host,
    maxSeats: opts.maxSeats,
    ante: opts.ante,
    maxStake: opts.maxStake,
    startChips: opts.startChips,
    maxRounds: opts.maxRounds,
    password: opts.password,
    botDifficulty: opts.botDifficulty,
    wallet,
    onResult,
    onEmpty: (r) => scheduleCleanup(r),
  });
  room.lastActive = Date.now();
  rooms.set(id, room);
  return room;
}

function get(id) {
  const r = rooms.get(id);
  if (r) r.lastActive = Date.now();
  return r || null;
}

function list() {
  return Array.from(rooms.values())
    .filter((r) => r.occupants() > 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => r.summary());
}

/** 查找某用户当前所在的房间（在座或观战），用于好友状态展示。 */
function findByUser(userId) {
  for (const r of rooms.values()) {
    if (r.memberByUser(userId) || r.spectators.has(userId)) {
      return { id: r.id, name: r.name, started: r.started };
    }
  }
  return null;
}

function destroy(id) {
  const r = rooms.get(id);
  if (r) {
    if (typeof r.dispose === 'function') r.dispose(); // 退款在桌玩家，避免金币丢失
    else r.clearTimer();
    rooms.delete(id);
  }
}

/** 房间没有任何在线观众/玩家后，延迟回收（留出重连窗口）。 */
function scheduleCleanup(room) {
  setTimeout(() => {
    if (room.occupants() === 0) destroy(room.id);
  }, 30 * 1000).unref?.();
}

// 定期清理空闲房间
const timer = setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (r.occupants() === 0 && now - (r.lastActive || r.createdAt) > IDLE_TTL) {
      destroy(id);
    }
  }
}, 10 * 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { create, get, list, destroy, findByUser, _rooms: rooms };
