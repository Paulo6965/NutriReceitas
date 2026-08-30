const express = require("express");
const mysql = require("mysql2");
const { spawn } = require("child_process");
const path = require("path");

const app = express();
const porta = 3000;


// Permite receber dados enviados pelos formulários
app.use(express.urlencoded({ extended: true }));


// Configuração da conexão com o MySQL
const conexao = mysql.createConnection({
    host: "localhost",
    port: 3306,
    user: "root",
    password: "Neripe88!",
    database: "teste_node"
});


// Conecta ao MySQL
conexao.connect((erro) => {

    if (erro) {
        console.log("Erro ao conectar no MySQL:");
        console.log(erro.message);
        return;
    }

    console.log("Conectado ao MySQL com sucesso!");

});


// ==============================
// PÁGINA PRINCIPAL
// ==============================

app.get("/", (req, res) => {

    res.send(`
        <h1>Cadastro de usuário</h1>

        <h3>Digite seu nome</h3>

        <form action="/usuarios" method="POST">

            <label>Digite seu nome:</label>

            <input type="text" name="nome">

            <button type="submit">Salvar</button>

        </form>


        <hr>


        <h3>Cadastro por voz</h3>

        <form action="/voz" method="POST">

            <button type="submit">🎤 Falar</button>

        </form>
    `);

});


// ==============================
// SALVAR NOME DIGITADO
// ==============================

app.post("/usuarios", (req, res) => {

    // Pega o nome enviado pelo formulário
    const nome = req.body.nome;

    console.log("Nome recebido:", nome);


    // Comando SQL
    const sql = "INSERT INTO usuarios (nome) VALUES (?)";


    // Executa o comando no MySQL
    conexao.query(sql, [nome], (erro, resultado) => {

        if (erro) {

            console.log("Erro ao salvar usuário:");
            console.log(erro.message);

            return res.send("Erro ao salvar usuário.");

        }


        console.log("Usuário salvo com sucesso!");

        res.send(`
            <h1>Usuário salvo com sucesso!</h1>

            <p>Nome: ${nome}</p>

            <a href="/">Voltar</a>
        `);

    });

});

app.post("/voz", (req, res) => {

    console.log("Iniciando reconhecimento de voz...");


    // Cria o caminho até o arquivo Python
    const caminhoPython = path.join(
        __dirname,
        "teste-voz.py"
    );


    // Executa o arquivo Python
    const python = spawn(
        "python",
        [caminhoPython]
    );


    // Variável que vai guardar o texto reconhecido
    let textoReconhecido = "";


    // Recebe os dados enviados pelo Python
    python.stdout.on("data", (dados) => {

        textoReconhecido += dados.toString();

    });


    // Recebe possíveis erros do Python
    python.stderr.on("data", (erro) => {

        console.log("Erro no Python:");

        console.log(erro.toString());

    });


    // Executa quando o programa Python termina
    python.on("close", (codigo) => {

        // Remove espaços e quebras de linha
        textoReconhecido = textoReconhecido.trim();


        console.log("Python terminou com código:", codigo);

        console.log(
            "Texto reconhecido:",
            textoReconhecido
        );


        // Verifica se ocorreu algum erro no reconhecimento
        if (
            textoReconhecido === "ERRO_TIMEOUT" ||
            textoReconhecido === "ERRO_NAO_ENTENDI" ||
            textoReconhecido === "ERRO_CONEXAO"
        ) {

            return res.send(`
                <h1>Erro no reconhecimento de voz</h1>

                <p>${textoReconhecido}</p>

                <a href="/">Voltar</a>
            `);

        }

        if (!textoReconhecido) {

            return res.send(`
                <h1>Nenhum texto foi reconhecido.</h1>

                <a href="/">Voltar</a>
            `);

        }

        const sql =
            "INSERT INTO usuarios (nome) VALUES (?)";
        conexao.query(
            sql,
            [textoReconhecido],
            (erro, resultado) => {
                if (erro) {
                    console.log(
                        "Erro ao salvar no MySQL:"
                    );
                    console.log(
                        erro.message
                    );
                    return res.send(
                        "Erro ao salvar usuário."
                    );
                }
                console.log(
                    "Usuário salvo por voz com sucesso!"
                );
                console.log(
                    "ID criado:",
                    resultado.insertId
                );
                res.send(`
                    <h1>Usuário salvo com sucesso!</h1>
                    <p>
                        Você disse:
                        ${textoReconhecido}
                    </p>
                    <p>
                        ID criado:
                        ${resultado.insertId}
                    </p>
                    <a href="/">Voltar</a>
                `);
            }
        );
    });
});

app.listen(porta, () => {
    console.log(
        `Servidor rodando em http://localhost:${porta}`
    );
});
