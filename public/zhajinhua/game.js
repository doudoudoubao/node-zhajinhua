'use strict';

/**
 * 炸金花前端（棋牌式圆桌）：单机对 AI 与真人联机共用同一套牌桌渲染。
 * 联机额外支持：好友 / 房间密码 / 观战 / 聊天 / 邀请 / 断线重连提示。
 * 所有发牌、洗牌、机器人决策都在服务端完成，他人暗牌不会下发，杜绝前端作弊。
 */

const $ = (id) => document.getElementById(id);

let me = null;
let mode = 'single';
let gameId = null;
let currentRoomId = null;
let es = null;            // 房间 SSE
let notifyEs = null;      // 全局通知 SSE
let lobbyTimer = null;
let countdownTimer = null;
let lastView = null;
let authTab = 'login';
let busy = false;
let myProfile = null;     // 含金币 / 战绩 / 头像
let prevView = null;      // 上一帧视图（用于音效触发）
let bubbles = {};         // 座位名 -> { text, until } 聊天气泡
let lastChatTs = 0;
let soundOn = localStorage.getItem('zjh_sound') !== '0';

const EMOTES = ['👍', '😂', '😭', '💰', '🤔', '😡', '🎉', '👏', '🐂', '🀄'];
const PHRASES = ['快点啦~', '你牌真好', '再来一局', '梭哈！', '决一死战', '承让承让', '哈哈哈哈', '不要走'];
const DIFF_LABELS = { easy: '新手', normal: '普通', hard: '高手' };

// ---------- 网络 ----------

async function postJSON(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  try { return await res.json(); } catch (e) { return { error: '服务器响应异常' }; }
}
async function getJSON(path) {
  const res = await fetch(path);
  try { return await res.json(); } catch (e) { return { error: '服务器响应异常' }; }
}

// ---------- 音效（WebAudio 合成，无需素材） ----------

let audioCtx = null;
function ac() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function tone(freq, dur, type, vol) {
  if (!soundOn) return;
  const c = ac(); if (!c) return;
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(vol || 0.12, c.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  o.connect(g); g.connect(c.destination);
  o.start(); o.stop(c.currentTime + dur);
}
const sfx = {
  deal: () => { tone(520, 0.06, 'square', 0.06); setTimeout(() => tone(640, 0.06, 'square', 0.06), 80); },
  chip: () => tone(880, 0.07, 'triangle', 0.1),
  turn: () => { tone(660, 0.12, 'sine', 0.14); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'sine', 0.14), i * 110)); },
  lose: () => { [392, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'sine', 0.12), i * 130)); },
  click: () => tone(440, 0.04, 'square', 0.05),
};
function toggleSound() {
  soundOn = !soundOn;
  localStorage.setItem('zjh_sound', soundOn ? '1' : '0');
  $('soundBtn').textContent = soundOn ? '🔊' : '🔇';
  if (soundOn) sfx.click();
}

// ---------- 屏幕 ----------

const SCREENS = ['home', 'singleSetup', 'lobby', 'table'];
function showScreen(id) { for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id); }

function goHome() {
  closeRoomStream();
  stopLobbyPolling();
  currentRoomId = null;
  gameId = null;
  showScreen('home');
}

// ---------- 用户系统 ----------

async function loadMe() {
  const r = await getJSON('/auth/me');
  me = r.user || null;
  if (me) { await loadProfile(); openNotify(); } else { myProfile = null; closeNotify(); }
  renderAuthArea();
}

async function loadProfile() {
  const r = await getJSON('/zhajinhua/api/profile');
  myProfile = r.profile || null;
  renderAuthArea();
}

function renderAuthArea() {
  const el = $('authArea');
  if (me) {
    const coins = myProfile ? myProfile.coins : 0;
    const av = myProfile ? myProfile.avatar : '🙂';
    const canCheckin = myProfile && !myProfile.checkedInToday;
    el.innerHTML = `
      <span class="coins">💰 ${coins}</span>
      <button class="checkin" id="checkinBtn" ${canCheckin ? '' : 'disabled'}>${canCheckin ? '签到' : '已签到'}</button>
      <span class="who"><span class="av" id="avatarBtn" title="个人资料">${av}</span> ${escapeHtml(me.username)}</span>
      <a class="link" id="logoutLink">退出</a>`;
    $('checkinBtn').addEventListener('click', doCheckin);
    $('avatarBtn').addEventListener('click', openProfile);
    $('logoutLink').addEventListener('click', logout);
  } else {
    el.innerHTML = `<button class="ghost small" id="loginBtn">登录 / 注册</button>`;
    $('loginBtn').addEventListener('click', () => openAuth('login'));
  }
}

async function doCheckin() {
  const r = await postJSON('/zhajinhua/api/checkin', {});
  if (r.claimed) { toast(`✅ 签到成功，+${r.gain} 金币！`); sfx.win(); }
  else toast('今天已经签到过啦');
  await loadProfile();
}

// ---------- 个人资料 / 排行榜 ----------

async function openProfile() {
  await loadProfile();
  if (!myProfile) return;
  const s = myProfile.stats || { games: 0, wins: 0, net: 0 };
  $('profileStats').innerHTML = `
    <div class="ps"><b>${myProfile.coins}</b>金币</div>
    <div class="ps"><b>${s.games}</b>局数</div>
    <div class="ps"><b>${s.wins}</b>夺冠</div>
    <div class="ps"><b>${s.net >= 0 ? '+' : ''}${s.net}</b>总盈亏</div>`;
  const recent = myProfile.recent || [];
  $('profileRecent').innerHTML = recent.length
    ? recent.map((g) => `<span class="rg ${g.won ? 'win' : 'lose'}">${g.won ? '🏆' : ''}${g.net >= 0 ? '+' : ''}${g.net}</span>`).join('')
    : '<div class="empty">还没有联机对局记录</div>';
  const grid = $('avatarGrid');
  grid.innerHTML = '';
  for (const a of myProfile.avatars) {
    const d = document.createElement('div');
    d.className = 'av-opt' + (a === myProfile.avatar ? ' sel' : '');
    d.textContent = a;
    d.addEventListener('click', async () => {
      const r = await postJSON('/zhajinhua/api/profile/avatar', { avatar: a });
      if (!r.error) { myProfile.avatar = a; openProfile(); renderAuthArea(); }
    });
    grid.appendChild(d);
  }
  $('profileModal').classList.remove('hidden');
}

async function openLeaderboard() {
  const r = await getJSON('/zhajinhua/api/leaderboard');
  const list = $('leaderboardList');
  const rows = r.leaderboard || [];
  if (!rows.length) { list.innerHTML = '<div class="empty">暂无数据</div>'; }
  else {
    list.innerHTML = rows.map((u, i) => `
      <div class="lb-row ${i < 3 ? 'top' + (i + 1) : ''}">
        <span class="lb-rank">${i + 1}</span>
        <span>${u.avatar}</span>
        <span class="lb-name">${escapeHtml(u.username)}</span>
        <span class="lb-stat">${u.games}局/${u.wins}冠</span>
        <span class="lb-coins">💰 ${u.coins}</span>
      </div>`).join('');
  }
  $('leaderboardModal').classList.remove('hidden');
}

function openAuth(tab) {
  setAuthTab(tab || 'login');
  $('authUsername').value = ''; $('authPassword').value = ''; $('authError').textContent = '';
  $('authModal').classList.remove('hidden');
  $('authUsername').focus();
}
function setAuthTab(tab) {
  authTab = tab;
  document.querySelectorAll('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('authSubmit').textContent = tab === 'login' ? '登录' : '注册';
}
async function submitAuth() {
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  const r = await postJSON(authTab === 'login' ? '/auth/login' : '/auth/register', { username, password });
  if (r.error) { $('authError').textContent = r.error; return; }
  me = r.user; renderAuthArea(); openNotify();
  $('authModal').classList.add('hidden');
  if (!$('lobby').classList.contains('hidden')) enterLobby();
}
async function logout() {
  await postJSON('/auth/logout', {});
  me = null; renderAuthArea(); closeNotify();
  if (mode === 'online') goHome();
}

// ---------- 全局通知（好友 / 邀请 / 上下线） ----------

function openNotify() {
  closeNotify();
  notifyEs = new EventSource('/zhajinhua/api/notify/stream');
  notifyEs.onmessage = (e) => { let p; try { p = JSON.parse(e.data); } catch (_) { return; } handleNotify(p); };
}
function closeNotify() { if (notifyEs) { notifyEs.close(); notifyEs = null; } }

function handleNotify(p) {
  if (p.type === 'friend_request') {
    toast(`👤 <b>${escapeHtml(p.from.username)}</b> 请求加你为好友`, {
      actions: [
        { label: '接受', cls: 'primary', fn: async () => { await postJSON('/zhajinhua/api/friends/accept', { fromId: p.from.id }); refreshFriends(); } },
        { label: '忽略', cls: 'ghost', fn: async () => { await postJSON('/zhajinhua/api/friends/decline', { fromId: p.from.id }); } },
      ],
    });
    refreshFriends();
  } else if (p.type === 'friend_accepted') {
    toast(`✅ <b>${escapeHtml(p.user.username)}</b> 已成为你的好友`);
    refreshFriends();
  } else if (p.type === 'invite') {
    toast(`🎴 <b>${escapeHtml(p.from.username)}</b> 邀请你加入房间「${escapeHtml(p.room.name)}」`, {
      type: 'invite',
      actions: [{ label: '加入', cls: 'gold', fn: () => enterRoom(p.room.id) }],
    });
  } else if (p.type === 'presence') {
    refreshFriends();
  }
}

// ---------- 单机 ----------

async function startSingle() {
  mode = 'single';
  const v = await postJSON('/zhajinhua/api/new', {
    botCount: parseInt($('botCount').value, 10), ante: parseInt($('ante').value, 10),
    startChips: parseInt($('startChips').value, 10), maxStake: parseInt($('maxStake').value, 10),
    botDifficulty: $('botDifficulty').value,
  });
  if (v.error) return flash(v.error);
  gameId = v.gameId; showScreen('table'); render(v);
}
async function singleAct(action, arg) {
  if (busy || !gameId) return;
  busy = true;
  try {
    const v = await postJSON('/zhajinhua/api/action', { gameId, action, arg });
    if (v.error && !v.players) return flash(v.error);
    render(v);
  } finally { busy = false; }
}

// ---------- 大厅 ----------

function enterLobby() {
  mode = 'online';
  showScreen('lobby');
  const needLogin = !me;
  $('lobbyAuthHint').classList.toggle('hidden', !needLogin);
  $('createRoomBtn').disabled = needLogin;
  $('joinById').classList.toggle('hidden', needLogin);
  $('friendsPanel').classList.toggle('hidden', needLogin);
  $('roomList').classList.toggle('hidden', needLogin);
  if (!needLogin) { refreshRooms(); refreshFriends(); startLobbyPolling(); }
}
function startLobbyPolling() { stopLobbyPolling(); lobbyTimer = setInterval(() => { refreshRooms(); refreshFriends(); }, 5000); }
function stopLobbyPolling() { if (lobbyTimer) clearInterval(lobbyTimer); lobbyTimer = null; }

let allRooms = [];
async function refreshRooms() {
  const r = await getJSON('/zhajinhua/api/rooms');
  allRooms = r.rooms || [];
  renderRoomList();
}
function renderRoomList() {
  const el = $('roomList');
  const q = ($('roomSearch').value || '').trim().toLowerCase();
  const f = $('roomFilterSel').value;
  let rooms = allRooms.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || String(r.id).includes(q))) return false;
    if (f === 'open' && r.players >= r.maxSeats) return false;
    if (f === 'waiting' && r.started) return false;
    if (f === 'playing' && !r.started) return false;
    if (f === 'public' && r.isPrivate) return false;
    return true;
  });
  if (!rooms.length) { el.innerHTML = '<div class="empty">没有符合条件的房间</div>'; return; }
  el.innerHTML = '';
  for (const r of rooms) {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="room-card-main">
        <div class="room-card-name">${r.isPrivate ? '🔒 ' : ''}${escapeHtml(r.name)} <span class="muted">#${r.id}</span></div>
        <div class="room-card-meta">
          <span>👥 ${r.players}/${r.maxSeats}</span>
          <span>👀 ${r.spectators}</span>
          <span>底注 ${r.ante}</span>
          <span>${r.started ? '🟢 进行中' : '⚪ 等待中'}</span>
        </div>
      </div>`;
    const btnEl = document.createElement('button');
    btnEl.className = 'primary small';
    btnEl.textContent = '进入';
    btnEl.addEventListener('click', () => enterRoom(r.id));
    card.appendChild(btnEl);
    el.appendChild(card);
  }
}

async function refreshFriends() {
  if (!me) return;
  const r = await getJSON('/zhajinhua/api/friends');
  renderFriends(r.friends || [], r.requests || []);
}
function renderFriends(friends, requests) {
  const rq = $('friendRequests');
  rq.innerHTML = requests.map((u) => `
    <div class="friend-req">
      <span>👤 ${escapeHtml(u.username)} 申请加好友</span>
      <span class="rq-actions">
        <button class="primary small" data-acc="${u.id}">接受</button>
        <button class="ghost small" data-dec="${u.id}">忽略</button>
      </span>
    </div>`).join('');
  rq.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', async () => { await postJSON('/zhajinhua/api/friends/accept', { fromId: +b.dataset.acc }); refreshFriends(); }));
  rq.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', async () => { await postJSON('/zhajinhua/api/friends/decline', { fromId: +b.dataset.dec }); refreshFriends(); }));

  const fl = $('friendList');
  if (!friends.length) { fl.innerHTML = '<div class="empty">还没有好友，点「+ 加好友」添加吧～</div>'; return; }
  fl.innerHTML = '';
  for (const f of friends) {
    const item = document.createElement('div');
    item.className = 'friend-item';
    const where = f.room ? `<span class="friend-where">在「${escapeHtml(f.room.name)}」</span>` : (f.online ? '<span class="friend-where">在线</span>' : '');
    item.innerHTML = `<span class="friend-dot ${f.online ? 'on' : 'off'}"></span><span class="friend-name">${escapeHtml(f.username)}</span>${where}`;
    if (f.room) {
      const j = document.createElement('button');
      j.className = 'ghost small'; j.textContent = '加入';
      j.addEventListener('click', () => enterRoom(f.room.id));
      item.appendChild(j);
    }
    fl.appendChild(item);
  }
}

function openCreateModal() {
  if (!me) return openAuth('login');
  $('createError').textContent = ''; $('roomNameInput').value = ''; $('roomPwInput').value = '';
  $('createModal').classList.remove('hidden');
}
async function createRoom() {
  const r = await postJSON('/zhajinhua/api/room/create', {
    name: $('roomNameInput').value.trim(), password: $('roomPwInput').value.trim(),
    maxSeats: parseInt($('cMaxSeats').value, 10), ante: parseInt($('cAnte').value, 10),
    startChips: parseInt($('cStartChips').value, 10), maxStake: parseInt($('cMaxStake').value, 10),
    botDifficulty: $('cBotDifficulty').value,
  });
  if (r.error) { $('createError').textContent = r.error; return; }
  $('createModal').classList.add('hidden');
  enterRoom(r.roomId);
}

// ---------- 进入 / 离开房间 ----------

async function enterRoom(roomId, password) {
  if (!me) return openAuth('login');
  roomId = String(roomId || '').trim();
  if (!roomId) return;
  const r = await postJSON('/zhajinhua/api/room/enter', { roomId, password });
  if (r.error) {
    if (/密码/.test(r.error)) {
      const pw = prompt('该房间已加密，请输入房间密码：');
      if (pw != null) return enterRoom(roomId, pw);
      return;
    }
    return flash(r.error);
  }
  mode = 'online'; currentRoomId = roomId;
  stopLobbyPolling();
  showScreen('table');
  openRoomStream(roomId);
}

function openRoomStream(roomId) {
  closeRoomStream();
  es = new EventSource('/zhajinhua/api/room/stream?roomId=' + encodeURIComponent(roomId));
  es.onopen = () => setConn(true);
  es.onmessage = (e) => { let v; try { v = JSON.parse(e.data); } catch (_) { return; } if (v.room) { setConn(true); render(v); } };
  es.onerror = () => setConn(false);
}
function closeRoomStream() { if (es) { es.close(); es = null; } setConn(true); }

function setConn(ok) { $('connBar').classList.toggle('hidden', ok); }

async function leaveRoom() {
  if (currentRoomId) await postJSON('/zhajinhua/api/room/leave', { roomId: currentRoomId });
  closeRoomStream();
  currentRoomId = null;
  enterLobby();
}

async function roomCmd(path) {
  const r = await postJSON(path, { roomId: currentRoomId });
  if (r.error) flash(r.error);
}
async function onlineAct(action, arg) {
  const r = await postJSON('/zhajinhua/api/room/action', { roomId: currentRoomId, action, arg });
  if (r.error) flash(r.error);
}
function doAction(action, arg) { return mode === 'single' ? singleAct(action, arg) : onlineAct(action, arg); }

async function sendChat() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const r = await postJSON('/zhajinhua/api/room/chat', { roomId: currentRoomId, text });
  if (r.error) flash(r.error);
}

// ---------- 渲染 ----------

function cardHtml(c) {
  if (!c) return '<div class="card back"></div>';
  return `<div class="card ${c.color}"><span class="c-rank">${c.rank}</span><span class="c-suit">${c.suit}</span></div>`;
}
function hiddenCards(n) { let s = ''; for (let i = 0; i < n; i++) s += cardHtml(null); return s; }

function slotXY(i, total) {
  const ang = Math.PI / 2 + i * (2 * Math.PI / total); // 底部起，顺时针
  return { x: 50 + 48 * Math.cos(ang), y: 50 + 42 * Math.sin(ang) };
}

function render(v) {
  lastView = v;
  const online = !!v.room;

  // 房间信息栏
  const rb = $('roomBar');
  rb.classList.toggle('hidden', !online);
  if (online) renderRoomBar(v);

  // 中央底池
  $('potChip').textContent = '底池 ' + v.pot;
  const inLobby = online && !v.room.started;
  $('stageInfo').textContent = inLobby ? '等待房主开始…' : `第 ${v.handNo} 手 · 单注 ${v.currentStake} · 第 ${v.round}/${v.maxRounds} 轮`;
  const sr = $('stageResult');
  const showResult = v.result && (v.phase === 'ended' || v.phase === 'gameover' || (inLobby && v.result));
  sr.classList.toggle('hidden', !showResult);
  if (showResult) sr.textContent = v.result;

  renderSeatsRing(v, online);
  renderControls(v, online, inLobby);

  // 聊天 / 观战（仅联机）
  $('chatDock').classList.toggle('hidden', !online);
  if (online) renderChat(v);

  // 牌局记录
  const log = $('log');
  log.innerHTML = (v.log || []).map((l) => {
    const hl = l.startsWith('🏆') || l.startsWith('——') || l.startsWith('🎮') || l.startsWith('🏁');
    return `<div class="${hl ? 'hl' : ''}">${escapeHtml(l)}</div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;

  playSounds(v);
  startCountdown(v, online);
  scheduleBubbleClear();
  prevView = v;
}

let bubbleTimer = null;
function scheduleBubbleClear() {
  if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  let soonest = Infinity;
  for (const k in bubbles) if (bubbles[k].until > Date.now()) soonest = Math.min(soonest, bubbles[k].until);
  if (soonest !== Infinity) bubbleTimer = setTimeout(() => { if (lastView) render(lastView); }, soonest - Date.now() + 50);
}

function playSounds(v) {
  const pv = prevView;
  if (!pv) return;
  // 新一手 → 发牌音
  if (v.handNo > pv.handNo && v.phase === 'betting') sfx.deal();
  // 底池增加 → 筹码音
  if (v.pot > pv.pot && v.phase === 'betting') sfx.chip();
  // 轮到你 → 提示音
  if (v.actions && v.actions.canAct && !(pv.actions && pv.actions.canAct)) sfx.turn();
  // 本手/本局结束 → 胜负音 + 刷新金币
  if ((v.phase === 'ended' || v.phase === 'gameover') && pv.phase === 'betting') {
    const youWin = v.winnerId != null && v.players.some((p) => p.isYou && p.id === v.winnerId);
    if (youWin) sfx.win(); else if (v.you && v.you.inHand) sfx.lose();
  }
  // 一局彻底结束（联机）→ 刷新金币余额
  if (v.room && !v.room.started && pv.room && pv.room.started) {
    if (me) loadProfile();
    sfx.win();
  }
}

function renderRoomBar(v) {
  const r = v.room;
  const parts = [`<span class="rb-title">${escapeHtml(r.name)}</span>`];
  parts.push(`<span class="rb-tag copy" data-copy="${r.id}" title="点击复制房间号">房号 ${r.id} 📋</span>`);
  if (r.isPrivate) {
    parts.push(r.password
      ? `<span class="rb-tag copy" data-copy="${escapeHtml(r.password)}" title="点击复制密码">🔒 密码 ${escapeHtml(r.password)} 📋</span>`
      : `<span class="rb-tag">🔒 私密房</span>`);
  }
  parts.push(`<span class="rb-tag">👥 ${r.seats.length}/${r.maxSeats}</span>`);
  parts.push(`<span class="rb-tag">👀 ${r.spectatorCount}</span>`);
  if (r.buyIn) parts.push(`<span class="rb-tag">💰 买入 ${r.buyIn}</span>`);
  if (r.botDifficulty) parts.push(`<span class="rb-tag">🤖 ${DIFF_LABELS[r.botDifficulty] || r.botDifficulty}</span>`);
  parts.push(`<span class="rb-spacer"></span>`);
  parts.push(`<button class="ghost small" id="rbHistory">📜 战报</button>`);
  parts.push(`<button class="ghost small" id="rbInvite">＋邀请好友</button>`);
  parts.push(`<button class="warn small" id="rbLeave">离开</button>`);
  $('roomBar').innerHTML = parts.join('');
  $('roomBar').querySelectorAll('[data-copy]').forEach((el) => el.addEventListener('click', () => copyText(el.dataset.copy)));
  $('rbHistory').addEventListener('click', openHistory);
  $('rbInvite').addEventListener('click', openInvite);
  $('rbLeave').addEventListener('click', leaveRoom);
}

function openHistory() {
  const r = lastView && lastView.room;
  const list = $('historyList');
  const hist = (r && r.history) || [];
  if (!hist.length) { list.innerHTML = '<div class="empty">本局还没有已结束的牌</div>'; }
  else {
    list.innerHTML = hist.slice().reverse().map((h) => {
      const players = h.players.map((p) => {
        const cards = p.cards ? `<span class="hcards">${p.cards.map(cardHtml).join('')}</span>` : (p.folded ? '<span>弃牌</span>' : '<span>未亮牌</span>');
        const hn = p.handName ? `【${p.handName}】` : '';
        return `<div class="hist-p ${p.name === h.winner ? 'win' : ''}">${escapeHtml(p.name)} ${cards} ${hn}</div>`;
      }).join('');
      const tag = h.reason === 'showdown' ? '摊牌' : '通杀';
      return `<div class="hist-row">
        <div class="hist-head"><span>第 ${h.handNo} 手 · ${tag}</span><span class="hw">🏆 ${escapeHtml(h.winner || '无')} +${h.pot}</span></div>
        <div class="hist-players">${players}</div>
      </div>`;
    }).join('');
  }
  $('historyModal').classList.remove('hidden');
}

function renderSeatsRing(v, online) {
  const maxSeats = online ? v.room.maxSeats : v.players.length;
  const mySeat = v.viewerId;
  const occ = v.players.slice();
  let ordered = mySeat >= 0 ? occ.slice(mySeat).concat(occ.slice(0, mySeat)) : occ.slice();
  const slots = ordered.slice();
  while (slots.length < maxSeats) slots.push(null);

  const seatMeta = {};
  if (online) for (const s of v.room.seats) seatMeta[s.seat] = s;

  const wrap = $('seats');
  wrap.innerHTML = '';
  slots.forEach((p, i) => {
    const pos = slotXY(i, slots.length);
    const el = document.createElement('div');
    el.className = 'seat-slot';
    el.style.left = pos.x + '%';
    el.style.top = pos.y + '%';
    el.innerHTML = p ? seatCardHtml(p, v, seatMeta[p.id]) : emptySeatHtml(v, online);
    wrap.appendChild(el);
  });
  // 空位入座 / 踢人
  wrap.querySelectorAll('[data-sit]').forEach((b) => b.addEventListener('click', () => roomCmd('/zhajinhua/api/room/sit')));
  wrap.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm('确定把该玩家请出房间？')) postJSON('/zhajinhua/api/room/kick', { roomId: currentRoomId, seat: +b.dataset.kick }).then((r) => { if (r.error) flash(r.error); });
  }));
}

function seatCardHtml(p, v, meta) {
  const cls = ['seat-card'];
  if (p.isTurn) cls.push('turn');
  if (p.folded || !p.inHand) cls.push('folded');
  if (p.id === v.winnerId) cls.push('winner');
  if (p.isYou) cls.push('you');
  const connected = meta ? meta.connected : true;
  if (!connected) cls.push('offline');

  let status = '';
  if (!p.inHand) status = '<span class="seat-status">轮空</span>';
  else if (p.folded) status = '<span class="seat-status">弃牌</span>';
  else if (p.looked) status = '<span class="seat-status look">看牌</span>';
  else status = '<span class="seat-status blind">闷牌</span>';
  if (meta && meta.standPending) status = '<span class="seat-status">将离座</span>';

  let cards = '';
  if (p.inHand) cards = `<div class="seat-cards">${p.cards ? p.cards.map(cardHtml).join('') : hiddenCards(3)}</div>`;
  else cards = '<div class="seat-cards"></div>';

  const avatar = p.avatar || (p.isBot ? '🤖' : '🙂');
  const pip = `<span class="conn-pip ${connected ? 'on' : 'off'}"></span>`;
  const crown = meta && meta.isHost ? '<span class="crown">👑</span>' : '';
  const ring = p.isTurn && v.room && v.room.turnDeadline ? '<div class="turn-ring" id="activeTurnRing"></div>' : '<div class="turn-ring"></div>';
  const kick = meta && meta.canKick ? `<button class="seat-kick" data-kick="${p.id}" title="请出房间">✕</button>` : '';
  const auto = meta && meta.auto ? '<span class="seat-auto">托管</span>' : '';
  const bub = bubbles[p.name] && bubbles[p.name].until > Date.now() ? `<div class="chat-bubble">${escapeHtml(bubbles[p.name].text)}</div>` : '';

  return `
    <div class="${cls.join(' ')}">
      ${kick}${auto}${bub}
      <div class="seat-avatar ${p.isBot ? 'bot' : ''}">${escapeHtml(avatar)}${meta ? pip : ''}</div>
      <div class="seat-name">${crown}${escapeHtml(p.name)}</div>
      <div class="seat-chips">${p.chips}</div>
      ${status}
      <div class="seat-bet">${p.bet > 0 ? '投 ' + p.bet : ''}</div>
      ${cards}
      <div class="seat-handname">${p.handName ? '【' + p.handName + '】' : ''}</div>
      ${ring}
    </div>`;
}

function emptySeatHtml(v, online) {
  const canSit = online && v.room.canSit;
  return `<div class="seat-empty">空位${canSit ? '<button class="ghost" data-sit="1">入座</button>' : ''}</div>`;
}

function renderControls(v, online, inLobby) {
  const c = $('controls');
  c.innerHTML = '';
  const a = v.actions;

  if (!online) {
    if (a.gameOver) { c.appendChild(btn('🔄 重新开始', 'primary', () => showScreen('singleSetup'))); c.appendChild(btn('🏠 首页', 'ghost', goHome)); return; }
    if (a.canNext) { c.appendChild(btn('▶️ 下一手', 'primary', () => doAction('next'))); c.appendChild(btn('🏠 首页', 'ghost', goHome)); return; }
    if (a.canAct) appendGameButtons(c, a, v);
    else c.appendChild(hint('等待对手行动…'));
    return;
  }

  const r = v.room;
  if (r.started) {
    if (a.canAct) appendGameButtons(c, a, v);
    else c.appendChild(hint(r.role === 'spectator' ? '观战中…' : (v.phase === 'ended' ? '本手结束，准备下一手…' : '等待其他玩家…')));
    if (r.role !== 'spectator') {
      c.appendChild(btn(r.youAuto ? '🛑 取消托管' : '🤝 托管', r.youAuto ? 'gold' : 'ghost', () => postJSON('/zhajinhua/api/room/auto', { roomId: currentRoomId, on: !r.youAuto })));
    }
    if (r.canStand) c.appendChild(btn('🪑 站起', 'ghost', () => roomCmd('/zhajinhua/api/room/stand')));
  } else {
    // 等待室
    if (r.isHost) {
      c.appendChild(btn('▶ 开始游戏', 'primary', () => roomCmd('/zhajinhua/api/room/start'), !r.canStart));
      c.appendChild(btn('＋机器人', 'ghost', () => roomCmd('/zhajinhua/api/room/addbot'), !r.canAddBot));
      c.appendChild(btn('－机器人', 'ghost', () => roomCmd('/zhajinhua/api/room/removebot'), !r.canRemoveBot));
    } else if (r.role === 'spectator') {
      c.appendChild(hint(r.canSit ? '点桌上「入座」加入游戏' : '观战中…'));
    } else {
      c.appendChild(hint('等待房主开始游戏…'));
      if (r.canStand) c.appendChild(btn('🪑 站起观战', 'ghost', () => roomCmd('/zhajinhua/api/room/stand')));
    }
  }
}

function appendGameButtons(c, a, v) {
  c.appendChild(hint('轮到你 →', 'your-turn'));
  if (a.canLook) c.appendChild(btn('👁 看牌', 'gold', () => doAction('look')));
  if (a.canCall) c.appendChild(btn(`✅ 跟注 ${a.callCost}`, 'primary', () => doAction('call')));
  if (a.canRaise) c.appendChild(btn('⬆️ 加注', 'ghost', () => openRaise(v)));
  if (a.canCompare) c.appendChild(btn(`⚔️ 比牌 ${a.compareCost}`, 'ghost', () => openCompare(v)));
  if (a.canFold) c.appendChild(btn('🏳️ 弃牌', 'warn', () => doAction('fold')));
}

function renderChat(v) {
  const r = v.room;
  const specs = r.spectators || [];
  $('specStrip').textContent = specs.length ? `观战 ${specs.length}：${specs.map((s) => s.name).slice(0, 5).join('、')}${specs.length > 5 ? '…' : ''}` : '';
  const box = $('chatMsgs');
  box.innerHTML = (r.chat || []).map((m) => m.sys
    ? `<div class="cm sys">· ${escapeHtml(m.text)}</div>`
    : `<div class="cm"><span class="nm">${escapeHtml(m.name)}：</span>${escapeHtml(m.text)}</div>`).join('');
  box.scrollTop = box.scrollHeight;

  // 新的玩家发言 → 在其座位上方弹气泡
  for (const m of (r.chat || [])) {
    if (!m.sys && m.ts > lastChatTs) {
      bubbles[m.name] = { text: m.text, until: Date.now() + 3500 };
    }
  }
  const newest = (r.chat || []).filter((m) => !m.sys).slice(-1)[0];
  if (newest) lastChatTs = Math.max(lastChatTs, newest.ts);

  if ($('emoteBar').childElementCount === 0) renderEmoteBar();
  if ($('phraseBar').childElementCount === 0) renderPhraseBar();
}

function quickSend(text) { postJSON('/zhajinhua/api/room/chat', { roomId: currentRoomId, text }).then((r) => { if (r.error) flash(r.error); }); }

function renderEmoteBar() {
  const bar = $('emoteBar');
  bar.innerHTML = '';
  for (const e of EMOTES) {
    const b = document.createElement('button');
    b.textContent = e;
    b.addEventListener('click', () => quickSend(e));
    bar.appendChild(b);
  }
}

function renderPhraseBar() {
  const bar = $('phraseBar');
  bar.innerHTML = '';
  for (const t of PHRASES) {
    const b = document.createElement('button');
    b.textContent = t;
    b.addEventListener('click', () => quickSend(t));
    bar.appendChild(b);
  }
}

function startCountdown(v, online) {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (!online || !v.room.turnDeadline || v.phase !== 'betting') return;
  const deadline = v.room.turnDeadline;
  const tick = () => {
    const el = $('activeTurnRing');
    if (!el) { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } return; }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = '⏱ ' + left + 's';
    el.classList.toggle('danger', left <= 5);
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function btn(text, cls, onClick, disabled) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = text; if (disabled) b.disabled = true;
  b.addEventListener('click', onClick);
  return b;
}
function hint(text, cls) {
  const s = document.createElement('span');
  s.className = cls || 'turn-hint'; s.textContent = text;
  return s;
}

// ---------- 邀请好友 ----------

async function openInvite() {
  const r = await getJSON('/zhajinhua/api/friends');
  const online = (r.friends || []).filter((f) => f.online);
  const list = $('inviteList');
  if (!online.length) { list.innerHTML = '<div class="empty">没有在线好友可邀请</div>'; }
  else {
    list.innerHTML = '';
    for (const f of online) {
      const row = document.createElement('div');
      row.className = 'inv-item';
      row.innerHTML = `<span>👤 ${escapeHtml(f.username)}</span>`;
      const b = document.createElement('button');
      b.className = 'primary small'; b.textContent = '邀请';
      b.addEventListener('click', async () => {
        const rr = await postJSON('/zhajinhua/api/friends/invite', { friendId: f.id, roomId: currentRoomId });
        if (rr.error) flash(rr.error); else { b.textContent = '已邀请'; b.disabled = true; }
      });
      row.appendChild(b);
      list.appendChild(row);
    }
  }
  $('inviteModal').classList.remove('hidden');
}

// ---------- 弹窗 ----------

function openCompare(v) {
  const wrap = $('compareTargets');
  wrap.innerHTML = '';
  for (const t of v.actions.compareTargets) {
    wrap.appendChild(btn(`与 ${t.name} 比牌`, 'ghost', () => { $('compareModal').classList.add('hidden'); doAction('compare', t.id); }));
  }
  $('compareModal').classList.remove('hidden');
}

let raiseLooked = false;
function openRaise(v) {
  const range = $('raiseRange');
  raiseLooked = v.you && v.you.looked;
  range.min = v.currentStake + 1; range.max = v.maxStake; range.step = 1;
  range.value = Math.min(v.maxStake, v.actions.raiseTo);
  updateRaiseLabel();
  $('raiseModal').classList.remove('hidden');
}
function updateRaiseLabel() {
  const val = parseInt($('raiseRange').value, 10);
  $('raiseValue').textContent = val;
  $('raiseCost').textContent = raiseLooked ? val * 2 : val;
}

// ---------- 工具 ----------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function copyText(t) {
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('已复制：' + t), () => {});
  else toast('请手动复制：' + t);
}

function toast(html, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'toast' + (opts.type ? ' ' + opts.type : '');
  el.innerHTML = `<div>${html}</div>`;
  if (opts.actions) {
    const row = document.createElement('div');
    row.className = 'toast-actions';
    for (const a of opts.actions) {
      const b = document.createElement('button');
      b.className = a.cls || 'ghost'; b.textContent = a.label;
      b.addEventListener('click', () => { a.fn(); el.remove(); });
      row.appendChild(b);
    }
    el.appendChild(row);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.actions ? 12000 : 4000);
}

let flashTimer = null;
function flash(msg) {
  toast('⚠️ ' + escapeHtml(msg));
  if (flashTimer) clearTimeout(flashTimer);
}

// ---------- 绑定 ----------

$('modeSingle').addEventListener('click', () => showScreen('singleSetup'));
$('modeOnline').addEventListener('click', enterLobby);
$('brandHome').addEventListener('click', goHome);
document.querySelectorAll('.back-home').forEach((b) => b.addEventListener('click', goHome));
$('startSingleBtn').addEventListener('click', () => startSingle().catch((e) => flash(e.message)));

$('createRoomBtn').addEventListener('click', openCreateModal);
$('refreshRoomsBtn').addEventListener('click', refreshRooms);
$('joinIdBtn').addEventListener('click', () => enterRoom($('joinIdInput').value, $('joinPwInput').value));
$('createCancel').addEventListener('click', () => $('createModal').classList.add('hidden'));
$('createConfirm').addEventListener('click', createRoom);

$('addFriendBtn').addEventListener('click', () => { $('addFriendError').textContent = ''; $('friendNameInput').value = ''; $('addFriendModal').classList.remove('hidden'); });
$('addFriendCancel').addEventListener('click', () => $('addFriendModal').classList.add('hidden'));
$('addFriendConfirm').addEventListener('click', async () => {
  const r = await postJSON('/zhajinhua/api/friends/request', { username: $('friendNameInput').value.trim() });
  if (r.error) { $('addFriendError').textContent = r.error; return; }
  $('addFriendModal').classList.add('hidden');
  toast(r.mutual ? '已互相成为好友' : '好友申请已发送'); refreshFriends();
});
$('inviteCancel').addEventListener('click', () => $('inviteModal').classList.add('hidden'));

$('compareCancel').addEventListener('click', () => $('compareModal').classList.add('hidden'));
$('raiseCancel').addEventListener('click', () => $('raiseModal').classList.add('hidden'));
$('raiseRange').addEventListener('input', updateRaiseLabel);
$('raiseConfirm').addEventListener('click', () => { $('raiseModal').classList.add('hidden'); doAction('raise', parseInt($('raiseRange').value, 10)); });

$('chatSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

document.querySelectorAll('.auth-tab').forEach((b) => b.addEventListener('click', () => setAuthTab(b.dataset.tab)));
$('authCancel').addEventListener('click', () => $('authModal').classList.add('hidden'));
$('authSubmit').addEventListener('click', submitAuth);
$('authPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

$('soundBtn').textContent = soundOn ? '🔊' : '🔇';
$('soundBtn').addEventListener('click', toggleSound);
$('leaderboardBtn').addEventListener('click', openLeaderboard);
$('leaderboardClose').addEventListener('click', () => $('leaderboardModal').classList.add('hidden'));
$('profileClose').addEventListener('click', () => $('profileModal').classList.add('hidden'));
$('historyClose').addEventListener('click', () => $('historyModal').classList.add('hidden'));
$('roomSearch').addEventListener('input', renderRoomList);
$('roomFilterSel').addEventListener('change', renderRoomList);

window.addEventListener('beforeunload', () => { closeRoomStream(); closeNotify(); });

// PWA：注册 Service Worker（仅缓存静态资源，API/SSE 不拦截）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

loadMe();
