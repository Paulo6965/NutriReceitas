const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const porta = Number(process.env.PORT || 3000);

// Permite receber formulários HTML e JSON enviado pelo front-end.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ============================================================
// CONEXÃO COM O BANCO
// ============================================================
// Defina estas variáveis no ambiente antes de iniciar o servidor:
// DB_HOST, DB_USER, DB_PASSWORD, DB_NAME e DB_PORT.
const conexao = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "Neripe88!",
    database: process.env.DB_NAME || "ReceitaAcompanha",
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    decimalNumbers: true
});

const TABELAS_OBRIGATORIAS = [
    "recipes",
    "recipe_ingredients",
    "ingredients",
    "user_ingredients"
];

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

function normalizarTexto(valor) {
    return String(valor ?? "")
        .trim()
        .toLocaleLowerCase("pt-BR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function numero(valor) {
    if (typeof valor === "string") {
        valor = valor.trim().replace(",", ".");
    }

    const resultado = Number(valor);
    return Number.isFinite(resultado) ? resultado : NaN;
}

function erroDeEntrada(mensagem) {
    const erro = new Error(mensagem);
    erro.statusCode = 400;
    return erro;
}

function normalizarUnidade(unidade) {
    const valor = normalizarTexto(unidade);

    const aliases = {
        g: "g",
        grama: "g",
        gramas: "g",

        kg: "kg",
        quilo: "kg",
        quilos: "kg",
        quilograma: "kg",
        quilogramas: "kg",

        mg: "mg",
        miligrama: "mg",
        miligramas: "mg",

        ml: "ml",
        mililitro: "ml",
        mililitros: "ml",

        l: "l",
        litro: "l",
        litros: "l",

        cl: "cl",
        centilitro: "cl",
        centilitros: "cl",

        un: "un",
        unidade: "un",
        unidades: "un"
    };

    return aliases[valor] || null;
}

/**
 * Converte uma quantidade para uma unidade-base.
 *
 * Dimensões aceitas:
 * - massa: mg, g e kg, com base em g;
 * - volume: ml, cl e l, com base em ml;
 * - contagem: un, com base em unidades.
 */
function converterParaBase(quantidade, unidade) {
    const valor = numero(quantidade);
    const unidadeNormalizada = normalizarUnidade(unidade);

    if (!Number.isFinite(valor) || valor < 0 || !unidadeNormalizada) {
        return null;
    }

    const conversoes = {
        mg: { dimensao: "massa", unidadeBase: "g", fator: 0.001 },
        g: { dimensao: "massa", unidadeBase: "g", fator: 1 },
        kg: { dimensao: "massa", unidadeBase: "g", fator: 1000 },
        ml: { dimensao: "volume", unidadeBase: "ml", fator: 1 },
        cl: { dimensao: "volume", unidadeBase: "ml", fator: 10 },
        l: { dimensao: "volume", unidadeBase: "ml", fator: 1000 },
        un: { dimensao: "contagem", unidadeBase: "un", fator: 1 }
    };

    const conversao = conversoes[unidadeNormalizada];

    return {
        quantidadeBase: valor * conversao.fator,
        dimensao: conversao.dimensao,
        unidadeBase: conversao.unidadeBase,
        unidadeNormalizada,
        fator: conversao.fator
    };
}

function adicionarAoEstoque(estoque, ingredientId, quantidade, unidade) {
    const convertido = converterParaBase(quantidade, unidade);

    // Dados inválidos no banco não podem tornar uma receita disponível.
    if (!convertido) {
        return false;
    }

    const id = String(ingredientId);

    if (!estoque.has(id)) {
        estoque.set(id, new Map());
    }

    const porDimensao = estoque.get(id);
    const valorAtual = porDimensao.get(convertido.dimensao) || 0;

    porDimensao.set(
        convertido.dimensao,
        valorAtual + convertido.quantidadeBase
    );

    return true;
}

function quantidadeDisponivel(estoque, ingredientId, dimensao) {
    const porDimensao = estoque.get(String(ingredientId));
    return porDimensao?.get(dimensao) || 0;
}

function ehOpcional(valor) {
    return valor === true ||
        Number(valor) === 1 ||
        ["true", "sim", "yes"].includes(normalizarTexto(valor));
}

function escaparHtml(valor) {
    const caracteres = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    };

    return String(valor ?? "").replace(/[&<>"']/g, (caractere) => {
        return caracteres[caractere];
    });
}

function listarNomesDasTabelas(linhas) {
    return linhas.map((linha) => Object.values(linha)[0]);
}

// ============================================================
// DESCOBERTA E VALIDAÇÃO DAS TABELAS
// ============================================================

async function listarTabelas() {
    const [linhas] = await conexao.query("SHOW TABLES");
    return listarNomesDasTabelas(linhas);
}

async function verificarEstruturaDoBanco() {
    const tabelas = await listarTabelas();
    const faltantes = TABELAS_OBRIGATORIAS.filter(
        (tabela) => !tabelas.includes(tabela)
    );

    console.log("Tabelas encontradas no banco:", tabelas.join(", ") || "nenhuma");

    if (faltantes.length > 0) {
        console.warn(
            "Atenção: estas tabelas obrigatórias não foram encontradas:",
            faltantes.join(", ")
        );
    } else {
        console.log("Todas as tabelas necessárias foram encontradas.");
    }

    return { tabelas, faltantes };
}

// ============================================================
// ESTOQUE DO USUÁRIO
// ============================================================

async function montarEstoqueDoBanco(userId) {
    const estoque = new Map();

    const sql = `
        SELECT ingredient_id, quantity, unit
        FROM user_ingredients
        WHERE user_id = ?
          AND status = 'available'
    `;

    const [linhas] = await conexao.execute(sql, [userId]);

    for (const linha of linhas) {
        adicionarAoEstoque(
            estoque,
            linha.ingredient_id,
            linha.quantity,
            linha.unit
        );
    }

    return {
        estoque,
        ingredientesNaoEncontrados: []
    };
}

/**
 * Monta o estoque a partir do payload enviado pelo front-end.
 * Aceita, por exemplo:
 * {
 *   "ingredientes": [
 *     { "nome": "arroz", "quantidade": 1, "unidade": "kg" },
 *     { "nome": "ovo", "quantidade": 6, "unidade": "un" }
 *   ]
 * }
 */
async function montarEstoqueDoFront(ingredientes) {
    if (!Array.isArray(ingredientes)) {
        throw erroDeEntrada("O campo 'ingredientes' deve ser um array.");
    }

    const estoque = new Map();
    const ingredientesNaoEncontrados = [];
    const [catalogo] = await conexao.execute(
        "SELECT id, name FROM ingredients"
    );

    const catalogoPorNome = new Map(
        catalogo.map((item) => [normalizarTexto(item.name), item.id])
    );

    for (const item of ingredientes) {
        if (!item || typeof item !== "object") {
            throw erroDeEntrada("Cada ingrediente deve ser um objeto válido.");
        }

        const nome = item.nome ?? item.ingrediente ?? item.name;
        const idInformado = item.ingredient_id ??
            item.ingredientId ??
            item.ingrediente_id;

        let ingredientId = idInformado;

        if (ingredientId === undefined || ingredientId === null || ingredientId === "") {
            ingredientId = catalogoPorNome.get(normalizarTexto(nome));
        }

        if (ingredientId === undefined || ingredientId === null) {
            ingredientesNaoEncontrados.push({
                nome: nome || "(sem nome)",
                motivo: "Ingrediente não existe na tabela ingredients."
            });
            continue;
        }

        const quantidade = item.quantidade ?? item.quantity;
        const unidade = item.unidade ?? item.unit;
        const convertido = converterParaBase(quantidade, unidade);

        if (!convertido) {
            throw erroDeEntrada(
                `Quantidade ou unidade inválida para o ingrediente '${nome || ingredientId}'.`
            );
        }

        adicionarAoEstoque(
            estoque,
            ingredientId,
            quantidade,
            unidade
        );
    }

    return { estoque, ingredientesNaoEncontrados };
}

// ============================================================
// VERIFICAÇÃO DAS RECEITAS
// ============================================================

async function buscarReceitasAtivas() {
    const sql = `
        SELECT
            r.id AS receita_id,
            r.title AS receita,
            ri.ingredient_id,
            i.name AS ingrediente,
            ri.quantity AS quantidade_necessaria,
            ri.unit AS unidade_necessaria,
            ri.optional AS opcional
        FROM recipes AS r
        LEFT JOIN recipe_ingredients AS ri
            ON ri.recipe_id = r.id
        LEFT JOIN ingredients AS i
            ON i.id = ri.ingredient_id
        WHERE r.status = 'active'
        ORDER BY r.id
    `;

    const [linhas] = await conexao.query(sql);
    return linhas;
}

async function verificarReceitas(userId, ingredientesFrontEnd) {
    const resultadoEstoque = Array.isArray(ingredientesFrontEnd)
        ? await montarEstoqueDoFront(ingredientesFrontEnd)
        : await montarEstoqueDoBanco(userId);

    const linhas = await buscarReceitasAtivas();
    const receitas = new Map();

    for (const linha of linhas) {
        const receitaId = String(linha.receita_id);

        if (!receitas.has(receitaId)) {
            receitas.set(receitaId, {
                id: linha.receita_id,
                nome: linha.receita,
                podeFazer: true,
                ingredientes: [],
                // Uso interno; será removido antes da resposta.
                _requisitos: new Map()
            });
        }

        // Permite que uma receita sem ingredientes cadastrados seja tratada
        // como receita sem requisitos, em vez de desaparecer do resultado.
        if (linha.ingredient_id === null || linha.ingredient_id === undefined) {
            continue;
        }

        const receita = receitas.get(receitaId);
        const opcional = ehOpcional(linha.opcional);
        const convertido = converterParaBase(
            linha.quantidade_necessaria,
            linha.unidade_necessaria
        );

        const chave = convertido
            ? `${linha.ingredient_id}|${convertido.dimensao}`
            : `${linha.ingredient_id}|unidade-invalida`;

        if (!receita._requisitos.has(chave)) {
            receita._requisitos.set(chave, {
                ingredientId: linha.ingredient_id,
                nome: linha.ingrediente,
                quantidadeBase: 0,
                unidadeOriginal: normalizarUnidade(linha.unidade_necessaria) ||
                    linha.unidade_necessaria,
                opcional,
                convertido
            });
        }

        const requisito = receita._requisitos.get(chave);

        // Se o mesmo ingrediente aparecer mais de uma vez, as quantidades
        // são somadas. Se uma ocorrência for obrigatória, o total também é.
        if (convertido) {
            requisito.quantidadeBase += convertido.quantidadeBase;
        }

        requisito.opcional = requisito.opcional && opcional;
    }

    for (const receita of receitas.values()) {
        for (const requisito of receita._requisitos.values()) {
            const convertido = requisito.convertido;
            let disponivelBase = 0;
            let quantidadeNecessaria = requisito.quantidadeBase;
            let unidadeNecessaria = requisito.unidadeOriginal;
            let disponivel = 0;
            let suficiente = false;

            if (convertido) {
                disponivelBase = quantidadeDisponivel(
                    resultadoEstoque.estoque,
                    requisito.ingredientId,
                    convertido.dimensao
                );

                quantidadeNecessaria = requisito.quantidadeBase / convertido.fator;
                disponivel = disponivelBase / convertido.fator;
                unidadeNecessaria = convertido.unidadeNormalizada;
                suficiente = disponivelBase + 1e-9 >= requisito.quantidadeBase;
            }

            if (!requisito.opcional && !suficiente) {
                receita.podeFazer = false;
            }

            receita.ingredientes.push({
                ingredient_id: requisito.ingredientId,
                nome: requisito.nome,
                necessario: quantidadeNecessaria,
                unidadeNecessaria,
                disponivel,
                unidadeDisponivel: unidadeNecessaria,
                opcional: requisito.opcional,
                suficiente
            });
        }

        delete receita._requisitos;
    }

    return {
        receitas: Array.from(receitas.values()).filter(
            (receita) => receita.podeFazer
        ),
        ingredientesNaoEncontrados: resultadoEstoque.ingredientesNaoEncontrados
    };
}

// ============================================================
// CADASTRO DE INGREDIENTE DO USUÁRIO
// ============================================================

async function encontrarOuCriarIngrediente(nome) {
    const [ingredientes] = await conexao.execute(
        "SELECT id, name FROM ingredients"
    );

    const nomeNormalizado = normalizarTexto(nome);
    const existente = ingredientes.find(
        (item) => normalizarTexto(item.name) === nomeNormalizado
    );

    if (existente) {
        return existente.id;
    }

    const [resultado] = await conexao.execute(
        "INSERT INTO ingredients (name) VALUES (?)",
        [nome.trim()]
    );

    return resultado.insertId;
}

async function salvarIngredienteDoUsuario({
    ingredientId,
    quantidade,
    unidade,
    userId
}) {
    const sql = `
        INSERT INTO user_ingredients
            (user_id, ingredient_id, quantity, unit, status)
        VALUES (?, ?, ?, ?, 'available')
    `;

    await conexao.execute(sql, [
        userId,
        ingredientId,
        quantidade,
        unidade
    ]);
}

async function usuarioExiste(userId) {
    const [usuarios] = await conexao.execute(
        "SELECT id FROM users WHERE id = ? LIMIT 1",
        [userId]
    );

    return usuarios.length > 0;
}

// ============================================================
// ROTAS
// ============================================================

app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Ingredientes e receitas</title>
        </head>
        <body>
            <h1>Cadastro de ingredientes</h1>

            <form action="/ingredientes" method="POST">
                <label>
                    Usuário:
                    <input type="number" name="userId" value="1" min="1" required>
                </label>
                <br><br>

                <label>
                    Ingrediente:
                    <input type="text" name="ingrediente" required>
                </label>
                <br><br>

                <label>
                    Quantidade:
                    <input type="number" name="quantidade" step="0.001" min="0" required>
                </label>
                <br><br>

                <label>
                    Unidade:
                    <select name="unidade">
                        <option value="g">Gramas</option>
                        <option value="kg">Quilos</option>
                        <option value="mg">Miligramas</option>
                        <option value="ml">Mililitros</option>
                        <option value="l">Litros</option>
                        <option value="un">Unidade</option>
                    </select>
                </label>
                <br><br>

                <button type="submit">Salvar ingrediente</button>
            </form>

            <p>
                Para o front-end, use também <code>POST /receitas/verificar</code>
                enviando JSON.
            </p>
        </body>
        </html>
    `);
});

app.post("/ingredientes", async (req, res) => {
    try {
        const ingrediente = String(req.body.ingrediente || "").trim();
        const quantidade = numero(req.body.quantidade);
        const unidade = normalizarUnidade(req.body.unidade);
        const userId = Number(req.body.userId || 1);

        if (!ingrediente || !Number.isFinite(quantidade) || quantidade <= 0) {
            return res.status(400).send("Ingrediente ou quantidade inválida.");
        }

        if (!unidade) {
            return res.status(400).send("Unidade inválida.");
        }

        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).send("userId inválido.");
        }

        if (!(await usuarioExiste(userId))) {
            return res.status(400).send(
                `Não existe usuário com id ${userId}. Informe um ID existente na tabela users ou cadastre o usuário antes.`
            );
        }

        const ingredientId = await encontrarOuCriarIngrediente(ingrediente);

        await salvarIngredienteDoUsuario({
            ingredientId,
            quantidade,
            unidade,
            userId
        });

        const resultado = await verificarReceitas(userId);
        const receitas = resultado.receitas;

        let html = `
            <h1>Ingrediente salvo!</h1>
            <p><strong>Ingrediente:</strong> ${escaparHtml(ingrediente)}</p>
            <p><strong>Quantidade:</strong> ${escaparHtml(quantidade)} ${escaparHtml(unidade)}</p>
            <h2>Receitas disponíveis</h2>
        `;

        if (receitas.length === 0) {
            html += `
                <p>Nenhuma receita pode ser feita com os ingredientes disponíveis.</p>
            `;
        } else {
            html += "<ul>";

            for (const receita of receitas) {
                html += `<li>${escaparHtml(receita.nome)}</li>`;
            }

            html += "</ul>";
        }

        html += `
            <br>
            <a href="/">Cadastrar outro ingrediente</a>
        `;

        return res.send(html);
    } catch (erro) {
        console.error("Erro ao salvar ingrediente:", erro);
        return res.status(500).send("Erro ao salvar o ingrediente.");
    }
});

/**
 * Verifica uma lista enviada pelo front-end sem precisar gravá-la em
 * user_ingredients.
 *
 * Exemplo de body:
 * {
 *   "userId": 1,
 *   "ingredientes": [
 *     { "nome": "arroz", "quantidade": 1, "unidade": "kg" },
 *     { "nome": "ovo", "quantidade": 6, "unidade": "un" }
 *   ]
 * }
 */
app.post("/receitas/verificar", async (req, res) => {
    try {
        const userId = Number(req.body.userId || 1);
        const ingredientes = req.body.ingredientes;

        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({
                erro: "userId inválido."
            });
        }

        const resultado = await verificarReceitas(userId, ingredientes);

        return res.json(resultado);
    } catch (erro) {
        console.error("Erro ao verificar receitas:", erro);
        return res.status(erro.statusCode || 500).json({
            erro: erro.statusCode ? erro.message : "Erro ao verificar receitas."
        });
    }
});

// Mantém a rota original: usa os ingredientes já salvos no banco para o usuário.
app.get("/receitas-disponiveis/:userId", async (req, res) => {
    try {
        const userId = Number(req.params.userId);

        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ erro: "userId inválido." });
        }

        const resultado = await verificarReceitas(userId);
        return res.json(resultado.receitas);
    } catch (erro) {
        console.error("Erro ao buscar receitas disponíveis:", erro);
        return res.status(500).json({
            erro: "Erro ao verificar receitas."
        });
    }
});

// Ajuda a confirmar quais tabelas o usuário configurou no banco.
// Em produção, proteja ou remova esta rota para não expor metadados do banco.
app.get("/tabelas", async (req, res) => {
    try {
        const estrutura = await verificarEstruturaDoBanco();
        return res.json(estrutura);
    } catch (erro) {
        console.error("Erro ao listar tabelas:", erro);
        return res.status(500).json({
            erro: "Não foi possível listar as tabelas do banco."
        });
    }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

async function iniciarServidor() {
    try {
        await conexao.query("SELECT 1");
        await verificarEstruturaDoBanco();

        app.listen(porta, () => {
            console.log(`Servidor rodando em http://localhost:${porta}`);
        });
    } catch (erro) {
        console.error("Não foi possível iniciar o servidor:", erro.message);
        process.exitCode = 1;
    }
}

iniciarServidor();
