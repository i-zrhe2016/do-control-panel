const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DO_API_TOKEN = process.env.DO_API_TOKEN || '';
const DO_API_BASE = 'https://api.digitalocean.com/v2';
const DO_DEFAULT_SSH_PUBLIC_KEY = (process.env.DO_DEFAULT_SSH_PUBLIC_KEY || '').trim();
const FIXED_REGION = 'sgp1';
const FIXED_SIZE = 's-2vcpu-2gb';
const FIXED_IMAGE = 'ubuntu-22-04-x64';
const CREDITS_CACHE_TTL_MS = 15_000;
const INVOICE_PAGE_SIZE = 100;
const INVOICE_MAX_PAGES = 100;
const STUDENT_PACK_INITIAL_CREDITS = numberOrDefault(process.env.DO_STUDENT_PACK_INITIAL_CREDITS, 200);
const DIRECT_CREDITS_KEYS = [
  'available_credits',
  'availableCredits',
  'credits_balance',
  'creditsBalance',
  'credit_balance',
  'creditBalance',
  'remaining_credits',
  'remainingCredits',
  'promo_credit_remaining',
  'promoCreditRemaining',
];

let creditsCache = {
  value: null,
  expiresAt: 0,
};

function numberOrDefault(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function doApi(pathname, options = {}) {
  if (!DO_API_TOKEN) {
    throw new Error('Missing DO_API_TOKEN');
  }

  const headers = {
    Authorization: `Bearer ${DO_API_TOKEN}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const resp = await fetch(`${DO_API_BASE}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!resp.ok) {
    const msg = json?.message || json?.id || 'DigitalOcean API request failed';
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = json;
    throw err;
  }

  return json;
}

function dropletToView(d) {
  const v4 = (d.networks && Array.isArray(d.networks.v4)) ? d.networks.v4 : [];
  const publicIp = v4.find((n) => n.type === 'public')?.ip_address || null;

  return {
    id: d.id,
    name: d.name,
    status: d.status,
    region: d.region?.slug || null,
    size: d.size_slug || d.size?.slug || null,
    image: d.image?.slug || d.image?.name || null,
    tags: Array.isArray(d.tags) ? d.tags : [],
    publicIp,
    createdAt: d.created_at || null,
  };
}

async function listDroplets() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await doApi(`/droplets?page=${page}&per_page=100`);
    const droplets = data.droplets || [];
    all.push(...droplets.map(dropletToView));
    if (droplets.length < 100) break;
    page += 1;
  }
  return all;
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundUsd(value) {
  return Math.round(value * 100) / 100;
}

function extractList(data, preferredKeys = []) {
  if (Array.isArray(data)) {
    return data;
  }

  for (const key of preferredKeys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  for (const value of Object.values(data || {})) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function parseDateOrNull(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function latestTimestamp(a, b) {
  const left = parseDateOrNull(a);
  const right = parseDateOrNull(b);

  if (!left) {
    return right ? right.toISOString() : null;
  }

  if (!right) {
    return left.toISOString();
  }

  return left >= right ? left.toISOString() : right.toISOString();
}

function pickDirectCreditsValue(data) {
  for (const key of DIRECT_CREDITS_KEYS) {
    const value = numberOrNull(data?.[key]);
    if (value !== null) {
      return { key, value };
    }
  }
  return null;
}

async function listInvoices() {
  const invoices = [];
  let invoicePreview = null;
  let page = 1;

  while (page <= INVOICE_MAX_PAGES) {
    const data = await doApi(`/customers/my/invoices?page=${page}&per_page=${INVOICE_PAGE_SIZE}`);
    const pageInvoices = extractList(data, ['invoices']);
    invoices.push(...pageInvoices);

    if (!invoicePreview && data?.invoice_preview) {
      invoicePreview = data.invoice_preview;
    }

    if (pageInvoices.length < INVOICE_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return {
    invoices,
    invoicePreview,
  };
}

async function getInvoiceSummary(invoiceUuid) {
  return doApi(`/customers/my/invoices/${invoiceUuid}/summary`);
}

async function getInvoicePreviewSummary() {
  return doApi('/customers/my/invoices/preview/summary');
}

function getSummaryCreditsAmount(summary) {
  const lineItemAmounts = Array.isArray(summary?.credits?.items)
    ? summary.credits.items
        .map((item) => numberOrNull(item?.amount))
        .filter((value) => value !== null)
    : [];

  if (lineItemAmounts.length > 0) {
    return roundUsd(lineItemAmounts.reduce((sum, value) => sum + Math.abs(value), 0));
  }

  const amount = numberOrNull(summary?.credits?.amount);
  if (amount !== null) {
    return roundUsd(Math.abs(amount));
  }

  return 0;
}

function summarizeCreditsFromInvoices(summaries, initialCredits) {
  let consumedCredits = 0;
  let generatedAt = null;

  for (const summary of summaries) {
    consumedCredits += getSummaryCreditsAmount(summary);
    generatedAt = latestTimestamp(
      generatedAt,
      summary?.invoice_generated_at || summary?.updated_at || summary?.issue_date || null,
    );
  }

  const roundedConsumed = roundUsd(consumedCredits);
  return {
    initialCredits: roundUsd(initialCredits),
    consumedCredits: roundedConsumed,
    availableCredits: roundUsd(Math.max(0, initialCredits - roundedConsumed)),
    invoiceCount: summaries.length,
    generatedAt,
  };
}

async function getAvailableCredits() {
  if (creditsCache.value && creditsCache.expiresAt > Date.now()) {
    return creditsCache.value;
  }

  let balanceData = {};
  try {
    balanceData = await doApi('/customers/my/balance');
  } catch {
    balanceData = {};
  }

  const directCredits = pickDirectCreditsValue(balanceData);
  let credits;

  if (directCredits) {
    credits = {
      availableCredits: roundUsd(directCredits.value),
      generatedAt: balanceData.generated_at || null,
      source: 'balance_field',
      exact: true,
      note: `DigitalOcean balance response field: ${directCredits.key}`,
    };
  } else {
    const { invoices } = await listInvoices();
    const summaries = await Promise.all(
      invoices
        .map((invoice) => String(invoice?.invoice_uuid || '').trim())
        .filter(Boolean)
        .map((invoiceUuid) => getInvoiceSummary(invoiceUuid)),
    );
    const previewSummary = await getInvoicePreviewSummary().catch(() => null);
    const allSummaries = previewSummary ? [...summaries, previewSummary] : summaries;
    const summary = summarizeCreditsFromInvoices(allSummaries, STUDENT_PACK_INITIAL_CREDITS);

    credits = {
      ...summary,
      generatedAt: summary.generatedAt || balanceData.generated_at || null,
      source: 'invoice_summaries',
      exact: false,
      note: `Estimated from a $${roundUsd(STUDENT_PACK_INITIAL_CREDITS)} GitHub Student Pack using invoice summaries and the current invoice preview.`,
    };
  }

  creditsCache = {
    value: credits,
    expiresAt: Date.now() + CREDITS_CACHE_TTL_MS,
  };

  return credits;
}

async function deleteDropletsByTag(tagName) {
  const droplets = await listDroplets();
  const targets = droplets.filter((d) => Array.isArray(d.tags) && d.tags.includes(tagName));
  const deletedIds = [];
  const failed = [];

  for (const droplet of targets) {
    try {
      await doApi(`/droplets/${droplet.id}`, { method: 'DELETE' });
      deletedIds.push(droplet.id);
    } catch (err) {
      failed.push({
        id: droplet.id,
        error: err.message || 'Delete failed',
      });
    }
  }

  return {
    tag: tagName,
    matched: targets.length,
    deleted: deletedIds.length,
    deletedIds,
    failed,
  };
}

async function listSshKeys() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await doApi(`/account/keys?page=${page}&per_page=200`);
    const keys = data.ssh_keys || [];
    all.push(...keys);
    if (keys.length < 200) break;
    page += 1;
  }
  return all;
}

function normalizePubKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

async function ensureDefaultSshKeyFingerprint() {
  if (!DO_DEFAULT_SSH_PUBLIC_KEY) {
    return null;
  }

  const normalized = normalizePubKey(DO_DEFAULT_SSH_PUBLIC_KEY);
  const existing = (await listSshKeys()).find((k) => normalizePubKey(k.public_key) === normalized);
  if (existing?.fingerprint) {
    return existing.fingerprint;
  }

  try {
    const created = await doApi('/account/keys', {
      method: 'POST',
      body: {
        name: `do-panel-key-${Date.now()}`,
        public_key: DO_DEFAULT_SSH_PUBLIC_KEY,
      },
    });
    return created?.ssh_key?.fingerprint || null;
  } catch (err) {
    const retried = (await listSshKeys()).find((k) => normalizePubKey(k.public_key) === normalized);
    if (retried?.fingerprint) {
      return retried.fingerprint;
    }
    throw err;
  }
}

function sanitizeName(name) {
  const raw = String(name || '').trim().toLowerCase();
  const safe = raw
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);

  if (!safe) {
    return `do-${Date.now()}`;
  }

  return safe;
}

function normalizeTags(tagsValue) {
  const source = Array.isArray(tagsValue)
    ? tagsValue
    : String(tagsValue || '').split(/[,\n，]/);

  const normalized = source
    .map((tag) => String(tag || '').trim())
    .filter(Boolean);

  return Array.from(new Set(normalized));
}

async function getDropletTags(dropletId) {
  const data = await doApi(`/droplets/${dropletId}`);
  const tags = data?.droplet?.tags;
  return normalizeTags(tags);
}

function tagResourcePayload(dropletId) {
  return {
    resources: [
      {
        resource_id: String(dropletId),
        resource_type: 'droplet',
      },
    ],
  };
}

async function addTagToDroplet(tagName, dropletId) {
  try {
    await doApi(`/tags/${encodeURIComponent(tagName)}/resources`, {
      method: 'POST',
      body: tagResourcePayload(dropletId),
    });
  } catch (err) {
    if (err.status !== 404) {
      throw err;
    }

    await doApi('/tags', {
      method: 'POST',
      body: { name: tagName },
    }).catch((createErr) => {
      if (createErr.status !== 422) {
        throw createErr;
      }
    });

    await doApi(`/tags/${encodeURIComponent(tagName)}/resources`, {
      method: 'POST',
      body: tagResourcePayload(dropletId),
    });
  }
}

async function removeTagFromDroplet(tagName, dropletId) {
  await doApi(`/tags/${encodeURIComponent(tagName)}/resources`, {
    method: 'DELETE',
    body: tagResourcePayload(dropletId),
  });
}

async function handleApi(req, res, urlObj) {
  if (!DO_API_TOKEN) {
    sendJson(res, 500, { error: 'Missing DO_API_TOKEN environment variable' });
    return;
  }

  try {
    if (req.method === 'GET' && urlObj.pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/droplets') {
      const droplets = await listDroplets();
      sendJson(res, 200, { droplets });
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/credits') {
      const credits = await getAvailableCredits();
      sendJson(res, 200, { credits });
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/balance') {
      sendJson(res, 410, { error: 'Deprecated endpoint. Use /api/credits.' });
      return;
    }

    if (req.method === 'POST' && urlObj.pathname === '/api/droplets') {
      const body = await parseBody(req);

      const name = sanitizeName(body.name || `do-${Date.now()}`);
      const tags = normalizeTags(body.tags);
      const requestedFingerprint = String(body.sshKeyFingerprint || '').trim();
      const defaultFingerprint = requestedFingerprint ? null : await ensureDefaultSshKeyFingerprint();

      const payload = {
        name,
        region: FIXED_REGION,
        size: FIXED_SIZE,
        image: FIXED_IMAGE,
      };

      if (tags.length > 0) {
        payload.tags = tags;
      }

      if (requestedFingerprint || defaultFingerprint) {
        payload.ssh_keys = [requestedFingerprint || defaultFingerprint];
      }

      const data = await doApi('/droplets', { method: 'POST', body: payload });
      sendJson(res, 201, {
        droplet: dropletToView(data.droplet || {}),
        profile: {
          region: FIXED_REGION,
          size: FIXED_SIZE,
          image: FIXED_IMAGE,
        },
      });
      return;
    }

    if (req.method === 'PATCH' && /^\/api\/droplets\/\d+\/rename$/.test(urlObj.pathname)) {
      const match = urlObj.pathname.match(/^\/api\/droplets\/(\d+)\/rename$/);
      const dropletId = Number(match[1]);
      const body = await parseBody(req);
      const name = sanitizeName(body.name);

      const action = await doApi(`/droplets/${dropletId}/actions`, {
        method: 'POST',
        body: {
          type: 'rename',
          name,
        },
      });

      sendJson(res, 202, {
        action: action.action || null,
        message: 'Rename action submitted',
      });
      return;
    }

    if (req.method === 'PATCH' && /^\/api\/droplets\/\d+\/tags$/.test(urlObj.pathname)) {
      const match = urlObj.pathname.match(/^\/api\/droplets\/(\d+)\/tags$/);
      const dropletId = Number(match[1]);
      const body = await parseBody(req);
      const targetTags = normalizeTags(body.tags);
      const currentTags = await getDropletTags(dropletId);

      const tagsToAdd = targetTags.filter((tag) => !currentTags.includes(tag));
      const tagsToRemove = currentTags.filter((tag) => !targetTags.includes(tag));

      for (const tag of tagsToAdd) {
        await addTagToDroplet(tag, dropletId);
      }

      for (const tag of tagsToRemove) {
        await removeTagFromDroplet(tag, dropletId);
      }

      sendJson(res, 200, {
        ok: true,
        tags: targetTags,
        added: tagsToAdd,
        removed: tagsToRemove,
      });
      return;
    }

    if (req.method === 'POST' && /^\/api\/droplets\/\d+\/rebuild$/.test(urlObj.pathname)) {
      const match = urlObj.pathname.match(/^\/api\/droplets\/(\d+)\/rebuild$/);
      const dropletId = Number(match[1]);
      await parseBody(req);

      const action = await doApi(`/droplets/${dropletId}/actions`, {
        method: 'POST',
        body: {
          type: 'rebuild',
          image: FIXED_IMAGE,
        },
      });

      sendJson(res, 202, {
        action: action.action || null,
        message: 'Rebuild action submitted',
        image: FIXED_IMAGE,
      });
      return;
    }

    if (req.method === 'DELETE' && /^\/api\/droplets\/\d+$/.test(urlObj.pathname)) {
      const match = urlObj.pathname.match(/^\/api\/droplets\/(\d+)$/);
      const dropletId = Number(match[1]);
      await doApi(`/droplets/${dropletId}`, { method: 'DELETE' });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'DELETE' && /^\/api\/droplets\/by-tag\/[^/]+$/.test(urlObj.pathname)) {
      const match = urlObj.pathname.match(/^\/api\/droplets\/by-tag\/([^/]+)$/);
      const tagName = decodeURIComponent(match[1] || '').trim();
      if (!tagName) {
        sendJson(res, 400, { error: 'Tag is required' });
        return;
      }

      const result = await deleteDropletsByTag(tagName);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const statusCode = err.status || 500;
    sendJson(res, statusCode, {
      error: err.message || 'Internal server error',
      details: err.payload || null,
    });
  }
}

function serveStatic(req, res, urlObj) {
  const pathname = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
  const filePath = path.join(__dirname, 'public', pathname);

  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const urlObj = new URL(req.url, `http://${host}`);

  if (urlObj.pathname.startsWith('/api/')) {
    handleApi(req, res, urlObj);
    return;
  }

  serveStatic(req, res, urlObj);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`DO control panel running: http://localhost:${PORT}`);
});
