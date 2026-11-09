/* NutriReceitas — modals.js
   Janelas: acessibilidade/foco, receita (porções, "Cozinhei!"), favoritos e estoque. */

// =====================================================================
//  MODAIS
// =====================================================================
// Acessibilidade: foco vai para dentro da janela, fica preso nela (Tab) e volta ao fechar
const FOCUSABLE = 'button:not([disabled]), [href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';
const focusables = (el) => $$(FOCUSABLE, el).filter(x => x.offsetParent !== null);
function openModal(el) {
  if (!el.classList.contains('open')) el._returnFocus = document.activeElement;
  el.classList.add('open'); document.body.style.overflow = 'hidden';
  setTimeout(() => { if (!el.contains(document.activeElement)) (focusables(el).find(x => !x.matches('[data-close]')) || focusables(el)[0])?.focus(); }, 60);
}
function closeModal(el) {
  el.classList.remove('open');
  if (el.id === 'auth-modal') AuthArt.stop();
  if (!$('.overlay.open')) document.body.style.overflow = '';
  const back = el._returnFocus; el._returnFocus = null;
  if (back && document.contains(back)) back.focus();
}
document.addEventListener('keydown', e => {
  // Enter/Espaço em um card de receita abre a receita
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-card]')) { e.preventDefault(); openRecipe(e.target.dataset.card); return; }
  if (e.key !== 'Tab') return;
  const open = $$('.overlay.open').pop(); if (!open) return;
  const f = focusables(open); if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !open.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
$$('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o || e.target.closest('[data-close]')) closeModal(o); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.overlay.open').forEach(closeModal); });

// ---- Receita ----
const favLabel = (id) => Favs.has(id) ? '♥ Salva nos favoritos' : '♡ Salvar nos favoritos';
let modalRecipe = null, modalServes = 1;
let modalInc = new Set();    // ingredientes incluídos na receita (o que a pessoa tem/comprou)
let modalOwned = new Set();  // o que ela já tinha ao abrir (lista do chat ou estoque)
let modalAdj = {};           // ajuste manual de quantidade por ingrediente (multiplicador sobre a receita)
let modalUnit = {};          // unidade escolhida para exibir/editar cada ingrediente (g/kg, ml/L, un)

// Escala final de um ingrediente = porções × ajuste manual
const ingFactor = (k) => (modalServes / modalRecipe.serves) * (modalAdj[k] ?? 1);
// Unidades de exibição possíveis para a unidade base do ingrediente
const UNIT_OPTS = { g: ['g', 'kg'], ml: ['ml', 'L'], un: ['un', 'g'] };
const UNIT_MULT = { g: 1, kg: 1000, ml: 1, L: 1000, un: 1 };
// Quantas unidades-base cabem em 1 da unidade escolhida (ovo em "g": 1 g = 1/50 un)
const unitMult = (k, baseU, unit) => baseU === 'un' && unit === 'g' ? 1 / (Nutrition.ref(k)?.unitG || 100) : UNIT_MULT[unit];
// Passo do − / + na unidade base, proporcional ao tamanho da quantidade
const qtyStep = (base, u) => u === 'un' ? 1 : base < 100 ? 10 : base < 1000 ? 50 : 100;
const fmtInput = (v, unit) => {
  const r = unit === 'g' || unit === 'ml' ? Math.round(v) : unit === 'un' ? Math.round(v * 2) / 2 : Math.round(v * 100) / 100;
  return String(r).replace('.', ',');
};

// Porções iniciais: se o usuário aplicou "Porção" nos filtros, converte a quantidade em porções
function initialServes(r) {
  if (!state.qty.applied) return r.serves;
  const [want] = toBase(state.qty.value, state.qty.unit);
  return Math.max(1, Math.round(want / (r.yield[0] / r.serves)));
}
// Compara o que a receita pede (já escalado) com o estoque e a lista do chat
function ingredientStatus(r, k, factor) {
  const [q, u] = r.amounts[k]; const need = q * factor;
  const st = Stock.amountOf(k);
  if (st.total > 0 && st.unit === u) {
    return st.total >= need ? { cls: 'ok', text: '✓ tem no estoque' } : { cls: 'warn', text: `tem ${fmtQty(st.total, u)} · faltam ${fmtQty(need - st.total, u)}` };
  }
  if (st.has) return { cls: 'ok', text: '✓ tem no estoque' };
  if (state.ingredients.includes(k)) return { cls: 'ok', text: '✓ na sua lista' };
  return { cls: 'miss', text: 'falta' };
}

/* Monta o modo de preparo só com os ingredientes incluídos.
   Passos estruturados: { t: 'texto com {prefixo:ingr1,ingr2}', req: [ingredientes necessários] }
   - um trecho {prefixo:...} some se nenhum dos ingredientes dele estiver incluído;
   - o passo inteiro some se nenhum ingrediente de `req` estiver incluído.
   Passos em texto simples (ex.: vindos da API) somem se só citarem ingredientes ausentes. */
function buildSteps(r, inc) {
  return r.steps.map(s => {
    if (typeof s === 'string') {
      const n = norm(s), cited = r.ingredients.filter(k => n.includes(norm(pretty(k))));
      return cited.length && !cited.some(k => inc.has(k)) ? null : s;
    }
    if (s.req.length && !s.req.some(k => inc.has(k))) return null;
    let t = s.t.replace(/\{([^:}]*):([^}]+)\}/g, (_, pre, keys) => {
      const ok = keys.split(',').map(x => x.trim()).filter(k => inc.has(k));
      return ok.length ? pre + joinPt(ok.map(k => pretty(k).toLowerCase())) : '';
    });
    t = t.replace(/\s+([,.;])/g, '$1').replace(/\s{2,}/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }).filter(Boolean);
}

function renderRecipeModal() {
  const r = modalRecipe, factor = modalServes / r.serves;
  const nut = Nutrition.recipe(r, ingFactor, modalInc);           // nutrientes por ingrediente + totais (só incluídos)
  const nutOf = Object.fromEntries(nut.items.map(x => [x.k, x]));
  const exact = !!r.kcalExact || nut.exact, approx = exact ? '' : '≈';
  const per = {}; NUTRI_KEYS.forEach(x => per[x] = nut.total[x] / modalServes);
  if (r.kcalExact && modalInc.size === r.ingredients.length) per.kcal = r.kcalExact;

  const rows = r.ingredients.map(k => {
    const inc = modalInc.has(k), st = ingredientStatus(r, k, ingFactor(k));
    let status;
    if (inc) status = modalOwned.has(k) ? st : { cls: 'ok', text: '✓ adicionado' };
    else status = modalOwned.has(k) ? { cls: 'miss', text: 'removido' } : { cls: 'miss', text: 'falta' };
    const [q, u] = r.amounts[k];
    const base = q * ingFactor(k);                                   // quantidade atual na unidade base
    const unit = UNIT_OPTS[u]?.includes(modalUnit[k]) ? modalUnit[k] : (base >= 1000 && u !== 'un' ? UNIT_OPTS[u][1] : u);
    return { k, inc, st: status, u, unit, base, shown: base / unitMult(k, u, unit), adjusted: Math.abs((modalAdj[k] ?? 1) - 1) > 0.001, n: nutOf[k].n };
  });
  const anyAdjusted = rows.some(x => x.adjusted);
  const excluded = rows.filter(x => !x.inc), short = rows.filter(x => x.inc && x.st.cls === 'warn');
  const steps = buildSteps(r, modalInc);
  const diets = dietsOf(r);
  const banner = excluded.length
    ? `<div class="mt-4 text-sm px-3 py-2.5 rounded-lg bg-[var(--brown-50)] text-[var(--ink-2)] flex flex-wrap items-center gap-x-3 gap-y-1"><span><span class="nudge">Preparando sem:</span> ${esc(joinPt(excluded.map(x => pretty(x.k).toLowerCase())))}. O modo de preparo foi ajustado.</span><button class="text-xs font-bold text-[var(--green)] hover:underline" data-ing-all>Usar receita completa</button></div>`
    : `<p class="mt-4 text-sm px-3 py-2 rounded-lg bg-[var(--green-50)] font-bold text-[var(--green)]">✓ Receita completa</p>`;
  const favEntry = Favs.get(r.id);
  const favNote = favEntry && favEntry.config
    ? `<div class="mt-3 text-sm px-3 py-2.5 rounded-lg border border-[var(--line)] flex flex-wrap items-center gap-x-3 gap-y-1"><span>❤️ <b>Sua versão salva</b>${configSummary(r, favEntry.config) ? ': ' + esc(configSummary(r, favEntry.config)) : ''}${favState() === 'changed' ? ' <span class="nudge">(com alterações não salvas)</span>' : ''}</span><button class="text-xs font-bold text-[var(--green)] hover:underline" data-original>Ver receita original</button></div>`
    : '';
  const shortNote = short.length ? `<p class="mt-2 text-sm text-[var(--ink-2)]"><span class="nudge">Pouca quantidade:</span> ${esc(joinPt(short.map(x => pretty(x.k).toLowerCase())))}.</p>` : '';
  const nLine = (n) => n ? `<span class="ing-nut"><b>${approx}${fmtN(n.kcal)} kcal</b><span>P ${fmtN(n.p)} g</span><span>C ${fmtN(n.c)} g</span><span>G ${fmtN(n.g)} g</span></span>` : '<span class="ing-nut"><span>sem dados nutricionais</span></span>';

  $('#recipe-modal-body').innerHTML = `
    <div class="relative aspect-[16/9] bg-[var(--brown-50)]">
      <img src="${r.img}" alt="" class="w-full h-full object-cover" onerror="this.remove()">
      <div class="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent"></div>
      <button class="icon-btn absolute top-3 right-3 !bg-[var(--surface-glass)] shadow" data-close aria-label="Fechar">✕</button>
      <div class="absolute bottom-4 left-4 sm:left-5 flex flex-wrap gap-2"><span class="pill">${ICON.clock}${r.time} min</span><span class="pill">${ICON.fire}${approx}${Math.round(per.kcal)} kcal/porção</span></div>
    </div>
    <div class="p-5 sm:p-7">
      <div class="flex items-center justify-between gap-3 flex-wrap"><span class="cat">${catLabel(r)}</span><span class="meta"><span class="rating">${ICON.star}${fmtRating(r.rating)} <span class="font-normal text-[var(--ink-3)]">(${r.reviews} avaliações)</span></span></span></div>
      <h3 id="recipe-title" class="font-display text-2xl sm:text-[30px] font-semibold mt-2 leading-tight">${esc(r.title)}</h3>
      <p class="text-[var(--ink-2)] mt-2">${esc(r.desc)}</p>
      ${diets.length ? `<div class="flex flex-wrap gap-1.5 mt-3">${diets.map(d => `<span class="tag have">✓ ${DIET_LABEL[d]}</span>`).join('')}</div>` : ''}

      <div class="grid grid-cols-4 gap-2 mt-5" aria-label="Informação nutricional por porção">
        <div class="macro"><b>${approx}${Math.round(per.kcal)}</b><span>kcal</span></div>
        <div class="macro"><b>${fmtN(per.p)} g</b><span>proteína</span></div>
        <div class="macro"><b>${fmtN(per.c)} g</b><span>carboidrato</span></div>
        <div class="macro"><b>${fmtN(per.g)} g</b><span>gordura</span></div>
      </div>
      <p class="mt-2 text-xs text-[var(--ink-3)] flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="kcal-src ${exact ? 'is-exact' : ''}">${exact ? '✓ Valores exatos' : '≈ Estimativa'}</span>
        <span>Por porção, com os ingredientes incluídos. Receita inteira (${modalServes} ${modalServes === 1 ? 'porção' : 'porções'}): <b class="text-[var(--ink-2)]">${approx}${Math.round(nut.total.kcal)} kcal</b></span>
      </p>
      ${favNote}${banner}${shortNote}

      <div class="flex flex-wrap items-center justify-between gap-3 mt-6">
        <h4 class="filter-label">Ingredientes</h4>
        <div class="flex items-center gap-2 text-sm">
          <span class="text-[var(--ink-3)]">Porções</span>
          <div class="stepper"><button data-serv="-1" aria-label="Menos porções">−</button><span class="!min-w-[44px]" aria-live="polite">${modalServes}</span><button data-serv="1" aria-label="Mais porções">+</button></div>
          <span class="text-xs text-[var(--ink-3)]">rende ~${fmtQty(r.yield[0] * factor, r.yield[1])}</span>
        </div>
      </div>
      <p class="text-xs text-[var(--ink-3)] mt-1">Ajuste a quantidade de cada ingrediente como quiser. No botão à direita, <b>+</b> inclui o que você comprou ou tem e <b>−</b> tira o que não tem — o modo de preparo se ajusta na hora.${anyAdjusted ? ' <button class="font-bold text-[var(--green)] hover:underline" data-qreset>Restaurar quantidades</button>' : ''}</p>
      <div class="grid md:grid-cols-[1.25fr_1fr] gap-7 mt-3">
        <ul class="space-y-2 text-sm">${rows.map(x => `
          <li class="ing-row ${x.inc ? '' : 'is-off'}">
            <div class="min-w-0 flex-1">
              <div class="ing-name">${emojiFor(x.k)} <b>${esc(pretty(x.k))}</b>${x.adjusted ? '<span class="adj-badge">ajustado</span>' : ''}</div>
              <div class="qty-ctl" role="group" aria-label="Quantidade de ${esc(pretty(x.k).toLowerCase())}">
                <button data-qstep="-1" data-k="${esc(x.k)}" aria-label="Diminuir ${esc(pretty(x.k).toLowerCase())}">−</button>
                <input type="text" inputmode="decimal" data-qin="${esc(x.k)}" value="${fmtInput(x.shown, x.unit)}" aria-label="Digite a quantidade em ${x.unit}" title="Clique e digite a quantidade" onfocus="this.select()">
                ${UNIT_OPTS[x.u].length > 1
                  ? `<select data-qunit="${esc(x.k)}" aria-label="Unidade">${UNIT_OPTS[x.u].map(o => `<option ${o === x.unit ? 'selected' : ''}>${o}</option>`).join('')}</select>`
                  : `<span class="qty-unit">${x.unit}</span>`}
                <button data-qstep="1" data-k="${esc(x.k)}" aria-label="Aumentar ${esc(pretty(x.k).toLowerCase())}">+</button>
              </div>
              ${nLine(x.n)}
            </div>
            <span class="ing-st ${x.st.cls}">${x.st.text}</span>
            <button class="ing-toggle ${x.inc ? 'is-in' : ''}" data-ing="${esc(x.k)}" aria-pressed="${x.inc}" aria-label="${x.inc ? 'Tirar' : 'Incluir'} ${esc(pretty(x.k).toLowerCase())}" title="${x.inc ? 'Não tenho — tirar da receita' : 'Comprei / tenho — incluir na receita'}">${x.inc ? '−' : '+'}</button>
          </li>`).join('')}</ul>
        <div>
          <h4 class="filter-label mb-3">Modo de preparo</h4>
          ${steps.length ? `<ol class="space-y-3 text-sm text-[var(--ink-2)]" aria-live="polite">${steps.map((s, i) => `<li class="flex gap-3 step-in"><span class="w-6 h-6 rounded-full bg-[var(--green)] text-white text-xs font-bold flex items-center justify-center flex-shrink-0">${i + 1}</span><span class="pt-0.5">${esc(s)}</span></li>`).join('')}</ol>`
            : '<p class="text-sm text-[var(--ink-3)]">Inclua ingredientes para ver o modo de preparo.</p>'}
        </div>
      </div>
      <div class="flex flex-col sm:flex-row gap-2 mt-7">
        ${favButtonHTML()}
        <button class="btn btn-brown" id="cook-btn" title="Desconta do estoque os ingredientes incluídos">🍳 Cozinhei!</button>
        <button class="btn btn-secondary" data-close>Fechar</button>
      </div>
    </div>`;
}
// ---- Versão personalizada da receita (salva nos favoritos) ----
function currentConfig() {
  const adj = {}; Object.entries(modalAdj).forEach(([k, v]) => { if (Math.abs(v - 1) > 0.001) adj[k] = +v.toFixed(4); });
  return { servings: modalServes, included: modalRecipe.ingredients.filter(k => modalInc.has(k)), adjustments: adj, units: { ...modalUnit } };
}
const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isOriginal = (r, c) => c.servings === r.serves && c.included.length === r.ingredients.length && !Object.keys(c.adjustments).length;
function applyConfig(r, c) {
  modalServes = c.servings || r.serves;
  modalInc = new Set((c.included || r.ingredients).filter(k => r.ingredients.includes(k)));
  modalAdj = { ...(c.adjustments || {}) };
  modalUnit = { ...(c.units || {}) };
}
// Resumo legível da personalização (para os cards de favoritos e a janela)
function configSummary(r, c) {
  if (!c) return '';
  const parts = [];
  if (c.servings !== r.serves) parts.push(`${c.servings} ${c.servings === 1 ? 'porção' : 'porções'}`);
  const out = r.ingredients.filter(k => !c.included.includes(k));
  if (out.length) parts.push(`sem ${joinPt(out.map(k => pretty(k).toLowerCase()))}`);
  const adj = Object.keys(c.adjustments || {});
  if (adj.length) parts.push(`${joinPt(adj.map(k => pretty(k).toLowerCase()))} ${adj.length === 1 ? 'ajustado' : 'ajustados'}`);
  return parts.join(' · ');
}
// Estado do botão de favorito comparando a versão atual com a salva
function favState() {
  const f = Favs.get(modalRecipe.id); if (!f) return 'none';
  const saved = f.config || currentConfigOriginal();
  return sameConfig(saved, currentConfig()) ? 'saved' : 'changed';
}
const currentConfigOriginal = () => ({ servings: modalRecipe.serves, included: [...modalRecipe.ingredients], adjustments: {}, units: {} });
function favButtonHTML() {
  const s = favState();
  if (s === 'none') return `<button class="btn btn-primary flex-1" id="modal-fav-btn" data-fav-action="save">♡ Salvar nos favoritos</button>`;
  if (s === 'changed') return `<button class="btn btn-primary flex-1" id="modal-fav-btn" data-fav-action="update" title="Salvar as alterações feitas nesta receita">↻ Atualizar favorito com as alterações</button>`;
  return `<button class="btn btn-primary flex-1" id="modal-fav-btn" data-fav-action="remove" title="Remover dos favoritos">♥ Salva nos favoritos</button>`;
}

function openRecipe(id) {
  const r = byId(id); if (!r) return;
  Reco.trackView(r);
  modalRecipe = r; modalServes = initialServes(r); modalAdj = {}; modalUnit = {};
  modalOwned = new Set(r.ingredients.filter(k => ingredientStatus(r, k, 1).cls !== 'miss'));
  // Começa com o que a pessoa tem; se ela não tem nada da receita, mostra a receita completa
  modalInc = new Set(modalOwned.size ? modalOwned : r.ingredients);
  // Receita favoritada: abre na versão que a pessoa salvou
  const fav = Favs.get(id);
  if (fav) applyConfig(r, fav.config || currentConfigOriginal());
  renderRecipeModal();
  openModal($('#recipe-modal'));
}
// "Cozinhei!": desconta do estoque os ingredientes incluídos (primeiro dos itens que vencem antes)
function cookRecipe() {
  const r = modalRecipe;
  const list = Stock.all();
  const used = [];
  r.ingredients.filter(k => modalInc.has(k)).forEach(k => {
    const [q, u] = r.amounts[k]; let need = q * ingFactor(k);       // quantidade ajustada
    if (u === 'un') need = Math.max(1, Math.ceil(need - 0.05));
    list.filter(i => Stock.keyOf(i) === k).sort((a, b) => (daysLeft(a.exp) ?? 9999) - (daysLeft(b.exp) ?? 9999)).forEach(i => {
      if (need <= 0) return;
      const [have, hu] = toBase(i.qty, i.unit); if (hu !== u) return;
      const take = Math.min(have, need); need -= take;
      const mult = /^(kg|l)$/i.test(i.unit) ? 1000 : 1;
      i.qty = +((have - take) / mult).toFixed(2);
      used.push(`${fmtQty(take, u)} de ${pretty(k).toLowerCase()}`);
    });
  });
  if (used.length) Stock.save(list.filter(i => i.qty > 0));
  Reco.track(Reco.featuresOf(r), 3);
  // Registra no histórico a versão exata que foi preparada
  const nut = Nutrition.recipe(r, ingFactor, modalInc);
  const entry = Cooked.add({
    recipeId: r.id, config: currentConfig(),
    kcalTotal: Math.round(nut.total.kcal), kcalPerServing: Math.round(nut.total.kcal / modalServes),
    usedFromStock: used,
  });
  closeModal($('#recipe-modal'));
  openCooked(entry.id);
  toast(used.length ? `Bom apetite! 🍽️ Estoque atualizado: −${joinPt(used)}` : 'Bom apetite! 🍽️ Receita registrada em Cozinhei');
}

// ---- Cozinhei (histórico) ----
const fmtWhen = (iso) => {
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  const hh = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return days === 0 ? `Hoje, ${hh}` : days === 1 ? `Ontem, ${hh}` : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) + `, ${hh}`;
};
function renderCooked(highlightId = null) {
  const list = Cooked.all().map(c => ({ c, r: byId(c.recipeId) })).filter(x => x.r);
  const weekAgo = Date.now() - 7 * 86400000;
  const week = list.filter(x => new Date(x.c.cookedAt) >= weekAgo);
  $('#cooked-stats').innerHTML = list.length ? `
    <div class="grid grid-cols-3 gap-2">
      <div class="macro"><b>${list.length}</b><span>receitas preparadas</span></div>
      <div class="macro"><b>${week.length}</b><span>nos últimos 7 dias</span></div>
      <div class="macro"><b>${list.reduce((s, x) => s + (x.c.usedFromStock?.length || 0), 0)}</b><span>itens do estoque aproveitados</span></div>
    </div>` : '';
  $('#cooked-list').innerHTML = list.length
    ? list.map(({ c, r }) => `
      <article class="cooked-card ${c.id === highlightId ? 'is-new' : ''}" data-cooked="${c.id}" tabindex="0" role="button" aria-label="Abrir ${esc(r.title)} como você preparou">
        <div class="cooked-img"><img src="${r.img}" alt="" loading="lazy" onerror="this.remove()">${c.id === highlightId ? '<span class="pill best">✓ Acabou de cozinhar</span>' : ''}</div>
        <div class="p-4 flex flex-col gap-1.5 flex-1">
          <span class="text-xs font-bold text-[var(--ink-3)]">${fmtWhen(c.cookedAt)}</span>
          <h4 class="font-display font-semibold text-[17px] leading-snug">${esc(r.title)}</h4>
          <p class="text-xs text-[var(--ink-2)]">${c.config.servings} ${c.config.servings === 1 ? 'porção' : 'porções'} · ≈${c.kcalPerServing} kcal/porção</p>
          ${configSummary(r, c.config) ? `<p class="card-note">✎ ${esc(configSummary(r, c.config))}</p>` : ''}
          ${c.usedFromStock?.length ? `<p class="text-xs text-[var(--ink-3)]">📦 Usou do estoque: ${esc(joinPt(c.usedFromStock))}</p>` : ''}
          <div class="mt-auto pt-2 flex items-center justify-between">
            <span class="see-more">Fazer de novo →</span>
            <button class="text-xs font-semibold text-[var(--ink-3)] hover:text-[var(--danger)]" data-cooked-del="${c.id}" aria-label="Remover do histórico">Remover</button>
          </div>
        </div>
      </article>`).join('')
    : `<div class="col-span-full text-center py-12"><div class="text-4xl mb-3">🍳</div><p class="font-bold">Nada por aqui ainda</p><p class="text-sm text-[var(--ink-3)] mt-1">Abra uma receita e toque em <b>Cozinhei!</b> depois de preparar.</p></div>`;
}
function openCooked(highlightId = null) {
  renderCooked(highlightId); openModal($('#cooked-modal'));
  if (highlightId) setTimeout(() => $(`#cooked-modal [data-cooked="${highlightId}"]`)?.focus(), 80);
}
// Abre a receita exatamente como foi preparada naquele dia
function openCookedRecipe(id) {
  const c = Cooked.all().find(x => x.id === id); if (!c) return;
  closeModal($('#cooked-modal'));
  openRecipe(c.recipeId);
  applyConfig(modalRecipe, c.config); renderRecipeModal();
}
$('#open-cooked-btn').addEventListener('click', () => openCooked());
$('#cooked-list').addEventListener('click', e => {
  const del = e.target.closest('[data-cooked-del]');
  if (del) { e.stopPropagation(); Cooked.remove(+del.dataset.cookedDel); renderCooked(); return; }
  const card = e.target.closest('[data-cooked]'); if (card) openCookedRecipe(+card.dataset.cooked);
});
$('#cooked-list').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-cooked]')) { e.preventDefault(); openCookedRecipe(+e.target.dataset.cooked); }
});
$('#recipe-modal').addEventListener('click', e => {
  const fav = e.target.closest('#modal-fav-btn');
  if (fav) {
    const id = modalRecipe.id, cfg = currentConfig(), act = fav.dataset.favAction;
    const config = isOriginal(modalRecipe, cfg) && !Object.keys(cfg.units).length ? null : cfg; // original = sem config
    if (act === 'remove') { Favs.remove(id); toast('Removida dos favoritos'); }
    else { Favs.put(id, config); toast(act === 'update' ? '↻ Favorito atualizado com suas alterações' : config ? '❤️ Salva com suas alterações' : '❤️ Salva nos favoritos'); }
    renderRecipeModal(); $('#recipe-modal #modal-fav-btn')?.focus();
    renderResults(); renderReco();
    if ($('#favs-modal').classList.contains('open')) renderFavs();
    return;
  }
  const sv = e.target.closest('[data-serv]');
  if (sv) {
    modalServes = Math.min(20, Math.max(1, modalServes + +sv.dataset.serv));
    renderRecipeModal();
    $(`#recipe-modal [data-serv="${sv.dataset.serv}"]`).focus();
  }
  const tg = e.target.closest('[data-ing]');
  if (tg) {
    const k = tg.dataset.ing, adding = !modalInc.has(k);
    adding ? modalInc.add(k) : modalInc.delete(k);
    renderRecipeModal();
    $(`#recipe-modal [data-ing="${CSS.escape(k)}"]`)?.focus();   // mantém o foco no mesmo ingrediente
    toast(adding ? `${pretty(k)} incluído — modo de preparo atualizado` : `${pretty(k)} removido — modo de preparo ajustado`);
  }
  if (e.target.closest('[data-ing-all]')) { modalInc = new Set(modalRecipe.ingredients); renderRecipeModal(); }
  // − / + da quantidade de um ingrediente
  const qs = e.target.closest('[data-qstep]');
  if (qs) {
    const k = qs.dataset.k, [q, u] = modalRecipe.amounts[k];
    const base = q * ingFactor(k), step = qtyStep(base, u);
    const next = Math.max(step, Math.round((base + step * +qs.dataset.qstep) / step) * step); // nunca chega a zero (para tirar, use o botão −/+ da direita)
    setIngAmount(k, next, `[data-qstep="${qs.dataset.qstep}"][data-k="${CSS.escape(k)}"]`);
  }
  if (e.target.closest('[data-original]')) { applyConfig(modalRecipe, currentConfigOriginal()); renderRecipeModal(); toast('Mostrando a receita original — sua versão continua salva'); }
  if (e.target.closest('[data-qreset]')) { modalAdj = {}; renderRecipeModal(); toast('Quantidades restauradas'); }
});
// Define a quantidade (na unidade base) de um ingrediente e redesenha mantendo o foco
function setIngAmount(k, baseQty, focusSel) {
  const [q] = modalRecipe.amounts[k];
  const servF = modalServes / modalRecipe.serves;
  modalAdj[k] = baseQty / (q * servF);
  if (!modalInc.has(k)) modalInc.add(k);           // mexer na quantidade inclui o ingrediente
  renderRecipeModal();
  if (focusSel) $('#recipe-modal ' + focusSel)?.focus();
}
// Digitar a quantidade (aplica ao sair do campo ou com Enter)
$('#recipe-modal').addEventListener('change', e => {
  const inp = e.target.closest('[data-qin]');
  if (inp) {
    const k = inp.dataset.qin, [, u] = modalRecipe.amounts[k];
    const unit = inp.parentElement.querySelector('[data-qunit]')?.value || u;
    const v = parseFloat(String(inp.value).replace(',', '.'));
    if (!(v > 0)) { toast('Digite uma quantidade maior que zero'); renderRecipeModal(); return; }
    setIngAmount(k, v * unitMult(k, u, unit), `[data-qin="${CSS.escape(k)}"]`);
  }
  const sel = e.target.closest('[data-qunit]');
  if (sel) { modalUnit[sel.dataset.qunit] = sel.value; renderRecipeModal(); $(`#recipe-modal [data-qunit="${CSS.escape(sel.dataset.qunit)}"]`)?.focus(); }
});
$('#recipe-modal').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[data-qin]')) { e.preventDefault(); e.target.dispatchEvent(new Event('change', { bubbles: true })); }
});
$('#recipe-modal').addEventListener('click', e => { if (e.target.closest('#cook-btn')) cookRecipe(); });

// ---- Favoritos ----
function renderFavs() {
  const list = Favs.all().map(f => ({ f, r: byId(f.recipeId) })).filter(x => x.r);
  $('#favs-list').innerHTML = list.length
    ? list.map(({ f, r }) => cardHTML(r, { compact: true, note: f.config ? `✎ ${configSummary(r, f.config) || 'Versão personalizada'}` : '' })).join('')
    : `<div class="col-span-full text-center py-12"><div class="text-4xl mb-3">🤍</div><p class="font-bold">Nenhuma receita salva ainda</p><p class="text-sm text-[var(--ink-3)] mt-1">Toque no coração de uma receita para guardá-la aqui.</p></div>`;
}
const openFavs = () => { renderFavs(); openModal($('#favs-modal')); };
$('#open-favs-btn').addEventListener('click', openFavs);

// ---- Estoque ----
let stockKind = 'solid';
const renderStockUnits = () => { $('#stock-unit').innerHTML = UNITS[stockKind].map(u => `<option>${u}</option>`).join(''); };
$('#stock-kind').addEventListener('click', e => {
  const b = e.target.closest('[data-kind]'); if (!b) return;
  stockKind = b.dataset.kind;
  $$('#stock-kind button').forEach(x => x.classList.toggle('active', x === b));
  renderStockUnits();
});
function renderStock() {
  // ordena: o que vence primeiro aparece no topo
  const list = Stock.all().slice().sort((a, b) => (daysLeft(a.exp) ?? 9999) - (daysLeft(b.exp) ?? 9999));
  const exp = Stock.expiring();
  $('#stock-summary').textContent = `${list.length} ${list.length === 1 ? 'item' : 'itens'}`;
  $('#stock-alert').innerHTML = exp.length ? `<div class="stock-alert"><span class="text-lg">⏰</span><div class="flex-1 min-w-0"><b>${exp.length === 1 ? '1 item vence' : exp.length + ' itens vencem'} em breve:</b> ${esc(joinPt(exp.map(i => `${i.name} (${expLabel(i.d)})`)))}</div><button class="btn btn-primary btn-sm" id="use-expiring-btn">Usar agora</button></div>` : '';
  $('#stock-list').innerHTML = list.length ? list.map(i => {
    const [kl, kc] = KIND_LABEL[i.kind] || KIND_LABEL.unit;
    const d = daysLeft(i.exp);
    return `
    <div class="stock-row">
      <div class="min-w-0">
        <div class="flex items-center gap-2 flex-wrap"><span class="font-semibold text-[15px] truncate">${stockEmoji(i)} ${esc(i.name)}</span><span class="kind ${kc}">${kl}</span>${d !== null ? `<span class="exp ${expClass(d)}">${expLabel(d)}</span>` : ''}</div>
        ${(() => { // observação + calorias da quantidade em estoque
          const k = Stock.keyOf(i), kc = k ? Nutrition.kcal(k, i.qty, i.unit) : null;
          const parts = [i.note ? esc(i.note) : '', kc != null ? `${Nutrition.ref(k).exact ? '' : '≈'}${Math.round(kc).toLocaleString('pt-BR')} kcal no total` : ''].filter(Boolean);
          return parts.length ? `<div class="text-xs text-[var(--ink-3)] truncate mt-0.5">${parts.join(' · ')}</div>` : '';
        })()}
      </div>
      <div class="stepper"><button data-step="-1" data-id="${i.id}" aria-label="Diminuir">−</button><span>${String(i.qty).replace('.', ',')} ${esc(i.unit)}</span><button data-step="1" data-id="${i.id}" aria-label="Aumentar">+</button></div>
      <button class="icon-btn !w-9 !h-9 hover:!text-[var(--danger)]" data-del="${i.id}" aria-label="Remover"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4h6v3"/></svg></button>
    </div>`;
  }).join('') : `<div class="empty text-center py-8 text-sm text-[var(--ink-3)]">Seu estoque está vazio.</div>`;
}
function renderStockPreview() {
  const list = Stock.all().slice().sort((a, b) => (daysLeft(a.exp) ?? 9999) - (daysLeft(b.exp) ?? 9999));
  const rows = list.slice(0, 3).map(i => {
    const [kl, kc] = KIND_LABEL[i.kind] || KIND_LABEL.unit;
    const d = daysLeft(i.exp);
    return `<div class="stock-preview-row"><div class="flex items-center gap-3 min-w-0"><span class="w-10 h-10 rounded-xl bg-[var(--brown-50)] grid place-items-center text-lg flex-shrink-0">${stockEmoji(i)}</span><div class="min-w-0"><div class="font-bold text-sm truncate">${esc(i.name)}</div><div class="flex gap-1 flex-wrap"><span class="kind ${kc}">${kl}</span>${d !== null && d <= alertDays() ? `<span class="exp ${expClass(d)}">${expLabel(d)}</span>` : ''}</div></div></div><span class="font-bold text-[var(--green)] text-sm whitespace-nowrap">${String(i.qty).replace('.', ',')} ${esc(i.unit)}</span></div>`;
  }).join('');
  const more = list.length > 3 ? `<p class="text-sm text-white/85 text-center pt-1">+ ${list.length - 3} ${list.length - 3 === 1 ? 'item' : 'itens'} no seu estoque</p>` : '';
  $('#stock-preview').innerHTML = list.length ? rows + more : `<div class="stock-preview-row justify-center text-sm text-[var(--ink-3)]">Seu estoque está vazio — comece adicionando um item.</div>`;
}
$('#stock-alert').addEventListener('click', e => { if (e.target.closest('#use-expiring-btn')) useExpiring(false); });
$('#stock-list').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) { Stock.remove(+del.dataset.del); renderStock(); return; }
  const st = e.target.closest('[data-step]');
  if (st) {
    const item = Stock.all().find(i => i.id === +st.dataset.id);
    const step = { g: 50, kg: 0.5, ml: 100, L: 0.5 }[item.unit] || 1;
    Stock.update(item.id, { qty: Math.max(0, +(item.qty + step * +st.dataset.step).toFixed(2)) }); renderStock();
  }
});
$('#stock-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#stock-name').value.trim(); const qty = parseFloat($('#stock-qty').value);
  if (!name || !(qty >= 0)) return;
  Stock.add({ name, kind: stockKind, qty, unit: $('#stock-unit').value, note: $('#stock-note').value.trim(), exp: $('#stock-exp').value || '' });
  e.target.reset(); renderStock(); $('#stock-name').focus();
  toast(`${name} adicionado ao estoque`);
});
const openStock = () => { renderStock(); openModal($('#stock-modal')); setTimeout(() => $('#stock-name').focus(), 150); };
$('#stock-to-search').addEventListener('click', () => useStock(false));
$('#open-stock-btn').addEventListener('click', openStock);
$('#band-open-stock').addEventListener('click', openStock);
$('#band-use-stock').addEventListener('click', () => useStock(false));
