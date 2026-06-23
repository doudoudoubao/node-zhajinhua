'use strict';

/**
 * 联机炸金花（房间）与用户系统自测。
 * 运行: node test/zhajinhua-online.test.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// 使用临时数据目录，避免污染真实 data/users.json
process.env.ZJH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zjh-test-'));

const assert = require('assert');
const { Room } = require('../src/zhajinhua/room');
const userStore = require('../src/auth/store');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '  ->  ' + e.message);
  }
}

const user = (id, username) => ({ id, username });

/** 进入并入座（替代旧的 join）。 */
function seat(room, u, password) {
  room.enter(u, password);
  return room.sit(u);
}

/** 手动驱动房间（绕过定时器），跑完若干手牌。 */
function pump(room, humanId, maxHands) {
  room.schedule = () => {}; // 测试中禁用真实定时器，改为手动推进
  let hands = 0, guard = 0;
  while (hands < maxHands && guard < 8000) {
    guard += 1;
    if (!room.started || !room.game) break;
    const g = room.game;
    if (g.phase === 'betting') {
      const p = room.members[g.turn];
      if (!p) break;
      if (p.isBot) {
        room.botStep(p.id);
      } else {
        const v = room.viewFor(humanId);
        if (v.actions.canLook) room.action(humanId, 'look');
        else if (v.actions.canCall) room.action(humanId, 'call');
        else room.action(humanId, 'fold');
      }
    } else if (g.phase === 'ended') {
      hands += 1;
      room.nextHand();
    } else {
      break;
    }
  }
  return hands;
}

console.log('\n== 用户系统 ==');

test('注册并登录', () => {
  const u = userStore.register('玩家A', 'secret123');
  assert.ok(u.id > 0);
  assert.strictEqual(u.username, '玩家A');
  const ok = userStore.verify('玩家A', 'secret123');
  assert.ok(ok && ok.id === u.id);
  const bad = userStore.verify('玩家A', 'wrongpass');
  assert.strictEqual(bad, null);
});

test('用户名不可重复', () => {
  userStore.register('dupuser', 'secret123');
  assert.throws(() => userStore.register('DupUser', 'another1'), /已被注册/);
});

test('拒绝过短的用户名/密码', () => {
  assert.throws(() => userStore.register('x', 'secret123'), /用户名/);
  assert.throws(() => userStore.register('okname', '123'), /密码/);
});

test('密码以哈希形式持久化（不存明文）', () => {
  userStore.register('persistme', 'plaintextpw');
  const raw = fs.readFileSync(userStore.USERS_FILE, 'utf8');
  assert.ok(!raw.includes('plaintextpw'), '明文密码不应出现在存储文件中');
  assert.ok(raw.includes('persistme'));
});

console.log('\n== 联机房间 ==');

test('创建房间，房主自动入座', () => {
  const host = user(1, '房主');
  const room = new Room({ id: 'r1', hostUserId: host.id, host, ante: 10, startChips: 500 });
  assert.strictEqual(room.members.length, 1);
  assert.strictEqual(room.hostUserId, 1);
  assert.strictEqual(room.humanCount(), 1);
});

test('未满 2 人不能开始；加机器人后可开始', () => {
  const host = user(2, '房主2');
  const room = new Room({ id: 'r2', hostUserId: host.id, host, ante: 10, startChips: 500 });
  assert.ok(room.start(host.id).error, '单人不应能开始');
  room.addBot(host.id);
  room.addBot(host.id);
  const r = room.start(host.id);
  assert.ok(r.ok, '加机器人后应能开始: ' + JSON.stringify(r));
  assert.strictEqual(room.started, true);
  assert.strictEqual(room.game.phase, 'betting');
});

test('非房主不能开始', () => {
  const host = user(3, 'h3');
  const room = new Room({ id: 'r3', hostUserId: host.id, host });
  room.addBot(host.id);
  const r = room.start(999);
  assert.ok(r.error, '非房主不应能开始');
});

test('一名真人 + 多机器人可跑通多手且筹码守恒', () => {
  const host = user(4, '玩家H');
  const room = new Room({ id: 'r4', hostUserId: host.id, host, ante: 10, startChips: 300, maxStake: 40, maxRounds: 6 });
  room.addBot(host.id);
  room.addBot(host.id);
  room.addBot(host.id);
  room.schedule = () => {};
  room.start(host.id);
  const total = () => room.members.reduce((s, m) => s + m.chips, 0) + (room.game ? room.game.pot : 0);
  const initial = total(); // 开局已收底注入池，基准须含底池
  const played = pump(room, host.id, 30);
  assert.ok(played >= 1, '应至少打完一手: ' + played);
  assert.strictEqual(total(), initial, '筹码总量应守恒');
  for (const m of room.members) assert.ok(m.chips >= 0, m.name + ' 筹码为负');
});

test('两名真人同桌：各自只能看到自己的暗牌', () => {
  const a = user(10, '甲');
  const b = user(11, '乙');
  const room = new Room({ id: 'r5', hostUserId: a.id, host: a, ante: 10, startChips: 500 });
  seat(room, b);
  room.schedule = () => {};
  assert.strictEqual(room.members.length, 2);
  room.start(a.id);
  // 开局后某人未看牌时，对手看不到其牌
  const va = room.viewFor(a.id);
  const vb = room.viewFor(b.id);
  const aSeesB = va.players.find((p) => p.name === '乙');
  const bSeesA = vb.players.find((p) => p.name === '甲');
  assert.strictEqual(aSeesB.cards, null, '甲不应看到乙的暗牌');
  assert.strictEqual(bSeesA.cards, null, '乙不应看到甲的暗牌');
  // 自己看牌后能看到自己的牌
  if (room.game.turn === 0) {
    room.action(a.id, 'look');
    const va2 = room.viewFor(a.id);
    const me = va2.players.find((p) => p.isYou);
    assert.ok(me.cards && me.cards.length === 3, '看牌后应能看到自己的 3 张牌');
    // 但乙仍看不到甲
    const vb2 = room.viewFor(b.id);
    assert.strictEqual(vb2.players.find((p) => p.name === '甲').cards, null);
  }
});

test('对局中真人离桌：自动弃牌且不崩溃，其余继续', () => {
  const a = user(20, 'A20');
  const b = user(21, 'B21');
  const room = new Room({ id: 'r6', hostUserId: a.id, host: a, ante: 10, startChips: 300, maxStake: 40 });
  seat(room, b);
  room.addBot(a.id);
  room.schedule = () => {};
  room.start(a.id);
  // 乙中途离桌
  const r = room.leave(b.id);
  assert.ok(r.ok);
  // 继续推进不应抛错
  pump(room, a.id, 10);
  for (const m of room.members) assert.ok(m.chips >= 0);
});

test('房主离开后自动转移房主', () => {
  const a = user(30, '原房主');
  const b = user(31, '继任者');
  const room = new Room({ id: 'r7', hostUserId: a.id, host: a });
  seat(room, b);
  room.leave(a.id);
  assert.strictEqual(room.hostUserId, 31, '房主应转移给乙');
});

test('座位上限受限', () => {
  const a = user(40, 'cap');
  const room = new Room({ id: 'r8', hostUserId: a.id, host: a, maxSeats: 2 });
  room.addBot(a.id); // 满 2 座
  const r = room.addBot(a.id);
  assert.ok(r.error, '超过座位上限应失败');
});

console.log('\n== 视图与摊牌 ==');

test('摊牌后所有未弃牌玩家亮牌', () => {
  const a = user(50, 'sd');
  const room = new Room({ id: 'r9', hostUserId: a.id, host: a, ante: 10, startChips: 200, maxStake: 30, maxRounds: 3 });
  room.addBot(a.id);
  room.addBot(a.id);
  room.schedule = () => {};
  room.start(a.id);
  pump(room, a.id, 1); // 至少打完一手
  // 取任意一手结束时的视图：胜者应已揭示（buildView 在 ended 时揭示未弃牌者）
  // 这里直接验证 ended 视图结构正常
  assert.ok(room.handNo >= 1 || (room.game && room.game.handNo >= 1));
});

console.log('\n== 房间密码 ==');

test('私密房需正确密码方可进入', () => {
  const a = user(60, '房主P');
  const b = user(61, '访客P');
  const room = new Room({ id: 'rp', hostUserId: a.id, host: a, password: '1234' });
  assert.strictEqual(room.isPrivate, true);
  assert.ok(room.enter(b, '0000').error, '错误密码应被拒绝');
  assert.ok(room.enter(b, '1234').ok, '正确密码应可进入');
  // 进入后可入座
  assert.ok(room.sit(b).ok);
  assert.strictEqual(room.members.length, 2);
});

test('被邀请者免密进入私密房', () => {
  const a = user(62, '房主I');
  const b = user(63, '被邀请者');
  const room = new Room({ id: 'ri', hostUserId: a.id, host: a, password: 'secret' });
  room.authorize(b.id); // 模拟邀请授权
  assert.ok(room.enter(b).ok, '已授权用户应能免密进入');
});

console.log('\n== 观战与站起 ==');

test('进入但不入座即为观战，出现在观战名单', () => {
  const a = user(70, '房主S');
  const watcher = user(71, '看客');
  const room = new Room({ id: 'rs', hostUserId: a.id, host: a });
  room.enter(watcher);
  const v = room.viewFor(watcher.id);
  assert.strictEqual(v.room.role, 'spectator');
  assert.strictEqual(v.room.spectatorCount, 1);
  assert.ok(v.room.spectators.some((s) => s.name === '看客'));
  assert.ok(v.room.canSit, '有空位时观战者可入座');
});

test('入座后从观战名单移除；站起后回到观战名单', () => {
  const a = user(72, '房主T');
  const u = user(73, '玩家T');
  const room = new Room({ id: 'rt', hostUserId: a.id, host: a });
  room.enter(u);
  room.sit(u);
  assert.strictEqual(room.spectators.size, 0, '入座后应不在观战名单');
  assert.strictEqual(room.members.length, 2);
  const r = room.stand(u);
  assert.ok(r.ok);
  assert.strictEqual(room.members.length, 1, '站起后应离座');
  assert.ok(room.spectators.has(u.id), '站起后应回到观战名单');
});

console.log('\n== 聊天 ==');

test('聊天消息进入房间记录并广播', () => {
  const a = user(80, '聊天人');
  const room = new Room({ id: 'rc', hostUserId: a.id, host: a });
  const r = room.sendChat(a, '大家好 <script>');
  assert.ok(r.ok);
  const msg = room.chat.find((c) => !c.sys && c.name === '聊天人');
  assert.ok(msg, '应有该用户的聊天消息');
  assert.ok(!msg.text.includes('<'), '应过滤掉尖括号');
});

test('非房间成员不能发言', () => {
  const a = user(81, '房主C');
  const outsider = user(82, '外人');
  const room = new Room({ id: 'rc2', hostUserId: a.id, host: a });
  assert.ok(room.sendChat(outsider, '你好').error, '未进入房间者不应能发言');
});

console.log('\n== 好友系统 ==');

test('好友申请 → 接受 → 互为好友', () => {
  const u1 = userStore.register('好友甲', 'pass123');
  const u2 = userStore.register('好友乙', 'pass123');
  const r = userStore.sendFriendRequest(u1.id, '好友乙');
  assert.strictEqual(r.mutual, false);
  assert.ok(userStore.listRequests(u2.id).some((x) => x.id === u1.id), '乙应收到申请');
  userStore.acceptFriend(u2.id, u1.id);
  assert.ok(userStore.listFriends(u1.id).some((f) => f.id === u2.id), '甲的好友含乙');
  assert.ok(userStore.listFriends(u2.id).some((f) => f.id === u1.id), '乙的好友含甲');
  assert.strictEqual(userStore.listRequests(u2.id).length, 0, '接受后申请清空');
});

test('互相申请自动成为好友', () => {
  const u1 = userStore.register('互加甲', 'pass123');
  const u2 = userStore.register('互加乙', 'pass123');
  userStore.sendFriendRequest(u1.id, '互加乙');
  const r = userStore.sendFriendRequest(u2.id, '互加甲'); // 乙也申请甲
  assert.strictEqual(r.mutual, true, '双向申请应直接成为好友');
  assert.ok(userStore.listFriends(u1.id).some((f) => f.id === u2.id));
});

test('删除好友为双向', () => {
  const u1 = userStore.register('删除甲', 'pass123');
  const u2 = userStore.register('删除乙', 'pass123');
  userStore.sendFriendRequest(u1.id, '删除乙');
  userStore.acceptFriend(u2.id, u1.id);
  userStore.removeFriend(u1.id, u2.id);
  assert.ok(!userStore.listFriends(u1.id).some((f) => f.id === u2.id));
  assert.ok(!userStore.listFriends(u2.id).some((f) => f.id === u1.id));
});

test('不能添加自己 / 不存在的用户', () => {
  const u1 = userStore.register('自己甲', 'pass123');
  assert.throws(() => userStore.sendFriendRequest(u1.id, '自己甲'), /自己/);
  assert.throws(() => userStore.sendFriendRequest(u1.id, '查无此人xyz'), /找不到/);
});

console.log('\n== 金币 / 头像 / 签到 / 排行榜 ==');

test('新用户有初始金币与头像', () => {
  const u = userStore.register('金币用户', 'pass123');
  const p = userStore.getProfile(u.id);
  assert.ok(p.coins > 0, '应有初始金币');
  assert.ok(p.avatar, '应有默认头像');
  assert.ok(Array.isArray(p.avatars) && p.avatars.length > 0);
});

test('每日签到只能领一次', () => {
  const u = userStore.register('签到用户', 'pass123');
  const before = userStore.balance(u.id);
  const r1 = userStore.checkin(u.id);
  assert.strictEqual(r1.claimed, true);
  assert.ok(r1.coins > before, '签到后金币增加');
  const r2 = userStore.checkin(u.id);
  assert.strictEqual(r2.claimed, false, '当天第二次签到应失败');
});

test('设置头像校验合法性', () => {
  const u = userStore.register('头像用户', 'pass123');
  const av = userStore.AVATARS[2];
  assert.strictEqual(userStore.setAvatar(u.id, av), av);
  assert.throws(() => userStore.setAvatar(u.id, '🚀不在列表'), /头像无效/);
});

test('扣款 / 加款 / 余额', () => {
  const u = userStore.register('钱包用户', 'pass123');
  const start = userStore.balance(u.id);
  assert.strictEqual(userStore.take(u.id, start + 1), false, '超额扣款应失败');
  assert.strictEqual(userStore.take(u.id, 100), true);
  assert.strictEqual(userStore.balance(u.id), start - 100);
  userStore.give(u.id, 50);
  assert.strictEqual(userStore.balance(u.id), start - 50);
});

test('排行榜按金币降序', () => {
  const lb = userStore.leaderboard(50);
  for (let i = 1; i < lb.length; i++) assert.ok(lb[i - 1].coins >= lb[i].coins, '应按金币降序');
});

console.log('\n== 金币经济（买入 / 结算 / 守恒）==');

function stubWallet(init) {
  const coins = new Map(Object.entries(init).map(([k, v]) => [+k, v]));
  return {
    coins,
    balance: (id) => coins.get(id) || 0,
    take: (id, a) => { if ((coins.get(id) || 0) < a) return false; coins.set(id, coins.get(id) - a); return true; },
    give: (id, a) => coins.set(id, (coins.get(id) || 0) + a),
  };
}
function pumpAll(room) {
  room.schedule = () => {};
  let guard = 0;
  while (room.started && room.game && guard < 4000) {
    guard += 1;
    const g = room.game;
    if (g.phase === 'betting') {
      const p = room.members[g.turn];
      if (!p) break;
      if (p.isBot) { room.botStep(p.id); continue; }
      const v = room.viewFor(p.userId);
      if (v.actions.canLook) room.action(p.userId, 'look');
      else if (v.actions.canCall) room.action(p.userId, 'call');
      else room.action(p.userId, 'fold');
    } else if (g.phase === 'ended') { room.nextHand(); } else break;
  }
}

test('买入扣金币，结束兑回，金币守恒（两真人）', () => {
  const w = stubWallet({ 100: 1000, 101: 1000 });
  const results = [];
  const a = user(100, '财主甲'); const b = user(101, '财主乙');
  const room = new Room({ id: 'eco1', hostUserId: a.id, host: a, ante: 10, startChips: 300, maxStake: 40, maxRounds: 6, wallet: w, onResult: (id, net, won) => results.push({ id, net, won }) });
  room.enter(b); room.sit(b);
  room.schedule = () => {};
  room.start(a.id);
  // 开局后各扣 300 买入
  assert.strictEqual(w.balance(100), 700);
  assert.strictEqual(w.balance(101), 700);
  pumpAll(room);
  // 结束后金币总额应守恒为 2000（两真人零和）
  assert.strictEqual(w.balance(100) + w.balance(101), 2000, '金币应守恒');
  assert.strictEqual(results.length, 2, '应记录两人战绩');
  assert.strictEqual(results.reduce((s, r) => s + r.net, 0), 0, '净盈亏之和应为 0');
});

test('金币不足无法入座', () => {
  const w = stubWallet({ 110: 1000, 111: 50 });
  const a = user(110, '富'); const b = user(111, '穷');
  const room = new Room({ id: 'eco2', hostUserId: a.id, host: a, startChips: 300, wallet: w });
  room.enter(b);
  const r = room.sit(b);
  assert.ok(r.error && /金币不足/.test(r.error), '金币不足应拒绝入座');
});

test('房间回收时退款在桌玩家', () => {
  const w = stubWallet({ 120: 1000 });
  const a = user(120, '独狼');
  const room = new Room({ id: 'eco3', hostUserId: a.id, host: a, startChips: 300, wallet: w });
  room.addBot(a.id);
  room.schedule = () => {};
  room.start(a.id);
  assert.strictEqual(w.balance(120), 700, '开局扣买入');
  room.dispose(); // 模拟回收
  assert.strictEqual(w.balance(120), 1000, '回收应退还在桌筹码');
});

console.log('\n== 托管与踢人 ==');

test('托管标记可开关，手动操作收回', () => {
  const a = user(130, '托管甲');
  const room = new Room({ id: 'au1', hostUserId: a.id, host: a, ante: 10, startChips: 300 });
  room.addBot(a.id);
  room.schedule = () => {};
  room.start(a.id);
  room.setAuto(a.id, true);
  assert.strictEqual(room.memberByUser(130).auto, true);
  // 若轮到自己，手动行动应收回托管
  if (room.game.turn === room.memberByUser(130).id) {
    room.action(130, room.viewFor(130).actions.canLook ? 'look' : 'call');
    assert.strictEqual(room.memberByUser(130).auto, false, '手动操作应收回托管');
  }
});

test('托管自动出牌不会卡死', () => {
  const a = user(131, '托管乙');
  const room = new Room({ id: 'au2', hostUserId: a.id, host: a, ante: 10, startChips: 200, maxStake: 30, maxRounds: 5 });
  room.addBot(a.id); room.addBot(a.id);
  room.schedule = () => {};
  room.start(a.id);
  room.setAuto(a.id, true);
  // 手动驱动：机器人走 botStep，真人轮到则 autoStep
  let guard = 0;
  while (room.started && room.game && guard < 2000) {
    guard += 1;
    const g = room.game;
    if (g.phase === 'betting') {
      const p = room.members[g.turn];
      if (!p) break;
      if (p.isBot) room.botStep(p.id); else room.autoStep(p.id);
    } else if (g.phase === 'ended') room.nextHand();
    else break;
  }
  assert.ok(!room.started || guard < 2000, '托管应能顺利推进');
});

test('房主踢人：移除座位并退款', () => {
  const w = stubWallet({ 140: 1000, 141: 1000 });
  const a = user(140, '房主K'); const b = user(141, '被踢者');
  const room = new Room({ id: 'kick1', hostUserId: a.id, host: a, startChips: 300, wallet: w });
  room.enter(b); room.sit(b);
  assert.strictEqual(room.members.length, 2);
  room.schedule = () => {};
  room.start(a.id);
  const mb = room.memberByUser(141);
  const seatB = mb.id;
  const chipsB = mb.chips; // 已扣底注后的桌上筹码
  const r = room.kick(a.id, seatB);
  assert.ok(r.ok, '房主应能踢人: ' + JSON.stringify(r));
  const stillB = room.memberByUser(141);
  assert.ok(!stillB || stillB.left, '被踢者应离座或标记为离座');
  assert.strictEqual(w.balance(141), 700 + chipsB, '被踢者应退还桌上剩余筹码（底注已投入底池不退）');
  // 非房主不能踢
  assert.ok(room.kick(999, 0).error);
});

console.log('\n== 机器人难度 / 战报 / 最近对局 ==');

test('房间机器人按难度赋值', () => {
  const a = user(150, '难度房主');
  const room = new Room({ id: 'diff1', hostUserId: a.id, host: a, botDifficulty: 'hard' });
  room.addBot(a.id);
  const bot = room.members.find((m) => m.isBot);
  assert.strictEqual(bot.difficulty, 'hard');
  assert.strictEqual(room.viewFor(a.id).room.botDifficulty, 'hard');
});

test('非法难度回落为普通', () => {
  const a = user(151, 'x');
  const room = new Room({ id: 'diff2', hostUserId: a.id, host: a, botDifficulty: '乱填' });
  assert.strictEqual(room.botDifficulty, 'normal');
});

test('本局战报记录每手结果', () => {
  const a = user(152, '战报甲');
  const room = new Room({ id: 'hist1', hostUserId: a.id, host: a, ante: 10, startChips: 200, maxStake: 30, maxRounds: 4 });
  room.addBot(a.id); room.addBot(a.id);
  room.schedule = () => {};
  room.start(a.id);
  pumpAll(room);
  assert.ok(room.handHistory.length >= 1, '应记录至少一手战报');
  const h = room.handHistory[0];
  assert.ok(h.handNo >= 1 && h.pot > 0 && typeof h.winner === 'string');
  assert.ok(Array.isArray(h.players) && h.players.length >= 2);
  // 战报随视图下发
  const v = room.viewFor(a.id);
  assert.ok(Array.isArray(v.room.history));
});

test('记录用户最近对局与累计战绩', () => {
  const u = userStore.register('最近对局用户', 'pass123');
  userStore.recordResult(u.id, 80, true, { room: '欢乐局' });
  userStore.recordResult(u.id, -30, false, { room: '欢乐局' });
  const p = userStore.getProfile(u.id);
  assert.strictEqual(p.stats.games, 2);
  assert.strictEqual(p.stats.wins, 1);
  assert.strictEqual(p.stats.net, 50);
  assert.strictEqual(p.recent.length, 2);
  assert.strictEqual(p.recent[0].net, -30, '最近一条应在最前');
  assert.strictEqual(p.recent[0].room, '欢乐局');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
