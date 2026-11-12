/* NutriReceitas — admin.js
   Painel do administrador: lista usuários do Firestore, mostra estatísticas
   de uso e permite promover/remover admin, desativar contas e apagar dados.

   Segurança: esconder o botão não protege nada. Quem protege são as regras
   do Firestore (firestore.rules): só quem tem role "admin" em /users/{uid}
   consegue ler os dados dos outros ou mudar papel/status. */

const Admin = {
  users: [],          // [{ uid, name, email, role, disabled, createdAt, lastLoginAt, data }]
  loading: false,
  openUid: null,      // usuário com os detalhes abertos
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
const asArray = (v) => Array.isArray(v) ? v : [];
const favTitle = (f) => (typeof f === 'string' ? byId(f)?.title : (f.recipeSnapshot?.title || byId(f.recipeId)?.title)) || 'Receita';

async function loadAdminData() {
  Admin.loading = true; renderAdmin();
  try {
    const users = await firebaseAdmin.listUsers();
    // Lê os dados de todos em paralelo (favoritos, estoque, cozinhei...)
    const datas = await Promise.all(users.map(u => firebaseAdmin.getUserData(u.uid).catch(() => ({}))));
    Admin.users = users
      .map((u, i) => ({ ...u, data: datas[i] }))
      .sort((a, b) => (b.lastLoginAt || '').localeCompare(a.lastLoginAt || ''));
    Admin.error = null;
  } catch (e) {
    console.error('[Admin]', e);
    Admin.error = e.code === 'permission-denied'
      ? 'Sem permissão para ler os usuários. Confira se sua conta tem role "admin" no Firestore e se as regras (firestore.rules) foram publicadas.'
      : 'Não foi possível carregar os dados: ' + e.message;
  }
  Admin.loading = false; renderAdmin();
}

function adminStats() {
  const s = { users: Admin.users.length, admins: 0, disabled: 0, favs: 0, stock: 0, cooked: 0, active7: 0 };
  const favCount = {}, ingCount = {};
  const weekAgo = Date.now() - 7 * 864e5;
  Admin.users.forEach(u => {
    if (u.role === 'admin') s.admins++;
    if (u.disabled) s.disabled++;
    if (u.lastLoginAt && new Date(u.lastLoginAt) > weekAgo) s.active7++;
    const favs = asArray(u.data?.favs), stock = asArray(u.data?.stock), cooked = asArray(u.data?.cooked);
    s.favs += favs.length; s.stock += stock.length; s.cooked += cooked.length;
    favs.forEach(f => { const t = favTitle(f); favCount[t] = (favCount[t] || 0) + 1; });
    stock.forEach(it => { const n = String(it.name || '').toLowerCase(); if (n) ingCount[n] = (ingCount[n] || 0) + 1; });
  });
  const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { s, topFavs: top(favCount), topIngs: top(ingCount) };
}

function renderAdmin() {
  const body = $('#admin-body');
  if (Admin.loading) { body.innerHTML = '<p class="text-[var(--ink-3)]">Carregando dados do Firebase…</p>'; return; }
  if (Admin.error)   { body.innerHTML = `<p class="text-[var(--danger)] font-semibold">${esc(Admin.error)}</p>`; return; }

  const { s, topFavs, topIngs } = adminStats();
  const stat = (label, value) => `
    <div class="rounded-2xl border border-[var(--line)] p-4">
      <div class="text-2xl font-bold">${value}</div>
      <div class="text-xs text-[var(--ink-3)] mt-1">${label}</div>
    </div>`;
  const rank = (title, rows, empty) => `
    <div class="rounded-2xl border border-[var(--line)] p-4">
      <h4 class="font-bold text-sm mb-2">${title}</h4>
      ${rows.length ? `<ol class="text-sm space-y-1 list-decimal list-inside">${rows.map(([n, c]) => `<li>${esc(n)} <span class="text-[var(--ink-3)]">(${c})</span></li>`).join('')}</ol>`
                    : `<p class="text-sm text-[var(--ink-3)]">${empty}</p>`}
    </div>`;

  body.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${stat('Usuários cadastrados', s.users)}
      ${stat('Ativos nos últimos 7 dias', s.active7)}
      ${stat('Administradores', s.admins)}
      ${stat('Contas desativadas', s.disabled)}
      ${stat('Receitas favoritadas', s.favs)}
      ${stat('Itens em estoque', s.stock)}
      ${stat('Receitas cozinhadas', s.cooked)}
      ${stat('Média de favoritos/usuário', s.users ? (s.favs / s.users).toFixed(1) : 0)}
    </div>
    <div class="grid md:grid-cols-2 gap-3 mt-3">
      ${rank('Receitas mais favoritadas', topFavs, 'Ninguém favoritou receitas ainda.')}
      ${rank('Ingredientes mais comuns no estoque', topIngs, 'Nenhum item em estoque ainda.')}
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 mt-6 mb-2">
      <h4 class="font-bold">Usuários</h4>
      <input id="admin-search" class="field !h-10 !w-64" placeholder="Buscar por nome ou e-mail" value="${esc(Admin.query || '')}">
    </div>
    <div class="overflow-x-auto rounded-2xl border border-[var(--line)]">
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-[var(--ink-3)] border-b border-[var(--line)]">
          <tr><th class="p-3">Usuário</th><th class="p-3">Papel</th><th class="p-3">Cadastro</th><th class="p-3">Último acesso</th>
              <th class="p-3 text-center">♡</th><th class="p-3 text-center">Estoque</th><th class="p-3 text-center">Cozinhei</th><th class="p-3"></th></tr>
        </thead>
        <tbody id="admin-rows">${adminRows()}</tbody>
      </table>
    </div>
    <p class="text-xs text-[var(--ink-3)] mt-3">Desativar impede o uso do site e bloqueia gravações no banco. Para excluir de vez a conta de login, use o Console do Firebase → Authentication.</p>`;

  $('#admin-search').addEventListener('input', e => { Admin.query = e.target.value; $('#admin-rows').innerHTML = adminRows(); });
}

function adminRows() {
  const q = (Admin.query || '').trim().toLowerCase();
  const list = Admin.users.filter(u => !q || `${u.name} ${u.email}`.toLowerCase().includes(q));
  if (!list.length) return `<tr><td colspan="8" class="p-4 text-center text-[var(--ink-3)]">Nenhum usuário encontrado.</td></tr>`;
  const me = state.user?.uid;
  return list.map(u => {
    const d = u.data || {};
    const favs = asArray(d.favs), stock = asArray(d.stock), cooked = asArray(d.cooked);
    const roleBadge = u.role === 'admin'
      ? '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-[var(--brown)] text-white">admin</span>'
      : '<span class="px-2 py-0.5 rounded-full text-xs border border-[var(--line)]">usuário</span>';
    const status = u.disabled ? ' <span class="px-2 py-0.5 rounded-full text-xs font-bold text-white bg-[var(--danger)]">desativado</span>' : '';
    const self = u.uid === me;
    const open = Admin.openUid === u.uid;
    return `
      <tr class="border-b border-[var(--line)] ${u.disabled ? 'opacity-60' : ''}">
        <td class="p-3"><div class="font-semibold">${esc(u.name || '—')}${self ? ' <span class="text-xs text-[var(--ink-3)]">(você)</span>' : ''}</div><div class="text-xs text-[var(--ink-3)]">${esc(u.email || '')}</div></td>
        <td class="p-3 whitespace-nowrap">${roleBadge}${status}</td>
        <td class="p-3 whitespace-nowrap">${fmtDate(u.createdAt)}</td>
        <td class="p-3 whitespace-nowrap">${fmtDate(u.lastLoginAt)}</td>
        <td class="p-3 text-center">${favs.length}</td>
        <td class="p-3 text-center">${stock.length}</td>
        <td class="p-3 text-center">${cooked.length}</td>
        <td class="p-3">
          <div class="flex flex-wrap gap-1.5 justify-end">
            <button class="btn btn-secondary btn-sm" data-admin-act="details" data-uid="${u.uid}">${open ? 'Fechar' : 'Detalhes'}</button>
            ${self ? '' : `
              <button class="btn btn-secondary btn-sm" data-admin-act="role" data-uid="${u.uid}">${u.role === 'admin' ? 'Remover admin' : 'Tornar admin'}</button>
              <button class="btn btn-secondary btn-sm" data-admin-act="disable" data-uid="${u.uid}">${u.disabled ? 'Reativar' : 'Desativar'}</button>
              <button class="btn btn-ghost btn-sm !text-[var(--danger)]" data-admin-act="clear" data-uid="${u.uid}">Apagar dados</button>`}
          </div>
        </td>
      </tr>
      ${open ? `<tr class="border-b border-[var(--line)]"><td colspan="8" class="p-4 bg-[var(--bg)]">${adminDetails(u)}</td></tr>` : ''}`;
  }).join('');
}

function adminDetails(u) {
  const d = u.data || {};
  const favs = asArray(d.favs), stock = asArray(d.stock), cooked = asArray(d.cooked);
  const list = (items, empty) => items.length
    ? `<ul class="text-sm space-y-1">${items.map(x => `<li>• ${x}</li>`).join('')}</ul>`
    : `<p class="text-sm text-[var(--ink-3)]">${empty}</p>`;
  return `
    <div class="grid md:grid-cols-3 gap-4">
      <div><h5 class="font-bold text-sm mb-1">Favoritos</h5>${list(favs.map(f => esc(favTitle(f))), 'Nenhum favorito.')}</div>
      <div><h5 class="font-bold text-sm mb-1">Estoque</h5>${list(stock.map(it => `${esc(it.name)} — ${esc(it.qty ?? '')} ${esc(it.unit ?? '')}${it.exp ? ` <span class="text-[var(--ink-3)]">(vence ${fmtDate(it.exp)})</span>` : ''}`), 'Estoque vazio.')}</div>
      <div><h5 class="font-bold text-sm mb-1">Cozinhei</h5>${list(cooked.slice(0, 10).map(c => `${esc(c.recipeSnapshot?.title || byId(c.recipeId)?.title || 'Receita')} <span class="text-[var(--ink-3)]">(${fmtDate(c.cookedAt)})</span>`), 'Nada preparado ainda.')}</div>
    </div>
    <p class="text-xs text-[var(--ink-3)] mt-3">ID (uid): ${esc(u.uid)}</p>`;
}

// Ações dos botões da tabela
$('#admin-modal').addEventListener('click', async e => {
  const btn = e.target.closest('[data-admin-act]'); if (!btn) return;
  const u = Admin.users.find(x => x.uid === btn.dataset.uid); if (!u) return;
  const act = btn.dataset.adminAct;

  if (act === 'details') {
    Admin.openUid = Admin.openUid === u.uid ? null : u.uid;
    $('#admin-rows').innerHTML = adminRows();
    return;
  }

  const who = u.name || u.email;
  try {
    btn.disabled = true;
    if (act === 'role') {
      const role = u.role === 'admin' ? 'user' : 'admin';
      if (!confirm(role === 'admin' ? `Tornar ${who} administrador(a)?` : `Remover o acesso de administrador de ${who}?`)) return;
      await firebaseAdmin.setRole(u.uid, role);
      u.role = role;
      toast(role === 'admin' ? `${who} agora é admin` : `${who} não é mais admin`);
    } else if (act === 'disable') {
      const disabled = !u.disabled;
      if (!confirm(disabled ? `Desativar a conta de ${who}? A pessoa não conseguirá usar o site.` : `Reativar a conta de ${who}?`)) return;
      await firebaseAdmin.setDisabled(u.uid, disabled);
      u.disabled = disabled;
      toast(disabled ? `Conta de ${who} desativada` : `Conta de ${who} reativada`);
    } else if (act === 'clear') {
      if (!confirm(`Apagar TODOS os dados de ${who} (favoritos, estoque, histórico)? Isso não pode ser desfeito.`)) return;
      const n = await firebaseAdmin.clearUserData(u.uid);
      u.data = {};
      toast(`${n} registro(s) de ${who} apagados`);
    }
    renderAdmin();
  } catch (err) {
    console.error('[Admin]', err);
    toast(err.code === 'permission-denied' ? 'Sem permissão (confira as regras do Firestore).' : 'Erro: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#admin-refresh').addEventListener('click', loadAdminData);

function openAdmin() {
  if (state.user?.role !== 'admin') { toast('Acesso restrito a administradores.'); return; }
  openModal($('#admin-modal'));
  loadAdminData();
}
