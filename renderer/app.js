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

// Clock time for a timeline entry — quieter than repeating "Completed".
function shortTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Date and time under a rail stop, e.g. "05-08 15:04"
function shortDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Pretty-prints a JSON string when it is JSON; otherwise returns it untouched,
// so a non-JSON error page is still shown exactly as MPDV sent it.
function prettyJson(text) {
  if (typeof text !== 'string' || !text.trim()) return String(text || '');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    return text;
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function persist() {
  await window.api.storeSet(store);
}

// Hand-overs are bookkept by the relay supervisor in the main process, which
// writes the same store file. Creating jobs can add a pending relay there, so
// re-read that list before the next persist() writes our older copy over it.
async function syncRelaysFromMain() {
  try {
    const fresh = await window.api.storeGet();
    store.pendingRelays = fresh.pendingRelays || [];
  } catch (e) {
    /* keep what we have; the relay:changed event will correct it */
  }
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
  // Recalls that run themselves keep ticking wherever the operator is in the app
  startAutoRecalls();
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
  // Pulling the setup is the first thing a fresh install wants, so it is offered
  // here rather than only behind the admin password.
  $('#startSync').addEventListener('click', (e) => {
    const y = store.settings.sync || {};
    if (!y.repo) { toast('No repository is set — add one in Admin → Settings.', 'error'); return; }
    confirmModal('Load this shop\'s setup?',
      `Products, stations, robots, nodes and recalls will be taken from ${escapeHtml(y.repo)}, replacing whatever is on this machine.`,
      () => loadSetupFromGitHub({
        repo: y.repo, branch: y.branch, path: y.path, token: y.token, passphrase: y.passphrase
      }, e.target));
  });
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
    await syncRelaysFromMain();
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

// MPDV keeps this id in an 8-character field, so what it stored can be a
// truncated version of what we sent — say so plainly rather than let it pass.
function mpdvCreatedIdNote(entry) {
  if (!entry.createdId) return '';
  const same = entry.orderNumber && entry.createdId === entry.orderNumber;
  return same
    ? ` — MPDV created <b>${escapeHtml(entry.createdId)}</b>`
    : ` — <span class="mpdv-id-warn">MPDV stored it as <b>${escapeHtml(entry.createdId)}</b></span>`;
}

function renderMpdvResult(results, total) {
  const okCount = results.filter((r) => r.ok).length;
  const rows = results.map((r) => `
    <div class="oi-row">
      <div class="thumb">${r.ok ? '✅' : '⚠️'}</div>
      <div class="nm">
        ${escapeHtml(r.productName || '(item)')}
        <div class="tl-meta">${r.orderNumber
          ? `Order no. <b>${escapeHtml(r.orderNumber)}</b>`
          : 'No order number was issued'}${mpdvCreatedIdNote(r)}</div>
        ${r.ok ? '' : `<div class="err-text">${escapeHtml(r.error || 'Rejected by MPDV')}</div>`}
        ${r.response ? `<details class="mpdv-log-raw"><summary>What MPDV replied (HTTP ${r.status === 0 ? 'no reply' : r.status})</summary><pre>${escapeHtml(prettyJson(r.response))}</pre></details>` : ''}
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

// An order counts as delivered the moment its delivery milestones are done.
// A recall's countdown hangs off that timestamp, so it is stamped in one place
// no matter who noticed the delivery — the progress screen or the background
// watcher that keeps running when nobody is looking at it.
function markOrderDelivered(order) {
  const already = order.state === 'completed' && order.completedAt;
  order.state = 'completed';
  if (!order.completedAt) order.completedAt = new Date().toISOString();
  return !already;
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
  let noted = false;
  await Promise.all(order.jobs.filter((j) => j.created && j.jobId).map(async (j) => {
    try {
      const res = await window.api.getJob(j.jobId);
      if (res && res.ok && res.data) {
        liveJobs[j.jobId] = res.data;
        if (noteAssignedResource(order, j.jobId, res.data)) noted = true;
      }
    } catch (e) { /* ignore transient */ }
  }));
  if (noted) await persist();   // which AGV ran it — a recall may be waiting on that
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
      markOrderDelivered(order);
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
  const stepTimes = [];
  const stepPhase = flow.map((step, stepIndex) => {
    let minPhase = 4;
    let anySeen = false;
    let when = null;
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
          // When it actually happened, so the timeline can show a time rather
          // than repeating the word "Completed" on every line.
          const finished = (m.eventHistory || []).find((e) => e.name === 'MILESTONE_FINISHED');
          const stamp = (finished && finished.time) || m.finishTime;
          if (stamp && !when) when = stamp;
        }
      });
    });
    stepTimes[stepIndex] = when;
    return anySeen ? minPhase : 0;
  });

  const completed = order.confirmed || order.state === 'completed';
  const failed = order.state === 'failed';

  // Every step is a stop on the rail: a short label and its time sit under the
  // icon, and one status line underneath says what is happening right now.
  const stepLines = [];
  stepLines.push({
    icon: '🧾',
    label: 'Order placed',
    place: order.items.map((i) => `${i.qty}× ${i.name}`).join(', '),
    text: 'Order placed',
    state: 'done',
    at: order.createdAt
  });

  flow.forEach((step, idx) => {
    const nm = stationName(step.stationRef);
    const fn = stationFn(step.stationRef);
    const dest = fn ? `${nm} (${fn})` : nm;
    const ph = stepPhase[idx];
    const done = completed || ph === 4;
    const active = !done && ph >= 1;

    const words = step.action === 'PICK'
      ? { done: 'Picked up', now: 'Picking up', soon: 'Pick up', sentence: 'at' }
      : step.action === 'DROP'
        ? { done: 'Delivered', now: 'Delivering', soon: 'Deliver', sentence: 'to' }
        : { done: 'Arrived', now: 'Moving', soon: 'Move', sentence: 'to' };

    const st = store.stations.find((s) => s.id === step.stationRef);
    stepLines.push({
      icon: step.action === 'PICK' ? '📦' : step.action === 'DROP' ? '🏭' : '🚚',
      iconImage: (st && st.image) || null,      // the station's own picture, when set
      label: done ? words.done : active ? words.now : words.soon,
      place: nm,
      text: `${done ? words.done : active ? words.now : words.soon} ${words.sentence} ${dest}`,
      state: done ? 'done' : active ? 'active' : 'pending',
      at: stepTimes[idx] || null
    });
  });

  stepLines.push({
    icon: completed ? '🎉' : '🏁',
    label: 'Completed',
    place: completed ? 'Enjoy your treat' : '',
    text: completed ? 'Delivered — enjoy your treat' : 'Order complete',
    state: completed ? 'done' : 'pending'
  });

  // Past a certain number of stops the station line is dropped so the labels
  // stay readable while everything still fits across the card.
  const dense = stepLines.length > 8;
  const railHtml = stepLines.map((s) => `
    <div class="rail-node ${s.state}">
      <div class="rail-dot">${s.iconImage
        ? `<img src="${escapeHtml(s.iconImage)}" alt="">`
        : s.icon}</div>
      <div class="rail-label">${escapeHtml(s.label)}</div>
      ${s.place ? `<div class="rail-place">${escapeHtml(s.place)}</div>` : ''}
      <div class="rail-time">${s.at ? escapeHtml(dense ? shortTime(s.at) : shortDateTime(s.at)) : ''}</div>
    </div>`).join('');

  // The parcel sits on the last finished stop, or halfway to the one under way,
  // so it advances between stops rather than jumping from icon to icon.
  const lastDone = stepLines.reduce((acc, s, i) => (s.state === 'done' ? i : acc), -1);
  const activeIdx = stepLines.findIndex((s) => s.state === 'active');
  const span = Math.max(1, stepLines.length - 1);
  const position = activeIdx >= 0 ? activeIdx - 0.5 : Math.max(lastDone, 0);
  const progress = Math.max(0, Math.min(1, position / span));
  const moving = activeIdx >= 0;

  // One line that changes as the order moves on
  const current = stepLines.find((s) => s.state === 'active')
    || [...stepLines].reverse().find((s) => s.state === 'done')
    || stepLines[0];
  const nextUp = stepLines.find((s) => s.state === 'pending');
  const statusHtml = `
    <div class="status-line ${completed ? 'done' : moving ? 'moving' : 'waiting'}">
      <span class="status-icon">${completed ? '🎉' : moving ? '🚚' : '⏳'}</span>
      <div class="status-body">
        <div class="status-now">${escapeHtml(completed ? 'Delivered — enjoy your treat' : current.text)}</div>
        ${!completed && nextUp ? `<div class="status-next">Next: ${escapeHtml(nextUp.text)}</div>` : ''}
      </div>
      ${!completed && moving ? '<span class="status-pips"><i></i><i></i><i></i></span>' : ''}
    </div>`;

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
      <div class="rail-scroll">
        <div class="rail ${dense ? 'dense' : ''}" style="--stops:${stepLines.length}">
          <div class="rail-line">
            <div class="rail-line-fill" style="width:${(progress * 100).toFixed(1)}%"></div>
            <div class="rail-traveller ${moving ? 'moving' : ''} ${completed ? 'arrived' : ''}" style="left:${(progress * 100).toFixed(1)}%">
              <span class="rail-parcel">📦</span>
            </div>
          </div>
          ${railHtml}
        </div>
      </div>
      ${statusHtml}
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
  markOrderDelivered(order);
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
      <button class="tab-btn ${adminTab === 'recalls' ? 'active' : ''}" data-tab="recalls">Recalls</button>
      <button class="tab-btn ${adminTab === 'stations' ? 'active' : ''}" data-tab="stations">Stations</button>
      <button class="tab-btn ${adminTab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
    </div>
    <div id="adminBody"></div>`;
  $('#lockAdmin').addEventListener('click', () => { adminUnlocked = false; showView('shop'); });
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { adminTab = b.dataset.tab; renderAdmin(); }));

  if (adminTab === 'products') renderAdminProducts();
  else if (adminTab === 'recalls') renderAdminRecalls();
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

// ---- Admin: recalls ----
//
// A recall is a route the admin runs on demand — typically fetching an empty
// rack back from the shop to production. It uses the same job machinery as an
// order (relays, hand-overs, waiting spots, robot access) but never appears in
// the shop, so a customer order does not have to include a return trip.
let recallDraft = null;

function renderAdminRecalls() {
  const body = $('#adminBody');
  if (recallDraft) { renderRecallEditor(body); return; }

  const list = (store.recalls || []).map((r) => {
    const desc = (r.steps || []).map((s) => `${stationName(s.stationRef)}·${s.action}`).join(' → ') || 'No steps';
    const { eligible } = eligibleRobotsForProduct(r);
    return `
      <div class="admin-item">
        <div class="thumb">↩️</div>
        <div class="grow">
          <div class="title-row">
            <span class="nm">${escapeHtml(r.name || 'Recall')}</span>
            <span class="chip">${escapeHtml(r.resourceId && r.resourceId !== AUTO_CAPABLE && r.resourceId !== AUTO_ANY
              ? r.resourceId : eligible.length ? 'auto — ' + eligible.join(', ') : 'auto')}</span>
          </div>
          <div class="desc">🚚 ${escapeHtml(desc)}</div>
          <div class="row-actions" style="margin-top:10px;">
            <button class="btn btn-primary" data-rc-send="${r.id}">▶ Send recall now</button>
            <button class="link-btn" data-rc-edit="${r.id}">Edit</button>
            <button class="link-btn danger" data-rc-del="${r.id}">Delete</button>
          </div>
          <div class="auto-box">
            <label class="switch">
              <input type="checkbox" data-rc-auto="${r.id}" ${autoCfg(r).enabled ? 'checked' : ''}>
              Run this recall after an order is delivered
            </label>
            <label class="inline-fld">wait
              <input class="inp" type="number" min="${AUTO_MIN_MINUTES}" max="${AUTO_MAX_MINUTES}" step="1"
                data-rc-every="${r.id}" value="${Number(autoCfg(r).everyMinutes)}" style="max-width:80px;">
              minutes <span class="hint" style="margin:0;">after the last order was delivered</span>
            </label>
            <label class="inline-fld">triggered by
              <select class="inp" data-rc-trigger="${r.id}" style="max-width:230px;">
                <option value="any" ${autoCfg(r).triggerMode === 'any' ? 'selected' : ''}>any delivered order</option>
                <option value="product" ${autoCfg(r).triggerMode === 'product' ? 'selected' : ''}>deliveries of chosen products</option>
                <option value="robot" ${autoCfg(r).triggerMode === 'robot' ? 'selected' : ''}>deliveries by chosen robots</option>
              </select>
            </label>
            <label class="switch">
              <input type="checkbox" data-rc-idle="${r.id}" ${autoCfg(r).onlyWhenIdle ? 'checked' : ''}>
              Only when no customer order is running
            </label>
            ${triggerPicks(r)}
            <label class="switch">
              <input type="checkbox" data-rc-ask="${r.id}" ${autoCfg(r).askBefore ? 'checked' : ''}>
              Warn the shop 30 s before, and let them put it off by
            </label>
            <span class="delay-opts">
              ${autoCfg(r).delayOptions.map((m, i) => `
                <input class="inp" type="number" min="1" max="${AUTO_MAX_MINUTES}" step="1"
                  data-rc-delay="${r.id}" data-slot="${i}" value="${m}"
                  ${autoCfg(r).askBefore ? '' : 'disabled'} style="max-width:64px;">`).join('')}
              <span class="hint" style="margin:0;">minutes</span>
            </span>
            <div class="auto-status" data-rc-auto-status="${r.id}">${escapeHtml(autoStatusText(r))}</div>
          </div>
        </div>
      </div>`;
  }).join('');

  const log = (store.recallLog || []).slice(0, 12).map((l) => `
    <div class="arm-log-row">
      <span class="dir ${l.note ? '' : l.ok ? 'in' : 'out'}">${l.note ? '⏸ waited' : l.ok ? '✅ sent' : '❌ failed'}</span>
      <span class="msg">${l.auto ? '⏱ ' : ''}${escapeHtml(l.name)}${l.robot ? ' — ' + escapeHtml(l.robot) : ''}
        ${l.note ? '— ' + escapeHtml(l.note) : l.ok ? '' : '— ' + escapeHtml(l.error || '')}
        <span style="opacity:.6">${escapeHtml(new Date(l.at).toLocaleString())}</span></span>
    </div>`).join('');

  body.innerHTML = `
    <div class="panel">
      <h2>Recalls</h2>
      <p class="hint">Routes you run on demand — fetching a rack back from the shop to production, returning an empty carrier, repositioning a load. They never show in the shop, so an order can simply deliver without also hauling everything back.</p>
      <p class="hint">A recall can also run itself: the countdown starts when a customer <b>order is delivered</b>, so the rack comes back a set time after it went out. Another delivery while waiting pushes the run back rather than adding a second one, and nothing is ever sent while this recall's own last run is still driving. The app has to stay open for it to run.</p>
      <div class="admin-list">${list || '<p class="hint">No recalls yet. Add one below.</p>'}</div>
      <button class="btn btn-primary" id="addRecall" style="margin-top:16px;">+ New recall</button>
      ${(store.recallLog || []).length ? `<div class="arm-log-title">Recently sent</div><div class="arm-log">${log}</div>` : ''}
    </div>`;

  $('#addRecall').addEventListener('click', () => {
    // Prefill the obvious direction: from wherever the shop is, back to production
    const shop = store.stations.find((s) => s.fn === 'shop');
    const prod = store.stations.find((s) => s.fn === 'production');
    const first = store.stations[0];
    recallDraft = {
      id: uid('rc'),
      name: 'Bring the rack back',
      resourceId: AUTO_CAPABLE,
      steps: [
        { stationRef: (shop || first || {}).id || '', action: 'PICK', resourceId: STEP_INHERIT },
        { stationRef: (prod || first || {}).id || '', action: 'DROP', resourceId: STEP_INHERIT }
      ],
      _new: true
    };
    renderAdmin();
  });
  $$('[data-rc-edit]', body).forEach((el) => el.addEventListener('click', () => {
    recallDraft = JSON.parse(JSON.stringify((store.recalls || []).find((r) => r.id === el.dataset.rcEdit)));
    renderAdmin();
  }));
  $$('[data-rc-del]', body).forEach((el) => el.addEventListener('click', () => {
    confirmModal('Delete recall?', 'This only removes the saved route; jobs already sent are unaffected.', async () => {
      store.recalls = (store.recalls || []).filter((r) => r.id !== el.dataset.rcDel);
      await persist();
      renderAdminRecalls();
    });
  }));
  $$('[data-rc-send]', body).forEach((el) => el.addEventListener('click', () => sendRecall(el.dataset.rcSend, el)));

  const findRecall = (id) => (store.recalls || []).find((r) => r.id === id);
  $$('[data-rc-auto]', body).forEach((el) => el.addEventListener('change', async () => {
    const r = findRecall(el.dataset.rcAuto);
    if (!r) return;
    autoCfg(r).enabled = el.checked;
    // Switching it on starts a fresh countdown — never an immediate send, which
    // is the one thing an operator would not expect from ticking a box.
    if (el.checked) armAutoRecall(r);
    await persist();
    renderAdminRecalls();
    toast(el.checked
      ? `Automatic runs on — ${autoCfg(r).everyMinutes} min after ${triggerSummary(r) || 'the trigger you pick'}`
      : 'Automatic runs off', 'success');
  }));
  $$('[data-rc-every]', body).forEach((el) => el.addEventListener('change', async () => {
    const r = findRecall(el.dataset.rcEvery);
    if (!r) return;
    const mins = Math.min(AUTO_MAX_MINUTES, Math.max(AUTO_MIN_MINUTES, Math.round(Number(el.value) || 0)));
    autoCfg(r).everyMinutes = mins;
    // A countdown already running is re-measured from the delivery that started
    // it, so changing the wait adjusts it instead of throwing it away.
    const st = autoState(r);
    if (st.armedAt) st.nextDueAt = new Date(new Date(st.armedAt).getTime() + autoIntervalMs(r)).toISOString();
    await persist();
    renderAdminRecalls();
  }));
  $$('[data-rc-idle]', body).forEach((el) => el.addEventListener('change', async () => {
    const r = findRecall(el.dataset.rcIdle);
    if (!r) return;
    autoCfg(r).onlyWhenIdle = el.checked;
    await persist();
    renderAdminRecalls();
  }));
  $$('[data-rc-trigger]', body).forEach((el) => el.addEventListener('change', async () => {
    const r = findRecall(el.dataset.rcTrigger);
    if (!r) return;
    autoCfg(r).triggerMode = el.value;
    // A pending countdown was armed under the old rule, so drop it and wait for
    // a delivery that matches the new one.
    if (autoCfg(r).enabled) armAutoRecall(r);
    await persist();
    renderAdminRecalls();
  }));
  const togglePick = async (el, key) => {
    const r = findRecall(el.dataset.rcTp || el.dataset.rcTr);
    if (!r) return;
    const list = autoCfg(r)[key];
    const at = list.indexOf(el.value);
    if (el.checked && at < 0) list.push(el.value);
    if (!el.checked && at >= 0) list.splice(at, 1);
    if (autoCfg(r).enabled) armAutoRecall(r);
    await persist();
    renderAdminRecalls();
  };
  $$('[data-rc-tp]', body).forEach((el) => el.addEventListener('change', () => togglePick(el, 'triggerProducts')));
  $$('[data-rc-tr]', body).forEach((el) => el.addEventListener('change', () => togglePick(el, 'triggerRobots')));
  $$('[data-rc-ask]', body).forEach((el) => el.addEventListener('change', async () => {
    const r = findRecall(el.dataset.rcAsk);
    if (!r) return;
    autoCfg(r).askBefore = el.checked;
    if (!el.checked) dismissRecallAsk();
    await persist();
    renderAdminRecalls();
  }));
  $$('[data-rc-delay]', body).forEach((el) => el.addEventListener('change', async () => {
    const r = findRecall(el.dataset.rcDelay);
    if (!r) return;
    const mins = Math.min(AUTO_MAX_MINUTES, Math.max(1, Math.round(Number(el.value) || 0)));
    autoCfg(r).delayOptions[Number(el.dataset.slot)] = mins;
    await persist();
    renderAdminRecalls();
  }));
}

// The products / robots a recall answers to, as a row of tick boxes. Only shown
// once the operator has narrowed the trigger down from "any delivered order".
function triggerPicks(recall) {
  const cfg = autoCfg(recall);
  if (cfg.triggerMode === 'any') return '';
  const items = cfg.triggerMode === 'product'
    ? store.products.map((p) => ({ id: p.id, label: p.name, on: cfg.triggerProducts.includes(p.id) }))
    : allRobotIds().map((id) => ({ id, label: id, on: cfg.triggerRobots.includes(id) }));
  if (!items.length) {
    return `<div class="auto-picks"><span class="hint" style="margin:0;">${cfg.triggerMode === 'product'
      ? 'No products defined yet.' : 'No robots added yet.'}</span></div>`;
  }
  const attr = cfg.triggerMode === 'product' ? 'data-rc-tp' : 'data-rc-tr';
  return `<div class="auto-picks">${items.map((it) => `
    <label class="switch">
      <input type="checkbox" ${attr}="${recall.id}" value="${escapeHtml(it.id)}" ${it.on ? 'checked' : ''}>
      ${escapeHtml(it.label)}
    </label>`).join('')}</div>`;
}

// Dispatches a recall down the same path as an order: legs are planned from the
// robot each step is allowed to use, then created as chained SYNAOS jobs.
// Used by the "Send recall now" button and by the timer, so both leave the same
// trail and both arm the watcher that keeps the timer off a running AGV.
async function dispatchRecall(recall, opts) {
  const auto = !!(opts && opts.auto);
  const { legs, warnings } = buildLegsForUnit(recall, 0, 1);
  if (!auto) {
    warnings.forEach((w) => toast(w === 'incapable'
      ? `${recall.name}: the assigned robot can't reach those stations — letting SYNAOS choose instead.`
      : `${recall.name}: no robot is known to reach those stations — letting SYNAOS choose.`, 'error'));
  }

  const runId = uid('rcl');
  const robot = (legs[0] && legs[0].resourceId) || null;
  let results = [];
  try {
    results = await window.api.createOrderJobs({
      orderId: runId,
      units: [{ unitId: uid('u'), productId: recall.id, name: `Recall — ${recall.name}`, quantity: 1, legs }]
    });
    await syncRelaysFromMain();
  } catch (e) {
    logRecallRun(recall, { auto, robot, ok: false, error: 'Could not reach SYNAOS: ' + e.message, jobIds: [] });
    return { ok: false, runId, jobIds: [], legs, error: 'Could not reach SYNAOS: ' + e.message };
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const firstErr = results.find((r) => !r.ok);
  const error = ok ? null : (firstErr && firstErr.error) || 'Rejected by SYNAOS';
  // Only jobs SYNAOS accepted are worth watching; a rejected leg has no job to
  // finish, and waiting on one would stall the schedule for good.
  const jobIds = results.filter((r) => r.ok && r.jobId).map((r) => r.jobId);
  logRecallRun(recall, { auto, robot, ok, error, jobIds });
  // Tell the shop something is being fetched back — by hand or on its own
  dismissRecallAsk();                 // whatever it was warning about has now gone
  if (jobIds.length) showRecallBubble(recall.name || 'Recall');
  return { ok, runId, jobIds, legs, error };
}

function logRecallRun(recall, entry) {
  store.recallLog = store.recallLog || [];
  store.recallLog.unshift({
    at: new Date().toISOString(),
    name: recall.name,
    auto: !!entry.auto,
    robot: entry.robot || null,
    ok: !!entry.ok,
    // Something that happened to the schedule rather than a send — e.g. the
    // shop putting the run off. Shown in its own right in the log.
    note: entry.note || null,
    error: entry.ok ? null : entry.error || 'Rejected by SYNAOS',
    jobIds: entry.jobIds || []
  });
  store.recallLog.length = Math.min(store.recallLog.length, 50);
}

async function sendRecall(recallId, button) {
  const recall = (store.recalls || []).find((r) => r.id === recallId);
  if (!recall) return;
  if (!(recall.steps || []).filter((s) => !isHandoverStep(s)).length) {
    toast('This recall has no steps yet.', 'error');
    return;
  }
  if (autoState(recall).jobIds.length) {
    toast('This recall is still running — wait for the AGV to finish.', 'error');
    return;
  }
  if (button) { button.disabled = true; button.textContent = 'Sending…'; }

  const run = await dispatchRecall(recall, { auto: false });
  // A run started by hand counts as this recall's last run, so the timer waits
  // for it too instead of sending a second AGV out behind it.
  watchRecallRun(recall, run);
  await persist();
  renderAdminRecalls();
  toast(run.ok ? `Recall sent — ${run.legs.length} job(s) created` : `Recall failed: ${run.error}`,
    run.ok ? 'success' : 'error');
}

// ---- Automatic recalls ----
//
// A recall can run itself after a delivery. What starts the clock is a customer
// order being **delivered** — the rack is only worth fetching once something has
// been taken to the shop — so the countdown is measured from the order's
// completion, not from when the option was switched on.
//
// The rest of the design is built around one hazard: sending a recall to an AGV
// that is still executing the previous one puts the vehicle into an error state.
// So a recall is never dispatched while its own last run is out there, a run
// only counts as finished when every one of its jobs (parking move included)
// reports FINISHED, and finishing a run does not re-arm the clock — only the
// next delivered order does.
const AUTO_TICK_MS = 5000;
const AUTO_MIN_MINUTES = 1;
const AUTO_MAX_MINUTES = 24 * 60;
const AUTO_SETTLE_MS = 30000;              // quiet gap after the AGV reports done
const AUTO_MAX_FAILURES = 3;               // then stop trying by itself
const AUTO_WATCHDOG_MS = 60 * 60 * 1000;   // a run that never finishes pauses the timer
const AUTO_BOOT_GRACE_MS = 60000;          // nothing drives off the moment the app opens
const ORDER_STALE_MS = 30 * 60 * 1000;     // an order older than this no longer counts as live
const ORDER_WATCH_TICKS = 3;               // check live orders every third tick (~15s)
const AUTO_WARN_MS = 30000;                // the shop's warning before an automatic run
const AUTO_WARN_STALE_MS = 120000;         // a warning older than this is given again
const DEFAULT_DELAYS = [2, 5, 10, 15];     // minutes the shop can push it back by

let autoRecallTimer = null;
let autoRecallBusy = false;
let orderWatchCounter = 0;

function autoCfg(recall) {
  const a = recall.auto || (recall.auto = {});
  if (typeof a.enabled !== 'boolean') a.enabled = false;
  if (!(Number(a.everyMinutes) > 0)) a.everyMinutes = 30;
  if (typeof a.onlyWhenIdle !== 'boolean') a.onlyWhenIdle = true;
  if (a.triggerMode !== 'product' && a.triggerMode !== 'robot') a.triggerMode = 'any';
  if (!Array.isArray(a.triggerProducts)) a.triggerProducts = [];
  if (!Array.isArray(a.triggerRobots)) a.triggerRobots = [];
  if (typeof a.askBefore !== 'boolean') a.askBefore = true;
  a.delayOptions = DEFAULT_DELAYS.map((fallback, i) => {
    const v = Math.round(Number((a.delayOptions || [])[i]));
    return v > 0 && v <= AUTO_MAX_MINUTES ? v : fallback;
  });
  return a;
}

// What the operator chose, in words — used in the status line and the log.
function triggerSummary(recall) {
  const cfg = autoCfg(recall);
  if (cfg.triggerMode === 'product') {
    const names = cfg.triggerProducts
      .map((id) => (store.products.find((p) => p.id === id) || {}).name)
      .filter(Boolean);
    return names.length ? `a delivery of ${names.join(' or ')}` : null;
  }
  if (cfg.triggerMode === 'robot') {
    return cfg.triggerRobots.length ? `a delivery by ${cfg.triggerRobots.join(' or ')}` : null;
  }
  return 'the next order to be delivered';
}

function autoState(recall) {
  const st = recall.autoState || (recall.autoState = {});
  if (!Array.isArray(st.jobIds)) st.jobIds = [];
  return st;
}

function autoIntervalMs(recall) {
  const m = Math.min(AUTO_MAX_MINUTES, Math.max(AUTO_MIN_MINUTES, Number(autoCfg(recall).everyMinutes) || AUTO_MIN_MINUTES));
  return m * 60000;
}

// Switching the option on (or changing the wait) does not start a countdown —
// the next delivered order does. Everything delivered up to now is written off
// as history, so ticking the box never reaches back and fires on an old order.
function armAutoRecall(recall) {
  const st = autoState(recall);
  st.watermark = new Date().toISOString();
  st.armedAt = null;
  st.armedBy = null;
  st.nextDueAt = null;
  if (st.lastResult === 'stalled') st.lastResult = null;
  st.failures = 0;
}

// Which deliveries wake this recall. Left on "any", several recalls on auto
// would all arm off the same order — one rack coming back is right, three AGVs
// converging on the shop because one order landed is not. So a recall can be
// tied to the products it fetches back, or to the AGV that has just delivered.
function orderMatchesTrigger(recall, order) {
  const cfg = autoCfg(recall);
  if (cfg.triggerMode === 'product') {
    if (!cfg.triggerProducts.length) return false;    // nothing chosen yet — never fire on a guess
    return (order.items || []).some((i) => cfg.triggerProducts.includes(i.productId));
  }
  if (cfg.triggerMode === 'robot') {
    if (!cfg.triggerRobots.length) return false;
    return (order.jobs || []).some((j) => j.assignedResourceId && cfg.triggerRobots.includes(j.assignedResourceId));
  }
  return true;
}

// The most recently delivered order this recall answers to.
function latestOrderDelivery(recall) {
  let best = null;
  (store.orders || []).forEach((o) => {
    if (!o.completedAt || !(o.state === 'completed' || o.confirmed)) return;
    if (recall && !orderMatchesTrigger(recall, o)) return;
    if (!best || new Date(o.completedAt).getTime() > new Date(best.completedAt).getTime()) best = o;
  });
  return best;
}

// SYNAOS may pick the robot itself, so an order often only learns which AGV ran
// it from the live job. A recall triggered by robot depends on that being
// written down, so record it wherever a job is polled.
function noteAssignedResource(order, jobId, data) {
  if (!data || !data.assignedResourceId) return false;
  const job = (order.jobs || []).find((j) => j.jobId === jobId);
  if (!job || job.assignedResourceId === data.assignedResourceId) return false;
  job.assignedResourceId = data.assignedResourceId;
  return true;
}

// Hang the countdown off the newest delivery this recall has not accounted for.
// A further delivery while waiting pushes the run back rather than adding a
// second one: the AGV goes in once the deliveries have settled.
function armFromDeliveries(recall) {
  const st = autoState(recall);
  const last = latestOrderDelivery(recall);
  if (!last) return false;
  const at = new Date(last.completedAt).getTime();
  if (st.watermark && at <= new Date(st.watermark).getTime()) return false;   // already accounted for
  st.watermark = last.completedAt;
  st.armedAt = last.completedAt;
  st.armedBy = last.shortId || last.id;
  st.nextDueAt = new Date(at + autoIntervalMs(recall)).toISOString();
  return true;
}

// Watches orders that are still running even when nobody is on the progress
// screen — that screen only polls while it is open, and the recall has to know
// about a delivery whether or not the customer stayed to watch it.
async function refreshLiveOrders() {
  const live = (store.orders || []).filter((o) => o.state === 'in_progress' && !o.confirmed);
  let changed = false;
  for (const order of live) {
    const created = (order.jobs || []).filter((j) => j.created && j.jobId);
    if (!created.length) continue;
    let delivered = true;
    let failed = false;
    for (const j of created) {
      let res = null;
      try {
        res = await window.api.getJob(j.jobId);
      } catch (e) {
        delivered = false;
        break;
      }
      if (!res || !res.ok || !res.data) { delivered = false; break; }
      const d = res.data;
      if (noteAssignedResource(order, j.jobId, d)) changed = true;
      if (d.status === 'FINISHED_FAILURE') { failed = true; delivered = false; break; }
      if (d.status === 'FINISHED_SUCCESS' || d.finishedExternally) continue;
      // Delivered once the delivery milestones are done — the robot driving off
      // to its waiting spot afterwards does not hold the order open.
      const delivery = (d.milestones || []).filter((m) => !isWaitingSpotMilestone(m));
      if (!delivery.length || !delivery.every((m) => milestonePhase(m) === 4)) { delivered = false; break; }
    }
    if (delivered) { markOrderDelivered(order); changed = true; }
    else if (failed) { order.state = 'failed'; changed = true; }
  }
  if (changed) renderOrdersBadge();
  return changed;
}

function pauseAutoRecall(recall, why) {
  autoCfg(recall).enabled = false;
  logRecallRun(recall, { auto: true, ok: false, error: `Automatic runs paused — ${why}`, jobIds: [] });
  toast(`${recall.name}: automatic runs paused — ${why}.`, 'error');
}

// A run is settled. It deliberately does NOT schedule another one — only the
// next delivered order does that — and it holds the recall back for a settling
// gap so nothing can go out on the heels of the AGV that has just parked.
function settleAutoRecall(recall, verdict) {
  const st = autoState(recall);
  st.jobIds = [];
  st.finishedAt = new Date().toISOString();
  st.holdUntil = new Date(Date.now() + AUTO_SETTLE_MS).toISOString();
  st.nextDueAt = null;
  st.armedAt = null;
  st.armedBy = null;
  st.lastResult = verdict;
  st.failures = verdict === 'ok' ? 0 : (st.failures || 0) + 1;
  if (verdict !== 'ok' && st.failures >= AUTO_MAX_FAILURES && autoCfg(recall).enabled) {
    pauseAutoRecall(recall, `${st.failures} runs in a row failed`);
  }
}

// Give the shop its full warning, then run. Called both at T-30s and when a run
// is about to go without one, so the countdown on screen is always the real one.
function warnRecallSoon(recall) {
  const st = autoState(recall);
  const soon = Date.now() + AUTO_WARN_MS;
  if (!st.nextDueAt || new Date(st.nextDueAt).getTime() < soon) st.nextDueAt = new Date(soon).toISOString();
  st.warnedFor = st.nextDueAt;
  showRecallAsk(recall);
}

// The shop is not ready — push the run back by the minutes they picked. The
// warning is cleared with it, so they are asked again before the new time.
async function delayAutoRecall(recallId, minutes) {
  const recall = (store.recalls || []).find((r) => r.id === recallId);
  if (!recall) return;
  const st = autoState(recall);
  dismissRecallAsk();
  if (st.jobIds.length) { toast('Too late — it is already on its way.', 'error'); return; }
  const from = Math.max(Date.now(), new Date(st.nextDueAt || 0).getTime());
  st.nextDueAt = new Date(from + minutes * 60000).toISOString();
  st.warnedFor = null;
  st.delayedAt = new Date().toISOString();
  st.delayedTotal = (st.delayedTotal || 0) + minutes;
  logRecallRun(recall, { auto: true, ok: true, note: `Put off ${minutes} min by the shop`, jobIds: [] });
  await persist();
  if (currentView === 'admin' && adminTab === 'recalls' && !recallDraft) renderAdminRecalls();
  toast(`No problem — ${recall.name} will wait ${minutes} more minute${minutes === 1 ? '' : 's'}.`, 'success');
}

// "Go ahead now" — skip the rest of the warning.
async function releaseAutoRecall(recallId) {
  const recall = (store.recalls || []).find((r) => r.id === recallId);
  if (!recall) return;
  const st = autoState(recall);
  dismissRecallAsk();
  if (st.jobIds.length) return;
  st.nextDueAt = new Date(Date.now() - 1000).toISOString();
  st.warnedFor = st.nextDueAt;      // already warned — do not ask again
  await persist();
}

function watchRecallRun(recall, run) {
  const st = autoState(recall);
  st.runId = run.runId;
  st.sentAt = new Date().toISOString();
  st.jobIds = run.jobIds || [];
  if (st.jobIds.length) {
    st.lastResult = 'running';
    st.nextDueAt = null;             // recomputed once these jobs report finished
  } else {
    settleAutoRecall(recall, run.ok ? 'ok' : 'failed');
  }
}

// Is the previous run over? Anything uncertain — a transient API error, a job
// the relay supervisor has not created yet — counts as still running, because
// the cost of waiting another tick is nothing and the cost of guessing wrong is
// an AGV error.
async function recallRunVerdict(st) {
  const relays = (store.pendingRelays || []).filter((p) => p.orderId === st.runId);
  // An abandoned hand-over means the receiving leg is never created, so its job
  // would never answer — call the run failed now instead of waiting for ever.
  if (relays.some((p) => p.state === 'failed')) return 'failed';
  if (relays.some((p) => p.state !== 'done')) return 'running';

  let anyFailed = false;
  for (const jobId of st.jobIds) {
    let res = null;
    try {
      res = await window.api.getJob(jobId);
    } catch (e) {
      return 'running';
    }
    if (!res || !res.ok || !res.data) return 'running';
    const d = res.data;
    if (d.status === 'FINISHED_FAILURE') { anyFailed = true; continue; }
    if (d.status === 'FINISHED_SUCCESS' || d.finishedExternally) continue;
    const milestones = d.milestones || [];
    // Every milestone, the trailing waiting-spot move included: the recall is
    // over when the AGV has stopped driving, not when it drops its load.
    if (!milestones.length || !milestones.every((m) => milestonePhase(m) === 4)) return 'running';
  }
  return anyFailed ? 'failed' : 'ok';
}

// Another recall's run is still out there. Two AGVs sent by two timers into the
// same aisle is exactly the collision this feature must not create.
function autoRecallInFlight(except) {
  return (store.recalls || []).some((r) => r !== except && ((r.autoState || {}).jobIds || []).length > 0);
}

function anOrderIsRunning() {
  return (store.orders || []).some((o) => o.state === 'in_progress' && !o.confirmed
    && Date.now() - new Date(o.createdAt).getTime() < ORDER_STALE_MS);
}

async function serviceAutoRecall(recall) {
  const st = autoState(recall);
  const cfg = autoCfg(recall);

  // 1. A run of this recall is still out there. Watch it; dispatch nothing.
  if (st.jobIds.length) {
    const verdict = await recallRunVerdict(st);
    if (verdict === 'running') {
      if (st.sentAt && Date.now() - new Date(st.sentAt).getTime() > AUTO_WATCHDOG_MS) {
        // Never seen to finish — the safe reading is that something is wrong on
        // the floor, so stop the timer rather than send another AGV after it.
        st.jobIds = [];
        st.lastResult = 'stalled';
        st.nextDueAt = null;
        st.armedAt = null;
        st.armedBy = null;
        if (cfg.enabled) pauseAutoRecall(recall, 'the last run never reported finished');
        return true;
      }
      return false;
    }
    settleAutoRecall(recall, verdict);
    return true;    // never dispatch on the same tick a run was seen to finish
  }

  if (!cfg.enabled || isMpdv()) return false;
  if (st.lastResult === 'stalled') return false;

  // 2. A newly delivered order starts (or pushes back) the countdown.
  const armed = armFromDeliveries(recall);
  if (!st.nextDueAt) return armed;                                  // nothing delivered to wait on

  // 3. Half a minute before it goes, tell the shop and offer to push it back —
  //    the AGV turning up to collect is only welcome if they are done with it.
  if (cfg.askBefore && !st.jobIds.length
      && new Date(st.nextDueAt).getTime() - Date.now() <= AUTO_WARN_MS
      && st.warnedFor !== st.nextDueAt) {
    warnRecallSoon(recall);
    return true;
  }

  if (Date.now() < new Date(st.nextDueAt).getTime()) return armed;
  if (st.holdUntil && Date.now() < new Date(st.holdUntil).getTime()) return armed;

  // Never send without the shop having had its warning — and if something held
  // the run back long after that warning, give it again rather than have an AGV
  // appear minutes after the countdown they watched ran out.
  if (cfg.askBefore) {
    if (st.warnedFor !== st.nextDueAt
        || Date.now() - new Date(st.nextDueAt).getTime() > AUTO_WARN_STALE_MS) {
      warnRecallSoon(recall);
      return true;
    }
  }

  // Due — but only if the floor is clear.
  if (autoRecallInFlight(recall)) return armed;
  if (cfg.onlyWhenIdle && anOrderIsRunning()) return armed;
  if (!(recall.steps || []).filter((s) => !isHandoverStep(s)).length) {
    pauseAutoRecall(recall, 'it has no steps');
    return true;
  }

  const run = await dispatchRecall(recall, { auto: true });
  watchRecallRun(recall, run);
  return true;
}

async function autoRecallTick() {
  if (!store || autoRecallBusy) return;
  // A recall whose timer was switched off mid-run is still serviced, so its
  // state does not stay stuck on "running" for ever.
  const watched = (store.recalls || []).filter((r) =>
    (r.auto && r.auto.enabled) || ((r.autoState || {}).jobIds || []).length);
  if (!watched.length) return;

  autoRecallBusy = true;
  let changed = false;
  try {
    // Judge a run against the relay supervisor's latest hand-over state, not a
    // copy that may be minutes old.
    if (watched.some((r) => ((r.autoState || {}).jobIds || []).length)) await syncRelaysFromMain();
    // Notice deliveries that finish while nobody is watching the progress
    // screen — they are what starts a recall's countdown.
    if (watched.some((r) => r.auto && r.auto.enabled)) {
      orderWatchCounter = (orderWatchCounter + 1) % ORDER_WATCH_TICKS;
      if (orderWatchCounter === 0 && (await refreshLiveOrders())) changed = true;
    }
    for (const recall of watched) {
      changed = (await serviceAutoRecall(recall)) || changed;
    }
  } catch (e) {
    /* a bad tick must never kill the timer */
  } finally {
    autoRecallBusy = false;
  }
  if (changed) {
    try { await persist(); } catch (e) { /* retried on the next tick */ }
  }
  refreshAutoRecallStatus(changed);
}

function startAutoRecalls() {
  if (autoRecallTimer) return;
  // After a restart a countdown may be long overdue. Nothing should drive off
  // the second the app opens — give the operator a minute to notice, and give a
  // run that was in flight at shutdown a chance to be polled and settled first.
  const grace = Date.now() + AUTO_BOOT_GRACE_MS;
  (store.recalls || []).forEach((r) => {
    const st = autoState(r);
    if (st.jobIds.length) return;
    if (st.nextDueAt && new Date(st.nextDueAt).getTime() < grace) st.nextDueAt = new Date(grace).toISOString();
  });
  autoRecallTimer = setInterval(autoRecallTick, AUTO_TICK_MS);
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

function autoStatusText(recall) {
  const cfg = autoCfg(recall);
  const st = autoState(recall);
  if (st.jobIds.length) return '🚚 Running now — nothing else goes out until this AGV is finished';
  if (st.lastResult === 'stalled') return '⏸️ Paused — the last run never reported finished; send it by hand to check the AGV';
  if (!cfg.enabled) {
    return st.finishedAt ? `Automatic runs off — last run ${shortDateTime(st.finishedAt)}` : '';
  }
  if (!st.nextDueAt) {
    const what = triggerSummary(recall);
    return what
      ? `⏱️ Waiting for ${what}`
      : `⚠️ Nothing chosen to trigger it — tick the ${cfg.triggerMode === 'product' ? 'products' : 'robots'} it should follow`;
  }
  const by = st.armedBy ? ` — order #${st.armedBy} was delivered ${shortDateTime(st.armedAt)}` : '';
  const left = new Date(st.nextDueAt).getTime() - Date.now();
  if (left > 0) {
    const put = st.delayedTotal ? ` (shop has put it off ${st.delayedTotal} min)` : '';
    if (cfg.askBefore && st.warnedFor === st.nextDueAt) return `🗣️ Asking the shop — ${fmtCountdown(left)} left${put}`;
    return `⏱️ Runs in ${fmtCountdown(left)}${by}${put}`;
  }
  if (cfg.onlyWhenIdle && anOrderIsRunning()) return '⏳ Due — holding until the customer order is finished';
  if (autoRecallInFlight(recall)) return '⏳ Due — holding until the other recall is finished';
  if (st.holdUntil && Date.now() < new Date(st.holdUntil).getTime()) return '⏳ Due — letting the AGV settle first';
  return '⏳ Due — starting…';
}

// Keeps the countdown honest without redrawing the panel under the operator's
// cursor; a full redraw only happens when something actually changed and no
// field is being edited.
function refreshAutoRecallStatus(changed) {
  if (currentView !== 'admin' || adminTab !== 'recalls' || recallDraft) return;
  const editing = document.activeElement && document.activeElement.closest
    && document.activeElement.closest('.auto-box');
  if (changed && !editing) { renderAdminRecalls(); return; }
  (store.recalls || []).forEach((r) => {
    const el = $(`[data-rc-auto-status="${r.id}"]`);
    if (el) el.textContent = autoStatusText(r);
  });
}

function renderRecallEditor(body) {
  const r = recallDraft;
  const stationOpts = (sel) => store.stations.map((s) =>
    `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${escapeHtml(s.name)} (${escapeHtml(s.stationId)})</option>`).join('');
  const actions = ['PICK', 'DROP', 'MOVE', 'PROVIDE'];
  const actionOpts = (sel) => actions.map((a) => `<option value="${a}" ${a === sel ? 'selected' : ''}>${a}</option>`).join('');
  const elig = eligibleRobotsForProduct(r);
  const stepRobotOpts = (step) => {
    const st = store.stations.find((s) => s.id === step.stationRef);
    const allowed = st ? robotsAllowedAtStation(st) : [];
    return `<option value="">Use the recall's robot</option>`
      + allowed.map((id) => `<option value="${escapeHtml(id)}" ${step.resourceId === id ? 'selected' : ''}>${escapeHtml(id)}</option>`).join('');
  };

  const stepsHtml = r.steps.map((s, i) => {
    if (isHandoverStep(s)) {
      return `
      <div class="step-editor-row handover-row">
        <span class="chip">${i + 1}</span>
        <span class="handover-label">🤝 Hand-over — robotic arm</span>
        <label class="inline-fld">method
          <input class="inp" data-rc-ho="${i}" value="${escapeHtml(s.method || 'grasp')}" style="max-width:110px;">
        </label>
        <button class="link-btn danger" data-rc-step-del="${i}">Remove</button>
      </div>`;
    }
    return `
    <div class="step-editor-row">
      <span class="chip">${i + 1}</span>
      <select class="inp" data-rc-station="${i}">${stationOpts(s.stationRef)}</select>
      <select class="inp" data-rc-action="${i}" style="max-width:120px;">${actionOpts(s.action)}</select>
      <select class="inp" data-rc-robot="${i}" style="max-width:190px;">${stepRobotOpts(s)}</select>
      <button class="link-btn danger" data-rc-step-del="${i}" ${r.steps.filter((x) => !isHandoverStep(x)).length <= 1 ? 'style="visibility:hidden;"' : ''}>Remove</button>
    </div>`;
  }).join('');

  const preview = buildLegsForUnit(r, 0, 1).legs;
  const issues = handoverIssues(r);

  body.innerHTML = `
    <div class="panel">
      <h2>${r._new ? 'New recall' : 'Edit recall'}</h2>
      <p class="hint">For example: pick the rack up at the Shop and drop it back at Production.</p>
      <div class="form-grid">
        <label class="fld full">Name
          <input class="inp" id="rc-name" value="${escapeHtml(r.name || '')}" placeholder="Bring the rack back">
        </label>
        <label class="fld full">Robot
          <select class="inp" id="rc-resource">
            <option value="${AUTO_CAPABLE}" ${r.resourceId === AUTO_CAPABLE ? 'selected' : ''}>Auto — only robots that can reach these stations (recommended)</option>
            <option value="" ${!r.resourceId || r.resourceId === AUTO_ANY ? 'selected' : ''}>Auto — let SYNAOS choose</option>
            ${elig.eligible.map((id) => `<option value="${escapeHtml(id)}" ${r.resourceId === id ? 'selected' : ''}>${escapeHtml(id)}</option>`).join('')}
            ${Object.keys(elig.blockedAt).map((id) =>
              `<option value="${escapeHtml(id)}" disabled>${escapeHtml(id)} — can't reach ${escapeHtml(elig.blockedAt[id])}</option>`).join('')}
          </select>
        </label>
      </div>
      <h2 style="margin-top:22px;">Route</h2>
      <div class="steps-editor">${stepsHtml}</div>
      <div class="row-actions" style="margin-top:8px;">
        <button class="link-btn add-step" id="rc-add-step">+ Add step</button>
        <button class="link-btn add-step" id="rc-add-ho">+ Add hand-over (robotic arm)</button>
      </div>
      ${issues.length ? `<div class="handover-warn">⚠️ ${issues.join('<br>⚠️ ')}</div>` : ''}
      ${preview.length > 1 ? `<div class="leg-preview">This recall will be sent as <b>${preview.length} chained jobs</b>:
        ${preview.map((l, i) => `<div class="leg-line"><span class="chip">Job ${i + 1}</span> <b>${escapeHtml(l.resourceId || 'SYNAOS decides')}</b> — ${escapeHtml(l.steps.map((x) => `${stationName(x.stationRef)}·${x.action}`).join(' → '))}</div>`).join('')}
      </div>` : ''}
      <div class="progress-actions" style="margin-top:20px;">
        <button class="btn btn-primary" id="rc-save">Save</button>
        <button class="btn btn-secondary" id="rc-cancel">Cancel</button>
      </div>
    </div>`;

  $('#rc-name').addEventListener('input', (e) => { r.name = e.target.value; });
  $('#rc-resource').addEventListener('change', (e) => { r.resourceId = e.target.value || null; renderAdmin(); });
  $$('[data-rc-station]', body).forEach((el) => el.addEventListener('change', (e) => { r.steps[+el.dataset.rcStation].stationRef = e.target.value; renderAdmin(); }));
  $$('[data-rc-action]', body).forEach((el) => el.addEventListener('change', (e) => { r.steps[+el.dataset.rcAction].action = e.target.value; renderAdmin(); }));
  $$('[data-rc-robot]', body).forEach((el) => el.addEventListener('change', (e) => { r.steps[+el.dataset.rcRobot].resourceId = e.target.value || STEP_INHERIT; renderAdmin(); }));
  $$('[data-rc-ho]', body).forEach((el) => el.addEventListener('change', (e) => { r.steps[+el.dataset.rcHo].method = e.target.value.trim() || 'grasp'; renderAdmin(); }));
  $$('[data-rc-step-del]', body).forEach((el) => el.addEventListener('click', () => { r.steps.splice(+el.dataset.rcStepDel, 1); renderAdmin(); }));
  $('#rc-add-step').addEventListener('click', () => {
    r.steps.push({ stationRef: store.stations[0] ? store.stations[0].id : '', action: 'MOVE', resourceId: STEP_INHERIT });
    renderAdmin();
  });
  $('#rc-add-ho').addEventListener('click', () => {
    r.steps.push({ kind: 'handover', method: 'grasp', quantity: 1 });
    renderAdmin();
  });
  $('#rc-cancel').addEventListener('click', () => { recallDraft = null; renderAdmin(); });
  $('#rc-save').addEventListener('click', async () => {
    if (!(r.name || '').trim()) { toast('Give the recall a name.', 'error'); return; }
    const real = r.steps.filter((s) => !isHandoverStep(s));
    if (!real.length || real.some((s) => !s.stationRef)) { toast('Each step needs a station.', 'error'); return; }
    delete r._new;
    store.recalls = store.recalls || [];
    const idx = store.recalls.findIndex((x) => x.id === r.id);
    if (idx >= 0) {
      // The editor works on a copy taken when it opened; the schedule may have
      // moved on since (a run may even have started), so keep the live one.
      r.auto = store.recalls[idx].auto || r.auto;
      r.autoState = store.recalls[idx].autoState || r.autoState;
      store.recalls[idx] = r;
    } else {
      store.recalls.push(r);
    }
    recallDraft = null;
    await persist();
    renderAdmin();
    toast('Recall saved', 'success');
  });
}

// ---- Admin: stations ----
function renderAdminStations() {
  const body = $('#adminBody');
  const fns = ['production', 'storage', 'shop', 'charging', 'other'];
  const list = store.stations.map((s) => `
    <div class="admin-item">
      <div class="thumb">${s.image ? `<img src="${escapeHtml(s.image)}" alt="">` : '📍'}</div>
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
          <div class="fld full">Station icon
            <div class="img-pick">
              <div class="img-preview">${s.image ? `<img src="${escapeHtml(s.image)}" alt="">` : '📍'}</div>
              <button class="btn btn-secondary" data-st-img="${s.id}">Choose image…</button>
              ${s.image ? `<button class="link-btn danger" data-st-img-clear="${s.id}">Remove</button>` : ''}
            </div>
            <span class="fld-hint">Shown on this stop in the customer's order tracking. Falls back to an emoji when empty.</span>
          </div>
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
  // Left over from when reading SYNAOS saved every robot it saw
  const autoAdded = robots.filter((r) => r.source === 'discovered');
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
            <span class="chip ${r.source === 'manual' ? '' : 'off'}">${r.source === 'manual' ? 'added by you' : 'auto-added'}</span>
            <span class="chip ${robotKind(r) === 'simulated' ? '' : 'on'}">${robotKind(r) === 'simulated' ? '🧪 simulated' : '🚚 real'}</span>
            <select class="inp kind-select" data-robot-kind="${escapeHtml(r.id)}" title="SYNAOS doesn't tell us this — correct it if the guess is wrong">
              <option value="" ${!r.kind ? 'selected' : ''}>auto (from the name)</option>
              <option value="real" ${r.kind === 'real' ? 'selected' : ''}>real</option>
              <option value="simulated" ${r.kind === 'simulated' ? 'selected' : ''}>simulated</option>
            </select>
          </div>
          <div class="desc">Supports: ${escapeHtml((r.supportedJobTypes || []).join(', ') || '—')}</div>
          ${cannot.length ? `<div class="desc" style="color:#d64545;">✖ Cannot reach: ${escapeHtml(cannot.join(', '))}</div>` : ''}
          <label class="fld" style="margin-top:10px;">Waiting spot
            <select class="inp" data-robot-home="${escapeHtml(r.id)}">
              <option value="">None — stay where it finished</option>
              ${(store.nodes || []).map((n) => {
                const key = `${n.nodeId}@${n.system}`;
                const on = r.homeNode && r.homeNode.id === n.nodeId && (r.homeNode.system || '') === n.system;
                return `<option value="${escapeHtml(n.id)}" ${on ? 'selected' : ''}>${escapeHtml(n.name || n.nodeId)} — ${escapeHtml(key)}</option>`;
              }).join('')}
              ${r.homeNode && r.homeNode.id && !(store.nodes || []).some((n) => n.nodeId === r.homeNode.id && (n.system || '') === (r.homeNode.system || ''))
                ? `<option value="__keep__" selected>${escapeHtml(r.homeNode.id)}@${escapeHtml(r.homeNode.system || '')} (not in the node list)</option>` : ''}
            </select>
            <span class="fld-hint">${(r.homeNode && r.homeNode.id)
              ? `After finishing its part of an order, ${escapeHtml(r.id)} drives to <b>${escapeHtml(r.homeNode.id)}</b> on <b>${escapeHtml(r.homeNode.system || 'STATION')}</b>.`
              : (store.nodes || []).length ? 'Pick a node to send this robot home after each order.'
              : 'Add a node below first, then pick it here.'}</span>
          </label>
          <div class="row-actions" style="margin-top:8px;">
            <button class="link-btn danger" data-robot-del="${escapeHtml(r.id)}">Remove</button>
          </div>
        </div>
      </div>`;
    }).join('')
    : '<p class="hint">No robots loaded yet. Click “Read from SYNAOS”, add one by id, or scan a range below.</p>';

  const nodesHtml = (store.nodes || []).length
    ? store.nodes.map((n) => `
      <div class="admin-item">
        <div class="thumb">📌</div>
        <div class="grow">
          <div class="form-grid">
            <label class="fld">Name
              <input class="inp" data-nd-name="${n.id}" value="${escapeHtml(n.name || '')}" placeholder="e.g. Kuka waiting spot">
            </label>
            <label class="fld">Node id
              <input class="inp" data-nd-node="${n.id}" value="${escapeHtml(n.nodeId || '')}" placeholder="00">
            </label>
            <label class="fld full">Navigation graph (address system)
              <input class="inp" data-nd-sys="${n.id}" value="${escapeHtml(n.system || '')}" placeholder="TUSK/NODES">
            </label>
          </div>
          <div class="row-actions" style="margin-top:8px;">
            <button class="link-btn danger" data-nd-del="${n.id}">Delete node</button>
          </div>
        </div>
      </div>`).join('')
    : '<p class="hint">No nodes yet. Add one, or read them from SYNAOS.</p>';

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
      <p class="hint">Only the robots you add yourself — a tenant carries plenty of AGVs that have nothing to do with this shop, so nothing is saved automatically. Every id is checked against SYNAOS before it is added. ✖ marks stations SYNAOS reported the robot cannot reach.</p>
      <div class="admin-list">${robotsHtml}</div>
      <div class="row-actions" style="margin-top:16px;">
        <button class="btn btn-primary" id="addRobot">+ Add robot by id</button>
        ${autoAdded.length ? `<button class="btn btn-secondary" id="dropAutoAdded">Remove ${autoAdded.length} auto-added robot(s)</button>` : ''}
      </div>
      ${autoAdded.length ? `<span class="fld-hint">Earlier versions saved every robot seen in job history. Those are marked <b>auto-added</b> — remove the ones this shop doesn't use.</span>` : ''}
      <div class="scan-box">
        <div class="arm-log-title">Find robots in SYNAOS</div>
        <p class="hint">SYNAOS does not let this app list the fleet — that page is behind its web login — so ids have to be checked one by one.
          <b>Pasting the list is the reliable way</b>: open Fleet Management in SYNAOS, select the vehicles, copy, and paste here. Every id is verified against SYNAOS before it is offered.</p>
        <div class="scan-tabs">
          <button class="tab-btn ${scanMode === 'paste' ? 'active' : ''}" data-scan-mode="paste">Paste a list</button>
          <button class="tab-btn ${scanMode === 'pattern' ? 'active' : ''}" data-scan-mode="pattern">Ids &amp; patterns</button>
        </div>
        ${scanMode === 'paste' ? `
          <textarea class="inp" id="scanPatterns" rows="6" spellcheck="false"
            placeholder="Paste anything containing the ids — e.g. copied straight from the Fleet Management table:&#10;001  KMP 400P-1-5G diffDrive&#10;36029  E10&#10;sc-aware-JQ3H0018  aware">${escapeHtml(lastScanPatterns)}</textarea>
          <span class="fld-hint">Surrounding words are harmless — anything that is not a real resource simply fails the check and is ignored.</span>
        ` : `
          <input class="inp" id="scanPatterns" placeholder="36020-36040, kuka0#, AFS1000-Sim?#" value="${escapeHtml(lastScanPatterns)}">
          <span class="fld-hint"><code>36020-36040</code> range · <code>#</code> a digit · <code>?</code> a digit or letter · <code>[1-9]</code> a set. Up to 600 ids per scan.
            Ids with unpredictable parts, like <code>sc-aware-JQ3H0018</code>, can only be found by pasting them.</span>
        `}
        <div class="scan-row">
          <button class="btn btn-secondary" id="runScan">Check against SYNAOS</button>
          <div id="scanStatus" class="fld-hint"></div>
        </div>
        <div id="scanResults"></div>
      </div>
    </div>
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <h2>Nodes (navigation graph)</h2>
        <button class="btn btn-secondary" id="syncSynaos3">⟳ Read from SYNAOS</button>
      </div>
      <p class="hint">Points on a robot's navigation graph — waiting spots, parking, staging. Give each a friendly name, then pick it as a robot's waiting spot instead of typing the id and graph by hand.</p>
      <div class="admin-list">${nodesHtml}</div>
      <button class="btn btn-primary" id="addNode" style="margin-top:16px;">+ Add node</button>
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
  $$('[data-st-img]', body).forEach((el) => el.addEventListener('click', async () => {
    const res = await window.api.pickImage();
    if (!res) return;
    if (res.error) { toast(res.error, 'error'); return; }
    const st = store.stations.find((s) => s.id === el.dataset.stImg);
    if (!st) return;
    st.image = res.dataUrl;
    await persist();
    renderAdminStations();
    toast('Station icon set', 'success');
  }));
  $$('[data-st-img-clear]', body).forEach((el) => el.addEventListener('click', async () => {
    const st = store.stations.find((s) => s.id === el.dataset.stImgClear);
    if (!st) return;
    st.image = null;
    await persist();
    renderAdminStations();
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
  $$('[data-robot-home]', body).forEach((el) => el.addEventListener('change', async () => {
    const robot = (store.robots || []).find((r) => r.id === el.dataset.robotHome);
    if (!robot) return;
    if (el.value === '__keep__') return;                 // leave a hand-entered spot alone
    const node = (store.nodes || []).find((n) => n.id === el.value);
    robot.homeNode = node ? { id: node.nodeId, system: node.system || 'STATION' } : null;
    await persist();
    renderAdminStations();
  }));

  // ---- nodes ----
  const patchNode = async (nid, patch) => {
    const node = (store.nodes || []).find((n) => n.id === nid);
    if (!node) return;
    Object.assign(node, patch);
    await persist();
    renderAdminStations();
  };
  $$('[data-nd-name]', body).forEach((el) =>
    el.addEventListener('change', () => patchNode(el.dataset.ndName, { name: el.value.trim() })));
  $$('[data-nd-node]', body).forEach((el) =>
    el.addEventListener('change', () => patchNode(el.dataset.ndNode, { nodeId: el.value.trim() })));
  $$('[data-nd-sys]', body).forEach((el) =>
    el.addEventListener('change', () => patchNode(el.dataset.ndSys, { system: el.value.trim() })));
  $$('[data-nd-del]', body).forEach((el) => el.addEventListener('click', () => {
    const node = (store.nodes || []).find((n) => n.id === el.dataset.ndDel);
    confirmModal('Delete node?', 'Robots using it as a waiting spot will stop parking.', async () => {
      store.nodes = (store.nodes || []).filter((n) => n.id !== el.dataset.ndDel);
      (store.robots || []).forEach((r) => {
        if (node && r.homeNode && r.homeNode.id === node.nodeId && (r.homeNode.system || '') === (node.system || '')) r.homeNode = null;
      });
      await persist();
      renderAdminStations();
    });
  }));
  $('#addNode').addEventListener('click', async () => {
    store.nodes = store.nodes || [];
    store.nodes.push({ id: uid('nd'), name: 'New node', nodeId: '', system: '' });
    await persist();
    renderAdminStations();
  });
  $('#syncSynaos3').addEventListener('click', discoverFromSynaosFlow);

  // ---- scan ----
  $('#runScan').addEventListener('click', runResourceScan);
  $('#scanPatterns').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && scanMode === 'pattern') runResourceScan();
  });
  $$('[data-scan-mode]', body).forEach((b) => b.addEventListener('click', () => {
    scanMode = b.dataset.scanMode;
    lastScanPatterns = '';
    renderAdminStations();
  }));
  $$('[data-robot-kind]', body).forEach((el) => el.addEventListener('change', async () => {
    const robot = (store.robots || []).find((r) => r.id === el.dataset.robotKind);
    if (!robot) return;
    robot.kind = el.value || null;
    await persist();
    renderAdminStations();
  }));
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
  const dropAuto = $('#dropAutoAdded');
  if (dropAuto) dropAuto.addEventListener('click', () => {
    const ids = (store.robots || []).filter((r) => r.source === 'discovered').map((r) => r.id);
    confirmModal('Remove auto-added robots?',
      `${ids.join(', ')} will be removed. Robots you added yourself are kept, and any station allow-lists mentioning these are cleaned up.`,
      async () => {
        store.robots = (store.robots || []).filter((r) => r.source !== 'discovered');
        store.stations.forEach((s) => { s.allowedRobots = (s.allowedRobots || []).filter((x) => !ids.includes(x)); });
        store.products.forEach((p) => {
          if (ids.includes(p.resourceId)) p.resourceId = AUTO_CAPABLE;
          (p.steps || []).forEach((st) => { if (ids.includes(st.resourceId)) st.resourceId = STEP_INHERIT; });
        });
        await persist();
        renderAdminStations();
        toast(`Removed ${ids.length} auto-added robot(s)`, 'success');
      });
  });
  $('#addStation').addEventListener('click', async () => {
    store.stations.push({ id: uid('st'), stationId: 'NEW', name: 'New station', fn: 'other', system: 'STATION', allowedRobots: [], image: null });
    await persist();
    renderAdminStations();
  });
  $('#syncSynaos').addEventListener('click', discoverFromSynaosFlow);
  $('#syncSynaos2').addEventListener('click', discoverFromSynaosFlow);
}

// Asks SYNAOS about every id the input yields, and offers the real ones.
let lastScanPatterns = '';
let scanMode = 'paste';

// SYNAOS exposes no simulated flag over Basic auth, so this is a guess from the
// name that the operator can correct per robot.
function looksSimulated(id) {
  return /(^sim|[-_. ]sim|sim[-_.\d])/i.test(String(id || ''));
}
function robotKind(robot) {
  if (robot.kind === 'real' || robot.kind === 'simulated') return robot.kind;
  return looksSimulated(robot.id) ? 'simulated' : 'real';
}

async function runResourceScan() {
  const input = $('#scanPatterns');
  const status = $('#scanStatus');
  const results = $('#scanResults');
  lastScanPatterns = input.value;
  results.innerHTML = '';
  status.textContent = 'Asking SYNAOS…';
  $('#runScan').disabled = true;

  const res = await window.api.scanResources(lastScanPatterns, scanMode);
  $('#runScan').disabled = false;

  if (!res.ok) { status.textContent = res.error || 'Scan failed.'; return; }

  const known = new Set((store.robots || []).map((r) => r.id));
  const fresh = res.found.filter((f) => !known.has(f.id));
  status.innerHTML = `Checked <b>${res.tried}</b> id(s) — <b>${res.found.length}</b> exist, <b>${fresh.length}</b> new.`
    + (res.truncated ? ` <span class="mpdv-id-warn">Stopped at the ${res.limit} id limit.</span>` : '');

  if (!res.found.length) { results.innerHTML = '<p class="hint">None of those ids exist in SYNAOS.</p>'; return; }
  results.innerHTML = `
    <div class="disc-list">
      ${res.found.map((f, i) => {
        const already = known.has(f.id);
        return `<label class="disc-row">
          <input type="checkbox" data-scan="${i}" ${already ? 'disabled' : 'checked'}>
          <span class="disc-id">${escapeHtml(f.id)}</span>
          <span class="chip on">${escapeHtml(f.mode || 'AUTO')}</span>
          <span class="chip ${f.simulated ? '' : 'on'}">${f.simulated ? 'looks simulated' : 'looks real'}</span>
          ${already ? '<span class="disc-note">already added</span>' : ''}
        </label>`;
      }).join('')}
    </div>
    <button class="btn btn-primary" id="addScanned" style="margin-top:12px;" ${fresh.length ? '' : 'disabled'}>Add selected robots</button>`;

  $('#addScanned').addEventListener('click', async () => {
    const picked = $$('[data-scan]').filter((c) => c.checked && !c.disabled).map((c) => res.found[+c.dataset.scan]);
    store.robots = store.robots || [];
    let added = 0;
    picked.forEach((f) => {
      if (store.robots.some((r) => r.id === f.id)) return;
      store.robots.push({ ...f, source: 'manual', homeNode: null });
      added++;
    });
    await persist();
    renderAdminStations();
    toast(added ? `Added ${added} robot(s) from the scan` : 'Nothing new to add', added ? 'success' : undefined);
  });
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
  // Robots are never added on their own: a tenant carries plenty of AGVs that
  // have nothing to do with this shop. Only the station/robot access evidence is
  // kept, which merely drives the "cannot reach" warnings.
  store.capability = res.capability || {};
  await persist();
  openDiscoverModal(res);
}

function openDiscoverModal(res) {
  const existing = new Set(store.stations.map((s) => (s.stationId || '') + '|' + (s.system || 'STATION')));
  const knownNodes = new Set((store.nodes || []).map((n) => (n.nodeId || '') + '|' + (n.system || '')));
  const discoveredNodes = res.nodes || [];
  const nodeRows = discoveredNodes.map((nd, i) => {
    const already = knownNodes.has(nd.id + '|' + nd.system);
    return `
      <label class="disc-row">
        <input type="checkbox" data-disc-node="${i}" ${already ? 'disabled' : 'checked'}>
        <span class="disc-id">${escapeHtml(nd.id)}</span>
        <span class="chip">${escapeHtml(nd.system)}</span>
        ${already ? '<span class="disc-note">already added</span>' : ''}
      </label>`;
  }).join('');
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

  // Offered, never taken automatically — tick only the ones this shop uses.
  const knownRobots = new Set((store.robots || []).map((r) => r.id));
  const discoveredRobots = res.robots || [];
  const robotRows = discoveredRobots.map((r, i) => {
    const already = knownRobots.has(r.id);
    return `
      <label class="disc-row">
        <input type="checkbox" data-disc-robot="${i}" ${already ? 'disabled' : ''}>
        <span class="disc-id">${escapeHtml(r.id)}</span>
        ${r.mode ? `<span class="chip on">${escapeHtml(r.mode)}</span>` : ''}
        <span class="chip ${looksSimulated(r.id) ? '' : 'on'}">${looksSimulated(r.id) ? 'looks simulated' : 'looks real'}</span>
        ${already ? '<span class="disc-note">already added</span>' : ''}
      </label>`;
  }).join('');

  const host = modalHost();
  host.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" style="max-width:560px;">
        <h3>Read from SYNAOS</h3>
        <p>Found <b>${res.stations.length}</b> station(s), <b>${discoveredNodes.length}</b> node(s) and <b>${discoveredRobots.length}</b> robot(s) across <b>${res.jobCount}</b> jobs.
          Nothing is saved unless you tick it. This only sees what has already been used in a job — paste the vehicle list in the Robots panel to add the rest.</p>
        <div class="arm-log-title">Stations</div>
        <div class="disc-list">${rows || '<p class="hint">No station addresses found.</p>'}</div>
        <div class="arm-log-title">Navigation-graph nodes</div>
        <div class="disc-list">${nodeRows || '<p class="hint">No node addresses found.</p>'}</div>
        <div class="arm-log-title">Robots — none are added unless you tick them</div>
        <div class="disc-list">${robotRows || '<p class="hint">No robots found in job history.</p>'}</div>
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

    const pickedNodes = $$('[data-disc-node]').filter((c) => c.checked && !c.disabled)
      .map((c) => discoveredNodes[+c.dataset.discNode]);
    store.nodes = store.nodes || [];
    let addedNodes = 0;
    pickedNodes.forEach((nd) => {
      if (store.nodes.some((n) => (n.nodeId || '') === nd.id && (n.system || '') === nd.system)) return;
      store.nodes.push({ id: uid('nd'), name: nd.id, nodeId: nd.id, system: nd.system });
      addedNodes++;
    });

    const pickedRobots = $$('[data-disc-robot]').filter((c) => c.checked && !c.disabled)
      .map((c) => discoveredRobots[+c.dataset.discRobot]);
    store.robots = store.robots || [];
    let addedRobots = 0;
    pickedRobots.forEach((r) => {
      if (store.robots.some((x) => x.id === r.id)) return;
      store.robots.push({ ...r, source: 'manual', homeNode: null });
      addedRobots++;
    });

    await persist();
    closeModal();
    renderCatalog();
    renderAdminStations();
    const parts = [];
    if (added) parts.push(`${added} station(s)`);
    if (addedNodes) parts.push(`${addedNodes} node(s)`);
    if (addedRobots) parts.push(`${addedRobots} robot(s)`);
    toast(parts.length ? `Imported ${parts.join(' and ')} from SYNAOS` : 'Nothing new to import',
      parts.length ? 'success' : undefined);
  });
}

// ---- Setup sync ----
//
// One file in a GitHub repository holds everything an install needs, so putting
// the app on another machine is a download rather than an evening of retyping.

function syncStatusText(y) {
  if (y.lastPublishedAt) return `Published ${shortDateTime(y.lastPublishedAt)}`;
  if (y.lastLoadedAt) return `Loaded ${shortDateTime(y.lastLoadedAt)}`;
  return 'Never published';
}

function syncOptionsFromForm() {
  return {
    repo: $('#y-repo').value.trim(),
    branch: $('#y-branch').value.trim() || 'main',
    path: $('#y-path').value.trim() || 'gradion-setup.json',
    token: $('#y-token').value.trim(),
    passphrase: $('#y-pass').value
  };
}

// Replaces what belongs to the shop and leaves what belongs to this machine:
// its own orders, logs, counters, theme, chosen system and any password the
// published file did not carry.
async function applySyncedConfig(config) {
  const local = store.settings;
  const incoming = config.settings || {};
  const secrets = config.decryptedSecrets || {};

  store.stations = config.stations || store.stations;
  store.robots = config.robots || store.robots;
  store.nodes = config.nodes || store.nodes;
  store.capability = config.capability || store.capability;
  store.products = config.products || store.products;
  // Keep each recall's own countdown and in-flight run — that is this machine's
  store.recalls = (config.recalls || store.recalls || []).map((r) => {
    const here = (store.recalls || []).find((x) => x.id === r.id);
    return Object.assign({}, r, { autoState: (here && here.autoState) || { jobIds: [] } });
  });

  local.apiBaseUrl = incoming.apiBaseUrl || local.apiBaseUrl;
  local.apiUsername = incoming.apiUsername || local.apiUsername;
  local.arm = Object.assign({}, local.arm, incoming.arm || {}, { password: secrets.armPassword || (local.arm || {}).password });
  local.mpdv = Object.assign({}, local.mpdv, incoming.mpdv || {}, { password: secrets.mpdvPassword || (local.mpdv || {}).password });
  if (secrets.apiPassword) local.apiPassword = secrets.apiPassword;
  if (secrets.adminPassword) local.adminPassword = secrets.adminPassword;

  await persist();
  renderCatalog();
  renderCart();
  applyMode();
  if (currentView === 'admin') renderAdmin();
}

async function loadSetupFromGitHub(opts, button) {
  const label = button && button.textContent;
  if (button) { button.disabled = true; button.textContent = 'Loading…'; }
  let res;
  try {
    res = await window.api.syncFetch(opts);
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (button) { button.disabled = false; button.textContent = label; }

  if (!res.ok) {
    // A file with encrypted passwords is useless without the passphrase, so ask
    // for it rather than quietly loading half a setup.
    if (res.needsPassphrase || res.badPassphrase) {
      promptModal('Passphrase needed', 'This setup carries encrypted passwords', 'password', '', async (val, close, setErr) => {
        if (!val) { setErr('Enter the passphrase used when it was published.'); return; }
        const retry = await window.api.syncFetch(Object.assign({}, opts, { passphrase: val }));
        if (!retry.ok) { setErr(retry.error || 'Could not read it.'); return; }
        close();
        store.settings.sync = Object.assign({}, store.settings.sync, opts, { passphrase: val });
        await applySyncedConfig(retry.config);
        toast(`Setup loaded — saved ${shortDateTime(retry.savedAt)}`, 'success');
      });
      return;
    }
    toast(res.error || 'Could not load the setup.', 'error');
    return;
  }
  store.settings.sync = Object.assign({}, store.settings.sync, opts);
  await applySyncedConfig(res.config);
  toast(`Setup loaded — saved ${shortDateTime(res.savedAt)}`, 'success');
}

// ---- Admin: settings ----
function renderAdminSettings() {
  const body = $('#adminBody');
  const s = store.settings;
  const y = s.sync || {};
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
      <h2>Setup sync (GitHub)</h2>
      <p class="hint">Keeps this shop's setup — products, stations, robots, nodes, recalls and connection details — in one file in a GitHub repository, so a new machine can pull it instead of being configured by hand.</p>
      <div class="sync-warn">🔒 <b>The repository is public.</b> Passwords are never published in the clear: without a passphrase they are left out of the file altogether, and with one they are encrypted and can only be read back by someone who knows it. The token and passphrase below stay on this machine.</div>
      <div class="form-grid">
        <label class="fld">Repository
          <input class="inp" id="y-repo" value="${escapeHtml(y.repo || '')}" placeholder="owner/name">
        </label>
        <label class="fld">Branch
          <input class="inp" id="y-branch" value="${escapeHtml(y.branch || 'main')}">
        </label>
        <label class="fld">File
          <input class="inp" id="y-path" value="${escapeHtml(y.path || 'gradion-setup.json')}">
        </label>
        <label class="fld">Token (publishing only)
          <input class="inp" id="y-token" type="password" value="${escapeHtml(y.token || '')}" placeholder="ghp_… / github_pat_…">
          <span class="fld-hint">Needs <b>Contents: write</b> on that repository. Loading a public repo needs no token.</span>
        </label>
        <label class="fld full">Passphrase for passwords (optional)
          <input class="inp" id="y-pass" type="password" value="${escapeHtml(y.passphrase || '')}" placeholder="Leave empty to publish without any passwords">
          <span class="fld-hint">Set the same passphrase on the other machine to bring the SYNAOS, arm, MPDV and admin passwords across.</span>
        </label>
      </div>
      <div class="progress-actions" style="margin-top:16px; align-items:center;">
        <button class="btn btn-primary" id="syncPublish">⬆️ Publish this setup</button>
        <button class="btn btn-secondary" id="syncLoad">⬇️ Load setup from GitHub</button>
        <span class="api-status" id="syncStatus"><span class="dot"></span> ${escapeHtml(syncStatusText(y))}</span>
      </div>
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
      ? log.map((l, i) => `<div class="mpdv-log-item ${l.ok ? '' : 'failed'}">
          <div class="mpdv-log-head">
            <span class="dir ${l.ok ? 'in' : 'out'}">${l.ok ? '✅ sent' : '❌ failed'}</span>
            <code>${escapeHtml(l.orderNumber || '—')}</code>
            <span class="chip">HTTP ${l.status === 0 ? 'no reply' : l.status}</span>
            <span class="msg">${escapeHtml(l.productName || '')} ×${l.quantity}</span>
            <span class="mpdv-log-time">${escapeHtml(new Date(l.at).toLocaleString())}</span>
          </div>
          ${l.ok ? '' : `<div class="mpdv-log-err">${escapeHtml(l.error || 'Rejected')}</div>`}
          ${l.createdId ? `<div class="mpdv-log-created">${l.createdId === l.orderNumber
            ? `MPDV created <b>${escapeHtml(l.createdId)}</b>`
            : `<span class="mpdv-id-warn">MPDV stored it as <b>${escapeHtml(l.createdId)}</b>, not ${escapeHtml(l.orderNumber || '—')}</span>`}</div>` : ''}
          ${l.response ? `<details class="mpdv-log-raw"><summary>MPDV response${l.ok ? ' (accepted)' : ''}</summary><pre>${escapeHtml(prettyJson(l.response))}</pre></details>` : ''}
          ${l.request ? `<details class="mpdv-log-raw"><summary>Request we sent</summary><pre>${escapeHtml(prettyJson(l.request))}</pre></details>` : ''}
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
  $('#syncPublish').addEventListener('click', async (e) => {
    const opts = syncOptionsFromForm();
    const what = opts.passphrase
      ? 'Products, stations, robots, nodes and recalls go up, with the passwords encrypted under your passphrase.'
      : 'Products, stations, robots, nodes and recalls go up. No passwords are included — the other machine will need them typed in once.';
    confirmModal('Publish this setup?', `${what} It replaces whatever is in ${escapeHtml(opts.repo)} at ${escapeHtml(opts.path)}.`, async () => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = 'Publishing…';
      let res;
      try {
        res = await window.api.syncPublish(opts);
      } catch (err) {
        res = { ok: false, error: err.message };
      }
      btn.disabled = false;
      btn.textContent = '⬆️ Publish this setup';
      if (!res.ok) { toast(res.error || 'Could not publish.', 'error'); return; }
      store.settings.sync = Object.assign({}, store.settings.sync, opts, { lastPublishedAt: res.at });
      await persist();
      renderAdminSettings();
      toast(`Setup published — ${(res.bytes / 1024).toFixed(0)} kB${res.secretsIncluded ? ', passwords encrypted' : ', no passwords'}`, 'success');
    });
  });
  $('#syncLoad').addEventListener('click', (e) => {
    confirmModal('Load setup from GitHub?',
      'This replaces the products, stations, robots, nodes and recalls on this machine with the published ones. Orders and logs are left alone.',
      () => loadSetupFromGitHub(syncOptionsFromForm(), e.target));
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

// ===========================================================================
// Recall bubble
//
// A comic thought-bubble that pops up when a recall goes out, so the shop can
// see the rack is being fetched back rather than wondering why an AGV just
// turned up. Drawn as one SVG: every lobe is stroked first, then the same
// lobes are filled on top, which hides the lines where they overlap and leaves
// a single cloud outline.
// ===========================================================================
const RECALL_BUBBLE_MS = 8000;
const BUBBLE_LOBES = [
  [80, 80, 54], [150, 62, 54], [214, 84, 50], [118, 112, 44],
  [186, 118, 40], [252, 112, 30], [52, 104, 34],
  [58, 180, 15], [26, 202, 8]           // the two trailing thought bubbles
];
let recallBubbleTimer = null;

function showRecallBubble(name) {
  dismissRecallBubble(true);
  const circles = BUBBLE_LOBES.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('');
  const el = document.createElement('div');
  el.id = 'recallBubble';
  el.className = 'recall-bubble';
  el.title = 'Click to dismiss';
  el.innerHTML = `
    <svg class="rb-cloud" viewBox="0 0 300 215" aria-hidden="true">
      <g class="rb-outline">${circles}</g>
      <g class="rb-fill">${circles}</g>
    </svg>
    <div class="rb-text">
      <span class="rb-emoji">↩️</span>
      <span class="rb-name">${escapeHtml(name)}</span>
      <span class="rb-sub">is on its way 🚚</span>
    </div>`;
  el.addEventListener('click', () => dismissRecallBubble());
  document.body.appendChild(el);
  recallBubbleTimer = setTimeout(() => dismissRecallBubble(), RECALL_BUBBLE_MS);
}

function dismissRecallBubble(immediate) {
  if (recallBubbleTimer) { clearTimeout(recallBubbleTimer); recallBubbleTimer = null; }
  const el = $('#recallBubble');
  if (!el) return;
  if (immediate) { el.remove(); return; }
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 400);
}

// ===========================================================================
// "Not ready yet?" — the shop's 30-second warning before an automatic recall
// ===========================================================================
let recallAskTimer = null;

function showRecallAsk(recall) {
  dismissRecallAsk();
  const cfg = autoCfg(recall);
  const st = autoState(recall);
  const secondsLeft = () => Math.max(0, Math.round((new Date(st.nextDueAt).getTime() - Date.now()) / 1000));

  const el = document.createElement('div');
  el.id = 'recallAsk';
  el.className = 'recall-ask';
  el.innerHTML = `
    <div class="ra-card">
      <div class="ra-head">
        <span class="ra-emoji">↩️</span>
        <div>
          <div class="ra-title">${escapeHtml(recall.name || 'Recall')}</div>
          <div class="ra-sub">A robot is coming to collect in <b class="ra-count">${secondsLeft()}</b>s — need more time?</div>
        </div>
      </div>
      <div class="ra-btns">
        ${cfg.delayOptions.map((m) => `<button class="btn btn-secondary" data-ra-delay="${m}">+${m} min</button>`).join('')}
        <button class="btn btn-primary" data-ra-go="1">I'm done — go now</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  $$('[data-ra-delay]', el).forEach((b) =>
    b.addEventListener('click', () => delayAutoRecall(recall.id, Number(b.dataset.raDelay))));
  $('[data-ra-go]', el).addEventListener('click', () => releaseAutoRecall(recall.id));

  // Its own second-by-second countdown; the scheduler only ticks every 5s
  recallAskTimer = setInterval(() => {
    const left = secondsLeft();
    const label = $('.ra-count', el);
    if (label) label.textContent = String(left);
    if (left <= 0) dismissRecallAsk();
  }, 1000);
}

function dismissRecallAsk() {
  if (recallAskTimer) { clearInterval(recallAskTimer); recallAskTimer = null; }
  const el = $('#recallAsk');
  if (el) el.remove();
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
