/* NutriReceitas — recipes.js
   Busca, cards e grade de receitas, recomendados e filtros. */

// =====================================================================
//  BUSCA + RESULTADOS
// =====================================================================
function matchRecipes() {
  const { kind, taste, temp, diet } = state.filters;
  const have = new Set(state.ingredients);
  const exp = expiringKeys();
  return RECIPES
    .filter(r => (kind === 'all' || r.kind === kind) && (taste === 'all' || r.taste === taste) && (temp === 'all' || r.temp === temp) && fitsDiet(r, diet))
    .map(r => {
      const hits = r.ingredients.filter(i => have.has(i));
      const saves = r.ingredients.filter(i => exp.has(i)); // usa algo que está vencendo
      return { r, hits, saves, ratio: hits.length / r.ingredients.length };
    })
    .filter(x => !state.ingredients.length || x.hits.length > 0)
    .sort((a, b) => {
      if (state.sort === 'time') return a.r.time - b.r.time;
      if (state.sort === 'rating') return b.r.rating - a.r.rating;
      return (b.hits.length - a.hits.length) || (b.saves.length - a.saves.length) || (b.ratio - a.ratio) || (Reco.score(b.r) - Reco.score(a.r));
    });
}
function runSearch({ fromChat, added = [], changes = [], note = '' }) {
  Reco.trackSearch(state.ingredients, state.filters);
  state.highlight = state.ingredients.length > 0;
  const res = renderResults();
  if (fromChat) {
    let intro = note || (added.length ? `Anotei ${joinPt(added.map(k => `<b>${esc(pretty(k).toLowerCase())}</b>`))}. ` : '');
    if (changes.length) intro += `Filtrando receitas ${joinPt(changes)}. `;
    if (!res.length) botSay(`${intro}Não encontrei nada com essa combinação. Tente remover um filtro ou adicionar outro ingrediente.`);
    else botSay(`${intro}Encontrei <b>${res.length} receita${res.length > 1 ? 's' : ''}</b>. As melhores:<div class="mt-2.5 flex flex-col gap-1.5">${res.slice(0, 3).map(x => suggestionBtn(x.r)).join('')}</div>`, 700);
  } else {
    $('#results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function useStock(fromChat) {
  const keys = Stock.keys();
  const added = keys.filter(addIngredient);
  if (!keys.length) { fromChat ? botSay('Seu estoque está vazio. Abra <b>Estoque</b> no topo para cadastrar o que você tem.') : toast('Seu estoque está vazio'); return; }
  if (fromChat) runSearch({ fromChat: true, added, changes: [] });
  else { closeModal($('#stock-modal')); runSearch({ fromChat: false }); toast(`${keys.length} itens do estoque adicionados`); }
}

function cardHTML(r, opts = {}) {
  const { hits = null, compact = false, best = false, saves = [], note = '' } = opts;
  const fav = Favs.has(r.id);
  const hitSet = new Set(hits || []);
  const missing = hits ? r.ingredients.length - hits.length : 0;
  const ratio = hits ? Math.round(hits.length / r.ingredients.length * 100) : 0;
  const searched = state.highlight && hits && hits.length;
  const badge = best ? '<span class="pill best">★ Melhor combinação</span>' : `<span class="pill">${r.temp === 'quente' ? '♨️ Quente' : '🧊 Frio'}</span>`;
  const matchText = missing === 0 ? '<b class="text-[var(--green)]">Você tem tudo!</b>' : missing === 1 ? '<span class="nudge">Falta só 1 ingrediente</span>' : `Você tem <b>${hits && hits.length}</b> de ${r.ingredients.length}`;
  return `
    <article class="recipe-card ${compact ? 'compact' : ''} ${searched ? 'searched' : ''}" data-card="${r.id}" tabindex="0" role="button" aria-label="Abrir receita: ${esc(r.title)}">
      <div class="media">
        <img src="${r.img}" alt="${esc(r.title)}" loading="lazy" onerror="this.remove()">
        <div class="absolute top-2.5 left-2.5 z-[2]">${badge}</div>
        <button class="fav-btn ${fav ? 'on' : ''}" data-fav="${r.id}" aria-label="${fav ? 'Remover dos' : 'Adicionar aos'} favoritos">${ICON.heart}</button>
        <div class="media-meta"><span>${ICON.clock}${r.time} min</span><span title="${isKcalExact(r) ? 'Valor exato' : 'Estimativa pelos ingredientes'}">${ICON.fire}${isKcalExact(r) ? '' : '≈'}${kcalPerServing(r)} kcal</span></div>
      </div>
      <div class="p-4 ${compact ? '' : 'sm:p-5'} flex-1 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <span class="cat">${catLabel(r)}</span>
          <span class="meta"><span class="rating">${ICON.star}${fmtRating(r.rating)} <span class="font-normal text-[var(--ink-3)]">(${r.reviews})</span></span></span>
        </div>
        <h3 class="font-display font-semibold ${compact ? 'text-[17px]' : 'text-xl'} leading-snug">${esc(r.title)}</h3>
        ${note ? `<p class="card-note">${esc(note)}</p>` : ''}
        ${compact ? '' : `<p class="text-sm text-[var(--ink-2)] leading-relaxed line-clamp-2">${esc(r.desc)}</p>`}
        ${saves.length ? `<span class="exp exp-warn self-start">⏰ Aproveita ${esc(joinPt(saves.map(i => pretty(i).toLowerCase())))} que vence logo</span>` : ''}
        ${hits ? `
          <div class="match-box mt-1">
            <div class="ring" style="--p:${ratio}"><span>${ratio}%</span></div>
            <div class="text-[13px] text-[var(--ink-2)] leading-snug">${matchText}<br><span class="text-xs text-[var(--ink-3)]">${hits.length ? 'dos ingredientes da receita' : ''}</span></div>
          </div>` : ''}
        ${compact ? '' : `<div class="flex flex-wrap gap-1 mt-1">${r.ingredients.map(i => `<span class="tag ${hitSet.has(i) ? 'have' : ''}">${hitSet.has(i) ? '✓ ' : ''}${esc(pretty(i))}</span>`).join('')}</div>`}
        <div class="card-foot mt-auto pt-3 flex items-center justify-between">
          <span class="text-xs text-[var(--ink-3)]">${r.ingredients.length} ingredientes</span>
          <span class="see-more">Ver receita <span aria-hidden="true">→</span></span>
        </div>
      </div>
    </article>`;
}
function renderResults() {
  const res = matchRecipes();
  const withIngs = state.ingredients.length > 0;
  $('#results-grid').innerHTML = res.length
    ? res.map((x, i) => cardHTML(x.r, { hits: withIngs ? x.hits : null, saves: x.saves, best: withIngs && i === 0 && state.sort === 'relevance' && x.hits.length >= 2 })).join('')
    : `<div class="empty col-span-full text-center py-16 px-6"><div class="text-4xl mb-3">🍳</div><p class="font-bold text-lg">Nenhuma receita com essa combinação</p><p class="text-sm text-[var(--ink-3)] mt-1">Tente remover um filtro ou adicionar outros ingredientes.</p></div>`;
  $('#results-count').textContent = `${res.length} receita${res.length === 1 ? '' : 's'}`;
  $('#results-summary').innerHTML = withIngs
    ? `Combinando com <b>${esc(joinPt(state.ingredients.map(k => pretty(k).toLowerCase())))}</b>.`
    : 'Adicione ingredientes ao NutriChef para ver as melhores combinações.';
  updateFilterBadge();
  return res;
}
function renderReco() {
  const { list, cold } = Reco.recommend(4);
  $('#reco-grid').innerHTML = list.map(r => cardHTML(r, { compact: true })).join('');
  const top = Reco.topFeatures();
  $('#reco-reason').innerHTML = cold || !top.length
    ? 'As mais bem avaliadas da semana. Busque e favorite receitas para personalizar.'
    : `Porque você costuma procurar por <b>${esc(joinPt(top.map(featureLabel)))}</b>.`;
}

document.addEventListener('click', e => {
  const favBtn = e.target.closest('[data-fav]');
  if (favBtn) {
    e.stopPropagation();
    const on = Favs.toggle(favBtn.dataset.fav);
    $$(`.fav-btn[data-fav="${favBtn.dataset.fav}"]`).forEach(b => { b.classList.toggle('on', on); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); });
    toast(on ? 'Salva nos favoritos' : 'Removida dos favoritos');
    if ($('#favs-modal').classList.contains('open')) renderFavs();
    return;
  }
  const card = e.target.closest('[data-card]');
  if (card) openRecipe(card.dataset.card);
});
$('#sort-select').addEventListener('change', e => { state.sort = e.target.value; renderResults(); });

// =====================================================================
//  FILTROS
// =====================================================================
function setFilter(type, value, rerender = false) {
  state.filters[type] = value;
  $$(`.seg[data-filter="${type}"] button`).forEach(b => b.classList.toggle('active', b.dataset.value === value));
  if (rerender) renderResults();
}
$$('.seg[data-filter]').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  setFilter(seg.dataset.filter, b.dataset.value, true);
  if (b.dataset.value !== 'all') Reco.trackSearch([], state.filters);
}));
function renderUnitSelector() {
  const units = UNITS[state.qty.kind];
  if (!units.includes(state.qty.unit)) state.qty.unit = units[0];
  $('#unit-selector').innerHTML = units.map(u => `<button data-unit="${u}" class="${u === state.qty.unit ? 'active' : ''}">${u}</button>`).join('');
}
$('#qty-kind').addEventListener('click', e => {
  const b = e.target.closest('[data-kind]'); if (!b) return;
  $$('#qty-kind button').forEach(x => x.classList.toggle('active', x === b));
  state.qty.kind = b.dataset.kind;
  $('#qty-input').value = state.qty.kind === 'solid' ? 250 : 300;
  renderUnitSelector();
});
$('#unit-selector').addEventListener('click', e => { const b = e.target.closest('[data-unit]'); if (!b) return; state.qty.unit = b.dataset.unit; renderUnitSelector(); });
$('#apply-qty-btn').addEventListener('click', () => {
  const v = parseFloat($('#qty-input').value);
  if (!(v > 0)) { toast('Informe uma quantidade válida'); return; }
  state.qty.value = v; state.qty.applied = true; updateFilterBadge();
  toast(`Receitas serão abertas na porção de ${String(v).replace('.', ',')} ${state.qty.unit}`);
  const b = $('#apply-qty-btn'); b.textContent = '✓ Aplicado'; setTimeout(() => b.textContent = 'Aplicar', 1200);
});
function updateFilterBadge() {
  const f = state.filters;
  const parts = [
    f.kind === 'all' ? null : (f.kind === 'comida' ? 'Comidas' : 'Bebidas'),
    f.taste === 'all' ? null : (f.taste === 'doce' ? 'Doces' : 'Salgados'),
    f.temp === 'all' ? null : (f.temp === 'quente' ? 'Quentes' : 'Frias'),
    f.diet === 'all' ? null : DIET_LABEL[f.diet],
    state.qty.applied ? `porção de ${String(state.qty.value).replace('.', ',')} ${state.qty.unit} (${state.qty.kind === 'solid' ? 'sólido' : 'líquido'})` : 'porção original de cada receita',
  ].filter(Boolean);
  $('#current-filter-badge').textContent = 'Filtros ativos: ' + parts.join(' · ');
  Session.save();
}

// Restaura a sessão salva do usuário (ingredientes, filtros, ordenação, porção)
function restoreSession() {
  const s = Session.load();
  Session._restoring = true;
  state.ingredients = s?.ingredients || [];
  state.filters = { kind: 'all', taste: 'all', temp: 'all', diet: 'all', ...(s?.filters || {}) };
  state.sort = s?.sort || 'relevance';
  state.qty = { kind: 'solid', value: 250, unit: 'g', ...(s?.qty || {}) };
  state.highlight = false;
  Object.entries(state.filters).forEach(([t, v]) => setFilter(t, v));
  $('#sort-select').value = state.sort;
  $$('#qty-kind button').forEach(b => b.classList.toggle('active', b.dataset.kind === state.qty.kind));
  $('#qty-input').value = state.qty.value;
  renderUnitSelector(); renderChips();
  Session._restoring = false;
}
