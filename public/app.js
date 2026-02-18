const createForm = document.getElementById('createForm');
const tableBody = document.getElementById('dropletTableBody');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const statTotal = document.getElementById('statTotal');
const statActive = document.getElementById('statActive');
const statInactive = document.getElementById('statInactive');

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

function renderRows(droplets) {
  renderStats(droplets);

  if (!droplets.length) {
    tableBody.innerHTML = '<tr><td colspan="8">暂无机器</td></tr>';
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
        <td class="actions">
          <button data-action="rename" data-id="${d.id}" class="btn btn-secondary">重命名</button>
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
    const droplets = data.droplets || [];
    renderRows(droplets);
    setStatus(`已加载 ${droplets.length} 台机器`);
  } catch (err) {
    setStatus(`加载失败: ${err.message}`, 'error');
  }
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const name = document.getElementById('createName').value.trim();
  const region = document.getElementById('createRegion').value.trim();
  const size = document.getElementById('createSize').value.trim();
  const image = document.getElementById('createImage').value.trim();

  if (!name) {
    setStatus('创建失败: 名称不能为空', 'error');
    return;
  }

  try {
    setStatus('创建中...', 'loading');
    await fetchJson('/api/droplets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        ...(region ? { region } : {}),
        ...(size ? { size } : {}),
        ...(image ? { image } : {}),
      }),
    });

    createForm.reset();
    setStatus('创建请求已提交');
    await loadDroplets();
  } catch (err) {
    setStatus(`创建失败: ${err.message}`, 'error');
  }
});

refreshBtn.addEventListener('click', () => {
  loadDroplets();
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

  if (action === 'rebuild') {
    const ok = window.confirm(`确认重装机器 ${id}？系统盘数据将被清空。`);
    if (!ok) return;

    const image = window.prompt('输入镜像 slug（可留空默认 Ubuntu）', '');

    try {
      setStatus(`重装中: ${id} ...`, 'loading');
      await fetchJson(`/api/droplets/${id}/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(image && image.trim() ? { image: image.trim() } : {}),
      });
      setStatus(`重装请求已提交: ${id}`);
      await loadDroplets();
    } catch (err) {
      setStatus(`重装失败: ${err.message}`, 'error');
    }
  }
});

loadDroplets();
