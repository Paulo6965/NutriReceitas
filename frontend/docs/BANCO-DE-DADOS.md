# Banco de dados e API — o que salvar em cada parte do site

Regra do projeto: **tudo o que a pessoa cria, escolhe ou altera precisa ser salvo na conta dela** e voltar igual em qualquer aparelho.

Hoje tudo já é salvo pela camada `db` (`js/storage.js`) no `localStorage`, com uma chave por usuário (`nr:<email>:<item>`). Na integração, cada chave abaixo vira uma tabela no Supabase. As funções que leem e gravam continuam com o mesmo nome, só muda o que elas fazem por dentro.

## Mapa: parte do site → o que salvar → onde está no código

| Parte do site | O que é salvo | Chave atual (`db`) | Tabela | Código |
|---|---|---|---|---|
| Login / cadastro | conta, nome, e-mail | `nr:session` | `auth.users` + `profiles` | `js/auth.js` → `signIn()`, `signOut()` |
| Tema | claro / escuro | `nr:theme` + `prefs.theme` | `user_preferences` | `js/main.js` → `setTheme()` |
| Busca (NutriChef + filtros) | ingredientes, filtros (tipo, sabor, temperatura, dieta), ordenação, porção | `session` | `user_session` | `Session` (`js/store.js`), `restoreSession()` (`js/recipes.js`) |
| Conversa com o NutriChef | mensagens (últimas 40) | `chat` | `chat_messages` | `ChatHistory` (`js/store.js`), `saveChat()` / `restoreChat()` (`js/chat.js`) |
| Estoque | itens, tipo, quantidade, unidade, observação, validade | `stock` | `stock_items` | `Stock` (`js/store.js`) |
| Favoritos | receita + versão personalizada (porções, ingredientes incluídos, quantidades, unidades) | `favs` | `favorites` | `Favs` (`js/store.js`), `currentConfig()` (`js/modals.js`) |
| Cozinhei | receita preparada, versão usada, calorias, o que saiu do estoque, data | `cooked` | `cooked` | `Cooked` (`js/store.js`), `cookRecipe()` (`js/modals.js`) |
| Avisos de validade (sininho) | avisos gerados, lidos/não lidos | `notifications` | `notifications` | `Notify` (`js/notifications.js`) + Edge Function `expiry-alerts` |
| Preferências de aviso | no site, por e-mail, dias de antecedência | `notifyPrefs` | `notification_prefs` | `Notify.prefs()` / `savePrefs()` |
| E-mails de aviso | e-mail-resumo diário | `emailOutbox` (só prévia) | enviado pelo servidor (Resend) | `supabase/functions/expiry-alerts/index.ts` |
| Recomendações | pesos de gosto (buscas, receitas vistas, favoritos, cozinhadas) | `profile` | `taste_profile` (ou `user_events`) | `Reco` (`js/store.js`) |
| Receitas | catálogo | — (mock em `js/catalog.js`) | `recipes` / API externa | `normalizeRecipe()` (`js/catalog.js`) |
| Nutrição | kcal, proteína, carboidrato, gordura por ingrediente | — (médias em `js/nutrition.js`) | `ingredients_nutrition` / API externa | `Nutrition.loadExact()` (`js/nutrition.js`) |

> **Ao criar algo novo no site que a pessoa possa alterar, acrescente uma linha nesta tabela e salve pela camada `db`.**

## SQL para o Supabase

```sql
-- Perfil (complementa auth.users)
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  name text,
  created_at timestamptz default now()
);

-- Preferências
create table user_preferences (
  user_id uuid primary key references auth.users on delete cascade,
  theme text check (theme in ('light','dark')),
  updated_at timestamptz default now()
);

-- Estado da busca (para continuar de onde parou)
create table user_session (
  user_id uuid primary key references auth.users on delete cascade,
  ingredients jsonb default '[]',        -- ["frango","batata"]
  filters jsonb default '{}',            -- {kind, taste, temp, diet}
  sort text default 'relevance',
  portion jsonb,                          -- {kind:'solid', value:250, unit:'g', applied:true}
  updated_at timestamptz default now()
);

-- Conversa com o NutriChef
create table chat_messages (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade,
  role text check (role in ('user','bot')),
  html text not null,                    -- já escapado no front; ideal: guardar também o texto puro
  created_at timestamptz default now()
);

-- Estoque
create table stock_items (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade,
  name text not null,
  kind text check (kind in ('solid','liquid','unit')),
  qty numeric not null,
  unit text not null,                    -- g, kg, ml, L, unidades, caixas...
  note text,
  expires_on date,
  created_at timestamptz default now()
);

-- Favoritos (com a versão personalizada da receita)
create table favorites (
  user_id uuid references auth.users on delete cascade,
  recipe_id text not null,
  servings int,
  included jsonb,                         -- ingredientes incluídos
  adjustments jsonb,                      -- {ingrediente: multiplicador}
  units jsonb,                            -- {ingrediente: 'kg' | 'g' | ...}
  saved_at timestamptz default now(),
  primary key (user_id, recipe_id)
);

-- Histórico "Cozinhei"
create table cooked (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade,
  recipe_id text not null,
  config jsonb not null,                  -- mesma estrutura do favorito
  kcal_total int,
  kcal_per_serving int,
  used_from_stock jsonb,                  -- ["375 ml de leite", "3 un de ovo"]
  cooked_at timestamptz default now()
);

-- Perfil de gosto (recomendações)
create table taste_profile (
  user_id uuid primary key references auth.users on delete cascade,
  weights jsonb default '{}',             -- {"ing:frango": 4.2, "taste:doce": 1.5, ...}
  events int default 0,
  updated_at timestamptz default now()
);

-- Preferências de aviso de validade
create table notification_prefs (
  user_id uuid primary key references auth.users on delete cascade,
  site boolean default true,
  email boolean default true,
  days int default 3 check (days between 1 and 7),
  updated_at timestamptz default now()
);

-- Avisos (sininho do site) — criados pela Edge Function "expiry-alerts"
create table notifications (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade,
  stock_item_id bigint references stock_items on delete cascade,
  key text not null,                      -- "<item>:<soon|today|expired>:<validade>" evita aviso repetido
  status text check (status in ('soon','today','expired')),
  title text not null,
  body text,
  show_on_site boolean default true,
  read_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz default now(),
  unique (user_id, key)
);

-- Rodar a verificação todo dia às 8h (horário de Brasília = 11h UTC)
-- Requer as extensões pg_cron e pg_net habilitadas no Supabase.
select cron.schedule('expiry-alerts', '0 11 * * *', $$
  select net.http_post(
    url := 'https://<SEU-PROJETO>.supabase.co/functions/v1/expiry-alerts',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')
  );
$$);

-- Segurança: cada pessoa só vê e altera os próprios dados
alter table profiles          enable row level security;
alter table user_preferences  enable row level security;
alter table user_session      enable row level security;
alter table chat_messages     enable row level security;
alter table stock_items       enable row level security;
alter table favorites         enable row level security;
alter table cooked            enable row level security;
alter table taste_profile     enable row level security;
alter table notification_prefs enable row level security;
alter table notifications     enable row level security;
create policy "dono" on notification_prefs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "dono" on notifications      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "dono" on profiles         for all using (auth.uid() = id)      with check (auth.uid() = id);
create policy "dono" on user_preferences for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "dono" on user_session     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "dono" on chat_messages    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "dono" on stock_items      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "dono" on favorites        for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "dono" on cooked           for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "dono" on taste_profile    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

## Checklist da integração

- [ ] Trocar `signIn()` / `signOut()` por `supabase.auth` e usar `auth.uid()` no lugar do e-mail em `userKey()`.
- [ ] Trocar a camada `db` por chamadas ao Supabase (ou criar um `db` assíncrono e ajustar `Stock`, `Favs`, `Cooked`, `Reco`, `Session`, `ChatHistory`).
- [ ] **Migração:** no primeiro login, enviar para o banco o que estiver no `localStorage` da pessoa (estoque, favoritos, cozinhei, sessão, conversa, gosto) e depois limpar.
- [ ] Visitante (sem conta): continua salvando localmente e oferece "Entre para salvar na sua conta".
- [ ] Gravar com atraso curto (debounce de ~500 ms) o que muda muito: sessão de busca e conversa.
- [ ] Ligar `normalizeRecipe()` à API de receitas e `Nutrition.loadExact()` à API de nutrição.
- [ ] Avisos de validade: criar conta no Resend (ou outro serviço de e-mail), verificar o domínio, cadastrar os secrets e fazer o deploy de `supabase/functions/expiry-alerts`. No site, trocar `Notify.sync()` por leitura da tabela `notifications` (e assinar via Realtime para o sininho atualizar sozinho).
- [ ] Testar: entrar em outro navegador e conferir que tudo da tabela acima voltou igual.
