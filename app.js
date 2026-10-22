'use strict';
/* =========================================================
 * 财务工作台 —— 纯本地实现（IndexedDB 持久化）
 * 模块：流水记账 / PDF 合成 / 文件库 / 多公司切换
 * ========================================================= */

/* ---------------- 基础工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = n => (Number(n) < 0 ? '-' : '') + '¥' + Math.abs(Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, '0');
const nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const todayLocal = () => nowLocal().slice(0, 10);
const fmtDT = s => (s || '').replace('T', ' ');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const KIND_ICONS = { image: '🖼️', pdf: '📕', video: '🎬', audio: '🎵', text: '📄', other: '📦' };
const KIND_NAMES = { image: '图片', pdf: 'PDF', video: '视频', audio: '音频', text: '文本', other: '其他' };

function fileKind(name, type = '') {
  const t = (type || '').toLowerCase(), n = (name || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('text/') || /\.(txt|md|markdown|json|csv|tsv|log|xml|html?|css|js|ts|yml|yaml|ini|conf)$/.test(n)) return 'text';
  return 'other';
}

function toast(msg, type = 'info') {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2600);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------------- IndexedDB 数据层 ---------------- */
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('fin_workbench_v1', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('companies')) db.createObjectStore('companies', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('accounts')) {
          const acc = db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true });
          acc.createIndex('byCompany', 'companyId');
        }
        if (!db.objectStoreNames.contains('transactions')) {
          const tx = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          tx.createIndex('byCompany', 'companyId');
          tx.createIndex('byAccount', 'accountId');
        }
        if (!db.objectStoreNames.contains('files')) {
          const fl = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
          fl.createIndex('byCategory', 'category');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('parties')) {
          const p = db.createObjectStore('parties', { keyPath: 'id', autoIncrement: true });
          p.createIndex('byCompany', 'companyId');
        }
        if (!db.objectStoreNames.contains('projects')) {
          const pr = db.createObjectStore('projects', { keyPath: 'id', autoIncrement: true });
          pr.createIndex('byCompany', 'companyId');
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error);
    });
  },
  async _store(name, mode) { const db = await this.open(); return db.transaction(name, mode).objectStore(name); },
  _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async add(name, obj) { return this._req((await this._store(name, 'readwrite')).add(obj)); },
  async put(name, obj) { return this._req((await this._store(name, 'readwrite')).put(obj)); },
  async get(name, id) { return this._req((await this._store(name, 'readonly')).get(id)); },
  async del(name, id) { return this._req((await this._store(name, 'readwrite')).delete(id)); },
  async all(name) { return this._req((await this._store(name, 'readonly')).getAll()); },
  async byIndex(name, idx, val) { return this._req((await this._store(name, 'readonly')).index(idx).getAll(val)); },
  async kvGet(key) { const r = await this.get('kv', key); return r ? r.value : null; },
  async kvSet(key, value) { return this.put('kv', { key, value }); },
};

/* ---------------- 应用状态 ---------------- */
const state = {
  view: 'ledger',
  companies: [], accounts: [], txns: [], files: [], parties: [], projects: [],
  currentCompanyId: null,
  currentAccountId: 'all',          // 'all' 或账户 id（字符串）
  dateFrom: '', dateTo: '',          // 流水查账日期范围筛选
  fileFilter: 'all', fileSearch: '',
  pdfItems: [],                     // {uid,name,size,type,kind,blob}
  pdfBlob: null, pdfUrl: null,
  pdfOpts: { pageSize: 'a4p', margin: 0 },
  editingTxnId: null,
  pendingReceipts: [],              // [{id,name}]
  draft: null,                      // 流水表单草稿 {date,type,accountId,amount,partyId,projectId,remark}
};
let _thumbUrls = [];
const thumbUrl = blob => { const u = URL.createObjectURL(blob); _thumbUrls.push(u); return u; };
const releaseThumbs = () => { _thumbUrls.forEach(u => URL.revokeObjectURL(u)); _thumbUrls = []; };

/* ---------------- 数据加载 ---------------- */
async function loadCompanies() { state.companies = await DB.all('companies'); }
async function loadAccounts() {
  state.accounts = (await DB.byIndex('accounts', 'byCompany', state.currentCompanyId)).sort((a, b) => a.id - b.id);
}
async function loadTxns() { state.txns = await DB.byIndex('transactions', 'byCompany', state.currentCompanyId); }
async function loadFiles() { state.files = (await DB.all('files')).sort((a, b) => b.id - a.id); }
async function loadParties() {
  state.parties = (await DB.byIndex('parties', 'byCompany', state.currentCompanyId)).sort((a, b) => a.id - b.id);
}
async function loadProjects() {
  state.projects = (await DB.byIndex('projects', 'byCompany', state.currentCompanyId)).sort((a, b) => a.id - b.id);
}

async function setCurrentCompany(id) {
  if (!state.companies.some(c => c.id === id)) id = state.companies[0]?.id ?? null;
  state.currentCompanyId = id;
  state.currentAccountId = 'all';
  state.editingTxnId = null;
  state.pendingReceipts = [];
  await Promise.all([loadAccounts(), loadTxns(), loadFiles(), loadParties(), loadProjects()]);
  await DB.kvSet('currentCompanyId', id);
}

function computeTotals(list) {
  let income = 0, expense = 0;
  for (const t of list) { if (t.type === 'income') income += t.amount; else expense += t.amount; }
  return { income, expense, balance: income - expense };
}

/* ---------------- 模态框 ---------------- */
function openModal({ title, body, wide = false, onClose = null }) {
  const root = $('#modalRoot');
  const wrap = document.createElement('div');
  wrap.className = 'modal-mask';
  wrap.innerHTML = `<div class="modal${wide ? ' wide' : ''}"><div class="modal-head"><div class="modal-title">${escapeHtml(title)}</div><button type="button" class="modal-close" data-modal-close>✕</button></div><div class="modal-body"></div></div>`;
  const bodyEl = $('.modal-body', wrap);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  root.appendChild(wrap);
  const close = () => { wrap.remove(); if (onClose) onClose(); };
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-modal-close]')) close(); });
  return { close, root: wrap };
}

function confirmModal(title, message, okText = '删除') {
  return new Promise(resolve => {
    const m = openModal({ title, body: `<p class="confirm-msg">${escapeHtml(message)}</p>` });
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'btn danger'; ok.textContent = okText;
    footer.append(cancel, ok);
    $('.modal', m.root).appendChild(footer);
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    cancel.onclick = () => finish(false);
    ok.onclick = () => finish(true);
    m.root.addEventListener('click', e => { if (e.target === m.root) finish(false); });
  });
}

function promptModal(title, label, defaultValue = '') {
  return new Promise(resolve => {
    const m = openModal({
      title,
      body: `<label class="field"><span>${escapeHtml(label)}</span><input class="prompt-input" id="promptInput" value="${escapeHtml(defaultValue)}"></label>`,
    });
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancel = document.createElement('button');
    cancel.className = 'btn'; cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'btn primary'; ok.textContent = '确定';
    footer.append(cancel, ok);
    $('.modal', m.root).appendChild(footer);
    const input = $('#promptInput', m.root);
    input.focus(); input.select();
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    cancel.onclick = () => finish(null);
    ok.onclick = () => finish(input.value.trim() || null);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
    m.root.addEventListener('click', e => { if (e.target === m.root) finish(null); });
  });
}

/* ---------------- 视图：流水记账 ---------------- */
function txnRowHtml(t) {
  const receiptBtn = (t.receipts && t.receipts.length)
    ? `<button type="button" class="receipt-btn" data-action="preview-receipt" data-id="${t.id}" title="查看单据">🧾 ${t.receipts.length}</button>` : '';
  const proj = t.projectName || '—';
  return `<div class="txn-row">
    <div class="txn-date">${escapeHtml((t.datetime || '').slice(0, 10))}</div>
    <span class="badge ${t.type}">${t.type === 'income' ? '收入' : '支出'}</span>
    <div class="txn-amount ${t.type}">${t.type === 'income' ? '+' : '-'}${fmtMoney(t.amount)}</div>
    <div class="txn-party" title="${escapeHtml(t.counterparty || '')}">${escapeHtml(t.counterparty || '—')}</div>
    <div class="txn-project" title="${escapeHtml(proj)}">${escapeHtml(proj)}</div>
    <div class="txn-remark" title="${escapeHtml(t.remark || '')}">${escapeHtml(t.remark || '—')}</div>
    <div>${receiptBtn}</div>
    <div class="txn-ops">
      <button type="button" class="icon-btn" data-action="edit-txn" data-id="${t.id}" title="编辑">✏️</button>
      <button type="button" class="icon-btn danger" data-action="delete-txn" data-id="${t.id}" title="删除">🗑</button>
    </div>
  </div>`;
}

function txnRowReadonlyHtml(t) {
  const receiptBtn = (t.receipts && t.receipts.length)
    ? `<button type="button" class="receipt-btn" data-action="preview-receipt" data-id="${t.id}" title="查看单据">🧾 ${t.receipts.length}</button>` : '';
  const proj = t.projectName || '—';
  return `<div class="txn-row">
    <div class="txn-date">${escapeHtml((t.datetime || '').slice(0, 10))}</div>
    <span class="badge ${t.type}">${t.type === 'income' ? '收入' : '支出'}</span>
    <div class="txn-amount ${t.type}">${t.type === 'income' ? '+' : '-'}${fmtMoney(t.amount)}</div>
    <div class="txn-party" title="${escapeHtml(t.counterparty || '')}">${escapeHtml(t.counterparty || '—')}</div>
    <div class="txn-project" title="${escapeHtml(proj)}">${escapeHtml(proj)}</div>
    <div class="txn-remark" title="${escapeHtml(t.remark || '')}">${escapeHtml(t.remark || '—')}</div>
    <div>${receiptBtn}</div>
    <div></div>
  </div>`;
}

function fillPartySelect() {
  const sel = $('#fParty');
  if (!sel) return;
  const type = ($('input[name="fType"]:checked') || {}).value || 'expense';
  const ptype = type === 'income' ? 'customer' : 'supplier';
  const list = state.parties.filter(p => p.type === ptype);
  sel.innerHTML = '<option value="">— 选择交易对象 —</option>' + list.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  // 优先回填草稿，其次编辑记录
  let selId = null;
  if (!state.editingTxnId && state.draft && state.draft.partyId) selId = state.draft.partyId;
  else if (state.editingTxnId) {
    const editing = state.txns.find(t => t.id === state.editingTxnId);
    if (editing) {
      if (editing.partyId && list.some(p => p.id === editing.partyId)) selId = editing.partyId;
      else if (editing.counterparty) {
        const m = list.find(p => p.name === editing.counterparty);
        if (m) selId = m.id;
      }
    }
  }
  if (selId != null && list.some(p => p.id === selId)) sel.value = selId;
}

function ledgerHtml() {
  let viewTxns = state.currentAccountId === 'all' ? state.txns : state.txns.filter(t => t.accountId === Number(state.currentAccountId));
  if (state.dateFrom) viewTxns = viewTxns.filter(t => (t.datetime || '').slice(0, 10) >= state.dateFrom);
  if (state.dateTo) viewTxns = viewTxns.filter(t => (t.datetime || '').slice(0, 10) <= state.dateTo);
  const vt = computeTotals(viewTxns);
  const sorted = [...viewTxns].sort((a, b) => (b.datetime || '').localeCompare(a.datetime || '') || (b.createdAt || 0) - (a.createdAt || 0));
  const editing = state.editingTxnId ? state.txns.find(t => t.id === state.editingTxnId) : null;
  let scopeName = state.currentAccountId === 'all'
    ? `全部账户（${state.accounts.length} 个）`
    : (state.accounts.find(a => a.id === Number(state.currentAccountId))?.name || '');
  if (state.dateFrom || state.dateTo) scopeName += ` · ${state.dateFrom || '…'} ~ ${state.dateTo || '…'}`;
  const accOptions = `<option value="all" ${state.currentAccountId === 'all' ? 'selected' : ''}>📊 全部账户</option>` +
    state.accounts.map(a => `<option value="${a.id}" ${String(a.id) === state.currentAccountId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');

  const statsHtml = `<div class="stats-row">
    <div class="stat-card"><div class="stat-label">收入合计</div><div class="stat-value in">${fmtMoney(vt.income)}</div></div>
    <div class="stat-card"><div class="stat-label">支出合计</div><div class="stat-value out">${fmtMoney(vt.expense)}</div></div>
    <div class="stat-card"><div class="stat-label">结余</div><div class="stat-value ${vt.balance < 0 ? 'out' : 'in'}">${fmtMoney(vt.balance)}</div></div>
    <div class="stat-card"><div class="stat-label">当前范围</div><div class="stat-value small">${escapeHtml(scopeName)} · ${viewTxns.length} 笔</div></div>
  </div>`;

  const draft = (!editing && state.draft) ? state.draft : null;
  const dType = draft ? draft.type : 'expense';
  const formHtml = state.accounts.length ? `
  <form id="txnForm" class="card txn-form" autocomplete="off">
    <div class="form-title">${editing ? '✏️ 编辑流水' : '➕ 记一笔'}</div>
    <div class="form-grid">
      <label class="field"><span>日期（手动输入 YYYY-MM-DD）</span><input type="text" id="fDate" required inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" value="${editing ? (editing.datetime || todayLocal()).slice(0, 10) : (draft && draft.date ? draft.date : todayLocal())}"></label>
      <div class="field"><span>类型（支出→供应商 / 收入→客户）</span>
        <div class="segmented">
          <label class="seg${(editing ? editing.type : dType) === 'expense' ? ' on' : ''}"><input type="radio" name="fType" value="expense" ${(editing ? editing.type : dType) === 'expense' ? 'checked' : ''}>支出</label>
          <label class="seg${(editing ? editing.type : dType) === 'income' ? ' on' : ''}"><input type="radio" name="fType" value="income" ${(editing ? editing.type : dType) === 'income' ? 'checked' : ''}>收入</label>
        </div>
      </div>
      <label class="field"><span>账户</span>
        <select id="fAccount">${state.accounts.map(a => {
          const sel = editing ? (editing.accountId === a.id)
            : draft && draft.accountId ? (draft.accountId === a.id)
            : (state.currentAccountId === String(a.id));
          return `<option value="${a.id}" ${sel ? 'selected' : ''}>${escapeHtml(a.name)}</option>`;
        }).join('')}</select>
      </label>
      <label class="field"><span>项目（可选）</span>
        <div class="party-select-wrap">
          <select id="fProject">
            <option value="">未关联项目</option>
            ${state.projects.map(p => `<option value="${p.id}" ${(editing ? editing.projectId === p.id : (draft && draft.projectId === p.id)) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
          </select>
          <button type="button" class="mini-btn party-add" data-action="quick-add-project" title="新增项目">＋</button>
        </div>
      </label>
      <label class="field"><span>金额</span><input type="number" id="fAmount" step="0.01" min="0.01" required placeholder="0.00" value="${editing ? editing.amount : (draft && draft.amount != null ? draft.amount : '')}"></label>
      <label class="field"><span>交易对象（按类型自动关联）</span>
        <div class="party-select-wrap">
          <select id="fParty"></select>
          <button type="button" class="mini-btn party-add" data-action="quick-add-party" title="新增交易对象">＋</button>
        </div>
      </label>
      <label class="field span2"><span>备注</span><input id="fRemark" placeholder="选填" value="${escapeHtml(editing ? editing.remark || '' : (draft && draft.remark ? draft.remark : ''))}"></label>
      <div class="field span2">
        <span>单据（可直接拖入，或点击上传）</span>
        <div class="receipt-drop" id="receiptDrop">📎 拖入票据文件，或点击此处上传</div>
        <input type="file" id="receiptInput" multiple hidden>
        <div class="receipt-chips">${state.pendingReceipts.map((r, i) => `<span class="chip"><span>🧾 ${escapeHtml(r.name)}</span><button type="button" class="chip-x" data-action="remove-receipt" data-i="${i}" title="移除">×</button></span>`).join('')}</div>
      </div>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn primary">${editing ? '保存修改' : '保存记录'}</button>
      ${editing ? '<button type="button" class="btn" data-action="cancel-edit">取消编辑</button>' : ''}
      <button type="button" class="btn ghost" data-action="export-csv">⬇ 导出 CSV</button>
    </div>
  </form>` : `<div class="card empty-tip">当前公司还没有账户，请先到「账户」页添加。
    <div style="margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button type="button" class="btn primary" data-action="switch-accounts">前往账户页</button>
    </div></div>`;

  const listHtml = sorted.length
    ? `<div class="card txn-list">${sorted.map(txnRowHtml).join('')}</div>`
    : `<div class="card empty-tip">暂无流水记录，先在上面记一笔吧。</div>`;

  return `<div class="ledger-single">
    <div class="card scope-bar">
      <label class="field inline"><span>查看账户</span><select id="scopeAccount">${accOptions}</select></label>
      <div class="date-range">
        <label class="field inline"><span>起始日期</span><input type="date" id="fDateFrom" value="${state.dateFrom || ''}"></label>
        <label class="field inline"><span>截止日期</span><input type="date" id="fDateTo" value="${state.dateTo || ''}"></label>
        ${(state.dateFrom || state.dateTo) ? '<button type="button" class="btn ghost" data-action="clear-date-range">清除日期</button>' : ''}
      </div>
      <button type="button" class="btn ghost" data-action="view-scope-txns">🔍 查看当前范围明细</button>
      <span class="scope-hint">在「账户」页可单独查看每个账户的流水与核算</span>
    </div>
    ${statsHtml}
    ${formHtml}
    ${listHtml}
  </div>`;
}

function captureDraft() {
  if (state.editingTxnId) return; // 编辑态从记录回填，不覆盖
  const dateEl = $('#fDate'), typeEl = $('input[name="fType"]:checked');
  const accEl = $('#fAccount'), amtEl = $('#fAmount'), partyEl = $('#fParty'), projEl = $('#fProject'), remEl = $('#fRemark');
  // 保留上一次的交易对象/项目：仅当当前下拉有有效选择时才覆盖，
  // 这样收支切换因类型不匹配而清空下拉时，原选择不会丢失，切换回匹配类型可自动恢复。
  let partyId = state.draft ? state.draft.partyId : null;
  if (partyEl && partyEl.value) partyId = Number(partyEl.value);
  let projectId = state.draft ? state.draft.projectId : null;
  if (projEl && projEl.value) projectId = Number(projEl.value);
  state.draft = {
    date: dateEl && dateEl.value ? dateEl.value : todayLocal(),
    type: typeEl ? typeEl.value : 'expense',
    accountId: accEl && accEl.value ? Number(accEl.value) : null,
    amount: amtEl ? amtEl.value : '',
    partyId,
    projectId,
    remark: remEl ? remEl.value : '',
  };
}

function bindLedgerForm() {
  const form = $('#txnForm');
  if (!form) return;
  form.addEventListener('submit', onTxnSubmit);
  // 任意字段变化即存入草稿，避免切换视图后丢失
  ['input', 'change'].forEach(ev => form.addEventListener(ev, () => { if (ev === 'change' || ev === 'input') captureDraft(); }));
  $$('input[name="fType"]').forEach(r => r.addEventListener('change', () => {
    $$('.seg').forEach(s => s.classList.remove('on'));
    if (r.closest('.seg')) r.closest('.seg').classList.add('on');
    captureDraft();
    fillPartySelect();
  }));
  fillPartySelect();
  const scope = $('#scopeAccount');
  if (scope) scope.addEventListener('change', async () => {
    state.currentAccountId = scope.value;
    await DB.kvSet('currentAccountId', scope.value);
    renderMain();
  });
  const df = $('#fDateFrom'), dt = $('#fDateTo');
  if (df) df.addEventListener('change', () => { state.dateFrom = df.value; renderMain(); });
  if (dt) dt.addEventListener('change', () => { state.dateTo = dt.value; renderMain(); });
  const drop = $('#receiptDrop'), input = $('#receiptInput');
  if (drop && input) {
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => { await addReceiptFiles([...input.files]); input.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('drag-over'); }));
    drop.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag-over'); });
    drop.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag-over');
      await addReceiptFiles([...e.dataTransfer.files]);
    });
  }
}

async function addReceiptFiles(files) {
  if (!files || !files.length) return;
  for (const f of files) {
    const id = await DB.add('files', { name: f.name, type: f.type || '', size: f.size, blob: f, category: 'receipt', createdAt: Date.now() });
    state.pendingReceipts.push({ id, name: f.name });
  }
  await loadFiles();
  renderMain();
  toast(`已添加 ${files.length} 个单据`);
}

async function onTxnSubmit(e) {
  e.preventDefault();
  if (!state.accounts.length) return toast('请先添加账户', 'error');
  const date = $('#fDate').value;
  const typeEl = $('input[name="fType"]:checked');
  const type = typeEl ? typeEl.value : 'expense';
  const amount = Number($('#fAmount').value);
  const accountId = Number($('#fAccount').value);
  const partySel = $('#fParty');
  const partyId = partySel.value ? Number(partySel.value) : null;
  const party = partyId ? state.parties.find(p => p.id === partyId) : null;
  const counterparty = party ? party.name : (partySel.selectedOptions[0] ? partySel.selectedOptions[0].textContent.trim() : '');
  const projectSel = $('#fProject');
  const projectId = projectSel.value ? Number(projectSel.value) : null;
  const project = projectId ? state.projects.find(p => p.id === projectId) : null;
  const projectName = project ? project.name : '';
  const remark = $('#fRemark').value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('请输入有效日期（格式 YYYY-MM-DD）', 'error');
  if (isNaN(new Date(date + 'T00:00:00').getTime())) return toast('请输入有效日期（格式 YYYY-MM-DD）', 'error');
  if (!(amount > 0)) return toast('请输入有效金额', 'error');
  const rec = {
    companyId: state.currentCompanyId,
    accountId,
    datetime: date,
    type, amount,
    counterparty,
    partyId: partyId || null,
    projectId: projectId || null,
    projectName,
    remark,
    receipts: state.pendingReceipts.map(r => ({ id: r.id, name: r.name })),
  };
  if (state.editingTxnId) {
    const old = state.txns.find(t => t.id === state.editingTxnId);
    const keep = new Set(rec.receipts.map(r => r.id));
    for (const r of (old && old.receipts) || []) if (!keep.has(r.id)) await DB.del('files', r.id);
    rec.id = state.editingTxnId;
    rec.createdAt = (old && old.createdAt) || Date.now();
    await DB.put('transactions', rec);
    toast('已保存修改');
  } else {
    rec.createdAt = Date.now();
    await DB.add('transactions', rec);
    toast('已保存记录');
  }
  state.editingTxnId = null;
  state.pendingReceipts = [];
  state.draft = null;
  await Promise.all([loadTxns(), loadFiles()]);
  renderMain();
}

/* ---------------- 视图：账户（独立页） ---------------- */
function accountsViewHtml() {
  const total = computeTotals(state.txns);
  const cards = state.accounts.map(a => {
    const t = computeTotals(state.txns.filter(x => x.accountId === a.id));
    return `<div class="card party-card">
      <div class="pc-head">
        <button type="button" class="pc-name-btn" data-action="view-account-txns" data-id="${a.id}" title="点击查看该账户流水">${escapeHtml(a.name)}</button>
        <span class="pc-ops">
          <button type="button" class="icon-btn" data-action="edit-account" data-id="${a.id}" title="重命名">✏️</button>
          <button type="button" class="icon-btn danger" data-action="delete-account" data-id="${a.id}" title="删除账户">🗑</button>
        </span>
      </div>
      <div class="pc-nums">
        <span class="num in">收 ${fmtMoney(t.income)}</span>
        <span class="num out">支 ${fmtMoney(t.expense)}</span>
        <span class="num bal">余 ${fmtMoney(t.balance)}</span>
      </div>
      <div class="pc-actions">
        <span class="pc-meta">💧 ${state.txns.filter(x => x.accountId === a.id).length} 笔流水 · 点击账户名查看</span>
      </div>
    </div>`;
  }).join('');
  return `<div class="mgmt-view">
    <div class="card">
      <div class="panel-title">账户管理
        <span>
          <button type="button" class="mini-btn" data-action="add-account">＋ 添加</button>
          <button type="button" class="mini-btn" data-action="quick-add-accounts">快速添加常用</button>
        </span>
      </div>
      <div class="mgmt-grid">
        ${cards}
        <div class="card party-card add-card" data-action="add-account"><div class="add-plus">＋</div><div>新增账户</div></div>
      </div>
      <div class="totals-foot">全公司合计 · 收入 ${fmtMoney(total.income)} · 支出 ${fmtMoney(total.expense)} · 结余 ${fmtMoney(total.balance)}</div>
    </div>
  </div>`;
}

/* ---------------- 视图：供应商 / 客户 ---------------- */
function partyBalance(p) {
  // 供应商 → 应付（支出合计）；客户 → 应收（收入合计）
  const txs = state.txns.filter(t => t.partyId === p.id);
  const kind = p.type === 'supplier' ? 'expense' : 'income';
  let amount = 0, count = 0;
  for (const t of txs) if (t.type === kind) { amount += Number(t.amount) || 0; count++; }
  return { amount, count };
}

function projectBalance(p) {
  // 项目关联余额：收入 / 支出 / 结余
  const txs = state.txns.filter(t => t.projectId === p.id);
  let income = 0, expense = 0, count = 0;
  for (const t of txs) {
    const amt = Number(t.amount) || 0;
    if (t.type === 'income') income += amt; else expense += amt;
    count++;
  }
  return { income, expense, balance: income - expense, count };
}

function partiesViewHtml() {
  const suppliers = state.parties.filter(p => p.type === 'supplier');
  const customers = state.parties.filter(p => p.type === 'customer');
  const block = (title, type, list) => {
    const label = type === 'supplier' ? '应付' : '应收';
    const cls = type === 'supplier' ? 'out' : 'in';
    const total = list.reduce((s, p) => s + partyBalance(p).amount, 0);
    return `<div class="card">
    <div class="panel-title">${title}<button type="button" class="mini-btn" data-action="add-party" data-ptype="${type}">＋ 新增</button></div>
    ${list.length ? `<div class="party-list">${list.map(p => {
      const b = partyBalance(p);
      return `<div class="party-row">
        <div class="pr-main">
          <button type="button" class="pr-name-btn" data-action="view-party-txns" data-id="${p.id}" title="查看流水明细">${escapeHtml(p.name)}</button>
          ${p.contact ? `<div class="pr-sub">联系人：${escapeHtml(p.contact)}</div>` : ''}
          ${p.note ? `<div class="pr-sub">${escapeHtml(p.note)}</div>` : ''}
          <div class="pr-sub"><b class="bal-${cls}">${label} ${fmtMoney(b.amount)}</b> · ${b.count} 笔</div>
        </div>
        <div class="pr-ops">
          <button type="button" class="icon-btn" data-action="edit-party" data-id="${p.id}" title="编辑">✏️</button>
          <button type="button" class="icon-btn danger" data-action="delete-party" data-id="${p.id}" title="删除">🗑</button>
        </div>
      </div>`;
    }).join('')}</div>
    <div class="totals-foot">${title}合计 · ${label} <b class="bal-${cls}">${fmtMoney(total)}</b></div>`
    : '<div class="empty-tip small">还没有记录</div>'}
  </div>`;
  };
  return `<div class="mgmt-view two-col">
    ${block('🏭 供应商', 'supplier', suppliers)}
    ${block('🤝 客户', 'customer', customers)}
  </div>`;
}

async function openPartyModal(type, existing) {
  const isEdit = !!existing;
  const m = openModal({
    title: (isEdit ? '编辑' : '新增') + (type === 'supplier' ? '供应商' : '客户'),
    body: `<form id="partyForm" class="modal-form">
      <label class="field"><span>名称 *</span><input id="pmName" required value="${escapeHtml(existing ? existing.name : '')}" placeholder="如：XX 材料商"></label>
      <label class="field"><span>联系人</span><input id="pmContact" value="${escapeHtml(existing ? (existing.contact || '') : '')}" placeholder="选填"></label>
      <label class="field"><span>备注</span><input id="pmNote" value="${escapeHtml(existing ? (existing.note || '') : '')}" placeholder="选填"></label>
    </form>`
  });
  const footer = document.createElement('div'); footer.className = 'modal-footer';
  const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = '取消';
  const ok = document.createElement('button'); ok.className = 'btn primary'; ok.textContent = isEdit ? '保存' : '创建';
  footer.append(cancel, ok);
  $('.modal', m.root).appendChild(footer);
  const form = $('#partyForm', m.root);
  $('#pmName', m.root).focus();
  cancel.onclick = () => m.close();
  const submit = async () => {
    const name = $('#pmName', m.root).value.trim();
    if (!name) { toast('请输入名称', 'error'); return; }
    const rec = { name, contact: $('#pmContact', m.root).value.trim(), note: $('#pmNote', m.root).value.trim(), type, companyId: state.currentCompanyId };
    if (isEdit) { rec.id = existing.id; await DB.put('parties', rec); }
    else { rec.createdAt = Date.now(); await DB.add('parties', rec); }
    await loadParties();
    renderMain();
    m.close();
    toast(isEdit ? '已保存' : '已创建');
  };
  ok.onclick = submit;
  form.addEventListener('submit', e => { e.preventDefault(); submit(); });
}

/* ---------------- 视图：项目 ---------------- */
function projectsViewHtml() {
  const cards = state.projects.map(p => {
    const b = projectBalance(p);
    return `<div class="card party-card">
    <div class="pc-head">
      <button type="button" class="pc-name-btn" data-action="view-project-txns" data-id="${p.id}" title="查看流水明细">${escapeHtml(p.name)}</button>
      <span class="pc-ops">
        <button type="button" class="icon-btn" data-action="edit-project" data-id="${p.id}" title="编辑">✏️</button>
        <button type="button" class="icon-btn danger" data-action="delete-project" data-id="${p.id}" title="删除项目">🗑</button>
      </span>
    </div>
    ${p.code ? `<div class="pr-sub">编号：${escapeHtml(p.code)}</div>` : ''}
    ${p.note ? `<div class="pr-sub">${escapeHtml(p.note)}</div>` : ''}
    <div class="pc-nums">
      <span class="num in">收 ${fmtMoney(b.income)}</span>
      <span class="num out">支 ${fmtMoney(b.expense)}</span>
      <span class="num bal">余 ${fmtMoney(b.balance)}</span>
    </div>
  </div>`;
  }).join('');
  return `<div class="mgmt-view">
    <div class="card">
      <div class="panel-title">项目管理<button type="button" class="mini-btn" data-action="add-project">＋ 新增项目</button></div>
      <div class="mgmt-grid">
        ${cards}
        <div class="card party-card add-card" data-action="add-project"><div class="add-plus">＋</div><div>新增项目</div></div>
      </div>
    </div>
  </div>`;
}

async function openProjectModal(existing) {
  const isEdit = !!existing;
  const m = openModal({
    title: isEdit ? '编辑项目' : '新增项目',
    body: `<form id="projForm" class="modal-form">
      <label class="field"><span>项目名称 *</span><input id="pjName" required value="${escapeHtml(existing ? existing.name : '')}" placeholder="如：XX 标段"></label>
      <label class="field"><span>编号</span><input id="pjCode" value="${escapeHtml(existing ? (existing.code || '') : '')}" placeholder="选填"></label>
      <label class="field"><span>备注</span><input id="pjNote" value="${escapeHtml(existing ? (existing.note || '') : '')}" placeholder="选填"></label>
    </form>`
  });
  const footer = document.createElement('div'); footer.className = 'modal-footer';
  const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = '取消';
  const ok = document.createElement('button'); ok.className = 'btn primary'; ok.textContent = isEdit ? '保存' : '创建';
  footer.append(cancel, ok);
  $('.modal', m.root).appendChild(footer);
  const form = $('#projForm', m.root);
  $('#pjName', m.root).focus();
  cancel.onclick = () => m.close();
  const submit = async () => {
    const name = $('#pjName', m.root).value.trim();
    if (!name) { toast('请输入项目名称', 'error'); return; }
    const rec = { name, code: $('#pjCode', m.root).value.trim(), note: $('#pjNote', m.root).value.trim(), companyId: state.currentCompanyId };
    if (isEdit) { rec.id = existing.id; await DB.put('projects', rec); }
    else { rec.createdAt = Date.now(); await DB.add('projects', rec); }
    await loadProjects();
    renderMain();
    m.close();
    toast(isEdit ? '已保存' : '已创建');
  };
  ok.onclick = submit;
  form.addEventListener('submit', e => { e.preventDefault(); submit(); });
}

/* ---------------- 视图：PDF 合成 ---------------- */
const buildPdfDebounced = debounce(() => buildPdf(false), 500);

function pdfHtml() {
  const items = state.pdfItems;
  const list = items.map((it, i) => `<div class="pdf-item">
    <div class="pdf-item-thumb">${it.kind === 'image' ? `<img src="${thumbUrl(it.blob)}" alt="">` : '<span class="pdf-badge">PDF</span>'}</div>
    <div class="pdf-item-info">
      <div class="pdf-item-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
      <div class="pdf-item-meta">${KIND_NAMES[it.kind]} · ${(it.size / 1024).toFixed(0)} KB</div>
    </div>
    <div class="pdf-item-ops">
      <button type="button" class="icon-btn" data-action="pdf-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
      <button type="button" class="icon-btn" data-action="pdf-down" data-i="${i}" ${i === items.length - 1 ? 'disabled' : ''} title="下移">↓</button>
      <button type="button" class="icon-btn danger" data-action="pdf-remove" data-i="${i}" title="移除">✕</button>
    </div>
  </div>`).join('');

  const controls = items.length ? `<div class="card pdf-controls">
    <label class="field inline"><span>页面大小</span>
      <select id="pdfPageSize">
        <option value="a4p" ${state.pdfOpts.pageSize === 'a4p' ? 'selected' : ''}>A4 纵向</option>
        <option value="a4l" ${state.pdfOpts.pageSize === 'a4l' ? 'selected' : ''}>A4 横向</option>
        <option value="fit" ${state.pdfOpts.pageSize === 'fit' ? 'selected' : ''}>适应图片尺寸</option>
      </select>
    </label>
    <label class="field inline"><span>边距 (mm)</span><input type="number" id="pdfMargin" min="0" max="50" step="1" value="${state.pdfOpts.margin}" style="width:76px"></label>
    <button type="button" class="btn primary" data-action="build-pdf">重新生成</button>
    <button type="button" class="btn" data-action="download-pdf" ${state.pdfBlob ? '' : 'disabled'}>⬇ 下载 PDF</button>
    <button type="button" class="btn" data-action="print-pdf" ${state.pdfBlob ? '' : 'disabled'}>🖨 打印</button>
    <button type="button" class="btn" data-action="save-pdf-to-library" ${state.pdfBlob ? '' : 'disabled'}>保存到文件库</button>
    <button type="button" class="btn ghost" data-action="clear-pdf">清空</button>
    <span class="pdf-status" id="pdfStatus"></span>
  </div>` : '';

  return `<div class="pdf-view">
    <div class="card pdf-drop" id="pdfDrop">
      <div class="pdf-drop-icon">📄</div>
      <div class="pdf-drop-title">把照片或 PDF 拖到这里，自动合成</div>
      <div class="pdf-drop-sub">支持 JPG / PNG / WEBP 等图片与 PDF，可混合拖入，自动合并为一个 PDF</div>
      <div class="pdf-drop-actions">
        <button type="button" class="btn" id="pdfPickBtn">选择文件</button>
        <button type="button" class="btn" data-action="add-from-library">从文件库添加</button>
      </div>
      <input type="file" id="pdfInput" multiple accept="image/*,application/pdf" hidden>
    </div>
    ${items.length ? `<div class="card pdf-items">${list}</div>` : ''}
    ${controls}
    ${items.length ? `<div class="card pdf-preview"><iframe id="pdfPreview" title="PDF 预览" src="${state.pdfUrl || ''}"></iframe></div>` : ''}
  </div>`;
}

function bindPdfView() {
  const drop = $('#pdfDrop'), input = $('#pdfInput');
  if (drop && input) {
    $('#pdfPickBtn').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => { await addPdfFiles([...input.files]); input.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('drag-over'); }));
    drop.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag-over'); });
    drop.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag-over');
      await addPdfFiles([...e.dataTransfer.files]);
    });
  }
  $('#pdfPageSize')?.addEventListener('change', e => { state.pdfOpts.pageSize = e.target.value; buildPdfDebounced(); });
  $('#pdfMargin')?.addEventListener('change', e => { state.pdfOpts.margin = Math.max(0, Number(e.target.value) || 0); buildPdfDebounced(); });
  if (state.pdfItems.length && !state.pdfBlob) buildPdfDebounced();
}

async function addPdfFiles(files) {
  let added = 0, skipped = 0;
  for (const f of files || []) {
    const k = fileKind(f.name, f.type);
    if (k === 'image' || k === 'pdf') {
      state.pdfItems.push({ uid: uid(), name: f.name, size: f.size, type: f.type || '', kind: k, blob: f });
      added++;
    } else skipped++;
  }
  if (skipped) toast(`${skipped} 个文件不是图片 / PDF，已忽略`, 'error');
  if (added) { state.pdfBlob = null; renderMain(); buildPdfDebounced(); }
}

async function toPngBytes(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? b.arrayBuffer().then(resolve) : reject(new Error('图片转换失败')), 'image/png');
  });
}

async function buildPdf(manual = false) {
  const statusEl = $('#pdfStatus');
  if (!state.pdfItems.length) {
    state.pdfBlob = null;
    if (statusEl) statusEl.textContent = '';
    return;
  }
  if (statusEl) statusEl.textContent = '正在合成…';
  try {
    const { PDFDocument, rgb } = PDFLib;
    const out = await PDFDocument.create();
    const { pageSize, margin } = state.pdfOpts;
    const m = Math.max(0, margin) / 25.4 * 72;
    for (const item of state.pdfItems) {
      if (item.kind === 'pdf') {
        const src = await PDFDocument.load(await item.blob.arrayBuffer());
        const pages = await out.copyPages(src, src.getPageIndices());
        for (const p of pages) out.addPage(p);
      } else {
        const bytes = new Uint8Array(await item.blob.arrayBuffer());
        let img;
        if (item.type === 'image/png') img = await out.embedPng(bytes);
        else if (item.type === 'image/jpeg' || item.type === 'image/jpg') img = await out.embedJpg(bytes);
        else img = await out.embedPng(await toPngBytes(item.blob));
        let pw, ph;
        if (pageSize === 'fit') { pw = img.width; ph = img.height; }
        else {
          const A4W = 595.28, A4H = 841.89;
          if (pageSize === 'a4l') { pw = A4H; ph = A4W; } else { pw = A4W; ph = A4H; }
        }
        const page = out.addPage([pw, ph]);
        if (pageSize !== 'fit') page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: rgb(1, 1, 1) });
        const availW = Math.max(20, pw - 2 * m), availH = Math.max(20, ph - 2 * m);
        const scale = Math.min(availW / img.width, availH / img.height);
        const w = img.width * scale, h = img.height * scale;
        page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
    }
    const bytes = await out.save();
    state.pdfBlob = new Blob([bytes], { type: 'application/pdf' });
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = URL.createObjectURL(state.pdfBlob);
    const frame = $('#pdfPreview');
    if (frame) frame.src = state.pdfUrl;
    if (statusEl) statusEl.textContent = `✅ 已合成 ${out.getPageCount()} 页 · ${(state.pdfBlob.size / 1024).toFixed(0)} KB`;
    if (manual) toast(`PDF 已生成（${out.getPageCount()} 页），可下载或保存到文件库`);
    // 合成成功后刷新下载 / 打印 / 保存按钮的可用状态（按钮在初次渲染时为禁用）
    $$('[data-action="download-pdf"]').forEach(b => b.disabled = false);
    $$('[data-action="print-pdf"]').forEach(b => b.disabled = false);
    $$('[data-action="save-pdf-to-library"]').forEach(b => b.disabled = false);
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = '';
    toast('合成失败：' + (err && err.message ? err.message : err), 'error');
  }
}

function printPdf() {
  if (!state.pdfBlob) return toast('请先合成 PDF', 'error');
  const w = window.open(state.pdfUrl, '_blank');
  if (!w) { toast('打印窗口被浏览器拦截，请允许弹出窗口后重试', 'error'); return; }
  w.addEventListener('load', () => { setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 400); });
}

// 往来方 / 项目 / 账户 流水明细弹窗（带日期区间筛选）
function openDetailModal({ title, summary, list, csvType, scope }) {
  const sorted = [...list].sort((a, b) => (b.datetime || '').localeCompare(a.datetime || '') || (b.createdAt || 0) - (a.createdAt || 0));
  const m = openModal({ title, wide: true });
  const bodyEl = $('.modal-body', m.root);
  bodyEl.innerHTML = `<div class="party-txn-summary">${summary}</div>
    <div class="detail-filter">
      <label class="field inline"><span>起始日期</span><input type="date" id="detailFrom"></label>
      <label class="field inline"><span>截止日期</span><input type="date" id="detailTo"></label>
      <span class="detail-count" id="detailCount"></span>
    </div>
    <div class="detail-actions"><button type="button" class="btn primary" data-action="export-detail-csv" data-ptype="${csvType}" data-scope="${scope}">⬇ 按区间导出 CSV</button></div>
    <div class="card txn-list" id="detailList"></div>`;
  const fromEl = $('#detailFrom', m.root), toEl = $('#detailTo', m.root);
  const countEl = $('#detailCount', m.root), listEl = $('#detailList', m.root);
  function renderFiltered() {
    const from = fromEl.value || '', to = toEl.value || '';
    const filtered = sorted.filter(t => {
      const d = (t.datetime || '').slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    listEl.innerHTML = filtered.length ? filtered.map(txnRowReadonlyHtml).join('') : '<div class="empty-tip">该区间内没有流水</div>';
    countEl.textContent = `共 ${filtered.length} 笔${from || to ? '（已按日期区间筛选）' : ''}`;
  }
  fromEl.addEventListener('change', renderFiltered);
  toEl.addEventListener('change', renderFiltered);
  renderFiltered();
}

/* ---------------- 视图：文件库 ---------------- */
function filesHtml() {
  const filters = [['all', '全部'], ['receipt', '票据'], ['image', '图片'], ['pdf', 'PDF'], ['video', '视频'], ['audio', '音频'], ['text', '文本'], ['other', '其他']];
  let list = state.files;
  // 票据归属流水，默认不在文件库显示；点「票据」标签才单独查看
  if (state.fileFilter === 'receipt') list = list.filter(f => f.category === 'receipt');
  else {
    list = list.filter(f => f.category !== 'receipt');
    if (state.fileFilter !== 'all') list = list.filter(f => fileKind(f.name, f.type) === state.fileFilter);
  }
  const q = state.fileSearch.trim().toLowerCase();
  if (q) list = list.filter(f => f.name.toLowerCase().includes(q));
  const cards = list.map(f => {
    const k = fileKind(f.name, f.type);
    return `<div class="file-card">
      <div class="file-thumb">${k === 'image'
        ? `<img src="${thumbUrl(f.blob)}" alt="" onerror="this.style.display='none'">`
        : `<span class="file-icon">${KIND_ICONS[k]}</span>`}</div>
      <div class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
      <div class="file-meta">${(f.size / 1024).toFixed(0)} KB · ${new Date(f.createdAt).toLocaleString('zh-CN', { hour12: false })}</div>
      <div class="file-ops">
        <button type="button" class="mini-btn" data-action="preview-file" data-id="${f.id}">预览</button>
        <button type="button" class="mini-btn" data-action="download-file" data-id="${f.id}">下载</button>
        ${(k === 'image' || k === 'pdf') ? `<button type="button" class="mini-btn" data-action="add-to-pdf" data-id="${f.id}">合成</button>` : ''}
        <button type="button" class="mini-btn" data-action="rename-file" data-id="${f.id}">重命名</button>
        <button type="button" class="mini-btn danger" data-action="delete-file" data-id="${f.id}">删除</button>
      </div>
    </div>`;
  }).join('');

  return `<div class="files-view">
    <div class="card files-toolbar">
      <input type="search" id="fileSearch" placeholder="搜索文件名…" value="${escapeHtml(state.fileSearch)}">
      <div class="filter-chips">${filters.map(([v, n]) => `<button type="button" class="chip-btn${state.fileFilter === v ? ' on' : ''}" data-action="set-filter" data-filter="${v}">${n}</button>`).join('')}</div>
      <button type="button" class="btn primary" id="uploadBtn">⬆ 上传文件</button>
      <input type="file" id="fileInput" multiple hidden>
    </div>
    <div class="card files-drop" id="filesDrop">📥 任意格式的文件都可以直接拖进来（图片 / PDF / 视频 / 音频 / 文档…）</div>
    ${cards ? `<div class="file-grid">${cards}</div>` : `<div class="card empty-tip">暂无文件${state.fileSearch ? '，换个关键词试试' : '，拖入或点击上传开始吧'}</div>`}
  </div>`;
}

function bindFilesView() {
  const input = $('#fileInput'), drop = $('#filesDrop');
  $('#uploadBtn')?.addEventListener('click', () => input.click());
  input?.addEventListener('change', async () => { await uploadFiles([...input.files]); input.value = ''; });
  if (drop) {
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('drag-over'); }));
    drop.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag-over'); });
    drop.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag-over');
      await uploadFiles([...e.dataTransfer.files]);
    });
  }
  const search = $('#fileSearch');
  search?.addEventListener('input', () => {
    state.fileSearch = search.value;
    renderMain();
    const s = $('#fileSearch');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  });
}

async function uploadFiles(files) {
  if (!files || !files.length) return;
  for (const f of files) {
    await DB.add('files', { name: f.name, type: f.type || '', size: f.size, blob: f, category: 'library', createdAt: Date.now() });
  }
  await loadFiles();
  renderMain();
  toast(`已上传 ${files.length} 个文件到文件库`);
}

/* ---------------- 文件重命名 ---------------- */
async function renameFile(id) {
  const f = state.files.find(x => x.id === id);
  if (!f) return;
  const oldName = f.name;
  const ext = oldName.includes('.') ? oldName.slice(oldName.lastIndexOf('.')) : '';
  const input = await promptModal('重命名文件', '新的文件名称', oldName);
  if (!input || input === oldName) return;
  let newName = input;
  // 若用户未带扩展名，自动补回原扩展名，保持文件类型/图标识别不被破坏
  if (ext && !newName.includes('.')) newName += ext;
  await DB.put('files', { ...f, name: newName });
  await loadFiles();
  renderMain();
  toast('文件名已更新');
}

/* ---------------- 文件预览 ---------------- */
async function previewFile(id) {
  let rec = state.files.find(f => f.id === id);
  if (!rec) rec = await DB.get('files', id);
  if (!rec) { toast('文件不存在', 'error'); return; }
  const k = fileKind(rec.name, rec.type);
  const url = URL.createObjectURL(rec.blob);
  const m = openModal({ title: rec.name, wide: true, onClose: () => URL.revokeObjectURL(url) });
  const bodyEl = $('.modal-body', m.root);
  bodyEl.innerHTML = '<div class="preview-loading">加载中…</div>';
  let el = null;
  try {
    if (k === 'image') { el = document.createElement('img'); el.className = 'preview-media'; el.src = url; }
    else if (k === 'video') { el = document.createElement('video'); el.className = 'preview-media'; el.controls = true; el.src = url; }
    else if (k === 'audio') { el = document.createElement('audio'); el.className = 'preview-audio'; el.controls = true; el.src = url; }
    else if (k === 'pdf') { el = document.createElement('iframe'); el.className = 'preview-frame'; el.src = url; }
    else if (k === 'text' && rec.blob.size <= 1024 * 1024) {
      el = document.createElement('pre');
      el.className = 'preview-text';
      el.textContent = (await rec.blob.text()).slice(0, 200000);
    }
  } catch (e) { el = null; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'preview-fallback';
    el.innerHTML = `<div class="pf-icon">${KIND_ICONS[k]}</div><div class="pf-text">「${escapeHtml(rec.name)}」${KIND_NAMES[k]}格式暂不支持在线预览，请下载后查看</div>`;
  }
  bodyEl.innerHTML = '';
  bodyEl.appendChild(el);
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const dl = document.createElement('button');
  dl.className = 'btn primary'; dl.textContent = '⬇ 下载文件';
  dl.onclick = () => downloadBlob(rec.blob, rec.name);
  footer.appendChild(dl);
  $('.modal', m.root).appendChild(footer);
}

/* 一笔流水的全部单据：画廊式逐张预览 */
async function previewReceipts(t) {
  const recs = (t.receipts || []).filter(Boolean);
  if (!recs.length) { toast('该笔流水没有单据', 'error'); return; }
  const urls = [];
  const cleanup = () => urls.forEach(u => URL.revokeObjectURL(u));
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') loadInto(curIdx - 1);
    else if (e.key === 'ArrowRight') loadInto(curIdx + 1);
  };
  const m = openModal({ title: `单据预览（${recs.length} 张）`, wide: true, onClose: () => { cleanup(); document.removeEventListener('keydown', onKey); } });
  const bodyEl = $('.modal-body', m.root);
  bodyEl.innerHTML = `<div class="rcp-wrap">
    <div class="rcp-nav">
      <button type="button" class="rcp-arrow" id="rcpPrev" title="上一张（←）">‹</button>
      <span class="rcp-count" id="rcpCount"></span>
      <button type="button" class="rcp-arrow" id="rcpNext" title="下一张（→）">›</button>
    </div>
    <div class="rcp-strip" id="rcpStrip"></div>
    <div class="rcp-main" id="rcpMain"><div class="preview-loading">加载中…</div></div>
  </div>`;
  const strip = $('#rcpStrip', m.root);
  const main = $('#rcpMain', m.root);
  const countEl = $('#rcpCount', m.root);
  const prevBtn = $('#rcpPrev', m.root);
  const nextBtn = $('#rcpNext', m.root);
  let curIdx = 0;

  function updateNav() {
    countEl.textContent = `第 ${curIdx + 1} / ${recs.length} 张`;
    prevBtn.disabled = curIdx <= 0;
    nextBtn.disabled = curIdx >= recs.length - 1;
    $$('.rcp-thumb', strip).forEach((th, i) => th.classList.toggle('on', i === curIdx));
  }

  async function loadInto(idx) {
    if (idx < 0 || idx >= recs.length) return;
    curIdx = idx;
    const rec = recs[idx];
    let f = state.files.find(x => x.id === rec.id);
    if (!f) f = await DB.get('files', rec.id);
    if (!f) { main.innerHTML = '<div class="preview-fallback">单据已不存在</div>'; updateNav(); return; }
    const k = fileKind(f.name, f.type);
    const url = URL.createObjectURL(f.blob);
    urls.push(url);
    let el = null;
    try {
      if (k === 'image') { el = document.createElement('img'); el.className = 'preview-media'; el.src = url; }
      else if (k === 'video') { el = document.createElement('video'); el.className = 'preview-media'; el.controls = true; el.src = url; }
      else if (k === 'audio') { el = document.createElement('audio'); el.className = 'preview-audio'; el.controls = true; el.src = url; }
      else if (k === 'pdf') { el = document.createElement('iframe'); el.className = 'preview-frame'; el.src = url; }
      else if (k === 'text' && f.blob.size <= 1024 * 1024) { el = document.createElement('pre'); el.className = 'preview-text'; el.textContent = (await f.blob.text()).slice(0, 200000); }
    } catch (e) { el = null; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'preview-fallback';
      el.innerHTML = `<div class="pf-icon">${KIND_ICONS[k]}</div><div class="pf-text">「${escapeHtml(f.name)}」${KIND_NAMES[k]}格式暂不支持在线预览，请下载后查看</div>`;
    }
    main.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'rcp-current';
    box.appendChild(el);
    const dl = document.createElement('button');
    dl.type = 'button'; dl.className = 'mini-btn primary'; dl.textContent = '⬇ 下载当前单据';
    dl.onclick = () => downloadBlob(f.blob, f.name);
    box.appendChild(dl);
    main.appendChild(box);
    updateNav();
  }

  recs.forEach((rec, idx) => {
    const th = document.createElement('button');
    th.type = 'button'; th.className = 'rcp-thumb';
    th.title = rec.name;
    th.innerHTML = `<span class="rcp-idx">${idx + 1}</span><span class="rcp-name">${escapeHtml(rec.name)}</span>`;
    th.addEventListener('click', () => loadInto(idx));
    strip.appendChild(th);
  });
  prevBtn.addEventListener('click', () => loadInto(curIdx - 1));
  nextBtn.addEventListener('click', () => loadInto(curIdx + 1));
  document.addEventListener('keydown', onKey);
  loadInto(0);

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const dlAll = document.createElement('button');
  dlAll.className = 'btn primary'; dlAll.textContent = '⬇ 下载全部单据';
  dlAll.onclick = async () => {
    for (const rec of recs) {
      let f = state.files.find(x => x.id === rec.id);
      if (!f) f = await DB.get('files', rec.id);
      if (f) downloadBlob(f.blob, f.name);
    }
    toast(`已开始下载 ${recs.length} 个单据`);
  };
  footer.appendChild(dlAll);
  $('.modal', m.root).appendChild(footer);
}

/* ---------------- 公司管理 ---------------- */
let mgmtModal = null;

function renderCompanySelect() {
  const sel = $('#companySelect');
  if (!sel) return;
  sel.innerHTML = state.companies.map(c =>
    `<option value="${c.id}" ${c.id === state.currentCompanyId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

async function openManageCompanies() {
  const counts = {};
  for (const c of state.companies) {
    const accs = await DB.byIndex('accounts', 'byCompany', c.id);
    const txs = await DB.byIndex('transactions', 'byCompany', c.id);
    counts[c.id] = { acc: accs.length, txn: txs.length };
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="mgmt-list">
      ${state.companies.map(c => `<div class="mgmt-row">
        <input class="mgmt-name" value="${escapeHtml(c.name)}" data-company="${c.id}">
        <span class="mgmt-meta">${counts[c.id].acc} 账户 · ${counts[c.id].txn} 笔</span>
        <button type="button" class="mini-btn danger" data-action="delete-company" data-id="${c.id}">删除</button>
      </div>`).join('') || '<div class="empty-tip small">还没有公司</div>'}
      <div class="mgmt-row">
        <input class="mgmt-name" id="newCompanyName" placeholder="新公司名称">
        <button type="button" class="mini-btn primary" id="createCompanyBtn">创建</button>
      </div>
    </div>
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="btn ghost" data-action="export-backup">⬇ 导出数据备份（JSON，不含文件内容）</button>
    </div>
    <p style="font-size:12px;color:var(--muted);margin:10px 0 0">提示：所有数据保存在本机浏览器中，清理浏览器数据前请先导出备份。</p>`;
  mgmtModal = openModal({ title: '公司管理', body: wrap });
  mgmtModal.root.addEventListener('click', e => { if (e.target === mgmtModal.root) mgmtModal = null; });

  $$('.mgmt-name[data-company]', wrap).forEach(inp => {
    inp.addEventListener('change', async () => {
      const cid = Number(inp.dataset.company);
      const c = state.companies.find(x => x.id === cid);
      const v = inp.value.trim();
      if (!v) { inp.value = c ? c.name : ''; return; }
      if (c && v !== c.name) {
        c.name = v;
        await DB.put('companies', c);
        await loadCompanies();
        renderCompanySelect(); renderMain();
        toast('已重命名');
      }
    });
  });
  $('#createCompanyBtn', wrap).addEventListener('click', async () => {
    const inp = $('#newCompanyName', wrap);
    const name = inp.value.trim();
    if (!name) { toast('请输入公司名称', 'error'); return; }
    const id = await DB.add('companies', { name, createdAt: Date.now() });
    await loadCompanies();
    await setCurrentCompany(id);
    renderCompanySelect(); renderMain();
    if (mgmtModal) { mgmtModal.close(); mgmtModal = null; }
    toast(`已创建并切换到「${name}」`);
  });
}

async function deleteCompany(id) {
  const c = state.companies.find(x => x.id === id);
  if (!c) return;
  const accs = await DB.byIndex('accounts', 'byCompany', id);
  const txs = await DB.byIndex('transactions', 'byCompany', id);
  const prs = await DB.byIndex('parties', 'byCompany', id);
  const pjs = await DB.byIndex('projects', 'byCompany', id);
  const ok = await confirmModal('删除公司',
    `将删除公司「${c.name}」及其 ${accs.length} 个账户、${txs.length} 笔流水、${prs.length} 个供应商/客户、${pjs.length} 个项目及关联单据，且不可恢复。文件库中的独立文件会保留。`);
  if (!ok) return;
  for (const a of accs) await DB.del('accounts', a.id);
  for (const t of txs) {
    for (const r of t.receipts || []) await DB.del('files', r.id);
    await DB.del('transactions', t.id);
  }
  for (const p of prs) await DB.del('parties', p.id);
  for (const p of pjs) await DB.del('projects', p.id);
  await DB.del('companies', id);
  await loadCompanies();
  await loadFiles();
  if (!state.companies.length) {
    const nid = await DB.add('companies', { name: '我的公司', createdAt: Date.now() });
    await loadCompanies();
  }
  await setCurrentCompany(state.companies[0].id);
  if (mgmtModal) { mgmtModal.close(); mgmtModal = null; }
  renderCompanySelect(); renderMain();
  toast('公司已删除');
}

async function exportBackup() {
  const data = {
    app: '财务工作台',
    exportedAt: new Date().toISOString(),
    companies: await DB.all('companies'),
    accounts: await DB.all('accounts'),
    transactions: await DB.all('transactions'),
    parties: await DB.all('parties'),
    projects: await DB.all('projects'),
    files: (await DB.all('files')).map(({ blob, ...rest }) => ({ ...rest, hasBlob: !!blob })),
  };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `财务工作台备份_${todayLocal()}.json`);
  toast('备份已导出（仅数据，不含文件内容）');
}

/* ---------------- CSV 导出 ---------------- */
function exportCsv() {
  const accName = id => state.accounts.find(a => a.id === id)?.name || '未关联账户';
  let list = state.currentAccountId === 'all' ? state.txns : state.txns.filter(t => t.accountId === Number(state.currentAccountId));
  if (state.dateFrom) list = list.filter(t => (t.datetime || '').slice(0, 10) >= state.dateFrom);
  if (state.dateTo) list = list.filter(t => (t.datetime || '').slice(0, 10) <= state.dateTo);
  const rows = [['日期', '类型', '账户', '金额', '交易对象', '项目', '备注', '单据数']];
  [...list].sort((a, b) => (a.datetime || '').localeCompare(b.datetime || '')).forEach(t => {
    rows.push([(t.datetime || '').slice(0, 10), t.type === 'income' ? '收入' : '支出', accName(t.accountId),
      Number(t.amount).toFixed(2), t.counterparty || '', t.projectName || '', t.remark || '', (t.receipts || []).length]);
  });
  const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const company = state.companies.find(c => c.id === state.currentCompanyId);
  const rangeTag = (state.dateFrom || state.dateTo) ? `_${state.dateFrom || '起'}-${state.dateTo || '止'}` : '';
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${company ? company.name : '公司'}-流水明细${rangeTag}.csv`);
  toast('CSV 已导出');
}

/* ---------------- 从文件库选择加入合成 ---------------- */
function openFilePicker() {
  const candidates = state.files.filter(f => ['image', 'pdf'].includes(fileKind(f.name, f.type)));
  if (!candidates.length) { toast('文件库中暂无图片或 PDF', 'error'); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="picker-grid">${candidates.map(f =>
    `<label class="picker-item"><input type="checkbox" value="${f.id}"><span class="picker-name">${KIND_ICONS[fileKind(f.name, f.type)]} ${escapeHtml(f.name)}</span></label>`).join('')}</div>`;
  const m = openModal({ title: '从文件库选择文件', body: wrap, wide: true });
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const ok = document.createElement('button');
  ok.className = 'btn primary'; ok.textContent = '加入合成';
  footer.appendChild(ok);
  $('.modal', m.root).appendChild(footer);
  ok.onclick = async () => {
    const ids = $$('input:checked', wrap).map(i => Number(i.value));
    let added = 0;
    for (const id of ids) {
      const f = state.files.find(x => x.id === id);
      if (f) {
        state.pdfItems.push({ uid: uid(), name: f.name, size: f.size, type: f.type || '', kind: fileKind(f.name, f.type), blob: f.blob });
        added++;
      }
    }
    m.close();
    if (added) { state.pdfBlob = null; renderMain(); buildPdfDebounced(); toast(`已加入 ${added} 个文件`); }
  };
}

/* ---------------- 全局拖拽路由 ---------------- */
function routeFiles(fileList, target) {
  const files = [...fileList];
  if (!files.length) return;
  if (target === 'pdf') {
    addPdfFiles(files).then(() => switchView('pdf'));
  } else if (target === 'files') {
    switchView('files');
    uploadFiles(files);
  } else if (target === 'txn') {
    switchView('ledger');
    (async () => {
      for (const f of files) {
        const id = await DB.add('files', { name: f.name, type: f.type || '', size: f.size, blob: f, category: 'receipt', createdAt: Date.now() });
        state.pendingReceipts.push({ id, name: f.name });
      }
      await loadFiles();
      renderMain();
      toast(`已添加 ${files.length} 个单据，请补全流水信息后保存`);
    })();
  }
}

function bindGlobalDrop() {
  const overlay = $('#dropOverlay');
  let depth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; depth++; overlay.classList.remove('hidden'); });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth || !e.relatedTarget) { depth = 0; overlay.classList.add('hidden'); }
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); depth = 0; overlay.classList.add('hidden'); });
  $$('.drop-zone', overlay).forEach(z => {
    z.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      z.classList.remove('over');
      overlay.classList.add('hidden');
      depth = 0;
      routeFiles(e.dataTransfer.files, z.dataset.target);
    });
  });
}

/* ---------------- 动作分发 ---------------- */
async function handleAction(action, el, e) {
  const id = el.dataset.id !== undefined && el.dataset.id !== '' ? Number(el.dataset.id) : null;
  switch (action) {
    /* ---- 账户 ---- */
    case 'select-all-accounts':
      state.currentAccountId = 'all';
      await DB.kvSet('currentAccountId', 'all');
      renderMain();
      break;
    case 'select-account':
      state.currentAccountId = String(id);
      await DB.kvSet('currentAccountId', String(id));
      renderMain();
      break;
    case 'add-account': {
      const name = await promptModal('添加账户', '账户名称（如：现金 / 银行 / 微信 / 支付宝）');
      if (!name) return;
      await DB.add('accounts', { companyId: state.currentCompanyId, name, createdAt: Date.now() });
      await loadAccounts();
      state.currentAccountId = String((await DB.byIndex('accounts', 'byCompany', state.currentCompanyId)).sort((a, b) => b.id - a.id)[0].id);
      await DB.kvSet('currentAccountId', state.currentAccountId);
      renderMain();
      toast(`账户「${name}」已添加`);
      break;
    }
    case 'quick-add-accounts': {
      const presets = ['现金', '银行账户', '微信', '支付宝'];
      let n = 0;
      for (const p of presets) {
        if (!state.accounts.some(a => a.name === p)) {
          await DB.add('accounts', { companyId: state.currentCompanyId, name: p, createdAt: Date.now() });
          n++;
        }
      }
      await loadAccounts();
      renderMain();
      toast(n ? `已添加 ${n} 个常用账户` : '常用账户都已存在');
      break;
    }
    case 'edit-account': {
      const a = state.accounts.find(x => x.id === id);
      if (!a) return;
      const name = await promptModal('重命名账户', '新名称', a.name);
      if (!name) return;
      a.name = name;
      await DB.put('accounts', a);
      await loadAccounts();
      renderMain();
      toast('已重命名');
      break;
    }
    case 'delete-account': {
      const a = state.accounts.find(x => x.id === id);
      if (!a) return;
      const cnt = state.txns.filter(t => t.accountId === id).length;
      const ok = await confirmModal('删除账户', `将删除账户「${a.name}」及其 ${cnt} 笔流水，且不可恢复。`);
      if (!ok) return;
      for (const t of state.txns.filter(t => t.accountId === id)) {
        for (const r of t.receipts || []) await DB.del('files', r.id);
        await DB.del('transactions', t.id);
      }
      await DB.del('accounts', id);
      if (state.currentAccountId === String(id)) state.currentAccountId = 'all';
      await Promise.all([loadAccounts(), loadTxns(), loadFiles()]);
      renderMain();
      toast('账户已删除');
      break;
    }
    case 'view-account-txns':
      state.currentAccountId = String(id);
      await DB.kvSet('currentAccountId', String(id));
      switchView('ledger');
      break;
    case 'switch-accounts':
      switchView('accounts');
      break;
    /* ---- 流水 ---- */
    case 'edit-txn': {
      const t = state.txns.find(x => x.id === id);
      if (!t) return;
      state.editingTxnId = id;
      state.pendingReceipts = (t.receipts || []).map(r => ({ ...r }));
      state.draft = null;
      renderMain();
      $('#txnForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'cancel-edit':
      state.editingTxnId = null;
      state.pendingReceipts = [];
      state.draft = null;
      renderMain();
      break;
    case 'delete-txn': {
      const t = state.txns.find(x => x.id === id);
      if (!t) return;
      const ok = await confirmModal('删除流水',
        `删除 ${fmtDT(t.datetime)} 的${t.type === 'income' ? '收入' : '支出'} ${fmtMoney(t.amount)}？关联的 ${(t.receipts || []).length} 个单据将一并删除。`);
      if (!ok) return;
      for (const r of t.receipts || []) await DB.del('files', r.id);
      await DB.del('transactions', id);
      if (state.editingTxnId === id) { state.editingTxnId = null; state.pendingReceipts = []; }
      await Promise.all([loadTxns(), loadFiles()]);
      renderMain();
      toast('已删除');
      break;
    }
    case 'preview-receipt': {
      const t = state.txns.find(x => x.id === id);
      if (t && t.receipts && t.receipts.length) previewReceipts(t);
      else toast('该笔流水没有单据', 'error');
      break;
    }
    case 'remove-receipt': {
      const i = Number(el.dataset.i);
      if (!isNaN(i)) state.pendingReceipts.splice(i, 1);
      renderMain();
      break;
    }
    case 'export-csv':
      exportCsv();
      break;
    case 'clear-date-range':
      state.dateFrom = ''; state.dateTo = '';
      renderMain();
      break;
    /* ---- 供应商客户 / 项目 ---- */
    case 'add-party': {
      const ptype = el.dataset.ptype === 'customer' ? 'customer' : 'supplier';
      await openPartyModal(ptype, null);
      break;
    }
    case 'edit-party': {
      const p = state.parties.find(x => x.id === id);
      if (p) await openPartyModal(p.type, p);
      break;
    }
    case 'delete-party': {
      const p = state.parties.find(x => x.id === id);
      if (!p) return;
      const used = state.txns.filter(t => t.partyId === id).length;
      const ok = await confirmModal('删除' + (p.type === 'supplier' ? '供应商' : '客户'),
        `删除「${p.name}」？${used ? `${used} 笔流水将不再关联该交易对象。` : ''}此操作不可恢复。`);
      if (!ok) return;
      for (const t of state.txns) {
        if (t.partyId === id) { t.partyId = null; await DB.put('transactions', t); }
      }
      await DB.del('parties', id);
      await loadParties();
      if (state.view === 'ledger') fillPartySelect();
      renderMain();
      toast('已删除');
      break;
    }
    case 'view-party-txns': {
      const p = state.parties.find(x => x.id === id);
      if (!p) return;
      const b = partyBalance(p);
      const label = p.type === 'supplier' ? '应付' : '应收';
      const cls = p.type === 'supplier' ? 'out' : 'in';
      const summary = `${label}合计 <b class="bal-${cls}">${fmtMoney(b.amount)}</b> · 共 ${b.count} 笔 · 点击 🧾 可预览单据`;
      openDetailModal({ title: `${escapeHtml(p.name)} · 流水明细`, summary, list: state.txns.filter(t => t.partyId === id), csvType: 'party', scope: id });
      break;
    }
    case 'view-project-txns': {
      const p = state.projects.find(x => x.id === id);
      if (!p) return;
      const b = projectBalance(p);
      const summary = `收入 <b class="bal-in">${fmtMoney(b.income)}</b> · 支出 <b class="bal-out">${fmtMoney(b.expense)}</b> · 结余 <b class="${b.balance < 0 ? 'bal-out' : 'bal-in'}">${fmtMoney(b.balance)}</b> · 共 ${b.count} 笔 · 点击 🧾 可预览单据`;
      openDetailModal({ title: `${escapeHtml(p.name)} · 流水明细`, summary, list: state.txns.filter(t => t.projectId === id), csvType: 'project', scope: id });
      break;
    }
    case 'view-scope-txns': {
      const scopeVal = $('#scopeAccount')?.value || 'all';
      const isAll = scopeVal === 'all';
      const acc = isAll ? null : state.accounts.find(a => a.id === Number(scopeVal));
      const list = isAll ? state.txns : state.txns.filter(t => t.accountId === Number(scopeVal));
      const bt = computeTotals(list);
      const titleName = isAll ? '全部账户' : (acc?.name || '账户');
      const summary = `收入 <b class="bal-in">${fmtMoney(bt.income)}</b> · 支出 <b class="bal-out">${fmtMoney(bt.expense)}</b> · 结余 <b class="${bt.balance < 0 ? 'bal-out' : 'bal-in'}">${fmtMoney(bt.balance)}</b> · 共 ${list.length} 笔 · 点击 🧾 可预览单据`;
      openDetailModal({ title: `${escapeHtml(titleName)} · 流水明细`, summary, list, csvType: 'account', scope: scopeVal });
      break;
    }
    case 'export-detail-csv': {
      const ptype = el.dataset.ptype;
      const scope = el.dataset.scope;
      let list, name;
      if (ptype === 'party') {
        const p = state.parties.find(x => x.id === Number(scope));
        list = state.txns.filter(t => t.partyId === Number(scope));
        name = p ? p.name : '交易对象';
      } else if (ptype === 'project') {
        const p = state.projects.find(x => x.id === Number(scope));
        list = state.txns.filter(t => t.projectId === Number(scope));
        name = p ? p.name : '项目';
      } else {
        const isAll = scope === 'all';
        const acc = isAll ? null : state.accounts.find(a => a.id === Number(scope));
        list = isAll ? state.txns : state.txns.filter(t => t.accountId === Number(scope));
        name = isAll ? '全部账户' : (acc ? acc.name : '账户');
      }
      const accName = aid => state.accounts.find(a => a.id === aid)?.name || '未关联账户';
      // 按弹窗内日期区间筛选后再导出
      const fromEl = document.querySelector('.modal-body #detailFrom');
      const toEl = document.querySelector('.modal-body #detailTo');
      const from = fromEl ? (fromEl.value || '') : '';
      const to = toEl ? (toEl.value || '') : '';
      if (from || to) {
        list = list.filter(t => {
          const d = (t.datetime || '').slice(0, 10);
          if (from && d < from) return false;
          if (to && d > to) return false;
          return true;
        });
      }
      const csvRows = [['日期', '类型', '账户', '金额', '交易对象', '项目', '备注', '单据数']];
      [...list].sort((a, b) => (a.datetime || '').localeCompare(b.datetime || '')).forEach(t => {
        csvRows.push([(t.datetime || '').slice(0, 10), t.type === 'income' ? '收入' : '支出', accName(t.accountId),
          Number(t.amount).toFixed(2), t.counterparty || '', t.projectName || '', t.remark || '', (t.receipts || []).length]);
      });
      const csv = '\uFEFF' + csvRows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const suffix = (from || to) ? `_${from || '起'}-${to || '止'}` : '';
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${name}-流水明细${suffix}.csv`);
      toast('CSV 已导出' + ((from || to) ? '（已按区间）' : ''));
      break;
    }
    case 'quick-add-party': {
      const type = ($('input[name="fType"]:checked') || {}).value || 'expense';
      const ptype = type === 'income' ? 'customer' : 'supplier';
      const name = await promptModal(ptype === 'supplier' ? '新增供应商（交易对象）' : '新增客户（交易对象）', '交易对象名称');
      if (!name) return;
      const nid = await DB.add('parties', { name, type: ptype, companyId: state.currentCompanyId, createdAt: Date.now() });
      await loadParties();
      fillPartySelect();
      const sel = $('#fParty');
      if (sel) sel.value = nid;
      captureDraft();
      toast(`已新增并选中「${name}」`);
      break;
    }
    case 'add-project':
      await openProjectModal(null);
      break;
    case 'edit-project': {
      const p = state.projects.find(x => x.id === id);
      if (p) await openProjectModal(p);
      break;
    }
    case 'delete-project': {
      const p = state.projects.find(x => x.id === id);
      if (!p) return;
      const used = state.txns.filter(t => t.projectId === id).length;
      const ok = await confirmModal('删除项目', `删除「${p.name}」？${used ? `${used} 笔流水将不再关联该项目。` : ''}此操作不可恢复。`);
      if (!ok) return;
      for (const t of state.txns) {
        if (t.projectId === id) { t.projectId = null; t.projectName = ''; await DB.put('transactions', t); }
      }
      await DB.del('projects', id);
      await loadProjects();
      renderMain();
      toast('已删除');
      break;
    }
    case 'quick-add-project': {
      const name = await promptModal('新增项目', '项目名称');
      if (!name) return;
      const nid = await DB.add('projects', { name, companyId: state.currentCompanyId, createdAt: Date.now() });
      await loadProjects();
      const sel = $('#fProject');
      if (sel) { sel.innerHTML = '<option value="">未关联项目</option>' + state.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join(''); sel.value = nid; }
      toast(`已新增并选中「${name}」`);
      break;
    }
    /* ---- 文件库 ---- */
    case 'set-filter':
      state.fileFilter = el.dataset.filter || 'all';
      renderMain();
      break;
    case 'preview-file':
      previewFile(id);
      break;
    case 'download-file': {
      const f = state.files.find(x => x.id === id);
      if (f) downloadBlob(f.blob, f.name);
      break;
    }
    case 'rename-file':
      renameFile(id);
      break;
    case 'delete-file': {
      const f = state.files.find(x => x.id === id);
      if (!f) return;
      const usedBy = state.txns.filter(t => (t.receipts || []).some(r => r.id === id)).length;
      const ok = await confirmModal('删除文件', `删除「${f.name}」？${usedBy ? `${usedBy} 笔流水将失去该单据。` : ''}此操作不可恢复。`);
      if (!ok) return;
      await DB.del('files', id);
      for (const t of state.txns) {
        if ((t.receipts || []).some(r => r.id === id)) {
          t.receipts = t.receipts.filter(r => r.id !== id);
          await DB.put('transactions', t);
        }
      }
      state.pendingReceipts = state.pendingReceipts.filter(r => r.id !== id);
      await Promise.all([loadFiles(), loadTxns()]);
      renderMain();
      toast('文件已删除');
      break;
    }
    case 'add-to-pdf': {
      const f = state.files.find(x => x.id === id);
      if (!f) return;
      state.pdfItems.push({ uid: uid(), name: f.name, size: f.size, type: f.type || '', kind: fileKind(f.name, f.type), blob: f.blob });
      state.pdfBlob = null;
      switchView('pdf');
      buildPdfDebounced();
      break;
    }
    /* ---- PDF 合成 ---- */
    case 'pdf-up': {
      const i = Number(el.dataset.i);
      if (i > 0 && i < state.pdfItems.length) {
        const a = state.pdfItems;
        [a[i - 1], a[i]] = [a[i], a[i - 1]];
        state.pdfBlob = null;
        renderMain();
        buildPdfDebounced();
      }
      break;
    }
    case 'pdf-down': {
      const i = Number(el.dataset.i);
      if (i >= 0 && i < state.pdfItems.length - 1) {
        const a = state.pdfItems;
        [a[i + 1], a[i]] = [a[i], a[i + 1]];
        state.pdfBlob = null;
        renderMain();
        buildPdfDebounced();
      }
      break;
    }
    case 'pdf-remove': {
      const i = Number(el.dataset.i);
      state.pdfItems.splice(i, 1);
      state.pdfBlob = null;
      renderMain();
      if (state.pdfItems.length) buildPdfDebounced();
      else if (state.pdfUrl) { URL.revokeObjectURL(state.pdfUrl); state.pdfUrl = null; }
      break;
    }
    case 'build-pdf':
      buildPdf(true);
      break;
    case 'download-pdf':
      if (state.pdfBlob) {
        const ts = new Date().toISOString().slice(0, 10);
        downloadBlob(state.pdfBlob, `合成文档_${ts}.pdf`);
      }
      break;
    case 'print-pdf':
      printPdf();
      break;
    case 'save-pdf-to-library':
      if (state.pdfBlob) {
        const name = `合成文档_${new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')}.pdf`;
        await DB.add('files', { name, type: 'application/pdf', size: state.pdfBlob.size, blob: state.pdfBlob, category: 'library', createdAt: Date.now() });
        await loadFiles();
        toast('已保存到文件库');
      }
      break;
    case 'clear-pdf':
      state.pdfItems = [];
      state.pdfBlob = null;
      if (state.pdfUrl) { URL.revokeObjectURL(state.pdfUrl); state.pdfUrl = null; }
      renderMain();
      break;
    case 'add-from-library':
      openFilePicker();
      break;
    /* ---- 公司 ---- */
    case 'delete-company':
      await deleteCompany(id);
      break;
    case 'export-backup':
      await exportBackup();
      break;
    default:
      break;
  }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  handleAction(el.dataset.action, el, e).catch(err => {
    console.error(err);
    toast('操作失败：' + (err && err.message ? err.message : err), 'error');
  });
});

/* ---------------- 导航与渲染 ---------------- */
function renderMain() {
  releaseThumbs();
  const main = $('#main');
  if (state.view === 'ledger') main.innerHTML = ledgerHtml();
  else if (state.view === 'accounts') main.innerHTML = accountsViewHtml();
  else if (state.view === 'parties') main.innerHTML = partiesViewHtml();
  else if (state.view === 'projects') main.innerHTML = projectsViewHtml();
  else if (state.view === 'pdf') main.innerHTML = pdfHtml();
  else main.innerHTML = filesHtml();
  if (state.view === 'ledger') bindLedgerForm();
  if (state.view === 'pdf') bindPdfView();
  if (state.view === 'files') bindFilesView();
}

function switchView(v) {
  state.view = v;
  DB.kvSet('view', v);
  $$('.sidenav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  renderMain();
}

function bindChrome() {
  $('#companySelect').addEventListener('change', async e => {
    await setCurrentCompany(Number(e.target.value));
    renderCompanySelect();
    renderMain();
    toast('已切换公司');
  });
  $('#addCompanyBtn').addEventListener('click', async () => {
    const name = await promptModal('新建公司', '公司名称');
    if (!name) return;
    const id = await DB.add('companies', { name, createdAt: Date.now() });
    await loadCompanies();
    await setCurrentCompany(id);
    renderCompanySelect();
    renderMain();
    toast(`已创建并切换到「${name}」`);
  });
  $('#manageCompanyBtn').addEventListener('click', openManageCompanies);
  $$('.sidenav button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    await DB.open();
  } catch (err) {
    document.body.innerHTML = '<div class="boot-error">💥 无法打开本地数据库（IndexedDB）。<br>请通过 http:// 地址访问本页面（如本地服务器），不要直接用 file:// 打开。</div>';
    return;
  }
  if (typeof PDFLib === 'undefined') toast('PDF 组件加载失败，请刷新页面重试', 'error');
  await loadCompanies();
  if (!state.companies.length) {
    const id = await DB.add('companies', { name: '我的公司', createdAt: Date.now() });
    await loadCompanies();
  }
  bindChrome();
  bindGlobalDrop();
  const savedCompany = await DB.kvGet('currentCompanyId');
  await setCurrentCompany(savedCompany || state.companies[0].id);
  const savedView = await DB.kvGet('view');
  if (savedView) state.view = savedView;
  const savedAcc = await DB.kvGet('currentAccountId');
  if (savedAcc && savedAcc !== 'all' && state.accounts.some(a => String(a.id) === String(savedAcc))) {
    state.currentAccountId = savedAcc;
  }
  renderCompanySelect();
  switchView(state.view || 'ledger');
}

document.addEventListener('DOMContentLoaded', boot);
