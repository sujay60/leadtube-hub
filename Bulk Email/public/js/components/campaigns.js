const CampaignsComponent = {
  pollInterval: null,

  async render() {
    const area = document.getElementById('contentArea');
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    try {
      const campaigns = await API.get('/api/campaigns');

      // Build chain counts and filter to root campaigns only
      let listHtml = '';
      if (campaigns.length) {
        const chainCounts = {};
        campaigns.forEach(c => {
          if (!c.follow_up_of) {
            let count = 1, childId = c.id, guard = 0;
            while (guard < 50) {
              const child = campaigns.find(x => x.follow_up_of === childId);
              if (!child) break;
              count++; childId = child.id; guard++;
            }
            chainCounts[c.id] = count;
          }
        });

        listHtml = campaigns.filter(c => !c.follow_up_of).map(c => {
          const pct = c.total_emails ? Math.round(((c.sent_count + c.failed_count) / c.total_emails) * 100) : 0;
          const statusColor = {completed:'green',sending:'blue',paused:'amber',failed:'red',draft:'slate',scheduled:'blue'}[c.status]||'slate';
          const chainCount = chainCounts[c.id] || 1;
          const chainBadge = chainCount > 1 ? `<span class="badge badge-blue" style="margin-left:8px;">📧 ${chainCount}-step sequence</span>` : '';
          const delayLabel = c.delay_ms >= 60000 ? `${c.delay_ms/60000}min` : `${(c.delay_ms||2000)/1000}s`;
          let acctCount = 1;
          try { const ids = JSON.parse(c.account_ids||'[]'); if (ids.length) acctCount = ids.length; } catch(e) {}
          const rrLabel = acctCount > 1 ? `🔄 ${acctCount} accounts` : `via ${escapeHtml(c.sender_email||'—')}`;
          return `
          <div class="card" id="campaign-${c.id}" style="cursor:pointer;" onclick="CampaignsComponent.showDetails(${c.id})">
            <div class="flex justify-between items-center">
              <div>
                <h3 style="font-weight:700;font-size:1rem;">${escapeHtml(c.name)}${chainBadge}</h3>
                <p class="text-sm text-muted mt-2">${escapeHtml(c.template_name||'—')} → ${escapeHtml(c.group_name||'—')} · ${rrLabel} · ⏱ ${delayLabel} delay</p>
              </div>
              <span class="badge badge-${statusColor}">${c.status}${c.is_paused ? ' ⏸' : ''}</span>
            </div>
            <div class="campaign-progress">
              <div class="progress-stats">
                <span>${c.sent_count} sent · ${c.failed_count} failed</span>
                <span>${c.total_emails} total</span>
              </div>
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            </div>
            <div class="flex gap-4 text-sm text-muted">
              <span>📬 ${c.opened_count||0} opened</span>
              <span>🔗 ${c.clicked_count||0} clicked</span>
              <span>📅 ${formatDate(c.created_at)}</span>
            </div>
          </div>`;
        }).join('');
      }

      area.innerHTML = `
        <div class="section-header">
          <h2 class="section-title">Campaigns</h2>
          <button class="btn btn-primary" onclick="CampaignsComponent.showCreateForm()" id="btn-new-campaign">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Campaign
          </button>
        </div>
        ${!campaigns.length ? `
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            <h3>No campaigns yet</h3>
            <p>Create a campaign to send personalized emails to your contacts</p>
          </div>
        ` : `
          <div style="display:flex;flex-direction:column;gap:12px;">
            ${listHtml}
          </div>
        `}
      `;
    } catch(err) { area.innerHTML = `<div class="card"><p class="text-muted">Error: ${err.message}</p></div>`; }
  },

  async showCreateForm() {
    const [accounts, groups, templates] = await Promise.all([
      API.get('/auth/accounts'), API.get('/api/contacts/groups'), API.get('/api/templates')
    ]);
    if (!accounts.length) { showToast('Connect a Gmail account first', 'error'); window.location.hash = '#/accounts'; return; }
    if (!groups.length) { showToast('Create a contact group first', 'error'); window.location.hash = '#/contacts'; return; }

    window._appAccounts = accounts;
    window._appGroups = groups;
    window._appTemplates = templates || [];
    window._seqTree = [{ id: 'root', parentId: null, subject: '', body: '' }];
    window._nodeIdCounter = 1;

    this.renderBuilder();
  },

  renderBuilder() {
    const area = document.getElementById('contentArea');
    area.innerHTML = `
      <div class="section-header">
        <button class="btn btn-secondary" onclick="CampaignsComponent.render()">← Cancel</button>
        <h2 class="section-title">Visual Sequence Builder</h2>
        <button class="btn btn-primary" onclick="CampaignsComponent.saveSequence()">🚀 Launch Sequence</button>
      </div>

      <div class="card mb-4" style="padding: 20px;">
        <div class="form-row">
          <div class="form-group mb-0">
            <label class="form-label">Campaign Name</label>
            <input class="form-input" id="seq-camp-name" placeholder="e.g. May YouTuber Outreach" />
          </div>
          <div class="form-group mb-0">
            <label class="form-label">Contact Group</label>
            <select class="form-select" id="seq-camp-group">
              ${window._appGroups.map(g => `<option value="${g.id}">${escapeHtml(g.name)} (${g.contact_count} contacts)</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group mt-4 mb-0">
          <label class="form-label">Send From (select multiple for round-robin)</label>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            ${window._appAccounts.map(a => `
              <label style="display:flex;align-items:center;gap:6px;background:var(--slate-100);padding:6px 12px;border-radius:20px;cursor:pointer;">
                <input type="checkbox" class="seq-account-cb" value="${a.id}" checked />
                <span class="text-sm font-semibold">${escapeHtml(a.email)}</span>
              </label>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="tree-wrapper">
        <div id="seq-tree-container"></div>
      </div>
    `;
    this.renderTree();
  },

  renderTree() {
    const container = document.getElementById('seq-tree-container');
    if (!container) return;
    
    const buildNodeHtml = (parentId) => {
      const children = window._seqTree.filter(n => n.parentId === parentId);
      if (children.length === 0) return '';
      
      let html = `<ul class="tree-ul ${parentId === null ? 'root-ul' : ''}">`;
      for (const node of children) {
        const isRoot = node.parentId === null;
        
        let conditionHtml = '';
        if (!isRoot) {
          conditionHtml = `
            <div class="form-group mb-3">
              <label class="form-label" style="font-size:.8rem;">Condition</label>
              <select class="form-select" style="padding:6px 10px;font-size:.85rem;" onchange="CampaignsComponent.updateNode('${node.id}', 'condition', this.value)">
                <option value="not_opened" ${node.condition==='not_opened'?'selected':''}>Did NOT open</option>
                <option value="not_clicked" ${node.condition==='not_clicked'?'selected':''}>Did NOT click</option>
                <option value="opened_not_clicked" ${node.condition==='opened_not_clicked'?'selected':''}>Opened, not clicked</option>
                <option value="all" ${node.condition==='all'?'selected':''}>All recipients</option>
              </select>
            </div>
            <div class="form-group mb-3">
              <label class="form-label" style="font-size:.8rem;">Wait Days</label>
              <input type="number" class="form-input" value="${node.delay_days||1}" min="1" style="padding:6px 10px;font-size:.85rem;" onchange="CampaignsComponent.updateNode('${node.id}', 'delay_days', this.value)" />
            </div>
            <hr style="margin:12px 0;border:none;border-top:1px solid var(--slate-100);" />
          `;
        }

        html += `
          <li class="tree-li">
            <div class="tree-node ${isRoot ? 'root-node' : ''}">
              <div class="node-header">
                <div class="node-title">${isRoot ? '🌟 Initial Email' : '📧 Follow-up'}</div>
                ${!isRoot ? `<button class="node-delete" onclick="CampaignsComponent.deleteNode('${node.id}')">✕</button>` : ''}
              </div>
              
              ${conditionHtml}

              ${(window._appTemplates && window._appTemplates.length) ? `
              <div class="form-group mb-3">
                <label class="form-label" style="font-size:.8rem;color:var(--blue-600);font-weight:600;">📄 Load from Template</label>
                <select class="form-select" style="padding:6px 10px;font-size:.85rem;border-color:var(--blue-200);background-color:var(--blue-50);" onchange="CampaignsComponent.loadTemplateIntoNode('${node.id}', this.value)">
                  <option value="">— Choose a saved template —</option>
                  ${window._appTemplates.map(t => `<option value="${t.id}">${escapeHtml(t.name)} — ${escapeHtml(t.subject)}</option>`).join('')}
                </select>
              </div>
              ` : ''}

              <div class="form-group mb-3">
                <label class="form-label" style="font-size:.8rem;">Subject Line</label>
                <input class="form-input" style="padding:6px 10px;font-size:.85rem;" value="${escapeHtml(node.subject)}" placeholder="Enter subject..." oninput="CampaignsComponent.updateNode('${node.id}', 'subject', this.value)" />
              </div>
              <div class="form-group mb-0">
                <label class="form-label" style="font-size:.8rem;display:flex;justify-content:space-between;">
                  <span>Message Body</span>
                  <span class="text-muted" style="font-weight:400;font-size:.7rem;">Supports HTML & {{variables}}</span>
                </label>
                <textarea class="form-textarea" style="padding:10px;font-size:.85rem;min-height:140px;" placeholder="Hi {{firstName}}, ..." oninput="CampaignsComponent.updateNode('${node.id}', 'body', this.value)">${escapeHtml(node.body)}</textarea>
              </div>

              <div style="text-align:center;margin-top:16px;">
                <button class="node-add-btn" onclick="CampaignsComponent.addBranch('${node.id}')">➕ Add Branch</button>
              </div>
            </div>
            ${buildNodeHtml(node.id)}
          </li>
        `;
      }
      html += `</ul>`;
      return html;
    };

    container.innerHTML = buildNodeHtml(null);
  },

  updateNode(id, key, val) {
    const node = window._seqTree.find(n => n.id === id);
    if (node) node[key] = val;
  },

  loadTemplateIntoNode(nodeId, templateId) {
    if (!templateId) return;
    const node = window._seqTree.find(n => n.id === nodeId);
    const template = (window._appTemplates || []).find(t => t.id === parseInt(templateId));
    if (node && template) {
      node.subject = template.subject || '';
      node.body = template.body_html || template.body_text || '';
      this.renderTree();
      showToast(`Template "${template.name}" loaded!`, 'success');
    }
  },

  addBranch(parentId) {
    window._seqTree.push({
      id: 'node_' + window._nodeIdCounter++,
      parentId: parentId,
      condition: 'not_opened',
      delay_days: 2,
      subject: '',
      body: ''
    });
    this.renderTree();
  },

  deleteNode(id) {
    if (!confirm('Delete this branch and all its children?')) return;
    const idsToDelete = new Set([id]);
    let added = true;
    while(added) {
      added = false;
      for (const node of window._seqTree) {
        if (idsToDelete.has(node.parentId) && !idsToDelete.has(node.id)) {
          idsToDelete.add(node.id);
          added = true;
        }
      }
    }
    window._seqTree = window._seqTree.filter(n => !idsToDelete.has(n.id));
    this.renderTree();
  },

  async saveSequence() {
    const checkedAccounts = [...document.querySelectorAll('.seq-account-cb:checked')].map(cb => parseInt(cb.value));
    if (!checkedAccounts.length) { showToast('Select at least one sender account', 'error'); return; }
    
    const name = document.getElementById('seq-camp-name').value.trim();
    if (!name) { showToast('Campaign name required', 'error'); return; }

    for (const node of window._seqTree) {
      if (!node.subject.trim() || !node.body.trim()) {
        showToast('All nodes must have a subject and body', 'error'); return;
      }
    }

    const data = {
      name: name,
      group_id: parseInt(document.getElementById('seq-camp-group').value),
      account_ids: checkedAccounts,
      delay_ms: 2000,
      tree: window._seqTree
    };

    try {
      const campaign = await API.post('/api/campaigns', data);
      showToast('Visual sequence launched successfully!', 'success');
      this.showDetails(campaign.id);
    } catch(e) { showToast(e.message, 'error'); }
  },

  async showDetails(id) {
    const area = document.getElementById('contentArea');
    area.innerHTML = '<div class="spinner"></div>';
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    try {
      const c = await API.get(`/api/campaigns/${id}`);
       const pct = c.total_emails ? Math.round(((c.sent_count + c.failed_count) / c.total_emails) * 100) : 0;
      const openRate = c.sent_count ? Math.round((c.opened_count / c.sent_count) * 100) : 0;
      const clickRate = c.sent_count ? Math.round((c.clicked_count / c.sent_count) * 100) : 0;
      const delayLabel = (c.delay_ms||2000) >= 60000 ? `${(c.delay_ms||2000)/60000} min` : `${(c.delay_ms||2000)/1000} sec`;
      const isPaused = c.status === 'paused' || c.is_paused;
      const isSending = c.status === 'sending';
      const isScheduled = c.status === 'scheduled';

      // Calculate countdown for scheduled campaigns
      let scheduleInfo = '';
      if (isScheduled && c.scheduled_send_at) {
        const sendAt = new Date(c.scheduled_send_at + 'Z');
        const now = new Date();
        const diffMs = sendAt - now;
        if (diffMs > 0) {
          const hours = Math.floor(diffMs / 3600000);
          const days = Math.floor(hours / 24);
          const remainHours = hours % 24;
          scheduleInfo = days > 0 ? `${days}d ${remainHours}h remaining` : `${hours}h remaining`;
        } else {
          scheduleInfo = 'Sending soon...';
        }
      }

      // Determine the last step in the chain for "Add Follow-up" button
      const chain = c.chain || [];
      const lastStep = chain.length ? chain[chain.length - 1] : null;
      const canAddFollowUp = lastStep && (lastStep.status === 'completed');
      // Show "Create Follow-up" button on the last step of the chain
      const showFollowUpBtn = canAddFollowUp ? `<button class="btn btn-primary" onclick="CampaignsComponent.showFollowUpForm(${lastStep.id})" id="btn-followup">↩ Add Follow-up #${chain.length}</button>` : '';

      area.innerHTML = `
        <button class="btn btn-secondary mb-4" onclick="CampaignsComponent.render()">← Back to Campaigns</button>
        <div class="flex justify-between items-center mb-4" style="flex-wrap:wrap;gap:12px;">
          <h2 style="font-size:1.3rem;font-weight:800;">${escapeHtml(c.name)}</h2>
          <div class="btn-group">
            ${c.status === 'draft' ? `<button class="btn btn-primary" onclick="CampaignsComponent.send(${c.id})" id="btn-send-campaign">🚀 Send Now</button>` : ''}
            ${isScheduled ? `<button class="btn btn-primary" onclick="CampaignsComponent.send(${c.id})" id="btn-send-now">🚀 Send Now (skip wait)</button>` : ''}
            ${isSending ? `<button class="btn btn-secondary" onclick="CampaignsComponent.pause(${c.id})" id="btn-pause">⏸ Pause</button>` : ''}
            ${isSending ? `<button class="btn btn-secondary" onclick="CampaignsComponent.resetStuck(${c.id})" id="btn-reset-stuck" title="Use this if the campaign is frozen at 0 emails after a server restart" style="background:var(--amber,#f59e0b);color:white;border-color:var(--amber,#f59e0b);">🔧 Reset Stuck</button>` : ''}
            ${isPaused ? `<button class="btn btn-primary" onclick="CampaignsComponent.resume(${c.id})" id="btn-resume">▶ Resume</button>` : ''}
            ${showFollowUpBtn}
            <button class="btn btn-danger btn-sm" onclick="CampaignsComponent.remove(${c.id})">Delete</button>
            <button class="btn btn-secondary btn-sm" onclick="CampaignsComponent.diagnoseEmail()" id="btn-diagnose" style="background:#7c3aed;color:white;border-color:#7c3aed;font-weight:700;">🔍 Diagnose Email</button>
          </div>
        </div>
        <div id="diagnose-results"></div>

        ${isScheduled ? `
          <div class="card mb-4" style="border:2px solid var(--blue-300);background:linear-gradient(135deg, var(--blue-50), var(--white));">
            <div class="flex items-center gap-4">
              <div style="font-size:2rem;">⏰</div>
              <div>
                <h3 style="font-weight:700;color:var(--blue-700);">Scheduled Follow-up</h3>
                <p class="text-sm text-muted">Will auto-send on <strong>${c.scheduled_send_at}</strong> · ${scheduleInfo}</p>
                <p class="text-sm text-muted mt-2">✅ Will send in the same email thread as the original · 🔄 Same round-robin accounts</p>
              </div>
            </div>
          </div>
        ` : ''}

        <div class="stats-grid">
          <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${c.total_emails}</div></div>
          <div class="stat-card green"><div class="stat-label">Sent</div><div class="stat-value" id="stat-sent">${c.sent_count}</div></div>
          <div class="stat-card amber"><div class="stat-label">Open Rate</div><div class="stat-value">${openRate}%</div><div class="stat-sub">${c.opened_count} opened</div></div>
          <div class="stat-card red"><div class="stat-label">Click Rate</div><div class="stat-value">${clickRate}%</div><div class="stat-sub">${c.clicked_count} clicked</div></div>
        </div>

        <!-- Delay & Progress Control -->
        <div class="card mb-4">
          <div class="card-header">
            <h3 class="card-title">⏱ Sending Settings</h3>
            <span class="badge badge-${c.status==='completed'?'green':c.status==='sending'?'blue':c.status==='paused'?'amber':'slate'}" id="status-badge">${c.status}${isPaused ? ' ⏸' : ''}</span>
          </div>
          <div class="flex items-center gap-4 mb-4" style="flex-wrap:wrap;">
            <span class="text-sm" style="font-weight:600;">Delay: ${delayLabel}</span>
            ${(isSending || isPaused) ? `
              <div class="flex items-center gap-2">
                <span class="text-sm text-muted">Change delay:</span>
                <select class="form-select" style="width:auto;padding:6px 10px;font-size:.85rem;" onchange="CampaignsComponent.updateDelay(${c.id}, this.value)">
                  <option value="2000" ${c.delay_ms==2000?'selected':''}>2 sec</option>
                  <option value="5000" ${c.delay_ms==5000?'selected':''}>5 sec</option>
                  <option value="10000" ${c.delay_ms==10000?'selected':''}>10 sec</option>
                  <option value="30000" ${c.delay_ms==30000?'selected':''}>30 sec</option>
                  <option value="60000" ${c.delay_ms==60000?'selected':''}>1 min</option>
                  <option value="120000" ${c.delay_ms==120000?'selected':''}>2 min</option>
                  <option value="300000" ${c.delay_ms==300000?'selected':''}>5 min</option>
                </select>
              </div>
            ` : ''}
          </div>
          <div class="campaign-progress">
            <div class="progress-stats"><span id="prog-text">${c.sent_count + c.failed_count} / ${c.total_emails}</span><span>${pct}%</span></div>
            <div class="progress-bar"><div class="progress-fill" id="prog-fill" style="width:${pct}%"></div></div>
          </div>
          ${c.failed_count ? `<p class="text-sm mt-2" style="color:var(--red);">${c.failed_count} emails failed</p>` : ''}
        </div>

        ${chain.length > 1 ? `
          <div class="card mb-4">
            <div class="card-header">
              <h3 class="card-title">📧 Follow-up Sequence</h3>
              <span class="badge badge-blue">${chain.length} steps</span>
            </div>
            <div class="followup-chain">
              ${chain.map((step, idx) => {
                const isCurrent = step.id === c.id;
                const statusColor = {completed:'green',sending:'blue',paused:'amber',failed:'red',draft:'slate',scheduled:'blue'}[step.status]||'slate';
                const statusIcon = {completed:'✅',sending:'📤',paused:'⏸',failed:'❌',draft:'📝',scheduled:'⏰'}[step.status]||'📧';
                const openRate = step.sent_count ? Math.round((step.opened_count / step.sent_count) * 100) : 0;
                const isLast = idx === chain.length - 1;

                // Countdown for scheduled steps
                let countdown = '';
                if (step.status === 'scheduled' && step.scheduled_send_at) {
                  const sendAt = new Date(step.scheduled_send_at + 'Z');
                  const diffMs = sendAt - new Date();
                  if (diffMs > 0) {
                    const h = Math.floor(diffMs / 3600000);
                    const d = Math.floor(h / 24);
                    countdown = d > 0 ? ` · sends in ${d}d ${h%24}h` : ` · sends in ${h}h`;
                  } else { countdown = ' · sending soon...'; }
                }

                return `
                  ${idx > 0 ? `
                    <div class="chain-connector">
                      <div class="chain-line"></div>
                      <div class="chain-condition">
                        <span>${step.follow_up_condition === 'not_opened' ? 'Not opened' : step.follow_up_condition === 'not_clicked' ? 'Not clicked' : step.follow_up_condition === 'opened_not_clicked' ? 'Opened, not clicked' : 'All'}</span>
                        <span>· wait ${step.follow_up_days || 1} day${(step.follow_up_days||1) > 1 ? 's' : ''}</span>
                      </div>
                      <div class="chain-line"></div>
                    </div>
                  ` : ''}
                  <div class="chain-step ${isCurrent ? 'chain-step-active' : ''}" onclick="CampaignsComponent.showDetails(${step.id})" style="cursor:pointer;">
                    <div class="flex justify-between items-center">
                      <div class="flex items-center gap-3">
                        <span style="font-size:1.3rem;">${statusIcon}</span>
                        <div>
                          <div style="font-weight:700;font-size:.95rem;">${step.step === 0 ? '📧 Original' : 'Follow-up #' + step.step}</div>
                          <div class="text-sm text-muted">${escapeHtml(step.template_name || '—')} · ${step.total_emails} emails · ${openRate}% opened${countdown}</div>
                        </div>
                      </div>
                      <span class="badge badge-${statusColor}">${step.status}</span>
                    </div>
                  </div>
                `;
              }).join('')}
              ${canAddFollowUp ? `
                <div class="chain-connector">
                  <div class="chain-line"></div>
                  <div class="chain-condition"><span>+</span></div>
                  <div class="chain-line"></div>
                </div>
                <div class="chain-step chain-step-add" onclick="CampaignsComponent.showFollowUpForm(${lastStep.id})" style="cursor:pointer;">
                  <div class="flex items-center gap-3 justify-center" style="padding:4px 0;">
                    <span style="font-size:1.1rem;">➕</span>
                    <span style="font-weight:600;color:var(--blue-600);">Add Follow-up #${chain.length}</span>
                  </div>
                </div>
              ` : ''}
            </div>
          </div>
        ` : (c.status === 'completed' ? `
          <div class="card mb-4">
            <div class="card-header">
              <h3 class="card-title">📧 Follow-up Sequence</h3>
            </div>
            <div class="followup-chain">
              <div class="chain-step chain-step-active">
                <div class="flex items-center gap-3">
                  <span style="font-size:1.3rem;">✅</span>
                  <div>
                    <div style="font-weight:700;font-size:.95rem;">📧 Original Campaign</div>
                    <div class="text-sm text-muted">${escapeHtml(c.template_name || '—')} · ${c.total_emails} emails · ${openRate}% opened</div>
                  </div>
                </div>
              </div>
              <div class="chain-connector">
                <div class="chain-line"></div>
                <div class="chain-condition"><span>+</span></div>
                <div class="chain-line"></div>
              </div>
              <div class="chain-step chain-step-add" onclick="CampaignsComponent.showFollowUpForm(${c.id})" style="cursor:pointer;">
                <div class="flex items-center gap-3 justify-center" style="padding:4px 0;">
                  <span style="font-size:1.1rem;">➕</span>
                  <span style="font-weight:600;color:var(--blue-600);">Add Follow-up #1</span>
                </div>
              </div>
            </div>
          </div>
        ` : '')}

        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Email Log</h3>
            ${c.failed_count > 0 ? `<button class="btn btn-secondary btn-sm" onclick="CampaignsComponent.retryFailed(${c.id})" id="btn-retry-failed" style="font-size:.8rem;">🔁 Retry Failed (${c.failed_count})</button>` : ''}
          </div>
          ${(c.emails||[]).some(e => e.status === 'failed' && e.error_message) ? `
            <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px 16px;margin-bottom:12px;font-size:.85rem;">
              <strong>⚠️ Why emails failed:</strong>
              <ul style="margin:6px 0 0 16px;padding:0;">
                ${[...new Set((c.emails||[]).filter(e=>e.error_message).map(e=>e.error_message))].map(msg=>`<li style="margin-top:4px;color:#856404;">${escapeHtml(msg)}</li>`).join('')}
              </ul>
              <p style="margin:8px 0 0;color:#856404;">
                <strong>Fix:</strong> Go to <strong>Accounts</strong> tab → reconnect your Gmail account with a fresh App Password or re-authorize via OAuth.
              </p>
            </div>
          ` : ''}
          <div class="table-container">
            <table><thead><tr><th>Contact</th><th>Email</th><th>Status</th><th>Error</th><th>Opened</th><th>Clicked</th><th>Sent At</th></tr></thead>
            <tbody>
              ${(c.emails||[]).map(e => `<tr>
                <td>${escapeHtml(e.first_name||e.channel_name||'—')}</td>
                <td>${escapeHtml(e.email)}</td>
                <td><span class="badge badge-${e.status==='sent'?'green':e.status==='failed'?'red':'slate'}">${e.status}</span></td>
                <td style="max-width:240px;font-size:.78rem;color:var(--red,#ef4444);">${e.error_message ? escapeHtml(e.error_message) : '—'}</td>
                <td>${e.opened_at ? '✅ ' + formatDate(e.opened_at) : '—'}</td>
                <td>${e.clicked_at ? '✅ ' + formatDate(e.clicked_at) : '—'}</td>
                <td>${formatDate(e.sent_at)}</td>
              </tr>`).join('')}
            </tbody></table>
          </div>
        </div>
      `;

      if (isSending || isPaused) this.startPolling(id);
    } catch(e) { area.innerHTML = `<div class="card"><p class="text-muted">Error: ${e.message}</p></div>`; }
  },

  async send(id) {
    if (!confirm('Start sending emails now?')) return;
    try {
      await API.post(`/api/campaigns/${id}/send`);
      showToast('Campaign is now sending!', 'success');
      this.showDetails(id);
    } catch(e) { showToast(e.message, 'error'); }
  },

  async pause(id) {
    try {
      await API.post(`/api/campaigns/${id}/pause`);
      showToast('Campaign paused ⏸', 'info');
      this.showDetails(id);
    } catch(e) { showToast(e.message, 'error'); }
  },

  async resume(id) {
    try {
      await API.post(`/api/campaigns/${id}/resume`);
      showToast('Campaign resumed ▶', 'success');
      this.showDetails(id);
    } catch(e) { showToast(e.message, 'error'); }
  },

  async updateDelay(id, delayMs) {
    try {
      await API.post(`/api/campaigns/${id}/delay`, { delay_ms: parseInt(delayMs) });
      showToast(`Delay updated to ${delayMs >= 60000 ? (delayMs/60000)+' min' : (delayMs/1000)+' sec'}`, 'success');
    } catch(e) { showToast(e.message, 'error'); }
  },

  async showFollowUpForm(campaignId) {
    const templates = await API.get('/api/templates');
    const availableVars = ['firstName', 'lastName', 'email', 'channelName', 'channelUrl', 'subscriberCount', 'niche', 'country', 'language'];

    openModal('Create Follow-up Email', `
      <p class="text-sm text-muted mb-4">Send a follow-up to contacts from this campaign based on their engagement.</p>

      <div class="form-group"><label class="form-label">Send to contacts who…</label>
        <select class="form-select" id="fu-condition">
          <option value="not_opened">Did NOT open the email</option>
          <option value="not_clicked">Did NOT click any link</option>
          <option value="opened_not_clicked">Opened but did NOT click</option>
          <option value="all">All recipients (re-send to everyone)</option>
        </select>
      </div>

      <div class="form-group"><label class="form-label">Follow-up Message</label>
        <div class="tab-bar" style="margin-bottom:12px;">
          <div class="tab active" onclick="CampaignsComponent.toggleFollowUpMode('custom', this)">✍️ Write Custom Message</div>
          <div class="tab" onclick="CampaignsComponent.toggleFollowUpMode('existing', this)">📄 Use Existing Template</div>
        </div>
      </div>

      <!-- Custom message section -->
      <div id="fu-custom-section">
        <div class="form-group">
          <label class="form-label">Subject Line</label>
          <input class="form-input" id="fu-subject" placeholder="e.g. Just checking in, {{firstName}}..." />
        </div>
        <div class="form-group">
          <label class="form-label">Insert Variables</label>
          <div class="var-chips">
            ${availableVars.map(v => `<span class="var-chip" onclick="CampaignsComponent.insertFollowUpVar('${v}')">{{${v}}}</span>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Message Body</label>
          <textarea class="form-textarea" id="fu-body" rows="8" placeholder="Hi {{firstName}},

I wanted to follow up on my previous email about collaborating with {{channelName}}.

I think there's a great opportunity for us to work together...

Best regards"></textarea>
          <div class="form-hint">Supports HTML. Use {{variable}} for personalization. Use {{#if variable}}...{{/if}} for conditional content.</div>
        </div>
      </div>

      <!-- Existing template section (hidden by default) -->
      <div id="fu-existing-section" style="display:none;">
        <div class="form-group"><label class="form-label">Select Template</label>
          <select class="form-select" id="fu-template">
            ${templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)} — ${escapeHtml(t.subject)}</option>`).join('')}
          </select>
        </div>
      </div>

      <input type="hidden" id="fu-mode" value="custom" />

      <div class="form-group"><label class="form-label">Wait days before sending</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button type="button" class="btn btn-secondary btn-sm fu-day-btn" data-days="1" onclick="CampaignsComponent.selectFollowUpDays(this)" style="background:var(--blue-500);color:white;border-color:var(--blue-500);">1 day</button>
          <button type="button" class="btn btn-secondary btn-sm fu-day-btn" data-days="2" onclick="CampaignsComponent.selectFollowUpDays(this)">2 days</button>
          <button type="button" class="btn btn-secondary btn-sm fu-day-btn" data-days="3" onclick="CampaignsComponent.selectFollowUpDays(this)">3 days</button>
          <button type="button" class="btn btn-secondary btn-sm fu-day-btn" data-days="5" onclick="CampaignsComponent.selectFollowUpDays(this)">5 days</button>
          <button type="button" class="btn btn-secondary btn-sm fu-day-btn" data-days="7" onclick="CampaignsComponent.selectFollowUpDays(this)">7 days</button>
        </div>
        <input type="hidden" id="fu-days" value="1" />
        <div class="form-hint">The follow-up campaign will be created as a draft. You can send it when ready.</div>
      </div>
      <div class="btn-group mt-4">
        <button class="btn btn-primary" onclick="CampaignsComponent.createFollowUp(${campaignId})">Create Follow-up</button>
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      </div>
    `);
  },

  toggleFollowUpMode(mode, tab) {
    document.getElementById('fu-mode').value = mode;
    document.querySelectorAll('.modal .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('fu-custom-section').style.display = mode === 'custom' ? '' : 'none';
    document.getElementById('fu-existing-section').style.display = mode === 'existing' ? '' : 'none';
  },

  insertFollowUpVar(varName) {
    const body = document.getElementById('fu-body');
    if (body) {
      const pos = body.selectionStart;
      const text = body.value;
      body.value = text.slice(0, pos) + `{{${varName}}}` + text.slice(pos);
      body.focus();
      body.selectionStart = body.selectionEnd = pos + varName.length + 4;
    }
  },

  selectFollowUpDays(btn) {
    document.querySelectorAll('.fu-day-btn').forEach(b => { b.style.background=''; b.style.color=''; b.style.borderColor=''; });
    btn.style.background = 'var(--blue-500)'; btn.style.color = 'white'; btn.style.borderColor = 'var(--blue-500)';
    document.getElementById('fu-days').value = btn.dataset.days;
  },

  async createFollowUp(campaignId) {
    const mode = document.getElementById('fu-mode').value;
    let templateId;

    if (mode === 'custom') {
      const subject = document.getElementById('fu-subject').value.trim();
      const body = document.getElementById('fu-body').value.trim();
      if (!subject || !body) { showToast('Subject and message body are required', 'error'); return; }

      // Create a new template from the custom message
      try {
        const tpl = await API.post('/api/templates', {
          name: `Follow-up: ${subject.substring(0, 40)}`,
          subject: subject,
          body_html: body.replace(/\n/g, '<br>'),
          body_text: body
        });
        templateId = tpl.id;
      } catch(e) { showToast('Failed to save follow-up template: ' + e.message, 'error'); return; }
    } else {
      templateId = parseInt(document.getElementById('fu-template').value);
    }

    const data = {
      template_id: templateId,
      condition: document.getElementById('fu-condition').value,
      delay_days: parseInt(document.getElementById('fu-days').value) || 1
    };
    try {
      const fu = await API.post(`/api/campaigns/${campaignId}/follow-up`, data);
      closeModal();
      showToast(`Follow-up created with ${fu.total_emails} contacts!`, 'success');
      this.showDetails(fu.id);
    } catch(e) { showToast(e.message, 'error'); }
  },

  startPolling(id) {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(async () => {
      try {
        const s = await API.get(`/api/campaigns/${id}/status`);
        const pct = s.total_emails ? Math.round(((s.sent_count + s.failed_count) / s.total_emails) * 100) : 0;
        const fill = document.getElementById('prog-fill');
        const text = document.getElementById('prog-text');
        const badge = document.getElementById('status-badge');
        const sent = document.getElementById('stat-sent');
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `${s.sent_count + s.failed_count} / ${s.total_emails}`;
        if (badge) { badge.textContent = s.status + (s.is_paused ? ' ⏸' : ''); badge.className = `badge badge-${s.status==='completed'?'green':s.status==='sending'?'blue':s.status==='paused'?'amber':'red'}`; }
        if (sent) sent.textContent = s.sent_count;
        if (s.status === 'completed' || s.status === 'failed') { clearInterval(this.pollInterval); this.pollInterval = null; this.showDetails(id); }
      } catch(e) {}
    }, 2000);
  },

  async diagnoseEmail() {
    const box = document.getElementById('diagnose-results');
    if (!box) return;
    box.innerHTML = '<div class="card" style="border:2px solid #7c3aed;padding:20px;"><div class="spinner"></div><p style="text-align:center;margin-top:12px;">Testing email connections... this may take 15 seconds</p></div>';
    try {
      const data = await API.post('/api/campaigns/diagnose');
      let html = `<div class="card" style="border:2px solid ${data.success ? '#22c55e' : '#ef4444'};padding:20px;margin-bottom:16px;">`;
      html += `<h3 style="font-size:1.1rem;font-weight:800;margin-bottom:12px;">${data.success ? '✅ All accounts OK!' : '❌ Email Sending Problem Detected'}</h3>`;
      
      // Environment info
      html += `<div style="background:#f1f5f9;border-radius:8px;padding:12px;margin-bottom:16px;font-size:.82rem;font-family:monospace;">`;
      html += `<strong>Server Environment:</strong><br>`;
      html += `CLIENT_ID configured: ${data.env.hasClientId ? '✅ Yes' : '❌ No'}<br>`;
      html += `CLIENT_SECRET configured: ${data.env.hasClientSecret ? '✅ Yes' : '❌ No'}<br>`;
      html += `BASE_URL: ${data.env.baseUrl}<br>`;
      html += `NODE_ENV: ${data.env.nodeEnv}`;
      html += `</div>`;
      
      // Each account
      for (const acc of (data.accounts || [])) {
        const ok = acc.status === 'OK';
        html += `<div style="background:${ok ? '#f0fdf4' : '#fef2f2'};border:1px solid ${ok ? '#86efac' : '#fca5a5'};border-radius:8px;padding:14px;margin-bottom:10px;">`;
        html += `<div style="font-weight:700;font-size:.95rem;margin-bottom:6px;">${ok ? '✅' : '❌'} ${acc.email} (${acc.type})</div>`;
        html += `<div style="font-size:.82rem;font-family:monospace;color:${ok ? '#166534' : '#991b1b'};white-space:pre-wrap;word-break:break-all;">${acc.message || 'No details'}</div>`;
        if (acc.code) html += `<div style="font-size:.78rem;color:#6b7280;margin-top:4px;">Error Code: ${acc.code}</div>`;
        if (acc.fullError) html += `<pre style="font-size:.72rem;color:#9ca3af;margin-top:6px;white-space:pre-wrap;max-height:120px;overflow:auto;">${acc.fullError}</pre>`;
        if (acc.tokenExpiry && acc.tokenExpiry !== 'N/A') html += `<div style="font-size:.78rem;color:#6b7280;margin-top:4px;">Token Expiry: ${acc.tokenExpiry} | Expired: ${acc.tokenExpired}</div>`;
        html += `</div>`;
      }
      
      if (!data.success) {
        html += `<div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px;margin-top:12px;font-size:.85rem;">`;
        html += `<strong>💡 How to fix:</strong><br>`;
        html += `• If you see "Connection timeout" → Your hosting provider blocks SMTP ports. The fix requires using Gmail API instead of SMTP.<br>`;
        html += `• If you see "Invalid credentials" or "Invalid login" → Your App Password is wrong. Generate a new one in Google Account → Security → App Passwords.<br>`;
        html += `• If you see "Token refresh failed" → Go to Accounts tab, remove the account, and reconnect it via Google OAuth.<br>`;
        html += `• <strong>Screenshot this entire box and share it for help!</strong>`;
        html += `</div>`;
      }
      
      html += `</div>`;
      box.innerHTML = html;
    } catch(e) {
      box.innerHTML = `<div class="card" style="border:2px solid #ef4444;padding:20px;"><h3 style="color:#ef4444;">❌ Diagnose Failed</h3><pre style="white-space:pre-wrap;">${e.message}</pre></div>`;
    }
  },

  async retryFailed(id) {
    if (!confirm('Reset all failed emails back to pending and re-send this campaign?')) return;
    try {
      await API.post(`/api/campaigns/${id}/retry-failed`);
      showToast('Failed emails reset — resending now!', 'success');
      this.showDetails(id);
    } catch(e) { showToast('Retry failed: ' + e.message, 'error'); }
  },

  async resetStuck(id) {
    if (!confirm('Reset this stuck campaign back to "draft" so you can send it again?\n\nOnly use this if the campaign is frozen at 0 emails sent (usually after a server restart).')) return;
    try {
      await API.post(`/api/campaigns/${id}/reset-stuck`);
      showToast('Campaign reset to draft — click Send Now to restart it.', 'success');
      this.showDetails(id);
    } catch(e) { showToast('Reset failed: ' + e.message, 'error'); }
  },

  async remove(id) {
    if (!confirm('Delete this campaign and all its data?')) return;
    try { await API.del(`/api/campaigns/${id}`); showToast('Campaign deleted', 'success'); this.render(); } catch(e) { showToast(e.message, 'error'); }
  }
};
