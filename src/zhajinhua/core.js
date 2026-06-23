'use strict';

/**
 * 炸金花下注流程核心状态机（大众规则），与「谁来驱动行动」无关。
 *
 * 单机（Table，机器人同步驱动）与联机（Room，真人异步 + 机器人定时）共用本类，
 * 保证两种模式下的牌型、下注、比牌、摊牌规则完全一致。
 *
 * 约定：this.players 为本手参与者数组，下标即 player.id；turn 为当前行动者 id。
 */

const E = require('./engine');

/** 机器人难度参数：影响看牌倾向、弃牌果断度、加注/比牌激进度与诈唬频率。 */
const BOT_DIFFICULTY = {
  easy: {
    look2: 0.5, look1: 0.25, blindBase: 0.30, blindVar: 0.30,
    weakFold: 0.45, midFoldExpensive: 0.30, strongTh: 0.85, midTh: 0.62,
    strongRaise: 0.35, strongCompare: 0.35, midRaise: 0.20, midCompare: 0.15, bluff: 0.05,
  },
  normal: {
    look2: 0.85, look1: 0.40, blindBase: 0.34, blindVar: 0.28,
    weakFold: 0.75, midFoldExpensive: 0.50, strongTh: 0.82, midTh: 0.60,
    strongRaise: 0.60, strongCompare: 0.55, midRaise: 0.35, midCompare: 0.30, bluff: 0.12,
  },
  hard: {
    look2: 0.95, look1: 0.70, blindBase: 0.38, blindVar: 0.24,
    weakFold: 0.90, midFoldExpensive: 0.65, strongTh: 0.78, midTh: 0.56,
    strongRaise: 0.75, strongCompare: 0.65, midRaise: 0.50, midCompare: 0.40, bluff: 0.20,
  },
};
const DIFFICULTY_LABELS = { easy: '新手', normal: '普通', hard: '高手' };

class BettingGame {
  constructor(opts = {}) {
    this.ante = clampInt(opts.ante, 10, 1, 1000);
    this.maxStake = clampInt(opts.maxStake, 80, this.ante * 2, 100000);
    this.maxRounds = clampInt(opts.maxRounds, 8, 2, 50);

    this.players = [];
    this.pot = 0;
    this.currentStake = this.ante;
    this.round = 1;
    this.phase = 'waiting'; // waiting | betting | ended | gameover
    this.turn = -1;
    this.winnerId = null;
    this.lastResult = '';
    this.handNo = 0;
    this.log = [];
    this.pending = new Set();
  }

  pushLog(msg) {
    this.log.push(msg);
    if (this.log.length > 80) this.log.shift();
  }

  /** 当前未弃牌、仍在本手牌中的玩家。 */
  activePlayers() {
    return this.players.filter((p) => p.inHand && !p.folded);
  }

  /** 从 idx（含）开始，找到第一个仍在牌局中的玩家下标。 */
  nextActiveFrom(idx) {
    const n = this.players.length;
    for (let k = 0; k < n; k++) {
      const i = (idx + k) % n;
      const p = this.players[i];
      if (p && p.inHand && !p.folded) return i;
    }
    return -1;
  }

  advanceTurn() {
    this.turn = this.nextActiveFrom((this.turn + 1) % this.players.length);
  }

  /** 跟注/比牌需要付出的筹码（看牌为 2 倍）。 */
  callCost(p) {
    return p.looked ? this.currentStake * 2 : this.currentStake;
  }

  /** 加注到 newStake 需付出的筹码。 */
  raiseCost(p, newStake) {
    return p.looked ? newStake * 2 : newStake;
  }

  /**
   * 发新一手牌：洗牌发牌、下底注、确定先说话的人。
   * 调用前 this.players 必须已就绪（id 已按 0..n-1 赋值）。
   */
  dealNewHand(firstActorId) {
    this.handNo += 1;
    this.pot = 0;
    this.currentStake = this.ante;
    this.round = 1;
    this.phase = 'betting';
    this.winnerId = null;
    this.lastResult = '';

    const deck = E.shuffle(E.createDeck());
    for (const p of this.players) {
      p.folded = false;
      p.looked = false;
      p.bet = 0;
      p.cards = null;
      p.hand = null;
      p.revealed = false;
      if (p.chips >= this.ante) {
        p.inHand = true;
        p.cards = [deck.pop(), deck.pop(), deck.pop()];
        p.hand = E.evaluate(p.cards);
        p.chips -= this.ante;
        p.bet += this.ante;
        this.pot += this.ante;
      } else {
        p.inHand = false;
      }
    }

    this.turn = this.nextActiveFrom(((firstActorId % this.players.length) + this.players.length) % this.players.length);
    this.pending = new Set(this.activePlayers().map((p) => p.id));
  }

  // ---- 玩家动作（均以 id 索引，不假设座位 0 是真人）----

  /** 看牌（不消耗筹码，也不结束当前行动）。 */
  look(id) {
    const p = this.players[id];
    if (!p || !p.inHand || p.folded || p.looked) return;
    p.looked = true;
    this.pushLog(`${p.name} 看牌`);
  }

  /** 跟注。 */
  call(id) {
    const p = this.players[id];
    if (!p || !p.inHand || p.folded) return;
    const cost = this.callCost(p);
    if (cost > p.chips) return this.fold(id);
    this.payIn(p, cost);
    this.pushLog(`${p.name} 跟注 ${cost}（${p.looked ? '看牌' : '闷牌'}）`);
    this.pending.delete(id);
    this.afterAction(id);
  }

  /** 加注到指定单注。 */
  raise(id, newStake) {
    const p = this.players[id];
    if (!p || !p.inHand || p.folded) return;
    newStake = clampInt(newStake, this.currentStake + this.ante, this.currentStake + 1, this.maxStake);
    const cost = this.raiseCost(p, newStake);
    if (newStake <= this.currentStake || this.currentStake >= this.maxStake || cost > p.chips) {
      return this.call(id);
    }
    this.currentStake = newStake;
    this.payIn(p, cost);
    this.pushLog(`${p.name} 加注到 ${newStake}（投入 ${cost}）`);
    // 加注后其余在场玩家需重新应对
    this.pending = new Set(this.activePlayers().map((x) => x.id));
    this.pending.delete(id);
    this.afterAction(id);
  }

  /** 弃牌（行动方主动弃牌）。 */
  fold(id) {
    const p = this.players[id];
    if (!p || !p.inHand || p.folded) return;
    this.pushLog(`${p.name} 弃牌`);
    this.dropPlayer(id);
  }

  /**
   * 让某玩家退出本手牌，无论是否轮到它（用于弃牌、离桌、掉线）。
   * 只有当被移除者正好是当前行动者时才推进 turn，避免打乱其他人的顺序。
   */
  dropPlayer(id) {
    const p = this.players[id];
    if (!p || !p.inHand || p.folded) return;
    const onTurn = this.turn === id;
    p.folded = true;
    this.pending.delete(id);
    if (this.phase !== 'betting') return;

    const active = this.activePlayers();
    if (active.length <= 1) {
      return this.endHand(active[0] ? active[0].id : null, 'fold');
    }
    if (onTurn) {
      this.advanceTurn();
      if (this.pending.size === 0) {
        if (this.round >= this.maxRounds) return this.showdown();
        this.round += 1;
        this.pending = new Set(this.activePlayers().map((x) => x.id));
        this.pushLog(`—— 进入第 ${this.round} 轮 ——`);
      }
    }
  }

  /** 与指定对手比牌（付出与跟注相同的筹码）。 */
  compare(id, targetId) {
    const p = this.players[id];
    if (!p || !p.inHand || p.folded) return;
    const active = this.activePlayers();
    if (active.length < 2) return;
    let target = this.players[targetId];
    if (!target || !target.inHand || target.folded || target.id === id) {
      target = active.find((x) => x.id !== id);
    }
    const cost = this.callCost(p);
    if (cost > p.chips) return this.fold(id);
    this.payIn(p, cost);

    const cmp = E.compareHands(p.hand, target.hand);
    let loser;
    if (cmp > 0) loser = target;
    else if (cmp < 0) loser = p;
    else loser = p; // 平局：主动比牌方判负

    loser.folded = true;
    loser.revealed = true;
    p.revealed = true;
    target.revealed = true;
    this.pending.delete(id);
    this.pending.delete(loser.id);
    this.pushLog(`${p.name} 与 ${target.name} 比牌，${loser.name} 落败出局`);
    this.afterAction(id, true);
  }

  payIn(p, cost) {
    p.chips -= cost;
    p.bet += cost;
    this.pot += cost;
  }

  /** 每个动作后：检查是否结束、推进回合与轮次。 */
  afterAction(actorId, mayEnd = false) {
    if (this.phase !== 'betting') return;

    const active = this.activePlayers();
    if (active.length <= 1) {
      return this.endHand(active[0] ? active[0].id : null, 'fold');
    }

    this.advanceTurn();

    if (this.pending.size === 0) {
      if (this.round >= this.maxRounds) {
        return this.showdown();
      }
      this.round += 1;
      this.pending = new Set(this.activePlayers().map((p) => p.id));
      this.pushLog(`—— 进入第 ${this.round} 轮 ——`);
    }
  }

  /** 强制摊牌：在场玩家比大小，最大者赢。 */
  showdown() {
    const active = this.activePlayers();
    let best = active[0];
    for (const p of active) {
      p.revealed = true;
      if (E.compareHands(p.hand, best.hand) > 0) best = p;
    }
    this.pushLog('达到回合上限，强制摊牌！');
    this.endHand(best.id, 'showdown');
  }

  /** 结束本手牌并把底池给赢家。 */
  endHand(winnerId, reason) {
    this.phase = 'ended';
    this.turn = -1;
    this.winnerId = winnerId;
    const won = this.pot;
    this.pot = 0; // 底池已结算，置零避免重复计入
    if (winnerId != null) {
      const w = this.players[winnerId];
      w.chips += won;
      w.revealed = w.revealed || reason === 'showdown';
      const handDesc = w.revealed && w.hand ? `（${w.hand.name}）` : '';
      this.lastResult = `${w.name} 赢得底池 ${won}${handDesc}`;
    } else {
      this.lastResult = '本手无人获胜';
    }
    this.pushLog('🏆 ' + this.lastResult);
    if (typeof this.onHandEnd === 'function') this.onHandEnd(winnerId, reason, won);
  }

  // ---- 机器人 AI ----

  /** 单个机器人的一次决策（同步执行其动作），按难度调整激进度。 */
  botAct(bot) {
    if (!bot || !bot.inHand || bot.folded) return;
    if (this.turn !== bot.id || this.phase !== 'betting') return;
    const d = BOT_DIFFICULTY[bot.difficulty] || BOT_DIFFICULTY.normal;

    if (!bot.looked) {
      const lookChance = this.round >= 2 ? d.look2 : d.look1;
      if (Math.random() < lookChance) this.look(bot.id);
    }

    const active = this.activePlayers().length;
    const cost = this.callCost(bot);
    if (cost > bot.chips) return this.fold(bot.id);

    let strength = bot.looked ? E.handStrength(bot.hand) : d.blindBase + Math.random() * d.blindVar;

    if (strength < 0.24 && Math.random() < d.weakFold) return this.fold(bot.id);
    if (strength < 0.4 && cost > bot.chips * 0.18 && Math.random() < d.midFoldExpensive) return this.fold(bot.id);

    const canRaise = this.currentStake < this.maxStake;
    const raiseTo = Math.min(this.maxStake, this.currentStake + this.ante);

    if (strength > d.strongTh) {
      if (active === 2 && Math.random() < d.strongCompare) return this.compare(bot.id, this.otherActiveId(bot.id));
      if (canRaise && Math.random() < d.strongRaise) return this.raise(bot.id, raiseTo);
      return this.call(bot.id);
    }
    if (strength > d.midTh) {
      if (active === 2 && Math.random() < d.midCompare) return this.compare(bot.id, this.otherActiveId(bot.id));
      if (canRaise && Math.random() < d.midRaise) return this.raise(bot.id, raiseTo);
      return this.call(bot.id);
    }
    if (!bot.looked && canRaise && Math.random() < d.bluff) return this.raise(bot.id, raiseTo);
    return this.call(bot.id);
  }

  otherActiveId(id) {
    const other = this.activePlayers().find((p) => p.id !== id);
    return other ? other.id : id;
  }

  // ---- 视图 ----

  /** 某玩家的牌是否对 viewer 可见。 */
  cardsVisibleTo(p, viewerId) {
    if (p.id === viewerId) {
      // 自己的牌：看牌后可见；本手结束后也可见
      return p.looked || this.phase === 'ended';
    }
    // 他人的牌：被比下/摊牌后揭示，或本手结束时揭示未弃牌者
    return p.revealed || (this.phase === 'ended' && !p.folded);
  }

  /** 生成给指定 viewer（座位 id，-1 表示旁观者）的视图。 */
  buildView(viewerId) {
    const me = this.players[viewerId] || null;
    const active = this.activePlayers();

    const players = this.players.map((p) => {
      const show = this.cardsVisibleTo(p, viewerId);
      return {
        id: p.id,
        name: p.name,
        avatar: p.avatar || (p.isBot ? '🤖' : '🙂'),
        isBot: p.isBot,
        isYou: p.id === viewerId,
        chips: p.chips,
        bet: p.bet,
        inHand: p.inHand,
        folded: p.folded,
        looked: p.looked,
        isTurn: p.id === this.turn,
        cards: show && p.cards ? p.cards.map(E.formatCard) : null,
        handName: show && p.hand ? p.hand.name : null,
      };
    });

    let actions = emptyActions();
    if (me) {
      const callCost = this.callCost(me);
      const raiseTo = Math.min(this.maxStake, this.currentStake + this.ante);
      const canAct = this.phase === 'betting' && this.turn === viewerId && me.inHand && !me.folded;
      actions = {
        canAct,
        canLook: canAct && !me.looked,
        canCall: canAct && callCost <= me.chips,
        callCost,
        canRaise: canAct && this.currentStake < this.maxStake && this.raiseCost(me, raiseTo) <= me.chips,
        raiseTo,
        raiseCost: this.raiseCost(me, raiseTo),
        maxStake: this.maxStake,
        canCompare: canAct && active.length >= 2 && callCost <= me.chips,
        compareCost: callCost,
        compareTargets: canAct ? active.filter((p) => p.id !== viewerId).map((p) => ({ id: p.id, name: p.name })) : [],
        canFold: canAct,
      };
    }

    return {
      handNo: this.handNo,
      pot: this.pot,
      ante: this.ante,
      currentStake: this.currentStake,
      maxStake: this.maxStake,
      round: this.round,
      maxRounds: this.maxRounds,
      phase: this.phase,
      turn: this.turn,
      activeCount: active.length,
      players,
      log: this.log.slice(-30),
      result: this.lastResult || '',
      winnerId: this.winnerId,
      viewerId,
      you: me ? { looked: me.looked, chips: me.chips, inHand: me.inHand, folded: me.folded } : null,
      actions,
    };
  }
}

function emptyActions() {
  return {
    canAct: false, canLook: false, canCall: false, callCost: 0,
    canRaise: false, raiseTo: 0, raiseCost: 0, maxStake: 0,
    canCompare: false, compareCost: 0, compareTargets: [], canFold: false,
  };
}

function clampInt(v, def, min, max) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = def;
  return Math.max(min, Math.min(max, n));
}

module.exports = { BettingGame, clampInt, BOT_DIFFICULTY, DIFFICULTY_LABELS };
