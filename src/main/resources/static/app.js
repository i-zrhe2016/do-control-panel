const createForm = document.getElementById('createForm');
const createRegionEl = document.getElementById('createRegion');
const createSizeQueryEl = document.getElementById('createSizeQuery');
const createSizeEl = document.getElementById('createSize');
const tableBody = document.getElementById('dropletTableBody');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const tagFilterEl = document.getElementById('tagFilter');
const deleteByTagBtn = document.getElementById('deleteByTagBtn');
const statTotal = document.getElementById('statTotal');
const statActive = document.getElementById('statActive');
const statInactive = document.getElementById('statInactive');
const statCredits = document.getElementById('statCredits');
const statCreditsSub = document.getElementById('statCreditsSub');
const statCreditsMeta = document.getElementById('statCreditsMeta');
const ALL_TAG_FILTER = '__all__';
const CREDITS_POLL_MS = 15_000;
const SIZE_SEARCH_DEBOUNCE_MS = 250;
let allDroplets = [];
let creditsPollTimer = null;
let creditsLoading = false;
let sizeSearchTimer = null;

function setStatus(message, type = 'ok') {
  statusEl.textContent = message;
  statusEl.classList.remove('error', 'loading');
  if (type === 'error') statusEl.classList.add('error');
  if (type === 'loading') statusEl.classList.add('loading');
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseTagsInput(value) {
  const parts = String(value || '').split(/[,\n，]/);
  const tags = parts
    .map((tag) => tag.trim())
    .filter(Boolean);
  return Array.from(new Set(tags));
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return '--';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDateTime(value) {
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatSizeLabel(size) {
  const slug = String(size?.slug || '');
  const vcpus = toNumberOrNull(size?.vcpus);
  const memoryGb = toNumberOrNull(size?.memoryGb);
  const diskGb = toNumberOrNull(size?.diskGb);
  const transferTb = toNumberOrNull(size?.transferTb);
  const monthlyUsd = toNumberOrNull(size?.monthlyUsd);

  const parts = [];
  if (vcpus !== null && memoryGb !== null) {
    parts.push(`${vcpus} vCPU / ${memoryGb}GB`);
  }
  if (diskGb !== null) {
    parts.push(`${diskGb}GB SSD`);
  }
  if (transferTb !== null) {
    parts.push(`${transferTb}TB transfer`);
  }
  if (monthlyUsd !== null) {
    parts.push(`$${monthlyUsd}/mo`);
  }

  return [slug, ...parts].filter(Boolean).join(' · ');
}

function renderSizeOptions(sizes, preferred = '') {
  const selected = preferred || createSizeEl.value;
  const safeSizes = Array.isArray(sizes) ? sizes : [];

  createSizeEl.innerHTML = '';
  if (!safeSizes.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '没有匹配型号';
    createSizeEl.append(option);
    createSizeEl.disabled = true;
    return;
  }

  for (const size of safeSizes) {
    const option = document.createElement('option');
    option.value = String(size.slug || '');
    option.textContent = formatSizeLabel(size);
    createSizeEl.append(option);
  }

  createSizeEl.disabled = false;
  if (selected && safeSizes.some((item) => String(item.slug || '') === selected)) {
    createSizeEl.value = selected;
    return;
  }

  const recommended = safeSizes.find((item) => Boolean(item.recommended));
  createSizeEl.value = String(recommended?.slug || safeSizes[0].slug || '');
}

async function loadPopularSizes(query = '') {
  const q = String(query || '').trim();
  const params = new URLSearchParams();
  const region = createRegionEl.value.trim();
  if (q) {
    params.set('q', q);
  }
  if (region) {
    params.set('region', region);
  }
  const url = params.size > 0 ? `/api/sizes/popular?${params.toString()}` : '/api/sizes/popular';
  const current = createSizeEl.value;
  const data = await fetchJson(url);
  renderSizeOptions(data.sizes || [], current);
}

function schedulePopularSizeSearch() {
  if (sizeSearchTimer) {
    window.clearTimeout(sizeSearchTimer);
  }

  sizeSearchTimer = window.setTimeout(async () => {
    try {
      await loadPopularSizes(createSizeQueryEl.value);
    } catch (err) {
      setStatus(`经典型号加载失败: ${err.message}`, 'error');
    }
  }, SIZE_SEARCH_DEBOUNCE_MS);
}

function renderCredits(credits, options = {}) {
  const { error = null, initial = false } = options;

  if (initial) {
    statCredits.textContent = '--';
    statCreditsSub.textContent = '';
    statCreditsSub.hidden = true;
    statCreditsMeta.textContent = '每 15 秒自动刷新';
    statCreditsMeta.classList.remove('error');
    return;
  }

  if (error) {
    statCredits.textContent = '--';
    statCreditsSub.textContent = '';
    statCreditsSub.hidden = true;
    statCreditsMeta.textContent = `Available Credits 加载失败: ${error}`;
    statCreditsMeta.classList.add('error');
    return;
  }

  const availableCredits = Number(credits?.availableCredits);
  if (!Number.isFinite(availableCredits)) {
    statCredits.textContent = '--';
    statCreditsSub.textContent = '';
    statCreditsSub.hidden = true;
    statCreditsMeta.textContent = 'DigitalOcean 当前未返回可解析的 credits 数据';
    statCreditsMeta.classList.add('error');
    return;
  }

  statCredits.textContent = formatUsd(availableCredits);
  statCreditsSub.textContent = '';
  statCreditsSub.hidden = true;
  statCreditsMeta.textContent = `更新于 ${formatDateTime(credits?.generatedAt)} · 每 15 秒自动刷新`;
  statCreditsMeta.classList.remove('error');
}

function renderStats(droplets) {
  const total = droplets.length;
  const active = droplets.filter((d) => String(d.status || '').toLowerCase() === 'active').length;
  const inactive = total - active;

  statTotal.textContent = String(total);
  statActive.textContent = String(active);
  statInactive.textContent = String(inactive);
}

function statusPill(status) {
  const text = escapeHtml(status || '-');
  const active = String(status || '').toLowerCase() === 'active';
  return `<span class="status-pill${active ? ' active' : ''}">${text}</span>`;
}

function collectTags(droplets) {
  const tagSet = new Set();
  for (const droplet of droplets) {
    const tags = Array.isArray(droplet.tags) ? droplet.tags : [];
    for (const tag of tags) {
      if (tag) tagSet.add(String(tag));
    }
  }
  return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
}

function getSelectedTag() {
  return tagFilterEl.value || ALL_TAG_FILTER;
}

function filterBySelectedTag(droplets) {
  const selectedTag = getSelectedTag();
  if (selectedTag === ALL_TAG_FILTER) {
    return droplets;
  }
  return droplets.filter((d) => Array.isArray(d.tags) && d.tags.includes(selectedTag));
}

function renderTagFilter(tags) {
  const current = getSelectedTag();
  const options = [
    `<option value="${ALL_TAG_FILTER}">全部标签</option>`,
    ...tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`),
  ];
  tagFilterEl.innerHTML = options.join('');

  if (current === ALL_TAG_FILTER || tags.includes(current)) {
    tagFilterEl.value = current;
  } else {
    tagFilterEl.value = ALL_TAG_FILTER;
  }
}

function updateDeleteByTagButton(filteredCount) {
  const selectedTag = getSelectedTag();
  const disabled = selectedTag === ALL_TAG_FILTER || filteredCount === 0;
  deleteByTagBtn.disabled = disabled;

  if (selectedTag === ALL_TAG_FILTER) {
    deleteByTagBtn.textContent = '删除当前标签机器';
    return;
  }

  deleteByTagBtn.textContent = `删除标签(${filteredCount})`;
}

function renderCurrentList() {
  const filteredDroplets = filterBySelectedTag(allDroplets);
  renderRows(filteredDroplets);
  updateDeleteByTagButton(filteredDroplets.length);
  return filteredDroplets;
}

function renderRows(droplets) {
  renderStats(droplets);

  if (!droplets.length) {
    tableBody.innerHTML = '<tr><td colspan="9">暂无机器</td></tr>';
    return;
  }

  tableBody.innerHTML = droplets
    .map((d) => {
      return `
      <tr>
        <td>${d.id}</td>
        <td>
          <input data-rename-id="${d.id}" value="${escapeHtml(d.name || '')}" />
        </td>
        <td>${statusPill(d.status)}</td>
        <td>${escapeHtml(d.publicIp || '-')}</td>
        <td>${escapeHtml(d.region || '-')}</td>
        <td>${escapeHtml(d.size || '-')}</td>
        <td>${escapeHtml(d.image || '-')}</td>
        <td>
          <input data-tags-id="${d.id}" value="${escapeHtml((Array.isArray(d.tags) ? d.tags : []).join(', '))}" />
        </td>
        <td class="actions">
          <button data-action="rename" data-id="${d.id}" class="btn btn-secondary">重命名</button>
          <button data-action="tags" data-id="${d.id}" class="btn btn-secondary">保存标签</button>
          <button data-action="rebuild" data-id="${d.id}" class="btn btn-warning">重装系统</button>
          <button data-action="delete" data-id="${d.id}" class="danger btn">删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadDroplets() {
  try {
    setStatus('加载中...', 'loading');
    const data = await fetchJson('/api/droplets');
    allDroplets = data.droplets || [];
    renderTagFilter(collectTags(allDroplets));
    const filteredDroplets = renderCurrentList();
    const selectedTag = getSelectedTag();

    if (selectedTag === ALL_TAG_FILTER) {
      setStatus(`已加载 ${allDroplets.length} 台机器`);
    } else {
      setStatus(`已加载 ${allDroplets.length} 台机器，标签 ${selectedTag} 下 ${filteredDroplets.length} 台`);
    }
  } catch (err) {
    setStatus(`加载失败: ${err.message}`, 'error');
  }
}

async function loadCredits(options = {}) {
  const { silent = false } = options;

  if (creditsLoading) {
    return;
  }

  creditsLoading = true;
  if (!silent) {
    statCreditsMeta.textContent = 'Available Credits 加载中...';
    statCreditsMeta.classList.remove('error');
  }

  try {
    const data = await fetchJson('/api/credits');
    renderCredits(data.credits || {});
  } catch (err) {
    renderCredits(null, { error: err.message });
  } finally {
    creditsLoading = false;
  }
}

async function refreshAll() {
  await Promise.all([
    loadDroplets(),
    loadCredits(),
  ]);
}

function startCreditsPolling() {
  if (creditsPollTimer) {
    window.clearInterval(creditsPollTimer);
  }

  creditsPollTimer = window.setInterval(() => {
    loadCredits({ silent: true });
  }, CREDITS_POLL_MS);
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const region = createRegionEl.value.trim();
  const name = document.getElementById('createName').value.trim();
  const tags = parseTagsInput(document.getElementById('createTags').value);
  const size = createSizeEl.value.trim();

  if (!name) {
    setStatus('创建失败: 名称不能为空', 'error');
    return;
  }

  if (!size) {
    setStatus('创建失败: 请选择一个型号', 'error');
    return;
  }

  try {
    setStatus('创建中...', 'loading');
    await fetchJson('/api/droplets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region,
        name,
        size,
        ...(tags.length > 0 ? { tags } : {}),
      }),
    });

    createForm.reset();
    createSizeQueryEl.value = '';
    await loadPopularSizes();
    setStatus('创建请求已提交');
    await loadDroplets();
  } catch (err) {
    setStatus(`创建失败: ${err.message}`, 'error');
  }
});

refreshBtn.addEventListener('click', () => {
  refreshAll();
});

tagFilterEl.addEventListener('change', () => {
  const filteredDroplets = renderCurrentList();
  const selectedTag = getSelectedTag();
  if (selectedTag === ALL_TAG_FILTER) {
    setStatus(`已显示全部机器，共 ${filteredDroplets.length} 台`);
    return;
  }
  setStatus(`已筛选标签 ${selectedTag}，共 ${filteredDroplets.length} 台`);
});

createSizeQueryEl.addEventListener('input', () => {
  schedulePopularSizeSearch();
});

createRegionEl.addEventListener('change', () => {
  loadPopularSizes(createSizeQueryEl.value).catch((err) => {
    setStatus(`经典型号加载失败: ${err.message}`, 'error');
  });
});

deleteByTagBtn.addEventListener('click', async () => {
  const selectedTag = getSelectedTag();
  const filteredDroplets = filterBySelectedTag(allDroplets);

  if (selectedTag === ALL_TAG_FILTER) {
    setStatus('请先选择一个标签', 'error');
    return;
  }

  if (!filteredDroplets.length) {
    setStatus(`标签 ${selectedTag} 下没有机器`, 'error');
    return;
  }

  const ok = window.confirm(`确认删除标签 ${selectedTag} 下的 ${filteredDroplets.length} 台机器？此操作不可恢复。`);
  if (!ok) return;

  try {
    setStatus(`批量删除中: 标签 ${selectedTag} ...`, 'loading');
    const result = await fetchJson(`/api/droplets/by-tag/${encodeURIComponent(selectedTag)}`, {
      method: 'DELETE',
    });

    const deleted = Number(result.deleted || 0);
    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    if (failed > 0) {
      setStatus(`批量删除完成: 成功 ${deleted} 台，失败 ${failed} 台`, 'error');
    } else {
      setStatus(`批量删除完成: 已删除 ${deleted} 台`);
    }
    await loadDroplets();
  } catch (err) {
    setStatus(`批量删除失败: ${err.message}`, 'error');
  }
});

tableBody.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const action = target.getAttribute('data-action');
  const id = target.getAttribute('data-id');
  if (!action || !id) return;

  if (action === 'delete') {
    const ok = window.confirm(`确认删除机器 ${id}？`);
    if (!ok) return;

    try {
      setStatus(`删除中: ${id} ...`, 'loading');
      await fetchJson(`/api/droplets/${id}`, { method: 'DELETE' });
      setStatus(`已删除 ${id}`);
      await loadDroplets();
    } catch (err) {
      setStatus(`删除失败: ${err.message}`, 'error');
    }
    return;
  }

  if (action === 'rename') {
    const input = document.querySelector(`input[data-rename-id="${id}"]`);
    const newName = input ? input.value.trim() : '';
    if (!newName) {
      setStatus('重命名失败: 名称不能为空', 'error');
      return;
    }

    try {
      setStatus(`重命名中: ${id} ...`, 'loading');
      await fetchJson(`/api/droplets/${id}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      setStatus(`重命名请求已提交: ${id} -> ${newName}`);
      await loadDroplets();
    } catch (err) {
      setStatus(`重命名失败: ${err.message}`, 'error');
    }
    return;
  }

  if (action === 'tags') {
    const input = document.querySelector(`input[data-tags-id="${id}"]`);
    const tags = parseTagsInput(input ? input.value : '');

    try {
      setStatus(`保存标签中: ${id} ...`, 'loading');
      await fetchJson(`/api/droplets/${id}/tags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      });
      setStatus(`标签已更新: ${id}`);
      await loadDroplets();
    } catch (err) {
      setStatus(`标签更新失败: ${err.message}`, 'error');
    }
    return;
  }

  if (action === 'rebuild') {
    const ok = window.confirm(`确认重装机器 ${id}？系统盘数据将被清空。`);
    if (!ok) return;

    try {
      setStatus(`重装中: ${id} ...`, 'loading');
      await fetchJson(`/api/droplets/${id}/rebuild`, {
        method: 'POST',
      });
      setStatus(`重装请求已提交: ${id}`);
      await loadDroplets();
    } catch (err) {
      setStatus(`重装失败: ${err.message}`, 'error');
    }
    return;
  }
});

renderTagFilter([]);
updateDeleteByTagButton(0);
renderCredits(null, { initial: true });
loadPopularSizes().catch((err) => {
  setStatus(`经典型号加载失败: ${err.message}`, 'error');
});
refreshAll();
startCreditsPolling();
