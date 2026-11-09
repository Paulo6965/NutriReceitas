/* NutriReceitas — catalog.js
   Catálogo: ingredientes, receitas (mock), adaptador da API, unidades e dietas. */

// ---------- Ingredientes ----------
const INGREDIENTS = {
  'frango': '🍗', 'batata': '🥔', 'ovo': '🥚', 'legumes': '🥕', 'cenoura': '🥕', 'abobrinha': '🥒', 'salsa': '🌿',
  'tomate': '🍅', 'queijo': '🧀', 'leite': '🥛', 'farinha': '🌾', 'acucar': '🍬', 'banana': '🍌',
  'morango': '🍓', 'cafe': '☕', 'arroz': '🍚', 'feijao': '🫘', 'carne': '🥩', 'peixe': '🐟', 'alface': '🥬',
  'cebola': '🧅', 'alho': '🧄', 'limao': '🍋', 'azeite': '🫒', 'manteiga': '🧈', 'chocolate': '🍫', 'pepino': '🥒',
  'grao-de-bico': '🫘', 'manjericao': '🌿', 'creme de leite': '🥛', 'mel': '🍯', 'pao': '🍞', 'macarrao': '🍝',
  'iogurte': '🥛', 'aveia': '🌾', 'baunilha': '🌼', 'atum': '🐟', 'milho': '🌽', 'brocolis': '🥦', 'cogumelo': '🍄',
  // ingredientes comuns no Brasil (ajudam a entender o que a pessoa digita/fala, mesmo sem receita no catálogo de teste)
  'quiabo': '🫛', 'jilo': '🫑', 'couve': '🥬', 'mandioca': '🍠', 'abobora': '🎃', 'pimentao': '🫑', 'berinjela': '🍆',
  'repolho': '🥬', 'espinafre': '🥬', 'linguica': '🌭', 'bacon': '🥓', 'presunto': '🍖', 'requeijao': '🧀', 'coco': '🥥',
  'laranja': '🍊', 'maca': '🍎', 'uva': '🍇', 'abacaxi': '🍍', 'manga': '🥭', 'mamao': '🍈', 'abacate': '🥑',
  'camarao': '🦐', 'sardinha': '🐟', 'lentilha': '🫘', 'ervilha': '🫛', 'tapioca': '🌾', 'fuba': '🌽', 'canela': '🌰',
  'gengibre': '🫚', 'amendoim': '🥜', 'castanha': '🌰', 'pepperoni': '🍕', 'mussarela': '🧀', 'salsicha': '🌭',
};
const DISPLAY = { 'acucar': 'Açúcar', 'cafe': 'Café', 'feijao': 'Feijão', 'limao': 'Limão', 'manjericao': 'Manjericão', 'pao': 'Pão', 'macarrao': 'Macarrão', 'brocolis': 'Brócolis', 'grao-de-bico': 'Grão-de-bico',
  'jilo': 'Jiló', 'abobora': 'Abóbora', 'pimentao': 'Pimentão', 'linguica': 'Linguiça', 'requeijao': 'Requeijão', 'maca': 'Maçã',
  'mamao': 'Mamão', 'camarao': 'Camarão', 'fuba': 'Fubá' };
const pretty = (k) => DISPLAY[k] || k.charAt(0).toUpperCase() + k.slice(1);
const emojiFor = (k) => INGREDIENTS[k] || '🌱';
function canonical(word) {
  const w = norm(word).replace(/\s+/g, ' ');
  if (!w) return null;
  if (INGREDIENTS[w]) return w;
  for (const t of [w.replace(/oes$/, 'ao'), w.replace(/aes$/, 'ao'), w.replace(/es$/, ''), w.replace(/s$/, '')]) if (INGREDIENTS[t]) return t;
  return null;
}

// ---------- Receitas (mock — virão da API) ----------
// Fotos locais (baixadas do Unsplash, licença livre) — receitas da API usarão a URL que vier dela
const IMG = (id) => `Imagens/receitas/${id}.jpg`;
/* ---------------------------------------------------------------------
   CATÁLOGO DE RECEITAS (mock local).
   Formato interno pensado para a futura API: `normalizeRecipe()` converte
   a resposta da API para este formato, sem mexer no resto do site.
     amounts: { ingrediente: [quantidade, unidade] }  (unidades: g, ml, un)
     yield:   rendimento total da receita ([qtd, 'g' | 'ml'])
     serves:  número de porções do rendimento
     macros:  por porção (proteína, carboidrato, gordura em gramas)
   --------------------------------------------------------------------- */
const RECIPES = [
  { id: 'frango-batata', title: 'Frango dourado com batatas rústicas', desc: 'Peito de frango marinado no limão, assado com batatas crocantes, tomate e salsa fresca.', img: IMG('1598515214211-89d3c73ae83b'), kind: 'comida', taste: 'salgado', temp: 'quente', time: 30, kcal: 420, macros: { p: 38, c: 28, g: 16 }, rating: 4.95, reviews: 210, style: ['proteico', 'forno', 'almoco'], serves: 3, yield: [900, 'g'],
    amounts: { frango: [500, 'g'], batata: [400, 'g'], tomate: [150, 'g'], salsa: [10, 'g'], limao: [1, 'un'], azeite: [30, 'ml'] },
    steps: [
      { t: 'Tempere o frango{ com :limao,azeite} e sal; deixe pegar gosto por 15 min.', req: ['frango'] },
      { t: 'Corte as batatas em gomos{, regue com :azeite} e espalhe na assadeira.', req: ['batata'] },
      { t: 'Asse a 200 °C por 25 min, até dourar.', req: ['frango', 'batata'] },
      { t: 'Junte {:tomate} nos últimos 5 minutos.', req: ['tomate'] },
      { t: 'Finalize com {:salsa} picada.', req: ['salsa'] },
      { t: 'Sirva quente.', req: [] },
    ] },
  { id: 'frittata', title: 'Frittata de ovos com legumes e tomate', desc: 'Ovos batidos com tomate, cenoura, abobrinha e queijo — pronta em uma frigideira.', img: IMG('1510693206972-df098062cb71'), kind: 'comida', taste: 'salgado', temp: 'quente', time: 20, kcal: 280, macros: { p: 20, c: 8, g: 18 }, rating: 4.88, reviews: 175, style: ['proteico', 'rapido', 'vegetariano'], serves: 2, yield: [500, 'g'],
    amounts: { ovo: [6, 'un'], tomate: [150, 'g'], legumes: [200, 'g'], queijo: [80, 'g'], salsa: [5, 'g'] },
    steps: [
      { t: 'Pique os legumes e refogue por 5 min em fogo médio.', req: ['legumes'] },
      { t: 'Bata os ovos com sal{ e :queijo}.', req: ['ovo'] },
      { t: 'Despeje os ovos na frigideira e cozinhe tampado em fogo baixo por 8 min.', req: ['ovo'] },
      { t: 'Distribua {:tomate} em rodelas por cima.', req: ['tomate'] },
      { t: 'Finalize com {:salsa} picada e sirva em fatias.', req: ['salsa'] },
    ] },
  { id: 'salada-batata', title: 'Salada fria de batata, ovo e salsa', desc: 'Batatas cozidas em cubos, ovos picados e tomate, temperados com azeite e salsa.', img: IMG('1540420773420-3366772f4999'), kind: 'comida', taste: 'salgado', temp: 'frio', time: 15, kcal: 230, macros: { p: 9, c: 30, g: 9 }, rating: 4.92, reviews: 142, style: ['leve', 'rapido', 'vegetariano'], serves: 3, yield: [700, 'g'],
    amounts: { batata: [500, 'g'], ovo: [3, 'un'], tomate: [150, 'g'], salsa: [10, 'g'], azeite: [30, 'ml'] },
    steps: [
      { t: 'Cozinhe {:batata,ovo} até ficarem no ponto.', req: ['batata', 'ovo'] },
      { t: 'Corte em cubos e misture{ com :tomate}.', req: ['batata', 'ovo', 'tomate'] },
      { t: 'Tempere com sal{, :azeite}{ e :salsa}.', req: [] },
      { t: 'Leve à geladeira por 20 min antes de servir.', req: [] },
    ] },
  { id: 'bowl-grao', title: 'Bowl verde de grão-de-bico', desc: 'Grão-de-bico, pepino, tomate e legumes frescos com molho de limão.', img: IMG('1512621776951-a57141f2eefd'), kind: 'comida', taste: 'salgado', temp: 'frio', time: 15, kcal: 350, macros: { p: 13, c: 42, g: 14 }, rating: 4.81, reviews: 98, style: ['leve', 'vegetariano', 'rapido'], serves: 2, yield: [600, 'g'],
    amounts: { 'grao-de-bico': [250, 'g'], pepino: [150, 'g'], tomate: [150, 'g'], legumes: [100, 'g'], limao: [1, 'un'], azeite: [20, 'ml'] },
    steps: [
      { t: 'Escorra o grão-de-bico cozido.', req: ['grao-de-bico'] },
      { t: 'Pique {:pepino,tomate,legumes} em cubos.', req: ['pepino', 'tomate', 'legumes'] },
      { t: 'Monte o bowl e tempere com sal{, :limao}{ e :azeite}.', req: [] },
    ] },
  { id: 'salada-frango', title: 'Salada colorida com frango grelhado', desc: 'Folhas de alface, tiras de frango grelhado, tomate e legumes crocantes.', img: IMG('1546069901-ba9599a7e63c'), kind: 'comida', taste: 'salgado', temp: 'frio', time: 20, kcal: 310, macros: { p: 30, c: 10, g: 16 }, rating: 4.79, reviews: 120, style: ['proteico', 'leve'], serves: 2, yield: [600, 'g'],
    amounts: { frango: [300, 'g'], alface: [150, 'g'], tomate: [150, 'g'], legumes: [100, 'g'], azeite: [20, 'ml'] },
    steps: [
      { t: 'Grelhe o frango temperado e corte em tiras.', req: ['frango'] },
      { t: 'Monte a base com {:alface,tomate,legumes}.', req: ['alface', 'tomate', 'legumes'] },
      { t: 'Cubra com as tiras de frango.', req: ['frango'] },
      { t: 'Tempere com sal{ e regue com :azeite} antes de servir.', req: [] },
    ] },
  { id: 'pizza', title: 'Pizza caseira de tomate e manjericão', desc: 'Massa de fermentação rápida, molho de tomate fresco, queijo e manjericão.', img: IMG('1565299624946-b28f40a0ae38'), kind: 'comida', taste: 'salgado', temp: 'quente', time: 45, kcal: 610, macros: { p: 22, c: 70, g: 24 }, rating: 4.9, reviews: 260, style: ['forno', 'jantar', 'vegetariano'], serves: 4, yield: [800, 'g'],
    amounts: { farinha: [500, 'g'], tomate: [300, 'g'], queijo: [200, 'g'], manjericao: [10, 'g'], azeite: [30, 'ml'] },
    steps: [
      { t: 'Misture a farinha com água, fermento e sal{ e um fio de :azeite}; descanse 20 min.', req: ['farinha'] },
      { t: 'Abra a massa e cubra{ com molho de :tomate}{ e :queijo}.', req: ['farinha'] },
      { t: 'Asse a 250 °C por 12 min.', req: [] },
      { t: 'Finalize com {:manjericao} fresco.', req: ['manjericao'] },
    ] },
  { id: 'panqueca', title: 'Panquecas fofinhas com mel', desc: 'Panquecas altas e macias, servidas com mel e frutas.', img: IMG('1567620905732-2d1ec7ab7445'), kind: 'comida', taste: 'doce', temp: 'quente', time: 20, kcal: 380, macros: { p: 9, c: 58, g: 12 }, rating: 4.86, reviews: 190, style: ['cafe-da-manha', 'rapido'], serves: 4, yield: [500, 'g'],
    amounts: { farinha: [200, 'g'], leite: [300, 'ml'], ovo: [2, 'un'], manteiga: [30, 'g'], mel: [40, 'g'], acucar: [30, 'g'] },
    steps: [
      { t: 'Misture {:farinha}{, :acucar} e uma pitada de sal.', req: ['farinha'] },
      { t: 'Em outra tigela, bata {:leite,ovo} e junte aos secos.', req: ['leite', 'ovo'] },
      { t: 'Doure porções na frigideira{ untada com :manteiga}.', req: [] },
      { t: 'Sirva{ com :mel} e frutas.', req: [] },
    ] },
  { id: 'smoothie', title: 'Smoothie de banana e morango', desc: 'Bebida cremosa e gelada com banana, morango e leite.', img: IMG('1505252585461-04db1eb84625'), kind: 'bebida', taste: 'doce', temp: 'frio', time: 5, kcal: 190, macros: { p: 6, c: 34, g: 4 }, rating: 4.84, reviews: 88, style: ['rapido', 'leve', 'cafe-da-manha'], serves: 2, yield: [400, 'ml'],
    amounts: { banana: [2, 'un'], morango: [150, 'g'], leite: [250, 'ml'], mel: [20, 'g'] },
    steps: [
      { t: 'Coloque {:banana,morango,leite} no liquidificador.', req: ['banana', 'morango', 'leite'] },
      { t: 'Bata até ficar cremoso.', req: [] },
      { t: 'Adoce{ com :mel} a gosto e sirva gelado.', req: [] },
    ] },
  { id: 'cafe-gelado', title: 'Café gelado cremoso', desc: 'Café coado forte batido com leite gelado e um toque de açúcar.', img: IMG('1461023058943-07fcbe16d735'), kind: 'bebida', taste: 'doce', temp: 'frio', time: 5, kcal: 120, macros: { p: 4, c: 16, g: 4 }, rating: 4.7, reviews: 64, style: ['rapido'], serves: 1, yield: [300, 'ml'],
    amounts: { cafe: [150, 'ml'], leite: [150, 'ml'], acucar: [15, 'g'] },
    steps: [
      { t: 'Prepare um café forte e deixe esfriar.', req: ['cafe'] },
      { t: 'Bata com gelo{, :leite}{ e :acucar}.', req: [] },
      { t: 'Sirva imediatamente.', req: [] },
    ] },
  { id: 'sorvete', title: 'Sorvete caseiro de baunilha', desc: 'Sem máquina: leite, creme de leite e baunilha batidos e congelados.', img: IMG('1563805042-7684c019e1cb'), kind: 'comida', taste: 'doce', temp: 'frio', time: 25, kcal: 260, macros: { p: 4, c: 24, g: 17 }, rating: 4.83, reviews: 110, style: ['sobremesa'], serves: 6, yield: [800, 'g'],
    amounts: { leite: [500, 'ml'], 'creme de leite': [300, 'g'], acucar: [120, 'g'], baunilha: [5, 'ml'] },
    steps: [
      { t: 'Aqueça {:leite}{ com :acucar} até dissolver; deixe esfriar.', req: ['leite'] },
      { t: 'Bata com {:creme de leite}{ e :baunilha}.', req: ['creme de leite'] },
      { t: 'Congele por 4 h, mexendo a cada hora.', req: [] },
    ] },
  { id: 'chocolate-quente', title: 'Chocolate quente cremoso', desc: 'Leite, chocolate meio amargo e um toque de canela.', img: IMG('1542990253-0d0f5be5f0ed'), kind: 'bebida', taste: 'doce', temp: 'quente', time: 10, kcal: 290, macros: { p: 9, c: 32, g: 14 }, rating: 4.89, reviews: 132, style: ['rapido', 'sobremesa'], serves: 1, yield: [300, 'ml'],
    amounts: { leite: [250, 'ml'], chocolate: [50, 'g'], acucar: [10, 'g'] },
    steps: [
      { t: 'Aqueça o leite sem deixar ferver.', req: ['leite'] },
      { t: 'Adicione o chocolate picado e mexa até derreter.', req: ['chocolate'] },
      { t: 'Adoce{ com :acucar} a gosto e sirva quente.', req: [] },
    ] },
  { id: 'macarrao', title: 'Macarrão ao sugo com manjericão', desc: 'Molho de tomate caseiro com alho, azeite e manjericão fresco.', img: IMG('1621996346565-e3dbc646d9a9'), kind: 'comida', taste: 'salgado', temp: 'quente', time: 25, kcal: 480, macros: { p: 15, c: 74, g: 13 }, rating: 4.87, reviews: 205, style: ['jantar', 'vegetariano', 'rapido'], serves: 3, yield: [700, 'g'],
    amounts: { macarrao: [300, 'g'], tomate: [400, 'g'], alho: [2, 'un'], azeite: [30, 'ml'], manjericao: [10, 'g'], queijo: [50, 'g'] },
    steps: [
      { t: 'Cozinhe o macarrão al dente.', req: ['macarrao'] },
      { t: 'Doure o alho{ no :azeite}.', req: ['alho'] },
      { t: 'Junte {:tomate} e cozinhe por 10 min para formar o molho.', req: ['tomate'] },
      { t: 'Misture a massa ao molho{ e finalize com :manjericao,queijo}.', req: ['macarrao'] },
    ] },
].map(r => ({ ...r, ingredients: Object.keys(r.amounts) }));

/* Adaptador da API: quando o back-end responder, cada receita passa por aqui.
   Exemplo esperado: { id, name, description, image, category, flavor, temperature,
   prepMinutes, calories, protein, carbs, fat, rating, reviewCount, tags, servings,
   yieldAmount, yieldUnit, ingredients: [{ name, quantity, unit }], steps: [] } */
function normalizeRecipe(api) {
  const amounts = {};
  (api.ingredients || []).forEach(i => { const k = canonical(i.name) || norm(i.name); amounts[k] = [Number(i.quantity) || 0, toBaseUnit(i.unit), i.calories != null ? Number(i.calories) : undefined]; }); // 3º item: kcal exata da API
  return {
    id: String(api.id), title: api.name, desc: api.description || '', img: api.image || '',
    kind: api.category === 'drink' ? 'bebida' : 'comida', taste: api.flavor === 'sweet' ? 'doce' : 'salgado',
    temp: api.temperature === 'cold' ? 'frio' : 'quente', time: api.prepMinutes || 0, kcal: api.calories || 0, kcalExact: api.caloriesPerServing || null, // exata por porção, quando a API enviar
    macros: { p: api.protein || 0, c: api.carbs || 0, g: api.fat || 0 }, rating: api.rating || 0, reviews: api.reviewCount || 0,
    style: api.tags || [], serves: api.servings || 1, yield: [api.yieldAmount || 0, toBaseUnit(api.yieldUnit)],
    amounts, ingredients: Object.keys(amounts), steps: api.steps || [],
  };
}

// ---------- Unidades e quantidades ----------
// Tudo é comparado em "base": g (sólidos), ml (líquidos) ou un (unidades).
function toBaseUnit(u) { u = norm(u || ''); return ['kg', 'g', 'grama', 'gramas'].includes(u) ? 'g' : ['l', 'ml', 'litro', 'litros'].includes(u) ? 'ml' : 'un'; }
function toBase(qty, unit) {
  const u = norm(unit || '');
  if (u === 'kg') return [qty * 1000, 'g'];
  if (u === 'l') return [qty * 1000, 'ml'];
  if (u === 'g' || u === 'ml') return [qty, u];
  if (u === 'un' || u === 'unidades' || u === 'unidade') return [qty, 'un'];
  return [qty, 'outro']; // caixas, pacotes, latas: não dá para comparar com precisão
}
function fmtQty(qty, unit) {
  const n = (v) => (Math.round(v * 10) / 10).toString().replace('.', ',');
  if (unit === 'g') return qty >= 1000 ? `${n(qty / 1000)} kg` : `${Math.round(qty)} g`;
  if (unit === 'ml') return qty >= 1000 ? `${n(qty / 1000)} L` : `${Math.round(qty)} ml`;
  if (unit === 'un') return `${Math.max(1, Math.ceil(qty - 0.05))} un`; // não existe meio ovo: arredonda para cima
  return `${n(qty)} ${unit}`;
}

// ---------- Dietas (derivadas dos ingredientes) ----------
const DIET_BLOCK = {
  vegetariano: ['frango', 'carne', 'peixe', 'atum'],
  'sem-lactose': ['leite', 'queijo', 'manteiga', 'creme de leite', 'iogurte'],
  'sem-gluten': ['farinha', 'pao', 'macarrao', 'aveia'],
};
const DIET_LABEL = { vegetariano: 'Vegetariano', 'sem-lactose': 'Sem lactose', 'sem-gluten': 'Sem glúten' };
const fitsDiet = (r, diet) => diet === 'all' || !r.ingredients.some(i => DIET_BLOCK[diet].includes(i));
const dietsOf = (r) => Object.keys(DIET_BLOCK).filter(d => fitsDiet(r, d));
const byId = (id) => RECIPES.find(r => r.id === id);
const STYLE_LABEL = { proteico: 'receitas proteicas', forno: 'pratos de forno', almoco: 'almoço', rapido: 'receitas rápidas', vegetariano: 'pratos vegetarianos', leve: 'refeições leves', jantar: 'jantar', 'cafe-da-manha': 'café da manhã', sobremesa: 'sobremesas', doce: 'doces', salgado: 'salgados', quente: 'pratos quentes', frio: 'pratos frios', bebida: 'bebidas', comida: 'pratos' };
const catLabel = (r) => r.kind === 'bebida' ? `Bebida ${r.temp === 'quente' ? 'quente' : 'gelada'}` : `${r.taste === 'doce' ? 'Doce' : 'Salgado'} · ${r.temp === 'quente' ? 'quente' : 'frio'}`;
