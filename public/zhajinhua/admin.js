'use strict';

/** 炸金花管理后台：管理员可管理所有注册玩家（金币 / 封禁 / 重置密码 / 管理员 / 删号）。 */

const $ = (id) => document.getElementById(id);

let users = [];
let online = new Set();

async function getJSON(p) { const r = await fetch(p); try { return await r.json(); } catch (e) { return { error: '响应异常' }; } }
async function postJSON(p, b) {
  const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  try { return await r.json(); } catch (e) { return { error: '响应异常' }; }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function fmtDate(ts) { if (!ts) return '-'; const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

async function init() {
  const me = await getJSON('/auth/me');
  if (!me.user) { location.href = '/zhajinhua/'; return; }
  $('who').innerHTML = `👤 ${esc(me.user.username)} <a class="link" id="logout">退出</a>`;
  $('logout').addEventListener('click', async () => { await postJSON('/auth/logout', {}); location.href = '/zhajinhua/'; });
  const prof = await getJSON('/zhajinhua/api/profile');
  if (!prof.profile || !prof.profile.isAdmin) { $('denied').classList.remove('hidden'); return; }
  $('panel').classList.remove('hidden');
  refresh();
}

async function refresh() {
  const r = await getJSON('/zhajinhua/api/admin/users');
  if (r.error) { $('denied').classList.remove('hidden'); $('panel').classList.add('hidden'); $('denied').textContent = r.error; return; }
  users = r.users || [];
  online = new Set(r.online || []);
  renderStats(r.stats || {});
  renderRows();
}

function renderStats(s) {
  $('stats').innerHTML = `
    <div class="admin-stat"><b>${s.users || 0}</b><span>注册用户</span></div>
    <div class="admin-stat"><b>${online.size}</b><span>当前在线</span></div>
    <div class="admin-stat"><b>${(s.totalCoins || 0).toLocaleString()}</b><span>金币总量</span></div>
    <div class="admin-stat"><b>${s.banned || 0}</b><span>已封禁</span></div>
    <div class="admin-stat"><b>${s.admins || 0}</b><span>管理员</span></div>`;
}

function renderRows() {
  const q = ($('search').value || '').trim().toLowerCase();
  const list = users.filter((u) => !q || u.username.toLowerCase().includes(q) || String(u.id) === q);
  const tb = $('rows');
  tb.innerHTML = '';
  for (const u of list) {
    const tr = document.createElement('tr');
    if (u.banned) tr.className = 'banned';
    const tags = [];
    if (online.has(u.id)) tags.push('<span class="badge on">在线</span>');
    if (u.admin) tags.push('<span class="badge admin">管理员</span>');
    if (u.banned) tags.push('<span class="badge ban">封禁</span>');
    const st = u.stats || {};
    tr.innerHTML = `
      <td>${u.id}</td>
      <td><span class="uname"><span class="av">${u.avatar || '🙂'}</span>${esc(u.username)}</span></td>
      <td class="coins-cell">🪙 ${(u.coins || 0).toLocaleString()}</td>
      <td>${st.games || 0} / ${st.wins || 0} / ${(st.net || 0) >= 0 ? '+' : ''}${st.net || 0}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td>${tags.join(' ') || '<span class="badge">离线</span>'}</td>
      <td class="row-ops"></td>`;
    const ops = tr.querySelector('.row-ops');
    ops.appendChild(opBtn('💰金币', 'ghost', () => setCoins(u)));
    ops.appendChild(opBtn(u.banned ? '解封' : '封禁', u.banned ? 'ghost' : 'warn', () => act(u.id, u.banned ? 'unban' : 'ban')));
    ops.appendChild(opBtn('🔑密码', 'ghost', () => resetPw(u)));
    ops.appendChild(opBtn(u.admin ? '撤管理' : '设管理', 'ghost', () => act(u.id, 'setAdmin', !u.admin)));
    ops.appendChild(opBtn('🗑删除', 'warn', () => del(u)));
    tb.appendChild(tr);
  }
  if (!list.length) tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">没有匹配的用户</td></tr>';
}

function opBtn(text, cls, fn) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}

async function act(id, action, value) {
  const r = await postJSON('/zhajinhua/api/admin/user', { id, action, value });
  if (r.error) { alert('操作失败：' + r.error); return; }
  refresh();
}

function setCoins(u) {
  const v = prompt(`设置「${u.username}」的金币数量：`, u.coins);
  if (v == null) return;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) { alert('请输入有效的非负整数'); return; }
  act(u.id, 'setCoins', n);
}

function resetPw(u) {
  const pw = prompt(`为「${u.username}」设置新密码（6-64 位）：`);
  if (pw == null) return;
  if (pw.length < 6 || pw.length > 64) { alert('密码长度需为 6-64 位'); return; }
  act(u.id, 'resetPassword', pw);
}

function del(u) {
  if (!confirm(`确定删除用户「${u.username}」(ID ${u.id})？此操作不可恢复。`)) return;
  act(u.id, 'delete');
}

$('refreshBtn').addEventListener('click', refresh);
$('search').addEventListener('input', renderRows);
init();
