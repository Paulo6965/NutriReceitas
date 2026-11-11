/* NutriReceitas — notifications.js
   Avisos de validade do estoque: no site (sininho no cabeçalho) e por e-mail.

   Hoje (protótipo): os avisos são gerados no navegador a partir do estoque, e os e-mails
   ficam numa "caixa de saída" local com prévia — o envio real precisa de servidor.
   Com o banco: a função `supabase/functions/expiry-alerts` roda todo dia, cria as linhas
   em `notifications` e envia os e-mails (ver docs/BANCO-DE-DADOS.md). */

const NOTIFY_DEFAULTS = { site: true, email: true, days: EXPIRING_DAYS };

const Notify = {
  prefs() { return { ...NOTIFY_DEFAULTS, ...(db.get(userKey('notifyPrefs'), null) || {}) }; },
  savePrefs(p) { db.set(userKey('notifyPrefs'), { ...this.prefs(), ...p }); this.sync(); },
  all() { return db.get(userKey('notifications'), []); },
  save(list) { db.set(userKey('notifications'), list.slice(0, 100)); },
  outbox() { return db.get(userKey('emailOutbox'), []); },
  unread() { return this.all().filter(n => !n.read).length; },

  // Situação de um item: 'expired' (vencido), 'today' (vence hoje) ou 'soon' (vence em breve)
  statusOf(d) { return d < 0 ? 'expired' : d === 0 ? 'today' : 'soon'; },

  /* Gera avisos novos a partir do estoque. Idempotente: cada item gera no máximo
     um aviso por situação (vence em breve → vence hoje → venceu). */
  sync() {
    if (!state.user) { this.render(); return; }   // avisos são da conta
    const prefs = this.prefs();
    const list = this.all();
    const keys = new Set(list.map(n => n.key));
    const fresh = [];
    Stock.expiring().forEach(i => {
      const status = this.statusOf(i.d), key = `${i.id}:${status}:${i.exp}`;
      if (keys.has(key)) return;
      const emoji = stockEmoji(i);
      const title = status === 'expired' ? `${i.name} venceu` : status === 'today' ? `${i.name} vence hoje` : `${i.name} ${expLabel(i.d)}`;
      const body = status === 'expired'
        ? `Confira se ainda está bom para consumo antes de usar. Venceu em ${new Date(i.exp + 'T00:00:00').toLocaleDateString('pt-BR')}.`
        : `Você tem ${String(i.qty).replace('.', ',')} ${i.unit}. Que tal uma receita para aproveitar antes de estragar?`;
      fresh.push({ id: Date.now() + Math.random(), key, itemId: i.id, ingredient: i.key, emoji, title, body, status, createdAt: new Date().toISOString(), read: false });
    });
    if (fresh.length) {
      if (prefs.site) this.save([...fresh, ...list]);
      if (prefs.email) this.queueEmail(fresh);
    }
    this.render();
  },

  // E-mail: um resumo com todos os avisos novos (simulado: vai para a caixa de saída local)
  queueEmail(items) {
    const user = state.user; if (!user?.email) return;
    const subject = items.length === 1 ? `⏰ ${items[0].title}` : `⏰ ${items.length} itens do seu estoque precisam de atenção`;
    const mail = { id: Date.now(), to: user.email, subject, html: emailTemplate(user, items), createdAt: new Date().toISOString(), status: 'aguardando servidor de e-mail' };
    db.set(userKey('emailOutbox'), [mail, ...this.outbox()].slice(0, 20));
    // TODO (servidor): POST /api/notifications/email { to, subject, html } — ou deixar a Edge Function enviar sozinha
  },

  markAllRead() { this.save(this.all().map(n => ({ ...n, read: true }))); this.render(); },
  remove(id) { this.save(this.all().filter(n => n.id !== id)); this.render(); },

  render() {
    const badge = $('#notif-count');
    const n = state.user ? this.unread() : 0;
    badge.textContent = n; badge.classList.toggle('hidden', !n);
    $('#notif-btn').setAttribute('aria-label', n ? `Notificações: ${n} não lida${n > 1 ? 's' : ''}` : 'Notificações');
    if (!$('#notif-panel').classList.contains('hidden')) this.renderPanel();
  },

  renderPanel() {
    const panel = $('#notif-panel');
    if (!state.user) {
      panel.innerHTML = `
        <div class="p-5 text-center">
          <div class="text-3xl mb-2">🔔</div>
          <p class="font-bold">Avisos de validade</p>
          <p class="text-sm text-[var(--ink-3)] mt-1">Entre na sua conta para receber avisos no site e por e-mail quando algo do seu estoque estiver para vencer.</p>
          <button class="btn btn-primary btn-sm mt-4" data-notif-login>Entrar</button>
        </div>`;
      return;
    }
    const list = this.all(), p = this.prefs();
    const ico = { expired: 'n-bad', today: 'n-warn', soon: 'n-warn' };
    panel.innerHTML = `
      <div class="notif-head">
        <b>Notificações</b>
        ${list.some(x => !x.read) ? '<button class="text-xs font-bold text-[var(--green)] hover:underline" data-notif-readall>Marcar todas como lidas</button>' : ''}
      </div>
      <div class="notif-list">
        ${list.length ? list.map(x => `
          <div class="notif-item ${x.read ? '' : 'is-unread'}">
            <span class="notif-ico ${ico[x.status]}">${x.emoji}</span>
            <div class="min-w-0 flex-1">
              <p class="font-bold text-sm leading-snug">${esc(x.title)}</p>
              <p class="text-xs text-[var(--ink-2)] mt-0.5">${esc(x.body)}</p>
              <div class="flex flex-wrap gap-3 mt-1.5 text-xs font-bold">
                ${x.status !== 'expired' ? `<button class="text-[var(--green)] hover:underline" data-notif-cook="${x.id}">Ver receitas →</button>` : ''}
                <button class="text-[var(--ink-3)] hover:underline" data-notif-stock>Abrir estoque</button>
                <span class="text-[var(--ink-3)] font-semibold ml-auto">${fmtWhen(x.createdAt)}</span>
              </div>
            </div>
            <button class="icon-btn !w-7 !h-7 text-xs" data-notif-del="${x.id}" aria-label="Apagar aviso">✕</button>
          </div>`).join('')
        : `<div class="p-6 text-center text-sm text-[var(--ink-3)]">✅ Nada vencendo nos próximos ${p.days} dias.</div>`}
      </div>
      <div class="notif-prefs">
        <p class="filter-label mb-2">Preferências</p>
        <label class="notif-opt"><input type="checkbox" data-pref="site" ${p.site ? 'checked' : ''}> Avisos aqui no site</label>
        <label class="notif-opt"><input type="checkbox" data-pref="email" ${p.email ? 'checked' : ''}> Avisos por e-mail <span class="text-[var(--ink-3)] truncate">(${esc(state.user.email)})</span></label>
        <label class="notif-opt">Avisar com
          <select class="field field-sm !h-8 !py-0 !px-2" data-pref="days">${[1, 2, 3, 5, 7].map(d => `<option value="${d}" ${d === p.days ? 'selected' : ''}>${d} dia${d > 1 ? 's' : ''}</option>`).join('')}</select>
          de antecedência</label>
        ${this.outbox().length ? `<button class="text-xs font-bold text-[var(--green)] hover:underline mt-2" data-notif-mail>Ver o último e-mail de aviso →</button>` : ''}
      </div>`;
  },
  toggle(open) {
    const panel = $('#notif-panel');
    const show = open ?? panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !show);
    $('#notif-btn').setAttribute('aria-expanded', show);
    if (show) this.renderPanel();
  },
};

// ---- Modelo do e-mail (HTML com estilos inline, compatível com clientes de e-mail) ----
function emailTemplate(user, items) {
  const first = esc((user.name || '').split(' ')[0] || 'Chef');
  const rows = items.map(i => `
    <tr><td style="padding:12px 16px;border-bottom:1px solid #ECE5DB;font-size:15px;color:#24190F">
      <span style="font-size:20px;vertical-align:middle">${i.emoji}</span>&nbsp; <b>${esc(i.title)}</b><br>
      <span style="color:#6A5D51;font-size:13px">${esc(i.body)}</span>
    </td></tr>`).join('');
  return `
  <div style="background:#F3EFE8;padding:24px;font-family:Arial,Helvetica,sans-serif">
    <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border-collapse:collapse">
      <tr><td style="background:#10301F;padding:22px 24px;color:#ffffff">
        <span style="font-size:20px;font-weight:bold;font-family:Georgia,serif">🌿 NutriReceitas</span>
      </td></tr>
      <tr><td style="padding:24px 24px 8px;color:#24190F">
        <p style="margin:0 0 6px;font-size:20px;font-weight:bold;font-family:Georgia,serif">Olá, ${first}! ⏰</p>
        <p style="margin:0;font-size:15px;color:#43372D;line-height:1.5">Alguns itens do seu estoque estão perto do vencimento. Aproveite antes de estragar — separamos receitas que usam esses ingredientes.</p>
      </td></tr>
      <tr><td style="padding:12px 8px"><table role="presentation" width="100%" style="border-collapse:collapse">${rows}</table></td></tr>
      <tr><td style="padding:8px 24px 28px" align="center">
        <a href="${location.origin}${location.pathname}#results-section" style="display:inline-block;background:#1F5038;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Ver receitas para aproveitar</a>
      </td></tr>
      <tr><td style="padding:16px 24px;background:#F8F2EB;color:#6A5D51;font-size:12px;line-height:1.5">
        Você recebe este aviso porque ativou os alertas de validade no NutriReceitas.
        Para mudar, abra o sininho 🔔 no site e ajuste as preferências.
      </td></tr>
    </table>
  </div>`;
}

// ---- Prévia do e-mail ----
function openEmailPreview() {
  const mail = Notify.outbox()[0]; if (!mail) return;
  $('#email-preview-meta').innerHTML = `<b>Para:</b> ${esc(mail.to)}<br><b>Assunto:</b> ${esc(mail.subject)}<br><span class="text-[var(--ink-3)]">${fmtWhen(mail.createdAt)} · ${esc(mail.status)}</span>`;
  $('#email-preview-frame').srcdoc = mail.html;
  Notify.toggle(false);
  openModal($('#email-modal'));
}

// ---- Eventos ----
$('#notif-btn').addEventListener('click', e => { e.stopPropagation(); Notify.toggle(); });
document.addEventListener('click', e => { if (!e.target.closest('#notif-panel') && !e.target.closest('#notif-btn')) $('#notif-panel').classList.add('hidden'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') Notify.toggle(false); });
$('#notif-panel').addEventListener('click', e => {
  e.stopPropagation();
  if (e.target.closest('[data-notif-login]')) { Notify.toggle(false); openAuth(); return; }
  if (e.target.closest('[data-notif-readall]')) return Notify.markAllRead();
  const del = e.target.closest('[data-notif-del]'); if (del) return Notify.remove(+del.dataset.notifDel);
  if (e.target.closest('[data-notif-stock]')) { Notify.toggle(false); openStock(); return; }
  if (e.target.closest('[data-notif-mail]')) return openEmailPreview();
  const cook = e.target.closest('[data-notif-cook]');
  if (cook) {
    const n = Notify.all().find(x => x.id === +cook.dataset.notifCook);
    Notify.save(Notify.all().map(x => x.id === n?.id ? { ...x, read: true } : x));
    Notify.toggle(false);
    if (n?.ingredient) { addIngredient(n.ingredient); runSearch({ fromChat: false }); }
    Notify.render();
  }
});
$('#notif-panel').addEventListener('change', e => {
  const el = e.target.closest('[data-pref]'); if (!el) return;
  const k = el.dataset.pref;
  Notify.savePrefs({ [k]: k === 'days' ? +el.value : el.checked });
  renderStockPreview();
  toast(k === 'email' ? (el.checked ? '📧 Avisos por e-mail ativados' : 'Avisos por e-mail desativados') : k === 'site' ? (el.checked ? '🔔 Avisos no site ativados' : 'Avisos no site desativados') : `Aviso com ${el.value} dia(s) de antecedência`);
});
