/* NutriReceitas — store.js
   Estado da página, algoritmo de recomendação, favoritos e estoque (com validade). */

// ---------- Estado ----------
const state = {
  user: db.get('nr:session', null),
  ingredients: [],
  filters: { kind: 'all', taste: 'all', temp: 'all', diet: 'all' },
  qty: { kind: 'solid', value: 250, unit: 'g' },
  sort: 'relevance',
  highlight: false, // true depois de "Buscar receitas": destaca os cards encontrados
};

/* =====================================================================
   ALGORITMO DE RECOMENDAÇÃO (perfil de gosto por usuário)
   Pesos: busca = 1, ver receita = 2, favoritar = 4. Pontos antigos
   decaem (x0.97 a cada evento). Score = soma dos pesos das features.
   Futuro: eventos no back-end (ex.: tabela user_events no Supabase).
   ===================================================================== */
const Reco = {
  profile() { return db.get(userKey('profile'), { w: {}, events: 0 }); },
  save(p) { db.set(userKey('profile'), p); },
  track(features, weight) {
    const p = this.profile();
    for (const k in p.w) p.w[k] *= 0.97;
    features.forEach(f => { p.w[f] = (p.w[f] || 0) + weight; });
    p.events++; this.save(p); renderReco();
  },
  featuresOf(r) { return [...r.ingredients.map(i => 'ing:' + i), 'taste:' + r.taste, 'temp:' + r.temp, 'kind:' + r.kind, ...r.style.map(s => 'style:' + s)]; },
  trackSearch(ings, filters) {
    const f = ings.map(i => 'ing:' + i);
    if (filters.taste !== 'all') f.push('taste:' + filters.taste);
    if (filters.temp !== 'all') f.push('temp:' + filters.temp);
    if (filters.kind !== 'all') f.push('kind:' + filters.kind);
    if (f.length) this.track(f, 1);
  },
  trackView(r) { this.track(this.featuresOf(r), 2); },
  trackFav(r) { this.track(this.featuresOf(r), 4); },
  score(r, p = this.profile()) { return this.featuresOf(r).reduce((s, f) => s + (p.w[f] || 0), 0); },
  topFeatures(p = this.profile(), n = 3) { return Object.entries(p.w).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k); },
  recommend(n = 4) {
    const p = this.profile();
    if (!p.events) return { list: [...RECIPES].sort((a, b) => b.rating - a.rating).slice(0, n), cold: true };
    return { list: [...RECIPES].map(r => ({ r, s: this.score(r, p) + r.rating * 0.1 })).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.r), cold: false };
  },
};
const featureLabel = (f) => { const [t, v] = f.split(':'); return t === 'ing' ? pretty(v).toLowerCase() : (STYLE_LABEL[v] || v); };
const fmtRating = (n) => (Math.floor(n * 10) / 10).toFixed(1).replace('.', ',');
const joinPt = (arr) => arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' e ' + arr[arr.length - 1];

// ---------- Favoritos ----------
/* Cada favorito guarda a VERSÃO PERSONALIZADA da receita.
   Formato pensado para a tabela do banco (ex.: Supabase):
     favorites(user_id, recipe_id, servings int, included jsonb, adjustments jsonb, units jsonb, saved_at timestamptz)
   - servings:    porções escolhidas
   - included:    ingredientes incluídos (os que não estão aqui foram tirados)
   - adjustments: { ingrediente: multiplicador } — quantidade mudada à mão (1 = original)
   - units:       { ingrediente: 'kg' | 'g' | 'L' | 'ml' | 'un' } — unidade escolhida para exibir
   `config` nulo = receita original. */
const Favs = {
  all() {
    const raw = db.get(userKey('favs'), []);
    // migração: versões antigas guardavam só o id
    return raw.map(f => typeof f === 'string' ? { recipeId: f, config: null, savedAt: null } : f);
  },
  save(list) { db.set(userKey('favs'), list); updateBadges(); },
  has(id) { return this.all().some(f => f.recipeId === id); },
  get(id) { return this.all().find(f => f.recipeId === id) || null; },
  // Salva (ou atualiza) com a configuração atual da receita
  put(id, config = null, recipeSnapshot = null) {
    const list = this.all(), i = list.findIndex(f => f.recipeId === id);
    const existing = i >= 0 ? list[i] : null;
    const snapshot = recipeSnapshot || (existing ? existing.recipeSnapshot : null) || byId(id);
    const entry = { recipeId: id, config, savedAt: new Date().toISOString(), recipeSnapshot: snapshot };
    if (i >= 0) list[i] = entry; else { list.push(entry); if (snapshot) Reco.trackFav(snapshot); }
    this.save(list);
  },
  remove(id) { this.save(this.all().filter(f => f.recipeId !== id)); },
  // Coração dos cards: alterna salvando a receita original
  toggle(id, recipeSnapshot = null) {
    if (this.has(id)) { this.remove(id); return false; }
    this.put(id, null, recipeSnapshot);
    return true;
  },
};

/* ---------- Sessão de busca e conversa ----------
   A busca continua no localStorage; o chat é temporário e vive somente na
   sessão da aba. Assim, atualizar a página mantém a conversa, mas fechar a
   aba/janela elimina o histórico. */
const Session = {
  _restoring: true,   // só começa a salvar depois que a sessão salva foi carregada (evita sobrescrever com vazio)
  save() {
    if (Session._restoring) return;
    db.set(userKey('session'), { ingredients: state.ingredients, filters: state.filters, sort: state.sort, qty: state.qty, updatedAt: new Date().toISOString() });
  },
  load() { return db.get(userKey('session'), null); },
};
const ChatHistory = {
  MAX: 40,
  key() { return `nr:chat-session:${(state.user && state.user.email) || 'guest'}`; },
  all() {
    try {
      // Remove o formato antigo persistido para não reaparecer após a migração.
      localStorage.removeItem(userKey('chat'));
      return JSON.parse(sessionStorage.getItem(this.key()) || '[]');
    } catch { return []; }
  },
  save(msgs) {
    try { sessionStorage.setItem(this.key(), JSON.stringify(msgs.slice(-this.MAX))); } catch {}
  },
  clear() {
    try { sessionStorage.removeItem(this.key()); } catch {}
    try { localStorage.removeItem(userKey('chat')); } catch {}
  },
};

/* ---------- Histórico "Cozinhei" ----------
   Cada vez que a pessoa clica em "Cozinhei!", registra a versão preparada.
   Formato pensado para a tabela do banco:
     cooked(id, user_id, recipe_id, config jsonb, kcal_total int, kcal_per_serving int, used_from_stock jsonb, cooked_at timestamptz) */
const Cooked = {
  all() { return db.get(userKey('cooked'), []); },
  add(entry) {
    const list = this.all();
    const item = { id: Date.now(), cookedAt: new Date().toISOString(), ...entry };
    list.unshift(item);                       // mais recente primeiro
    db.set(userKey('cooked'), list.slice(0, 200)); updateBadges();
    return item;
  },
  remove(id) { db.set(userKey('cooked'), this.all().filter(c => c.id !== id)); updateBadges(); },
};

// ---------- Estoque ----------
const UNITS = { solid: ['g', 'kg'], liquid: ['ml', 'L'], unit: ['unidades', 'caixas', 'pacotes', 'latas'] };
// Datas de validade: "YYYY-MM-DD"; daysLeft < 0 = vencido
const isoIn = (d) => { const t = new Date(); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };
const daysLeft = (iso) => { if (!iso) return null; const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((new Date(iso + 'T00:00:00') - t) / 86400000); };
const expLabel = (d) => d === null ? '' : d < 0 ? `venceu há ${-d} dia${d === -1 ? '' : 's'}` : d === 0 ? 'vence hoje' : d === 1 ? 'vence amanhã' : `vence em ${d} dias`;
const expClass = (d) => d === null ? '' : d < 0 ? 'exp-bad' : d <= 3 ? 'exp-warn' : 'exp-ok';
const EXPIRING_DAYS = 3; // padrão; cada pessoa pode mudar nas preferências de notificação
const alertDays = () => db.get(userKey('notifyPrefs'), null)?.days ?? EXPIRING_DAYS;
const Stock = {
  all() { return db.get(userKey('stock'), null) ?? [
    { id: 1, name: 'Queijo parmesão', kind: 'solid', qty: 250, unit: 'g', note: '', exp: isoIn(20) },
    { id: 2, name: 'Leite', kind: 'liquid', qty: 5, unit: 'L', note: '5 caixas de 1L', exp: isoIn(2) },
    { id: 3, name: 'Ovo', kind: 'unit', qty: 12, unit: 'unidades', note: '', exp: isoIn(10) },
  ]; },
  keyOf(i) { return canonical(i.name) || canonical(i.name.split(' ')[0]); },
  // Quanto existe de um ingrediente (somando itens), na unidade base
  amountOf(key) {
    let total = 0, unit = null, unknown = false;
    this.all().filter(i => this.keyOf(i) === key).forEach(i => {
      const [q, u] = toBase(i.qty, i.unit);
      if (u === 'outro') { unknown = true; return; }
      if (!unit) unit = u;
      if (u === unit) total += q; else unknown = true;
    });
    return { total, unit, unknown, has: total > 0 || unknown };
  },
  // Itens que vencem em até EXPIRING_DAYS dias (ou já venceram), mais urgentes primeiro
  expiring() {
    return this.all().map(i => ({ ...i, d: daysLeft(i.exp), key: this.keyOf(i) }))
      .filter(i => i.d !== null && i.d <= alertDays() && i.qty > 0).sort((a, b) => a.d - b.d);
  },
  save(list) { db.set(userKey('stock'), list); updateBadges(); },
  add(item) { const l = this.all(); l.push({ id: Date.now(), ...item }); this.save(l); },
  remove(id) { this.save(this.all().filter(i => i.id !== id)); },
  update(id, patch) { this.save(this.all().map(i => i.id === id ? { ...i, ...patch } : i)); },
  keys() { return this.all().filter(i => i.qty > 0).map(i => this.keyOf(i)).filter(Boolean); },
};
const KIND_LABEL = { solid: ['Sólido', 'kind-solid'], liquid: ['Líquido', 'kind-liquid'], unit: ['Unidade', 'kind-unit'] };
const stockEmoji = (i) => { const k = canonical(i.name) || canonical(i.name.split(' ')[0]); return k ? emojiFor(k) : '🧺'; };

