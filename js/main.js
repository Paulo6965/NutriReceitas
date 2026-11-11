/* NutriReceitas — main.js
   Borda animada dos cards, cabeçalho, modo claro/escuro e inicialização. */

// ---------- Borda giratória dos cards buscados ----------
// Velocidade constante (1 volta/7s); no hover acelera suavemente (1 volta/1,8s)
// e ao sair volta suavemente ao normal.
const SPIN_NORMAL = 360 / 7, SPIN_HOVER = 360 / 1.8;
const spinState = new Map();
let lastFrame = performance.now();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function spinLoop(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
  $$('#results-grid .recipe-card.searched').forEach(card => {
    const id = card.dataset.card;
    let st = spinState.get(id);
    if (!st) { st = { a: Math.random() * 360, v: SPIN_NORMAL }; spinState.set(id, st); }
    const target = card.matches(':hover') ? SPIN_HOVER : SPIN_NORMAL;
    st.v += (target - st.v) * Math.min(1, dt * 5);
    st.a = (st.a + st.v * dt) % 360;
    card.style.setProperty('--angle', st.a.toFixed(2) + 'deg');
  });
  requestAnimationFrame(spinLoop);
}
if (!reduceMotion) requestAnimationFrame(spinLoop);

// ---------- Header: transparente sobre o hero, branco ao rolar ----------
const header = $('#main-header');
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 40);
window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

// ---------- Modo claro / escuro ----------
const themeBtn = $('#theme-btn');
function setTheme(t, save = true) {
  const root = document.documentElement;
  root.classList.add('theme-anim');                 // transição suave só durante a troca
  root.dataset.theme = t;
  if (save) {
    try { localStorage.setItem('nr:theme', t); } catch {}  // local: aplica antes de a página desenhar
    if (state.user) db.set(userKey('prefs'), { ...db.get(userKey('prefs'), {}), theme: t }); // perfil do usuário → user_preferences.theme
  }
  themeBtn.title = t === 'dark' ? 'Mudar para modo claro' : 'Mudar para modo escuro';
  setTimeout(() => root.classList.remove('theme-anim'), 400);
}
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(next);
  toast(next === 'dark' ? '🌙 Modo escuro ativado' : '☀️ Modo claro ativado');
});
// Se o usuário nunca escolheu, acompanha a mudança do sistema
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  let saved = null; try { saved = localStorage.getItem('nr:theme'); } catch {}
  if (!saved) setTheme(e.matches ? 'dark' : 'light', false);
});
themeBtn.title = document.documentElement.dataset.theme === 'dark' ? 'Mudar para modo claro' : 'Mudar para modo escuro';

// ---------- Inicialização ----------
// Começa vazio: a pessoa diz o que tem (sem "Melhor combinação" antes da primeira busca)
renderUnitSelector(); renderStockUnits(); renderChips(); afterAuthChange();
// Calorias exatas: quando a API existir, substitui as médias e redesenha os cards
Nutrition.loadExact(Object.keys(INGREDIENTS)).then(() => { if (Object.keys(Nutrition.exact).length) { renderResults(); renderReco(); } });
