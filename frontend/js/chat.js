/* NutriReceitas — chat.js
   Ingredientes selecionados e o NutriChef (chat). Futuro: POST /api/chef → IA. */

// =====================================================================
//  INGREDIENTES SELECIONADOS
// =====================================================================
function addIngredient(raw) {
  const key = canonical(raw) || norm(raw);
  if (!key || state.ingredients.includes(key)) return false;
  state.ingredients.push(key); renderChips();
  return true;
}
function removeIngredient(key) {
  state.ingredients = state.ingredients.filter(k => k !== key);
  if (!state.ingredients.length) state.highlight = false;
  renderChips(); renderResults();
}
function renderChips() {
  $('#selected-tags-container').innerHTML = state.ingredients.length
    ? state.ingredients.map(k => `<span class="ing-chip">${emojiFor(k)} ${esc(pretty(k))}<button aria-label="Remover ${esc(pretty(k))}" data-remove="${esc(k)}"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button></span>`).join('')
    : `<span class="text-sm text-[var(--ink-3)]">Nenhum ingrediente ainda — conte ao NutriChef o que você tem.</span>`;
  $('#active-tag-count').textContent = `(${state.ingredients.length})`;
  Session.save();
}
$('#selected-tags-container').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) removeIngredient(b.dataset.remove); });
$('#clear-ings-btn').addEventListener('click', () => { state.ingredients = []; state.highlight = false; renderChips(); renderResults(); });

// =====================================================================
//  NUTRICHEF — CHAT  (futuro: POST /api/chef → IA)
// =====================================================================
const chatLog = $('#chat-log');
const chatInput = $('#chat-input');
// Salva a conversa (sem as bolhas de "digitando…")
function saveChat() {
  ChatHistory.save([...chatLog.children].filter(el => !el.querySelector('.typing'))
    .map(el => ({ role: el.classList.contains('user') ? 'user' : 'bot', html: el.innerHTML })));
}
function pushMsg(html, who = 'bot') {
  const div = document.createElement('div');
  div.className = `msg ${who}`; div.innerHTML = html;
  chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
  saveChat();
  return div;
}
function botSay(html, delay = 550) {
  const typing = pushMsg('<span class="typing"><span></span><span></span><span></span></span>');
  setTimeout(() => { typing.innerHTML = html; chatLog.scrollTop = chatLog.scrollHeight; saveChat(); }, delay);
}
// Restaura a conversa salva; se não houver, cumprimenta
function restoreChat() {
  const msgs = ChatHistory.all();
  if (!msgs.length) return greet();
  chatLog.innerHTML = '';
  msgs.forEach(m => { const d = document.createElement('div'); d.className = `msg ${m.role}`; d.innerHTML = m.html; d.style.animation = 'none'; chatLog.appendChild(d); });
  chatLog.scrollTop = chatLog.scrollHeight;
}
function greet() {
  chatLog.innerHTML = ''; ChatHistory.clear();
  const name = state.user ? `, ${esc(state.user.name.split(' ')[0])}` : '';
  pushMsg(`Olá${name}! 👋 Sou o <b>NutriChef</b>. Me diga o que tem na geladeira e eu encontro a receita ideal.`);
  pushMsg(`Também posso usar seu <b>estoque</b> ou filtrar por <b>doce</b>, <b>salgado</b>, <b>bebidas</b>, <b>vegetariano</b>, <b>sem lactose</b> ou <b>sem glúten</b>.`);
  const exp = Stock.expiring();
  if (exp.length) pushMsg(`⏰ Atenção: ${esc(joinPt(exp.map(i => `${i.name.toLowerCase()} ${expLabel(i.d)}`)))}. Quer receitas para aproveitar antes de estragar?<div class="mt-2.5"><button class="suggestion" data-expiring><span>Usar o que vence primeiro</span><small>→</small></button></div>`);
}
// Ingredientes que vencem logo, para priorizar nas receitas
const expiringKeys = () => new Set(Stock.expiring().map(i => i.key).filter(Boolean));
function useExpiring(fromChat) {
  const keys = [...expiringKeys()];
  if (!keys.length) { fromChat ? botSay('Nada vencendo nos próximos dias. 👏 Seu estoque está em dia!') : toast('Nada vencendo nos próximos dias'); return; }
  const added = keys.filter(addIngredient);
  state.sort = 'relevance'; $('#sort-select').value = 'relevance';
  if (fromChat) runSearch({ fromChat: true, added, changes: ['que usam o que vence primeiro'] });
  else { closeModal($('#stock-modal')); runSearch({ fromChat: false }); toast('Mostrando receitas com o que vence primeiro'); }
}
function extractIngredients(text) {
  const n = ' ' + norm(text).replace(/[.,;!?]/g, ' ') + ' ';
  const found = new Set();
  Object.keys(INGREDIENTS).sort((a, b) => b.length - a.length).forEach(k => {
    if (new RegExp(`\\b${k.replace(/-/g, '[- ]')}(s|es)?\\b`).test(n)) found.add(k);
  });
  n.split(/\s+/).forEach(w => { const c = canonical(w); if (c) found.add(c); });
  if (found.has('creme de leite') && !/\bleite\b/.test(n.replace(/creme de leite/g, ''))) found.delete('leite');
  return [...found];
}
/* ---------- Continuar ou recomeçar a busca? ----------
   Cada mensagem com ingredientes pode JUNTAR com a busca anterior ou RECOMEÇAR:
   - junta quando os ingredientes combinam numa mesma refeição (frango → arroz);
   - recomeça quando não combinam (frango → café e leite);
   - palavras da pessoa têm prioridade: "também" junta; "agora", "só", "esquece" recomeçam.
   Com a API: dá para trocar `profileOf` por uma consulta de "ingredientes que combinam". */
const ING_PROFILE = {
  salgado: ['frango', 'carne', 'peixe', 'atum', 'arroz', 'feijao', 'batata', 'macarrao', 'legumes', 'cenoura', 'abobrinha', 'tomate', 'cebola', 'alho', 'alface', 'pepino', 'brocolis', 'cogumelo', 'milho', 'grao-de-bico', 'salsa', 'manjericao', 'pao',
    'quiabo', 'jilo', 'couve', 'mandioca', 'abobora', 'pimentao', 'berinjela', 'repolho', 'espinafre', 'linguica', 'bacon',
    'presunto', 'camarao', 'sardinha', 'lentilha', 'ervilha', 'salsicha', 'pepperoni'],
  doce: ['cafe', 'chocolate', 'mel', 'acucar', 'morango', 'banana', 'baunilha', 'aveia', 'iogurte', 'creme de leite',
    'laranja', 'maca', 'uva', 'abacaxi', 'manga', 'mamao', 'coco', 'canela', 'amendoim'],
  // os demais (leite, ovo, queijo, manteiga, farinha, azeite, limão…) combinam com os dois
};
function profileOf(keys) {
  let s = 0, d = 0;
  keys.forEach(k => { if (ING_PROFILE.salgado.includes(k)) s++; else if (ING_PROFILE.doce.includes(k)) d++; });
  return s && d ? 'misto' : s ? 'salgado' : d ? 'doce' : 'neutro';
}
function shouldMerge(prev, next, t) {
  if (!prev.length) return true;
  if (/\b(tambem|alem diss?o|alem de|junto com|junta|e ainda)\b/.test(t)) return true;                  // pediu para juntar
  if (/\b(agora|so|somente|apenas|esquece|esqueca|outra coisa|em vez|ao inves|na verdade|mudei)\b/.test(t)) return false; // pediu outra coisa
  const a = profileOf(prev), b = profileOf(next);
  return a === 'neutro' || b === 'neutro' || a === 'misto' || a === b;
}

/* ---------- Correção de ingredientes digitados/falados errado ----------
   Compara cada palavra desconhecida com os ingredientes do catálogo (distância de edição):
   - muito parecida (≥ 80%): corrige sozinho e avisa ("frangu" → frango);
   - meio parecida (≥ 60%): pergunta "Você quis dizer…?";
   - nada parecida: trata como ingrediente novo.
   Com a API: a lista de nomes pode vir do catálogo completo de ingredientes. */
const STOPWORDS = new Set(('tenho tem temos tinha quero queria gostaria fazer faca faz algo alguma algum alguns algumas uma umas um uns ' +
  'de da do das dos e ou com sem pra pro para por que qual quais me eu voce vc tbm q aqui em casa na no nas nos a o as os ' +
  'so somente apenas agora tambem mais menos muito pouco pouca receita receitas comida comidas prato pratos doce doces ' +
  'salgado salgada salgados quente quentes frio fria frios frias gelado gelada bebida bebidas rapido rapida pratico pratica ' +
  'oi ola bom boa dia tarde noite usar uso meu minha meus minhas estoque vence vencer primeiro validade vegetariano vegetariana ' +
  'vegano vegana lactose gluten kg g gramas grama litro litros ml unidade unidades duas dois tres quatro cinco meia meio ' +
  'ainda la ja isso esse essa este esta ate jantar janta almoco lanche manha sobremesa refeicao comer beber suco ' +
  'esquece esqueca verdade mudei ao inves vez junto junta alem disso ai sim nao obrigado obrigada valeu por favor ' +
  'recomende recomenda sugira sugere surpreenda').split(' '));

function levenshtein(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// Ingrediente mais parecido com um trecho de texto: { key, score 0..1 }
function closestIngredient(chunk) {
  let best = { key: null, score: 0 };
  Object.keys(INGREDIENTS).forEach(k => {
    const name = k.replace(/-/g, ' ');
    [name, name + 's'].forEach(n => {
      const s = 1 - levenshtein(chunk, n) / Math.max(chunk.length, n.length);
      if (s > best.score) best = { key: k, score: s };
    });
  });
  return best;
}
/* Analisa as palavras que não viraram ingrediente:
   devolve { fixed: [{from,to}], ask: [{from,to}], unknown: [palavras] } */
function fuzzyIngredients(text, known) {
  const words = norm(text).replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const knownWords = new Set(known.flatMap(k => k.replace(/-/g, ' ').split(' ')));
  const out = { fixed: [], ask: [], unknown: [] };
  const used = new Set();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (used.has(i) || STOPWORDS.has(w) || w.length < 3 || knownWords.has(w) || canonical(w)) continue;
    // tenta também 2 e 3 palavras juntas ("grao de bik", "creme de leiti")
    let pick = { key: null, score: 0, span: 1 };
    [3, 2, 1].forEach(span => {
      const chunk = words.slice(i, i + span).join(' ');
      if (span > 1 && words.slice(i, i + span).length < span) return;
      const c = closestIngredient(chunk);
      if (c.score > pick.score + (span > 1 ? 0.05 : 0)) pick = { ...c, span };
    });
    if (pick.key && known.includes(pick.key)) continue;
    const from = words.slice(i, i + pick.span).join(' ');
    if (pick.score >= 0.8) { out.fixed.push({ from, to: pick.key }); for (let j = i; j < i + pick.span; j++) used.add(j); }
    else if (pick.score >= 0.6) { out.ask.push({ from, to: pick.key }); for (let j = i; j < i + pick.span; j++) used.add(j); }
    else out.unknown.push(w);
  }
  // remove repetidos
  const uniq = (arr, f) => arr.filter((x, i, a) => a.findIndex(y => f(y) === f(x)) === i);
  out.fixed = uniq(out.fixed, x => x.to); out.ask = uniq(out.ask.filter(a => !out.fixed.some(f => f.to === a.to)), x => x.to);
  return out;
}
const askHTML = (asks) => asks.map(a => `
  <div class="mt-2 flex flex-wrap items-center gap-2" data-ask-row>
    <span>Você quis dizer <b>${esc(pretty(a.to).toLowerCase())}</b>? <span class="text-[var(--ink-3)]">(“${esc(a.from)}”)</span></span>
    <button class="btn btn-primary btn-sm !h-8" data-fix-yes="${esc(a.to)}">Sim, ${esc(pretty(a.to).toLowerCase())}</button>
    <button class="btn btn-secondary btn-sm !h-8" data-fix-no="${esc(a.from)}">Não</button>
  </div>`).join('');

function handleChat(text) {
  const t = norm(text);
  pushMsg(esc(text), 'user');
  const filtersBefore = { ...state.filters };
  const changes = [];
  if (/\b(doce|doces|sobremesa)\b/.test(t)) { setFilter('taste', 'doce'); changes.push('doces'); }
  if (/\b(salgad[oa]s?)\b/.test(t)) { setFilter('taste', 'salgado'); changes.push('salgadas'); }
  if (/\b(bebida|beber|suco|drink|smoothie)\b/.test(t)) { setFilter('kind', 'bebida'); changes.push('bebidas'); }
  if (/\b(comer|prato|refeicao|almoco|jantar)\b/.test(t)) { setFilter('kind', 'comida'); changes.push('pratos'); }
  if (/\b(gelad[oa]|fri[oa]s?|refrescante)\b/.test(t)) { setFilter('temp', 'frio'); changes.push('frias'); }
  if (/\b(quente|quentinh[oa])\b/.test(t)) { setFilter('temp', 'quente'); changes.push('quentes'); }
  if (/\b(rapid[oa]|rapidinho|pratic[oa])\b/.test(t)) { state.sort = 'time'; $('#sort-select').value = 'time'; changes.push('rápidas'); }
  if (/\b(vegetarian[oa]s?|vegan[oa]s?|sem carne)\b/.test(t)) { setFilter('diet', 'vegetariano'); changes.push('vegetarianas'); }
  if (/sem lactose|intolerant/.test(t)) { setFilter('diet', 'sem-lactose'); changes.push('sem lactose'); }
  if (/sem gluten|celiac/.test(t)) { setFilter('diet', 'sem-gluten'); changes.push('sem glúten'); }
  const dietHits = changes.filter(c => ['vegetarianas', 'sem lactose', 'sem glúten'].includes(c));
  if (dietHits.length > 1) { changes.splice(0, changes.length, ...changes.filter(c => !dietHits.includes(c) || c === dietHits[dietHits.length - 1])); setTimeout(() => botSay(`Por enquanto aplico uma dieta por vez — fiquei com <b>${dietHits[dietHits.length - 1]}</b>.`), 1500); }
  if (/venc|validade|estragar/.test(t)) { useExpiring(true); return; }
  if (/estoque|despensa/.test(t)) { useStock(true); return; }
  if (/recomend|sugest|surpreend|o que (eu )?(faco|como)/.test(t) && !extractIngredients(text).length) {
    const { list, cold } = Reco.recommend(3);
    const why = cold ? 'Ainda estou conhecendo seu gosto, então separei as mais bem avaliadas:' : `Como você curte ${joinPt(Reco.topFeatures().map(featureLabel))}, acho que vai gostar destas:`;
    botSay(`${why}<div class="mt-2.5 flex flex-col gap-1.5">${list.map(suggestionBtn).join('')}</div>`);
    return;
  }
  if (/^(oi|ola|bom dia|boa tarde|boa noite|e ai)\b/.test(t)) { botSay('Oi! 😊 Quais ingredientes você tem aí?'); return; }
  let ings = extractIngredients(text);
  // Palavras parecidas com ingredientes: corrige ("frangu" → frango) ou pergunta ("aros" → arroz?)
  const fz = fuzzyIngredients(text, ings);
  ings = [...ings, ...fz.fixed.map(f => f.to).filter(k => !ings.includes(k))];
  const fixNote = fz.fixed.length ? `✏️ Corrigi ${joinPt(fz.fixed.map(f => `“${esc(f.from)}” para <b>${esc(pretty(f.to).toLowerCase())}</b>`))}. ` : '';
  // Só pergunta, sem buscar ainda, quando a mensagem não trouxe mais nada
  if (!ings.length && !changes.length && fz.ask.length) {
    botSay(`Não tenho certeza se entendi.${askHTML(fz.ask)}`);
    return;
  }
  // Palavras que não parecem nenhum ingrediente conhecido: trata como ingredientes novos se for uma lista
  if (!ings.length && !changes.length && fz.unknown.length && t.length < 80 && /,| e |\btenho\b|\btem\b/.test(t)) ings = fz.unknown;
  // Junta com a busca anterior ou começa uma nova (só quando a mensagem traz ingredientes)
  let note = '';
  const prev = [...state.ingredients];
  const newOnes = ings.map(k => canonical(k) || norm(k)).filter(k => !prev.includes(k));
  if (newOnes.length && prev.length) {
    if (shouldMerge(prev, newOnes, t)) {
      note = `Juntei com o que você já tinha: <b>${esc(joinPt([...prev, ...newOnes].map(k => pretty(k).toLowerCase())))}</b>. `;
    } else {
      state.ingredients = []; state.highlight = false;
      // filtros que vieram de pedidos anteriores também recomeçam (os desta mensagem ficam)
      Object.keys(state.filters).forEach(f => { if (state.filters[f] === filtersBefore[f] && f !== 'diet') setFilter(f, 'all'); });
      note = `Nova busca com o que você pediu agora — deixei <b>${esc(joinPt(prev.map(k => pretty(k).toLowerCase())))}</b> de fora porque não combina.
        <div class="mt-2"><button class="suggestion" data-merge="${esc(prev.join(','))}"><span>Juntar com ${esc(joinPt(prev.map(k => pretty(k).toLowerCase())))}</span><small>+</small></button></div>`;
    }
  }
  const added = ings.filter(addIngredient);
  if (!added.length && !changes.length) {
    if (ings.length) botSay('Esses ingredientes já estão na sua lista. Quer que eu busque? Toque em <b>Buscar receitas</b>.');
    else botSay('Não reconheci ingredientes aí. Tente algo como <i>“tenho frango, arroz e cebola”</i>.');
    return;
  }
  if (fixNote) note = (note || `Anotei ${joinPt(added.map(k => `<b>${esc(pretty(k).toLowerCase())}</b>`))}. `) + fixNote;
  runSearch({ fromChat: true, added, changes, note });
  if (fz.ask.length) setTimeout(() => botSay(`Ah, e mais uma coisa:${askHTML(fz.ask)}`), 1300);
  // Ingrediente fora do catálogo de teste: avisa em vez de ficar em silêncio
  const unknown = added.filter(k => !INGREDIENTS[k]);
  if (unknown.length) setTimeout(() => botSay(`Ainda não tenho receitas com <b>${esc(joinPt(unknown))}</b> no catálogo de teste. Quando a API de receitas estiver conectada, eu busco em muito mais opções. 😉`), 900);
}
const suggestionBtn = (r) => `<button class="suggestion" data-open="${r.id}"><span>${esc(r.title)}</span><small>${r.time} min →</small></button>`;
chatLog.addEventListener('click', e => {
  const b = e.target.closest('[data-open]'); if (b) return openRecipe(b.dataset.open);
  if (e.target.closest('[data-expiring]')) handleChat('Usar o que vence primeiro');
  // Confirmação da correção: "Você quis dizer arroz?"
  const yes = e.target.closest('[data-fix-yes]');
  if (yes) {
    const k = yes.dataset.fixYes;
    yes.closest('[data-ask-row]').innerHTML = `✓ Anotado: <b>${esc(pretty(k).toLowerCase())}</b>`;
    saveChat();
    const added = [k].filter(addIngredient);
    runSearch({ fromChat: true, added });
    return;
  }
  const no = e.target.closest('[data-fix-no]');
  if (no) {
    no.closest('[data-ask-row]').innerHTML = `<span class="text-[var(--ink-3)]">Ok, ignorei “${esc(no.dataset.fixNo)}”.</span>`;
    saveChat();
    botSay('Sem problema! Me diga de novo o ingrediente, de outro jeito — por exemplo, <i>“peito de frango”</i> ou <i>“arroz branco”</i>.');
    return;
  }
  // "Juntar com…": devolve os ingredientes da busca anterior
  const mg = e.target.closest('[data-merge]');
  if (mg) {
    const keys = mg.dataset.merge.split(',').filter(Boolean);
    const added = keys.filter(addIngredient);
    mg.closest('div').remove();
    runSearch({ fromChat: true, added, note: 'Pronto, juntei tudo. ' });
  }
});
$('#chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = chatInput.value.trim(); if (!v) return;
  chatInput.value = ''; handleChat(v);
});
$('#add-ingredient-btn').addEventListener('click', () => {
  const v = chatInput.value.trim();
  if (!v) { chatInput.focus(); return; }
  const list = extractIngredients(v); const parts = list.length ? list : v.split(/,| e /).map(s => s.trim()).filter(Boolean);
  const n = parts.filter(addIngredient).length;
  chatInput.value = '';
  toast(n ? `${n} ingrediente(s) adicionado(s)` : 'Já está na lista');
  renderResults();
});
$$('#quick-suggestions [data-say]').forEach(b => b.addEventListener('click', () => handleChat(b.dataset.say)));
$('#clear-chat-btn').addEventListener('click', greet);
$('#search-btn').addEventListener('click', () => runSearch({ fromChat: false }));
const PLACEHOLDERS = ['Ex.: tenho ovos, queijo e tomate', 'Ex.: quero algo doce e rápido', 'Ex.: frango e arroz para o jantar', 'Ex.: uma bebida gelada com banana'];
let phIdx = 0;
setInterval(() => { if (document.activeElement !== chatInput && !chatInput.value) { phIdx = (phIdx + 1) % PLACEHOLDERS.length; chatInput.placeholder = PLACEHOLDERS[phIdx]; } }, 3500);
