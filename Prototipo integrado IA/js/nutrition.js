/* NutriReceitas — nutrition.js
   Informação nutricional por ingrediente (kcal, proteína, carboidrato, gordura)
   e cálculo pela quantidade usada.

   Hoje: valores MÉDIOS de referência (aprox. tabelas nutricionais, ex.: TACO).
   Com a API conectada: `Nutrition.loadExact()` busca os valores exatos de cada ingrediente
   e `normalizeRecipe()` (catalog.js) guarda os valores exatos de cada prato.
   O valor exato SEMPRE tem prioridade sobre a estimativa. */

// Por 100 g (ou 100 ml para líquidos): [kcal, proteína g, carboidrato g, gordura g, peso de 1 unidade em g]
const NUTRI_TABLE = {
  'frango': [159, 32, 0, 2.5, 150],    'batata': [77, 2, 17, 0.1, 150],     'ovo': [143, 13, 0.7, 9.5, 50],
  'legumes': [35, 1.5, 7, 0.2],         'cenoura': [41, 0.9, 9.6, 0.2, 70],  'abobrinha': [17, 1.2, 3.1, 0.3, 200],
  'salsa': [36, 3, 6.3, 0.8],           'tomate': [18, 0.9, 3.9, 0.2, 120],  'queijo': [350, 25, 2, 27, 30],
  'leite': [61, 3.2, 4.7, 3.3],         'farinha': [364, 10, 76, 1],         'acucar': [387, 0, 100, 0],
  'banana': [89, 1.1, 23, 0.3, 100],    'morango': [32, 0.7, 7.7, 0.3, 15],  'cafe': [2, 0.1, 0, 0],
  'arroz': [130, 2.7, 28, 0.3],         'feijao': [76, 4.8, 13.6, 0.5],      'carne': [250, 26, 0, 15, 150],
  'peixe': [120, 22, 0, 3, 150],        'alface': [15, 1.4, 2.9, 0.2],       'cebola': [40, 1.1, 9.3, 0.1, 110],
  'alho': [149, 6.4, 33, 0.5, 5],       'limao': [29, 1.1, 9.3, 0.3, 70],    'azeite': [810, 0, 0, 92],
  'manteiga': [717, 0.9, 0.1, 81],      'chocolate': [546, 4.9, 61, 31],     'pepino': [15, 0.7, 3.6, 0.1, 200],
  'grao-de-bico': [164, 8.9, 27, 2.6],  'manjericao': [23, 3.2, 2.7, 0.6],   'creme de leite': [205, 2.4, 4, 20],
  'mel': [304, 0.3, 82, 0],             'pao': [270, 8, 55, 3, 50],          'macarrao': [371, 13, 75, 1.5],
  'iogurte': [61, 3.5, 4.7, 3.3, 170],  'aveia': [389, 17, 66, 7],           'baunilha': [288, 0.1, 13, 0.1],
  'atum': [132, 28, 0, 1, 120],         'milho': [86, 3.3, 19, 1.4],         'brocolis': [34, 2.8, 7, 0.4],
  'cogumelo': [22, 3.1, 3.3, 0.3],
};
const NUTRI_KEYS = ['kcal', 'p', 'c', 'g'];
const zeroNutri = () => ({ kcal: 0, p: 0, c: 0, g: 0 });

const Nutrition = {
  // Valores exatos vindos da API: { chave: { kcal, p, c, g, unitG } } (por 100 g/ml)
  exact: {},

  ref(key) {
    if (this.exact[key]) return { unitG: 100, ...this.exact[key], exact: true };
    const t = NUTRI_TABLE[key];
    return t ? { kcal: t[0], p: t[1], c: t[2], g: t[3], unitG: t[4] || 100, exact: false } : null;
  },

  // Nutrientes de uma quantidade (ex.: 'frango', 500, 'g' → { kcal: 795, p: 160, c: 0, g: 12.5 })
  of(key, qty, unit) {
    const ref = this.ref(key); if (!ref || !(qty > 0)) return null;
    const [q, u] = toBase(qty, unit);
    const grams = u === 'g' || u === 'ml' ? q : u === 'un' ? q * ref.unitG : null;
    if (grams == null) return null; // caixas, pacotes, latas: sem peso conhecido
    const out = {}; NUTRI_KEYS.forEach(n => out[n] = grams * ref[n] / 100);
    return out;
  },
  kcal(key, qty, unit) { const o = this.of(key, qty, unit); return o ? o.kcal : null; },

  // Nutrientes de cada ingrediente da receita (na escala de porções) e totais.
  // `factor`: número (mesma escala para todos) ou função (k) => escala daquele ingrediente.
  // `include` (Set opcional): só soma os ingredientes incluídos.
  recipe(r, factorArg = 1, include = null) {
    const total = zeroNutri(); let allExact = true;
    const items = r.ingredients.map(k => {
      const factor = typeof factorArg === 'function' ? factorArg(k) : factorArg;
      const [q, u, exactData] = r.amounts[k];
      let n, exact;
      if (exactData != null) { // valores exatos da API para a quantidade da receita
        const d = typeof exactData === 'number' ? { kcal: exactData } : exactData;
        n = {}; NUTRI_KEYS.forEach(x => n[x] = d[x] != null ? d[x] * factor : null); exact = true;
      } else { n = this.of(k, q * factor, u); exact = !!this.ref(k)?.exact; }
      const included = !include || include.has(k);
      if (included) {
        if (!n) allExact = false;
        else { NUTRI_KEYS.forEach(x => total[x] += n[x] || 0); if (!exact) allExact = false; }
      }
      return { k, n, exact, included };
    });
    return { items, total, exact: allExact };
  },

  /* TODO (API): buscar os valores exatos dos ingredientes e guardar em cache.
     Exemplo de resposta: [{ name: 'frango', kcal: 165, protein: 31, carbs: 0, fat: 3.6, unitWeight: 120 }] (por 100 g) */
  async loadExact(keys) {
    // const res = await fetch(`/api/nutrition?ingredients=${encodeURIComponent(keys.join(','))}`);
    // const data = await res.json();
    // data.forEach(d => { this.exact[canonical(d.name) || norm(d.name)] = { kcal: d.kcal, p: d.protein, c: d.carbs, g: d.fat, unitG: d.unitWeight || 100 }; });
    return this.exact;
  },
};

// Formatação curta de nutrientes: 12.46 → "12,5"
const fmtN = (v) => v == null ? '–' : (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toString().replace('.', ',');

// Calorias por porção do prato: exata da API se houver; senão, estimativa pelos ingredientes
function kcalPerServing(r) {
  if (r.kcalExact) return r.kcalExact;
  const est = Nutrition.recipe(r).total.kcal;
  return est ? Math.round(est / r.serves) : r.kcal;
}
const isKcalExact = (r) => !!r.kcalExact || Nutrition.recipe(r).exact;
