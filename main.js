const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Persistent store (JSON file in the per-user app data folder)
// ---------------------------------------------------------------------------

let storePath;

// What an operation carries beyond its identity fields. These used to be built
// into the payload; they are rows now so a site whose MPDV uses other formulas
// or a different cycle target can change them without a new build.
function defaultMpdvOperationFields() {
  return [
    { acronym: 'operation.processing_time.formula', value: 'BEA_ZY' },
    { acronym: 'operation.processing_time.mode', value: 'FORMULA' },
    { acronym: 'operation.remaining_runtime.formula', value: 'RLFZ' },
    { acronym: 'operation.remaining_runtime.mode', value: 'FORMULA' },
    { acronym: 'operation.cycle.target', value: '60000' }
  ];
}

// Rows arrive from the admin form, so take nothing on trust: a row is an
// acronym and a value, both strings, and an unnamed row is not a field.
function cleanMpdvFields(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      acronym: String((row && row.acronym) || '').trim(),
      value: row && row.value != null ? String(row.value) : ''
    }))
    .filter((row) => row.acronym);
}

// The envelope around the params: which columns MPDV should return, the id it
// echoes back, and whether the answer comes as an object. Typed in the admin
// form, so nothing is taken on trust.
function cleanMpdvColumns(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  return list.map((c) => String(c).trim()).filter(Boolean);
}

function cleanMpdvRequestId(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// `saved` is what was on disk, not the defaults-merged copy: the defaults
// always carry an orderFields array, so asking the merged object whether it has
// one would answer yes for an install that predates the field entirely.
function normalizeMpdvFields(mpdv, saved) {
  if (!Array.isArray((saved || {}).orderFields)) {
    // Before v1.13 the deadline was the only order field, and it had its own
    // setting. Carry it across as the first row so it keeps being sent.
    const deadline = typeof mpdv.latestEndTs === 'string' ? mpdv.latestEndTs.trim() : '';
    mpdv.orderFields = deadline ? [{ acronym: 'order.latest_end_ts', value: deadline }] : [];
  }
  delete mpdv.latestEndTs;          // an ordinary row now
  mpdv.orderFields = cleanMpdvFields(mpdv.orderFields);
  mpdv.orderColumns = cleanMpdvColumns(mpdv.orderColumns);
  mpdv.orderRequestId = cleanMpdvRequestId(mpdv.orderRequestId, 1);
  mpdv.orderReturnAsObject = mpdv.orderReturnAsObject !== false;
  mpdv.orderRaw = cleanMpdvRaw(mpdv.orderRaw);
  (mpdv.operations || []).forEach((op) => {
    op.fields = cleanMpdvFields(Array.isArray(op.fields) ? op.fields : defaultMpdvOperationFields());
    op.columns = cleanMpdvColumns(op.columns);
    op.requestId = cleanMpdvRequestId(op.requestId, 7);
    op.returnAsObject = op.returnAsObject !== false;
    op.raw = cleanMpdvRaw(op.raw);
  });
}

// The operator's own JSON for one request. Kept verbatim — it is theirs, and
// reformatting what someone typed to send to a vendor helps nobody.
function cleanMpdvRaw(raw) {
  return {
    enabled: !!(raw && raw.enabled),
    body: raw && raw.body != null ? String(raw.body) : ''
  };
}

// The arms in the cell. They share one broker but each has its own topics, so a
// route step can name the arm it needs. `stateTopic` is the one that matters:
// the arm reports Finished there and nothing continues until it does.
function defaultArms() {
  const template = '{\n  "task_id": "{taskId}",\n  "method": "{method}",\n  "quantity": {quantity}\n}';
  return [
    {
      id: 'openmind',
      label: 'Openmind arm',
      commandTopic: 'Openmind/robot01/cmd',
      stateTopic: 'Openmind/robot01/state',
      statusTopic: 'Openmind/robot01/status',   // watched too, but only for the log
      // Placeholders: {taskId} {method} {quantity} {from} {to} {orderId}
      // {unitId} {transferId} {orderNumber} {productName}
      payloadTemplate: template,
      stateField: 'state',        // JSON field to read ('' = match the raw text)
      doneValue: 'Finished',      // the value that means this arm is done
      matchField: 'task_id'       // field tying a state message back to our command
    },
    {
      id: 'kuka',
      label: 'Kuka arm',
      commandTopic: 'kuka/robot01/cmd',
      stateTopic: 'kuka/robot01/state',
      statusTopic: '',
      payloadTemplate: template,
      stateField: 'state',
      doneValue: 'Finished',
      matchField: 'task_id'
    }
  ];
}

function defaultStore() {
  return {
    settings: {
      adminPassword: 'Ts13',
      theme: 'light',
      apiBaseUrl: 'https://ace.one.stg.synaos.cloud',
      apiUsername: 'ace',
      apiPassword: 'X#jzd.0sdc20b0q#MYa"',
      // The robotic arms that physically move a load at a hand-over station.
      // Credentials are entered by the operator and only ever stored locally.
      arm: {
        enabled: true,
        brokerUrl: 'mqtts://mqtt.ace.one.stg.synaos.cloud:8883',
        tlsInsecure: true,           // broker uses TLS but its certificate is not validated
        username: 'synaos',
        password: 'MpUWLrfoXlPBC4BXADgYjXtYO',
        clientId: '',
        arms: defaultArms(),
        timeoutSeconds: 120,         // give up waiting for an arm and continue anyway
        // In MPDV mode the app creates no AGV job, so it watches SYNAOS for the
        // AGV reaching the hand-over station, then commands the arm and waits
        // for it exactly as a SYNAOS hand-over does.
        mpdvWait: {
          enabled: true,
          arrivalTimeoutSeconds: 1800,   // how long to watch for the AGV
          armTimeoutSeconds: 600         // how long to wait for the arm afterwards
        }
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
        language: 'en',
        timeZoneId: 'Asia/Singapore',
        // What goes on the order besides the three the app fills in itself
        // (id, ordertype, planned yield). Free acronym/value rows, so a field
        // MPDV accepts can be added without a new release.
        orderFields: [
          { acronym: 'order.latest_end_ts', value: '2026-08-05T00:00:00.000+08:00' }
        ],
        // The envelope around those params: which columns to ask back, the id
        // MPDV echoes, and whether the answer comes as an object.
        orderColumns: [],
        orderRequestId: 1,
        orderReturnAsObject: true,
        // One operation per arm, sent for every order. The identity fields are
        // editable, and `fields` carries everything else the operation needs —
        // the formulas, their modes and the cycle target — as editable rows.
        // The two must not share an operation number: MPDV rejects the second
        // as a duplicate on the same order ("Data are already available", 1669).
        operations: [
          { label: 'Openmind arm', operation: '0010', workplace: 'ROBOT01', article: 'BRACES', designation: 'BRACES', unit: 'PCS', fields: defaultMpdvOperationFields(), columns: [], requestId: 7, returnAsObject: true },
          { label: 'Kuka arm', operation: '0020', workplace: 'ROBOT02', article: 'PEN', designation: 'PEN', unit: 'PCS', fields: defaultMpdvOperationFields(), columns: [], requestId: 7, returnAsObject: true }
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
    pendingMpdvRuns: [],
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
const ARM_CONFIG_VERSION = 3;

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
    if (arm[key] !== SUPERSEDED_ARM_VALUES[key] || arm[key] === defaultArm[key]) return;
    // The topics and the template have moved into the arms list, so a stale one
    // is dropped here and migrateArmsList fills it from the shipped default.
    if (defaultArm[key] === undefined) delete arm[key];
    else arm[key] = defaultArm[key];
    changed = true;
  });
  if (arm.tlsInsecure === undefined) { arm.tlsInsecure = defaultArm.tlsInsecure; changed = true; }
  if (migrateArmsList(arm)) changed = true;
  data.armConfigVersion = ARM_CONFIG_VERSION;
  return changed;
}

// v1.14 gave every arm its own topics. An install from before that has one arm's
// fields sitting at the top level: keep them as the first arm — a topic the
// operator typed is not something to overwrite — and add the second arm beside
// it. The state topic is new, so an arm that has none gets the shipped default.
function migrateArmsList(arm) {
  if (Array.isArray(arm.arms) && arm.arms.length) return false;
  const shipped = defaultArms();
  const first = Object.assign({}, shipped[0], {
    commandTopic: arm.commandTopic || shipped[0].commandTopic,
    statusTopic: arm.statusTopic !== undefined ? arm.statusTopic : shipped[0].statusTopic,
    payloadTemplate: arm.payloadTemplate || shipped[0].payloadTemplate,
    // The old status field/value/match named the same three things
    stateField: arm.statusField === 'status' ? shipped[0].stateField : (arm.statusField || shipped[0].stateField),
    doneValue: arm.statusDoneValue || shipped[0].doneValue,
    matchField: arm.statusMatchField || shipped[0].matchField
  });
  arm.arms = [first, shipped[1]];
  // The flat fields have moved into arms[0]; leaving copies behind would let a
  // stale one be edited in a form that no longer exists.
  ['commandTopic', 'statusTopic', 'payloadTemplate', 'statusField', 'statusDoneValue', 'statusMatchField']
    .forEach((key) => delete arm[key]);
  return true;
}

// Arms arrive from the admin form and from synced setups, so nothing is taken on
// trust: an arm needs an id and at least one topic to be worth keeping.
function normalizeArms(arm) {
  const shipped = defaultArms();
  const seen = new Set();
  const list = (Array.isArray(arm.arms) ? arm.arms : [])
    .map((raw, i) => {
      const base = shipped[i] || shipped[0];
      const id = String((raw && raw.id) || '').trim() || `arm${i + 1}`;
      return {
        id,
        label: String((raw && raw.label) || '').trim() || base.label,
        commandTopic: String((raw && raw.commandTopic) || '').trim(),
        stateTopic: String((raw && raw.stateTopic) || '').trim(),
        statusTopic: String((raw && raw.statusTopic) || '').trim(),
        payloadTemplate: raw && raw.payloadTemplate != null ? String(raw.payloadTemplate) : base.payloadTemplate,
        stateField: raw && raw.stateField != null ? String(raw.stateField).trim() : base.stateField,
        doneValue: String((raw && raw.doneValue) || '').trim() || base.doneValue,
        matchField: raw && raw.matchField != null ? String(raw.matchField).trim() : base.matchField
      };
    })
    .filter((a) => {
      if (seen.has(a.id)) return false;    // two arms sharing an id cannot be told apart
      seen.add(a.id);
      return a.commandTopic || a.stateTopic || a.statusTopic;
    });
  arm.arms = list.length ? list : shipped;
  arm.mpdvWait = Object.assign({ enabled: true, arrivalTimeoutSeconds: 1800, armTimeoutSeconds: 600 }, arm.mpdvWait || {});
}

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const data = JSON.parse(raw);
    // Merge with defaults so new fields appear after app updates. Assign into a
    // fresh object so the defaults themselves stay pristine for the migration.
    const def = defaultStore();
    const defaultArm = Object.assign({}, def.settings.arm);
    const savedArm = (data.settings && data.settings.arm) || {};
    const arm = Object.assign({}, defaultArm, savedArm);
    // An install from before the arms became a list must migrate its own topics
    // into one, so the shipped list must not be merged in over the top of it.
    if (!Array.isArray(savedArm.arms)) delete arm.arms;
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
    // Both arms shipped with 0010, and MPDV refuses the second operation on an
    // order when the number is already taken — return code 1669, "Data are
    // already available". Give the second one its own number, once, so a
    // deliberate choice made afterwards is left alone.
    if (!mpdv.operationNumbersSeparated) {
      if (mpdv.operations.length > 1 && mpdv.operations[1].operation === mpdv.operations[0].operation) {
        mpdv.operations[1].operation = '0020';
      }
      mpdv.operationNumbersSeparated = true;
    }
    // v1.13 turned everything that is not filled in by the app itself into
    // editable rows. The one order field an install already had was the
    // deadline, so it becomes the first row rather than being lost.
    normalizeMpdvFields(mpdv, (data.settings && data.settings.mpdv) || {});
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
    const armMigrated = migrateArmConfig(data, defaultArm);
    normalizeArms(arm);
    if (armMigrated && storePath) {
      try { saveStore(data); } catch (e) { /* read-only run; migration still applies in memory */ }
    }
    data.pendingRelays = data.pendingRelays || [];
    // Finished runs are kept for a day so the tracking screen can still show one
    // that has just completed; the order itself keeps its own copy of the
    // stages, so pruning here loses nothing from the history.
    data.pendingMpdvRuns = (data.pendingMpdvRuns || []).filter((r) => {
      if (!r || (r.state !== 'done' && r.state !== 'failed')) return true;
      const at = Date.parse(r.finishedAt || r.createdAt || '') || 0;
      return Date.now() - at < 24 * 60 * 60 * 1000;
    });
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
const MAIN_OWNED_KEYS = ['pendingRelays', 'pendingMpdvRuns', 'mpdvLog', 'mpdvCounter'];

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
// Robotic arms over MQTT
//
// A load that changes AGV mid-route is moved by a robotic arm: the app publishes
// a command on that arm's topic and the arm reports back on its state topic.
// Nothing continues until the state says Finished — in SYNAOS mode the receiving
// AGV's job is not created before then, and in MPDV mode the order does not move
// on to its next stage.
//
// There are several arms on one broker (Openmind, Kuka), each with its own
// topics, so every route step and every wait names the arm it belongs to.
// ---------------------------------------------------------------------------

const mqtt = require('mqtt');

const armState = {
  client: null,
  url: null,
  connected: false,
  lastError: null,
  waiters: new Set(),   // { topic, taskId, tag, done }
  // The last Finished seen on a topic that nobody was waiting for yet. It closes
  // the gap between subscribing and waiting: an arm that answers while the order
  // is still being written down is not missed.
  lastDone: new Map(),  // topic -> { at, taskId }
  log: []               // recent traffic, surfaced in the admin panel
};

function armLog(direction, topic, message) {
  armState.log.unshift({ at: new Date().toISOString(), direction, topic, message: String(message).slice(0, 300) });
  armState.log.length = Math.min(armState.log.length, 40);
}

// Every arm the settings describe. Kept as a function rather than read directly
// so a setup that arrives with none still leaves the app with something usable.
function armDefs(arm) {
  const list = Array.isArray(arm && arm.arms) ? arm.arms : [];
  return list.filter((a) => a && (a.stateTopic || a.commandTopic || a.statusTopic));
}

// The arm a route step or a wait names. An unnamed one is the first, which is
// what a single-arm setup has always meant.
function findArmDef(arm, armId) {
  const defs = armDefs(arm);
  if (!defs.length) return null;
  const id = String(armId || '').trim();
  return defs.find((d) => d.id === id) || defs[0];
}

// Everything worth listening to: the state topics that gate the work, and the
// status topics, which are only shown in the traffic log.
function armTopics(arm) {
  const out = [];
  armDefs(arm).forEach((d) => {
    [d.stateTopic, d.statusTopic].forEach((raw) => {
      const topic = String(raw || '').trim();
      if (topic && !out.includes(topic)) out.push(topic);
    });
  });
  return out;
}

function armConfigKey(arm) {
  return [arm.brokerUrl, arm.username, arm.password, arm.clientId, arm.tlsInsecure, armTopics(arm).join(',')].join('|');
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
      const topics = armTopics(arm);
      if (topics.length) {
        client.subscribe(topics, (err) => {
          if (err) armState.lastError = `subscribe failed: ${err.message}`;
        });
      }
      if (!settled) { settled = true; resolve(client); }
    });
    client.on('message', (topic, payload, packet) => {
      const text = payload.toString();
      const retained = !!(packet && packet.retain);
      armLog('in', topic, retained ? `(retained) ${text}` : text);
      // A retained message is the broker replaying the last thing said on that
      // topic — quite possibly a Finished from an earlier run. Worth showing,
      // never allowed to release a wait.
      if (!retained) handleArmMessage(arm, topic, text);
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

// Whether a state message means this arm has finished. The field is configurable
// because the arms need not speak the same JSON; `state` and `status` are both
// tried when the configured field is absent, and a bare word is matched as text.
function messageIsDone(def, body, text) {
  const doneValue = String((def && def.doneValue) || 'Finished').trim().toLowerCase();
  if (!doneValue) return false;
  if (body && typeof body === 'object') {
    for (const field of [def.stateField, 'state', 'status'].filter(Boolean)) {
      if (body[field] !== undefined) return String(body[field]).trim().toLowerCase() === doneValue;
    }
  }
  return String(text || '').toLowerCase().includes(doneValue);
}

// A message arrived on one of the subscribed topics. Only a state topic releases
// a wait — a status topic is there so its traffic can be read in the admin panel.
// The arm echoes our task id back, so that is what a waiter is matched on.
function handleArmMessage(arm, topic, text) {
  const defs = armDefs(arm).filter((d) => String(d.stateTopic || '').trim() === topic);
  if (!defs.length) return;

  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* plain text state */ }

  for (const def of defs) {
    if (!messageIsDone(def, body, text)) continue;
    const raw = body && def.matchField ? body[def.matchField] : undefined;
    const taskId = raw === undefined || raw === null ? null : String(raw);
    let taken = false;
    for (const waiter of [...armState.waiters]) {
      if (waiter.topic !== topic) continue;
      // A waiter that knows its task id only accepts that one; an arm that
      // echoes nothing back releases whoever is waiting on its topic.
      if (waiter.taskId && taskId && taskId !== waiter.taskId) continue;
      waiter.done('state');
      taken = true;
    }
    // Nobody was waiting yet — remember it briefly so the wait that is about to
    // start does not sit through a Finished that has already been said.
    if (!taken) armState.lastDone.set(topic, { at: Date.now(), taskId });
    return;
  }
}

// Waits for one arm to say it has finished. `since` guards the gap between
// subscribing and waiting: a Finished from while the order was being created
// counts, one from before it does not. A silent arm times out and the caller
// decides what that means, so nothing can wedge an order forever.
function waitForArmDone(arm, def, opts) {
  const topic = String((def && def.stateTopic) || '').trim();
  if (!topic) return Promise.resolve({ ok: false, via: 'no-state-topic' });

  const o = opts || {};
  const taskId = o.taskId === undefined || o.taskId === null || o.taskId === '' ? null : String(o.taskId);
  const since = Number(o.since) || 0;
  const seconds = Math.max(5, Number(o.timeoutSeconds) || Number(arm.timeoutSeconds) || 120);

  const already = armState.lastDone.get(topic);
  if (already && already.at >= since && !(taskId && already.taskId && already.taskId !== taskId)) {
    armState.lastDone.delete(topic);      // used once, never twice
    return Promise.resolve({ ok: true, via: 'state' });
  }

  return new Promise((resolve) => {
    const waiter = { topic, taskId, tag: o.tag || null };
    let timer = null;
    waiter.done = (via) => {
      if (!armState.waiters.has(waiter)) return;
      armState.waiters.delete(waiter);
      if (timer) clearTimeout(timer);
      resolve({ ok: via === 'state', via });
    };
    armState.waiters.add(waiter);
    timer = setTimeout(() => waiter.done('timeout'), seconds * 1000);
  });
}

// Why the work carried on without a Finished. Null when the arm confirmed, or
// when there was no arm involved, because there is nothing to explain then.
function describeArmOutcome(result) {
  if (!result || result.ok) return null;
  switch (result.via) {
    case 'timeout': return 'The arm never reported Finished; continued after the timeout.';
    case 'skipped': return 'The wait for the arm was skipped by hand.';
    case 'no-arm': return 'No arm is configured, so nothing was commanded.';
    case 'no-command-topic': return 'That arm has no command topic, so nothing was published.';
    case 'no-state-topic': return 'That arm has no state topic, so its Finished could not be heard.';
    case 'no-handover': return null;
    default: return null;
  }
}

// Lets an operator stop waiting — the arm is done but silent, or the run is
// being taken over by hand. Everything tagged the same way gives up at once.
function cancelArmWaits(tag, via) {
  let stopped = 0;
  for (const waiter of [...armState.waiters]) {
    if (tag && waiter.tag !== tag) continue;
    waiter.done(via || 'skipped');
    stopped += 1;
  }
  return stopped;
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

// Commands one arm and waits for it to report Finished on its state topic. The
// same two steps serve both modes: a SYNAOS hand-over between two AGVs, and an
// MPDV order stage once the AGV has reached the station.
async function runArmTransfer(arm, def, values, opts) {
  if (!def) return { ok: false, via: 'no-arm' };
  await connectArm(arm);
  if (!def.commandTopic) return { ok: false, via: 'no-command-topic' };

  // Subscribed before publishing, so a fast arm cannot answer into a void
  const since = Date.now();
  const payload = renderArmPayload(def.payloadTemplate, values);
  armState.client.publish(def.commandTopic, payload, { qos: 1 });
  armLog('out', def.commandTopic, payload);

  return waitForArmDone(arm, def, {
    taskId: values.taskId !== undefined ? values.taskId : values.transferId,
    since,
    timeoutSeconds: (opts && opts.timeoutSeconds) || arm.timeoutSeconds,
    tag: opts && opts.tag
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

// Filled in per order by the app, so a row naming one of these is ignored
// rather than allowed to overwrite the running number or the ordered quantity.
const MPDV_ORDER_AUTO_ACRONYMS = ['order.id', 'order.ordertype', 'order.plan.yield.base'];
const MPDV_OPERATION_AUTO_ACRONYMS = [
  'order.id', 'operation.operation', 'operation.plan.workplace', 'operation.article',
  'operation.designation', 'operation.plan.yield.primary', 'operation.plan.unit.primary'
];

// Rows are typed as text, but MPDV wants a number for the likes of
// `operation.cycle.target`. Send one when the text *is* a plain number and
// nothing else: "60000" becomes 60000, while "0010" stays the string it was
// typed as rather than being flattened to 10.
function mpdvFieldValue(raw) {
  const text = String(raw == null ? '' : raw).trim();
  return text && String(Number(text)) === text ? Number(text) : String(raw == null ? '' : raw);
}

// The configured rows, as params. Anything the app fills in itself is dropped.
function mpdvExtraParams(rows, autoAcronyms) {
  return cleanMpdvFields(rows)
    .filter((row) => !autoAcronyms.includes(row.acronym))
    .map((row) => ({ acronym: row.acronym, operator: 'EQUAL', value: mpdvFieldValue(row.value) }));
}

// The order itself. Its id is the running number the shop will quote later, and
// ordertype is which AGV goes for it — 0 kuka, 1 tusk — which each product
// carries, so a cart line decides its own. Everything past those three is the
// admin's own list of order fields, sent in the order it was entered.
function buildMpdvOrderPayload(cfg, orderNumber, orderType, quantity, requestId) {
  return {
    params: [
      { acronym: 'order.id', operator: 'EQUAL', value: orderNumber },
      { acronym: 'order.ordertype', operator: 'EQUAL', value: String(orderType == null ? '0' : orderType) },
      { acronym: 'order.plan.yield.base', operator: 'EQUAL', value: mpdvQuantity(quantity) },
      ...mpdvExtraParams(cfg.orderFields, MPDV_ORDER_AUTO_ACRONYMS)
    ],
    columns: cleanMpdvColumns(cfg.orderColumns),
    // A request id set in admin wins; left unset, each call in a send keeps
    // counting up as it always has.
    requestId: cleanMpdvRequestId(cfg.orderRequestId, Number(requestId) > 0 ? Number(requestId) : 1),
    language: cfg.language || 'en',
    timeZoneId: cfg.timeZoneId || 'Asia/Singapore',
    returnAsObject: cfg.orderReturnAsObject !== false
  };
}

// One operation per arm, tied to the order by the same id and carrying the same
// quantity. Below the identity fields sit that arm's own rows — the formulas,
// their modes and the cycle target — sent exactly as supplied.
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
      ...mpdvExtraParams(op.fields, MPDV_OPERATION_AUTO_ACRONYMS)
    ],
    columns: cleanMpdvColumns(op.columns),
    requestId: cleanMpdvRequestId(op.requestId, Number(requestId) > 0 ? Number(requestId) : 7),
    language: cfg.language || 'en',
    timeZoneId: cfg.timeZoneId || 'Asia/Singapore',
    returnAsObject: op.returnAsObject !== false
  };
}

// ---------------------------------------------------------------------------
// Raw request bodies
//
// The structured editor covers the order the shop normally sends, but a vendor
// test may need a body it will not produce — a different `ordertype`, columns
// asking for other fields back, params the app fills in itself. Raw mode sends
// exactly what was typed, with placeholders for the few values that can only be
// known per order.
// ---------------------------------------------------------------------------

const MPDV_RAW_PLACEHOLDERS = [
  'orderNumber', 'quantity', 'orderType', 'productName', 'requestId', 'language', 'timeZoneId'
];

// Substituted into the text *before* it is parsed, so a placeholder works both
// as a JSON string ("{orderNumber}") and as a bare number ({quantity}). Strings
// are escaped, so a product name containing a quote cannot break the JSON.
function renderMpdvRaw(template, values) {
  return String(template == null ? '' : template).replace(/\{(\w+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    const value = values[key];
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return JSON.stringify(String(value == null ? '' : value)).slice(1, -1);
  });
}

function mpdvRawEnabled(raw) {
  return !!(raw && raw.enabled && String(raw.body || '').trim());
}

// Bodies are pasted from vendor documentation and from a colleague's notes, and
// those arrive annotated: `// this must be unique` beside a field, a trailing
// comma left behind by a deleted line. None of that is JSON, but refusing it
// would mean hand-editing every sample before it can be tried. Both are removed
// here — with a scanner rather than a regular expression, so a `//` inside a
// string (a URL, say) is left exactly where it is. The comments are ours alone:
// what reaches MPDV is the parsed body.
function stripJsonComments(text) {
  let out = '';
  let inString = false, escaped = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      else if (c === '\n') out += c;          // keep the line numbering honest
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

// A comma with nothing after it but a closing brace or bracket. Strings are
// skipped for the same reason as above.
function stripTrailingCommas(text) {
  let out = '';
  let inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;   // drop the comma
    }
    out += c;
  }
  return out;
}

function parseLooseJson(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

// Nothing here stops a body being sent — it is about what happens on the
// *second* send. Checked against the text as typed rather than the filled-in
// body, because a placeholder is exactly what stops the id repeating.
function mpdvRawWarnings(rawText, body) {
  const warnings = [];
  const params = body && Array.isArray(body.params) ? body.params : [];
  const id = params.find((p) => p && p.acronym === 'order.id');
  if (id && !/\{orderNumber\}/.test(String(rawText || ''))) {
    warnings.push(`Every order sent with this body would carry the id "${id.value}". MPDV keeps order ids unique, so the next one is refused as a duplicate — put {orderNumber} in that value to give each send its own.`);
  }
  const quantity = params.find((p) => p && p.acronym === 'order.plan.yield.base');
  if (quantity && !/\{quantity\}/.test(String(rawText || ''))) {
    warnings.push(`The planned yield is fixed at ${JSON.stringify(quantity.value)}, so what the customer ordered is ignored — use {quantity} if it should follow the cart.`);
  }
  return warnings;
}

// A body that does not parse is a configuration mistake, so it is reported as
// one instead of being sent as text MPDV would only reject.
function buildMpdvRawBody(raw, values) {
  const text = renderMpdvRaw(raw.body, values);
  try {
    return { ok: true, body: parseLooseJson(text) };
  } catch (e) {
    return { ok: false, error: `The JSON typed for this request is not valid: ${e.message}`, text };
  }
}

// What actually goes on the wire for the order: the operator's own JSON when
// raw mode is on, otherwise the body built from the fields.
function mpdvOrderBody(cfg, orderNumber, orderType, quantity, requestId, productName) {
  const values = {
    orderNumber,
    quantity: mpdvQuantity(quantity),
    orderType: String(orderType == null ? '0' : orderType),
    productName: productName || '',
    requestId: cleanMpdvRequestId(cfg.orderRequestId, Number(requestId) > 0 ? Number(requestId) : 1),
    language: cfg.language || 'en',
    timeZoneId: cfg.timeZoneId || 'Asia/Singapore'
  };
  if (mpdvRawEnabled(cfg.orderRaw)) return buildMpdvRawBody(cfg.orderRaw, values);
  return { ok: true, body: buildMpdvOrderPayload(cfg, orderNumber, orderType, quantity, requestId) };
}

function mpdvOperationBody(cfg, orderNumber, op, quantity, requestId, productName, orderType) {
  const values = {
    orderNumber,
    quantity: mpdvQuantity(quantity),
    orderType: String(orderType == null ? '0' : orderType),
    productName: productName || '',
    requestId: cleanMpdvRequestId(op.requestId, Number(requestId) > 0 ? Number(requestId) : 7),
    language: cfg.language || 'en',
    timeZoneId: cfg.timeZoneId || 'Asia/Singapore'
  };
  if (mpdvRawEnabled(op.raw)) return buildMpdvRawBody(op.raw, values);
  return { ok: true, body: buildMpdvOperationPayload(cfg, orderNumber, op, quantity, requestId) };
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
          // The route says which arm does this hand-over; an older route that
          // named none means the first one, as it always did.
          const def = findArmDef(arm, handover.armId);
          armResult = await runArmTransfer(arm, def, {
            taskId: nextArmTaskId(),
            method: handover.method || 'grasp',
            quantity: Number(handover.quantity) > 0 ? Number(handover.quantity) : 1,
            from: (watch.address && watch.address.id) || '',
            to: (next.milestones[0].address && next.milestones[0].address.id) || '',
            fromStation: (watch.address && watch.address.id) || '',
            toStation: (next.milestones[0].address && next.milestones[0].address.id) || '',
            orderId: relay.orderId,
            unitId: relay.unitId,
            orderNumber: '',
            productName: relay.productName || '',
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
        current.lastError = describeArmOutcome(armResult);
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
// MPDV run supervisor
//
// In MPDV mode the app creates no AGV job: the order and its operations go to
// the MES, which sends the AGV. The arms still have to be told when to work, and
// they only work once the AGV has actually arrived — so for each hand-over in
// the product's route the supervisor:
//
//   1. watches SYNAOS until a milestone at that station has FINISHED,
//   2. publishes the command to that hand-over's arm,
//   3. waits for the arm's state topic to say Finished,
//
// and only then moves the order on to its next stage. Runs are advanced one at a
// time: there is one cell, and two orders must not command an arm at once.
// ---------------------------------------------------------------------------

let mpdvTimer = null;
let mpdvRunning = false;

// How far back to ask SYNAOS for jobs. Running jobs are always included; the
// window only decides how much finished history comes with them.
const MPDV_JOB_WINDOW_SECONDS = 3600;

function notifyMpdvRunsChanged() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send('mpdv:runsChanged');
  });
}

function scheduleMpdvSupervisor() {
  if (mpdvTimer) return;
  mpdvTimer = setInterval(runMpdvSupervisor, 4000);
  runMpdvSupervisor();
}

// The stages an MPDV order goes through, read from the product's own route: each
// hand-over the operator placed there is one stage, and the step before it says
// where the AGV has to get to before that arm can work.
function mpdvStagesForProduct(product, stations, arm) {
  const steps = (product && product.steps) || [];
  const stages = [];
  steps.forEach((step, i) => {
    if (!step || step.kind !== 'handover') return;
    const prev = steps.slice(0, i).reverse().find((s) => s && s.kind !== 'handover');
    if (!prev) return;         // a hand-over with nothing before it has no station
    const station = (stations || []).find((s) => s.id === prev.stationRef);
    const def = findArmDef(arm, step.armId);
    if (!station || !def) return;
    stages.push({
      armId: def.id,
      armLabel: def.label || def.id,
      method: step.method || 'grasp',
      stationRef: prev.stationRef,
      stationId: station.stationId,
      stationName: station.name || station.stationId,
      system: station.system || 'STATION',
      action: prev.action || null,
      state: 'pending',
      taskId: null,
      note: null
    });
  });
  return stages;
}

// Has an AGV finished a milestone at this station since the order was sent? The
// app did not create the job, so there is no id to follow — station, action and
// "after we sent the order" is what there is to go on.
function findStationArrival(jobs, stage, sinceMs) {
  for (const job of jobs || []) {
    for (const m of job.milestones || []) {
      const address = m.address || {};
      if (String(address.id || '') !== String(stage.stationId)) continue;
      if (stage.system && address.system && String(address.system) !== String(stage.system)) continue;
      // The AGV puts the load down before the arm takes it, so when the route
      // says DROP a PICK at the same station is somebody else's business.
      if (stage.action && m.action && String(m.action) !== String(stage.action)) continue;
      const finished = (m.eventHistory || []).find((e) => e && e.name === 'MILESTONE_FINISHED');
      if (!finished) continue;
      const at = finished.time ? Date.parse(finished.time) : NaN;
      if (!Number.isFinite(at) || at < sinceMs) continue;
      return { jobId: job.id, resourceId: job.assignedResourceId || null, at: finished.time };
    }
  }
  return null;
}

function findMpdvRun(store, runId) {
  return (store.pendingMpdvRuns || []).find((r) => r.id === runId) || null;
}

// A run that was waiting for an arm when the app closed has lost the wait it was
// sitting in. The AGV is already at the station, so the stage starts again from
// the command — say so plainly, because that means the arm is told twice.
function resumeMpdvRuns() {
  const store = loadStore();
  const runs = store.pendingMpdvRuns || [];
  if (!runs.length) return false;
  let changed = false;
  runs.forEach((run) => {
    if (run.state !== 'arm-running') return;
    run.state = 'waiting-for-agv';
    run.skipArrival = true;
    run.lastError = 'The app restarted while the arm was working, so it is being commanded again.';
    const stage = (run.stages || [])[run.index];
    if (stage) stage.state = 'pending';
    changed = true;
  });
  if (changed) saveStore(store);
  return runs.some((r) => r.state !== 'done' && r.state !== 'failed');
}

// Advances the oldest run that still has work. Everything is written to the
// store as it happens, so closing the window does not lose an order mid-flight.
async function runMpdvSupervisor() {
  if (mpdvRunning) return;
  mpdvRunning = true;
  try {
    const store = loadStore();
    const runs = (store.pendingMpdvRuns || []).filter((r) => r.state !== 'done' && r.state !== 'failed');
    if (!runs.length) {
      if ((store.pendingMpdvRuns || []).every((r) => r.state === 'done')) {
        clearInterval(mpdvTimer);
        mpdvTimer = null;
      }
      return;
    }

    const run = runs[0];                       // one cell, one order at a time
    const stage = (run.stages || [])[run.index];
    if (!stage) {
      run.state = 'done';
      saveStore(store);
      notifyMpdvRunsChanged();
      return;
    }

    const arm = store.settings.arm || {};
    const wait = arm.mpdvWait || {};
    // Switching the arms off has to stop work that was already queued too —
    // otherwise a run created earlier would still command an arm the operator
    // has just disabled.
    if (!arm.enabled || wait.enabled === false) return;
    const sinceMs = Date.parse(run.since) || Date.parse(run.createdAt) || Date.now();

    // A run marked as commanding an arm while nothing is waiting for one has
    // lost its wait — the only way here is an error thrown mid-stage. Put it
    // back rather than let it block every order behind it.
    if (run.state === 'arm-running' && ![...armState.waiters].some((w) => w.tag === `mpdv:${run.id}`)) {
      run.state = 'waiting-for-agv';
      run.skipArrival = true;                 // the AGV is already at the station
      stage.state = 'pending';
      saveStore(store);
      notifyMpdvRunsChanged();
      return;
    }

    // ---- 1. has the AGV got there yet? ----
    if (run.state === 'waiting-for-agv') {
      let arrival = null;
      if (run.skipArrival) {
        arrival = { jobId: null, resourceId: null, at: new Date().toISOString(), byHand: true };
      } else {
        const res = await apiRequest(store.settings, 'GET', `/api/v1/jobs?finishedLessThanSecondsAgo=${MPDV_JOB_WINDOW_SECONDS}`);
        if (!res.ok || !Array.isArray(res.data)) return;    // transient — try again next tick
        arrival = findStationArrival(res.data, stage, sinceMs);
      }

      if (!arrival) {
        const limit = Math.max(30, Number(wait.arrivalTimeoutSeconds) || 1800) * 1000;
        if (Date.now() - sinceMs > limit) {
          const fresh = loadStore();
          const target = findMpdvRun(fresh, run.id);
          if (target) {
            target.state = 'failed';
            target.lastError = `No AGV reached ${stage.stationName} within the time allowed, so ${stage.armLabel} was not commanded.`;
            saveStore(fresh);
            notifyMpdvRunsChanged();
          }
        }
        return;
      }

      // ---- 2. the AGV is there: command the arm ----
      const fresh = loadStore();
      const target = findMpdvRun(fresh, run.id);
      if (!target) return;
      const current = target.stages[target.index];
      current.state = 'arm-running';
      current.taskId = nextArmTaskId();
      current.arrivedAt = arrival.at || new Date().toISOString();
      current.arrivedBy = arrival.byHand ? 'skipped by hand' : (arrival.resourceId || null);
      target.state = 'arm-running';
      target.skipArrival = false;
      target.lastError = null;
      saveStore(fresh);
      notifyMpdvRunsChanged();

      let result;
      try {
        const def = findArmDef(arm, current.armId);
        result = await runArmTransfer(arm, def, {
          taskId: current.taskId,
          method: current.method || 'grasp',
          quantity: Number(target.quantity) > 0 ? Number(target.quantity) : 1,
          from: current.stationId,
          to: current.stationId,
          fromStation: current.stationId,
          toStation: current.stationId,
          orderId: target.orderNumber,
          orderNumber: target.orderNumber,
          productName: target.productName || '',
          unitId: target.id,
          transferId: `${target.orderNumber}-${target.index}`
        }, { timeoutSeconds: wait.armTimeoutSeconds, tag: `mpdv:${target.id}` });
      } catch (err) {
        // Broker unreachable — put the stage back and try again next tick
        const back = loadStore();
        const r = findMpdvRun(back, run.id);
        if (r) {
          r.stages[r.index].state = 'pending';
          r.state = 'waiting-for-agv';
          r.lastError = `Arm unreachable: ${err.message}`;
          // The AGV has already arrived, so do not make it arrive again
          r.skipArrival = true;
          saveStore(back);
          notifyMpdvRunsChanged();
        }
        return;
      }

      // ---- 3. the arm has answered (or the wait ran out): move the order on ----
      const after = loadStore();
      const done = findMpdvRun(after, run.id);
      if (!done) return;
      const finishedStage = done.stages[done.index];
      finishedStage.state = result.ok ? 'done' : 'continued';
      finishedStage.note = describeArmOutcome(result);
      finishedStage.finishedAt = new Date().toISOString();
      done.index += 1;
      done.lastError = finishedStage.note;
      if (done.index >= done.stages.length) {
        done.state = 'done';
        done.finishedAt = new Date().toISOString();
      } else {
        done.state = 'waiting-for-agv';
        done.since = new Date().toISOString();   // the next stage watches from now
        // Two arms working at the same station means the load is already there:
        // no AGV makes a second trip, so there would be no arrival to see.
        const next = done.stages[done.index];
        if (next.stationId === finishedStage.stationId && next.system === finishedStage.system) {
          done.skipArrival = true;
        }
      }
      saveStore(after);
      notifyMpdvRunsChanged();
    }
  } catch (err) {
    armState.lastError = `MPDV supervisor: ${err.message}`;
  } finally {
    mpdvRunning = false;
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
    const startStore = loadStore();
    const cfg = startStore.settings.mpdv || {};
    const armCfg = startStore.settings.arm || {};
    const armWait = armCfg.mpdvWait || {};
    const armGating = !!(armCfg.enabled && armWait.enabled !== false);
    const results = [];
    const queued = [];
    let requestId = 1;

    // Subscribe before the first order goes out, so an arm that answers early is
    // heard. A broker that cannot be reached is reported per line rather than
    // stopping the order — the MES record is what the shop floor needs first.
    let brokerError = null;
    if (armGating) {
      try { await connectArm(armCfg); } catch (err) { brokerError = err.message; }
    }

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

      // A request whose own JSON does not parse never reaches MPDV: it is
      // reported exactly where a rejection would have been.
      const unsendable = (kind, label, verdict) => ({
        kind, label, ok: false, status: 0, attempt: 1,
        error: verdict.error, createdId: null, response: '', request: verdict.text || ''
      });

      // The order has to exist before an operation can reference its id
      const orderBody = mpdvOrderBody(cfg, orderNumber, line.orderType, quantity, requestId++, line.name);
      const orderCall = orderBody.ok
        ? await send(orderBody.body, 'BOOrder', 'Order')
        : unsendable('order', 'Order', orderBody);
      const calls = [orderCall];

      if (orderCall.ok) {
        for (const op of cfg.operations || []) {
          const label = op.label || op.workplace || 'Operation';
          const opBody = mpdvOperationBody(cfg, orderNumber, op, quantity, requestId++, line.name, line.orderType);
          calls.push(opBody.ok
            ? await send(opBody.body, 'BOOperation', label)
            : unsendable('operation', label, opBody));
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

      // The order is in the MES; now the cell has to run it. Each hand-over in
      // the product's route becomes a stage: AGV to the station, arm commanded,
      // arm finished. A line whose order was refused runs nothing.
      if (!failed && armGating) {
        const product = (startStore.products || []).find((p) => p.id === line.productId);
        const stages = mpdvStagesForProduct(product, startStore.stations, armCfg);
        if (stages.length) {
          const run = {
            id: crypto.randomUUID(),
            orderNumber,
            productId: line.productId || null,
            productName: line.name || '',
            quantity,
            orderType: String(line.orderType == null ? '0' : line.orderType),
            stages,
            index: 0,
            state: 'waiting-for-agv',
            // Only an arrival from here on belongs to this order
            since: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            lastError: brokerError ? `Broker unreachable when the order was sent: ${brokerError}` : null
          };
          queued.push(run);
          entry.run = { id: run.id, stages: stages.map((s) => ({ armLabel: s.armLabel, stationName: s.stationName })) };
        }
        entry.armNote = brokerError
          ? `The order reached MPDV, but the arm broker did not answer: ${brokerError}`
          : (stages.length ? null : 'No hand-over is set in this product\'s route, so no arm is commanded.');
      }

      recordMpdvLog(entry);
      results.push(entry);
    }

    if (queued.length) {
      const store = loadStore();
      store.pendingMpdvRuns = (store.pendingMpdvRuns || []).concat(queued);
      saveStore(store);
      scheduleMpdvSupervisor();
      notifyMpdvRunsChanged();
    }
    return results;
  });

  // What the cell is doing with the MPDV orders that are running
  ipcMain.handle('mpdv:runs', () => (loadStore().pendingMpdvRuns || []).map((r) => ({
    id: r.id,
    orderNumber: r.orderNumber,
    productName: r.productName,
    quantity: r.quantity,
    state: r.state,
    index: r.index,
    lastError: r.lastError || null,
    createdAt: r.createdAt,
    stages: (r.stages || []).map((s) => ({
      armId: s.armId, armLabel: s.armLabel, stationName: s.stationName, stationId: s.stationId,
      action: s.action, state: s.state, note: s.note || null,
      arrivedAt: s.arrivedAt || null, arrivedBy: s.arrivedBy || null, taskId: s.taskId || null
    }))
  })));

  // Stop waiting: while watching for the AGV this says "it is there, go on"; while
  // waiting for the arm it says "it is done, carry on without the message".
  ipcMain.handle('mpdv:skipWait', (_ev, runId) => {
    const store = loadStore();
    const run = findMpdvRun(store, runId);
    if (!run) return { ok: false, error: 'That run is no longer listed.' };
    if (run.state === 'arm-running') {
      const stopped = cancelArmWaits(`mpdv:${run.id}`, 'skipped');
      return { ok: true, skipped: 'arm', stopped };
    }
    run.skipArrival = true;
    run.state = 'waiting-for-agv';
    saveStore(store);
    scheduleMpdvSupervisor();
    notifyMpdvRunsChanged();
    return { ok: true, skipped: 'arrival' };
  });

  // Gives up on a run. The MES order stays exactly as it is — this only stops the
  // app from commanding arms for it.
  ipcMain.handle('mpdv:cancelRun', (_ev, runId) => {
    const store = loadStore();
    const run = findMpdvRun(store, runId);
    if (!run) return { ok: false, error: 'That run is no longer listed.' };
    cancelArmWaits(`mpdv:${run.id}`, 'skipped');
    store.pendingMpdvRuns = (store.pendingMpdvRuns || []).filter((r) => r.id !== runId);
    saveStore(store);
    notifyMpdvRunsChanged();
    return { ok: true };
  });

  // Clears the finished and abandoned runs out of the list
  ipcMain.handle('mpdv:clearRuns', () => {
    const store = loadStore();
    store.pendingMpdvRuns = (store.pendingMpdvRuns || []).filter((r) => r.state !== 'done' && r.state !== 'failed');
    saveStore(store);
    notifyMpdvRunsChanged();
    return true;
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
      // What would actually go out — the operator's own JSON where raw mode is
      // on, so the preview never shows a body that is not the one being sent.
      payload: buildMpdvOrderPayload(cfg, orderNumber, '0', 1, 1),
      operationPayloads: (cfg.operations || []).map((op, i) => ({
        label: op.label || op.workplace,
        payload: buildMpdvOperationPayload(cfg, orderNumber, op, 1, 7 + i)
      })),
      raw: {
        placeholders: MPDV_RAW_PLACEHOLDERS,
        order: mpdvRawEnabled(cfg.orderRaw)
          ? mpdvOrderBody(cfg, orderNumber, '0', 1, 1, 'Example product')
          : null,
        operations: (cfg.operations || []).map((op, i) => (mpdvRawEnabled(op.raw)
          ? mpdvOperationBody(cfg, orderNumber, op, 1, 7 + i, 'Example product', '0')
          : null))
      }
    };
  });

  // Checks one raw body without sending anything: does it parse once the
  // placeholders are filled in, and what comes out the other side?
  ipcMain.handle('mpdv:checkRaw', (_ev, body) => {
    const store = loadStore();
    const cfg = store.settings.mpdv || {};
    const key = mpdvDateKey(cfg.timeZoneId);
    const counter = store.mpdvCounter || { date: '', seq: 0 };
    const seq = (counter.date === key ? Number(counter.seq) || 0 : 0) + 1;
    const verdict = buildMpdvRawBody({ body }, {
      orderNumber: formatMpdvOrderNumber(key, Math.min(seq, MPDV_MAX_ORDERS_PER_DAY)),
      quantity: 1,
      orderType: '0',
      productName: 'Example product',
      requestId: 1,
      language: cfg.language || 'en',
      timeZoneId: cfg.timeZoneId || 'Asia/Singapore'
    });
    return verdict.ok
      ? { ok: true, preview: JSON.stringify(verdict.body, null, 2), warnings: mpdvRawWarnings(body, verdict.body) }
      : { ok: false, error: verdict.error, text: verdict.text };
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
    normalizeArms(arm);
    try {
      await connectArm(arm);
      return { ok: true, connected: true, subscribed: armTopics(arm).join(', ') || null };
    } catch (err) {
      return { ok: false, connected: false, error: err.message };
    }
  });

  // Publishes a command to one arm by hand, to check it reacts as expected.
  ipcMain.handle('arm:testPublish', async (_ev, armOverride, armId) => {
    const store = loadStore();
    const arm = Object.assign({}, store.settings.arm, armOverride || {});
    normalizeArms(arm);
    const def = findArmDef(arm, armId);
    if (!def) return { ok: false, error: 'No arm is configured.' };
    try {
      const res = await runArmTransfer(arm, def, {
        taskId: nextArmTaskId(), method: 'grasp', quantity: 1,
        from: 'K1', to: 'T2', fromStation: 'K1', toStation: 'T2',
        orderId: 'test-order', orderNumber: 'test-order', productName: 'Test',
        unitId: 'test-unit', transferId: 'test-transfer'
      });
      return { ok: true, via: res.via, armLabel: def.label, note: describeArmOutcome(res) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('arm:status', () => {
    const store = loadStore();
    return {
      connected: armState.connected,
      lastError: armState.lastError,
      log: armState.log.slice(0, 12),
      topics: armTopics(store.settings.arm || {}),
      pending: (store.pendingRelays || []).map((r) => ({
        unitId: r.unitId, productName: r.productName, state: r.state,
        leg: r.nextIndex + 1, totalLegs: r.legs.length, lastError: r.lastError
      })),
      mpdvRuns: (store.pendingMpdvRuns || [])
        .filter((r) => r.state !== 'done')
        .map((r) => ({
          orderNumber: r.orderNumber, productName: r.productName, state: r.state,
          stage: r.index + 1, totalStages: (r.stages || []).length,
          armLabel: ((r.stages || [])[r.index] || {}).armLabel || '',
          stationName: ((r.stages || [])[r.index] || {}).stationName || '',
          lastError: r.lastError || null
        }))
    };
  });

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
    if (resumeMpdvRuns()) scheduleMpdvSupervisor();
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
  mpdvOrderBody,
  mpdvOperationBody,
  renderMpdvRaw,
  buildMpdvRawBody,
  cleanMpdvRaw,
  defaultMpdvOperationFields,
  mpdvFieldValue,
  mpdvExtraParams,
  mpdvRequest,
  interpretMpdvResponse,
  renderArmPayload,
  handleArmMessage,
  messageIsDone,
  armDefs,
  findArmDef,
  armTopics,
  normalizeArms,
  migrateArmsList,
  waitForArmDone,
  cancelArmWaits,
  mpdvStagesForProduct,
  findStationArrival,
  runMpdvSupervisor,
  resumeMpdvRuns,
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
