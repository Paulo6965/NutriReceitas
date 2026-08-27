const express = require("express");
const mysql = require("mysql2");

const app = express();
const porta = 3000;

app.use(express.urlencoded({ extended: true }));

const conexao = mysql.createConnection({
    host: "localhost",
    port: 3306,
    user: "root",
    password: "Neripe88!",
    database: "teste_node"
});

conexao.connect((erro) => {
    if (erro) {
        console.log("Erro ao conectar no MySQL:");
        console.log(erro.message);
        return;
    }

    console.log("Conectado ao MySQL com sucesso!");
});

app.get("/", (req, res) => {
    res.send(`
        <h1>Cadastro de usuário</h1>

        <form action="/usuarios" method="POST">
            <label>Digite seu nome:</label>
            <input type="text" name="nome">

            <button type="submit">Salvar</button>
        </form>
    `);
});

app.post("/usuarios", (req, res) => {

    const nome = req.body.nome;

    console.log("Nome recebido:", nome);

    const sql = "INSERT INTO usuarios (nome) VALUES (?)";

    conexao.query(sql, [nome], (erro, resultado) => {

        if (erro) {
            console.log("Erro ao salvar usuário:");
            console.log(erro.message);
            return;
        }

        console.log("Usuário salvo com sucesso!");

        res.send("Usuário salvo com sucesso!");
    });
});

app.listen(porta, () => {
    console.log(`Servidor rodando em http://localhost:${porta}`);
});