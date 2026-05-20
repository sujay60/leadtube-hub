const InboxComponent = {
  async render() {
    const area = document.getElementById('contentArea');
    area.innerHTML = '<div class="spinner"></div>';

    try {
      const replies = await API.get('/api/inbox');

      if (!replies.length) {
        area.innerHTML = `
          <div class="section-header">
            <h2 class="section-title">Centralized Inbox</h2>
          </div>
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            <h3>No replies yet</h3>
            <p>When contacts reply to your campaigns, they will appear here.</p>
          </div>
        `;
        return;
      }

      // Group replies by thread
      const threads = {};
      replies.forEach(r => {
        const tid = r.thread_id || r.id;
        if (!threads[tid]) {
          threads[tid] = { contact_name: r.first_name ? `${r.first_name} ${r.last_name||''}` : r.contact_email, messages: [], campaign_name: r.campaign_name, contact_id: r.contact_id, campaign_id: r.campaign_id };
        }
        threads[tid].messages.push(r);
      });

      const threadHtml = Object.values(threads).map(t => {
        const firstMsg = t.messages[0];
        const isRead = firstMsg.is_read;
        return `
          <div class="card mb-3" style="${!isRead ? 'border-left: 3px solid var(--blue-500);' : ''}; padding: 12px;">
            <div class="card-header" style="margin-bottom:8px; align-items: center;">
              <div>
                <h3 class="card-title" style="font-size: 1rem; margin: 0;">${escapeHtml(t.contact_name)}</h3>
                <div class="text-xs text-muted">Campaign: ${escapeHtml(t.campaign_name)}</div>
              </div>
              <div class="btn-group">
                ${firstMsg.is_paused ? 
                  `<button class="btn btn-primary btn-xs" onclick="InboxComponent.resumeContact(${t.contact_id}, ${t.campaign_id})">▶️ Resume</button>` :
                  `<button class="btn btn-secondary btn-xs" onclick="InboxComponent.pauseContact(${t.contact_id}, ${t.campaign_id})">⏸ Pause</button>`
                }
                <button class="btn btn-primary btn-xs" onclick="InboxComponent.openReplyModal(${firstMsg.id}, '${escapeHtml(t.contact_name)}')">↩ Reply</button>
              </div>
            </div>
            
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${t.messages.reverse().map(m => {
                const isSentByUs = m.body_text && m.body_text.startsWith('[You replied]:');
                return `
                <div style="padding:10px 14px;background:${isSentByUs ? 'var(--blue-50)' : 'var(--slate-50)'};border-radius:var(--radius-sm);border:1px solid ${isSentByUs ? 'var(--blue-100)' : 'var(--slate-200)'};">
                  <div class="flex justify-between items-center mb-1">
                    <span style="font-weight:600;font-size:.8rem;">${isSentByUs ? 'You' : escapeHtml(t.contact_name)} <span class="text-muted" style="font-weight:400;font-size:.75rem;">&lt;${escapeHtml(m.contact_email)}&gt;</span></span>
                    <span class="text-muted" style="font-size:.7rem;">${formatDate(m.received_at)}</span>
                  </div>
                  <div style="font-size:.85rem;white-space:pre-wrap;color:var(--slate-700);line-height:1.4;">${escapeHtml(isSentByUs ? m.body_text.replace('[You replied]:\n','') : (m.body_text || m.body_html || '(No content)'))}</div>
                </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }).join('');

      area.innerHTML = `
        <div class="section-header">
          <h2 class="section-title">Centralized Inbox</h2>
        </div>
        ${threadHtml}
      `;

      // Mark all as read when viewed
      replies.filter(r => !r.is_read).forEach(r => API.post(`/api/inbox/${r.id}/read`));

    } catch(err) {
      area.innerHTML = `<div class="card"><p class="text-muted">Error: ${err.message}</p></div>`;
    }
  },

  async pauseContact(contactId, campaignId) {
    if (!confirm("Pause all future automated follow-ups for this contact?")) return;
    try {
      await API.post('/api/inbox/pause-contact', { contact_id: contactId, campaign_id: campaignId });
      showToast('Automated follow-ups paused.', 'success');
      this.render();
    } catch(err) { showToast(err.message, 'error'); }
  },

  async resumeContact(contactId, campaignId) {
    try {
      await API.post('/api/inbox/resume-contact', { contact_id: contactId, campaign_id: campaignId });
      showToast('Automated follow-ups resumed.', 'success');
      this.render();
    } catch(err) { showToast(err.message, 'error'); }
  },

  openReplyModal(replyId, contactName) {
    openModal(`Reply to ${contactName}`, `
      <div class="form-group">
        <label class="form-label">Your Message</label>
        <textarea class="form-textarea" id="inbox-reply-text" rows="6" placeholder="Type your reply here..."></textarea>
      </div>
      <div class="btn-group mt-4">
        <button class="btn btn-primary" onclick="InboxComponent.sendReply(${replyId})">Send Reply</button>
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      </div>
    `);
  },

  async sendReply(replyId) {
    const text = document.getElementById('inbox-reply-text').value.trim();
    if (!text) { showToast('Message cannot be empty', 'error'); return; }

    const btn = document.querySelector('.modal .btn-primary');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      await API.post('/api/inbox/reply', { reply_id: replyId, text_body: text });
      closeModal();
      showToast('Reply sent successfully!', 'success');
      this.render(); // Refresh inbox
    } catch(err) {
      btn.disabled = false;
      btn.textContent = 'Send Reply';
      showToast(err.message, 'error');
    }
  }
};
