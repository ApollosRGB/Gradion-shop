'use strict';

// ===========================================================================
// State
// ===========================================================================
let store = null;              // persisted store (settings, stations, products, orders)
let cart = [];                 // [{ productId, qty }]
let currentView = 'shop';
let adminUnlocked = false;
let adminTab = 'products';
let productDraft = null;       // product being edited in admin
let progressOrderId = null;    // order currently shown on progress screen
let pollTimer = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}
function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function persist() {
  await window.api.storeSet(store);
}

// ===========================================================================
// Boot
// ===========================================================================
async function boot() {
  store = await window.api.storeGet();
  applyTheme(store.settings.theme || 'light');
  wireChrome();
  renderCatalog();
  renderCart();
  renderOrdersBadge();
  showView('shop');
}

function wireChrome() {
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#adminToggle').addEventListener('click', onAdminToggle);
  $$('.nav-btn').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view)));
  $('#finishBtn').addEventListener('click', onFinish);
}

// ===========================================================================
// Theme
// ===========================================================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}
async function toggleTheme() {
  const next = (store.settings.theme === 'dark') ? 'light' : 'dark';
  store.settings.theme = next;
  applyTheme(next);
  await persist();
}

// ===========================================================================
// View switching
// ===========================================================================
function showView(view) {
  currentView = view;
  ['shop', 'progress', 'orders', 'admin'].forEach((v) =>
    $('#view-' + v).classList.toggle('hidden', v !== view));

  const isUserView = view === 'shop' || view === 'orders' || view === 'progress';
  $('#bottomNav').classList.toggle('hidden', !(view === 'shop' || view === 'orders'));
  $('#adminToggle').textContent = view === 'admin' ? 'Exit Admin' : 'Admin';

  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  if (view !== 'progress') stopPolling();
  if (view === 'orders') renderOrders();
  if (view === 'admin') renderAdmin();
}

// ===========================================================================
// Catalog (user shop)
// ===========================================================================
function visibleProducts() {
  return store.products.filter((p) => p.visible);
}

function renderCatalog() {
  const root = $('#catalog');
  const products = visibleProducts();
  if (!products.length) {
    root.innerHTML = `<div class="empty-state"><div class="big">📭</div><p>No items available yet.<br>Ask an admin to publish a job.</p></div>`;
    return;
  }
  root.innerHTML = products.map((p) => {
    const inCart = cart.find((c) => c.productId === p.id);
    const qty = inCart ? inCart.qty : 0;
    const media = p.image
      ? `<img src="${p.image}" alt="">`
      : `<span class="placeholder">🎁</span>`;
    return `
      <div class="card">
        <div class="card-media">
          ${media}
          <span class="delivery-badge">🤖 Robot delivery</span>
        </div>
        <div class="card-body">
          <div class="card-name">${escapeHtml(p.name)}</div>
          <div class="card-meta"><span class="star">★ ${Number(p.rating || 4.8).toFixed(1)}</span> · ${p.sold || 0} sold</div>
          <div class="card-price">${money(p.price)}</div>
          <div class="card-actions">
            <div class="stepper">
              <button class="round-btn minus" data-dec="${p.id}" ${qty === 0 ? 'disabled' : ''}>−</button>
              <span class="qty">${qty}</span>
              <button class="round-btn plus" data-inc="${p.id}">+</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  $$('[data-inc]', root).forEach((b) => b.addEventListener('click', () => changeQty(b.dataset.inc, +1)));
  $$('[data-dec]', root).forEach((b) => b.addEventListener('click', () => changeQty(b.dataset.dec, -1)));
}

function changeQty(productId, delta) {
  let row = cart.find((c) => c.productId === productId);
  if (!row && delta > 0) {
    row = { productId, qty: 0 };
    cart.push(row);
  }
  if (!row) return;
  row.qty += delta;
  if (row.qty <= 0) cart = cart.filter((c) => c.productId !== productId);
  renderCatalog();
  renderCart();
}

// ===========================================================================
// Cart
// ===========================================================================
function cartTotal() {
  return cart.reduce((sum, c) => {
    const p = store.products.find((x) => x.id === c.productId);
    return sum + (p ? p.price * c.qty : 0);
  }, 0);
}

function renderCart() {
  const root = $('#cartItems');
  if (!cart.length) {
    root.innerHTML = `<div class="cart-empty">Your cart is empty.<br>Tap “+” on an item to add it.</div>`;
  } else {
    root.innerHTML = cart.map((c) => {
      const p = store.products.find((x) => x.id === c.productId);
      if (!p) return '';
      const thumb = p.image ? `<img src="${p.image}">` : '🎁';
      return `
        <div class="cart-row">
          <div class="thumb">${thumb}</div>
          <div class="info">
            <div class="nm">${escapeHtml(p.name)}</div>
            <div class="pr">${money(p.price)} each</div>
          </div>
          <div class="mini-stepper">
            <button data-cdec="${p.id}">−</button>
            <span class="qty">${c.qty}</span>
            <button data-cinc="${p.id}">+</button>
          </div>
        </div>`;
    }).join('');
    $$('[data-cinc]', root).forEach((b) => b.addEventListener('click', () => changeQty(b.dataset.cinc, +1)));
    $$('[data-cdec]', root).forEach((b) => b.addEventListener('click', () => changeQty(b.dataset.cdec, -1)));
  }
  $('#cartTotal').textContent = money(cartTotal());
  $('#finishBtn').disabled = cart.length === 0;
}

// ===========================================================================
// Finish → create SYNAOS jobs
// ===========================================================================
async function onFinish() {
  if (!cart.length) return;
  const btn = $('#finishBtn');
  btn.disabled = true;
  btn.textContent = 'Sending to robot…';

  const orderId = uid('ord');
  const units = [];
  const itemsSnapshot = [];
  cart.forEach((c) => {
    const p = store.products.find((x) => x.id === c.productId);
    if (!p) return;
    itemsSnapshot.push({ productId: p.id, name: p.name, price: p.price, qty: c.qty, image: p.image, steps: p.steps });
    for (let i = 0; i < c.qty; i++) {
      units.push({ unitId: uid('u'), productId: p.id });
    }
  });

  let results = [];
  try {
    results = await window.api.createOrderJobs({ orderId, units });
  } catch (e) {
    toast('Failed to reach the robot service: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Finish & Send to Robot';
    return;
  }

  const anyOk = results.some((r) => r.ok);
  const jobs = results.map((r, i) => ({
    unitId: units[i].unitId,
    productId: units[i].productId,
    jobId: r.jobId,
    created: r.ok,
    error: r.error || null
  }));

  const order = {
    id: orderId,
    shortId: orderId.slice(-6),
    createdAt: new Date().toISOString(),
    items: itemsSnapshot,
    jobs,
    total: cartTotal(),
    state: anyOk ? 'in_progress' : 'failed',
    confirmed: false
  };
  store.orders.unshift(order);
  await persist();

  cart = [];
  renderCatalog();
  renderCart();
  renderOrdersBadge();

  if (!anyOk) {
    const firstErr = results.find((r) => !r.ok);
    toast('Robot service rejected the order' + (firstErr && firstErr.error ? ': ' + firstErr.error : ''), 'error');
  } else {
    toast('Order sent to the robot!', 'success');
  }

  btn.textContent = 'Finish & Send to Robot';
  openProgress(orderId);
}

// ===========================================================================
// Order progress screen (API-polled)
// ===========================================================================
function stationName(ref) {
  const st = store.stations.find((s) => s.id === ref || s.stationId === ref);
  return st ? st.name : ref;
}
function stationFn(ref) {
  const st = store.stations.find((s) => s.id === ref || s.stationId === ref);
  return st ? (st.fn || '') : '';
}

// Build the canonical flow (ordered unique station+action steps) for an order
function orderFlow(order) {
  const seen = new Set();
  const flow = [];
  order.items.forEach((it) => {
    (it.steps || []).forEach((s) => {
      const key = s.stationRef + '|' + s.action;
      if (!seen.has(key)) {
        seen.add(key);
        flow.push({ stationRef: s.stationRef, action: s.action });
      }
    });
  });
  return flow;
}

const PHASE = { PENDING: 0, APPROACHING: 1, ARRIVED: 2, PERFORMING: 3, FINISHED: 4 };
function milestonePhase(m) {
  let ph = 0;
  (m.eventHistory || []).forEach((ev) => {
    const n = ev.name;
    if (n === 'MILESTONE_APPROACHING_STARTED') ph = Math.max(ph, 1);
    else if (n === 'MILESTONE_APPROACHED') ph = Math.max(ph, 2);
    else if (n === 'MILESTONE_PERFORMING_STARTED') ph = Math.max(ph, 3);
    else if (n === 'MILESTONE_FINISHED') ph = Math.max(ph, 4);
  });
  return ph;
}

function openProgress(orderId) {
  progressOrderId = orderId;
  showView('progress');
  renderProgress(null);
  startPolling();
}

function startPolling() {
  stopPolling();
  pollOnce();
  pollTimer = setInterval(pollOnce, 3000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollOnce() {
  const order = store.orders.find((o) => o.id === progressOrderId);
  if (!order) { stopPolling(); return; }
  if (order.confirmed || order.state === 'completed') { stopPolling(); }

  const liveJobs = {};
  await Promise.all(order.jobs.filter((j) => j.created && j.jobId).map(async (j) => {
    try {
      const res = await window.api.getJob(j.jobId);
      if (res && res.ok && res.data) liveJobs[j.jobId] = res.data;
    } catch (e) { /* ignore transient */ }
  }));
  renderProgress(liveJobs, order);

  // Auto-complete when the API reports all jobs finished
  const createdJobs = order.jobs.filter((j) => j.created && j.jobId);
  if (createdJobs.length) {
    const allFinished = createdJobs.every((j) => {
      const d = liveJobs[j.jobId];
      if (!d) return false;
      if (d.status === 'FINISHED_SUCCESS' || d.finishedExternally) return true;
      return (d.milestones || []).every((m) => milestonePhase(m) === 4);
    });
    const anyFailed = createdJobs.some((j) => {
      const d = liveJobs[j.jobId];
      return d && d.status === 'FINISHED_FAILURE';
    });
    if (allFinished && !order.confirmed && order.state !== 'completed') {
      order.state = 'completed';
      await persist();
      renderOrdersBadge();
    } else if (anyFailed && order.state === 'in_progress') {
      order.state = 'failed';
      await persist();
    }
  }
}

function renderProgress(liveJobs, orderArg) {
  const order = orderArg || store.orders.find((o) => o.id === progressOrderId);
  if (!order) return;
  const flow = orderFlow(order);

  // Aggregate milestone phase per canonical step across all live jobs
  const stepPhase = flow.map((step) => {
    let minPhase = 4;
    let anySeen = false;
    order.jobs.forEach((j) => {
      const d = liveJobs && liveJobs[j.jobId];
      if (!d) return;
      (d.milestones || []).forEach((m) => {
        const mref = (m.address && m.address.id) || '';
        const st = store.stations.find((s) => s.id === step.stationRef);
        const wantId = st ? st.stationId : step.stationRef;
        if (mref === wantId && (m.action || '').toUpperCase() === step.action) {
          anySeen = true;
          minPhase = Math.min(minPhase, milestonePhase(m));
        }
      });
    });
    return anySeen ? minPhase : 0;
  });

  const completed = order.confirmed || order.state === 'completed';
  const failed = order.state === 'failed';

  // Build the human step list
  const stepLines = [];
  stepLines.push({ icon: '🧾', text: 'Order placed', sub: order.items.map((i) => `${i.qty}× ${i.name}`).join(', '), state: 'done' });

  flow.forEach((step, idx) => {
    const nm = stationName(step.stationRef);
    const fn = stationFn(step.stationRef);
    const dest = fn ? `${nm} (${fn})` : nm;
    const ph = stepPhase[idx];
    const verb = step.action === 'PICK' ? 'Picking up at'
      : step.action === 'DROP' ? 'Delivering to'
      : 'Moving to';
    const doneVerb = step.action === 'PICK' ? 'Picked up at'
      : step.action === 'DROP' ? 'Delivered to'
      : 'Arrived at';
    let state = 'pending', text, sub;
    if (completed || ph === 4) { state = 'done'; text = `${doneVerb} ${dest}`; sub = 'Completed'; }
    else if (ph >= 1) { state = 'active'; text = `${verb} ${dest}`; sub = 'AGV en route…'; }
    else { state = 'pending'; text = `On the way to ${dest}`; sub = 'Waiting for AGV'; }
    stepLines.push({ icon: step.action === 'PICK' ? '📦' : step.action === 'DROP' ? '🏁' : '🚚', text, sub, state });
  });

  stepLines.push({
    icon: completed ? '🎉' : '🎊',
    text: completed ? 'Delivered!' : 'Finished',
    sub: completed ? 'Enjoy your treat' : 'Waiting for completion',
    state: completed ? 'done' : 'pending'
  });

  // Rail nodes = unique stations in flow
  const railStations = [];
  const railSeen = new Set();
  flow.forEach((s) => {
    if (!railSeen.has(s.stationRef)) { railSeen.add(s.stationRef); railStations.push(s.stationRef); }
  });
  const stationDonePhase = {};
  flow.forEach((s, i) => {
    stationDonePhase[s.stationRef] = Math.max(stationDonePhase[s.stationRef] || 0, stepPhase[i]);
  });

  const railHtml = railStations.map((ref, i) => {
    const ph = completed ? 4 : (stationDonePhase[ref] || 0);
    const cls = ph === 4 ? 'done' : ph >= 1 ? 'active' : '';
    const emoji = i === 0 ? '🏭' : i === railStations.length - 1 ? '📦' : '🤖';
    return `<div class="rail-node ${cls}">
      <div class="rail-dot">${emoji}</div>
      <div class="rail-label">${escapeHtml(stationName(ref))}</div>
    </div>`;
  }).join('');

  const stepsHtml = stepLines.map((s) => `
    <div class="step-line ${s.state}">
      <div class="step-ic">${s.icon}</div>
      <div>
        <div class="step-txt">${escapeHtml(s.text)}</div>
        <div class="step-sub">${escapeHtml(s.sub || '')}</div>
      </div>
      ${s.state === 'done' ? '<span class="step-check">✓</span>' : ''}
    </div>`).join('');

  const itemsHtml = order.items.map((i) => `
    <div class="oi-row">
      <div class="thumb">${i.image ? `<img src="${i.image}">` : '🎁'}</div>
      <div class="nm">${escapeHtml(i.name)}</div>
      <div class="qty-lbl">Qty: ${i.qty}</div>
      <div class="pr">${money(i.price * i.qty)}</div>
    </div>`).join('');

  const failNote = failed
    ? `<div class="err-text" style="text-align:center;margin-bottom:10px;">⚠️ Some units were rejected by the robot service. ${escapeHtml((order.jobs.find((j) => j.error) || {}).error || '')}</div>`
    : '';

  const confirmBlock = completed ? '' : `
    <div class="order-card" style="text-align:center;">
      <h2 style="color:var(--text);margin-bottom:14px;">Got your treat?</h2>
      <div class="progress-actions">
        <button class="btn btn-primary" id="confirmGotIt">👍 Got it!</button>
        <button class="btn btn-danger" id="cancelOrder">Cancel order</button>
      </div>
    </div>`;

  $('#progressWrap').innerHTML = `
    <div class="order-card">
      <h2>Order #${escapeHtml(order.shortId)}</h2>
      ${failNote}
      <div class="rail">${railHtml}</div>
      <div class="steps">${stepsHtml}</div>
    </div>
    ${confirmBlock}
    <div class="order-items-card">
      <h3>Order items</h3>
      ${itemsHtml}
      <div class="oi-row" style="border-top:2px solid var(--border);margin-top:6px;">
        <div class="nm">Total</div>
        <div class="pr">${money(order.total)}</div>
      </div>
    </div>
    <div class="progress-actions" style="margin-top:16px;">
      <button class="btn btn-secondary" id="backToShop">← Back to Shop</button>
    </div>`;

  $('#backToShop').addEventListener('click', () => showView('shop'));
  const gotIt = $('#confirmGotIt');
  if (gotIt) gotIt.addEventListener('click', () => confirmOrder(order.id));
  const cancel = $('#cancelOrder');
  if (cancel) cancel.addEventListener('click', () => cancelOrder(order.id));
}

async function confirmOrder(orderId) {
  const order = store.orders.find((o) => o.id === orderId);
  if (!order) return;
  order.confirmed = true;
  order.state = 'completed';
  await persist();
  stopPolling();
  renderOrdersBadge();
  renderProgress(null);
  toast('Marked as received 🎉', 'success');
}

async function cancelOrder(orderId) {
  const order = store.orders.find((o) => o.id === orderId);
  if (!order) return;
  confirmModal('Cancel this order?', 'This will ask the robot service to discard the transport jobs.', async () => {
    for (const j of order.jobs) {
      if (j.created && j.jobId) {
        try { await window.api.discardJob(j.jobId); } catch (e) { /* ignore */ }
      }
    }
    order.state = 'failed';
    await persist();
    stopPolling();
    renderOrdersBadge();
    toast('Order cancelled', 'success');
    showView('orders');
  });
}

// ===========================================================================
// My Orders
// ===========================================================================
function renderOrdersBadge() {
  const active = store.orders.filter((o) => o.state === 'in_progress' && !o.confirmed).length;
  const badge = $('#ordersBadge');
  badge.textContent = store.orders.length ? String(store.orders.length) : '0';
  badge.classList.toggle('zero', store.orders.length === 0);
}

function renderOrders() {
  const root = $('#ordersList');
  if (!store.orders.length) {
    root.innerHTML = `<div class="empty-state"><div class="big">🧾</div><p>No orders yet.</p></div>`;
    return;
  }
  root.innerHTML = store.orders.map((o) => {
    const summary = o.items.map((i) => `${i.qty}× ${i.name}`).join(', ');
    const date = new Date(o.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const pill = o.confirmed || o.state === 'completed'
      ? '<span class="status-pill completed">Completed</span>'
      : o.state === 'failed'
      ? '<span class="status-pill failed">Failed</span>'
      : '<span class="status-pill progress">In progress</span>';
    return `
      <div class="order-list-item" data-open="${o.id}">
        <div class="thumb">📦</div>
        <div class="oli-main">
          <div class="oli-id">Order #${escapeHtml(o.shortId)}</div>
          <div class="oli-sub">${escapeHtml(summary)}</div>
          <div class="oli-date">${escapeHtml(date)}</div>
        </div>
        <div class="oli-right">
          ${pill}
          <div class="oli-price">${money(o.total)}</div>
        </div>
      </div>`;
  }).join('');
  $$('[data-open]', root).forEach((el) =>
    el.addEventListener('click', () => openProgress(el.dataset.open)));
}

// ===========================================================================
// Admin
// ===========================================================================
function onAdminToggle() {
  if (currentView === 'admin') { showView('shop'); return; }
  if (adminUnlocked) { showView('admin'); return; }
  promptModal('Admin access', 'Enter the admin password', 'password', '', (val, close, setErr) => {
    if (val === store.settings.adminPassword) {
      adminUnlocked = true;
      close();
      showView('admin');
    } else {
      setErr('Incorrect password.');
    }
  });
}

function renderAdmin() {
  const root = $('#adminWrap');
  root.innerHTML = `
    <div class="admin-head">
      <h1>⚙️ Admin</h1>
      <button class="ghost-btn" id="lockAdmin" style="background:var(--surface-2);color:var(--text);border-color:var(--border);">🔒 Lock</button>
    </div>
    <div class="admin-tabs">
      <button class="tab-btn ${adminTab === 'products' ? 'active' : ''}" data-tab="products">Jobs / Products</button>
      <button class="tab-btn ${adminTab === 'stations' ? 'active' : ''}" data-tab="stations">Stations</button>
      <button class="tab-btn ${adminTab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
    </div>
    <div id="adminBody"></div>`;
  $('#lockAdmin').addEventListener('click', () => { adminUnlocked = false; showView('shop'); });
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { adminTab = b.dataset.tab; renderAdmin(); }));

  if (adminTab === 'products') renderAdminProducts();
  else if (adminTab === 'stations') renderAdminStations();
  else renderAdminSettings();
}

// ---- Admin: products / jobs ----
function renderAdminProducts() {
  const body = $('#adminBody');
  if (productDraft) { renderProductEditor(body); return; }

  const list = store.products.map((p) => {
    const stepDesc = (p.steps || []).map((s) => `${stationName(s.stationRef)}·${s.action}`).join(' → ') || 'No steps';
    return `
      <div class="admin-item">
        <div class="thumb">${p.image ? `<img src="${p.image}">` : '🎁'}</div>
        <div class="grow">
          <div class="title-row">
            <span class="nm">${escapeHtml(p.name)}</span>
            <span class="chip">${money(p.price)}</span>
            <span class="chip ${p.visible ? 'on' : 'off'}">${p.visible ? 'Shown to users' : 'Hidden'}</span>
          </div>
          <div class="desc">🚚 ${escapeHtml(stepDesc)}</div>
          <div class="row-actions" style="margin-top:10px;">
            <button class="link-btn" data-edit="${p.id}">Edit</button>
            <button class="link-btn" data-toggle="${p.id}">${p.visible ? 'Hide from users' : 'Show to users'}</button>
            <button class="link-btn danger" data-del="${p.id}">Delete</button>
          </div>
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="panel">
      <h2>Jobs / Products</h2>
      <p class="hint">Each product maps to a SYNAOS transport job. Configure its milestones (station + action), price, image, and whether users can see it.</p>
      <div class="admin-list">${list || '<p class="hint">No products yet.</p>'}</div>
      <button class="btn btn-primary" id="addProduct" style="margin-top:16px;">+ New job / product</button>
    </div>`;

  $('#addProduct').addEventListener('click', () => {
    productDraft = {
      id: uid('p'), name: '', price: 0, image: null, visible: true,
      rating: 4.9, sold: 0,
      steps: store.stations.length >= 2
        ? [{ stationRef: store.stations[0].id, action: 'PICK' }, { stationRef: store.stations[1].id, action: 'DROP' }]
        : [{ stationRef: store.stations[0] ? store.stations[0].id : '', action: 'PICK' }],
      _new: true
    };
    renderAdmin();
  });
  $$('[data-edit]', body).forEach((b) => b.addEventListener('click', () => {
    productDraft = JSON.parse(JSON.stringify(store.products.find((p) => p.id === b.dataset.edit)));
    renderAdmin();
  }));
  $$('[data-toggle]', body).forEach((b) => b.addEventListener('click', async () => {
    const p = store.products.find((x) => x.id === b.dataset.toggle);
    p.visible = !p.visible;
    await persist();
    renderCatalog();
    renderAdminProducts();
  }));
  $$('[data-del]', body).forEach((b) => b.addEventListener('click', () => {
    confirmModal('Delete product?', 'This removes it from the shop. Existing orders are unaffected.', async () => {
      store.products = store.products.filter((p) => p.id !== b.dataset.del);
      await persist();
      renderCatalog();
      renderAdminProducts();
    });
  }));
}

function renderProductEditor(body) {
  const p = productDraft;
  const stationOpts = (sel) => store.stations.map((s) =>
    `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${escapeHtml(s.name)} (${escapeHtml(s.stationId)})</option>`).join('');
  const actions = ['PICK', 'DROP', 'MOVE', 'PROVIDE'];
  const actionOpts = (sel) => actions.map((a) => `<option value="${a}" ${a === sel ? 'selected' : ''}>${a}</option>`).join('');

  const stepsHtml = p.steps.map((s, i) => `
    <div class="step-editor-row">
      <span class="chip">${i + 1}</span>
      <select class="inp" data-step-station="${i}">${stationOpts(s.stationRef)}</select>
      <select class="inp" data-step-action="${i}" style="max-width:130px;">${actionOpts(s.action)}</select>
      <button class="link-btn danger" data-step-del="${i}" ${p.steps.length <= 1 ? 'style="visibility:hidden;"' : ''}>Remove</button>
    </div>`).join('');

  body.innerHTML = `
    <div class="panel">
      <h2>${p._new ? 'New job / product' : 'Edit job / product'}</h2>
      <p class="hint">Example: “Notebook” = KUKA moves to K2 (PICK) then K1 (DROP).</p>
      <div class="form-grid">
        <label class="fld full">Product name
          <input class="inp" id="f-name" value="${escapeHtml(p.name)}" placeholder="e.g. Mini Branded Notebook">
        </label>
        <label class="fld">Price ($)
          <input class="inp" id="f-price" type="number" min="0" step="0.5" value="${p.price}">
        </label>
        <label class="fld">Rating (display)
          <input class="inp" id="f-rating" type="number" min="0" max="5" step="0.1" value="${p.rating}">
        </label>
        <label class="fld">Units sold (display)
          <input class="inp" id="f-sold" type="number" min="0" step="1" value="${p.sold}">
        </label>
        <label class="fld switch full">
          <input type="checkbox" id="f-visible" ${p.visible ? 'checked' : ''}> Show this job to users
        </label>
        <div class="fld full">Product image
          <div class="img-pick">
            <div class="img-preview" id="f-preview">${p.image ? `<img src="${p.image}">` : '🎁'}</div>
            <button class="btn btn-secondary" id="f-pickimg">Choose image…</button>
            ${p.image ? '<button class="link-btn danger" id="f-clearimg">Remove</button>' : ''}
          </div>
        </div>
      </div>
      <h2 style="margin-top:22px;">Job milestones (process)</h2>
      <p class="hint">The AGV executes these in order. Each step = a station + an action.</p>
      <div class="steps-editor" id="stepsEditor">${stepsHtml}</div>
      <button class="link-btn add-step" id="addStep" style="margin-top:8px;">+ Add step</button>
      <div class="progress-actions" style="margin-top:20px;">
        <button class="btn btn-primary" id="saveProduct">Save</button>
        <button class="btn btn-secondary" id="cancelProduct">Cancel</button>
      </div>
    </div>`;

  // wire fields → draft
  $('#f-name').addEventListener('input', (e) => p.name = e.target.value);
  $('#f-price').addEventListener('input', (e) => p.price = parseFloat(e.target.value) || 0);
  $('#f-rating').addEventListener('input', (e) => p.rating = parseFloat(e.target.value) || 0);
  $('#f-sold').addEventListener('input', (e) => p.sold = parseInt(e.target.value) || 0);
  $('#f-visible').addEventListener('change', (e) => p.visible = e.target.checked);
  $$('[data-step-station]', body).forEach((el) => el.addEventListener('change', (e) => p.steps[+el.dataset.stepStation].stationRef = e.target.value));
  $$('[data-step-action]', body).forEach((el) => el.addEventListener('change', (e) => p.steps[+el.dataset.stepAction].action = e.target.value));
  $$('[data-step-del]', body).forEach((el) => el.addEventListener('click', () => { p.steps.splice(+el.dataset.stepDel, 1); renderAdmin(); }));
  $('#addStep').addEventListener('click', () => {
    p.steps.push({ stationRef: store.stations[0] ? store.stations[0].id : '', action: 'MOVE' });
    renderAdmin();
  });
  $('#f-pickimg').addEventListener('click', async () => {
    const res = await window.api.pickImage();
    if (!res) return;
    if (res.error) { toast(res.error, 'error'); return; }
    p.image = res.dataUrl;
    renderAdmin();
  });
  const clr = $('#f-clearimg');
  if (clr) clr.addEventListener('click', () => { p.image = null; renderAdmin(); });

  $('#cancelProduct').addEventListener('click', () => { productDraft = null; renderAdmin(); });
  $('#saveProduct').addEventListener('click', async () => {
    if (!p.name.trim()) { toast('Please enter a product name.', 'error'); return; }
    if (!p.steps.length || p.steps.some((s) => !s.stationRef)) { toast('Each step needs a station.', 'error'); return; }
    delete p._new;
    const idx = store.products.findIndex((x) => x.id === p.id);
    if (idx >= 0) store.products[idx] = p; else store.products.push(p);
    productDraft = null;
    await persist();
    renderCatalog();
    renderCart();
    renderAdmin();
    toast('Saved', 'success');
  });
}

// ---- Admin: stations ----
function renderAdminStations() {
  const body = $('#adminBody');
  const list = store.stations.map((s) => `
    <div class="admin-item">
      <div class="thumb">📍</div>
      <div class="grow">
        <div class="form-grid">
          <label class="fld">Display name
            <input class="inp" data-st-name="${s.id}" value="${escapeHtml(s.name)}">
          </label>
          <label class="fld">Station ID (SYNAOS address)
            <input class="inp" data-st-id="${s.id}" value="${escapeHtml(s.stationId)}">
          </label>
          <label class="fld full">Function
            <select class="inp" data-st-fn="${s.id}">
              ${['production', 'storage', 'shop', 'charging', 'other'].map((f) =>
                `<option value="${f}" ${f === s.fn ? 'selected' : ''}>${f}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="row-actions" style="margin-top:8px;">
          <button class="link-btn danger" data-st-del="${s.id}">Delete station</button>
        </div>
      </div>
    </div>`).join('');

  body.innerHTML = `
    <div class="panel">
      <h2>Stations</h2>
      <p class="hint">Stations map a friendly name + function to a SYNAOS station address ID (used in job milestones). Function labels appear in the user's order-progress screen.</p>
      <div class="admin-list">${list || '<p class="hint">No stations yet.</p>'}</div>
      <button class="btn btn-primary" id="addStation" style="margin-top:16px;">+ Add station</button>
    </div>`;

  $$('[data-st-name]', body).forEach((el) => el.addEventListener('change', async (e) => {
    store.stations.find((s) => s.id === el.dataset.stName).name = e.target.value; await persist();
  }));
  $$('[data-st-id]', body).forEach((el) => el.addEventListener('change', async (e) => {
    store.stations.find((s) => s.id === el.dataset.stId).stationId = e.target.value; await persist();
  }));
  $$('[data-st-fn]', body).forEach((el) => el.addEventListener('change', async (e) => {
    store.stations.find((s) => s.id === el.dataset.stFn).fn = e.target.value; await persist();
  }));
  $$('[data-st-del]', body).forEach((el) => el.addEventListener('click', () => {
    confirmModal('Delete station?', 'Products using it will need their steps updated.', async () => {
      store.stations = store.stations.filter((s) => s.id !== el.dataset.stDel);
      await persist();
      renderAdminStations();
    });
  }));
  $('#addStation').addEventListener('click', async () => {
    store.stations.push({ id: uid('st'), stationId: 'NEW', name: 'New station', fn: 'other' });
    await persist();
    renderAdminStations();
  });
}

// ---- Admin: settings ----
function renderAdminSettings() {
  const body = $('#adminBody');
  const s = store.settings;
  body.innerHTML = `
    <div class="panel">
      <h2>SYNAOS connection</h2>
      <p class="hint">Job Management API used to dispatch AGV transport jobs.</p>
      <div class="form-grid">
        <label class="fld full">Base URL
          <input class="inp" id="s-url" value="${escapeHtml(s.apiBaseUrl)}">
        </label>
        <label class="fld">Username
          <input class="inp" id="s-user" value="${escapeHtml(s.apiUsername)}">
        </label>
        <label class="fld">Password
          <input class="inp" id="s-pass" type="password" value="${escapeHtml(s.apiPassword)}">
        </label>
      </div>
      <div class="progress-actions" style="margin-top:16px; align-items:center;">
        <button class="btn btn-secondary" id="saveConn">Save connection</button>
        <button class="btn btn-secondary" id="testConn">Test connection</button>
        <span class="api-status" id="connStatus"><span class="dot"></span> Not tested</span>
      </div>
    </div>
    <div class="panel">
      <h2>Admin password</h2>
      <p class="hint">Change the password that unlocks this admin area.</p>
      <div class="form-grid">
        <label class="fld">New password
          <input class="inp" id="s-newpass" type="password" placeholder="New password">
        </label>
        <label class="fld">Confirm new password
          <input class="inp" id="s-newpass2" type="password" placeholder="Repeat">
        </label>
      </div>
      <button class="btn btn-primary" id="changePass" style="margin-top:16px;">Update password</button>
    </div>
    <div class="panel">
      <h2>Appearance</h2>
      <label class="fld switch"><input type="checkbox" id="s-dark" ${s.theme === 'dark' ? 'checked' : ''}> Dark mode</label>
    </div>`;

  $('#saveConn').addEventListener('click', async () => {
    s.apiBaseUrl = $('#s-url').value.trim();
    s.apiUsername = $('#s-user').value;
    s.apiPassword = $('#s-pass').value;
    await persist();
    toast('Connection saved', 'success');
  });
  $('#testConn').addEventListener('click', async () => {
    const status = $('#connStatus');
    status.innerHTML = '<span class="dot"></span> Testing…';
    const res = await window.api.apiTest({
      apiBaseUrl: $('#s-url').value.trim(),
      apiUsername: $('#s-user').value,
      apiPassword: $('#s-pass').value
    });
    if (res.ok) status.innerHTML = '<span class="dot ok"></span> Connected (HTTP ' + res.status + ')';
    else status.innerHTML = `<span class="dot bad"></span> Failed (${res.error || 'HTTP ' + res.status})`;
  });
  $('#changePass').addEventListener('click', async () => {
    const a = $('#s-newpass').value, b = $('#s-newpass2').value;
    if (!a) { toast('Enter a new password.', 'error'); return; }
    if (a !== b) { toast('Passwords do not match.', 'error'); return; }
    store.settings.adminPassword = a;
    await persist();
    $('#s-newpass').value = ''; $('#s-newpass2').value = '';
    toast('Admin password updated', 'success');
  });
  $('#s-dark').addEventListener('change', async (e) => {
    store.settings.theme = e.target.checked ? 'dark' : 'light';
    applyTheme(store.settings.theme);
    await persist();
  });
}

// ===========================================================================
// Modals & toasts
// ===========================================================================
function modalHost() {
  let host = $('#modalRoot');
  host.innerHTML = '';
  return host;
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

function promptModal(title, label, type, initial, onSubmit) {
  const host = modalHost();
  host.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <div class="modal-field">
          <label>${escapeHtml(label)}</label>
          <input class="inp" id="modalInput" type="${type}" value="${escapeHtml(initial || '')}">
        </div>
        <div class="err-text" id="modalErr"></div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="modalCancel">Cancel</button>
          <button class="btn btn-primary" id="modalOk">OK</button>
        </div>
      </div>
    </div>`;
  const input = $('#modalInput');
  input.focus();
  const submit = () => onSubmit(input.value, closeModal, (msg) => { $('#modalErr').textContent = msg; });
  $('#modalOk').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  $('#modalCancel').addEventListener('click', closeModal);
}

function confirmModal(title, message, onYes) {
  const host = modalHost();
  host.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="modalCancel">Cancel</button>
          <button class="btn btn-danger" id="modalYes">Confirm</button>
        </div>
      </div>
    </div>`;
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalYes').addEventListener('click', () => { closeModal(); onYes(); });
}

let toastHost;
function toast(msg, kind) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.id = 'toastHost';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ===========================================================================
boot();
