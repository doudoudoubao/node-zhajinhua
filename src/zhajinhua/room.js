'use strict';

/**
 * 联机炸金花房间：多名真人 + 可选机器人同桌对战，支持观战、聊天、房间密码。
 *
 * - 继承 BettingGame，复用与单机完全一致的牌型 / 下注 / 比牌 / 摊牌规则。
 * - 真人异步行动（HTTP POST），机器人由定时器驱动，玩家超时自动弃牌。
 * - 通过 SSE 把「每个人各自的视图」实时推送给所有在座/旁观者（隐藏他人暗牌）。
 * - 进入(enter) → 入座(sit) / 观战 → 站起(stand) → 离开(leave)，贴近市面棋牌流程。
 *
 * 并发说明：Node 单线程，定时器回调与请求处理不会真正并行，故无需加锁。
 */

const { BettingGame, clampInt, DIFFICULTY_LABELS } = require('./core');
const E = require('./engine');

const BOT_NAMES = ['机器人·阿强', '机器人·小敏', '机器人·老六', '机器人·阿珍', '机器人·大壮', '机器人·囡囡'];

class Room {
  constructor(opts = {}) {
    this.id = opts.id;
    this.name = String(opts.name || '炸金花房间').slice(0, 24);
    this.hostUserId = opts.hostUserId;
    this.maxSeats = clampInt(opts.maxSeats, 6, 2, 6);
    this.password = String(opts.password || '').slice(0, 16);
    this.isPrivate = !!this.password;
    this.botDifficulty = ['easy', 'normal', 'hard'].includes(opts.botDifficulty) ? opts.botDifficulty : 'normal';
    this.handHistory = []; // 本局每手战报快照
    this.createdAt = Date.now();

    // 下注参数
    this.startChips = clampInt(opts.startChips, 1000, 100, 1000000);
    this.config = {
      ante: clampInt(opts.ante, 10, 1, 1000),
      maxStake: clampInt(opts.maxStake, 80, 2, 100000),
      maxRounds: clampInt(opts.maxRounds, 8, 2, 50),
      startChips: this.startChips,
    };

    // 编排参数
    this.botDelay = 1200;
    this.turnMs = clampInt(opts.turnMs, 30000, 8000, 120000);
    this.discTurnMs = 8000; // 掉线者更快自动弃牌
    this.nextHandDelay = 4500;

    this.game = null; // BettingGame 实例（开局后创建）
    this.members = []; // 座位顺序的成员数组（真人 + 机器人）
    this.started = false;
    this.phase = 'waiting';
    this.dealerIdx = 0;
    this.botSeq = 0;
    this.lastResult = '';
    this.log = [];
    this.chat = []; // { name, text, ts, sys }
    this.turnDeadline = 0;

    this.pendingJoins = []; // 对局进行中排队入座的真人，下一手生效
    this.timer = null;
    this.subs = new Map(); // userId -> Set(res)
    this.spectators = new Map(); // userId -> { name, connected }
    this.authorized = new Set(); // 允许进入的用户（私密房通过密码或邀请获得）
    this.lastChatAt = new Map(); // userId -> ts（限频）
    this.onEmpty = typeof opts.onEmpty === 'function' ? opts.onEmpty : () => {};

    // 金币经济（可选）：注入钱包则启用买入 / 结算；不注入则发免费筹码（便于测试）
    this.wallet = opts.wallet || null;
    this.onResult = typeof opts.onResult === 'function' ? opts.onResult : null;

    if (opts.host) {
      this.authorized.add(opts.host.id);
      this.addMemberNow(opts.host.id, opts.host.username, false, opts.host.avatar);
    }
  }

  // ---- 成员管理 ----

  memberByUser(userId) {
    return this.members.find((m) => m.userId === userId) || null;
  }

  humanCount() {
    return this.members.filter((m) => !m.isBot).length;
  }

  /** 仍有人在看/在玩（用于回收判断）。 */
  occupants() {
    let n = this.members.filter((m) => !m.isBot && m.connected).length;
    for (const s of this.spectators.values()) if (s.connected) n += 1;
    return n;
  }

  addMemberNow(userId, name, isBot, avatar) {
    const m = {
      id: this.members.length,
      userId,
      name: String(name).slice(0, 16),
      avatar: avatar || (isBot ? '🤖' : '🙂'),
      isBot,
      chips: this.startChips,
      connected: isBot,
      left: false,
      standPending: false,
      auto: false,
      onTable: false,   // 是否已买入坐到桌上（金币经济）
      buyInTotal: 0,
      cards: null, hand: null,
      inHand: false, folded: false, looked: false, bet: 0, revealed: false,
    };
    this.members.push(m);
    this.reindex();
    return m;
  }

  // ---- 金币买入 / 结算 ----

  /** 让成员买入坐上牌桌；启用钱包时从金币扣除买入额。返回是否成功。 */
  buyIn(m) {
    if (m.isBot || !this.wallet) { m.chips = this.startChips; m.onTable = true; return true; }
    if (!this.wallet.take(m.userId, this.startChips)) return false;
    m.chips = this.startChips;
    m.buyInTotal += this.startChips;
    m.onTable = true;
    return true;
  }

  /** 成员离桌时把桌上筹码兑回金币（不记战绩）。 */
  cashOut(m) {
    if (m.isBot || !this.wallet || !m.onTable) return;
    this.wallet.give(m.userId, Math.max(0, m.chips));
    m.onTable = false;
  }

  reindex() {
    this.members.forEach((m, i) => { m.id = i; });
  }

  /** 邀请授权：让某用户无需密码即可进入私密房。 */
  authorize(userId) {
    this.authorized.add(userId);
  }

  /** 进入房间（观战席）。私密房需密码或已被授权/邀请。 */
  enter(user, password) {
    const isMember = !!this.memberByUser(user.id);
    if (!isMember && !this.authorized.has(user.id)) {
      if (this.isPrivate && String(password || '') !== this.password) {
        return { error: '房间密码错误' };
      }
      this.authorized.add(user.id);
    }
    if (!isMember && !this.spectators.has(user.id)) {
      this.spectators.set(user.id, { name: user.username, avatar: user.avatar || '🙂', connected: false });
      this.pushChat(`${user.username} 进入房间`, true);
    }
    this.broadcast();
    return { ok: true, roomId: this.id, name: this.name, started: this.started, isPrivate: this.isPrivate };
  }

  /** 入座成为玩家。 */
  sit(user) {
    if (!this.authorized.has(user.id) && !this.memberByUser(user.id)) {
      return { error: '请先进入房间' };
    }
    if (this.memberByUser(user.id) || this.pendingJoins.some((j) => j.id === user.id)) {
      return { ok: true };
    }
    if (this.members.length + this.pendingJoins.length >= this.maxSeats) {
      return { error: '座位已满' };
    }
    if (this.wallet && this.wallet.balance(user.id) < this.startChips) {
      return { error: `金币不足，买入需 ${this.startChips}（当前 ${this.wallet.balance(user.id)}）` };
    }
    this.spectators.delete(user.id);
    if (this.started) {
      this.pendingJoins.push({ id: user.id, username: user.username, avatar: user.avatar || '🙂' });
      this.pushChat(`${user.username} 将于下一手入座`, true);
    } else {
      const m = this.addMemberNow(user.id, user.username, false, user.avatar);
      m.connected = this.subs.has(user.id);
      this.pushChat(`${user.username} 入座`, true);
    }
    this.broadcast();
    return { ok: true };
  }

  /** 切换托管（自动出牌）。 */
  setAuto(userId, on) {
    const m = this.memberByUser(userId);
    if (!m) return { error: '你不在牌桌上' };
    m.auto = !!on;
    this.pushChat(`${m.name} ${m.auto ? '开启了托管' : '取消了托管'}`, true);
    this.broadcast();
    if (this.started && this.game && this.game.turn === m.id) this.schedule();
    return { ok: true, auto: m.auto };
  }

  /** 房主把某座位上的真人请出房间。 */
  kick(hostId, seat) {
    if (this.hostUserId !== hostId) return { error: '只有房主可以操作' };
    const m = this.members[seat];
    if (!m) return { error: '该座位没有玩家' };
    if (m.isBot) return { error: '请用「－机器人」移除机器人' };
    if (m.userId === hostId) return { error: '不能请出自己' };
    const targetId = m.userId;
    this.leave(targetId, '被房主请出房间');
    this.closeUserConns(targetId);
    return { ok: true };
  }

  /** 主动断开某用户的所有 SSE 连接（用于踢人）。 */
  closeUserConns(userId) {
    const set = this.subs.get(userId);
    if (!set) return;
    for (const res of set) { try { res.end(); } catch (e) { /* ignore */ } }
    this.subs.delete(userId);
  }

  /** 站起回到观战席（对局中将在本手结束后生效）。 */
  stand(user) {
    const m = this.memberByUser(user.id);
    this.pendingJoins = this.pendingJoins.filter((j) => j.id !== user.id);
    if (!m) { this.broadcast(); return { ok: true }; }
    const wasHost = this.hostUserId === user.id;

    if (!this.started) {
      m.left = true;
      m.standPending = true;
      this.removeLeftMembers();
      this.pushChat(`${m.name} 站起观战`, true);
    } else {
      if (m.inHand && !m.folded) this.game.dropPlayer(m.id);
      m.left = true;
      m.standPending = true;
      this.pushChat(`${m.name} 选择站起，将于本手结束后离座`, true);
      this.syncFromGame();
    }
    if (wasHost) this.reassignHost();
    this.broadcast();
    if (this.started) this.schedule();
    return { ok: true };
  }

  /** 彻底离开房间。 */
  leave(userId, reason) {
    const m = this.memberByUser(userId);
    const spec = this.spectators.get(userId);
    this.pendingJoins = this.pendingJoins.filter((j) => j.id !== userId);
    this.authorized.delete(userId);
    this.spectators.delete(userId);
    const why = reason || '离开了房间';

    if (m) {
      const wasHost = this.hostUserId === userId;
      const name = m.name;
      if (this.started && this.game && m.inHand && !m.folded) {
        this.game.dropPlayer(m.id);
        this.cashOut(m); // 立即兑现已弃牌的剩余筹码（底注已投入底池，不退）
        m.left = true;   // 座位在本手结束时移除（避免打乱牌权）
        this.syncFromGame();
      } else {
        m.left = true;
        this.removeLeftMembers();
      }
      this.pushChat(`${name} ${why}`, true);
      if (wasHost) this.reassignHost();
    } else if (spec) {
      this.pushChat(`${spec.name} ${why}`, true);
    }

    this.broadcast();
    if (this.started) this.schedule();
    this.maybeEmpty();
    return { ok: true };
  }

  reassignHost() {
    const human = this.members.find((m) => !m.isBot && !m.left);
    this.hostUserId = human ? human.userId : null;
    if (human) this.pushChat(`房主转移给 ${human.name}`, true);
  }

  removeLeftMembers() {
    const remaining = [];
    for (const m of this.members) {
      if (m.left) {
        this.cashOut(m); // 离桌兑现筹码回金币
        if (m.standPending && !m.isBot) {
          this.spectators.set(m.userId, { name: m.name, avatar: m.avatar, connected: this.subs.has(m.userId) });
        }
        continue;
      }
      remaining.push(m);
    }
    this.members = remaining;
    this.reindex();
  }

  maybeEmpty() {
    if (this.occupants() === 0) {
      this.clearTimer();
      this.onEmpty(this);
    }
  }

  /** 房主添加一个机器人。 */
  addBot(byUserId) {
    if (this.started) return { error: '游戏中无法添加机器人' };
    if (this.hostUserId !== byUserId) return { error: '只有房主可以操作' };
    if (this.members.length >= this.maxSeats) return { error: '座位已满' };
    const used = new Set(this.members.map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `机器人${this.botSeq + 1}`;
    this.botSeq += 1;
    const bot = this.addMemberNow('bot:' + this.botSeq, name, true);
    bot.difficulty = this.botDifficulty;
    this.pushChat(`房主添加了 ${name}（${DIFFICULTY_LABELS[this.botDifficulty]}）`, true);
    this.broadcast();
    return { ok: true };
  }

  /** 房主移除最后一个机器人。 */
  removeBot(byUserId) {
    if (this.started) return { error: '游戏中无法移除机器人' };
    if (this.hostUserId !== byUserId) return { error: '只有房主可以操作' };
    for (let i = this.members.length - 1; i >= 0; i--) {
      if (this.members[i].isBot) {
        this.pushChat(`房主移除了 ${this.members[i].name}`, true);
        this.members.splice(i, 1);
        this.reindex();
        this.broadcast();
        return { ok: true };
      }
    }
    return { error: '没有可移除的机器人' };
  }

  // ---- 对局生命周期 ----

  /** 房主开始游戏。 */
  start(byUserId) {
    if (this.started) return { error: '游戏已经开始' };
    if (this.hostUserId !== byUserId) return { error: '只有房主可以开始游戏' };
    if (this.members.length < 2) return { error: '至少需要 2 名玩家（可添加机器人凑数）' };
    if (this.humanCount() < 1) return { error: '至少需要 1 名真人' };

    // 买入：金币不足者退回观战席
    for (const m of [...this.members]) {
      if (!this.buyIn(m)) {
        m.left = true;
        this.spectators.set(m.userId, { name: m.name, avatar: m.avatar, connected: this.subs.has(m.userId) });
        this.pushChat(`${m.name} 金币不足，无法买入，转为观战`, true);
      }
    }
    this.removeLeftMembers();
    if (this.members.length < 2 || this.humanCount() < 1) {
      // 买入失败导致人数不足：退款已买入者
      for (const m of this.members) this.cashOut(m);
      return { error: '可买入的玩家不足，无法开始' };
    }

    this.game = new BettingGame(this.config);
    this.game.players = this.members;
    this.game.onHandEnd = (winnerId, reason, won) => this.recordHand(winnerId, reason, won);
    this.handHistory = [];
    this.reindex();

    this.started = true;
    this.dealerIdx = this.members.length - 1;
    this.dealHand();
    this.pushLog('🎮 游戏开始！');
    this.broadcast();
    this.schedule();
    return { ok: true };
  }

  dealHand() {
    this.dealerIdx = (this.dealerIdx + 1) % this.members.length;
    this.game.dealNewHand((this.dealerIdx + 1) % this.members.length);
    this.syncFromGame();
    this.pushLog(`—— 第 ${this.game.handNo} 手开始，每人底注 ${this.config.ante}，底池 ${this.game.pot} ——`);
  }

  /** 进入下一手：先处理离场 / 入座，再判断能否继续。 */
  nextHand() {
    if (!this.started) return;
    this.applyPending();
    const funded = this.members.filter((m) => m.chips >= this.config.ante);
    if (funded.length < 2 || this.humanCount() < 1) {
      return this.endGame();
    }
    this.dealHand();
    this.broadcast();
    this.schedule();
  }

  applyPending() {
    this.removeLeftMembers();
    for (const j of this.pendingJoins) {
      if (this.members.length >= this.maxSeats) break;
      if (this.memberByUser(j.id)) continue;
      const m = this.addMemberNow(j.id, j.username, false, j.avatar);
      if (!this.buyIn(m)) {
        // 金币不足，撤销入座并退回观战
        this.members.pop();
        this.reindex();
        this.spectators.set(j.id, { name: j.username, avatar: j.avatar, connected: this.subs.has(j.id) });
        this.pushChat(`${j.username} 金币不足，无法入座`, true);
        continue;
      }
      m.connected = this.subs.has(j.id);
      this.spectators.delete(j.id);
      this.pushChat(`${j.username} 入座`, true);
    }
    this.pendingJoins = [];
    if (this.game) this.game.players = this.members;
  }

  endGame() {
    this.started = false;
    this.phase = 'waiting';
    this.clearTimer();
    this.removeLeftMembers(); // 先兑现本局中途离场者

    let best = null;
    for (const m of this.members) {
      if (!best || m.chips > best.chips) best = m;
    }
    this.lastResult = best ? `🏁 本局结束！筹码最多：${best.name}（${best.chips}）` : '本局结束';
    this.pushLog(this.lastResult);

    // 结算：记录战绩 + 把桌上筹码兑回金币
    for (const m of this.members) {
      if (m.isBot) continue;
      if (this.onResult && m.onTable) this.onResult(m.userId, m.chips - m.buyInTotal, m === best, this.name);
      this.cashOut(m);
      m.buyInTotal = 0;
    }

    // 排队入座者本局未及参与，退回观战席
    for (const j of this.pendingJoins) {
      if (!this.memberByUser(j.id)) this.spectators.set(j.id, { name: j.username, avatar: j.avatar, connected: this.subs.has(j.id) });
    }
    this.pendingJoins = [];

    for (const m of this.members) {
      m.inHand = false; m.folded = false; m.cards = null; m.hand = null;
      m.looked = false; m.bet = 0; m.revealed = false; m.auto = false;
      m.chips = this.startChips; // 等待室仅作展示，真实余额在金币钱包
    }
    this.game = null;
    this.broadcast();
  }

  /** 房间被回收前调用：退款所有在桌玩家（含底池中的下注），避免金币丢失。 */
  dispose() {
    if (this.started) {
      if (this.game && this.game.phase === 'betting') {
        for (const m of this.members) { m.chips += m.bet; m.bet = 0; } // 撤销本手下注
        this.game.pot = 0;
      }
      for (const m of this.members) this.cashOut(m);
    }
    this.clearTimer();
  }

  syncFromGame() {
    if (!this.game) return;
    this.phase = this.game.phase;
    this.log = this.game.log;
  }

  /** 记录一手牌的战报快照（含已揭示的牌）。 */
  recordHand(winnerId, reason, won) {
    if (!this.game) return;
    const winner = winnerId != null ? this.members[winnerId] : null;
    const entry = {
      handNo: this.game.handNo,
      pot: won || 0,
      reason, // 'fold' | 'showdown'
      winner: winner ? winner.name : '',
      ts: Date.now(),
      players: this.members.filter((m) => m.cards).map((m) => ({
        name: m.name,
        folded: m.folded,
        revealed: m.revealed || (reason === 'showdown' && !m.folded) || m.id === winnerId,
        cards: (m.revealed || (reason === 'showdown' && !m.folded)) && m.cards ? m.cards.map(E.formatCard) : null,
        handName: (m.revealed || (reason === 'showdown' && !m.folded)) && m.hand ? m.hand.name : null,
      })),
    };
    this.handHistory.push(entry);
    if (this.handHistory.length > 30) this.handHistory.shift();
  }

  // ---- 真人动作 ----

  action(userId, act, arg) {
    if (!this.started || !this.game) return { error: '游戏尚未开始' };
    const m = this.memberByUser(userId);
    if (!m) return { error: '你不在牌桌上' };
    if (this.game.phase !== 'betting') return { error: '当前无法行动' };
    if (this.game.turn !== m.id) return { error: '还没轮到你' };

    m.auto = false; // 手动操作即收回托管
    switch (act) {
      case 'look': this.game.look(m.id); break;
      case 'call': this.game.call(m.id); break;
      case 'raise': this.game.raise(m.id, parseInt(arg, 10)); break;
      case 'compare': this.game.compare(m.id, parseInt(arg, 10)); break;
      case 'fold': this.game.fold(m.id); break;
      default: return { error: '未知动作: ' + act };
    }
    this.syncFromGame();
    this.broadcast();
    this.schedule();
    return { ok: true };
  }

  /** 房间聊天。 */
  sendChat(user, text) {
    if (!this.authorized.has(user.id) && !this.memberByUser(user.id)) {
      return { error: '请先进入房间' };
    }
    let t = String(text || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 200);
    if (!t) return { error: '消息为空' };
    const now = Date.now();
    if (now - (this.lastChatAt.get(user.id) || 0) < 500) return { error: '发言太快，请稍候' };
    this.lastChatAt.set(user.id, now);
    this.chat.push({ name: user.username, text: t, ts: now, sys: false });
    if (this.chat.length > 60) this.chat.shift();
    this.broadcast();
    return { ok: true };
  }

  // ---- 定时编排 ----

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    this.clearTimer();
    if (!this.started || !this.game) return;

    if (this.game.phase === 'betting') {
      const p = this.members[this.game.turn];
      if (!p) return;
      if (p.isBot) {
        this.turnDeadline = 0;
        this.timer = setTimeout(() => this.botStep(p.id), this.botDelay);
      } else if (p.auto) {
        const ms = 1500;
        this.turnDeadline = Date.now() + ms;
        this.timer = setTimeout(() => this.autoStep(p.id), ms);
      } else {
        const ms = p.connected ? this.turnMs : this.discTurnMs;
        this.turnDeadline = Date.now() + ms;
        this.timer = setTimeout(() => this.timeoutStep(p.id), ms);
      }
    } else if (this.game.phase === 'ended') {
      this.turnDeadline = 0;
      this.timer = setTimeout(() => this.nextHand(), this.nextHandDelay);
    }
  }

  botStep(id) {
    if (!this.started || !this.game) return;
    if (this.game.phase !== 'betting' || this.game.turn !== id) return;
    this.game.botAct(this.members[id]);
    this.syncFromGame();
    this.broadcast();
    this.schedule();
  }

  timeoutStep(id) {
    if (!this.started || !this.game) return;
    if (this.game.phase !== 'betting' || this.game.turn !== id) return;
    const p = this.members[id];
    this.pushLog(`${p.name} 超时，自动弃牌`);
    this.game.fold(id);
    this.syncFromGame();
    this.broadcast();
    this.schedule();
  }

  /** 托管自动出牌：小注跟、大注弃（保守策略）。 */
  autoStep(id) {
    if (!this.started || !this.game) return;
    if (this.game.phase !== 'betting' || this.game.turn !== id) return;
    const p = this.members[id];
    if (!p.auto) { this.schedule(); return; }
    const cost = this.game.callCost(p);
    const cap = this.config.ante * 3;
    if (cost <= p.chips && cost <= cap) {
      this.game.call(id);
    } else {
      this.pushLog(`${p.name}（托管）弃牌`);
      this.game.fold(id);
    }
    this.syncFromGame();
    this.broadcast();
    this.schedule();
  }

  // ---- SSE 订阅与广播 ----

  addSubscriber(userId, res) {
    let set = this.subs.get(userId);
    if (!set) {
      set = new Set();
      this.subs.set(userId, set);
    }
    const firstConn = set.size === 0;
    set.add(res);
    const m = this.memberByUser(userId);
    if (m) {
      if (firstConn && !m.connected) this.pushChat(`${m.name} 重新连接`, true);
      m.connected = true;
    } else {
      const spec = this.spectators.get(userId);
      if (spec) spec.connected = true;
    }
    if (firstConn) this.broadcast();
    else this.sendTo(res, this.viewFor(userId));
  }

  removeSubscriber(userId, res) {
    const set = this.subs.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      this.subs.delete(userId);
      const m = this.memberByUser(userId);
      if (m) {
        m.connected = false;
        this.pushChat(`${m.name} 掉线了，等待重连…`, true);
      } else {
        const spec = this.spectators.get(userId);
        if (spec) spec.connected = false;
      }
      this.broadcast();
      this.maybeEmpty();
    }
  }

  sendTo(res, view) {
    try {
      res.write('data: ' + JSON.stringify(view) + '\n\n');
    } catch (e) { /* 连接已断开，由 close 事件清理 */ }
  }

  broadcast() {
    for (const [userId, set] of this.subs) {
      const view = this.viewFor(userId);
      for (const res of set) this.sendTo(res, view);
    }
  }

  pushLog(msg) {
    this.log.push(msg);
    if (this.log.length > 80) this.log.shift();
    if (this.game) this.game.log = this.log;
  }

  /** 系统/玩家聊天消息（sys=true 为系统提示）。 */
  pushChat(text, sys) {
    this.chat.push({ name: '', text, ts: Date.now(), sys: !!sys });
    if (this.chat.length > 60) this.chat.shift();
  }

  // ---- 视图 ----

  spectatorList() {
    return Array.from(this.spectators.values()).map((s) => ({ name: s.name, avatar: s.avatar || '🙂', connected: s.connected }));
  }

  /** 为某个用户（成员或旁观者）生成完整视图。 */
  viewFor(userId) {
    const m = this.memberByUser(userId);
    const viewerId = m ? m.id : -1;
    const isHost = this.hostUserId === userId;

    let v;
    if (this.started && this.game) {
      v = this.game.buildView(viewerId);
    } else {
      v = this.lobbyView(viewerId);
    }

    const canStand = !!m && (!this.started || !m.inHand || m.folded || (this.game && this.game.phase !== 'betting'));

    v.room = {
      id: this.id,
      name: this.name,
      isPrivate: this.isPrivate,
      password: isHost ? this.password : undefined,
      started: this.started,
      isHost,
      hostUserId: this.hostUserId,
      maxSeats: this.maxSeats,
      yourSeat: viewerId,
      youJoined: !!m,
      role: m ? (isHost ? 'host' : 'player') : 'spectator',
      pendingJoin: this.pendingJoins.some((j) => j.id === userId),
      turnMs: this.turnMs,
      turnDeadline: this.turnDeadline,
      config: this.config,
      seats: this.members.map((mem) => ({
        seat: mem.id,
        name: mem.name,
        avatar: mem.avatar,
        isBot: mem.isBot,
        chips: mem.chips,
        connected: mem.connected,
        isYou: mem.userId === userId,
        isHost: mem.userId === this.hostUserId,
        standPending: mem.standPending,
        auto: mem.auto,
        canKick: isHost && !mem.isBot && mem.userId !== userId,
      })),
      spectators: this.spectatorList(),
      spectatorCount: this.spectators.size,
      chat: this.chat.slice(-30),
      history: this.handHistory.slice(-15),
      botDifficulty: this.botDifficulty,
      buyIn: this.wallet ? this.startChips : 0,
      youAuto: m ? !!m.auto : false,
      canSit: !m && this.members.length + this.pendingJoins.length < this.maxSeats,
      canStand,
      canStart: !this.started && isHost && this.members.length >= 2 && this.humanCount() >= 1,
      canAddBot: !this.started && isHost && this.members.length < this.maxSeats,
      canRemoveBot: !this.started && isHost && this.members.some((x) => x.isBot),
    };
    return v;
  }

  lobbyView(viewerId) {
    return {
      handNo: 0,
      pot: 0,
      ante: this.config.ante,
      currentStake: this.config.ante,
      maxStake: this.config.maxStake,
      round: 0,
      maxRounds: this.config.maxRounds,
      phase: 'waiting',
      turn: -1,
      activeCount: 0,
      players: this.members.map((mem) => ({
        id: mem.id, name: mem.name, avatar: mem.avatar, isBot: mem.isBot, isYou: mem.id === viewerId,
        chips: mem.chips, bet: 0, inHand: false, folded: false, looked: false,
        isTurn: false, cards: null, handName: null,
      })),
      log: this.log.slice(-30),
      result: this.lastResult || '',
      winnerId: null,
      viewerId,
      you: null,
      actions: {
        canAct: false, canLook: false, canCall: false, callCost: 0,
        canRaise: false, raiseTo: 0, raiseCost: 0, maxStake: 0,
        canCompare: false, compareCost: 0, compareTargets: [], canFold: false,
      },
    };
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      isPrivate: this.isPrivate,
      started: this.started,
      players: this.members.length,
      humans: this.humanCount(),
      maxSeats: this.maxSeats,
      spectators: this.spectators.size,
      ante: this.config.ante,
      startChips: this.startChips,
    };
  }
}

module.exports = { Room };
