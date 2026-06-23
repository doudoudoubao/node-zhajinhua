'use strict';

/**
 * 炸金花对局的内存会话存储。
 * 单进程即可运行，适合 VPS 自托管；闲置对局会被定时回收。
 */

const { Table } = require('./table');

const TTL = 30 * 60 * 1000; // 30 分钟无操作即回收
const MAX_GAMES = 500; // 防止内存无限增长

const games = new Map(); // id -> { table, lastActive }

/** 新建一局并返回 table。 */
function create(opts) {
  // 容量保护：超限时清掉最旧的一局
  if (games.size >= MAX_GAMES) {
    let oldestId = null;
    let oldest = Infinity;
    for (const [id, g] of games) {
      if (g.lastActive < oldest) {
        oldest = g.lastActive;
        oldestId = id;
      }
    }
    if (oldestId) games.delete(oldestId);
  }
  const table = new Table(opts);
  games.set(table.id, { table, lastActive: Date.now() });
  return table;
}

/** 取出一局并刷新活跃时间。 */
function get(id) {
  const g = games.get(id);
  if (!g) return null;
  g.lastActive = Date.now();
  return g.table;
}

/** 回收过期对局。 */
function sweep() {
  const now = Date.now();
  for (const [id, g] of games) {
    if (now - g.lastActive > TTL) games.delete(id);
  }
}

const timer = setInterval(sweep, 5 * 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { create, get, sweep, _games: games };
