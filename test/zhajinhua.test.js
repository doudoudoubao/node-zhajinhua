'use strict';

/**
 * 炸金花牌力引擎与对局流程自测。
 * 运行: node test/zhajinhua.test.js
 */

const assert = require('assert');
const E = require('../src/zhajinhua/engine');
const { Table } = require('../src/zhajinhua/table');

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

const C = (rank, suit) => ({ rank, suit });
const ev = (cards) => E.evaluate(cards);

console.log('\n== 牌型识别 ==');

test('豹子', () => {
  const h = ev([C(10, '♠'), C(10, '♥'), C(10, '♣')]);
  assert.strictEqual(h.type, 5);
  assert.strictEqual(h.name, '豹子');
});

test('同花顺', () => {
  const h = ev([C(7, '♥'), C(8, '♥'), C(9, '♥')]);
  assert.strictEqual(h.type, 4);
  assert.strictEqual(h.name, '同花顺');
});

test('金花（同花）', () => {
  const h = ev([C(2, '♣'), C(9, '♣'), C(13, '♣')]);
  assert.strictEqual(h.type, 3);
});

test('顺子', () => {
  const h = ev([C(4, '♠'), C(5, '♥'), C(6, '♣')]);
  assert.strictEqual(h.type, 2);
});

test('A-2-3 视为顺子', () => {
  const h = ev([C(14, '♠'), C(2, '♥'), C(3, '♣')]);
  assert.strictEqual(h.type, 2);
  assert.strictEqual(h.tiebreak[0], 3);
});

test('Q-K-A 为最大顺子', () => {
  const h = ev([C(12, '♠'), C(13, '♥'), C(14, '♣')]);
  assert.strictEqual(h.type, 2);
  assert.strictEqual(h.tiebreak[0], 14);
});

test('对子', () => {
  const h = ev([C(8, '♠'), C(8, '♥'), C(3, '♣')]);
  assert.strictEqual(h.type, 1);
  assert.strictEqual(h.tiebreak[0], 8);
  assert.strictEqual(h.tiebreak[1], 3);
});

test('单张', () => {
  const h = ev([C(2, '♠'), C(9, '♥'), C(13, '♣')]);
  assert.strictEqual(h.type, 0);
});

console.log('\n== 牌型比较 ==');

const cmp = (h1, h2) => E.compareHands(ev(h1), ev(h2));

test('豹子 > 同花顺', () => {
  assert.strictEqual(cmp([C(3, '♠'), C(3, '♥'), C(3, '♣')], [C(7, '♥'), C(8, '♥'), C(9, '♥')]), 1);
});

test('同花顺 > 金花', () => {
  assert.strictEqual(cmp([C(7, '♥'), C(8, '♥'), C(9, '♥')], [C(2, '♣'), C(9, '♣'), C(13, '♣')]), 1);
});

test('金花 > 顺子', () => {
  assert.strictEqual(cmp([C(2, '♣'), C(5, '♣'), C(9, '♣')], [C(4, '♠'), C(5, '♥'), C(6, '♣')]), 1);
});

test('顺子 > 对子', () => {
  assert.strictEqual(cmp([C(4, '♠'), C(5, '♥'), C(6, '♣')], [C(13, '♠'), C(13, '♥'), C(2, '♣')]), 1);
});

test('对子 > 单张', () => {
  assert.strictEqual(cmp([C(2, '♠'), C(2, '♥'), C(3, '♣')], [C(14, '♠'), C(13, '♥'), C(9, '♣')]), 1);
});

test('A-2-3 顺子 < 2-3-4 顺子', () => {
  assert.strictEqual(cmp([C(14, '♠'), C(2, '♥'), C(3, '♣')], [C(2, '♠'), C(3, '♥'), C(4, '♣')]), -1);
});

test('Q-K-A 顺子 > J-Q-K 顺子', () => {
  assert.strictEqual(cmp([C(12, '♠'), C(13, '♥'), C(14, '♣')], [C(11, '♠'), C(12, '♥'), C(13, '♣')]), 1);
});

test('大豹子 > 小豹子', () => {
  assert.strictEqual(cmp([C(14, '♠'), C(14, '♥'), C(14, '♣')], [C(13, '♠'), C(13, '♥'), C(13, '♣')]), 1);
});

test('对子相同比单张', () => {
  assert.strictEqual(cmp([C(8, '♠'), C(8, '♥'), C(13, '♣')], [C(8, '♣'), C(8, '♦'), C(2, '♣')]), 1);
});

test('完全相同点数为平局', () => {
  assert.strictEqual(cmp([C(8, '♠'), C(8, '♥'), C(13, '♣')], [C(8, '♣'), C(8, '♦'), C(13, '♦')]), 0);
});

console.log('\n== 牌力强度排序 ==');

test('强度随牌型递增', () => {
  const single = E.handStrength(ev([C(2, '♠'), C(9, '♥'), C(13, '♣')]));
  const pair = E.handStrength(ev([C(8, '♠'), C(8, '♥'), C(3, '♣')]));
  const leopard = E.handStrength(ev([C(14, '♠'), C(14, '♥'), C(14, '♣')]));
  assert.ok(single < pair, '单张应弱于对子');
  assert.ok(pair < leopard, '对子应弱于豹子');
  assert.ok(leopard <= 1 && single >= 0);
});

console.log('\n== 牌组完整性 ==');

test('一副牌 52 张且无重复', () => {
  const deck = E.createDeck();
  assert.strictEqual(deck.length, 52);
  const set = new Set(deck.map((c) => c.rank + c.suit));
  assert.strictEqual(set.size, 52);
});

test('洗牌后仍为 52 张不重复', () => {
  const deck = E.shuffle(E.createDeck());
  const set = new Set(deck.map((c) => c.rank + c.suit));
  assert.strictEqual(set.size, 52);
});

console.log('\n== 对局流程 ==');

test('开局即下底注且发牌', () => {
  const t = new Table({ botCount: 2, ante: 10, startChips: 500 });
  const v = t.getView();
  assert.strictEqual(v.players.length, 3);
  // 底注已收：进行中底池≥30；若机器人开局即弃牌至只剩一人，本手已结束（底池已派发）
  assert.ok(v.pot >= 30 || v.phase === 'ended', '应已收取底注: pot=' + v.pot + ' phase=' + v.phase);
  // 筹码守恒（3 人 × 500）
  const total = t.players.reduce((s, p) => s + p.chips, 0) + t.pot;
  assert.strictEqual(total, 1500, '筹码总量应为 1500');
  // 进行中时机器人手牌对客户端隐藏
  const bot = v.players.find((p) => p.isBot && p.inHand && !p.folded);
  if (bot && v.phase === 'betting') assert.strictEqual(bot.cards, null, '进行中机器人牌应隐藏');
});

test('看牌不消耗筹码', () => {
  const t = new Table({ botCount: 1, ante: 10, startChips: 500 });
  // 推进到你的回合
  if (t.turn === 0) {
    const before = t.players[0].chips;
    t.playerAction('look');
    assert.strictEqual(t.players[0].chips, before, '看牌不应扣筹码');
    assert.strictEqual(t.players[0].looked, true);
  }
});

test('多局自动跑通不会卡死或为负筹码', () => {
  const t = new Table({ botCount: 3, ante: 10, startChips: 300, maxStake: 40, maxRounds: 6 });
  for (let hand = 0; hand < 40; hand++) {
    let guard = 0;
    while (t.phase === 'betting' && guard < 100) {
      guard += 1;
      if (t.turn === 0) {
        // 简单策略：能跟就跟，否则弃牌
        const v = t.getView();
        if (v.actions.canCall) t.playerAction('call');
        else t.playerAction('fold');
      } else {
        break; // 机器人由引擎内部驱动，理论上不会停在机器人回合
      }
    }
    assert.notStrictEqual(t.phase, 'betting', '一手牌应能结束');
    for (const p of t.players) {
      assert.ok(p.chips >= 0, p.name + ' 筹码不应为负: ' + p.chips);
    }
    if (t.phase === 'gameover') break;
    t.playerAction('next');
  }
});

test('筹码守恒（总量不变）', () => {
  const t = new Table({ botCount: 2, ante: 10, startChips: 200, maxStake: 40 });
  const total = () => t.players.reduce((s, p) => s + p.chips, 0) + t.pot;
  const initial = total();
  for (let i = 0; i < 5; i++) {
    let guard = 0;
    while (t.phase === 'betting' && guard < 100) {
      guard += 1;
      if (t.turn === 0) {
        const v = t.getView();
        if (v.actions.canCall) t.playerAction('call');
        else t.playerAction('fold');
      } else break;
    }
    assert.strictEqual(total(), initial, '筹码总量应守恒');
    if (t.phase === 'gameover') break;
    t.playerAction('next');
  }
});

test('单机机器人按难度赋值', () => {
  const t = new Table({ botCount: 2, botDifficulty: 'easy', startChips: 300 });
  for (const p of t.players) {
    if (p.isBot) assert.strictEqual(p.difficulty, 'easy', '机器人应为指定难度');
  }
});

test('未指定难度默认为普通', () => {
  const t = new Table({ botCount: 1 });
  assert.strictEqual(t.players[1].difficulty, 'normal');
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
