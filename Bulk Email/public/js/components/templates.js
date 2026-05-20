const TemplatesComponent = {
  async render() {
    const area = document.getElementById('contentArea');
    try {
      const templates = await API.get('/api/templates');
      area.innerHTML = `
        <div class="section-header">
          <h2 class="section-title">Email Templates</h2>
          <button class="btn btn-primary" onclick="TemplatesComponent.showEditor()" id="btn-new-template">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Template
          </button>
        </div>
        ${templates.length === 0 ? `
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <h3>No templates yet</h3>
            <p>Create your first email template with personalization variables</p>
            <button class="btn btn-primary" onclick="TemplatesComponent.showEditor()">Create Template</button>
          </div>
        ` : `
          <div class="grid-2">
            ${templates.map(t => {
              const vars = JSON.parse(t.variables || '[]');
              return `
                <div class="template-card" onclick="TemplatesComponent.showEditor(${t.id})" id="template-${t.id}">
                  <div class="template-name">${escapeHtml(t.name)}</div>
                  <div class="template-subject">Subject: ${escapeHtml(t.subject)}</div>
                  ${vars.length ? `<div class="var-chips">${vars.map(v => `<span class="var-chip">{{${v}}}</span>`).join('')}</div>` : ''}
                  <div class="template-meta">
                    <span>Updated ${formatDate(t.updated_at)}</span>
                  </div>
                </div>`;
            }).join('')}
          </div>
        `}
      `;
    } catch (err) { area.innerHTML = `<div class="card"><p class="text-muted">Error: ${err.message}</p></div>`; }
  },

  async showEditor(id) {
    let template = { name: '', subject: '', body_html: '', body_text: '' };
    if (id) {
      try { template = await API.get(`/api/templates/${id}`); } catch(e) {}
    }

    const availableVars = ['firstName', 'lastName', 'email', 'channelName', 'channelUrl', 'subscriberCount', 'niche', 'country', 'language'];

    openModal(id ? 'Edit Template' : 'New Template', `
      <div class="form-group">
        <label class="form-label">Template Name</label>
        <input class="form-input" id="tpl-name" value="${escapeHtml(template.name)}" placeholder="e.g. YouTuber Collaboration Pitch" />
      </div>
      <div class="form-group">
        <label class="form-label">Subject Line</label>
        <input class="form-input" id="tpl-subject" value="${escapeHtml(template.subject)}" placeholder="e.g. Hey {{firstName}}, let's collaborate!" />
        <div class="form-hint">Use {{variable}} for personalization</div>
      </div>
      <div class="form-group">
        <label class="form-label">Available Variables</label>
        <div class="var-chips">
          ${availableVars.map(v => `<span class="var-chip" onclick="TemplatesComponent.insertVar('${v}')">{{${v}}}</span>`).join('')}
        </div>
        <div class="form-hint">Click to insert into body. You can also use custom fields from your contacts.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Email Body (HTML)</label>
        <textarea class="form-textarea" id="tpl-body" rows="12" placeholder="Write your email here. Use {{firstName}}, {{channelName}}, etc.">${template.body_html || ''}</textarea>
        <div class="form-hint">Supports HTML. Use {{#if variable}}content{{/if}} for conditional blocks.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Plain Text Version (optional)</label>
        <textarea class="form-textarea" id="tpl-text" rows="4" placeholder="Plain text fallback...">${template.body_text || ''}</textarea>
      </div>
      <div class="btn-group mt-4">
        <button class="btn btn-primary" onclick="TemplatesComponent.save(${id || 'null'})" id="btn-save-template">Save Template</button>
        ${id ? `<button class="btn btn-danger" onclick="TemplatesComponent.remove(${id})" id="btn-delete-template">Delete</button>` : ''}
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      </div>
    `);
  },

  insertVar(varName) {
    const body = document.getElementById('tpl-body');
    if (body) {
      const pos = body.selectionStart;
      const text = body.value;
      body.value = text.slice(0, pos) + `{{${varName}}}` + text.slice(pos);
      body.focus();
      body.selectionStart = body.selectionEnd = pos + varName.length + 4;
    }
  },

  async save(id) {
    const data = {
      name: document.getElementById('tpl-name').value.trim(),
      subject: document.getElementById('tpl-subject').value.trim(),
      body_html: document.getElementById('tpl-body').value,
      body_text: document.getElementById('tpl-text').value
    };
    if (!data.name || !data.subject || !data.body_html) { showToast('Name, subject, and body are required', 'error'); return; }
    try {
      if (id) { await API.put(`/api/templates/${id}`, data); }
      else { await API.post('/api/templates', data); }
      closeModal();
      showToast('Template saved!', 'success');
      this.render();
    } catch (err) { showToast(err.message, 'error'); }
  },

  async remove(id) {
    if (!confirm('Delete this template?')) return;
    try {
      await API.del(`/api/templates/${id}`);
      closeModal();
      showToast('Template deleted', 'success');
      this.render();
    } catch (err) { showToast(err.message, 'error'); }
  }
};
