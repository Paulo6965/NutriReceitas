/* NutriReceitas — firebase.js
   Inicializa o Firebase e expõe `firebaseAuth` e `firebaseDB` globalmente
   para que os scripts clássicos (storage.js, auth.js…) possam usá-los.
   Carregado como <script type="module"> no index.html ANTES dos outros scripts. */

import { initializeApp }                        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updateProfile,
}                                               from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
}                                             from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Configuração do projeto nadispensa ──────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyDhTeVL3hq2cDmLNQCOJv-u5pZtSoy2VX4",
  authDomain:        "nadispensa.firebaseapp.com",
  projectId:         "nadispensa",
  storageBucket:     "nadispensa.firebasestorage.app",
  messagingSenderId: "831897818711",
  appId:             "1:831897818711:web:a643ec2ac61e968e063512",
  measurementId:     "G-XQEQY098WN",
};

const app      = initializeApp(firebaseConfig);
const auth     = getAuth(app);
const firestore = getFirestore(app);

// ── Helpers de autenticação ─────────────────────────────────────────────────
window.firebaseAuth = {
  signIn:            (email, password)   => signInWithEmailAndPassword(auth, email, password),
  signUp:            (email, password)   => createUserWithEmailAndPassword(auth, email, password),
  signInWithGoogle:  ()                  => signInWithPopup(auth, new GoogleAuthProvider()),
  signOut:           ()                  => signOut(auth),
  sendPasswordReset: (email)             => sendPasswordResetEmail(auth, email),
  updateProfile:     (user, data)        => updateProfile(user, data),
  onAuthStateChanged:(cb)               => onAuthStateChanged(auth, cb),
  currentUser:       ()                  => auth.currentUser,
};

// ── Camada de banco de dados (substitui localStorage) ──────────────────────
// Chaves são armazenadas em /users/{uid}/kv/{chave codificada}
// Mantém a mesma assinatura síncrona de db.get/set/del, mas com fallback para
// localStorage enquanto Firestore carrega (evita tela em branco).

const memCache = {}; // cache em memória para reads síncronos

function safeKey(key) {
  // Firestore não aceita "/" no ID do documento – codificamos
  return key.replace(/\//g, '__');
}

window.firebaseDB = {
  // Leitura síncrona (retorna do cache / localStorage) + atualiza cache em background
  get(key, fallback = null) {
    if (key in memCache) return memCache[key];
    try {
      const v = localStorage.getItem(key);
      const parsed = v ? JSON.parse(v) : fallback;
      memCache[key] = parsed;
      return parsed;
    } catch {
      return fallback;
    }
  },

  // Escrita: salva em cache, localStorage e (se logado) Firestore
  async set(key, val) {
    memCache[key] = val;
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
    const user = auth.currentUser;
    if (!user) return;
    try {
      const ref = doc(firestore, "users", user.uid, "kv", safeKey(key));
      await setDoc(ref, { value: val, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.warn("[Firebase] set falhou, mantendo em localStorage:", e.message);
    }
  },

  // Deleção: remove de cache, localStorage e Firestore
  async del(key) {
    delete memCache[key];
    try { localStorage.removeItem(key); } catch {}
    const user = auth.currentUser;
    if (!user) return;
    try {
      const ref = doc(firestore, "users", user.uid, "kv", safeKey(key));
      await deleteDoc(ref);
    } catch (e) {
      console.warn("[Firebase] del falhou:", e.message);
    }
  },

  // Carrega todos os dados do Firestore para o cache local (chamado após login)
  async syncFromCloud(uid) {
    try {
      const col = collection(firestore, "users", uid, "kv");
      const snap = await getDocs(col);
      snap.forEach(d => {
        const key = d.id.replace(/__/g, '/');
        const val = d.data().value;
        memCache[key] = val;
        try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
      });
      console.log(`[Firebase] ${snap.size} chaves sincronizadas do Firestore.`);
    } catch (e) {
      console.warn("[Firebase] syncFromCloud falhou:", e.message);
    }
  },

  // Migra dados antigos do localStorage (nr:guest:*) para Firestore após primeiro login
  async migrateLocalData(uid) {
    const prefix = 'nr:guest:';
    const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
    if (keys.length === 0) return;
    for (const key of keys) {
      try {
        const val = JSON.parse(localStorage.getItem(key));
        const newKey = key.replace('nr:guest:', `nr:${uid}:`);
        await this.set(newKey, val);
        localStorage.removeItem(key);
      } catch {}
    }
    console.log(`[Firebase] ${keys.length} chaves migradas do guest para o usuário.`);
  },
};

// ── Perfis e Área do Administrador ─────────────────────────────────────────
// Cada pessoa tem um documento /users/{uid} com nome, e-mail, papel e status:
//   { name, email, role: 'user' | 'admin', disabled: bool, createdAt, lastLoginAt }
// O papel NÃO pode ser alterado pelo próprio usuário: as regras do Firestore
// (firestore.rules) só deixam um admin mudar `role` e `disabled`.
// O primeiro admin é definido à mão no Console do Firebase (role = "admin").

const KV_TYPE = (docId) => docId.split(':').pop(); // "nr:<uid>:favs" → "favs"

window.firebaseAdmin = {
  // Cria o perfil no primeiro login; nos próximos, só atualiza o último acesso.
  async ensureProfile(fbUser, name) {
    const ref  = doc(firestore, "users", fbUser.uid);
    const snap = await getDoc(ref);
    const now  = new Date().toISOString();
    if (!snap.exists()) {
      const profile = {
        name:        name || fbUser.displayName || fbUser.email.split('@')[0],
        email:       fbUser.email,
        role:        'user',
        disabled:    false,
        createdAt:   now,
        lastLoginAt: now,
      };
      await setDoc(ref, profile);
      return profile;
    }
    const changes = { lastLoginAt: now, email: fbUser.email };
    if (!snap.data().name && name) changes.name = name;
    await updateDoc(ref, changes);
    return { ...snap.data(), ...changes };
  },

  // ---- Funções abaixo só funcionam para admin (as regras bloqueiam os demais) ----

  async listUsers() {
    const snap = await getDocs(collection(firestore, "users"));
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  },

  // Lê os dados salvos de um usuário: { favs: [...], stock: [...], cooked: [...], ... }
  async getUserData(uid) {
    const snap = await getDocs(collection(firestore, "users", uid, "kv"));
    const data = {};
    snap.forEach(d => { data[KV_TYPE(d.id)] = d.data().value; });
    return data;
  },

  setRole(uid, role)         { return updateDoc(doc(firestore, "users", uid), { role }); },
  setDisabled(uid, disabled) { return updateDoc(doc(firestore, "users", uid), { disabled }); },

  // Apaga favoritos, estoque, histórico etc. do usuário (a conta de login continua existindo).
  async clearUserData(uid) {
    const snap = await getDocs(collection(firestore, "users", uid, "kv"));
    await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
    return snap.size;
  },
};

// ── Listener de autenticação: sincroniza estado ao entrar/sair ─────────────
onAuthStateChanged(auth, async (fbUser) => {
  if (fbUser) {
    // Sincroniza dados da nuvem para o cache local
    await window.firebaseDB.syncFromCloud(fbUser.uid);
    // Migra dados de convidado se houver
    await window.firebaseDB.migrateLocalData(fbUser.uid);
  }
  // Notifica o restante da aplicação via evento customizado
  window.dispatchEvent(new CustomEvent('firebase:authchange', { detail: fbUser }));
});
