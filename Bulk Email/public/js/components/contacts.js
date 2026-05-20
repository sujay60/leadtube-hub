const ContactsComponent = {
  currentTab: 'contacts',

  async render() {
    const area = document.getElementById('contentArea');
    area.innerHTML = `
      <div class="section-header">
        <h2 class="section-title">Contacts</h2>
        <div class="btn-group">
          <button class="btn btn-secondary" onclick="ContactsComponent.showImportModal()" id="btn-import-csv">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Import CSV
          </button>
          <button class="btn btn-primary" onclick="ContactsComponent.showContactForm()" id="btn-add-contact">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Contact
          </button>
        </div>
      </div>
      <div class="tab-bar">
        <div class="tab ${this.currentTab==='contacts'?'active':''}" onclick="ContactsComponent.switchTab('contacts')">All Contacts</div>
        <div class="tab ${this.currentTab==='groups'?'active':''}" onclick="ContactsComponent.switchTab('groups')">Groups</div>
        <div class="tab ${this.currentTab==='fields'?'active':''}" onclick="ContactsComponent.switchTab('fields')">Custom Fields</div>
      </div>
      <div id="contactsTabContent"></div>
    `;
    this.renderTab();
  },

  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['contacts','groups','fields'][i] === tab));
    this.renderTab();
  },

  async renderTab() {
    if (this.currentTab === 'contacts') await this.renderContacts();
    else if (this.currentTab === 'groups') await this.renderGroups();
    else await this.renderFields();
  },

  async renderContacts() {
    const el = document.getElementById('contactsTabContent');
    try {
      const contacts = await API.get('/api/contacts');
      if (!contacts.length) {
        el.innerHTML = `<div class="empty-state"><h3>No contacts yet</h3><p>Add contacts manually or import from CSV</p></div>`;
        return;
      }
      el.innerHTML = `
        <div class="flex items-center justify-between mb-4">
          <div class="search-bar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input placeholder="Search contacts..." id="contact-search" oninput="ContactsComponent.searchContacts(this.value)" />
          </div>
          <span class="text-sm text-muted">${contacts.length} contacts</span>
        </div>
        <div class="table-container">
          <table id="contacts-table">
            <thead><tr>
              <th>Name</th><th>Email</th><th>Channel</th><th>Subscribers</th><th>Niche</th><th>Group</th><th></th>
            </tr></thead>
            <tbody>
              ${contacts.map(c => `<tr id="contact-row-${c.id}">
                <td><strong>${escapeHtml(c.first_name||'')} ${escapeHtml(c.last_name||'')}</strong></td>
                <td>${escapeHtml(c.email)}</td>
                <td>${c.channel_name ? `<a href="${escapeHtml(c.channel_url||'#')}" target="_blank" style="color:var(--blue-600)">${escapeHtml(c.channel_name)}</a>` : '—'}</td>
                <td>${c.subscriber_count||'—'}</td>
                <td>${c.niche ? `<span class="badge badge-blue">${escapeHtml(c.niche)}</span>` : '—'}</td>
                <td>${c.group_name ? `<span class="badge badge-slate">${escapeHtml(c.group_name)}</span>` : '—'}</td>
                <td>
                  <div class="btn-group">
                    <button class="btn-icon" onclick="ContactsComponent.showContactForm(${c.id})" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                    <button class="btn-icon" onclick="ContactsComponent.deleteContact(${c.id})" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                  </div>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch(err) { el.innerHTML = `<p class="text-muted">Error: ${err.message}</p>`; }
  },

  async renderGroups() {
    const el = document.getElementById('contactsTabContent');
    try {
      const groups = await API.get('/api/contacts/groups');
      el.innerHTML = `
        <div class="flex justify-between items-center mb-4">
          <span></span>
          <button class="btn btn-primary btn-sm" onclick="ContactsComponent.showGroupForm()">+ New Group</button>
        </div>
        ${!groups.length ? '<div class="empty-state"><h3>No groups</h3><p>Create groups to organize your contacts</p></div>' : `
        <div class="grid-3">
          ${groups.map(g => `
            <div class="card" id="group-${g.id}">
              <div class="flex justify-between items-center">
                <h3 class="card-title">${escapeHtml(g.name)}</h3>
                <button class="btn-icon" onclick="ContactsComponent.deleteGroup(${g.id})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
              </div>
              <p class="text-sm text-muted mt-2">${g.description||'No description'}</p>
              <div class="mt-4" style="font-size:1.5rem;font-weight:800;color:var(--blue-600);">${g.contact_count}</div>
              <div class="text-sm text-muted">contacts</div>
            </div>
          `).join('')}
        </div>`}`;
    } catch(err) { el.innerHTML = `<p class="text-muted">Error: ${err.message}</p>`; }
  },

  async renderFields() {
    const el = document.getElementById('contactsTabContent');
    try {
      const fields = await API.get('/api/contacts/fields');
      el.innerHTML = `
        <div class="flex justify-between items-center mb-4">
          <p class="text-sm text-muted">Custom fields are available as template variables using <code>{{field_name}}</code></p>
          <button class="btn btn-primary btn-sm" onclick="ContactsComponent.showFieldForm()">+ Add Field</button>
        </div>
        <div class="table-container">
          <table><thead><tr><th>Field Name</th><th>Label</th><th>Type</th><th>Variable</th><th></th></tr></thead>
          <tbody>
            ${fields.map(f => `<tr>
              <td><strong>${escapeHtml(f.field_name)}</strong></td>
              <td>${escapeHtml(f.field_label)}</td>
              <td><span class="badge badge-slate">${f.field_type}</span></td>
              <td><span class="var-chip">{{${f.field_name}}}</span></td>
              <td><button class="btn-icon" onclick="ContactsComponent.deleteField(${f.id})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></td>
            </tr>`).join('')}
          </tbody></table>
        </div>`;
    } catch(err) { el.innerHTML = `<p class="text-muted">Error: ${err.message}</p>`; }
  },

  searchContacts(query) {
    const rows = document.querySelectorAll('#contacts-table tbody tr');
    rows.forEach(row => { row.style.display = row.textContent.toLowerCase().includes(query.toLowerCase()) ? '' : 'none'; });
  },

  async showContactForm(id) {
    let contact = { email:'', first_name:'', last_name:'', channel_name:'', channel_url:'', subscriber_count:'', niche:'', country:'', language:'English', custom_fields:'{}' };
    if (id) { try { contact = await API.get(`/api/contacts/${id}`); } catch(e) {} }
    const groups = await API.get('/api/contacts/groups');
    const fields = await API.get('/api/contacts/fields');
    let cf = {};
    try { cf = typeof contact.custom_fields === 'string' ? JSON.parse(contact.custom_fields) : (contact.custom_fields||{}); } catch(e){}

    openModal(id ? 'Edit Contact' : 'Add Contact', `
      <div class="form-row">
        <div class="form-group"><label class="form-label">First Name</label><input class="form-input" id="c-fn" value="${escapeHtml(contact.first_name||'')}" /></div>
        <div class="form-group"><label class="form-label">Last Name</label><input class="form-input" id="c-ln" value="${escapeHtml(contact.last_name||'')}" /></div>
      </div>
      <div class="form-group"><label class="form-label">Email *</label><input class="form-input" id="c-email" type="email" value="${escapeHtml(contact.email)}" /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Channel Name</label><input class="form-input" id="c-cn" value="${escapeHtml(contact.channel_name||'')}" placeholder="e.g. MrBeast" /></div>
        <div class="form-group"><label class="form-label">Channel URL</label><input class="form-input" id="c-cu" value="${escapeHtml(contact.channel_url||'')}" placeholder="https://youtube.com/@..." /></div>
      </div>
      <div class="form-row-3">
        <div class="form-group"><label class="form-label">Subscribers</label><input class="form-input" id="c-sc" value="${escapeHtml(contact.subscriber_count||'')}" placeholder="e.g. 1.2M" /></div>
        <div class="form-group"><label class="form-label">Niche</label><input class="form-input" id="c-niche" value="${escapeHtml(contact.niche||'')}" placeholder="e.g. Gaming" /></div>
        <div class="form-group"><label class="form-label">Country</label><input class="form-input" id="c-country" value="${escapeHtml(contact.country||'')}" /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Language</label><input class="form-input" id="c-lang" value="${escapeHtml(contact.language||'English')}" /></div>
        <div class="form-group"><label class="form-label">Group</label><select class="form-select" id="c-group">
          <option value="">No group</option>
          ${groups.map(g => `<option value="${g.id}" ${contact.group_id==g.id?'selected':''}>${escapeHtml(g.name)}</option>`).join('')}
        </select></div>
      </div>
      ${fields.length ? `<h4 style="margin:16px 0 8px;font-size:.9rem;">Custom Fields</h4>
        ${fields.map(f => `<div class="form-group"><label class="form-label">${escapeHtml(f.field_label)}</label><input class="form-input cf-input" data-field="${f.field_name}" value="${escapeHtml(cf[f.field_name]||'')}" /></div>`).join('')}` : ''}
      <div class="btn-group mt-4">
        <button class="btn btn-primary" onclick="ContactsComponent.saveContact(${id||'null'})">Save</button>
        ${id ? `<button class="btn btn-danger" onclick="ContactsComponent.deleteContact(${id});closeModal()">Delete</button>` : ''}
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      </div>
    `);
  },

  async saveContact(id) {
    const cf = {};
    document.querySelectorAll('.cf-input').forEach(i => { if (i.value) cf[i.dataset.field] = i.value; });
    const data = {
      email: document.getElementById('c-email').value.trim(),
      first_name: document.getElementById('c-fn').value.trim(),
      last_name: document.getElementById('c-ln').value.trim(),
      channel_name: document.getElementById('c-cn').value.trim(),
      channel_url: document.getElementById('c-cu').value.trim(),
      subscriber_count: document.getElementById('c-sc').value.trim(),
      niche: document.getElementById('c-niche').value.trim(),
      country: document.getElementById('c-country').value.trim(),
      language: document.getElementById('c-lang').value.trim(),
      group_id: document.getElementById('c-group').value || null,
      custom_fields: cf
    };
    if (!data.email) { showToast('Email is required', 'error'); return; }
    try {
      if (id) await API.put(`/api/contacts/${id}`, data); else await API.post('/api/contacts', data);
      closeModal(); showToast('Contact saved!', 'success'); this.render();
    } catch(e) { showToast(e.message, 'error'); }
  },

  async deleteContact(id) {
    if (!confirm('Delete this contact?')) return;
    try { await API.del(`/api/contacts/${id}`); showToast('Deleted', 'success'); this.render(); } catch(e) { showToast(e.message, 'error'); }
  },

  showGroupForm() {
    openModal('New Group', `
      <div class="form-group"><label class="form-label">Group Name</label><input class="form-input" id="g-name" placeholder="e.g. Tech YouTubers" /></div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="g-desc" rows="3"></textarea></div>
      <div class="btn-group mt-4">
        <button class="btn btn-primary" onclick="ContactsComponent.saveGroup()">Create Group</button>
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      </div>
    `);
  },

  async saveGroup() {
    const name = document.getElementById('g-name').value.trim();
    if (!name) { showToast('Name required', 'error'); return; }
    try { await API.post('/api/contacts/groups', { name, description: document.getElementById('g-desc').value }); closeModal(); showToast('Group created!', 'success'); this.render(); } catch(e) { showToast(e.message, 'error'); }
  },

  async deleteGroup(id) {
    if (!confirm('Delete this group? Contacts will be unassigned.')) return;
    try { await API.del(`/api/contacts/groups/${id}`); showToast('Deleted', 'success'); this.render(); } catch(e) { showToast(e.message, 'error'); }
  },

  showFieldForm() {
    openModal('Add Custom Field', `
      <div class="form-group"><label class="form-label">Field Label</label><input class="form-input" id="f-label" placeholder="e.g. TikTok Handle" /></div>
      <div class="form-group"><label class="form-label">Field Name (variable name)</label><input class="form-input" id="f-name" placeholder="e.g. tiktok_handle" /><div class="form-hint">Use in templates as {{field_name}}</div></div>
      <div class="form-group"><label class="form-label">Type</label><select class="form-select" id="f-type"><option value="text">Text</option><option value="number">Number</option><option value="url">URL</option></select></div>
      <div class="btn-group mt-4">
        <button class="btn btn-primary" onclick="ContactsComponent.saveField()">Add Field</button>
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      </div>
    `);
  },

  async saveField() {
    const label = document.getElementById('f-label').value.trim();
    const name = document.getElementById('f-name').value.trim();
    if (!label || !name) { showToast('Both fields required', 'error'); return; }
    try { await API.post('/api/contacts/fields', { field_label: label, field_name: name, field_type: document.getElementById('f-type').value }); closeModal(); showToast('Field added!', 'success'); this.render(); } catch(e) { showToast(e.message, 'error'); }
  },

  async deleteField(id) {
    if (!confirm('Delete this custom field?')) return;
    try { await API.del(`/api/contacts/fields/${id}`); showToast('Deleted', 'success'); this.render(); } catch(e) { showToast(e.message, 'error'); }
  },

  showImportModal() {
    openModal('Import Contacts from CSV', `
      <div class="file-drop" id="csv-drop" onclick="document.getElementById('csv-file').click()">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <p>Click to upload or drag & drop your <span class="highlight">CSV file</span></p>
        <input type="file" id="csv-file" accept=".csv" style="display:none" onchange="ContactsComponent.previewCSV(this)" />
      </div>
      <div id="csv-preview" class="mt-4"></div>
    `);
    const drop = document.getElementById('csv-drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) { document.getElementById('csv-file').files = e.dataTransfer.files; this.previewCSV(document.getElementById('csv-file')); } });
  },

  async previewCSV(input) {
    const file = input.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('csv', file);
    try {
      const preview = await API.upload('/api/contacts/import/preview', formData);
      const fieldMap = { email:'email', first_name:'first_name', last_name:'last_name', channel_name:'channel_name', channel_url:'channel_url', subscriber_count:'subscriber_count', niche:'niche', country:'country', language:'language' };
      const el = document.getElementById('csv-preview');
      el.innerHTML = `
        <p class="text-sm" style="margin-bottom:12px;"><strong>${preview.total_rows}</strong> rows found. Map your CSV columns:</p>
        <div id="csv-mapping">
          ${preview.headers.map(h => `
            <div class="mapping-row">
              <span style="flex:1;font-weight:600;">${escapeHtml(h)}</span>
              <span class="mapping-arrow">→</span>
              <select class="form-select" style="flex:1;" data-csv-col="${escapeHtml(h)}">
                <option value="">Skip</option>
                ${Object.entries(fieldMap).map(([k,v]) => `<option value="${k}" ${h.toLowerCase().replace(/\s+/g,'_').includes(v)?'selected':''}>${k}</option>`).join('')}
              </select>
            </div>
          `).join('')}
        </div>
        <div class="form-group mt-4"><label class="form-label">Add to Group</label><select class="form-select" id="csv-group"><option value="">No group</option></select></div>
        <button class="btn btn-primary mt-4" onclick="ContactsComponent.importCSV('${preview.file}')">Import ${preview.total_rows} Contacts</button>
      `;
      const groups = await API.get('/api/contacts/groups');
      const gs = document.getElementById('csv-group');
      groups.forEach(g => { const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; gs.appendChild(o); });
    } catch(e) { showToast(e.message, 'error'); }
  },

  async importCSV(fileName) {
    const mapping = {};
    document.querySelectorAll('#csv-mapping select').forEach(s => { if (s.value) mapping[s.value] = s.dataset.csvCol; });
    if (!mapping.email) { showToast('Please map the email column', 'error'); return; }
    const formData = new FormData();
    formData.append('file', fileName);
    formData.append('mapping', JSON.stringify(mapping));
    formData.append('group_id', document.getElementById('csv-group').value);
    try {
      const result = await API.upload('/api/contacts/import', formData);
      closeModal(); showToast(`Imported ${result.imported} contacts (${result.skipped} skipped)`, 'success'); this.render();
    } catch(e) { showToast(e.message, 'error'); }
  }
};
