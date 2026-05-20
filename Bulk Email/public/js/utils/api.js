// API client utility
async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error(res.ok ? 'Invalid server response' : `Server error (${res.status})`); }
}

const API = {
  async get(url) {
    const res = await fetch(url);
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  async post(url, data) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  },
  async put(url, data) {
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE' });
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  },
  async upload(url, formData) {
    const res = await fetch(url, { method: 'POST', body: formData });
    const json = await safeJson(res);
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }
};

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(40px)'; setTimeout(() => toast.remove(), 300); }, 3500);
}

function openModal(title, bodyHtml) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalOverlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
