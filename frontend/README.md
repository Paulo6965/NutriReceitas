# NutriReceitas

Site de receitas com o **NutriChef**, um assistente que sugere receitas a partir dos ingredientes que a pessoa tem em casa (por texto ou voz), com estoque, validade, favoritos, filtros e recomendações personalizadas.

> Protótipo de front-end: os dados ficam no `localStorage` do navegador até a integração com Supabase e com a API de receitas.

## Como rodar

Não há etapa de build e **o site funciona sem internet**: Tailwind, fontes e fotos estão dentro da pasta (`vendor/`, `fonts/`, `Imagens/`). Só a entrada por voz usa serviços online.

No Windows, dê dois cliques em **`iniciar-site.bat`**: ele abre o site em `http://localhost:5500`.

> Não abra o `index.html` direto (endereço `file://`): o navegador bloqueia o **microfone** nesse modo e a entrada por voz não funciona.

Ou, pelo terminal:

```bash
python -m http.server 5500
```

Depois abra `http://localhost:5500`.

## Estrutura

```
index.html          Estrutura da página (HTML)
css/styles.css      Estilos, temas claro/escuro e responsividade
js/
  theme-init.js     Aplica o tema antes de desenhar a página (carregado no <head>)
  utils.js          Utilidades: $, esc, norm, toast, ícones
  storage.js        Persistência (localStorage) → trocar por Supabase
  catalog.js        Ingredientes, receitas (mock), normalizeRecipe() da API, unidades, dietas
  nutrition.js      Calorias por ingrediente (médias) e cálculo pela quantidade; gancho da API
  store.js          Estado, algoritmo de recomendação, favoritos e estoque
  chat.js           Ingredientes selecionados + NutriChef (chat)
  recipes.js        Busca, cards, recomendados e filtros
  voice.js          Entrada por voz: nativa (Chrome/Edge/Safari) ou Whisper local (Firefox/Brave/Opera…)
  modals.js         Janelas, acessibilidade, receita (porções, "Cozinhei!"), favoritos, estoque
  auth.js           Login/cadastro de demonstração e animações do painel
  main.js           Borda animada, cabeçalho, modo claro/escuro, inicialização
Imagens/            Imagens locais (Hero + fotos das receitas em Imagens/receitas/)
fonts/              Fontes Fraunces e Plus Jakarta Sans (woff2) + css/fonts.css
vendor/             Tailwind (tailwindcss.min.js) — sem CDN
versoes-antigas/    Versões anteriores do layout (referência)
```

Os scripts são carregados **em ordem** no fim do `index.html`. Cada arquivo pode usar o que os anteriores definem.

## Pontos de integração

> Mapa completo do que salvar em cada parte do site, SQL do Supabase e checklist: **[docs/BANCO-DE-DADOS.md](docs/BANCO-DE-DADOS.md)**.

| O quê | Onde | Como |
|---|---|---|
| Login/cadastro | `js/auth.js` → `signIn()` | `supabase.auth.signInWithPassword` / `signUp` |
| Favoritos, estoque, perfil de gosto | `js/storage.js` → `db` | Tabelas no Supabase, mantendo `get/set/del` |
| Receitas | `js/catalog.js` → `normalizeRecipe()` | Converter a resposta da API para o formato interno |
| Calorias exatas dos ingredientes | `js/nutrition.js` → `Nutrition.loadExact()` | `GET /api/nutrition?ingredients=...` (substitui as médias da `KCAL_TABLE`) |
| Calorias exatas dos pratos | `js/catalog.js` → `normalizeRecipe()` | Campos `caloriesPerServing` (prato) e `ingredients[].calories` |
| NutriChef (IA) | `js/chat.js` → `handleChat()` | `POST /api/chef` com mensagem, ingredientes, filtros e estoque |
| Tema salvo | `js/main.js` → `setTheme()` | Opcional: salvar no perfil do usuário |

## Próximos passos

- Para produção: trocar o Tailwind em tempo real (`vendor/tailwindcss.min.js`) por um CSS compilado, que carrega mais rápido.
- Favicon, Open Graph e metadados de SEO.
