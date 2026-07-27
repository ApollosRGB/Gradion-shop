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
      apiPassword: 'X#jzd.0sdc20b0q#MYa"'
    },
    stations: [
      { id: 'st-k2', stationId: 'K2', name: 'Production', fn: 'production', system: 'STATION', allowedRobots: [] },
      { id: 'st-k1', stationId: 'K1', name: 'Shop', fn: 'shop', system: 'STATION', allowedRobots: [] }
    ],
    robots: [],
    capability: {},
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
    data.settings = Object.assign(def.settings, data.settings || {});
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

// A resource id is only usable if it is a real, concrete id — never a UI sentinel
// such as "" (auto) or "__capable__" (app picks a capable robot).
function usableResourceId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.startsWith('__')) return null;
  return id;
}

function buildJobPayload(product, stations, orderId, unitId, resourceId) {
  const jobId = crypto.randomUUID();
  const correlations = [
    { kind: 'order', id: orderId },
    { kind: 'orderUnit', id: unitId }
  ];
  const milestones = product.steps.map((step) => {
    const st = stations.find((s) => s.id === step.stationRef);
    return {
      id: crypto.randomUUID(),
      action: step.action,
      address: { system: (st && st.system) || 'STATION', id: st ? st.stationId : step.stationRef },
      correlations
    };
  });
  const job = {
    id: jobId,
    milestones,
    executeMilestonesInProvidedSequence: true,
    correlations: [{ kind: 'SCHEDULER', id: 'SYNAOS-JOBS' }, ...correlations],
    scheduling: { scheduler: 'SYNAOS-JOBS' }
  };
  // Optionally pin the job to a specific transport resource (robot).
  // The renderer resolves which robot may serve this product's stations; anything
  // else (auto, sentinels, blanks) is left unassigned so the SYNAOS scheduler decides.
  const pinned = usableResourceId(resourceId);
  if (pinned) job.assignedResourceId = pinned;
  return job;
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
            if (unreachable) noteCap(key, rid, 'no');
            else if (events.includes('MILESTONE_FINISHED')) noteCap(key, rid, 'ok');
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

  // Creates one SYNAOS job per ordered unit. Returns created job descriptors.
  ipcMain.handle('api:createOrderJobs', async (_ev, { orderId, units }) => {
    const store = loadStore();
    const results = [];
    for (const unit of units) {
      const product = store.products.find((p) => p.id === unit.productId);
      if (!product) {
        results.push({ unitId: unit.unitId, ok: false, error: 'Unknown product' });
        continue;
      }
      const payload = buildJobPayload(product, store.stations, orderId, unit.unitId, unit.resourceId);
      const res = await apiRequest(store.settings, 'POST', '/api/v1/jobs', payload);
      if (res.ok) {
        // Best-effort: register an Operation so the job shows up in the SYNAOS frontend
        apiRequest(store.settings, 'POST', '/api/v1/operations', {
          id: crypto.randomUUID(),
          name: product.name,
          filter: { id: payload.id, kind: 'jobId' },
          type: 'Job',
          icon: 'JOB'
        });
      }
      results.push({
        unitId: unit.unitId,
        ok: res.ok,
        status: res.status,
        jobId: payload.id,
        assignedResourceId: payload.assignedResourceId || null,
        error: res.ok ? null : res.error || (res.raw ? String(res.raw).slice(0, 300) : `HTTP ${res.status}`)
      });
    }
    return results;
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
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
