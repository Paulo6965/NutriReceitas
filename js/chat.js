/* NutriReceitas — chat.js
   Ingredientes selecionados e ponte segura para o NutriChef local. */

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
//  NUTRICHEF — CHAT (backend local Python/Ollama)
// =====================================================================
const chatLog = $('#chat-log');
const chatInput = $('#chat-input');
window.__chefChatRecipes = window.__chefChatRecipes || new Map();
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

const CHEF_SESSION_KEY = 'nr:local-chef-session';
const chefSessionId = () => {
  let id = localStorage.getItem(CHEF_SESSION_KEY);
  if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; localStorage.setItem(CHEF_SESSION_KEY, id); }
  return id;
};
const chefMarkdown = (value) => {
  let text = String(value || '');
  
  // Se for uma lista de opções de receitas (ex: "Encontrei estas opções de receitas:")
  if (/Encontrei estas opç/i.test(text) && /\d+\.\s+/i.test(text)) {
    let lines = text.split('\n');
    let intro = [];
    let outro = [];
    let currentCard = null;
    let cards = [];
    
    for (let line of lines) {
      let trimmed = line.trim();
      let matchNum = trimmed.match(/^(\d+)\.\s+(.+)$/);
      if (matchNum) {
        if (currentCard) cards.push(currentCard);
        currentCard = { num: matchNum[1], title: matchNum[2], ingredients: '', stats: [] };
      } else if (currentCard) {
        if (/^Alguns ingredientes:\s*/i.test(trimmed)) {
          currentCard.ingredients = trimmed.replace(/^Alguns ingredientes:\s*/i, '');
        } else if (/^(Aproveitamento|Disponíveis usados|Ainda faltam):\s*/i.test(trimmed)) {
          currentCard.stats.push(trimmed);
        } else if (trimmed.length > 0 && !cards.length) {
          currentCard.stats.push(trimmed);
        } else if (trimmed.length > 0) {
          outro.push(trimmed);
        }
      } else {
        if (trimmed) intro.push(trimmed);
      }
    }
    if (currentCard) cards.push(currentCard);
    
    if (cards.length > 0) {
      let cardsHtml = cards.map(c => `
        <div class="recipe-chat-card">
          <div class="recipe-chat-header">
            <span class="recipe-chat-title">${esc(c.num)}. ${esc(c.title)}</span>
            <span class="recipe-chat-badge">Opção ${esc(c.num)}</span>
          </div>
          <div class="recipe-chat-body">
            ${c.ingredients ? `
              <div class="recipe-chat-section-title">Ingredientes destacados</div>
              <ul class="recipe-chat-list">
                ${c.ingredients.split(',').map(i => `<li class="recipe-chat-item"><span class="bullet">•</span><span>${esc(i.trim())}</span></li>`).join('')}
              </ul>
            ` : ''}
            ${c.stats.length ? `
              <div class="pt-1.5 border-t border-[var(--line)] text-xs text-[var(--ink-3)] space-y-0.5">
                ${c.stats.map(s => `<div>${esc(s)}</div>`).join('')}
              </div>
            ` : ''}
          </div>
        </div>
      `).join('');
      
      let outroHtml = outro.length ? `<div class="mt-2 text-sm font-semibold text-[var(--ink-2)]">${esc(outro.join(' '))}</div>` : '';
      return `<p class="mb-2 font-medium">${esc(intro.join(' '))}</p>${cardsHtml}${outroHtml}`;
    }
  }

  // A resposta da IA é texto comum; escapamos antes de aplicar a formatação
  let html = esc(text);
  html = html.replace(/^### (.+)$/gm, '<b>$1</b>')
    .replace(/^## (.+)$/gm, '<strong>$1</strong>')
    .replace(/^[-*] (.+)$/gm, '• $1')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
  return html;
};
// Cards das opções vindas do NutriChef (com foto quando a FatSecret tem).
// Só aceitamos https sem aspas na URL da foto, porque ela vai para o src.
const safeImg = (url) => (typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : '');
const chefOptionsHtml = (reply, options, hasMore) => {
  const intro = String(reply || '').split('\n')[0] || 'Encontrei estas opções de receitas:';
  const cards = options.map(o => {
    const img = safeImg(o.imagem);
    const ings = Array.isArray(o.ingredientes) ? o.ingredientes : [];
    const stats = Array.isArray(o.detalhes) ? o.detalhes : [];
    return `
      <button type="button" class="chef-opt ${img ? 'has-img' : ''}" data-chef-pick="${esc(String(o.numero))}" aria-label="Ver receita ${esc(String(o.numero))}: ${esc(o.titulo)}">
        ${img ? `<img src="${img}" alt="" loading="lazy" onerror="this.closest('.chef-opt').classList.remove('has-img');this.remove()">` : ''}
        <span class="chef-opt-body">
          <span class="chef-opt-title"><b>${esc(String(o.numero))}.</b> ${esc(o.titulo)}</span>
          ${ings.length ? `<span class="chef-opt-ings">${esc(ings.join(', '))}</span>` : ''}
          ${stats.map(s => `<span class="chef-opt-stat">${esc(s)}</span>`).join('')}
        </span>
      </button>`;
  }).join('');
  const more = hasMore ? '<button type="button" class="btn btn-secondary btn-sm mt-2" data-chef-more>Ver mais receitas</button>' : '';
  return `<p class="mb-2 font-medium">${esc(intro)}</p><div class="chef-opts">${cards}</div>${more}
    <p class="mt-2 text-xs text-[var(--ink-3)]">Toque numa receita ou responda com o número.</p>`;
};
async function handleChat(text) {
  if (!state.user) {
    toast('Faça login ou crie sua conta para conversar com o NutriChef!');
    openAuth();
    return;
  }
  pushMsg(esc(text), 'user');
  const typing = pushMsg('<span class="typing"><span></span><span></span><span></span></span>');
  const stock = (typeof Stock !== 'undefined' ? Stock.all() : []).map(item => ({
    name: item.name, qty: item.qty, unit: item.unit, exp: item.exp || null,
  }));
  try {
    const response = await fetch('/api/chef', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        sessionId: chefSessionId(),
        context: { ingredients: state.ingredients, filters: state.filters, stock },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.reply || data.error || 'backend_offline');
    let html = Array.isArray(data.options) && data.options.length
      ? chefOptionsHtml(data.reply, data.options, data.hasMore)
      : chefMarkdown(data.reply);
    if (data.recipe && data.recipe.recipe_id) {
      const key = `fatsecret-${String(data.recipe.recipe_id)}`;
      window.__chefChatRecipes.set(key, data.recipe);
      html += `<div class="mt-3"><button class="btn btn-secondary btn-sm" data-chef-open="${esc(key)}">Ver receita em detalhes</button></div>`;
    }
    typing.innerHTML = html;
    saveChat();
  } catch (error) {
    console.error('NutriChef local indisponível:', error);
    typing.innerHTML = '<b>Não consegui conectar ao NutriChef local.</b><br>Abra o site pelo <i>iniciar-site-local</i> e confirme se o Ollama está em execução.';
    saveChat();
  }
}
const suggestionBtn = (r) => `<button class="suggestion" data-open="${r.id}"><span>${esc(r.title)}</span><small>${r.time} min →</small></button>`;
chatLog.addEventListener('click', e => {
  const chefOpen = e.target.closest('[data-chef-open]');
  if (chefOpen) {
    const recipe = window.__chefChatRecipes.get(chefOpen.dataset.chefOpen);
    if (recipe && typeof openChefRecipe === 'function') openChefRecipe(recipe);
    return;
  }
  const pick = e.target.closest('[data-chef-pick]');
  if (pick) return handleChat(pick.dataset.chefPick);
  const more = e.target.closest('[data-chef-more]');
  if (more) { more.remove(); return handleChat('mais'); }
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
