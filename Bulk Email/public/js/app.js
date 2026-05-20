// Main App Router & State
const App = {
  currentRoute: 'dashboard',
  routes: { dashboard: DashboardComponent, accounts: AccountsComponent, templates: TemplatesComponent, contacts: ContactsComponent, campaigns: CampaignsComponent, inbox: InboxComponent },

  init() {
    window.addEventListener('hashchange', () => this.navigate());
    document.getElementById('menuToggle').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });

    const themeToggle = document.getElementById('themeToggle');
    if (localStorage.getItem('theme') === 'dark') {
      document.body.classList.add('dark-theme');
    }
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        document.body.classList.toggle('dark-theme');
        localStorage.setItem('theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
      });
    }

    this.navigate();
  },

  navigate() {
    const hash = window.location.hash.slice(2) || 'dashboard';
    const route = hash.split('?')[0];
    if (!this.routes[route]) { window.location.hash = '#/dashboard'; return; }

    this.currentRoute = route;
    document.getElementById('sidebar').classList.remove('open');

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.route === route);
    });

    // Update page title
    const titles = { dashboard: 'Dashboard', accounts: 'Gmail Accounts', templates: 'Email Templates', contacts: 'Contacts', campaigns: 'Campaigns', inbox: 'Centralized Inbox' };
    document.getElementById('pageTitle').textContent = titles[route] || route;

    // Render component
    const component = this.routes[route];
    if (component && component.render) {
      document.getElementById('contentArea').innerHTML = '<div class="spinner"></div>';
      component.render();
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
