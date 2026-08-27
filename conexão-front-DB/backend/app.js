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

//criando o servidor na porta 3000 usa req e res para receber os pedidos e enviar as informações 
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
    console.log(`Servidor rodando em http://localhost:${porta}`); //Comando utilizado para ele ouvir o servidor criado e pode receber as informações do front e enviar para o DB
});
