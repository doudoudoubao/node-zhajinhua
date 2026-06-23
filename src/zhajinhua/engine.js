'use strict';

/**
 * 炸金花（三张）核心牌力引擎 —— 大众规则。
 *
 * 牌型从大到小：
 *   豹子(5) > 同花顺(4) > 金花/同花(3) > 顺子(2) > 对子(1) > 单张(0)
 *
 * 顺子说明：A-2-3 视为最小的顺子，Q-K-A 为最大的顺子。
 *
 * 本模块为纯函数，无任何外部依赖，可同时在 Node 与浏览器中运行。
 */

const SUITS = ['♠', '♥', '♣', '♦']; // 0 黑桃 1 红心 2 梅花 3 方块
const RED_SUITS = new Set(['♥', '♦']);

// 2..10, J=11, Q=12, K=13, A=14
const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const TYPE_NAMES = ['单张', '对子', '顺子', '金花', '同花顺', '豹子'];

/** 生成一副标准 52 张扑克（不含大小王）。 */
function createDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ rank: r, suit: SUITS[s] });
    }
  }
  return deck;
}

/** Fisher–Yates 洗牌（原地打乱并返回）。 */
function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = deck[i];
    deck[i] = deck[j];
    deck[j] = t;
  }
  return deck;
}

/**
 * 评估三张牌，返回牌型与用于比较的权重数组。
 * @param {{rank:number,suit:string}[]} cards 长度为 3 的手牌
 * @returns {{type:number, name:string, tiebreak:number[], cards:object[]}}
 */
function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('炸金花手牌必须为 3 张');
  }
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a); // 降序
  const suits = cards.map((c) => c.suit);
  const [a, b, c] = ranks;

  const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
  const isTriple = a === b && b === c;

  // 顺子判定（含特殊的 A-2-3）
  let isStraight = false;
  let straightHigh = null;
  if (a - 1 === b && b - 1 === c) {
    isStraight = true;
    straightHigh = a;
  } else if (a === 14 && b === 3 && c === 2) {
    // A-2-3 视为最小顺子，权重设为 3（小于 2-3-4 的 4）
    isStraight = true;
    straightHigh = 3;
  }

  let pairRank = null;
  let kicker = null;
  if (!isTriple) {
    if (a === b) {
      pairRank = a;
      kicker = c;
    } else if (b === c) {
      pairRank = b;
      kicker = a;
    }
  }

  let type;
  let tiebreak;
  if (isTriple) {
    type = 5;
    tiebreak = [a];
  } else if (isStraight && isFlush) {
    type = 4;
    tiebreak = [straightHigh];
  } else if (isFlush) {
    type = 3;
    tiebreak = [a, b, c];
  } else if (isStraight) {
    type = 2;
    tiebreak = [straightHigh];
  } else if (pairRank != null) {
    type = 1;
    tiebreak = [pairRank, kicker];
  } else {
    type = 0;
    tiebreak = [a, b, c];
  }

  return { type, name: TYPE_NAMES[type], tiebreak, cards };
}

/**
 * 比较两手牌。
 * @returns {number} h1 大于 h2 返回 1，小于返回 -1，完全相等返回 0。
 */
function compareHands(h1, h2) {
  const a = [h1.type, ...h1.tiebreak];
  const b = [h2.type, ...h2.tiebreak];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 把牌力归一化为 0..1 的强度值，供 AI 决策使用。
 */
function handStrength(hand) {
  // 各牌型的基础区间宽度大致拉开，型内再用首张点数微调
  const base = hand.type / 6; // 0 .. 5/6
  const top = (hand.tiebreak[0] || 2) / 14; // 0.14 .. 1
  const strength = base + (top / 6); // 落在对应牌型区间内
  return Math.min(0.999, strength);
}

/** 把一张牌格式化为展示对象。 */
function formatCard(card) {
  return {
    rank: RANK_LABELS[card.rank],
    suit: card.suit,
    color: RED_SUITS.has(card.suit) ? 'red' : 'black',
    label: RANK_LABELS[card.rank] + card.suit,
  };
}

const engine = {
  SUITS,
  RANK_LABELS,
  TYPE_NAMES,
  createDeck,
  shuffle,
  evaluate,
  compareHands,
  handStrength,
  formatCard,
};

// 同时支持 CommonJS 与浏览器全局
if (typeof module !== 'undefined' && module.exports) {
  module.exports = engine;
}
if (typeof window !== 'undefined') {
  window.ZJHEngine = engine;
}
