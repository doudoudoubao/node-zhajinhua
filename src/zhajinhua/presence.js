'use strict';

/**
 * 全局在线状态与通知中心。
 *
 * 每个登录用户可建立一条「通知 SSE 长连接」(/zhajinhua/api/notify/stream)，
 * 用于：好友上线/下线提醒、好友申请、加入房间邀请等实时推送。
 *
 * 与房间内的对局 SSE 相互独立：即使你不在任何房间，也能收到好友邀请。
 */

const userStore = require('../auth/store');

const conns = new Map(); // userId -> Set(res)

function isOnline(userId) {
  return conns.has(userId);
}

/** 当前在线用户 id 集合。 */
function onlineIds() {
  return new Set(conns.keys());
}

function send(res, payload) {
  try {
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  } catch (e) { /* 连接已断，close 事件会清理 */ }
}

/** 向某用户的所有通知连接推送一条消息。 */
function notify(userId, payload) {
  const set = conns.get(userId);
  if (!set) return false;
  for (const res of set) send(res, payload);
  return true;
}

/** 把我的在线状态变化告知我的所有好友。 */
function broadcastPresence(userId, online) {
  for (const fid of userStore.friendIds(userId)) {
    notify(fid, { type: 'presence', userId, online });
  }
}

/** 注册一条通知连接。 */
function register(userId, res) {
  let set = conns.get(userId);
  const firstConn = !set;
  if (!set) {
    set = new Set();
    conns.set(userId, set);
  }
  set.add(res);
  // 首次上线 → 通知好友；并把当前在线好友列表回发给自己
  if (firstConn) broadcastPresence(userId, true);
  const onlineFriends = userStore.friendIds(userId).filter((id) => isOnline(id));
  send(res, { type: 'hello', onlineFriends });
}

/** 注销一条通知连接。 */
function unregister(userId, res) {
  const set = conns.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    conns.delete(userId);
    broadcastPresence(userId, false);
  }
}

module.exports = { isOnline, onlineIds, notify, register, unregister, broadcastPresence };
