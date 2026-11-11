/* NutriReceitas — auth.js
   Autenticação via Firebase (Email/Senha e Google) + animações do painel de login. */

// ── Aba ativa no modal (login | register) ───────────────────────────────────
let authTab = 'login';
$('#auth-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  authTab = b.dataset.tab;
  $$('#auth-tabs button').forEach(x => x.classList.toggle('active', x === b));
  $('#name-field').classList.toggle('hidden', authTab !== 'register');
  $('#forgot-row').classList.toggle('hidden', authTab === 'register');
  $('#auth-submit').textContent = authTab === 'login' ? 'Entrar' : 'Criar conta grátis';
  AuthArt.start(authTab);
});

// ── Helpers internos ────────────────────────────────────────────────────────
function _applySession(fbUser, displayName) {
  state.user = {
    name:  fbUser.displayName || displayName || fbUser.email.split('@')[0],
    email: fbUser.email,
    uid:   fbUser.uid,
    role:  'user', // padrão; admin pode ser definido via Firestore custom claim futuramente
  };
  db.set('nr:session', state.user);
}

function _resetBtn() {
  const btn = $('#auth-submit');
  btn.disabled = false;
  btn.textContent = authTab === 'login' ? 'Entrar' : 'Criar conta grátis';
}

// ── Login com Email/Senha ───────────────────────────────────────────────────
async function signInWithEmail(email, password, name) {
  try {
    const cred = await firebaseAuth.signIn(email, password);
    _applySession(cred.user, name);
    closeModal($('#auth-modal'));
    afterAuthChange();
    toast(`Bem-vindo(a), ${state.user.name.split(' ')[0]}!`);
  } catch (e) {
    // Se o usuário não existe, cria a conta automaticamente
    if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') {
      await signUpWithEmail(email, password, name);
    } else {
      _resetBtn();
      const msgs = {
        'auth/wrong-password':    'Senha incorreta.',
        'auth/invalid-email':     'E-mail inválido.',
        'auth/too-many-requests': 'Muitas tentativas. Tente mais tarde.',
      };
      toast(msgs[e.code] || 'Erro: ' + e.message);
    }
  }
}

// ── Cadastro com Email/Senha ────────────────────────────────────────────────
async function signUpWithEmail(email, password, name) {
  try {
    const cred = await firebaseAuth.signUp(email, password);
    // Salva o nome de exibição no Firebase Auth
    await firebaseAuth.updateProfile(cred.user, { displayName: name });
    _applySession(cred.user, name);
    closeModal($('#auth-modal'));
    afterAuthChange();
    toast(`Conta criada! Bem-vindo(a), ${state.user.name.split(' ')[0]}!`);
  } catch (e) {
    _resetBtn();
    const msgs = {
      'auth/email-already-in-use': 'Este e-mail já está cadastrado. Use "Entrar".',
      'auth/weak-password':        'Senha muito fraca (mínimo 6 caracteres).',
      'auth/invalid-email':        'E-mail inválido.',
    };
    toast(msgs[e.code] || 'Erro ao criar conta: ' + e.message);
  }
}

// ── Login com Google ────────────────────────────────────────────────────────
$('#google-btn').addEventListener('click', async () => {
  try {
    const result = await firebaseAuth.signInWithGoogle();
    _applySession(result.user, result.user.displayName);
    closeModal($('#auth-modal'));
    afterAuthChange();
    toast(`Bem-vindo(a), ${state.user.name.split(' ')[0]}!`);
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      toast('Erro com Google: ' + e.message);
    }
  }
});

// ── Submit do formulário ────────────────────────────────────────────────────
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email    = $('#auth-email').value.trim();
  const password = $('#auth-pass').value;
  const name     = (authTab === 'register' && $('#auth-name').value.trim()) || email.split('@')[0];

  const btn = $('#auth-submit');
  btn.disabled = true;
  btn.textContent = 'Aguarde…';

  if (authTab === 'login') {
    await signInWithEmail(email, password, name);
  } else {
    await signUpWithEmail(email, password, name);
  }
});

// ── Recuperar senha ─────────────────────────────────────────────────────────
$('#forgot-row').addEventListener('click', async e => {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  if (!email) { toast('Digite seu e-mail primeiro.'); return; }
  try {
    await firebaseAuth.sendPasswordReset(email);
    toast('E-mail de recuperação enviado!');
  } catch {
    toast('Não foi possível enviar o e-mail de recuperação.');
  }
});

// ── Logout ──────────────────────────────────────────────────────────────────
async function signOut() {
  await firebaseAuth.signOut();
  state.user = null;
  db.del('nr:session');
  afterAuthChange();
  toast('Você saiu da conta');
}

// ── Abre o modal de login ───────────────────────────────────────────────────
const openAuth = () => { openModal($('#auth-modal')); AuthArt.start(authTab); };

// ── Listener global do Firebase Auth (detecta sessão salva ao recarregar) ───
window.addEventListener('firebase:authchange', async (e) => {
  const fbUser = e.detail;
  if (fbUser && !state.user) {
    // Recarregamento de página com sessão ativa no Firebase
    _applySession(fbUser, fbUser.displayName);
    afterAuthChange();
  } else if (!fbUser && state.user) {
    // Sessão expirou no Firebase
    state.user = null;
    db.del('nr:session');
    afterAuthChange();
  }
});

/* ── Animações em loop do lado esquerdo do modal ───────────────────────────
   Entrar:      digita ingredientes → viram etiquetas → NutriChef responde →
                receita aparece, anel enche até 100% → receita é favoritada.
   Criar conta: estoque vai sendo preenchido → barras do "seu gosto" crescem →
                "Recomendações prontas". Cada ciclo dura ~9s e recomeça. */
const AuthArt = {
  timers: [], intervals: [],
  COPY: {
    login:    ['Seu NutriChef está te esperando.', 'Continue de onde parou: favoritos, estoque e recomendações no seu gosto.'],
    register: ['Monte sua cozinha inteligente.',   'Cadastre o que tem em casa e receba receitas que aprendem o seu gosto.'],
  },
  at(ms, fn)     { this.timers.push(setTimeout(fn, ms)); },
  every(ms, fn)  { const id = setInterval(fn, ms); this.intervals.push(id); return id; },
  stop()         { this.timers.forEach(clearTimeout); this.intervals.forEach(clearInterval); this.timers = []; this.intervals = []; },
  on(scene, key) { const el = $(`[data-a="${key}"]`, scene); if (el) el.classList.add('on'); },
  count(from, to, ms, cb) {
    const t0 = performance.now();
    const id = this.every(30, () => {
      const k = Math.min(1, (performance.now() - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      cb(Math.round(from + (to - from) * e));
      if (k >= 1) clearInterval(id);
    });
  },
  reset(scene) {
    scene.classList.remove('fading');
    $$('.a-item, .a-heart', scene).forEach(e => e.classList.remove('on'));
    const type = $('[data-type]', scene); if (type) type.textContent = '';
    const dots = $('[data-dots]', scene); if (dots) dots.classList.remove('hidden');
    const bt   = $('[data-bottext]', scene); if (bt) bt.classList.add('hidden');
    const ring = $('[data-ring]', scene);
    if (ring) { ring.style.setProperty('--p', 0); $('[data-ring-text]', scene).textContent = '0%'; $('[data-match]', scene).textContent = 'Combinando…'; }
    const cnt = $('[data-count]', scene); if (cnt) cnt.textContent = '0 itens';
    $$('.a-bar i', scene).forEach(i => i.style.width = '0');
    $$('[data-pct]', scene).forEach(p => p.textContent = '0%');
  },
  start(tab) {
    this.stop();
    const name = tab === 'register' ? 'register' : 'login';
    $('#scene-login').classList.toggle('hidden',    name !== 'login');
    $('#scene-register').classList.toggle('hidden', name !== 'register');
    $('#auth-art-title').textContent = this.COPY[name][0];
    $('#auth-art-sub').textContent   = this.COPY[name][1];
    const scene = $('#scene-' + name);
    if (reduceMotion) { this.finalState(scene, name); return; }
    name === 'login' ? this.loopLogin(scene) : this.loopRegister(scene);
  },
  loopLogin(scene) {
    this.reset(scene);
    const phrase = 'tenho ovos, tomate e queijo';
    this.at(300, () => {
      this.on(scene, 'user');
      let i = 0; const el = $('[data-type]', scene);
      const id = this.every(45, () => { el.textContent = phrase.slice(0, ++i); if (i >= phrase.length) clearInterval(id); });
    });
    this.at(1750, () => this.on(scene, 'c1'));
    this.at(1950, () => this.on(scene, 'c2'));
    this.at(2150, () => this.on(scene, 'c3'));
    this.at(2650, () => this.on(scene, 'bot'));
    this.at(3600, () => { $('[data-dots]', scene).classList.add('hidden'); $('[data-bottext]', scene).classList.remove('hidden'); });
    this.at(4200, () => {
      this.on(scene, 'card');
      this.count(0, 100, 1100, v => { $('[data-ring]', scene).style.setProperty('--p', v); $('[data-ring-text]', scene).textContent = v + '%'; });
    });
    this.at(5400, () => { $('[data-match]', scene).innerHTML = '<b class="text-[var(--green)]">Você tem tudo!</b>'; });
    this.at(6000, () => this.on(scene, 'heart'));
    this.at(8400, () => scene.classList.add('fading'));
    this.at(9000, () => this.loopLogin(scene));
  },
  loopRegister(scene) {
    this.reset(scene);
    const cnt = $('[data-count]', scene);
    const setCount = (n) => { cnt.textContent = `${n} ${n === 1 ? 'item' : 'itens'}`; cnt.classList.add('bump'); setTimeout(() => cnt.classList.remove('bump'), 220); };
    this.at(300,  () => this.on(scene, 'stock'));
    this.at(900,  () => { this.on(scene, 'r1'); setCount(1); });
    this.at(1500, () => { this.on(scene, 'r2'); setCount(2); });
    this.at(2100, () => { this.on(scene, 'r3'); setCount(3); });
    this.at(2900, () => this.on(scene, 'taste'));
    this.at(3200, () => {
      $$('.a-bar i', scene).forEach(i => i.style.width = i.dataset.w + '%');
      $$('[data-pct]', scene).forEach(p => this.count(0, +p.dataset.pct, 1200, v => p.textContent = v + '%'));
    });
    this.at(4900, () => this.on(scene, 'ready'));
    this.at(8400, () => scene.classList.add('fading'));
    this.at(9000, () => this.loopRegister(scene));
  },
  finalState(scene, name) {
    this.reset(scene);
    $$('.a-item, .a-heart', scene).forEach(e => e.classList.add('on'));
    if (name === 'login') {
      $('[data-type]', scene).textContent = 'tenho ovos, tomate e queijo';
      $('[data-dots]', scene).classList.add('hidden'); $('[data-bottext]', scene).classList.remove('hidden');
      $('[data-ring]', scene).style.setProperty('--p', 100); $('[data-ring-text]', scene).textContent = '100%';
      $('[data-match]', scene).innerHTML = '<b class="text-[var(--green)]">Você tem tudo!</b>';
    } else {
      $('[data-count]', scene).textContent = '3 itens';
      $$('.a-bar i', scene).forEach(i => i.style.width = i.dataset.w + '%');
      $$('[data-pct]', scene).forEach(p => p.textContent = p.dataset.pct + '%');
    }
  },
};

// ── Botões de abertura de modal ─────────────────────────────────────────────
$$('[data-open-modal]').forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  ({ favs: openFavs, stock: openStock, auth: () => state.user ? toast('Você já está conectado') : openAuth() })[a.dataset.openModal]();
}));

// ── Menu do usuário logado ──────────────────────────────────────────────────
let userMenuOpen = false;
document.addEventListener('click', e => {
  if (userMenuOpen && !e.target.closest('#user-btn')) {
    $('#user-menu')?.classList.add('hidden'); userMenuOpen = false;
  }
});

function renderAuthSlot() {
  const slot = $('#auth-slot');
  if (!state.user) {
    slot.innerHTML = `<button class="btn btn-primary btn-sm" id="login-btn">Entrar</button>`;
    $('#login-btn').addEventListener('click', openAuth);
    return;
  }
  const initials = state.user.name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  slot.innerHTML = `
    <div class="relative">
      <button class="nav-link !pl-1.5" id="user-btn" aria-haspopup="menu">
        <span class="w-8 h-8 rounded-full bg-[var(--brown)] text-white flex items-center justify-center text-xs font-bold">${esc(initials)}</span>
        <span class="hidden sm:inline max-w-[120px] truncate">${esc(state.user.name)}</span>
      </button>
      <div id="user-menu" class="menu hidden absolute right-0 top-full mt-2 w-60 z-50" role="menu">
        <div class="px-3 py-2.5 border-b border-[var(--line)] mb-1">
          <div class="text-sm font-bold truncate">${esc(state.user.name)}</div>
          <div class="text-xs text-[var(--ink-3)] truncate">${esc(state.user.email)}</div>
        </div>
        <button class="menu-item" id="um-favs">♡ Meus favoritos</button>
        <button class="menu-item" id="um-stock">▢ Meu estoque</button>
        <button class="menu-item" id="um-reset">↺ Reiniciar recomendações</button>
        <div class="h-px bg-[var(--line)] my-1"></div>
        <button class="menu-item !text-[var(--danger)]" id="um-logout">Sair</button>
      </div>
    </div>`;
  $('#user-btn').addEventListener('click', () => {
    $('#user-menu').classList.toggle('hidden');
    userMenuOpen = !$('#user-menu').classList.contains('hidden');
  });
  $('#um-favs').addEventListener('click', openFavs);
  $('#um-stock').addEventListener('click', openStock);
  $('#um-reset').addEventListener('click', () => { db.del(userKey('profile')); renderReco(); toast('Recomendações reiniciadas'); });
  $('#um-logout').addEventListener('click', signOut);
}

function updateBadges() {
  const f = Favs.all().length, s = Stock.all().length;
  $('#fav-count').textContent = f; $('#fav-count').classList.toggle('has', f > 0);
  $('#stock-count').textContent = s; $('#stock-count').classList.toggle('has', s > 0);
  const ck = Cooked.all().length;
  $('#cooked-count').textContent = ck; $('#cooked-count').classList.toggle('has', ck > 0);
  Notify.sync();
  renderStockPreview();
}

// Ao entrar/sair/trocar de conta: carrega TUDO daquele usuário
function afterAuthChange() {
  const prefs = state.user ? db.get(userKey('prefs'), null) : null;
  if (prefs?.theme && prefs.theme !== document.documentElement.dataset.theme) setTheme(prefs.theme);
  restoreSession(); renderAuthSlot(); updateBadges(); renderReco(); renderResults(); restoreChat();
}
