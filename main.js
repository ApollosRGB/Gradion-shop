const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Persistent store (JSON file in the per-user app data folder)
// ---------------------------------------------------------------------------

let storePath;

function defaultStore() {
  return {
    settings: {
      adminPassword: 'Ts13',
      theme: 'light',
      apiBaseUrl: 'https://ace.one.stg.synaos.cloud',
      apiUsername: 'ace',
      apiPassword: 'X#jzd.0sdc20b0q#MYa"',
      // Robotic arm that physically transfers a load between two AGVs at a
      // hand-over station. Credentials are entered by the operator and only
      // ever stored locally.
      arm: {
        enabled: true,
        brokerUrl: 'mqtts://mqtt.ace.one.stg.synaos.cloud:8883',
        tlsInsecure: true,           // broker uses TLS but its certificate is not validated
        username: 'synaos',
        password: 'MpUWLrfoXlPBC4BXADgYjXtYO',
        clientId: '',
        commandTopic: 'Openmind/robot01/cmd',
        statusTopic: 'Openmind/robot01/status',
        // Placeholders: {taskId} {method} {quantity} {from} {to} {orderId} {unitId}
        payloadTemplate: '{\n  "task_id": "{taskId}",\n  "method": "{method}",\n  "quantity": {quantity}\n}',
        statusField: 'status',       // JSON field to read from the status message ('' = match raw text)
        statusDoneValue: 'Finished', // value meaning the arm has completed the task
        statusMatchField: 'task_id', // field tying a status back to its command
        timeoutSeconds: 120          // give up waiting and continue anyway
      },
      // MPDV MES — an alternative to dispatching AGV jobs. An order placed here
      // becomes a BOOrder plus one BOOperation per arm; the order goes first,
      // because the operations reference its id.
      mpdv: {
        baseUrl: 'https://azu-tr-vhxw-10.mpdv.cloud:8080',
        accessId: '00099831',
        username: '12345',
        password: 'mpdv',
        tlsInsecure: true,           // host does not serve its full certificate chain
        latestEndTs: '2026-08-05T00:00:00.000+08:00',
        language: 'en',
        timeZoneId: 'Asia/Singapore',
        // One operation per arm, sent for every order. The identity fields are
        // editable; the formulas, modes and cycle target are sent as supplied.
        operations: [
          { label: 'Openmind arm', operation: '0010', workplace: 'ROBOT01', article: 'BRACES', designation: 'BRACES', unit: 'PCS' },
          { label: 'Kuka arm', operation: '0010', workplace: 'ROBOT02', article: 'PEN', designation: 'PEN', unit: 'PCS' }
        ]
      },
      // Where this shop's setup (products, stations, robots, recalls) is kept so
      // a new install can pull it instead of being configured by hand. The token
      // and passphrase live here only — they are never part of what is published.
      sync: {
        repo: 'ApollosRGB/Gradion-shop',
        branch: 'setups',
        // The name this shop's setup is published under — all another machine
        // needs. The file it maps to (setups/<name>.json) is worked out for you.
        name: 'setup1',
        path: '',
        token: '',
        passphrase: '',
        lastPublishedAt: null,
        lastLoadedAt: null
      }
    },
    // Running order number: DDMMYY + a 4-digit counter that restarts each day
    mpdvCounter: { date: '', seq: 0 },
    mpdvLog: [],
    stations: [
      { id: 'st-k2', stationId: 'K2', name: 'Production', fn: 'production', system: 'STATION', allowedRobots: [], image: null },
      { id: 'st-k1', stationId: 'K1', name: 'Shop', fn: 'shop', system: 'STATION', allowedRobots: [], image: null }
    ],
    robots: [],
    // Navigation-graph nodes (waiting spots, parking, staging) kept apart from
    // handling stations because they live in a graph, not the STATION system.
    nodes: [],
    capability: {},
    // Admin-only routes for fetching a rack back, e.g. Shop -> Production.
    // Kept out of the shop so a customer order does not have to include the
    // return trip that immediately undoes the delivery.
    recalls: [],
    recallLog: [],
    pendingRelays: [],
    armConfigVersion: ARM_CONFIG_VERSION,
    products: [
      {
        id: 'p-pen',
        name: 'Branded Pen (in rigid sleeve)',
        price: 5,
        image: null,
        visible: true,
        rating: 4.9,
        ratingCount: 642,
        sold: 642,
        steps: [
          { stationRef: 'st-k2', action: 'PICK' },
          { stationRef: 'st-k1', action: 'DROP' }
        ]
      },
      {
        id: 'p-notebook',
        name: 'Mini Branded Notebook',
        price: 8,
        image: null,
        visible: true,
        rating: 4.8,
        ratingCount: 729,
        sold: 729,
        steps: [
          { stationRef: 'st-k2', action: 'PICK' },
          { stationRef: 'st-k1', action: 'DROP' }
        ]
      }
    ],
    orders: []
  };
}

// Bumped whenever the shipped arm configuration changes. Saved settings always
// win over defaults, so without this an install that already has an older arm
// block would never pick up new broker details.
const ARM_CONFIG_VERSION = 2;

// The values the arm block shipped with before the real broker was known. A
// field still holding one of these was never configured by the operator, so it
// is safe to replace with the current default; anything they changed is kept.
const SUPERSEDED_ARM_VALUES = {
  enabled: false,
  brokerUrl: 'mqtt://localhost:1883',
  username: '',
  password: '',
  commandTopic: 'arm/command',
  statusTopic: 'arm/status',
  payloadTemplate: '{\n  "command": "transfer",\n  "from": "{from}",\n  "to": "{to}",\n  "orderId": "{orderId}",\n  "transferId": "{transferId}"\n}',
  statusDoneValue: 'done',
  statusMatchField: 'transferId'
};

// `defaultArm` must be a pristine copy of the shipped defaults — never the
// object that the saved settings were merged into, or every comparison below
// would be against the saved value itself and nothing would ever migrate.
function migrateArmConfig(data, defaultArm) {
  if ((Number(data.armConfigVersion) || 1) >= ARM_CONFIG_VERSION) return false;
  const arm = data.settings.arm;
  let changed = false;
  Object.keys(SUPERSEDED_ARM_VALUES).forEach((key) => {
    if (arm[key] === SUPERSEDED_ARM_VALUES[key] && arm[key] !== defaultArm[key]) {
      arm[key] = defaultArm[key];
      changed = true;
    }
  });
  if (arm.tlsInsecure === undefined) { arm.tlsInsecure = defaultArm.tlsInsecure; changed = true; }
  data.armConfigVersion = ARM_CONFIG_VERSION;
  return changed;
}

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const data = JSON.parse(raw);
    // Merge with defaults so new fields appear after app updates. Assign into a
    // fresh object so the defaults themselves stay pristine for the migration.
    const def = defaultStore();
    const defaultArm = Object.assign({}, def.settings.arm);
    const arm = Object.assign({}, defaultArm, (data.settings && data.settings.arm) || {});
    const mpdv = Object.assign({}, def.settings.mpdv, (data.settings && data.settings.mpdv) || {});
    // v1.12 replaced the workplan-order call with BOOrder + BOOperation. Carry
    // the host and access id out of the old single endpoint so the credentials
    // and address an install already had keep working.
    if (mpdv.endpoint) {
      try {
        const old = new URL(mpdv.endpoint);
        if (!(data.settings && data.settings.mpdv && data.settings.mpdv.baseUrl)) {
          mpdv.baseUrl = `${old.protocol}//${old.host}`;
        }
        const id = old.searchParams.get('X-Access-Id');
        if (id && !(data.settings && data.settings.mpdv && data.settings.mpdv.accessId)) mpdv.accessId = id;
      } catch (e) { /* unparseable old endpoint — the defaults stand */ }
      delete mpdv.endpoint;
    }
    delete mpdv.workplanOrderId;      // workplan orders are no longer created
    delete mpdv.orderType;            // now per product: which AGV fetches it
    if (!Array.isArray(mpdv.operations) || !mpdv.operations.length) mpdv.operations = def.settings.mpdv.operations;
    const sync = Object.assign({}, def.settings.sync, (data.settings && data.settings.sync) || {});
    // Setups used to be committed to main alongside the code. Move an existing
    // install onto the data branch once; reading falls back to the default
    // branch, so anything already published stays reachable until it is
    // published again. Done once, so a deliberate choice of main is respected.
    if (!sync.branchMoved) {
      if (!sync.branch || sync.branch === 'main' || sync.branch === 'master') sync.branch = SYNC_BRANCH;
      sync.branchMoved = true;
    }
    data.settings = Object.assign({}, def.settings, data.settings || {});
    data.settings.arm = arm;
    data.settings.mpdv = mpdv;
    data.settings.sync = sync;
    data.mpdvCounter = data.mpdvCounter || { date: '', seq: 0 };
    data.mpdvLog = data.mpdvLog || [];

    // Carry an existing install forward onto the current arm configuration
    if (migrateArmConfig(data, defaultArm) && storePath) {
      try { saveStore(data); } catch (e) { /* read-only run; migration still applies in memory */ }
    }
    data.pendingRelays = data.pendingRelays || [];
    data.stations = data.stations || def.stations;
    data.stations.forEach((s) => {
      if (!s.system) s.system = 'STATION';
      if (!Array.isArray(s.allowedRobots)) s.allowedRobots = [];
      if (s.image === undefined) s.image = null;   // optional station icon
    });
    data.capability = data.capability || {};
    data.products = data.products || def.products;
    // Seed rating counters so the displayed rating can become a running average
    data.products.forEach((p) => { if (p.ratingCount == null) p.ratingCount = p.sold || 0; });
    data.robots = data.robots || [];
    data.robots.forEach((r) => { if (r.homeNode === undefined) r.homeNode = null; });
    data.nodes = data.nodes || [];
    data.recalls = data.recalls || [];
    // A recall may run itself once an order has been delivered — `everyMinutes`
    // is the wait after that delivery, and `autoState` is the bookkeeping for
    // the pending countdown and the last run, not configuration.
    data.recalls.forEach((r) => {
      r.auto = Object.assign({
        enabled: false, everyMinutes: 30, onlyWhenIdle: true,
        // Which deliveries wake it: any, only orders containing certain
        // products, or only orders a certain AGV delivered.
        triggerMode: 'any', triggerProducts: [], triggerRobots: [],
        // The shop gets 30s notice and can push the run back by one of these
        askBefore: true, delayOptions: [2, 5, 10, 15]
      }, r.auto || {});
      r.autoState = Object.assign({ jobIds: [] }, r.autoState || {});
    });
    data.recallLog = data.recallLog || [];
    data.orders = data.orders || [];
    return data;
  } catch (e) {
    return defaultStore();
  }
}

// Written by the main process only — see the store:set handler.
const MAIN_OWNED_KEYS = ['pendingRelays', 'mpdvLog', 'mpdvCounter'];

function saveStore(data) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = storePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, storePath);
}

// ---------------------------------------------------------------------------
// SYNAOS Job Management API client
// ---------------------------------------------------------------------------

function apiRequest(settings, method, apiPath, body) {
  return new Promise((resolve) => {
    let base;
    try {
      base = new URL(settings.apiBaseUrl);
    } catch (e) {
      resolve({ ok: false, status: 0, error: 'Invalid API base URL' });
      return;
    }
    const https = base.protocol === 'http:' ? require('http') : require('https');
    const auth = Buffer.from(`${settings.apiUsername}:${settings.apiPassword}`).toString('base64');
    const payload = body ? JSON.stringify(body) : null;
    const basePath = base.pathname.replace(/\/$/, '');
    const options = {
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path: basePath + apiPath,
      method,
      timeout: 20000,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json, application/problem+json'
      }
    };
    if (payload) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        let json = null;
        try {
          json = chunks ? JSON.parse(chunks) : null;
        } catch (e) {
          /* non-JSON body */
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: json, raw: chunks });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: 'Request timed out' });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Robotic arm over MQTT
//
// When a route changes robot mid-way the load has to be physically moved from
// the outgoing AGV to the incoming one. That transfer is done by a robotic arm
// which listens on an MQTT topic and reports back on a status topic. The
// receiving AGV's job is only created once the arm says the transfer is done.
// ---------------------------------------------------------------------------

const mqtt = require('mqtt');

const armState = {
  client: null,
  url: null,
  connected: false,
  lastError: null,
  waiters: new Set(),   // { transferId, resolve, done }
  log: []               // recent traffic, surfaced in the admin panel
};

function armLog(direction, topic, message) {
  armState.log.unshift({ at: new Date().toISOString(), direction, topic, message: String(message).slice(0, 300) });
  armState.log.length = Math.min(armState.log.length, 40);
}

function armConfigKey(arm) {
  return [arm.brokerUrl, arm.username, arm.password, arm.clientId, arm.statusTopic, arm.tlsInsecure].join('|');
}

// A refused connection surfaces as an AggregateError (one failure per resolved
// address) whose own message is empty, so unwrap it into something an operator
// can actually act on.
function describeMqttError(err) {
  if (!err) return 'Unknown error';
  const parts = Array.isArray(err.errors)
    ? [...new Set(err.errors.map((e) => e && (e.code || e.message)).filter(Boolean))]
    : [];
  return parts.join(', ') || err.message || err.code || String(err);
}

// Connects (or reconnects when the configuration changed) and subscribes to the
// status topic. Resolves once connected, rejects on the first failure.
function connectArm(arm) {
  return new Promise((resolve, reject) => {
    const key = armConfigKey(arm);
    if (armState.client && armState.connected && armState.url === key) {
      resolve(armState.client);
      return;
    }
    if (armState.client) {
      try { armState.client.end(true); } catch (e) { /* ignore */ }
      armState.client = null;
      armState.connected = false;
    }
    let settled = false;
    const client = mqtt.connect(arm.brokerUrl, {
      username: arm.username || undefined,
      password: arm.password || undefined,
      clientId: arm.clientId || `gradion-shop-${crypto.randomUUID().slice(0, 8)}`,
      connectTimeout: 8000,
      reconnectPeriod: 5000,
      clean: true,
      // The broker encrypts but presents a certificate that does not validate,
      // matching "Encryption (tls)" on with "Validate certificate" off.
      rejectUnauthorized: !arm.tlsInsecure
    });
    armState.client = client;
    armState.url = key;

    client.on('connect', () => {
      armState.connected = true;
      armState.lastError = null;
      if (arm.statusTopic) {
        client.subscribe(arm.statusTopic, (err) => {
          if (err) armState.lastError = `subscribe failed: ${err.message}`;
        });
      }
      if (!settled) { settled = true; resolve(client); }
    });
    client.on('message', (topic, payload) => {
      const text = payload.toString();
      armLog('in', topic, text);
      handleArmStatus(arm, text);
    });
    client.on('error', (err) => {
      const message = describeMqttError(err);
      armState.lastError = message;
      armState.connected = false;
      if (!settled) {
        settled = true;
        // Stop retrying a connection nobody is waiting on any more
        try { client.end(true); } catch (e) { /* ignore */ }
        reject(new Error(message));
      }
    });
    client.on('close', () => { armState.connected = false; });
  });
}

// Decides whether a status message means "the transfer finished", and for which
// transfer. A message that carries no identifying field resolves any waiter.
function handleArmStatus(arm, text) {
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* plain text status */ }

  const doneValue = String(arm.statusDoneValue || 'done').toLowerCase();
  let isDone;
  if (body && arm.statusField && body[arm.statusField] !== undefined) {
    isDone = String(body[arm.statusField]).toLowerCase() === doneValue;
  } else {
    isDone = text.toLowerCase().includes(doneValue);
  }
  if (!isDone) return;

  const idField = arm.statusMatchField;
  const statusId = body && idField ? body[idField] : undefined;
  for (const waiter of [...armState.waiters]) {
    if (statusId !== undefined && String(statusId) !== String(waiter.transferId)) continue;
    waiter.done('status');
  }
}

// Sequential task ids in the arm's own style (task-0001, task-0002, …) so its
// logs line up with ours. The status message echoes this back.
function nextArmTaskId() {
  const store = loadStore();
  const next = (Number(store.armTaskSeq) || 0) + 1;
  store.armTaskSeq = next;
  saveStore(store);
  return `task-${String(next).padStart(4, '0')}`;
}

function renderArmPayload(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) =>
    (values[key] !== undefined ? String(values[key]) : match));
}

// Publishes a transfer command and waits for the arm to report completion.
// Falls back to continuing after `timeoutSeconds` so a silent arm cannot wedge
// an order forever.
async function runArmTransfer(arm, values) {
  await connectArm(arm);
  const payload = renderArmPayload(arm.payloadTemplate, values);
  armState.client.publish(arm.commandTopic, payload, { qos: 1 });
  armLog('out', arm.commandTopic, payload);

  if (!arm.statusTopic) return { ok: true, via: 'no-status-topic' };

  return new Promise((resolve) => {
    // The arm echoes the task id back in its status, so that is what a status
    // message is matched against.
    const waiter = { transferId: values.taskId !== undefined ? values.taskId : values.transferId };
    let timer = null;
    waiter.done = (via) => {
      if (!armState.waiters.has(waiter)) return;
      armState.waiters.delete(waiter);
      if (timer) clearTimeout(timer);
      resolve({ ok: via === 'status', via });
    };
    armState.waiters.add(waiter);
    timer = setTimeout(() => waiter.done('timeout'), Math.max(5, Number(arm.timeoutSeconds) || 120) * 1000);
  });
}

// ---------------------------------------------------------------------------
// MPDV MES
//
// An order can be sent to MPDV as a workplan order instead of being dispatched
// to the AGVs. Each order gets a running number of the form DDMMYY0001 that
// restarts every day, and the quantity ordered becomes the planned yield.
// ---------------------------------------------------------------------------

// The date part follows the configured time zone, so the number matches the day
// MPDV itself will record rather than whatever the PC's clock is set to.
function mpdvDateKey(timeZoneId, when) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZoneId || 'Asia/Singapore',
    day: '2-digit', month: '2-digit', year: '2-digit'
  }).formatToParts(when || new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('day')}${get('month')}${get('year')}`;   // DDMMYY
}

// MPDV stores this id in an 8-character field, so the running number is
// DDMMYY plus a two-digit counter (030826 + 01 -> "03082601"). A longer number
// would be truncated, and every order of the day would collide on one id.
const MPDV_MAX_ORDERS_PER_DAY = 99;

// A refused operation is tried again before the next one goes out
const MPDV_ATTEMPTS = 3;
const MPDV_RETRY_MS = 1000;      // 1s after the first failure, 2s after the second

function formatMpdvOrderNumber(dateKey, seq) {
  return `${dateKey}${String(seq).padStart(2, '0')}`;
}

// Reserves the next number for today. Persisted, so numbering survives restarts.
function nextMpdvOrderNumber(timeZoneId, when) {
  const store = loadStore();
  const key = mpdvDateKey(timeZoneId, when);
  const counter = store.mpdvCounter || { date: '', seq: 0 };
  const seq = (counter.date === key ? Number(counter.seq) || 0 : 0) + 1;
  if (seq > MPDV_MAX_ORDERS_PER_DAY) {
    // Refuse rather than send a 9-character number that MPDV would truncate
    // into a duplicate of an earlier order.
    const err = new Error(`Daily limit reached: MPDV order ids only hold ${MPDV_MAX_ORDERS_PER_DAY} orders per day (${key}).`);
    err.code = 'MPDV_DAILY_LIMIT';
    throw err;
  }
  store.mpdvCounter = { date: key, seq };
  saveStore(store);
  return formatMpdvOrderNumber(key, seq);
}

// Where the two calls live. Both hang off the same host and access id, so only
// those two are configured rather than a URL each.
function mpdvUrl(cfg, resource) {
  const base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
  return `${base}/data/${resource}/insert?X-Access-Id=${encodeURIComponent(cfg.accessId || '')}`;
}

function mpdvQuantity(quantity) {
  return Number(quantity) > 0 ? Number(quantity) : 1;
}

// The order itself. Its id is the running number the shop will quote later, and
// ordertype is which AGV goes for it — 0 kuka, 1 tusk — which each product
// carries, so a cart line decides its own.
function buildMpdvOrderPayload(cfg, orderNumber, orderType, quantity, requestId) {
  return {
    params: [
      { acronym: 'order.id', operator: 'EQUAL', value: orderNumber },
      { acronym: 'order.ordertype', operator: 'EQUAL', value: String(orderType == null ? '0' : orderType) },
      { acronym: 'order.plan.yield.base', operator: 'EQUAL', value: mpdvQuantity(quantity) },
      { acronym: 'order.latest_end_ts', operator: 'EQUAL', value: cfg.latestEndTs }
    ],
    columns: [],
    requestId: Number(requestId) > 0 ? Number(requestId) : 1,
    language: cfg.language || 'en',
    timeZoneId: cfg.timeZoneId || 'Asia/Singapore',
    returnAsObject: true
  };
}

// One operation per arm, tied to the order by the same id and carrying the same
// quantity. Everything below the identity fields is sent exactly as supplied.
function buildMpdvOperationPayload(cfg, orderNumber, op, quantity, requestId) {
  return {
    params: [
      { acronym: 'order.id', operator: 'EQUAL', value: orderNumber },
      { acronym: 'operation.operation', operator: 'EQUAL', value: String(op.operation || '0010') },
      { acronym: 'operation.plan.workplace', operator: 'EQUAL', value: op.workplace },
      { acronym: 'operation.article', operator: 'EQUAL', value: op.article },
      { acronym: 'operation.designation', operator: 'EQUAL', value: op.designation },
      { acronym: 'operation.plan.yield.primary', operator: 'EQUAL', value: mpdvQuantity(quantity) },
      { acronym: 'operation.plan.unit.primary', operator: 'EQUAL', value: op.unit || 'PCS' },
      { acronym: 'operation.processing_time.formula', operator: 'EQUAL', value: 'BEA_ZY' },
      { acronym: 'operation.processing_time.mode', operator: 'EQUAL', value: 'FORMULA' },
      { acronym: 'operation.remaining_runtime.formula', operator: 'EQUAL', value: 'RLFZ' },
      { acronym: 'operation.remaining_runtime.mode', operator: 'EQUAL', value: 'FORMULA' },
      { acronym: 'operation.cycle.target', operator: 'EQUAL', value: 60000 }
    ],
    columns: [],
    requestId: Number(requestId) > 0 ? Number(requestId) : 7,
    language: cfg.language || 'en',
    timeZoneId: cfg.timeZoneId || 'Asia/Singapore',
    returnAsObject: true
  };
}

function mpdvRequest(cfg, body, endpoint) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(endpoint || mpdvUrl(cfg, 'BOOrder'));
    } catch (e) {
      resolve({ ok: false, status: 0, error: 'Invalid MPDV address — check the base URL and access id.' });
      return;
    }
    const transport = url.protocol === 'http:' ? require('http') : require('https');
    const payload = JSON.stringify(body);
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      method: 'POST',
      timeout: 25000,
      rejectUnauthorized: !cfg.tlsInsecure,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* not json */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, raw });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'Request timed out' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.write(payload);
    req.end();
  });
}

// MPDV answers 200 even for a rejected order, with the problem described in the
// body, so success is judged on the body as well as the status code.
// Digs the human-readable message out of whatever MPDV sends back. It is not
// consistent: a rejection can arrive as HTTP 400 with a JSON body, or as HTTP
// 200 whose body describes the problem, and the message may sit under any of
// several field names or inside its __rowType row format. Whatever happens the
// raw body is kept so nothing is hidden from the operator.
const MPDV_MESSAGE_FIELDS = [
  'errorMessage', 'error_message', 'message', 'error', 'errorText', 'text',
  'detail', 'details', 'description', 'reason', 'exception', 'exceptionMessage',
  'localizedMessage', 'msg', 'errorDescription'
];

function extractMpdvMessage(value, depth) {
  if (value === null || value === undefined || (depth || 0) > 6) return null;
  if (typeof value === 'string') {
    const s = value.trim();
    return s && s !== '{}' && s !== '[]' ? s : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractMpdvMessage(item, (depth || 0) + 1);
      if (found) return found;
    }
    return null;
  }
  // Prefer a recognised message field on this object
  for (const field of MPDV_MESSAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      const found = extractMpdvMessage(value[field], (depth || 0) + 1);
      if (found) return found;
    }
  }
  // MPDV wraps payloads in rows; the useful part hides under obj/data/result
  for (const container of ['obj', 'data', 'result', 'response', 'body', 'errors', 'faults']) {
    if (Object.prototype.hasOwnProperty.call(value, container)) {
      const found = extractMpdvMessage(value[container], (depth || 0) + 1);
      if (found) return found;
    }
  }
  return null;
}

// The id MPDV actually created, read from its __rowType: OBJECT row. Worth
// surfacing because MPDV truncates the id to 8 characters, so what it stored
// can differ from what was sent.
function extractMpdvCreatedId(body) {
  const rows = Array.isArray(body) ? body : [body];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const obj = row.obj || row.data;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const value = obj['order.id'] || obj['workplanorder.id'] || obj['workplanorder.target.id'];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
  }
  return null;
}

// True when the body itself signals a failure even though the status said 200.
function mpdvBodyLooksFailed(body) {
  if (!body) return false;
  const rows = Array.isArray(body) ? body : [body];
  return rows.some((row) => row && typeof row === 'object'
    && (/error|fault|exception/i.test(String(row.__rowType || ''))
      || row.error !== undefined || row.errorMessage !== undefined
      || row.exception !== undefined
      || (Array.isArray(row.errors) && row.errors.length > 0)));
}

function interpretMpdvResponse(res) {
  const raw = typeof res.raw === 'string' ? res.raw : '';
  const detail = raw.slice(0, 4000);

  // Never reached the server (DNS, TLS, timeout) — there is no body to read
  if (res.status === 0) {
    return { ok: false, error: res.error || 'Could not reach MPDV', detail, httpStatus: 0 };
  }

  const message = extractMpdvMessage(res.data, 0);

  if (!res.ok) {
    // MPDV's own words if it gave any, otherwise the raw body, otherwise status
    const fallback = raw.trim() ? raw.trim().slice(0, 400) : `HTTP ${res.status}`;
    return { ok: false, error: message || fallback, detail, httpStatus: res.status };
  }

  if (mpdvBodyLooksFailed(res.data)) {
    return { ok: false, error: message || 'MPDV rejected the order', detail, httpStatus: res.status };
  }

  return { ok: true, detail, httpStatus: res.status, createdId: extractMpdvCreatedId(res.data) };
}

function recordMpdvLog(entry) {
  const store = loadStore();
  store.mpdvLog = store.mpdvLog || [];
  store.mpdvLog.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  store.mpdvLog.length = Math.min(store.mpdvLog.length, 50);
  saveStore(store);
}

// ---------------------------------------------------------------------------
// Resource scanning
//
// SYNAOS exposes no fleet listing over Basic auth, and job history only reveals
// robots that have already run a job — which is why a registered but unused AGV
// stays invisible. The resource-mode endpoint answers 200 for a real resource
// and 404 otherwise, so candidate ids can be checked one by one.
// ---------------------------------------------------------------------------

const SCAN_LIMIT = 600;

// Expands `36020-36040`, `kuka0*`, `VNP15-0[1-9]`, `00?` into concrete ids.
// Ranges keep their zero padding, so `001-010` yields 001…010, not 1…10.
function expandScanPattern(pattern) {
  const token = String(pattern || '').trim();
  if (!token) return [];

  // A whole-token numeric range, optionally with a shared prefix/suffix
  const range = token.match(/^(.*?)(\d+)-(\d+)(.*)$/);
  if (range) {
    const [, prefix, fromRaw, toRaw, suffix] = range;
    const from = parseInt(fromRaw, 10);
    const to = parseInt(toRaw, 10);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
      const width = Math.max(fromRaw.length, toRaw.length);
      const out = [];
      // Bounded here as well as in expandScanInput, so an enormous range is
      // trimmed rather than falling through and being scanned as a literal id.
      const last = Math.min(to, from + SCAN_LIMIT);
      for (let i = from; i <= last; i++) out.push(`${prefix}${String(i).padStart(width, '0')}${suffix}`);
      return out.flatMap((t) => expandCharClasses(t));
    }
  }
  return expandCharClasses(token);
}

const DIGITS = '0123456789'.split('');
const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyz'.split('');

// Expands [1-9] / [abc] classes and the single-character wildcards:
//   #  or  *   one digit
//   ?           one digit or letter — needed for ids like AFS1000-Sim01
function expandCharClasses(token, depth) {
  if ((depth || 0) > 8) return [token];

  const cls = token.match(/\[([^\]]+)\]/);
  if (cls) {
    const chars = [];
    const spec = cls[1];
    for (let i = 0; i < spec.length; i++) {
      if (spec[i + 1] === '-' && spec[i + 2]) {
        for (let c = spec.charCodeAt(i); c <= spec.charCodeAt(i + 2); c++) chars.push(String.fromCharCode(c));
        i += 2;
      } else chars.push(spec[i]);
    }
    return chars.flatMap((c) => expandCharClasses(token.replace(cls[0], c), (depth || 0) + 1));
  }

  for (const [mark, alphabet] of [['#', DIGITS], ['*', DIGITS], ['?', ALNUM]]) {
    const at = token.indexOf(mark);
    if (at >= 0) {
      return alphabet.flatMap((ch) =>
        expandCharClasses(token.slice(0, at) + ch + token.slice(at + 1), (depth || 0) + 1));
    }
  }
  return [token];
}

// Pulls candidate ids out of arbitrary pasted text — e.g. a vehicle list copied
// from the SYNAOS Fleet Management page. Anything that is not a real resource
// simply fails validation, so stray words cost a lookup but never a false entry.
const PASTE_NOISE = new Set([
  'total', 'select', 'vehicles', 'vehicle', 'in', 'fleet', 'order', 'mode', 'manual',
  'automatic', 'filters', 'search', 'by', 'id', 'communication', 'interface', 'type',
  'diffdrive', 'add', 'automated', 'management', 'dashboard', 'shop', 'floor'
]);

function extractIdsFromText(text) {
  const tokens = String(text || '').split(/[\s,;|\t\r\n]+/).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const raw of tokens) {
    const token = raw.trim().replace(/^[("'\[]+|[)"'\].,:]+$/g, '');
    if (!token || token.length < 2 || token.length > 64) continue;
    if (PASTE_NOISE.has(token.toLowerCase())) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(token)) continue;   // id-shaped only
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= SCAN_LIMIT) return { ids: out, truncated: true };
  }
  return { ids: out, truncated: false };
}

// Best-effort guess from the name alone. SYNAOS exposes no simulated flag over
// Basic auth, so this is a hint the operator can override, never a fact.
function guessSimulated(id) {
  return /(^sim|[-_. ]sim|sim[-_.\d])/i.test(String(id || ''));
}

function expandScanInput(input) {
  const tokens = String(input || '').split(/[\s,;\n]+/).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    for (const id of expandScanPattern(token)) {
      if (!seen.has(id)) { seen.add(id); out.push(id); }
      if (out.length >= SCAN_LIMIT) return { ids: out, truncated: true };
    }
  }
  return { ids: out, truncated: false };
}

// Correlation id marking the trailing "go to the waiting spot" milestone, so the
// customer-facing progress screen can tell parking apart from the actual delivery.
const WAITING_SPOT_TAG = 'waitingSpot';

// A resource id is only usable if it is a real, concrete id — never a UI sentinel
// such as "" (auto) or "__capable__" (app picks a capable robot).
function usableResourceId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.startsWith('__')) return null;
  return id;
}

// A SYNAOS job is executed by exactly one transport resource ("All milestones will
// be executed by the same transport resource"), so a route that uses several robots
// must be split into one job per robot. Consecutive legs are chained with a milestone
// dependency, so a leg cannot start approaching until the previous leg has FINISHED.
//
// legs: [{ resourceId, steps: [{ stationRef, action }] }]
// extra: correlations that mark what this job is — a recall carries its own id
// so any device can tell whose work a job in the fleet is.
function buildRelayPayloads(legs, stations, orderId, unitId, quantity, extra) {
  const correlations = [
    { kind: 'order', id: orderId },
    { kind: 'orderUnit', id: unitId },
    ...(Array.isArray(extra) ? extra.filter((c) => c && c.kind && c.id) : [])
  ];
  // One job now carries a whole cart line, so record how many it is carrying
  if (Number(quantity) > 0) correlations.push({ kind: 'quantity', id: String(Number(quantity)) });
  const jobs = [];
  let previousMilestoneId = null;

  legs.forEach((leg, legIndex) => {
    const milestones = leg.steps.map((step, stepIndex) => {
      const st = stations.find((s) => s.id === step.stationRef);
      const milestone = {
        id: crypto.randomUUID(),
        action: step.action,
        address: { system: (st && st.system) || 'STATION', id: st ? st.stationId : step.stationRef },
        correlations
      };
      // Hand-off: the first milestone of a follow-on leg waits for the previous leg
      if (stepIndex === 0 && previousMilestoneId) {
        milestone.dependencies = [{
          predecessorId: previousMilestoneId,
          requiredPredecessorStatus: 'FINISHED',
          blockedQualification: 'APPROACHING_ALLOWED'
        }];
      }
      return milestone;
    });
    // The next leg waits for this leg's last *delivery* milestone — not for the
    // robot to finish parking afterwards.
    previousMilestoneId = milestones[milestones.length - 1].id;

    // Waiting spot: once this robot's work is done, send it to its home node.
    // Marked with a correlation so the order-progress screen can ignore it.
    const park = leg.parkNode;
    if (park && park.id) {
      milestones.push({
        id: crypto.randomUUID(),
        action: 'MOVE',
        address: { system: park.system || 'STATION', id: park.id },
        correlations: [...correlations, { kind: 'gradionStep', id: WAITING_SPOT_TAG }]
      });
    }

    const job = {
      id: crypto.randomUUID(),
      milestones,
      executeMilestonesInProvidedSequence: true,
      correlations: [{ kind: 'SCHEDULER', id: 'SYNAOS-JOBS' }, ...correlations],
      scheduling: { scheduler: 'SYNAOS-JOBS' }
    };
    // Pin this leg to its robot. The renderer resolves which robot may serve each
    // station; anything else (auto, sentinels, blanks) is left to the SYNAOS scheduler.
    const pinned = usableResourceId(leg.resourceId);
    if (pinned) job.assignedResourceId = pinned;

    // armBefore describes a hand-over the operator placed in the route that has
    // to happen before this leg may start. Absent = no arm involvement.
    jobs.push({ payload: job, legIndex, totalLegs: legs.length, armBefore: leg.armBefore || null });
  });

  return jobs;
}

// ---------------------------------------------------------------------------
// Setup sync
//
// The shop's setup — products, stations, robots, nodes, recalls, connection
// details — is kept in one file in a GitHub repository, so installing the app
// on another machine is a download rather than an evening of retyping.
//
// The repository is public, so passwords are NEVER written in the clear. With
// no passphrase they are left out of the file entirely; with one they are
// encrypted (AES-256-GCM, key derived with scrypt) and can only be read back by
// someone who knows it. The GitHub token and the passphrase itself stay on the
// machine and are never part of what is published.
// ---------------------------------------------------------------------------

const SYNC_KIND = 'gradion-shop-setup';
const SYNC_MAX_BYTES = 8 * 1024 * 1024;   // GitHub's contents API is unhappy well before this
// Setups are data, not code, so they live on their own branch rather than
// landing in the middle of the release history on main.
const SYNC_BRANCH = 'setups';

function githubRequest(method, apiPath, token, body) {
  return new Promise((resolve) => {
    const https = require('https');
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: apiPath,
      method,
      timeout: 30000,
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects requests that do not identify themselves
        'User-Agent': 'GradionShop',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (token) options.headers.Authorization = `Bearer ${token}`;
    if (payload) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(options, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch (e) { /* not JSON */ }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data: json,
          error: (json && json.message) || null
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'GitHub timed out' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function encryptSecrets(secrets, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return {
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64')
  };
}

// Throws when the passphrase is wrong — GCM's tag check is what tells us.
function decryptSecrets(blob, passphrase) {
  const salt = Buffer.from(blob.salt, 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

// Everything worth carrying to another machine, and nothing that belongs to
// this one: no orders, no logs, no counters, no in-flight recall bookkeeping,
// and above all no tokens or passwords unless they can be encrypted.
function buildSyncPayload(store, passphrase) {
  const s = store.settings || {};
  const arm = Object.assign({}, s.arm); delete arm.password;
  const mpdv = Object.assign({}, s.mpdv); delete mpdv.password;
  return {
    kind: SYNC_KIND,
    formatVersion: 1,
    appVersion: app.getVersion(),
    savedAt: new Date().toISOString(),
    settings: {
      apiBaseUrl: s.apiBaseUrl,
      apiUsername: s.apiUsername,
      arm,
      mpdv
    },
    stations: store.stations || [],
    robots: store.robots || [],
    nodes: store.nodes || [],
    capability: store.capability || {},
    products: store.products || [],
    // The route and its automation travel; the countdown and the run it is
    // watching belong to the machine that was running it.
    recalls: (store.recalls || []).map((r) => {
      const copy = Object.assign({}, r);
      delete copy.autoState;
      return copy;
    }),
    secrets: passphrase ? encryptSecrets({
      apiPassword: s.apiPassword || '',
      armPassword: (s.arm || {}).password || '',
      mpdvPassword: (s.mpdv || {}).password || '',
      adminPassword: s.adminPassword || ''
    }, passphrase) : null
  };
}

// Setups are addressed by a name the operator picks — "setup1", "line-2",
// "showroom" — and that name is all the other machine needs to type. The file it
// maps to is an implementation detail nobody has to think about.
const SYNC_DIR = 'setups';

function syncSlug(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 40);
}

// Where the repository keeps its code, so a setup published before the data
// branch existed can still be found.
async function githubDefaultBranch(repo, token) {
  const res = await githubRequest('GET', `/repos/${repo}`, token);
  return res.ok && res.data ? res.data.default_branch || 'main' : 'main';
}

async function githubBranchExists(repo, branch, token) {
  const res = await githubRequest('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (res.ok) return { ok: true, exists: true };
  if (res.status === 404) return { ok: true, exists: false };
  return { ok: false, error: res.error || `GitHub answered ${res.status}` };
}

// Starts the data branch with no parent commit, so it carries the setups and
// nothing else — no copy of the code, no shared history with main. The file
// being published is its first commit.
async function githubCreateOrphanBranch(repo, branch, token, filePath, contentB64, message) {
  const blob = await githubRequest('POST', `/repos/${repo}/git/blobs`, token, { content: contentB64, encoding: 'base64' });
  if (!blob.ok) return { ok: false, error: blob.error || `GitHub answered ${blob.status}` };

  const tree = await githubRequest('POST', `/repos/${repo}/git/trees`, token, {
    tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.data.sha }]
  });
  if (!tree.ok) return { ok: false, error: tree.error || `GitHub answered ${tree.status}` };

  const commit = await githubRequest('POST', `/repos/${repo}/git/commits`, token, {
    message, tree: tree.data.sha, parents: []
  });
  if (!commit.ok) return { ok: false, error: commit.error || `GitHub answered ${commit.status}` };

  const ref = await githubRequest('POST', `/repos/${repo}/git/refs`, token, {
    ref: `refs/heads/${branch}`, sha: commit.data.sha
  });
  if (!ref.ok) return { ok: false, error: ref.error || `GitHub answered ${ref.status}` };
  return { ok: true, created: true };
}

function syncPaths(opts) {
  const repo = String((opts && opts.repo) || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
  const branch = String((opts && opts.branch) || 'main').trim() || 'main';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { error: 'Repository should look like owner/name.' };

  // An explicit path still wins, so a file published by an older version stays reachable
  const explicit = String((opts && opts.path) || '').trim().replace(/^\//, '');
  const slug = syncSlug((opts && opts.name) || '');
  if (!explicit && !slug) return { error: 'Give the setup a name, for example setup1.' };
  const path = explicit || `${SYNC_DIR}/${slug}.json`;

  return {
    repo, path, branch, slug,
    contents: `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    dir: `/repos/${repo}/contents/${SYNC_DIR}`
  };
}

// ---------------------------------------------------------------------------
// Relay supervisor
//
// Watches each pending hand-over: as soon as the outgoing AGV's DROP is
// FINISHED it asks the arm to move the load and, once the arm confirms, creates
// the receiving AGV's job. Runs in the main process so it keeps going even if
// the customer navigates away from the progress screen.
// ---------------------------------------------------------------------------

let relayTimer = null;
let relayRunning = false;

function notifyRelayChanged() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('relay:changed');
  });
}

function scheduleRelaySupervisor() {
  if (relayTimer) return;
  relayTimer = setInterval(runRelaySupervisor, 4000);
  runRelaySupervisor();
}

function milestoneIsFinished(m) {
  return (m.eventHistory || []).some((e) => e.name === 'MILESTONE_FINISHED');
}

async function runRelaySupervisor() {
  if (relayRunning) return;
  relayRunning = true;
  try {
    const store = loadStore();
    const pending = store.pendingRelays || [];
    if (!pending.length) {
      clearInterval(relayTimer);
      relayTimer = null;
      return;
    }
    let changed = false;

    for (const relay of [...pending]) {
      if (relay.state === 'arm-running') continue;   // a transfer is in flight

      const prev = relay.legs[relay.nextIndex - 1];
      const next = relay.legs[relay.nextIndex];
      if (!prev || !next) { relay.state = 'done'; changed = true; continue; }

      const dep = (next.milestones[0].dependencies || [])[0];
      const watchId = dep && dep.predecessorId;

      const jobRes = await apiRequest(store.settings, 'GET', `/api/v1/jobs/${prev.id}`);
      if (!jobRes.ok || !jobRes.data) continue;      // transient — try again next tick
      if (jobRes.data.status === 'FINISHED_FAILURE') {
        relay.state = 'failed';
        relay.lastError = 'The previous leg failed, so the hand-over was abandoned.';
        changed = true;
        continue;
      }
      const watch = (jobRes.data.milestones || []).find((m) => m.id === watchId);
      if (!watch || !milestoneIsFinished(watch)) continue;   // AGV has not dropped yet

      // The outgoing AGV has dropped. Run the hand-over if the operator put one
      // here, then create the receiving AGV's job.
      const arm = store.settings.arm || {};
      const handover = (relay.armPlan || [])[relay.nextIndex];
      let armResult = { ok: true, via: 'no-handover' };

      if (handover) {
        relay.state = 'arm-running';
        relay.lastError = null;
        saveStore(store);
        notifyRelayChanged();

        try {
          armResult = await runArmTransfer(arm, {
            taskId: nextArmTaskId(),
            method: handover.method || 'grasp',
            quantity: Number(handover.quantity) > 0 ? Number(handover.quantity) : 1,
            from: (watch.address && watch.address.id) || '',
            to: (next.milestones[0].address && next.milestones[0].address.id) || '',
            fromStation: (watch.address && watch.address.id) || '',
            toStation: (next.milestones[0].address && next.milestones[0].address.id) || '',
            orderId: relay.orderId,
            unitId: relay.unitId,
            transferId: `${relay.unitId}-${relay.nextIndex}`
          });
        } catch (err) {
          // Could not reach the broker — leave it queued and retry on the next tick
          const s = loadStore();
          const r = (s.pendingRelays || []).find((x) => x.id === relay.id);
          if (r) { r.state = 'waiting-for-drop'; r.lastError = `Arm unreachable: ${err.message}`; saveStore(s); }
          notifyRelayChanged();
          continue;
        }
      }

      const fresh = loadStore();
      const current = (fresh.pendingRelays || []).find((x) => x.id === relay.id);
      if (!current) continue;

      const createRes = await apiRequest(fresh.settings, 'POST', '/api/v1/jobs', next);
      if (createRes.ok) {
        apiRequest(fresh.settings, 'POST', '/api/v1/operations', {
          id: crypto.randomUUID(),
          name: `${current.productName} (leg ${current.nextIndex + 1}/${current.legs.length})`,
          filter: { id: next.id, kind: 'jobId' },
          type: 'Job',
          icon: 'JOB'
        });
        current.nextIndex += 1;
        current.state = current.nextIndex >= current.legs.length ? 'done' : 'waiting-for-drop';
        current.lastError = armResult.via === 'timeout'
          ? 'The arm never reported completion; continued after the timeout.'
          : null;
      } else {
        current.state = 'failed';
        current.lastError = `Could not create the next leg: ${createRes.error || 'HTTP ' + createRes.status}`;
      }
      fresh.pendingRelays = (fresh.pendingRelays || []).filter((x) => x.state !== 'done');
      saveStore(fresh);
      notifyRelayChanged();
      changed = false;   // store already written
    }

    if (changed) {
      store.pendingRelays = pending.filter((r) => r.state !== 'done');
      saveStore(store);
      notifyRelayChanged();
    }
  } catch (err) {
    // Never let a supervisor error kill the interval
    armState.lastError = `relay supervisor: ${err.message}`;
  } finally {
    relayRunning = false;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('store:get', () => loadStore());
  ipcMain.handle('store:set', (_ev, data) => {
    // These belong to the main process: hand-over progress, the MPDV log and
    // its running order number are written here, not in the window. The
    // renderer saves the whole store from a copy it loaded at start-up, so
    // taking its version would put back a log that was just cleared, restore
    // entries recorded since, or rewind the running number onto an order id
    // MPDV has already been given.
    const current = loadStore();
    MAIN_OWNED_KEYS.forEach((key) => { data[key] = current[key]; });
    saveStore(data);
    return true;
  });

  ipcMain.handle('api:test', async (_ev, settings) => {
    const res = await apiRequest(settings, 'GET', '/api/v1/jobs?finishedLessThanSecondsAgo=10');
    return { ok: res.ok, status: res.status, error: res.error || null };
  });

  // Reads the real stations and transport resources (robots) that SYNAOS is using,
  // by scanning the job-manager's jobs (the only data reachable with Basic auth —
  // the layout/fleet services sit behind an OAuth2 gateway). Enriches robots via
  // the resource-mode endpoint to confirm they are live.
  ipcMain.handle('api:discoverFromSynaos', async (_ev, settingsOverride) => {
    const store = loadStore();
    const settings = settingsOverride || store.settings;
    const res = await apiRequest(settings, 'GET', '/api/v1/jobs?finishedLessThanSecondsAgo=999999999');
    if (!res.ok) {
      return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` };
    }
    const jobs = Array.isArray(res.data) ? res.data : [];
    const stationMap = new Map();   // id -> Set(systems)
    const robotSet = new Set();
    // Evidence of which robot can / cannot reach which station, mined from job history.
    // capability[stationKey] = { ok: [robotIds], no: [robotIds] }
    const capability = {};
    const noteCap = (stationKey, robot, kind) => {
      if (!capability[stationKey]) capability[stationKey] = { ok: [], no: [] };
      const bucket = capability[stationKey][kind];
      if (!bucket.includes(robot)) bucket.push(robot);
    };

    for (const job of jobs) {
      if (job.assignedResourceId) robotSet.add(job.assignedResourceId);
      for (const m of job.milestones || []) {
        const a = m.address;
        if (a && a.id != null) {
          if (!stationMap.has(a.id)) stationMap.set(a.id, new Set());
          stationMap.get(a.id).add(a.system || 'STATION');

          const rid = job.assignedResourceId;
          if (rid) {
            const key = `${a.id}@${a.system || 'STATION'}`;
            const events = (m.eventHistory || []).map((e) => e.name);
            // SYNAOS reports an unreachable address as an execution-stopped reason
            const unreachable = /UNABLE_TO_ACCESS_ADDRESS/i.test(m.executionStoppedReason || '');
            // A job/milestone closed by a human ("finished externally") proves nothing
            // about the robot's reach, so it must never count as positive evidence.
            const externally = m.finishedExternally === true || job.finishedExternally === true;
            if (unreachable) noteCap(key, rid, 'no');
            else if (events.includes('MILESTONE_FINISHED') && !externally) noteCap(key, rid, 'ok');
          }
        }
      }
    }
    const addresses = [...stationMap.entries()]
      .map(([id, sys]) => ({ id: String(id), system: sys.has('STATION') ? 'STATION' : [...sys][0] }))
      .sort((a, b) => (a.system === b.system ? a.id.localeCompare(b.id) : a.system.localeCompare(b.system)));
    // Anything not in the STATION system is a navigation-graph node
    const stations = addresses.filter((a) => a.system === 'STATION');
    const nodes = addresses.filter((a) => a.system !== 'STATION');

    // Enrich robots with their mode / supported job types (confirms they are real)
    const robots = [];
    for (const id of [...robotSet].sort()) {
      const rm = await apiRequest(settings, 'GET', `/api/v1/resources/${encodeURIComponent(id)}/resource-mode`);
      robots.push({
        id,
        mode: rm.ok && rm.data ? rm.data.resourceMode : null,
        supportedJobTypes: rm.ok && rm.data ? rm.data.supportedJobTypes : null,
        live: rm.ok
      });
    }
    return { ok: true, status: res.status, jobCount: jobs.length, stations, nodes, robots, capability };
  });

  // Creates the SYNAOS jobs for each ordered unit — one job per robot leg.
  // Legs are posted in order because a follow-on leg references the previous leg's
  // milestone id; if a leg fails, the unit's remaining legs are skipped so we never
  // leave a dangling dependency pointing at a milestone that was never created.
  ipcMain.handle('api:createOrderJobs', async (_ev, { orderId, units }) => {
    const store = loadStore();
    const results = [];
    for (const unit of units) {
      // A unit that carries its own legs and label needs no catalogue entry —
      // that is how an admin recall is dispatched down the same path.
      const product = store.products.find((p) => p.id === unit.productId)
        || (unit.name ? { name: unit.name, steps: [] } : null);
      if (!product) {
        results.push({ unitId: unit.unitId, ok: false, error: 'Unknown product' });
        continue;
      }
      const legs = Array.isArray(unit.legs) && unit.legs.length
        ? unit.legs
        : [{ resourceId: unit.resourceId, steps: product.steps }];

      const planned = buildRelayPayloads(legs, store.stations, orderId, unit.unitId, unit.quantity, unit.correlations);

      // Hand-overs are only performed where the operator put one in the route.
      // Everything up to the first hand-over goes out now; from that point on
      // the relay supervisor creates each leg after the arm reports done.
      const armCfg = (store.settings && store.settings.arm) || {};
      const armPlan = planned.map((p) => (armCfg.enabled ? p.armBefore : null) || null);
      const firstGate = armPlan.findIndex((a) => a);
      const splitAt = firstGate === -1 ? planned.length : firstGate;
      const dispatchNow = planned.slice(0, splitAt);
      const deferred = planned.slice(splitAt);

      let aborted = false;
      for (const { payload, legIndex, totalLegs } of dispatchNow) {
        if (aborted) {
          results.push({
            unitId: unit.unitId, legIndex, totalLegs, ok: false, jobId: payload.id,
            assignedResourceId: payload.assignedResourceId || null,
            error: 'Skipped — an earlier leg of this item could not be created'
          });
          continue;
        }
        const res = await apiRequest(store.settings, 'POST', '/api/v1/jobs', payload);
        if (res.ok) {
          // Best-effort: register an Operation so the job shows up in the SYNAOS frontend
          apiRequest(store.settings, 'POST', '/api/v1/operations', {
            id: crypto.randomUUID(),
            name: totalLegs > 1 ? `${product.name} (leg ${legIndex + 1}/${totalLegs})` : product.name,
            filter: { id: payload.id, kind: 'jobId' },
            type: 'Job',
            icon: 'JOB'
          });
        } else {
          aborted = true;
        }
        results.push({
          unitId: unit.unitId,
          legIndex,
          totalLegs,
          ok: res.ok,
          status: res.status,
          jobId: payload.id,
          assignedResourceId: payload.assignedResourceId || null,
          error: res.ok ? null : res.error || (res.raw ? String(res.raw).slice(0, 300) : `HTTP ${res.status}`)
        });
      }

      if (deferred.length && !aborted) {
        store.pendingRelays = store.pendingRelays || [];
        store.pendingRelays.push({
          id: crypto.randomUUID(),
          orderId,
          unitId: unit.unitId,
          productName: product.name,
          legs: planned.map((p) => p.payload),
          armPlan,
          nextIndex: splitAt,
          state: 'waiting-for-drop',
          lastError: null,
          createdAt: new Date().toISOString()
        });
        saveStore(store);
        deferred.forEach(({ payload, legIndex, totalLegs }) => {
          results.push({
            unitId: unit.unitId, legIndex, totalLegs, ok: true, deferred: true,
            jobId: payload.id, assignedResourceId: payload.assignedResourceId || null, error: null
          });
        });
      } else if (deferred.length && aborted) {
        deferred.forEach(({ payload, legIndex, totalLegs }) => {
          results.push({
            unitId: unit.unitId, legIndex, totalLegs, ok: false, jobId: payload.id,
            assignedResourceId: payload.assignedResourceId || null,
            error: 'Skipped — the first leg of this item could not be created'
          });
        });
      }
    }
    if (store.pendingRelays && store.pendingRelays.length) scheduleRelaySupervisor();
    return results;
  });

  // Creates one MPDV order per cart line, then an operation per arm against it.
  // Returns a result per line, each carrying every call it made, so the shop can
  // show exactly which step failed and in MPDV's own words.
  ipcMain.handle('mpdv:createOrders', async (_ev, { lines }) => {
    const cfg = loadStore().settings.mpdv || {};
    const results = [];
    let requestId = 1;

    // An operation that fails is tried again before the next one is sent — a
    // refusal is usually MPDV being busy rather than the payload being wrong.
    const send = async (payload, resource, label) => {
      let last = null;
      for (let attempt = 1; attempt <= MPDV_ATTEMPTS; attempt++) {
        const res = await mpdvRequest(cfg, payload, mpdvUrl(cfg, resource));
        const verdict = interpretMpdvResponse(res);
        last = {
          kind: resource === 'BOOrder' ? 'order' : 'operation',
          label,
          ok: verdict.ok,
          status: res.status,
          attempt,
          error: verdict.ok ? null : verdict.error,
          createdId: verdict.createdId || null,
          response: verdict.detail || '',
          request: JSON.stringify(payload)
        };
        if (verdict.ok) return last;
        if (attempt < MPDV_ATTEMPTS) await new Promise((r) => setTimeout(r, MPDV_RETRY_MS * attempt));
      }
      return last;
    };

    for (const line of lines || []) {
      const quantity = mpdvQuantity(line.quantity);
      let orderNumber;
      try {
        orderNumber = nextMpdvOrderNumber(cfg.timeZoneId);
      } catch (err) {
        const entry = {
          productName: line.name || '', orderNumber: null, quantity,
          ok: false, status: 0, error: err.message, response: '', calls: []
        };
        recordMpdvLog(entry);
        results.push(entry);
        continue;
      }

      // The order has to exist before an operation can reference its id
      const orderCall = await send(
        buildMpdvOrderPayload(cfg, orderNumber, line.orderType, quantity, requestId++),
        'BOOrder', 'Order');
      const calls = [orderCall];

      if (orderCall.ok) {
        for (const op of cfg.operations || []) {
          calls.push(await send(
            buildMpdvOperationPayload(cfg, orderNumber, op, quantity, requestId++),
            'BOOperation', op.label || op.workplace || 'Operation'));
        }
      }

      const failed = calls.find((c) => !c.ok);
      const entry = {
        productName: line.name || '',
        orderNumber,
        quantity,
        orderType: String(line.orderType == null ? '0' : line.orderType),
        ok: !failed,
        status: (failed || orderCall).status,
        error: failed ? `${failed.label}: ${failed.error}` : null,
        // The id MPDV stored — may differ from ours, since it truncates to 8 chars
        createdId: orderCall.createdId || null,
        // Kept verbatim so nothing MPDV said is hidden, successful or not
        response: (failed || orderCall).response || '',
        request: orderCall.request,
        calls
      };
      recordMpdvLog(entry);
      results.push(entry);
    }
    return results;
  });

  // Sends nothing; just reports what the next number would look like.
  ipcMain.handle('mpdv:preview', (_ev, cfgOverride) => {
    const store = loadStore();
    const cfg = Object.assign({}, store.settings.mpdv, cfgOverride || {});
    const key = mpdvDateKey(cfg.timeZoneId);
    const counter = store.mpdvCounter || { date: '', seq: 0 };
    const nextSeq = (counter.date === key ? Number(counter.seq) || 0 : 0) + 1;
    const orderNumber = formatMpdvOrderNumber(key, nextSeq);
    return {
      orderNumber,
      todayKey: key,
      usedToday: counter.date === key ? counter.seq : 0,
      remainingToday: Math.max(0, MPDV_MAX_ORDERS_PER_DAY - (counter.date === key ? Number(counter.seq) || 0 : 0)),
      orderUrl: mpdvUrl(cfg, 'BOOrder'),
      operationUrl: mpdvUrl(cfg, 'BOOperation'),
      payload: buildMpdvOrderPayload(cfg, orderNumber, '0', 1, 1),
      operationPayloads: (cfg.operations || []).map((op, i) => ({
        label: op.label || op.workplace,
        payload: buildMpdvOperationPayload(cfg, orderNumber, op, 1, 7 + i)
      }))
    };
  });

  ipcMain.handle('mpdv:log', () => (loadStore().mpdvLog || []).slice(0, 20));

  ipcMain.handle('mpdv:clearLog', () => {
    const store = loadStore();
    store.mpdvLog = [];
    saveStore(store);
    return true;
  });

  // Connects to the arm's broker and reports what happened, so the operator can
  // check the settings without placing an order.
  ipcMain.handle('arm:test', async (_ev, armOverride) => {
    const store = loadStore();
    const arm = Object.assign({}, store.settings.arm, armOverride || {});
    try {
      await connectArm(arm);
      return { ok: true, connected: true, subscribed: arm.statusTopic || null };
    } catch (err) {
      return { ok: false, connected: false, error: err.message };
    }
  });

  // Publishes a hand-over command by hand, to check the arm reacts as expected.
  ipcMain.handle('arm:testPublish', async (_ev, armOverride) => {
    const store = loadStore();
    const arm = Object.assign({}, store.settings.arm, armOverride || {});
    try {
      const res = await runArmTransfer(arm, {
        taskId: nextArmTaskId(), method: 'grasp', quantity: 1,
        from: 'K1', to: 'T2', fromStation: 'K1', toStation: 'T2',
        orderId: 'test-order', unitId: 'test-unit', transferId: 'test-transfer'
      });
      return { ok: true, via: res.via };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('arm:status', () => ({
    connected: armState.connected,
    lastError: armState.lastError,
    log: armState.log.slice(0, 12),
    pending: (loadStore().pendingRelays || []).map((r) => ({
      unitId: r.unitId, productName: r.productName, state: r.state,
      leg: r.nextIndex + 1, totalLegs: r.legs.length, lastError: r.lastError
    }))
  }));

  // Checks a batch of candidate ids against SYNAOS and reports which are real,
  // so an AGV that has never run a job can still be found. Progress is streamed
  // back because a wide range takes a while.
  ipcMain.handle('api:scanResources', async (ev, patterns, mode) => {
    const store = loadStore();
    // "paste" takes ids out of copied text; "pattern" expands ranges/wildcards
    const { ids, truncated } = mode === 'paste'
      ? extractIdsFromText(patterns)
      : expandScanInput(patterns);
    if (!ids.length) {
      return { ok: false, error: mode === 'paste'
        ? 'No ids found in that text.'
        : 'Nothing to scan — enter an id, range or pattern.' };
    }

    const found = [];
    const CONCURRENCY = 5;
    let checked = 0;

    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const answers = await Promise.all(batch.map(async (id) => {
        const rm = await apiRequest(store.settings, 'GET', `/api/v1/resources/${encodeURIComponent(id)}/resource-mode`);
        return { id, rm };
      }));
      answers.forEach(({ id, rm }) => {
        if (rm.ok && rm.data) {
          found.push({
            id,
            mode: rm.data.resourceMode || null,
            supportedJobTypes: rm.data.supportedJobTypes || null,
            live: true,
            simulated: guessSimulated(id)
          });
        }
      });
      checked += batch.length;
      if (!ev.sender.isDestroyed()) {
        ev.sender.send('scan:progress', { checked, total: ids.length, found: found.length });
      }
    }
    return { ok: true, tried: ids.length, truncated, limit: SCAN_LIMIT, found };
  });

  // Confirms a transport resource really exists in SYNAOS.
  // The resource-mode endpoint answers 200 for a real robot and 404 otherwise,
  // which is the only fleet lookup reachable with Basic auth. Ids are case-sensitive.
  ipcMain.handle('api:validateResource', async (_ev, resourceId) => {
    const store = loadStore();
    const id = String(resourceId || '').trim();
    if (!id) return { ok: false, exists: false, error: 'Enter a robot id.' };
    const rm = await apiRequest(store.settings, 'GET', `/api/v1/resources/${encodeURIComponent(id)}/resource-mode`);
    if (rm.status === 404) return { ok: true, exists: false, id };
    if (!rm.ok) return { ok: false, exists: false, id, error: rm.error || `HTTP ${rm.status}` };
    return {
      ok: true,
      exists: true,
      id,
      mode: rm.data ? rm.data.resourceMode : null,
      supportedJobTypes: rm.data ? rm.data.supportedJobTypes : null
    };
  });

  // Every job the tenant currently has — unfinished ones are always included,
  // whichever machine created them. This is how devices see each other: SYNAOS
  // knows what the AGVs are doing, and no app instance has to be told.
  ipcMain.handle('api:listJobs', async (_ev, sinceSeconds) => {
    const store = loadStore();
    const window = Number(sinceSeconds) > 0 ? Math.round(Number(sinceSeconds)) : 7200;
    const res = await apiRequest(store.settings, 'GET', `/api/v1/jobs?finishedLessThanSecondsAgo=${window}`);
    if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}` };
    return { ok: true, jobs: Array.isArray(res.data) ? res.data : [] };
  });

  ipcMain.handle('api:getJob', async (_ev, jobId) => {
    const store = loadStore();
    return apiRequest(store.settings, 'GET', `/api/v1/jobs/${jobId}`);
  });

  ipcMain.handle('api:discardJob', async (_ev, jobId) => {
    const store = loadStore();
    return apiRequest(store.settings, 'PUT', `/api/v1/jobs/${jobId}/discard-request`, {
      id: jobId,
      reason: 'Cancelled from Gradion Shop app'
    });
  });

  // Publishes this machine's setup to the repository. Needs a token with write
  // access to it; the token never leaves this machine other than as the
  // Authorization header on this request.
  ipcMain.handle('sync:publish', async (_ev, opts) => {
    const store = loadStore();
    const cfg = Object.assign({}, store.settings.sync, opts || {});
    const where = syncPaths(cfg);
    if (where.error) return { ok: false, error: where.error };
    if (!cfg.token) return { ok: false, needsToken: true, error: 'Publishing needs a GitHub token with write access — loading on the other machine does not.' };

    const payload = buildSyncPayload(store, cfg.passphrase || '');
    const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    if (body.length > SYNC_MAX_BYTES) {
      return { ok: false, error: `The setup is ${(body.length / 1048576).toFixed(1)} MB — too large to publish. Product and station images are usually the cause.` };
    }

    const message = `Gradion Shop setup — ${new Date().toISOString()}`;
    const at = new Date().toISOString();
    const remember = () => {
      store.settings.sync = Object.assign({}, store.settings.sync, cfg, { lastPublishedAt: at, branchMoved: true });
      saveStore(store);
    };

    // The data branch may not exist yet — the first publish is what starts it
    const branch = await githubBranchExists(where.repo, where.branch, cfg.token);
    if (!branch.ok) return { ok: false, error: branch.error };
    if (!branch.exists) {
      const made = await githubCreateOrphanBranch(
        where.repo, where.branch, cfg.token, where.path, body.toString('base64'), message);
      if (!made.ok) return { ok: false, error: `Could not start the ${where.branch} branch — ${made.error}` };
      remember();
      return {
        ok: true, at, bytes: body.length, secretsIncluded: !!payload.secrets, branchCreated: where.branch,
        url: `https://github.com/${where.repo}/blob/${where.branch}/${where.path}`
      };
    }

    // An update has to name the blob it replaces, so look for one first
    const head = await githubRequest('GET', `${where.contents}?ref=${encodeURIComponent(where.branch)}`, cfg.token);
    const sha = head.ok && head.data ? head.data.sha : undefined;
    if (!head.ok && head.status !== 404) {
      return { ok: false, error: head.error || `GitHub answered ${head.status}` };
    }

    const res = await githubRequest('PUT', where.contents, cfg.token, {
      message,
      content: body.toString('base64'),
      branch: where.branch,
      sha
    });
    if (!res.ok) return { ok: false, status: res.status, error: res.error || `GitHub answered ${res.status}` };

    remember();
    return {
      ok: true,
      at,
      bytes: body.length,
      secretsIncluded: !!payload.secrets,
      url: (res.data && res.data.content && res.data.content.html_url) || null
    };
  });

  // What has been published, so the other machine can pick a setup from a list
  // rather than having to spell its name exactly. Needs no token on a public repo.
  ipcMain.handle('sync:list', async (_ev, opts) => {
    const store = loadStore();
    const cfg = Object.assign({}, store.settings.sync, opts || {});
    const where = syncPaths(Object.assign({}, cfg, { name: cfg.name || 'x' }));
    if (where.error) return { ok: false, error: where.error };
    const read = async (branch) =>
      githubRequest('GET', `${where.dir}?ref=${encodeURIComponent(branch)}`, cfg.token || null);

    let branch = where.branch;
    let res = await read(branch);
    // Setups published before they had their own branch are still on the code
    // branch, so look there too rather than reporting an empty shop.
    if (res.status === 404) {
      const fallback = await githubDefaultBranch(where.repo, cfg.token || null);
      if (fallback !== branch) {
        const alt = await read(fallback);
        if (alt.ok) { res = alt; branch = fallback; }
      }
    }
    if (res.status === 404) return { ok: true, setups: [], branch };   // nothing published yet
    if (!res.ok) return { ok: false, status: res.status, error: res.error || `GitHub answered ${res.status}` };
    const setups = (Array.isArray(res.data) ? res.data : [])
      .filter((f) => f.type === 'file' && /\.json$/i.test(f.name))
      .map((f) => ({ name: f.name.replace(/\.json$/i, ''), size: f.size }));
    return { ok: true, setups, branch };
  });

  // Reads the published setup. A public repository needs no token; a private
  // one uses the same token as publishing.
  ipcMain.handle('sync:fetch', async (_ev, opts) => {
    const store = loadStore();
    const cfg = Object.assign({}, store.settings.sync, opts || {});
    const where = syncPaths(cfg);
    if (where.error) return { ok: false, error: where.error };

    const read = async (branch) =>
      githubRequest('GET', `${where.contents}?ref=${encodeURIComponent(branch)}`, cfg.token || null);

    let branch = where.branch;
    let res = await read(branch);
    // Fall back to the code branch for setups published before the data branch
    if (res.status === 404) {
      const fallback = await githubDefaultBranch(where.repo, cfg.token || null);
      if (fallback !== branch) {
        const alt = await read(fallback);
        if (alt.ok) { res = alt; branch = fallback; }
      }
    }
    if (res.status === 404) return { ok: false, error: `No setup called "${where.slug || where.path}" has been published to ${where.repo} yet.` };
    if (!res.ok) return { ok: false, status: res.status, error: res.error || `GitHub answered ${res.status}` };

    let config;
    try {
      config = JSON.parse(Buffer.from((res.data.content || '').replace(/\n/g, ''), 'base64').toString('utf8'));
    } catch (e) {
      return { ok: false, error: 'That file is not readable as a saved setup.' };
    }
    if (!config || config.kind !== SYNC_KIND) {
      return { ok: false, error: 'That file is not a Gradion Shop setup.' };
    }

    if (config.secrets) {
      if (!cfg.passphrase) return { ok: false, needsPassphrase: true, error: 'This setup carries encrypted passwords — enter the passphrase to read it.' };
      try {
        config.decryptedSecrets = decryptSecrets(config.secrets, cfg.passphrase);
      } catch (e) {
        return { ok: false, badPassphrase: true, error: 'That passphrase does not open this setup.' };
      }
    }
    delete config.secrets;

    const at = new Date().toISOString();
    store.settings.sync = Object.assign({}, store.settings.sync, cfg, { lastLoadedAt: at });
    saveStore(store);
    return { ok: true, config, at, savedAt: config.savedAt || null, branch };
  });

  // Opens GitHub's own "new token" page with the right boxes already ticked, so
  // making one is a click and a copy rather than a hunt through settings. Only
  // github.com is ever opened.
  ipcMain.handle('sync:openTokenPage', async () => {
    const url = 'https://github.com/settings/tokens/new?scopes=repo&description=Gradion%20Shop%20setup%20sync';
    await shell.openExternal(url);
    return { ok: true, url };
  });

  ipcMain.handle('dialog:pickImage', async (ev) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose product image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    });
    if (res.canceled || !res.filePaths.length) return null;
    const file = res.filePaths[0];
    const stat = fs.statSync(file);
    if (stat.size > 8 * 1024 * 1024) {
      return { error: 'Image is larger than 8 MB — please choose a smaller file.' };
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' }[ext] || 'png';
    const b64 = fs.readFileSync(file).toString('base64');
    return { dataUrl: `data:image/${mime};base64,${b64}` };
  });
}

// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
    }
  });

  app.whenReady().then(() => {
    storePath = path.join(app.getPath('userData'), 'treat-stand-store.json');
    registerIpc();
    createWindow();
    // Pick up hand-overs left in flight by a previous run
    if ((loadStore().pendingRelays || []).length) scheduleRelaySupervisor();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Exposed so the arm/relay logic can be exercised by tests against a real broker.
module.exports = {
  __setStorePathForTest: (p) => { storePath = p; },
  __loadStoreForTest: () => loadStore(),
  registerIpcForTest: () => registerIpc(),
  expandScanInput,
  expandScanPattern,
  extractIdsFromText,
  guessSimulated,
  mpdvDateKey,
  nextMpdvOrderNumber,
  mpdvUrl,
  buildMpdvOrderPayload,
  buildMpdvOperationPayload,
  mpdvRequest,
  interpretMpdvResponse,
  renderArmPayload,
  handleArmStatus,
  connectArm,
  runArmTransfer,
  buildRelayPayloads,
  usableResourceId,
  buildSyncPayload,
  encryptSecrets,
  decryptSecrets,
  syncPaths,
  armState
};
