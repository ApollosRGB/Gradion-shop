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
let ratingDraft = {};          // in-progress star selection { productId: 1..5 }

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
  applyMode();
  // No system chosen yet → ask before showing the shop
  showView(store.settings.mode ? 'shop' : 'start');
}

function wireChrome() {
  // The relay supervisor runs in the main process; refresh when it creates the
  // next leg of a hand-over so the progress screen tracks the new job.
  if (window.api.onRelayChanged) {
    window.api.onRelayChanged(async () => {
      const fresh = await window.api.storeGet();
      store.pendingRelays = fresh.pendingRelays || [];
      if (currentView === 'progress') pollOnce();
      if (currentView === 'admin' && adminTab === 'settings') renderAdmin();
    });
  }
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#adminToggle').addEventListener('click', onAdminToggle);
  $('#modeBadge').addEventListener('click', () => showView('start'));
  $$('[data-mode]').forEach((b) => b.addEventListener('click', async () => {
    store.settings.mode = b.dataset.mode;
    await persist();
    applyMode();
    showView('shop');
  }));
  $$('.nav-btn').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view)));
  $('#finishBtn').addEventListener('click', onFinish);
}

// ===========================================================================
// Which system orders are dispatched to
// ===========================================================================
function isMpdv() {
  return (store.settings || {}).mode === 'mpdv';
}

function applyMode() {
  const mpdv = isMpdv();
  $('#modeBadge').textContent = mpdv ? '🏭 MPDV' : '🤖 SYNAOS';
  $('#brandTitle').textContent = mpdv ? 'Gradion Shop — Production' : 'Gradion Shop';
  $('#finishBtn').textContent = mpdv ? 'Finish & Send to Production' : 'Finish & Send to Robot';
  // Order history and live tracking are SYNAOS concepts
  $$('.nav-btn').forEach((b) => {
    if (b.dataset.view === 'orders') b.classList.toggle('hidden', mpdv);
  });
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
  ['start', 'shop', 'progress', 'orders', 'admin', 'mpdv-result'].forEach((v) =>
    $('#view-' + v).classList.toggle('hidden', v !== view));

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
  if (isMpdv()) return onFinishMpdv();
  const btn = $('#finishBtn');
  btn.disabled = true;
  btn.textContent = 'Sending to robot…';

  const orderId = uid('ord');
  const units = [];
  const itemsSnapshot = [];
  const fellBack = new Set();
  // One trip per cart line: an AGV carries the whole line in a single job chain,
  // and the arm is told to move that many items at the hand-over.
  cart.forEach((c, lineIndex) => {
    const p = store.products.find((x) => x.id === c.productId);
    if (!p) return;
    itemsSnapshot.push({ productId: p.id, name: p.name, price: p.price, qty: c.qty, image: p.image, steps: p.steps });
    const { legs, warnings } = buildLegsForUnit(p, lineIndex, c.qty);
    warnings.forEach((w) => fellBack.add(`${p.name}|${w}`));
    units.push({
      unitId: uid('u'), productId: p.id, quantity: c.qty, legs,
      resourceId: legs[0] ? legs[0].resourceId : null
    });
  });

  fellBack.forEach((entry) => {
    const [name, why] = entry.split('|');
    toast(why === 'incapable'
      ? `${name}: the assigned robot can't reach those stations — letting SYNAOS choose instead.`
      : `${name}: no robot is known to reach those stations — letting SYNAOS choose.`, 'error');
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
  // One unit can produce several jobs (one per robot leg), so match on unitId
  // rather than position.
  const jobs = results.map((r) => {
    const unit = units.find((u) => u.unitId === r.unitId);
    return {
      unitId: r.unitId,
      productId: unit ? unit.productId : null,
      jobId: r.jobId,
      created: r.ok,
      assignedResourceId: r.assignedResourceId || null,
      legIndex: r.legIndex || 0,
      totalLegs: r.totalLegs || 1,
      error: r.error || null
    };
  });

  // Count each ordered item toward the product's "sold" total once the order is placed
  if (anyOk) {
    itemsSnapshot.forEach((it) => {
      const p = store.products.find((x) => x.id === it.productId);
      if (p) p.sold = (p.sold || 0) + it.qty;
    });
  }

  const order = {
    id: orderId,
    shortId: orderId.slice(-6),
    createdAt: new Date().toISOString(),
    items: itemsSnapshot,
    jobs,
    total: cartTotal(),
    state: anyOk ? 'in_progress' : 'failed',
    confirmed: false,
    rated: false,
    ratings: {}
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
// MPDV ordering — one workplan order per cart line
// ===========================================================================
async function onFinishMpdv() {
  const btn = $('#finishBtn');
  btn.disabled = true;
  btn.textContent = 'Sending to production…';

  const lines = cart.map((c) => {
    const p = store.products.find((x) => x.id === c.productId);
    return p ? { productId: p.id, name: p.name, quantity: c.qty, price: p.price, image: p.image } : null;
  }).filter(Boolean);

  let results = [];
  try {
    results = await window.api.mpdvCreateOrders({ lines });
  } catch (e) {
    toast('Could not reach MPDV: ' + e.message, 'error');
    btn.disabled = false;
    applyMode();
    return;
  }

  const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  if (results.some((r) => r.ok)) {
    results.forEach((r) => {
      if (!r.ok) return;
      const p = store.products.find((x) => x.id === (lines.find((l) => l.name === r.productName) || {}).productId);
      if (p) p.sold = (p.sold || 0) + r.quantity;
    });
    await persist();
    renderCatalog();
  }

  cart = [];
  renderCart();
  btn.disabled = false;
  applyMode();
  renderMpdvResult(results, total);
  showView('mpdv-result');
}

function renderMpdvResult(results, total) {
  const okCount = results.filter((r) => r.ok).length;
  const rows = results.map((r) => `
    <div class="oi-row">
      <div class="thumb">${r.ok ? '✅' : '⚠️'}</div>
      <div class="nm">
        ${escapeHtml(r.productName || '(item)')}
        <div class="step-sub">${r.orderNumber
          ? `Order no. <b>${escapeHtml(r.orderNumber)}</b>`
          : 'No order number was issued'}</div>
        ${r.ok ? '' : `<div class="err-text">${escapeHtml(r.error || 'Rejected by MPDV')}</div>`}
      </div>
      <div class="qty-lbl">Qty: ${r.quantity}</div>
    </div>`).join('');

  const allOk = okCount === results.length && results.length > 0;
  $('#mpdvResultWrap').innerHTML = `
    <div class="order-card" style="text-align:center;">
      <div style="font-size:56px;">${allOk ? '🏭' : okCount ? '⚠️' : '❌'}</div>
      <h2 style="color:var(--text);">${allOk
        ? 'Sent to production'
        : okCount ? 'Partly sent to production' : 'MPDV did not accept the order'}</h2>
      <p class="hint">${okCount} of ${results.length} line(s) reached MPDV.</p>
    </div>
    <div class="order-items-card">
      <h3>Order lines</h3>
      ${rows}
      <div class="oi-row" style="border-top:2px solid var(--border);margin-top:6px;">
        <div class="nm">Total</div>
        <div class="pr">${money(total)}</div>
      </div>
    </div>
    <div class="progress-actions" style="margin-top:16px;">
      <button class="btn btn-primary" id="mpdvBackToShop">← Back to Shop</button>
    </div>`;
  $('#mpdvBackToShop').addEventListener('click', () => showView('shop'));
}

// ===========================================================================
// Robot ↔ station access
//
// SYNAOS will not tell us over Basic auth which robot can reach which station,
// and its scheduler has been observed assigning a robot that then reports
// UNABLE_TO_ACCESS_ADDRESS. So access is decided from two sources:
//   1. the admin's explicit per-station allow-list (authoritative when set), and
//   2. evidence mined from job history (a robot that failed with
//      UNABLE_TO_ACCESS_ADDRESS at a station is never offered for it again).
// ===========================================================================
const AUTO_ANY = '';              // let SYNAOS pick (may pick an unreachable robot)
const AUTO_CAPABLE = '__capable__'; // app picks a robot known to reach every station

function stationKeyOf(st) {
  return `${st.stationId}@${st.system || 'STATION'}`;
}
function allRobotIds() {
  return (store.robots || []).map((r) => r.id);
}

// May this robot be assigned here at all? Permissive: the admin's allow-list when
// set, otherwise anything SYNAOS has not proved incapable (✖). A robot with no
// history here is allowed — it simply has not been tried yet.
function robotsAllowedAtStation(st) {
  const all = allRobotIds();
  if (Array.isArray(st.allowedRobots) && st.allowedRobots.length) {
    return all.filter((id) => st.allowedRobots.includes(id));
  }
  const cap = (store.capability || {})[stationKeyOf(st)] || { ok: [], no: [] };
  return all.filter((id) => !(cap.no || []).includes(id));
}

// Which robot should the app pick when told to choose automatically? Stricter:
// prefer robots that have actually completed a milestone here (✓), because SYNAOS
// has been seen auto-assigning an untried robot that then failed with
// UNABLE_TO_ACCESS_ADDRESS. Never used to veto an explicit choice by the admin.
function robotsPreferredAtStation(st) {
  const allowed = robotsAllowedAtStation(st);
  if (Array.isArray(st.allowedRobots) && st.allowedRobots.length) return allowed;
  const cap = (store.capability || {})[stationKeyOf(st)] || { ok: [], no: [] };
  const proven = allowed.filter((id) => (cap.ok || []).includes(id));
  return proven.length ? proven : allowed;
}

// Robots able to serve *every* station a product's job-level default covers.
// Steps with their own robot are excluded — they do not constrain the default.
// `preferred` narrows to proven robots and is what auto-selection uses.
function eligibleRobotsForProduct(product) {
  const all = allRobotIds();
  const blockedAt = {};
  let eligible = null;
  let preferred = null;
  const steps = (product.steps || []).filter((s) => !stepHasOverride(s));
  const scope = steps.length ? steps : (product.steps || []);
  scope.forEach((step) => {
    const st = store.stations.find((s) => s.id === step.stationRef);
    if (!st) return;
    const allowed = robotsAllowedAtStation(st);
    const pref = robotsPreferredAtStation(st);
    all.forEach((id) => { if (!allowed.includes(id) && !blockedAt[id]) blockedAt[id] = st.name; });
    eligible = eligible === null ? allowed.slice() : eligible.filter((id) => allowed.includes(id));
    preferred = preferred === null ? pref.slice() : preferred.filter((id) => pref.includes(id));
  });
  const elig = eligible === null ? all : eligible;
  let pref = preferred === null ? all : preferred;
  if (!pref.length) pref = elig;   // never let the preference filter strand a route
  return { eligible: elig, preferred: pref, blockedAt };
}

// Per-step robot override. Empty/absent means "use the job-level default".
const STEP_INHERIT = '';

// Trailing "drive to the waiting spot" milestones are tagged by the main process
// so they can be kept out of the customer's delivery progress.
const WAITING_SPOT_TAG = 'waitingSpot';
function isWaitingSpotMilestone(m) {
  return (m.correlations || []).some((c) => c.id === WAITING_SPOT_TAG);
}

// Resolves the robot for a single step, honouring only robots allowed at that
// step's own station (a relay leg needs access to its own stations, not the whole route).
function resolveStepResource(product, step, index) {
  const raw = step.resourceId;
  const choice = (raw === undefined || raw === null || raw === STEP_INHERIT)
    ? (product.resourceId || AUTO_ANY)
    : raw;
  const st = store.stations.find((s) => s.id === step.stationRef);
  if (choice === AUTO_CAPABLE) {
    const preferred = st ? robotsPreferredAtStation(st) : [];
    if (!preferred.length) return { resourceId: null, fellBack: 'no-capable' };
    return { resourceId: preferred[index % preferred.length], fellBack: null };
  }
  if (choice === AUTO_ANY) return { resourceId: null, fellBack: null };
  const allowed = st ? robotsAllowedAtStation(st) : [];
  if (!allowed.includes(choice)) return { resourceId: null, fellBack: 'incapable' };
  return { resourceId: choice, fellBack: null };
}

function stepHasOverride(step) {
  return !!(step.resourceId && step.resourceId !== STEP_INHERIT);
}

// A hand-over tells the robotic arm to move the load between two AGVs. It is an
// app-level instruction placed in the route by the operator, never a SYNAOS
// milestone, and the arm only runs where one of these appears.
function isHandoverStep(step) {
  return step && step.kind === 'handover';
}

// The robot's configured waiting spot, appended as a trailing MOVE so it parks
// itself once its part of the route is done. Only possible when we know which
// robot runs the leg — an unassigned leg is chosen by SYNAOS, so it has no home.
function parkNodeFor(resourceId) {
  if (!resourceId) return null;
  const robot = (store.robots || []).find((r) => r.id === resourceId);
  const home = robot && robot.homeNode;
  return home && home.id ? { id: home.id, system: home.system || 'STATION' } : null;
}

// Splits a product's route into legs — one per robot. Consecutive steps sharing a
// robot stay in one job; a change of robot starts a new job (SYNAOS executes every
// milestone of a job with the same resource, so a relay must be several jobs).
// `orderQuantity` is how many of this product the customer asked for. The whole
// line travels together, so it is also how many the arm moves at a hand-over.
function buildLegsForUnit(product, index, orderQuantity) {
  const quantity = Number(orderQuantity) > 0 ? Number(orderQuantity) : 1;
  const allSteps = product.steps || [];
  const steps = allSteps.filter((s) => !isHandoverStep(s));
  const warnings = new Set();
  const plain = (s) => ({ stationRef: s.stationRef, action: s.action });
  const withPark = (legs) => legs.map((l) => ({ ...l, parkNode: parkNodeFor(l.resourceId) }));

  // No per-step overrides and no hand-overs → one robot for the whole route
  if (!steps.some(stepHasOverride) && !allSteps.some(isHandoverStep)) {
    const { resourceId, fellBack } = resolveResourceForUnit(product, index);
    if (fellBack) warnings.add(fellBack);
    return { legs: withPark([{ resourceId, steps: steps.map(plain) }]), warnings: [...warnings] };
  }

  const legs = [];
  let pendingHandover = null;   // hand-over that must run before the next leg
  allSteps.forEach((step) => {
    // A hand-over is an instruction to the arm, not a SYNAOS milestone: it ends
    // the current leg and gates the next one.
    if (isHandoverStep(step)) {
      pendingHandover = { method: step.method || 'grasp', quantity };
      return;
    }
    const { resourceId, fellBack } = resolveStepResource(product, step, index);
    if (fellBack) warnings.add(fellBack);
    const last = legs[legs.length - 1];
    if (last && last.resourceId === resourceId && !pendingHandover) {
      last.steps.push(plain(step));
    } else {
      legs.push({ resourceId, steps: [plain(step)], armBefore: pendingHandover });
      pendingHandover = null;
    }
  });
  if (pendingHandover) warnings.add('handover-last');
  return { legs: withPark(legs), warnings: [...warnings] };
}

// A robot change mid-route means the load is physically handed over, which only
// works if the outgoing robot DROPs and the incoming robot PICKs at the same station.
function handoverIssues(product) {
  const steps = product.steps || [];
  const issues = [];
  steps.forEach((step, i) => {
    if (!isHandoverStep(step)) return;
    const prev = steps.slice(0, i).reverse().find((s) => !isHandoverStep(s));
    const next = steps.slice(i + 1).find((s) => !isHandoverStep(s));
    if (!prev || !next) {
      issues.push(`Step ${i + 1} is a hand-over but has no step ${prev ? 'after' : 'before'} it — the arm needs a load to move from one AGV to another.`);
      return;
    }
    if (prev.action !== 'DROP' || next.action !== 'PICK') {
      issues.push(`The hand-over at step ${i + 1} should sit between a <b>DROP</b> and a <b>PICK</b> — the outgoing AGV puts the load down and the incoming one takes it.`);
    } else if (prev.stationRef !== next.stationRef) {
      issues.push(`The hand-over at step ${i + 1} drops at <b>${escapeHtml(stationName(prev.stationRef))}</b> but picks up at <b>${escapeHtml(stationName(next.stationRef))}</b>. The arm moves the load between two AGVs at one place, so both should be the same station.`);
    }
  });
  return issues;
}

// Decides the robot for one ordered unit. Never returns a robot that cannot
// serve the route — an unreachable or unknown choice degrades to the scheduler.
function resolveResourceForUnit(product, index) {
  const choice = product.resourceId || AUTO_ANY;
  const { eligible, preferred } = eligibleRobotsForProduct(product);
  if (choice === AUTO_CAPABLE) {
    if (!preferred.length) return { resourceId: null, fellBack: 'no-capable' };
    return { resourceId: preferred[index % preferred.length], fellBack: null };
  }
  if (choice === AUTO_ANY) return { resourceId: null, fellBack: null };
  if (!eligible.includes(choice)) return { resourceId: null, fellBack: 'incapable' };
  return { resourceId: choice, fellBack: null };
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
  const ord = store.orders.find((o) => o.id === orderId);
  ratingDraft = ord && ord.ratings ? { ...ord.ratings } : {};
  showView('progress');
  renderProgress(null);
  startPolling();
}

// Applies the customer's star ratings to each product's running average
async function submitOrderRating(orderId) {
  const order = store.orders.find((o) => o.id === orderId);
  if (!order || order.rated) return;
  if (!order.items.every((i) => ratingDraft[i.productId] > 0)) {
    toast('Please rate every item first.', 'error');
    return;
  }
  order.items.forEach((it) => {
    const r = ratingDraft[it.productId];
    order.ratings[it.productId] = r;
    const p = store.products.find((x) => x.id === it.productId);
    if (p) {
      const count = p.ratingCount || 0;
      const sum = (p.rating || 0) * count;
      p.ratingCount = count + 1;
      p.rating = (sum + r) / p.ratingCount;   // new running average
    }
  });
  order.rated = true;
  await persist();
  renderCatalog();
  renderProgress(null);
  toast('Thanks for your rating! ⭐', 'success');
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
      // The order is delivered once the delivery milestones are done; the robot
      // driving off to its waiting spot afterwards must not hold the order open.
      return (d.milestones || []).filter((m) => !isWaitingSpotMilestone(m))
        .every((m) => milestonePhase(m) === 4);
    });
    const anyFailed = createdJobs.some((j) => {
      const d = liveJobs[j.jobId];
      return d && d.status === 'FINISHED_FAILURE';
    });
    if (allFinished && !order.confirmed && order.state !== 'completed') {
      order.state = 'completed';
      await persist();
      renderOrdersBadge();
      renderProgress(liveJobs, order);   // immediately reflect completion + show rating card
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

  // Rating card — shown once the order is completed
  const starsRow = (pid, value, interactive) =>
    [1, 2, 3, 4, 5].map((n) =>
      `<span class="star-pick ${n <= value ? 'on' : ''}" ${interactive ? `data-rate="${pid}" data-val="${n}"` : ''}>★</span>`).join('');

  let ratingBlock = '';
  if (completed) {
    if (order.rated) {
      const avg = order.items.reduce((s, i) => s + (order.ratings[i.productId] || 0), 0) / (order.items.length || 1);
      ratingBlock = `
        <div class="order-card">
          <h2 style="text-align:center;">Thanks for rating! ⭐</h2>
          <p class="hint" style="text-align:center;">You rated this order ${avg.toFixed(1)} on average.</p>
          ${order.items.map((i) => `
            <div class="rate-row">
              <div class="rate-name">${escapeHtml(i.name)}</div>
              <div class="stars-lg readonly">${starsRow(i.productId, order.ratings[i.productId] || 0, false)}</div>
            </div>`).join('')}
        </div>`;
    } else {
      const allRated = order.items.every((i) => ratingDraft[i.productId] > 0);
      ratingBlock = `
        <div class="order-card">
          <h2 style="text-align:center;">Rate your order</h2>
          <p class="hint" style="text-align:center;">Tap the stars to rate each item.</p>
          ${order.items.map((i) => `
            <div class="rate-row">
              <div class="rate-name">${escapeHtml(i.name)}</div>
              <div class="stars-lg">${starsRow(i.productId, ratingDraft[i.productId] || 0, true)}</div>
            </div>`).join('')}
          <div class="progress-actions" style="margin-top:14px;">
            <button class="btn btn-primary" id="submitRating" ${allRated ? '' : 'disabled'}>Submit rating</button>
          </div>
        </div>`;
    }
  }

  $('#progressWrap').innerHTML = `
    <div class="order-card">
      <h2>Order #${escapeHtml(order.shortId)}</h2>
      ${failNote}
      <div class="rail">${railHtml}</div>
      <div class="steps">${stepsHtml}</div>
    </div>
    ${confirmBlock}
    ${ratingBlock}
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
  $$('[data-rate]').forEach((el) => el.addEventListener('click', () => {
    ratingDraft[el.dataset.rate] = parseInt(el.dataset.val, 10);
    renderProgress(null);
  }));
  const submitBtn = $('#submitRating');
  if (submitBtn) submitBtn.addEventListener('click', () => submitOrderRating(order.id));
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

  // Which robots may serve this product's whole route
  const elig = eligibleRobotsForProduct(p);
  let resourceHint;
  if (!allRobotIds().length) {
    resourceHint = `<span class="fld-hint">No robots known yet — use <b>Read from SYNAOS</b> or <b>Add robot by ID</b> on the Stations tab.</span>`;
  } else if (!elig.eligible.length) {
    resourceHint = `<span class="fld-hint warn">⚠️ No known robot can reach every station on this route. Check the allowed robots for each station.</span>`;
  } else if (!p.resourceId || p.resourceId === AUTO_ANY) {
    resourceHint = `<span class="fld-hint warn">⚠️ With plain Auto, SYNAOS may pick a robot that can't reach these stations. Robots that can: <b>${escapeHtml(elig.eligible.join(', '))}</b>.</span>`;
  } else {
    resourceHint = `<span class="fld-hint">Can reach this route: <b>${escapeHtml(elig.eligible.join(', '))}</b>.</span>`;
  }

  // Per-step robot options: only robots allowed at that step's own station
  const stepRobotOpts = (step) => {
    const st = store.stations.find((x) => x.id === step.stationRef);
    const allowed = st ? robotsAllowedAtStation(st) : [];
    const blocked = allRobotIds().filter((id) => !allowed.includes(id));
    const sel = step.resourceId || STEP_INHERIT;
    return [
      `<option value="" ${sel === STEP_INHERIT ? 'selected' : ''}>Same as job</option>`,
      `<option value="${AUTO_CAPABLE}" ${sel === AUTO_CAPABLE ? 'selected' : ''}>Auto — capable here</option>`,
      ...allowed.map((id) => `<option value="${escapeHtml(id)}" ${sel === id ? 'selected' : ''}>${escapeHtml(id)}</option>`),
      ...blocked.map((id) => `<option value="${escapeHtml(id)}" disabled>${escapeHtml(id)} — no access</option>`)
    ].join('');
  };

  const stepsHtml = p.steps.map((s, i) => {
    if (isHandoverStep(s)) {
      return `
      <div class="step-editor-row handover-row">
        <span class="chip">${i + 1}</span>
        <span class="handover-label">🤝 Hand-over — robotic arm</span>
        <label class="inline-fld">method
          <input class="inp" data-ho-method="${i}" value="${escapeHtml(s.method || 'grasp')}" style="max-width:110px;">
        </label>
        <span class="inline-fld" title="The whole cart line travels in one trip, so the arm moves as many as the customer ordered">quantity: <b>from the order</b></span>
        <button class="link-btn danger" data-step-del="${i}">Remove</button>
      </div>`;
    }
    const prevReal = p.steps.slice(0, i).reverse().find((x) => !isHandoverStep(x));
    const changesRobot = prevReal &&
      (stepHasOverride(s) ? s.resourceId : '(job default)') !==
      (stepHasOverride(prevReal) ? prevReal.resourceId : '(job default)');
    return `
    ${changesRobot ? '<div class="leg-divider"><span>↕ robot changes — new job</span></div>' : ''}
    <div class="step-editor-row">
      <span class="chip">${i + 1}</span>
      <select class="inp" data-step-station="${i}">${stationOpts(s.stationRef)}</select>
      <select class="inp" data-step-action="${i}" style="max-width:120px;">${actionOpts(s.action)}</select>
      <select class="inp" data-step-robot="${i}" style="max-width:190px;" title="Robot for this step">${stepRobotOpts(s)}</select>
      <button class="link-btn danger" data-step-del="${i}" ${p.steps.filter((x) => !isHandoverStep(x)).length <= 1 ? 'style="visibility:hidden;"' : ''}>Remove</button>
    </div>`;
  }).join('');

  // Preview of how the route will be split into jobs
  // Previewed as if a customer ordered one; the arm's quantity follows the order
  const previewLegs = buildLegsForUnit(p, 0, 1).legs;
  const legPreview = previewLegs.length > 1
    ? `<div class="leg-preview">This route will be sent as <b>${previewLegs.length} chained jobs</b>:
        ${previewLegs.map((l, i) => `<div class="leg-line">${l.armBefore ? `<div class="leg-arm">🤝 arm: ${escapeHtml(l.armBefore.method)} × the ordered quantity — the next AGV waits for “${escapeHtml((store.settings.arm || {}).statusDoneValue || 'Finished')}”</div>` : ''}<span class="chip">Job ${i + 1}</span> <b>${escapeHtml(l.resourceId || 'SYNAOS decides')}</b> — ${escapeHtml(l.steps.map((x) => `${stationName(x.stationRef)}·${x.action}`).join(' → '))}${l.parkNode ? ` <span class="chip">then parks at ${escapeHtml(l.parkNode.id)}</span>` : ''}</div>`).join('')}
        <span class="fld-hint">Each job starts only after the previous one has finished.</span>
      </div>`
    : '';
  const issues = handoverIssues(p);
  const issuesHtml = issues.length
    ? `<div class="handover-warn">⚠️ ${issues.join('<br>⚠️ ')}</div>`
    : '';

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
        <label class="fld full">Assign robot (transport resource)
          <select class="inp" id="f-resource">
            <option value="${AUTO_CAPABLE}" ${p.resourceId === AUTO_CAPABLE ? 'selected' : ''}>Auto — only robots that can reach these stations (recommended)</option>
            <option value="" ${!p.resourceId || p.resourceId === AUTO_ANY ? 'selected' : ''}>Auto — let SYNAOS choose (may pick an unreachable robot)</option>
            ${elig.eligible.map((id) => {
              const r = (store.robots || []).find((x) => x.id === id) || { id };
              return `<option value="${escapeHtml(id)}" ${p.resourceId === id ? 'selected' : ''}>${escapeHtml(id)}${r.mode ? ' (' + escapeHtml(r.mode) + ')' : ''}</option>`;
            }).join('')}
            ${Object.keys(elig.blockedAt).map((id) =>
              `<option value="${escapeHtml(id)}" disabled>${escapeHtml(id)} — can't reach ${escapeHtml(elig.blockedAt[id])}</option>`).join('')}
          </select>
          ${resourceHint}
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
      <p class="hint">Executed in order. Each step = station + action + the robot that performs it. A step set to a different robot starts a new chained job, because SYNAOS runs every milestone of one job with the same robot.</p>
      <div class="steps-editor" id="stepsEditor">${stepsHtml}</div>
      <div class="row-actions" style="margin-top:8px;">
        <button class="link-btn add-step" id="addStep">+ Add step</button>
        <button class="link-btn add-step" id="addHandover">+ Add hand-over (robotic arm)</button>
      </div>
      ${issuesHtml}
      ${legPreview}
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
  $('#f-resource').addEventListener('change', (e) => { p.resourceId = e.target.value || null; renderAdmin(); });
  // Re-render on step edits: changing a station or action changes which robots are
  // allowed there and whether a hand-over boundary is still valid.
  $$('[data-step-station]', body).forEach((el) => el.addEventListener('change', (e) => {
    p.steps[+el.dataset.stepStation].stationRef = e.target.value; renderAdmin();
  }));
  $$('[data-step-action]', body).forEach((el) => el.addEventListener('change', (e) => {
    p.steps[+el.dataset.stepAction].action = e.target.value; renderAdmin();
  }));
  $$('[data-step-robot]', body).forEach((el) => el.addEventListener('change', (e) => {
    p.steps[+el.dataset.stepRobot].resourceId = e.target.value || STEP_INHERIT;
    renderAdmin();
  }));
  $$('[data-step-del]', body).forEach((el) => el.addEventListener('click', () => { p.steps.splice(+el.dataset.stepDel, 1); renderAdmin(); }));
  $('#addStep').addEventListener('click', () => {
    p.steps.push({ stationRef: store.stations[0] ? store.stations[0].id : '', action: 'MOVE', resourceId: STEP_INHERIT });
    renderAdmin();
  });
  $('#addHandover').addEventListener('click', () => {
    p.steps.push({ kind: 'handover', method: 'grasp', quantity: 1 });
    renderAdmin();
  });
  $$('[data-ho-method]', body).forEach((el) => el.addEventListener('change', (e) => {
    p.steps[+el.dataset.hoMethod].method = e.target.value.trim() || 'grasp';
    renderAdmin();
  }));
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
    const realSteps = p.steps.filter((s) => !isHandoverStep(s));
    if (!realSteps.length || realSteps.some((s) => !s.stationRef)) { toast('Each step needs a station.', 'error'); return; }
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
  const fns = ['production', 'storage', 'shop', 'charging', 'other'];
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
          <label class="fld">Function
            <select class="inp" data-st-fn="${s.id}">
              ${fns.map((f) => `<option value="${f}" ${f === s.fn ? 'selected' : ''}>${f}</option>`).join('')}
            </select>
          </label>
          <label class="fld">Address system
            <input class="inp" data-st-sys="${s.id}" value="${escapeHtml(s.system || 'STATION')}">
          </label>
        </div>
        <div class="fld" style="margin-top:10px;">
          Robots allowed at this station
          <div class="robot-chips">
            ${allRobotIds().length ? allRobotIds().map((rid) => {
              const cap = (store.capability || {})[stationKeyOf(s)] || { ok: [], no: [] };
              const provenNo = (cap.no || []).includes(rid);
              const provenOk = (cap.ok || []).includes(rid);
              const on = (s.allowedRobots || []).includes(rid);
              return `<label class="robot-chip ${on ? 'on' : ''} ${provenNo ? 'proven-no' : ''}" title="${provenNo ? 'SYNAOS reported UNABLE_TO_ACCESS_ADDRESS for this robot here' : provenOk ? 'Confirmed by a finished job' : ''}">
                <input type="checkbox" data-st-robot="${s.id}" value="${escapeHtml(rid)}" ${on ? 'checked' : ''}>
                ${escapeHtml(rid)}${provenNo ? ' ✖' : provenOk ? ' ✓' : ''}
              </label>`;
            }).join('') : '<span class="hint">No robots known yet.</span>'}
          </div>
          <span class="fld-hint">${(s.allowedRobots || []).length
            ? 'Only the ticked robots may be assigned here.'
            : (((store.capability || {})[stationKeyOf(s)] || {}).ok || []).length
              ? 'None ticked = only robots proven to work here (✓) are used. Tick to override.'
              : 'None ticked = any robot except those SYNAOS proved cannot reach it (✖).'}</span>
        </div>
        <div class="row-actions" style="margin-top:8px;">
          <button class="link-btn danger" data-st-del="${s.id}">Delete station</button>
        </div>
      </div>
    </div>`).join('');

  const robots = store.robots || [];
  const robotsHtml = robots.length
    ? robots.map((r) => {
      // Stations this robot is barred from, according to SYNAOS job history
      const cannot = Object.entries(store.capability || {})
        .filter(([, v]) => (v.no || []).includes(r.id))
        .map(([k]) => k.split('@')[0]);
      return `
      <div class="admin-item">
        <div class="thumb">🤖</div>
        <div class="grow">
          <div class="title-row">
            <span class="nm">${escapeHtml(r.id)}</span>
            ${r.mode ? `<span class="chip on">${escapeHtml(r.mode)}</span>` : '<span class="chip off">unknown mode</span>'}
            <span class="chip">${r.source === 'manual' ? 'added manually' : 'discovered'}</span>
          </div>
          <div class="desc">Supports: ${escapeHtml((r.supportedJobTypes || []).join(', ') || '—')}</div>
          ${cannot.length ? `<div class="desc" style="color:#d64545;">✖ Cannot reach: ${escapeHtml(cannot.join(', '))}</div>` : ''}
          <div class="form-grid" style="margin-top:10px;">
            <label class="fld">Waiting spot — node id
              <input class="inp" data-robot-home-id="${escapeHtml(r.id)}" value="${escapeHtml((r.homeNode && r.homeNode.id) || '')}" placeholder="e.g. 00">
            </label>
            <label class="fld">Waiting spot — navigation graph
              <input class="inp" data-robot-home-sys="${escapeHtml(r.id)}" value="${escapeHtml((r.homeNode && r.homeNode.system) || '')}" placeholder="e.g. TUSK/NODES">
            </label>
          </div>
          <span class="fld-hint">${(r.homeNode && r.homeNode.id)
            ? `After finishing its part of an order, ${escapeHtml(r.id)} drives to <b>${escapeHtml(r.homeNode.id)}</b> on <b>${escapeHtml(r.homeNode.system || 'STATION')}</b>.`
            : 'Leave empty to let the robot stay where it finished.'}</span>
          <div class="row-actions" style="margin-top:8px;">
            <button class="link-btn danger" data-robot-del="${escapeHtml(r.id)}">Remove</button>
          </div>
        </div>
      </div>`;
    }).join('')
    : '<p class="hint">No robots loaded yet. Click “Read from SYNAOS”, or add one by id below.</p>';

  body.innerHTML = `
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <h2>Stations</h2>
        <button class="btn btn-secondary" id="syncSynaos">⟳ Add from SYNAOS</button>
      </div>
      <p class="hint">Stations map a friendly name + function to a SYNAOS station address (used in job milestones). Function labels appear in the user's order-progress screen. “Add from SYNAOS” reads the real station addresses this tenant uses.</p>
      <div class="admin-list">${list || '<p class="hint">No stations yet.</p>'}</div>
      <button class="btn btn-primary" id="addStation" style="margin-top:16px;">+ Add station manually</button>
    </div>
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <h2>Robots (transport resources)</h2>
        <button class="btn btn-secondary" id="syncSynaos2">⟳ Read from SYNAOS</button>
      </div>
      <p class="hint">The AGVs/robots SYNAOS is using. Discovery only finds robots that already appear in jobs — add any others by id. ✖ marks stations SYNAOS reported the robot cannot reach.</p>
      <div class="admin-list">${robotsHtml}</div>
      <button class="btn btn-primary" id="addRobot" style="margin-top:16px;">+ Add robot by id</button>
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
  $$('[data-st-sys]', body).forEach((el) => el.addEventListener('change', async (e) => {
    store.stations.find((s) => s.id === el.dataset.stSys).system = e.target.value.trim() || 'STATION'; await persist();
  }));
  $$('[data-st-del]', body).forEach((el) => el.addEventListener('click', () => {
    confirmModal('Delete station?', 'Products using it will need their steps updated.', async () => {
      store.stations = store.stations.filter((s) => s.id !== el.dataset.stDel);
      await persist();
      renderAdminStations();
    });
  }));
  $$('[data-st-robot]', body).forEach((el) => el.addEventListener('change', async () => {
    const st = store.stations.find((s) => s.id === el.dataset.stRobot);
    st.allowedRobots = st.allowedRobots || [];
    if (el.checked) {
      if (!st.allowedRobots.includes(el.value)) st.allowedRobots.push(el.value);
    } else {
      st.allowedRobots = st.allowedRobots.filter((r) => r !== el.value);
    }
    await persist();
    renderAdminStations();
  }));
  const setHome = async (rid, patch) => {
    const robot = (store.robots || []).find((r) => r.id === rid);
    if (!robot) return;
    const home = { id: '', system: '', ...(robot.homeNode || {}), ...patch };
    robot.homeNode = home.id.trim() ? { id: home.id.trim(), system: (home.system || '').trim() || 'STATION' } : null;
    await persist();
    renderAdminStations();
  };
  $$('[data-robot-home-id]', body).forEach((el) =>
    el.addEventListener('change', () => setHome(el.dataset.robotHomeId, { id: el.value })));
  $$('[data-robot-home-sys]', body).forEach((el) =>
    el.addEventListener('change', () => setHome(el.dataset.robotHomeSys, { system: el.value })));
  $$('[data-robot-del]', body).forEach((el) => el.addEventListener('click', () => {
    const rid = el.dataset.robotDel;
    confirmModal('Remove robot?', `${rid} will be removed from the list and from any station's allowed robots.`, async () => {
      store.robots = (store.robots || []).filter((r) => r.id !== rid);
      store.stations.forEach((s) => { s.allowedRobots = (s.allowedRobots || []).filter((x) => x !== rid); });
      store.products.forEach((p) => { if (p.resourceId === rid) p.resourceId = AUTO_CAPABLE; });
      await persist();
      renderAdminStations();
    });
  }));
  $('#addRobot').addEventListener('click', addRobotByIdFlow);
  $('#addStation').addEventListener('click', async () => {
    store.stations.push({ id: uid('st'), stationId: 'NEW', name: 'New station', fn: 'other', system: 'STATION', allowedRobots: [] });
    await persist();
    renderAdminStations();
  });
  $('#syncSynaos').addEventListener('click', discoverFromSynaosFlow);
  $('#syncSynaos2').addEventListener('click', discoverFromSynaosFlow);
}

// Adds a robot that discovery cannot see, verifying the id against SYNAOS first.
function addRobotByIdFlow() {
  promptModal('Add robot by id', 'SYNAOS transport resource id (case-sensitive, e.g. kuka01)', 'text', '', async (val, close, setErr) => {
    const id = (val || '').trim();
    if (!id) { setErr('Enter a robot id.'); return; }
    if ((store.robots || []).some((r) => r.id === id)) { setErr('That robot is already in the list.'); return; }
    setErr('Checking with SYNAOS…');
    const res = await window.api.validateResource(id);
    if (!res.ok) { setErr('Could not reach SYNAOS: ' + (res.error || 'unknown error')); return; }
    if (!res.exists) { setErr(`SYNAOS has no resource “${id}”. Ids are case-sensitive.`); return; }
    store.robots = store.robots || [];
    store.robots.push({
      id, mode: res.mode, supportedJobTypes: res.supportedJobTypes, live: true, source: 'manual'
    });
    await persist();
    close();
    renderAdminStations();
    toast(`Added ${id} (${res.mode || 'unknown mode'})`, 'success');
  });
}

// Reads stations + robots live from SYNAOS and opens an import picker
async function discoverFromSynaosFlow() {
  const btns = [$('#syncSynaos'), $('#syncSynaos2')].filter(Boolean);
  btns.forEach((b) => { b.disabled = true; b.textContent = 'Reading SYNAOS…'; });
  let res;
  try {
    res = await window.api.discoverFromSynaos();
  } catch (e) {
    toast('Could not reach SYNAOS: ' + e.message, 'error');
    renderAdminStations();
    return;
  }
  if (!res.ok) {
    toast('SYNAOS read failed: ' + (res.error || 'HTTP ' + res.status), 'error');
    renderAdminStations();
    return;
  }
  // Cache robots + learned station access immediately.
  // Discovered robots are merged in, so manually added ones (e.g. a robot that has
  // never appeared in a job) are never dropped.
  const manual = (store.robots || []).filter((r) => r.source === 'manual');
  const discovered = (res.robots || []).map((r) => ({ ...r, source: 'discovered' }));
  const seen = new Set(discovered.map((r) => r.id));
  store.robots = [...discovered, ...manual.filter((r) => !seen.has(r.id))];
  store.capability = res.capability || {};
  await persist();
  openDiscoverModal(res);
}

function openDiscoverModal(res) {
  const existing = new Set(store.stations.map((s) => (s.stationId || '') + '|' + (s.system || 'STATION')));
  const rows = res.stations.map((st, i) => {
    const key = st.id + '|' + st.system;
    const already = existing.has(key);
    return `
      <label class="disc-row">
        <input type="checkbox" data-disc="${i}" ${already ? 'disabled' : 'checked'}>
        <span class="disc-id">${escapeHtml(st.id)}</span>
        <span class="chip ${st.system === 'STATION' ? 'on' : ''}">${escapeHtml(st.system)}</span>
        ${already ? '<span class="disc-note">already added</span>' : ''}
      </label>`;
  }).join('');

  const robotLines = (res.robots || []).map((r) =>
    `<span class="chip">${escapeHtml(r.id)}${r.mode ? ' · ' + escapeHtml(r.mode) : ''}</span>`).join(' ');

  const host = modalHost();
  host.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" style="max-width:560px;">
        <h3>Read from SYNAOS</h3>
        <p>Found <b>${res.stations.length}</b> station address(es) and <b>${(res.robots || []).length}</b> robot(s) across <b>${res.jobCount}</b> jobs. Pick the stations to import.</p>
        <div class="disc-list">${rows || '<p class="hint">No station addresses found in SYNAOS jobs.</p>'}</div>
        ${robotLines ? `<div style="margin-top:14px;"><div class="hint" style="margin-bottom:6px;">Robots (saved automatically):</div>${robotLines}</div>` : ''}
        <div class="modal-actions">
          <button class="btn btn-secondary" id="discCancel">Close</button>
          <button class="btn btn-primary" id="discImport">Import selected</button>
        </div>
      </div>
    </div>`;

  $('#discCancel').addEventListener('click', () => { closeModal(); renderAdminStations(); });
  $('#discImport').addEventListener('click', async () => {
    const picked = $$('[data-disc]').filter((c) => c.checked && !c.disabled).map((c) => res.stations[+c.dataset.disc]);
    let added = 0;
    picked.forEach((st) => {
      const key = st.id + '|' + st.system;
      if (store.stations.some((s) => (s.stationId || '') + '|' + (s.system || 'STATION') === key)) return;
      const fn = /shop|store/i.test(st.id) ? 'shop'
        : /(lg_|storage|lager)/i.test(st.id) ? 'storage'
        : /(charge|charging)/i.test(st.id) ? 'charging'
        : /(m\df|prod|vg_|qa_)/i.test(st.id) ? 'production' : 'other';
      store.stations.push({ id: uid('st'), stationId: st.id, name: st.id, fn, system: st.system });
      added++;
    });
    await persist();
    closeModal();
    renderCatalog();
    renderAdminStations();
    toast(added ? `Imported ${added} station(s) from SYNAOS` : 'Nothing new to import', added ? 'success' : undefined);
  });
}

// ---- Admin: settings ----
function renderAdminSettings() {
  const body = $('#adminBody');
  const s = store.settings;
  const a = s.arm || {};
  const m = s.mpdv || {};
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
      <h2>MPDV production orders</h2>
      <p class="hint">Used when the shop is set to <b>MPDV</b>. Each cart line becomes a workplan order; the ordered quantity becomes <code>plan.yield.base</code>.</p>
      <div class="form-grid">
        <label class="fld full">Endpoint
          <input class="inp" id="m-endpoint" value="${escapeHtml(m.endpoint || '')}">
        </label>
        <label class="fld">Username
          <input class="inp" id="m-user" value="${escapeHtml(m.username || '')}">
        </label>
        <label class="fld">Password
          <input class="inp" id="m-pass" type="password" value="${escapeHtml(m.password || '')}">
        </label>
        <label class="fld switch full">
          <input type="checkbox" id="m-tls" ${m.tlsInsecure ? 'checked' : ''}> Don't validate the TLS certificate
          <span class="fld-hint">Needed here: the host serves a valid DigiCert certificate but not its full chain.</span>
        </label>
        <label class="fld">workplanorder.id
          <input class="inp" id="m-woid" value="${escapeHtml(m.workplanOrderId || '')}">
          <span class="fld-hint">Sent unchanged on every order.</span>
        </label>
        <label class="fld">ordertype
          <input class="inp" id="m-otype" value="${escapeHtml(m.orderType || '')}">
        </label>
        <label class="fld full">latest_end_ts (deadline)
          <input class="inp" id="m-end" value="${escapeHtml(m.latestEndTs || '')}">
          <span class="fld-hint">Sent as-is, e.g. <code>2026-08-05T00:00:00.000+08:00</code>.</span>
        </label>
        <label class="fld">language
          <input class="inp" id="m-lang" value="${escapeHtml(m.language || 'en')}">
        </label>
        <label class="fld">timeZoneId
          <input class="inp" id="m-tz" value="${escapeHtml(m.timeZoneId || 'Asia/Singapore')}">
          <span class="fld-hint">Also decides which day the order number belongs to.</span>
        </label>
      </div>
      <div class="progress-actions" style="margin-top:16px; align-items:center; flex-wrap:wrap;">
        <button class="btn btn-secondary" id="saveMpdv">Save MPDV settings</button>
        <span class="api-status" id="mpdvNext"></span>
      </div>
      <div class="arm-log-title">Order log — did it reach MPDV?</div>
      <div id="mpdvLog" class="arm-log"></div>
      <button class="link-btn" id="clearMpdvLog">Clear log</button>
    </div>
    <div class="panel">
      <h2>Robotic arm (MQTT)</h2>
      <p class="hint">When a route changes robot, the arm moves the load between the two AGVs at the hand-over station. The receiving AGV's job is only created once the arm reports the transfer done.</p>
      <label class="fld switch" style="margin-bottom:14px;">
        <input type="checkbox" id="a-enabled" ${a.enabled ? 'checked' : ''}> Use the robotic arm for hand-overs
      </label>
      <div class="form-grid">
        <label class="fld full">Broker URL
          <input class="inp" id="a-url" value="${escapeHtml(a.brokerUrl || '')}" placeholder="mqtt://192.168.1.50:1883">
          <span class="fld-hint">mqtt:// · mqtts:// (TLS) · ws:// · wss:// are all supported.</span>
        </label>
        <label class="fld switch full">
          <input type="checkbox" id="a-tlsinsecure" ${a.tlsInsecure ? 'checked' : ''}> Don't validate the broker's TLS certificate
          <span class="fld-hint">Match this to “Validate certificate” being off in MQTT Explorer.</span>
        </label>
        <label class="fld">Username
          <input class="inp" id="a-user" value="${escapeHtml(a.username || '')}" placeholder="(optional)">
        </label>
        <label class="fld">Password
          <input class="inp" id="a-pass" type="password" value="${escapeHtml(a.password || '')}" placeholder="(optional)">
        </label>
        <label class="fld">Command topic
          <input class="inp" id="a-cmd" value="${escapeHtml(a.commandTopic || '')}" placeholder="arm/command">
        </label>
        <label class="fld">Status topic
          <input class="inp" id="a-stat" value="${escapeHtml(a.statusTopic || '')}" placeholder="arm/status">
        </label>
        <label class="fld full">Command payload
          <textarea class="inp" id="a-tpl" rows="6" spellcheck="false">${escapeHtml(a.payloadTemplate || '')}</textarea>
          <span class="fld-hint">Placeholders: <code>{from}</code> <code>{to}</code> <code>{orderId}</code> <code>{unitId}</code> <code>{transferId}</code> — rename the JSON fields to whatever the arm expects.</span>
        </label>
        <label class="fld">Status field
          <input class="inp" id="a-sfield" value="${escapeHtml(a.statusField || '')}" placeholder="status">
          <span class="fld-hint">JSON field to read. Leave blank to match the raw text.</span>
        </label>
        <label class="fld">“Finished” value
          <input class="inp" id="a-sdone" value="${escapeHtml(a.statusDoneValue || '')}" placeholder="done">
        </label>
        <label class="fld">Transfer-id field
          <input class="inp" id="a-smatch" value="${escapeHtml(a.statusMatchField || '')}" placeholder="transferId">
          <span class="fld-hint">If the arm echoes this back, statuses are matched to the right transfer.</span>
        </label>
        <label class="fld">Timeout (seconds)
          <input class="inp" id="a-timeout" type="number" min="5" step="5" value="${Number(a.timeoutSeconds) || 120}">
          <span class="fld-hint">If the arm stays silent this long, the order continues anyway.</span>
        </label>
      </div>
      <div class="progress-actions" style="margin-top:16px; align-items:center; flex-wrap:wrap;">
        <button class="btn btn-secondary" id="saveArm">Save arm settings</button>
        <button class="btn btn-secondary" id="testArm">Test connection</button>
        <button class="btn btn-secondary" id="testArmPub">Send test transfer</button>
        <span class="api-status" id="armStatus"><span class="dot"></span> Not tested</span>
      </div>
      <div id="armLog" class="arm-log"></div>
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
  // ---- MPDV ----
  const readMpdvForm = () => ({
    endpoint: $('#m-endpoint').value.trim(),
    username: $('#m-user').value,
    password: $('#m-pass').value,
    tlsInsecure: $('#m-tls').checked,
    workplanOrderId: $('#m-woid').value.trim(),
    orderType: $('#m-otype').value.trim(),
    latestEndTs: $('#m-end').value.trim(),
    language: $('#m-lang').value.trim() || 'en',
    timeZoneId: $('#m-tz').value.trim() || 'Asia/Singapore'
  });
  const showMpdvState = async () => {
    const [preview, log] = await Promise.all([window.api.mpdvPreview(), window.api.mpdvLog()]);
    $('#mpdvNext').innerHTML = `<span class="dot ok"></span> Next order no. <b>${escapeHtml(preview.orderNumber)}</b>
      — ${preview.usedToday} used today, ${preview.remainingToday} left`;
    $('#mpdvLog').innerHTML = log.length
      ? log.map((l) => `<div class="arm-log-row">
          <span class="dir ${l.ok ? 'in' : 'out'}">${l.ok ? '✅ sent' : '❌ failed'}</span>
          <code>${escapeHtml(l.orderNumber || '—')}</code>
          <span class="msg">${escapeHtml(l.productName || '')} ×${l.quantity}
            ${l.ok ? '' : '— ' + escapeHtml(l.error || '')}
            <span style="opacity:.6">${escapeHtml(new Date(l.at).toLocaleString())}</span></span>
        </div>`).join('')
      : '<p class="hint">No MPDV orders sent yet.</p>';
  };
  $('#saveMpdv').addEventListener('click', async () => {
    store.settings.mpdv = Object.assign({}, store.settings.mpdv, readMpdvForm());
    await persist();
    showMpdvState();
    toast('MPDV settings saved', 'success');
  });
  $('#clearMpdvLog').addEventListener('click', async () => {
    await window.api.mpdvClearLog();
    showMpdvState();
  });
  showMpdvState();

  // ---- Robotic arm ----
  const readArmForm = () => ({
    enabled: $('#a-enabled').checked,
    brokerUrl: $('#a-url').value.trim(),
    tlsInsecure: $('#a-tlsinsecure').checked,
    username: $('#a-user').value,
    password: $('#a-pass').value,
    commandTopic: $('#a-cmd').value.trim(),
    statusTopic: $('#a-stat').value.trim(),
    payloadTemplate: $('#a-tpl').value,
    statusField: $('#a-sfield').value.trim(),
    statusDoneValue: $('#a-sdone').value.trim(),
    statusMatchField: $('#a-smatch').value.trim(),
    timeoutSeconds: parseInt($('#a-timeout').value, 10) || 120
  });
  const armStatusEl = () => $('#armStatus');
  const showArmLog = async () => {
    const st = await window.api.armStatus();
    const rows = (st.log || []).map((l) =>
      `<div class="arm-log-row"><span class="dir ${l.direction}">${l.direction === 'out' ? '▲ sent' : '▼ recv'}</span>
        <code>${escapeHtml(l.topic)}</code><span class="msg">${escapeHtml(l.message)}</span></div>`).join('');
    const pend = (st.pending || []).map((p) =>
      `<div class="arm-log-row"><span class="dir">⏳</span><span class="msg">${escapeHtml(p.productName)} — leg ${p.leg}/${p.totalLegs}, ${escapeHtml(p.state)}${p.lastError ? ' — ' + escapeHtml(p.lastError) : ''}</span></div>`).join('');
    $('#armLog').innerHTML = (pend ? `<div class="arm-log-title">Hand-overs in progress</div>${pend}` : '')
      + (rows ? `<div class="arm-log-title">Recent MQTT traffic</div>${rows}` : '');
  };

  $('#saveArm').addEventListener('click', async () => {
    store.settings.arm = Object.assign({}, store.settings.arm, readArmForm());
    await persist();
    toast('Arm settings saved', 'success');
  });
  $('#testArm').addEventListener('click', async () => {
    armStatusEl().innerHTML = '<span class="dot"></span> Connecting…';
    const res = await window.api.armTest(readArmForm());
    armStatusEl().innerHTML = res.ok
      ? `<span class="dot ok"></span> Connected${res.subscribed ? ' · subscribed to ' + escapeHtml(res.subscribed) : ''}`
      : `<span class="dot bad"></span> ${escapeHtml(res.error || 'Failed')}`;
    showArmLog();
  });
  $('#testArmPub').addEventListener('click', async () => {
    armStatusEl().innerHTML = '<span class="dot"></span> Publishing test transfer…';
    const res = await window.api.armTestPublish(readArmForm());
    armStatusEl().innerHTML = res.ok
      ? (res.via === 'status'
        ? '<span class="dot ok"></span> Arm confirmed the transfer'
        : `<span class="dot bad"></span> Published, but no confirmation (${escapeHtml(res.via)})`)
      : `<span class="dot bad"></span> ${escapeHtml(res.error || 'Failed')}`;
    showArmLog();
  });
  showArmLog();

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
