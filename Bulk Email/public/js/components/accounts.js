const AccountsComponent = {
  async render() {
    const area = document.getElementById('contentArea');
    try {
      const [accounts, authMode] = await Promise.all([
        API.get('/auth/accounts'),
        API.get('/auth/mode')
      ]);

      area.innerHTML = `
        <div class="section-header">
          <div>
            <h2 class="section-title">Connected Gmail Accounts</h2>
            <p class="text-sm text-muted mt-2">Connect your Gmail to send emails through your personal account</p>
          </div>
        </div>

        <!-- Simple Setup: App Password -->
        <div class="card mt-4" style="border: 2px solid var(--blue-300); background: linear-gradient(135deg, var(--blue-50), var(--white));">
          <div class="card-header">
            <h3 class="card-title" style="color: var(--blue-700);">⚡ Quick Setup (Recommended)</h3>
            <span class="badge badge-green">Easy</span>
          </div>
          <p class="text-sm text-muted mb-4">Connect your Gmail using an App Password — no Google Cloud setup needed!</p>
          
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Gmail Address</label>
              <input class="form-input" id="app-email" type="email" placeholder="your.email@gmail.com" />
            </div>
            <div class="form-group">
              <label class="form-label">App Password</label>
              <input class="form-input" id="app-password" type="password" placeholder="xxxx xxxx xxxx xxxx" />
            </div>
          </div>
          <div class="flex items-center gap-4">
            <button class="btn btn-primary" onclick="AccountsComponent.connectAppPassword()" id="btn-connect-app-pw">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              Connect Account
            </button>
            <a href="https://myaccount.google.com/apppasswords" target="_blank" class="btn btn-secondary btn-sm">
              Get App Password →
            </a>
          </div>
          
          <div class="mt-4" style="background:var(--white);border:1px solid var(--slate-200);border-radius:var(--radius-sm);padding:16px;">
            <h4 style="font-size:.85rem;color:var(--slate-700);margin-bottom:8px;">📋 How to get an App Password:</h4>
            <ol style="font-size:.82rem;color:var(--slate-600);padding-left:20px;line-height:1.8;">
              <li>Go to <a href="https://myaccount.google.com/security" target="_blank" style="color:var(--blue-600);font-weight:600;">Google Account Security</a></li>
              <li>Enable <strong>2-Step Verification</strong> if not already on</li>
              <li>Go to <a href="https://myaccount.google.com/apppasswords" target="_blank" style="color:var(--blue-600);font-weight:600;">App Passwords</a></li>
              <li>Create a new app password (name it "MailBlast")</li>
              <li>Copy the 16-character password and paste it above</li>
            </ol>
          </div>
        </div>

        ${authMode.oauth_configured ? `
        <!-- OAuth2 Setup -->
        <div class="card mt-4">
          <div class="card-header">
            <h3 class="card-title">🔐 OAuth2 Setup (Advanced)</h3>
            <span class="badge badge-blue">Configured</span>
          </div>
          <p class="text-sm text-muted mb-4">Connect via Google OAuth2 for token-based authentication.</p>
          <a href="/auth/google" class="btn btn-google" id="btn-connect-oauth">
            <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/><path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/><path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/><path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"/></svg>
            Connect with Google
          </a>
        </div>` : ''}

        <!-- Connected Accounts -->
        <h3 class="section-title mt-6 mb-4">Connected Accounts (${accounts.length})</h3>
        ${accounts.length === 0 ? `
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            <h3>No accounts connected</h3>
            <p>Use the Quick Setup above to connect your Gmail</p>
          </div>
        ` : `
          <div class="grid-2">
            ${accounts.map(a => `
              <div class="account-card" id="account-${a.id}">
                ${a.picture_url ? `<img class="account-avatar" src="${a.picture_url}" alt="" />` :
                  `<div class="account-avatar-placeholder">${(a.display_name || a.email)[0].toUpperCase()}</div>`}
                <div class="account-info">
                  <div class="account-name">${escapeHtml(a.display_name || 'Gmail Account')}</div>
                  <div class="account-email">${escapeHtml(a.email)}</div>
                  <div class="text-sm text-muted">Connected ${formatDate(a.created_at)}</div>
                </div>
                <button class="btn btn-sm btn-danger" onclick="AccountsComponent.disconnect(${a.id})" id="disconnect-${a.id}">Disconnect</button>
              </div>
            `).join('')}
          </div>
        `}
      `;
    } catch (err) {
      area.innerHTML = `<div class="card"><p class="text-muted">Error: ${err.message}</p></div>`;
    }
  },

  async connectAppPassword() {
    const email = document.getElementById('app-email').value.trim();
    const password = document.getElementById('app-password').value.trim();
    if (!email || !password) { showToast('Enter both email and app password', 'error'); return; }
    if (!email.includes('@')) { showToast('Enter a valid email address', 'error'); return; }

    try {
      await API.post('/auth/add-account', { email, app_password: password });
      showToast('Gmail connected successfully!', 'success');
      document.getElementById('app-email').value = '';
      document.getElementById('app-password').value = '';
      this.render();
    } catch (err) { showToast(err.message, 'error'); }
  },

  async disconnect(id) {
    if (!confirm('Disconnect this Gmail account?')) return;
    try {
      await API.del(`/auth/accounts/${id}`);
      showToast('Account disconnected', 'success');
      this.render();
    } catch (err) { showToast(err.message, 'error'); }
  }
};
