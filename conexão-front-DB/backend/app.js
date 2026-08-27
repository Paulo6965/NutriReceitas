const express = require("express"); //importando express
const mysql = require("mysql2"); // importando mysql2 para fazer a conexão com node js

const app = express(); //Definindo qual vai ser a variavel para express nese caso "app"
const porta = 3000; //definindo qual vai ser a porta utilizada no servidor

app.use(express.urlencoded({ extended: true }));

const conexao = mysql.createConnection({  //Criando conexão com o MySQL e fornecendo as informaçoes necessarias
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

//criando um codigo basico de front para rodar no servidor com alguns comandos de back como req(request) e res(respond)
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

    const sql = "INSERT INTO usuarios (nome) VALUES (?)";  //comando usado para fazer insert nas tabelas do MySQl (?) 

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
    console.log(`Servidor rodando em http://localhost:${porta}`); //Criando o servidor e dizendo para o codigo ouvir o que acontece nele
});
