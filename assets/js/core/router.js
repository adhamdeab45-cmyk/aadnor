import { $$ } from "./utils.js";

export function setupTabs(defaultTab = "home") {
  function activate(tab) {
    $$('[data-page]').forEach(p => p.hidden = p.dataset.page !== tab);
    $$('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    localStorage.setItem('adnor_tab', tab);
  }
  $$('[data-tab]').forEach(btn => btn.addEventListener('click', () => activate(btn.dataset.tab)));
  activate(localStorage.getItem('adnor_tab') || defaultTab);
  return { activate };
}
