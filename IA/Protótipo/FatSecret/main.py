
import json
import os
import re
from typing import Any

import requests
from dotenv import load_dotenv
from ollama import chat


# ============================================================
# CONFIGURAÇÃO
# ============================================================

load_dotenv()

MODEL = "qwen3:4b"

FATSECRET_CLIENT_ID = os.getenv("FATSECRET_CLIENT_ID")
FATSECRET_CLIENT_SECRET = os.getenv("FATSECRET_CLIENT_SECRET")

TOKEN_URL = "https://oauth.fatsecret.com/connect/token"
API_BASE_URL = "https://platform.fatsecret.com/rest"

if not FATSECRET_CLIENT_ID or not FATSECRET_CLIENT_SECRET:
    raise RuntimeError(
        "Configure FATSECRET_CLIENT_ID e FATSECRET_CLIENT_SECRET no .env."
    )


# ============================================================
# ESTADO DA SESSÃO
# Futuramente, será substituído/integrado à sessão web.
# ============================================================

sessao = {
    "ultima_receita": None,
    "candidatas": [],
    "token": None,
}

http = requests.Session()


# ============================================================
# FATSECRET: AUTENTICAÇÃO E REQUISIÇÕES
# ============================================================

def obter_token() -> str:
    """Obtém um token OAuth 2.0 para acessar a API."""

    if sessao["token"] is not None:
        return sessao["token"]

    resposta = http.post(
        TOKEN_URL,
        auth=(FATSECRET_CLIENT_ID, FATSECRET_CLIENT_SECRET),
        data={
            "grant_type": "client_credentials",
            "scope": "basic",
        },
        timeout=20,
    )

    if not resposta.ok:
        raise RuntimeError(
            f"Falha na autenticação FatSecret. "
            f"HTTP {resposta.status_code}. "
            f"Resposta: {resposta.text}"
        )

    dados = resposta.json()

    token = dados.get("access_token")
    if not token:
        raise RuntimeError("O FatSecret não retornou um token de acesso.")

    sessao["token"] = token
    return token


def requisitar_fatsecret(endpoint: str, parametros: dict) -> dict:
    """Executa uma requisição autenticada à API."""

    token = obter_token()

    resposta = http.get(
        f"{API_BASE_URL}/{endpoint}",
        headers={"Authorization": f"Bearer {token}"},
        params={**parametros, "format": "json"},
        timeout=30,
    )

    # Se o token expirou, limpa o token e tenta novamente uma vez.
    if resposta.status_code == 401:
        sessao["token"] = None
        token = obter_token()

        resposta = http.get(
            f"{API_BASE_URL}/{endpoint}",
            headers={"Authorization": f"Bearer {token}"},
            params={**parametros, "format": "json"},
            timeout=30,
        )

    resposta.raise_for_status()
    dados = resposta.json()

    if not isinstance(dados, dict):
        raise RuntimeError("A API retornou um formato inesperado.")

    return dados


def como_lista(valor: Any) -> list:
    """Normaliza campos que podem vir como objeto, lista ou ausentes."""

    if valor is None:
        return []

    if isinstance(valor, list):
        return valor

    if isinstance(valor, dict):
        return [valor]

    return []


# ============================================================
# TOOL 1: PESQUISAR RECEITAS
# ============================================================

def buscar_receitas(consulta: str) -> str:
    """Pesquisa receitas no FatSecret e guarda as candidatas."""

    consulta = consulta.strip()

    if not consulta:
        return json.dumps({
            "erro": "Informe o nome ou tipo de receita para pesquisar."
        }, ensure_ascii=False)

    try:
        dados = requisitar_fatsecret(
            "recipes/search/v3",
            {
                "search_expression": consulta,
                "max_results": 5,
                "page_number": 0,
            },
        )

        receitas_api = dados.get("recipes", {})
        receitas = como_lista(receitas_api.get("recipe"))

        candidatas = []

        for receita in receitas:
            if not isinstance(receita, dict):
                continue

            recipe_id = receita.get("recipe_id")
            nome = receita.get("recipe_name")

            if recipe_id is None or not nome:
                continue

            candidatas.append({
                "recipe_id": str(recipe_id),
                "titulo": nome,
                "descricao": receita.get("recipe_description"),
                "url": receita.get("recipe_url"),
            })

        # Só são aceitos IDs retornados nesta pesquisa.
        sessao["candidatas"] = candidatas

        if not candidatas:
            return json.dumps({
                "resultado": "nenhuma_receita_encontrada",
                "mensagem": (
                    "O FatSecret não retornou receitas para essa pesquisa. "
                    "Tente outros termos. Não invente uma receita."
                ),
            }, ensure_ascii=False)

        return json.dumps({
            "resultado": "receitas_encontradas",
            "receitas": candidatas,
            "instrucao": (
                "Escolha uma receita retornada e use obter_detalhes_receita "
                "com o recipe_id correspondente antes de apresentar "
                "ingredientes ou instruções."
            ),
        }, ensure_ascii=False)

    except requests.RequestException as erro:
        return json.dumps({
            "erro": "falha_na_consulta_fatsecret",
            "detalhes": str(erro),
        }, ensure_ascii=False)

    except (ValueError, RuntimeError) as erro:
        return json.dumps({
            "erro": "resposta_fatsecret_invalida",
            "detalhes": str(erro),
        }, ensure_ascii=False)


# ============================================================
# TOOL 2: CONSULTAR OS DETALHES DA RECEITA
# ============================================================

def obter_detalhes_receita(recipe_id: str) -> str:
    """
    Consulta uma receita encontrada pela ferramenta de pesquisa.
    Armazena os dados retornados na sessão, sem gerar instruções.
    """

    recipe_id = str(recipe_id)

    ids_permitidos = {
        receita["recipe_id"]
        for receita in sessao["candidatas"]
    }

    if recipe_id not in ids_permitidos:
        return json.dumps({
            "erro": "recipe_id_nao_autorizado",
            "mensagem": (
                "O identificador não pertence à pesquisa atual. "
                "Pesquise novamente antes de consultar os detalhes."
            ),
        }, ensure_ascii=False)

    try:
        dados = requisitar_fatsecret(
            "recipe/v2",
            {"recipe_id": recipe_id},
        )

        receita_api = dados.get("recipe")

        if not isinstance(receita_api, dict):
            return json.dumps({
                "erro": "detalhes_nao_encontrados",
                "mensagem": "O FatSecret não retornou os detalhes da receita.",
            }, ensure_ascii=False)

        ingredientes_api = como_lista(
            receita_api.get("ingredients", {}).get("ingredient")
            if isinstance(receita_api.get("ingredients"), dict)
            else None
        )

        direcoes_api = como_lista(
            receita_api.get("directions", {}).get("direction")
            if isinstance(receita_api.get("directions"), dict)
            else None
        )

        ingredientes = []

        for item in ingredientes_api:
            if not isinstance(item, dict):
                continue

            descricao = item.get("ingredient_description")
            nome = item.get("food_name")

            texto = descricao or nome
            if texto:
                ingredientes.append(texto)

        # Mantém a ordem informada pelo FatSecret.
        direcoes_api.sort(
            key=lambda item: int(item.get("direction_number", 0))
            if isinstance(item, dict)
            else 0
        )

        passos = [
            item["direction_description"]
            for item in direcoes_api
            if isinstance(item, dict)
            and item.get("direction_description")
        ]

        porcoes = receita_api.get("number_of_servings")

        nutricao_api = receita_api.get("serving_sizes", {})
        nutricao = {}

        if isinstance(nutricao_api, dict):
            porcao = nutricao_api.get("serving")

            if isinstance(porcao, list):
                porcao = porcao[0] if porcao else None

            if isinstance(porcao, dict):
                for campo in (
                    "serving_size",
                    "calories",
                    "protein",
                    "carbohydrate",
                    "fat",
                    "fiber",
                    "sodium",
                ):
                    if campo in porcao:
                        nutricao[campo] = porcao[campo]

        receita = {
            "titulo": receita_api.get("recipe_name"),
            "ingredientes": ingredientes,
            "passo_a_passo": passos,
            "fonte": "FatSecret",
            "url_fonte": receita_api.get("recipe_url"),
            "recipe_id": str(receita_api.get("recipe_id", recipe_id)),
            "tempo_preparo_minutos": receita_api.get(
                "preparation_time_min"
            ),
            "tempo_cozimento_minutos": receita_api.get(
                "cooking_time_min"
            ),
            "porcoes": porcoes,
            "nutricao": nutricao,
            "aviso": (
                None
                if passos
                else (
                    "A API não retornou instruções para esta receita. "
                    "O passo a passo não foi inventado."
                )
            ),
        }

        # Não guardar como receita válida se não houver título ou
        # ingredientes vindos da fonte.
        if not receita["titulo"] or not ingredientes:
            return json.dumps({
                "erro": "receita_incompleta",
                "mensagem": (
                    "A API não retornou título e ingredientes suficientes "
                    "para apresentar a receita."
                ),
            }, ensure_ascii=False)

        # Fonte de verdade para a última receita da sessão.
        sessao["ultima_receita"] = receita

        return json.dumps(receita, ensure_ascii=False)

    except requests.RequestException as erro:
        return json.dumps({
            "erro": "falha_na_consulta_fatsecret",
            "detalhes": str(erro),
        }, ensure_ascii=False)

    except (ValueError, RuntimeError) as erro:
        return json.dumps({
            "erro": "resposta_fatsecret_invalida",
            "detalhes": str(erro),
        }, ensure_ascii=False)


# ============================================================
# REGISTRO DAS TOOLS PARA O OLLAMA
# ============================================================

tools = [
    {
        "type": "function",
        "function": {
            "name": "buscar_receitas",
            "description": (
                "Pesquisa receitas reais no FatSecret. "
                "Use quando o usuário pedir uma receita ou quiser "
                "encontrar receitas por nome ou tipo."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "consulta": {
                        "type": "string",
                        "description": "Nome ou tipo de receita a pesquisar.",
                    }
                },
                "required": ["consulta"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "obter_detalhes_receita",
            "description": (
                "Obtém ingredientes, instruções e outros detalhes "
                "de uma receita encontrada na pesquisa atual. "
                "Não use IDs que não foram retornados pela pesquisa."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "recipe_id": {
                        "type": "string",
                        "description": "ID de uma receita encontrada.",
                    }
                },
                "required": ["recipe_id"],
            },
        },
    },
]

funcoes = {
    "buscar_receitas": buscar_receitas,
    "obter_detalhes_receita": obter_detalhes_receita,
}


# ============================================================
# APRESENTAÇÃO: USA OS DADOS DA API, NÃO A RESPOSTA DO MODELO
# ============================================================

def formatar_receita(receita: dict) -> str:
    linhas = [
        f"## {receita['titulo']}",
        "",
        "### Ingredientes",
    ]

    linhas.extend(
        f"- {item}" for item in receita["ingredientes"]
    )

    linhas.extend(["", "### Passo a passo"])

    if receita["passo_a_passo"]:
        linhas.extend(
            f"{i}. {passo}"
            for i, passo in enumerate(receita["passo_a_passo"], start=1)
        )
    else:
        linhas.append(
            "O FatSecret não retornou o passo a passo desta receita."
        )

    linhas.extend([
        "",
        f"Fonte: {receita['fonte']}",
        f"Link: {receita['url_fonte'] or 'Não informado pela API'}",
    ])

    if receita["aviso"]:
        linhas.extend(["", f"Aviso: {receita['aviso']}"])

    return "\n".join(linhas)


def parece_pedido_de_receita(texto: str) -> bool:
    """Verificação conservadora para impedir receitas sem consulta."""

    texto = texto.lower()

    termos = (
        "receita",
        "receitas",
        "como preparar",
        "como fazer",
        "passo a passo",
        "modo de preparo",
    )

    return any(termo in texto for termo in termos)


def pede_receita_anterior(texto: str) -> bool:
    """Detecta pedidos simples para recuperar a última receita."""

    texto = texto.lower()

    termos = (
        "última receita",
        "ultima receita",
        "receita anterior",
        "mostre novamente",
        "repita a receita",
        "ingredientes dela",
        "passo a passo dela",
        "essa receita",
    )

    return any(termo in texto for termo in termos)


# ============================================================
# CONVERSA COM O OLLAMA
# ============================================================

mensagens = [
    {
        "role": "system",
        "content": (
            "Você é o CustomChef, um assistente culinário. "
            "Responda sempre em português brasileiro. "
            "Seja direto e cordial. "
            "REGRA OBRIGATÓRIA: nunca invente, complete, adapte ou "
            "deduza receitas, ingredientes ou instruções culinárias. "
            "Receitas só podem ser apresentadas a partir dos dados "
            "retornados pelas ferramentas do FatSecret. "
            "Quando o usuário pedir uma receita, use buscar_receitas. "
            "Depois escolha um resultado e chame obter_detalhes_receita. "
            "Se não houver resultados, informe isso sem criar uma receita. "
            "Se a API não fornecer o passo a passo, diga que ele não está "
            "disponível. Nunca preencha essa lacuna com instruções próprias. "
            "Não declare que consultou a API se não chamou uma ferramenta."
        ),
    }
]

print("CustomChef iniciado. Digite 'sair' para encerrar.")

while True:
    entrada = input("\nVocê: ").strip()

    if entrada.lower() == "sair":
        break

    if not entrada:
        continue

    # Recuperação direta: não depende da memória generativa do modelo.
    if sessao["ultima_receita"] and pede_receita_anterior(entrada):
        print("\nCustomChef:")
        print(formatar_receita(sessao["ultima_receita"]))
        print("\nJSON:")
        print(json.dumps(
            sessao["ultima_receita"],
            ensure_ascii=False,
            indent=2,
        ))
        continue

    mensagens.append({"role": "user", "content": entrada})

    versao_anterior = sessao["ultima_receita"]
    receita_anterior_id = (
        versao_anterior.get("recipe_id")
        if versao_anterior
        else None
    )

    # Limita a quantidade de chamadas de ferramentas por interação.
    ferramentas_usadas = False
    receita_confirmada_nesta_interacao = False

    try:
        for _ in range(5):
            resposta = chat(
                model=MODEL,
                messages=mensagens,
                tools=tools,
                keep_alive="10m",
                options={
                    "num_ctx": 4096,
                    "num_predict": 256,
                    "temperature": 0,
                },
            )

            mensagem = resposta.message
            chamadas = mensagem.tool_calls or []

            print(f"\n[DEBUG] Chamadas solicitadas pelo Qwen: {len(chamadas)}")

            for chamada in chamadas:
                print(f"[DEBUG] Ferramenta: {chamada.function.name}")
                print(f"[DEBUG] Argumentos: {chamada.function.arguments}")

            # Guardamos a mensagem do assistente incluindo as tool calls.
            mensagens.append(
                mensagem.model_dump(exclude_none=True)
            )

            if not chamadas:
                break

            ferramentas_usadas = True

            for chamada in chamadas:
                nome = chamada.function.name
                argumentos = chamada.function.arguments

                funcao = funcoes.get(nome)

                if funcao is None:
                    resultado = json.dumps({
                        "erro": "ferramenta_desconhecida"
                    })
                else:
                    try:
                        resultado = funcao(**argumentos)
                    except Exception as erro:
                        resultado = json.dumps({
                            "erro": "falha_na_ferramenta",
                            "detalhes": str(erro),
                        }, ensure_ascii=False)

                    print(f"[DEBUG] Resultado de {nome}:")
                    print(resultado[:2000])
                if nome == "obter_detalhes_receita":
                    try:
                        dados_resultado = json.loads(resultado)
    
                        if (
                            isinstance(dados_resultado, dict)
                            and not dados_resultado.get("erro")
                            and dados_resultado.get("titulo")
                            and dados_resultado.get("ingredientes")
                        ):
                            receita_confirmada_nesta_interacao = True
    
                    except (json.JSONDecodeError, TypeError):
                        pass

                mensagens.append({
                    "role": "tool",
                    "tool_name": nome,
                    "content": resultado,
                })

        else:
            print(
                "\nCustomChef: Não consegui concluir a consulta "
                "com segurança. Tente novamente."
            )
            continue

        # Guardrail de saída: para pedidos de receita, a resposta
        # exibida vem dos dados guardados pelo Python, nunca do texto
        # livre que o modelo poderia ter inventado.
        if parece_pedido_de_receita(entrada):
            receita = sessao["ultima_receita"]

            if (
                receita_confirmada_nesta_interacao
                and receita is not None
            ):
                print("\nCustomChef:")
                print(formatar_receita(receita))

                print("\nJSON:")
                print(json.dumps(
                    receita,
                    ensure_ascii=False,
                    indent=2,
                ))
            else:
                print(
                    "\nCustomChef: Não consegui confirmar uma receita "
                    "completa no FatSecret. Não vou inventar uma."
                )
        else:
            texto = resposta.message.content or ""
            print(f"\nCustomChef: {texto}")

    except Exception as erro:
        print(
            "\nCustomChef: Ocorreu um erro durante a consulta. "
            "Confira a conexão com o Ollama e o acesso ao FatSecret."
        )
        print(f"Detalhe técnico: {erro}")
