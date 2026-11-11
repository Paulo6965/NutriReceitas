/* NutriReceitas — storage.js
   Camada de persistência: usa firebaseDB (Firestore + localStorage como fallback).
   O objeto `db` mantém a mesma API de antes para não quebrar os outros módulos. */

// firebaseDB é injetado pelo firebase.js (carregado como module antes deste script)
// Enquanto firebase.js ainda não carregou, usa um fallback síncrono em localStorage.
const _fallback = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  del(key)      { try { localStorage.removeItem(key); } catch {} },
};

// `db` é o objeto usado por todo o resto da aplicação.
// Redireciona para firebaseDB quando disponível, ou para fallback.
const db = {
  get(key, fallback = null) {
    return (window.firebaseDB || _fallback).get(key, fallback);
  },
  set(key, val) {
    return (window.firebaseDB || _fallback).set(key, val);
  },
  del(key) {
    return (window.firebaseDB || _fallback).del(key);
  },
};

// userKey: gera a chave namespaceada pelo uid do usuário logado (ou 'guest')
const userKey = (k) => {
  const uid = (window.state && state.user && state.user.uid) || 'guest';
  return `nr:${uid}:${k}`;
};
