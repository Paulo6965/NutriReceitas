/* NutriReceitas — storage.js
   Camada de persistência (hoje localStorage). Trocar por Supabase mantendo as mesmas funções. */

// ---------- Camada de dados (trocar por API/Supabase depois) ----------
const memStore = {};
const db = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return key in memStore ? memStore[key] : fallback; } },
  set(key, val) { memStore[key] = val; try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
  del(key) { delete memStore[key]; try { localStorage.removeItem(key); } catch {} },
};
const userKey = (k) => `nr:${(state.user && state.user.email) || 'guest'}:${k}`;
