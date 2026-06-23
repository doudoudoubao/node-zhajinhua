'use strict';

/**
 * 单机炸金花牌桌：一名真人（你，座位 0）对多个 AI 机器人。
 *
 * 下注规则继承自 BettingGame（与联机模式共用）；本类只负责单机编排：
 * 机器人在你行动后被同步驱动，直到再次轮到你或本手结束。
 */

const { BettingGame, clampInt } = require('./core');

let SEQ = 1;

const BOT_NAMES = ['小赵', '老钱', '阿孙', '李哥', '周姐', '吴叔', '郑爷', '小王'];

class Table extends BettingGame {
  constructor(opts = {}) {
    super(opts);
    this.id = opts.id || genId();
    this.startChips = clampInt(opts.startChips, 1000, 100, 1000000);
    const botCount = clampInt(opts.botCount, 3, 1, 5);

    const diff = ['easy', 'normal', 'hard'].includes(opts.botDifficulty) ? opts.botDifficulty : 'normal';
    this.players.push(makePlayer(0, opts.playerName || '你', false, this.startChips));
    const names = shuffleNames();
    for (let i = 0; i < botCount; i++) {
      const m = makePlayer(i + 1, names[i], true, this.startChips);
      m.difficulty = diff;
      this.players.push(m);
    }

    this.dealerIdx = this.players.length - 1; // 第一手由 0 号玩家先说话
    this.startHand();
  }

  /** 开始新的一手牌：处理筹码不足导致的结束，再发牌。 */
  startHand() {
    const eligible = this.players.filter((p) => p.chips >= this.ante);
    const youHaveChips = this.players[0].chips >= this.ante;
    if (!youHaveChips || eligible.length < 2) {
      this.phase = 'gameover';
      this.turn = -1;
      this.winnerId = null;
      this.pushLog(youHaveChips ? '其他玩家都没筹码了，游戏结束。' : '你的筹码输光了，游戏结束。');
      return;
    }

    this.dealerIdx = (this.dealerIdx + 1) % this.players.length;
    this.dealNewHand((this.dealerIdx + 1) % this.players.length);
    this.pushLog(`—— 第 ${this.handNo} 手开始，每人底注 ${this.ante}，底池 ${this.pot} ——`);
    this.runBots();
  }

  /** 同步驱动机器人，直到轮到你或本手结束。 */
  runBots() {
    let guard = 0;
    while (this.phase === 'betting' && this.turn > 0 && guard < 200) {
      guard += 1;
      this.botAct(this.players[this.turn]);
    }
  }

  /** 你的动作入口，处理后自动驱动机器人。 */
  playerAction(action, arg) {
    if (this.phase === 'gameover') return { error: '游戏已结束' };
    if (action === 'next') {
      if (this.phase !== 'ended') return { error: '本手牌尚未结束' };
      this.startHand();
      return { ok: true };
    }
    if (this.phase !== 'betting') return { error: '当前无法行动' };
    if (this.turn !== 0) return { error: '还没轮到你' };

    switch (action) {
      case 'look': this.look(0); break;
      case 'call': this.call(0); break;
      case 'raise': this.raise(0, parseInt(arg, 10)); break;
      case 'compare': this.compare(0, parseInt(arg, 10)); break;
      case 'fold': this.fold(0); break;
      default: return { error: '未知动作: ' + action };
    }
    this.runBots();
    return { ok: true };
  }

  /** 给客户端的视图（你固定为座位 0）。 */
  getView() {
    const v = this.buildView(0);
    v.gameId = this.id;
    v.actions.canNext = this.phase === 'ended';
    v.actions.gameOver = this.phase === 'gameover';
    return v;
  }
}

const BOT_AVATARS = ['🐯', '🦊', '🐼', '🦁', '🐵', '🐷', '🐲', '🐰'];

function makePlayer(id, name, isBot, chips) {
  return {
    id, name, isBot, chips,
    avatar: isBot ? BOT_AVATARS[(id - 1 + BOT_AVATARS.length) % BOT_AVATARS.length] : '😀',
    cards: null, hand: null,
    inHand: false, folded: false, looked: false,
    bet: 0, revealed: false,
  };
}

function shuffleNames() {
  const arr = BOT_NAMES.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function genId() {
  SEQ += 1;
  return Date.now().toString(36) + '-' + SEQ.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

module.exports = { Table };
