const DashboardComponent = {
  async render() {
    const area = document.getElementById('contentArea');
    try {
      const [accounts, templates, contacts, campaigns] = await Promise.all([
        API.get('/auth/accounts'),
        API.get('/api/templates'),
        API.get('/api/contacts'),
        API.get('/api/campaigns')
      ]);

      const totalSent = campaigns.reduce((s, c) => s + (c.sent_count || 0), 0);
      const totalOpened = campaigns.reduce((s, c) => s + (c.opened_count || 0), 0);
      const totalClicked = campaigns.reduce((s, c) => s + (c.clicked_count || 0), 0);

      area.innerHTML = `
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Connected Accounts</div>
            <div class="stat-value">${accounts.length}</div>
            <div class="stat-sub">Gmail accounts linked</div>
          </div>
          <div class="stat-card green">
            <div class="stat-label">Emails Sent</div>
            <div class="stat-value">${totalSent.toLocaleString()}</div>
            <div class="stat-sub">Across all campaigns</div>
          </div>
          <div class="stat-card amber">
            <div class="stat-label">Open Rate</div>
            <div class="stat-value">${totalSent ? Math.round((totalOpened / totalSent) * 100) : 0}%</div>
            <div class="stat-sub">${totalOpened} opened</div>
          </div>
          <div class="stat-card red">
            <div class="stat-label">Click Rate</div>
            <div class="stat-value">${totalSent ? Math.round((totalClicked / totalSent) * 100) : 0}%</div>
            <div class="stat-sub">${totalClicked} clicked</div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="card-header">
              <h3 class="card-title">Quick Actions</h3>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${accounts.length === 0 ? '<a href="#/accounts" class="btn btn-primary" id="qa-connect">Connect Gmail Account</a>' : ''}
              <a href="#/templates" class="btn btn-secondary" id="qa-template">Create Email Template</a>
              <a href="#/contacts" class="btn btn-secondary" id="qa-contacts">Import Contacts</a>
              <a href="#/campaigns" class="btn btn-secondary" id="qa-campaign">Start Campaign</a>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <h3 class="card-title">Recent Campaigns</h3>
            </div>
            ${campaigns.length === 0 ? '<p class="text-muted text-sm">No campaigns yet. Create your first one!</p>' : `
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${campaigns.slice(0, 5).map(c => `
                  <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--slate-100);">
                    <div>
                      <div style="font-weight:600;font-size:.9rem;">${escapeHtml(c.name)}</div>
                      <div class="text-sm text-muted">${c.sender_email || 'N/A'} · ${c.total_emails} emails</div>
                    </div>
                    <span class="badge badge-${c.status === 'completed' ? 'green' : c.status === 'sending' ? 'blue' : c.status === 'failed' ? 'red' : 'slate'}">${c.status}</span>
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        </div>

        <div class="card mt-6">
          <div class="card-header">
            <h3 class="card-title">Overview</h3>
          </div>
          <div class="form-row-3">
            <div class="text-center">
              <div style="font-size:2rem;font-weight:800;color:var(--blue-600);">${templates.length}</div>
              <div class="text-sm text-muted">Templates</div>
            </div>
            <div class="text-center">
              <div style="font-size:2rem;font-weight:800;color:var(--blue-600);">${contacts.length}</div>
              <div class="text-sm text-muted">Contacts</div>
            </div>
            <div class="text-center">
              <div style="font-size:2rem;font-weight:800;color:var(--blue-600);">${campaigns.length}</div>
              <div class="text-sm text-muted">Campaigns</div>
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      area.innerHTML = `<div class="card"><p class="text-muted">Failed to load dashboard: ${err.message}</p></div>`;
    }
  }
};
