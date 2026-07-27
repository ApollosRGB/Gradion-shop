const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
        enabled: false,
        brokerUrl: 'mqtt://localhost:1883',
        username: '',
        password: '',
        clientId: '',
        commandTopic: 'arm/command',
        statusTopic: 'arm/status',
        // Placeholders: {from} {to} {fromStation} {toStation} {orderId} {unitId} {transferId}
        payloadTemplate: '{\n  "command": "transfer",\n  "from": "{from}",\n  "to": "{to}",\n  "orderId": "{orderId}",\n  "transferId": "{transferId}"\n}',
        statusField: 'status',       // JSON field to read from the status message ('' = match raw text)
        statusDoneValue: 'done',     // value/substring meaning "transfer finished"
        statusMatchField: 'transferId', // optional field tying a status back to its transfer
        timeoutSeconds: 120          // give up waiting and continue anyway
      }
    },
    stations: [
      { id: 'st-k2', stationId: 'K2', name: 'Production', fn: 'production', system: 'STATION', allowedRobots: [] },
      { id: 'st-k1', stationId: 'K1', name: 'Shop', fn: 'shop', system: 'STATION', allowedRobots: [] }
    ],
    robots: [],
    capability: {},
    pendingRelays: [],
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

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const data = JSON.parse(raw);
    // Merge with defaults so new fields appear after app updates
    const def = defaultStore();
    const arm = Object.assign({}, def.settings.arm, (data.settings && data.settings.arm) || {});
    data.settings = Object.assign(def.settings, data.settings || {});
    data.settings.arm = arm;
    data.pendingRelays = data.pendingRelays || [];
    data.stations = data.stations || def.stations;
    data.stations.forEach((s) => {
      if (!s.system) s.system = 'STATION';
      if (!Array.isArray(s.allowedRobots)) s.allowedRobots = [];
    });
    data.capability = data.capability || {};
    data.products = data.products || def.products;
    // Seed rating counters so the displayed rating can become a running average
    data.products.forEach((p) => { if (p.ratingCount == null) p.ratingCount = p.sold || 0; });
    data.robots = data.robots || [];
    data.robots.forEach((r) => { if (r.homeNode === undefined) r.homeNode = null; });
    data.orders = data.orders || [];
    return data;
  } catch (e) {
    return defaultStore();
  }
}

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
  return [arm.brokerUrl, arm.username, arm.password, arm.clientId, arm.statusTopic].join('|');
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
      clean: true
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
    const waiter = { transferId: values.transferId };
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
function buildRelayPayloads(legs, stations, orderId, unitId) {
  const correlations = [
    { kind: 'order', id: orderId },
    { kind: 'orderUnit', id: unitId }
  ];
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

    jobs.push({ payload: job, legIndex, totalLegs: legs.length });
  });

  return jobs;
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

      // Drop is done — run the transfer, then create the receiving AGV's job.
      const arm = store.settings.arm || {};
      const transferId = `${relay.unitId}-${relay.nextIndex}`;
      relay.state = 'arm-running';
      relay.lastError = null;
      saveStore(store);
      notifyRelayChanged();

      let armResult;
      try {
        armResult = await runArmTransfer(arm, {
          from: (watch.address && watch.address.id) || '',
          to: (next.milestones[0].address && next.milestones[0].address.id) || '',
          fromStation: (watch.address && watch.address.id) || '',
          toStation: (next.milestones[0].address && next.milestones[0].address.id) || '',
          orderId: relay.orderId,
          unitId: relay.unitId,
          transferId
        });
      } catch (err) {
        // Could not reach the broker — leave it queued and retry on the next tick
        const s = loadStore();
        const r = (s.pendingRelays || []).find((x) => x.id === relay.id);
        if (r) { r.state = 'waiting-for-drop'; r.lastError = `Arm unreachable: ${err.message}`; saveStore(s); }
        notifyRelayChanged();
        continue;
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
    const stations = [...stationMap.entries()]
      .map(([id, sys]) => ({ id: String(id), system: sys.has('STATION') ? 'STATION' : [...sys][0] }))
      .sort((a, b) => (a.system === b.system ? a.id.localeCompare(b.id) : a.system.localeCompare(b.system)));

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
    return { ok: true, status: res.status, jobCount: jobs.length, stations, robots, capability };
  });

  // Creates the SYNAOS jobs for each ordered unit — one job per robot leg.
  // Legs are posted in order because a follow-on leg references the previous leg's
  // milestone id; if a leg fails, the unit's remaining legs are skipped so we never
  // leave a dangling dependency pointing at a milestone that was never created.
  ipcMain.handle('api:createOrderJobs', async (_ev, { orderId, units }) => {
    const store = loadStore();
    const results = [];
    for (const unit of units) {
      const product = store.products.find((p) => p.id === unit.productId);
      if (!product) {
        results.push({ unitId: unit.unitId, ok: false, error: 'Unknown product' });
        continue;
      }
      const legs = Array.isArray(unit.legs) && unit.legs.length
        ? unit.legs
        : [{ resourceId: unit.resourceId, steps: product.steps }];

      const planned = buildRelayPayloads(legs, store.stations, orderId, unit.unitId);

      // With the robotic arm in play the load has to be moved between the two
      // AGVs before the receiving one may pick up, so only the first leg is
      // dispatched now. The rest are created by the relay supervisor once the
      // arm reports each transfer done. Ids are already fixed, so the renderer
      // can track the deferred jobs from the start.
      const armCfg = (store.settings && store.settings.arm) || {};
      const armGated = !!armCfg.enabled && planned.length > 1;
      const dispatchNow = armGated ? planned.slice(0, 1) : planned;
      const deferred = armGated ? planned.slice(1) : [];

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
          nextIndex: 1,
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
  renderArmPayload,
  handleArmStatus,
  connectArm,
  runArmTransfer,
  buildRelayPayloads,
  usableResourceId,
  armState
};
