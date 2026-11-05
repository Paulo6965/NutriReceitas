"""CustomChef - assistente culinário baseado em Ollama e FatSecret.

Execução:
    python main_refatorado.py

Variáveis necessárias no arquivo .env:
    FATSECRET_CLIENT_ID=...
    FATSECRET_CLIENT_SECRET=...
    OLLAMA_MODEL=qwen3:4b       # opcional

Dependências:
    pip install requests python-dotenv ollama
"""

from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

import requests
from dotenv import load_dotenv
from ollama import chat


LOGGER = logging.getLogger("customchef")


# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Settings:
    model: str
    fatsecret_client_id: str
    fatsecret_client_secret: str
    token_url: str = "https://oauth.fatsecret.com/connect/token"
    api_base_url: str = "https://platform.fatsecret.com/rest"
    request_timeout: tuple[int, int] = (10, 30)
    max_tool_rounds: int = 5
    max_recipe_options: int = 3

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        client_id = os.getenv("FATSECRET_CLIENT_ID", "").strip()
        client_secret = os.getenv("FATSECRET_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            raise RuntimeError(
                "Configure FATSECRET_CLIENT_ID e FATSECRET_CLIENT_SECRET no .env."
            )
        return cls(
            model=os.getenv("OLLAMA_MODEL", "qwen3:4b"),
            fatsecret_client_id=client_id,
            fatsecret_client_secret=client_secret,
        )


# ---------------------------------------------------------------------------
# Modelos de estado
# ---------------------------------------------------------------------------

@dataclass
class ConversationState:
    candidates: list[dict[str, Any]] = field(default_factory=list)
    detailed_options: list[dict[str, Any]] = field(default_factory=list)
    selected_recipe: dict[str, Any] | None = None
    last_recipe: dict[str, Any] | None = None
    fatsecret_token: str | None = None
    available_ingredients: list[str] = field(default_factory=list)
    ingredient_mode: bool = False
    messages: list[dict[str, Any]] = field(default_factory=list)

    def clear_search(self) -> None:
        self.candidates.clear()
        self.detailed_options.clear()
        self.selected_recipe = None
        self.available_ingredients.clear()
        self.ingredient_mode = False


# ---------------------------------------------------------------------------
# Utilitários
# ---------------------------------------------------------------------------

def as_list(value: Any) -> list[Any]:
    """Normaliza respostas da FatSecret que podem ser lista ou objeto único."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return [value]
    return []


def json_result(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False)


def parse_json_object(content: str) -> dict[str, Any]:
    try:
        value = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"O modelo retornou JSON inválido: {content}") from exc
    if not isinstance(value, dict):
        raise ValueError("O modelo não retornou um objeto JSON.")
    return value


# ---------------------------------------------------------------------------
# Integração com FatSecret
# ---------------------------------------------------------------------------

class FatSecretClient:
    def __init__(self, settings: Settings, state: ConversationState) -> None:
        self.settings = settings
        self.state = state
        self.http = requests.Session()

    def _token(self) -> str:
        if self.state.fatsecret_token:
            return self.state.fatsecret_token

        response = self.http.post(
            self.settings.token_url,
            auth=(
                self.settings.fatsecret_client_id,
                self.settings.fatsecret_client_secret,
            ),
            data={"grant_type": "client_credentials", "scope": "basic"},
            timeout=self.settings.request_timeout,
        )
        response.raise_for_status()
        data = response.json()
        token = data.get("access_token")
        if not token:
            raise RuntimeError("A FatSecret não retornou um token de acesso.")
        self.state.fatsecret_token = token
        return token

    def request(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        def do_request(token: str) -> requests.Response:
            return self.http.get(
                f"{self.settings.api_base_url}/{endpoint}",
                headers={"Authorization": f"Bearer {token}"},
                params={**params, "format": "json"},
                timeout=self.settings.request_timeout,
            )

        response = do_request(self._token())
        if response.status_code == 401:
            self.state.fatsecret_token = None
            response = do_request(self._token())
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("A FatSecret retornou um formato inesperado.")
        return data

    def search(self, query: str) -> str:
        query = query.strip()
        if not query:
            return json_result({"erro": "Informe ingredientes ou uma receita para pesquisar."})

        try:
            data = self.request(
                "recipes/search/v3",
                {"search_expression": query, "max_results": 5, "page_number": 0},
            )
            raw = data.get("recipes", {})
            recipes = as_list(raw.get("recipe") if isinstance(raw, dict) else None)
            candidates = [
                {
                    "recipe_id": str(item["recipe_id"]),
                    "titulo": item["recipe_name"],
                    "descricao": item.get("recipe_description"),
                    "url": item.get("recipe_url"),
                }
                for item in recipes
                if isinstance(item, dict) and item.get("recipe_id") and item.get("recipe_name")
            ]
            self.state.candidates = candidates
            self.state.detailed_options = []
            self.state.selected_recipe = None
            if not candidates:
                return json_result({
                    "resultado": "nenhuma_receita_encontrada",
                    "mensagem": "Não encontrei receitas para essa busca.",
                })
            return json_result({"resultado": "receitas_encontradas", "receitas": candidates})
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            LOGGER.exception("Falha na busca FatSecret")
            return json_result({"erro": "falha_na_consulta_fatsecret", "detalhes": str(exc)})

    def search_for_ingredients(self, primary: str, ingredients: list[str]) -> str:
        """Busca por várias alternativas e combina candidatas sem duplicação.

        A API pode não retornar resultados para uma combinação ou para o
        ingrediente principal escolhido pelo modelo. Nesse caso, cada
        ingrediente disponível é usado como consulta de recuperação.
        """
        expansions = {
            "bread": ["bread", "loaf", "toast"],
            "cheese": ["cheese", "cheddar", "mozzarella"],
            "pasta": ["pasta", "macaroni", "spaghetti"],
            "bean": ["bean", "beans"],
            "rice": ["rice"],
            "sweet potato": ["sweet potato", "yam"],
        }
        base_terms = list(dict.fromkeys([
            normalize_ingredient(primary),
            *(normalize_ingredient(item) for item in ingredients),
        ]))
        queries = list(dict.fromkeys(
            query
            for term in base_terms
            for query in expansions.get(term, [term])
            if query
        ))
        LOGGER.info("Consultas de ingredientes: %s", queries)
        merged: dict[str, dict[str, Any]] = {}
        errors: list[str] = []

        for query in queries:
            result = parse_json_object(self.search(query))
            if result.get("resultado") == "receitas_encontradas":
                for candidate in result.get("receitas", []):
                    if isinstance(candidate, dict) and candidate.get("recipe_id"):
                        merged[str(candidate["recipe_id"])] = candidate
            elif result.get("erro"):
                errors.append(str(result["erro"]))
            # Não interromper aqui: expansões do primeiro ingrediente, como
            # bread/loaf/toast, não podem impedir a consulta dos ingredientes
            # seguintes. O limite é aplicado somente após todas as consultas.

        self.state.candidates = list(merged.values())[:30]
        LOGGER.info("Candidatas únicas encontradas: %d", len(self.state.candidates))
        self.state.detailed_options = []
        self.state.selected_recipe = None
        if not self.state.candidates:
            return json_result({
                "resultado": "nenhuma_receita_encontrada",
                "mensagem": "Não encontrei receitas para os ingredientes informados.",
                "consultas_realizadas": queries,
                "erros": errors,
            })
        return json_result({
            "resultado": "receitas_encontradas",
            "receitas": self.state.candidates,
            "consultas_realizadas": queries,
        })

    def details(self, recipe_id: str, *, store_last: bool = True) -> str:
        recipe_id = str(recipe_id)
        allowed_ids = {item["recipe_id"] for item in self.state.candidates}
        if recipe_id not in allowed_ids:
            return json_result({
                "erro": "recipe_id_nao_autorizado",
                "mensagem": "O identificador não pertence à pesquisa atual.",
            })

        try:
            data = self.request("recipe/v2", {"recipe_id": recipe_id})
            raw = data.get("recipe")
            if not isinstance(raw, dict):
                return json_result({"erro": "detalhes_nao_encontrados"})

            ingredients_raw = raw.get("ingredients", {})
            directions_raw = raw.get("directions", {})
            ingredients = [
                item.get("ingredient_description") or item.get("food_name")
                for item in as_list(
                    ingredients_raw.get("ingredient") if isinstance(ingredients_raw, dict) else None
                )
                if isinstance(item, dict)
                and (item.get("ingredient_description") or item.get("food_name"))
            ]
            directions = as_list(
                directions_raw.get("direction") if isinstance(directions_raw, dict) else None
            )
            directions.sort(key=lambda item: int(item.get("direction_number", 0)) if isinstance(item, dict) else 0)
            steps = [
                item["direction_description"]
                for item in directions
                if isinstance(item, dict) and item.get("direction_description")
            ]

            serving_sizes = raw.get("serving_sizes", {})
            serving = serving_sizes.get("serving") if isinstance(serving_sizes, dict) else None
            serving = serving[0] if isinstance(serving, list) and serving else serving
            nutrition = {
                key: serving[key]
                for key in ("serving_size", "calories", "protein", "carbohydrate", "fat", "fiber", "sodium")
                if isinstance(serving, dict) and key in serving
            }
            recipe = {
                "recipe_id": str(raw.get("recipe_id", recipe_id)),
                "titulo": raw.get("recipe_name"),
                "ingredientes": ingredients,
                "passo_a_passo": steps,
                "fonte": "FatSecret",
                "url_fonte": raw.get("recipe_url"),
                "tempo_preparo_minutos": raw.get("preparation_time_min"),
                "tempo_cozimento_minutos": raw.get("cooking_time_min"),
                "porcoes": raw.get("number_of_servings"),
                "nutricao": nutrition,
                "aviso": None if steps else "A API não retornou instruções; elas não foram inventadas.",
            }
            if not recipe["titulo"] or not ingredients:
                return json_result({"erro": "receita_incompleta"})
            if store_last:
                self.state.last_recipe = recipe
            return json_result(recipe)
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            LOGGER.exception("Falha ao obter detalhes FatSecret")
            return json_result({"erro": "falha_na_consulta_fatsecret", "detalhes": str(exc)})

    def first_complete_options(self, limit: int) -> str:
        options: list[dict[str, Any]] = []
        for candidate in self.state.candidates:
            if len(options) >= limit:
                break
            result = parse_json_object(self.details(candidate["recipe_id"], store_last=False))
            if result.get("titulo") and result.get("ingredientes") and not result.get("erro"):
                options.append(result)
        self.state.detailed_options = options
        if not options:
            return json_result({"erro": "detalhes_nao_encontrados"})
        return json_result({"resultado": "opcoes_recuperadas", "receitas": options})


# ---------------------------------------------------------------------------
# Integração com Ollama
# ---------------------------------------------------------------------------

class LLMService:
    TRANSLATION_MODEL = "qwen3:4b"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _chat(self, messages: list[dict[str, Any]], **kwargs: Any) -> Any:
        model_name = kwargs.pop("model_name", self.settings.model)
        return chat(
            model=model_name,
            messages=messages,
            think=False,
            options={"temperature": 0, **kwargs.pop("options", {})},
            **kwargs,
        )

    def extract_ingredients(self, text: str) -> dict[str, Any]:
        response = self._chat([
            {"role": "system", "content": (
                "Extraia ingredientes da mensagem. Retorne somente JSON válido no formato "
                '{"ingrediente_principal":"chicken","ingredientes_disponiveis":["chicken","potato","carrot"]}. '
                "Traduza para inglês, preserve todos os ingredientes e não invente nenhum. "
                "Escolha como ingrediente_principal o ingrediente mais adequado para buscar receitas. "
                "O ingrediente_principal deve aparecer na lista."
            )},
            {"role": "user", "content": text},
        ], format="json", options={"num_predict": 256})
        data = parse_json_object(response.message.content or "")
        principal = data.get("ingrediente_principal")
        ingredients = data.get("ingredientes_disponiveis")
        if not isinstance(principal, str) or not principal.strip() or not isinstance(ingredients, list):
            raise ValueError("O modelo não retornou ingredientes válidos.")
        ingredients = [item.strip().lower() for item in ingredients if isinstance(item, str) and item.strip()]
        if not ingredients:
            raise ValueError("Nenhum ingrediente foi identificado.")
        ingredients = list(dict.fromkeys(ingredients))
        principal = principal.strip().lower()
        if principal not in ingredients:
            ingredients.insert(0, principal)
        return {
            "ingrediente_principal": principal,
            "ingredientes_disponiveis": ingredients,
        }

    def translate_options(self, options: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result = []
        for original in options:
            copy = dict(original)
            copy["titulo_pt"] = original["titulo"]
            copy["ingredientes_pt"] = original["ingredientes"][:4]
            payload = {
                "titulo": original["titulo"],
                "ingredientes": original["ingredientes"][:4],
            }
            try:
                response = self._chat([
                    {"role": "system", "content": (
                        "Traduza o título e os ingredientes desta receita do inglês para português brasileiro. "
                        "Não explique, não raciocine em texto, não inclua markdown e não copie o texto original. "
                        "Preserve quantidades, unidades e ordem. Retorne somente JSON válido no formato "
                        '{"titulo":"...","ingredientes":["..."]}'
                    )},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
                ], model_name=self.TRANSLATION_MODEL, format="json", options={
                    "num_predict": 384,
                    "repeat_penalty": 1.25,
                })
                data = parse_json_object(response.message.content or "")
                title = data.get("titulo")
                ingredients = data.get("ingredientes")
                expected_count = len(payload["ingredientes"])
                if (
                    isinstance(title, str) and title.strip()
                    and isinstance(ingredients, list)
                    and len(ingredients) == expected_count
                    and all(isinstance(value, str) and value.strip() for value in ingredients)
                ):
                    copy["titulo_pt"] = title.strip()
                    copy["ingredientes_pt"] = [
                        normalize_ingredient_quantity(original_value, translated_value)
                        for original_value, translated_value in zip(payload["ingredientes"], ingredients)
                    ]
                else:
                    LOGGER.warning("Tradução incompleta da opção; exibindo dados originais.")
            except Exception as exc:
                LOGGER.warning("Falha ao traduzir uma opção; exibindo dados originais: %s", exc)
            result.append(copy)
        return result

    def translate_full_recipe(self, recipe: dict[str, Any]) -> dict[str, Any]:
        """Traduz a receita em blocos curtos para evitar repetição do Ollama."""
        common_system = (
            "Traduza do inglês para português brasileiro. Não explique, não raciocine em texto, "
            "não inclua markdown e retorne somente JSON válido. Preserve quantidades e informações. "
            "Não copie o texto original."
        )

        original_ingredients = recipe.get("ingredientes", [])
        try:
            base_response = self._chat([
                {"role": "system", "content": common_system +
                    ' Retorne exatamente {"titulo":"...","ingredientes":["..."]}.'},
                {"role": "user", "content": json.dumps({
                    "titulo": recipe.get("titulo", ""),
                    "ingredientes": original_ingredients,
                }, ensure_ascii=False)},
            ], model_name=self.TRANSLATION_MODEL, format="json", options={
                "num_predict": 768,
                "repeat_penalty": 1.25,
            })
            base = parse_json_object(base_response.message.content or "")
            title = base.get("titulo")
            ingredients = base.get("ingredientes")
            valid_base = (
                isinstance(title, str) and title.strip()
                and isinstance(ingredients, list)
                and len(ingredients) == len(original_ingredients)
                and all(isinstance(value, str) and value.strip() for value in ingredients)
            )
        except Exception as exc:
            LOGGER.warning("Falha ao traduzir título e ingredientes; usando dados originais: %s", exc)
            valid_base = False

        if not valid_base:
            title = recipe.get("titulo", "")
            ingredients = original_ingredients

        steps = []
        for original_step in recipe.get("passo_a_passo", []):
            try:
                step_response = self._chat([
                    {"role": "system", "content": common_system +
                        ' Traduza o passo inteiro e retorne exatamente {"passo":"..."}.'},
                    {"role": "user", "content": json.dumps({"passo": original_step}, ensure_ascii=False)},
                ], model_name=self.TRANSLATION_MODEL, format="json", options={
                    "num_predict": 384,
                    "repeat_penalty": 1.25,
                })
                step_data = parse_json_object(step_response.message.content or "")
                translated_step = step_data.get("passo")
            except Exception as exc:
                LOGGER.warning("Falha ao traduzir um passo; usando o texto original: %s", exc)
                translated_step = None
            if not isinstance(translated_step, str) or not translated_step.strip():
                steps.append(original_step)
            else:
                steps.append(translated_step.strip())

        localized = dict(recipe)
        localized["titulo"] = title.strip()
        localized["ingredientes"] = [
            normalize_ingredient_quantity(original_value, translated_value)
            for original_value, translated_value in zip(original_ingredients, ingredients)
        ]
        localized["passo_a_passo"] = steps
        return localized


# ---------------------------------------------------------------------------
# Regras de aplicação e apresentação
# ---------------------------------------------------------------------------

COMMON_TRANSLATIONS = {
    "batata-doce": "sweet potato", "batata doce": "sweet potato",
    "arroz": "rice", "feijão": "beans", "ovo": "egg", "ovos": "eggs",
    "frango": "chicken", "carne": "beef", "batata": "potato", "macarrão": "pasta",
    "tomate": "tomato", "cebola": "onion", "queijo": "cheese", "leite": "milk",
    "pão": "bread", "peixe": "fish", "atum": "tuna", "camarão": "shrimp",
}


PT_BR_INGREDIENTS = {
    "cooked, chopped chicken meat": "frango cozido e picado",
    "cooked white rice": "arroz branco cozido",
    "ground black pepper": "pimenta-do-reino moída",
    "black pepper": "pimenta-do-reino",
    "shredded egg": "ovo em tiras",
    "large egg": "ovo grande",
    "medium onion": "cebola média",
    "soy sauce": "molho de soja",
    "oil": "óleo",
    "butter": "manteiga",
    "pork chops, boneless": "costeletas de porco sem osso",
    "pork chops": "costeletas de porco",
    "lemon yields": "suco de limão",
    "lemon": "limão",
    "garlic cloves": "dentes de alho",
    "cloves": "dentes de",
    "large onion": "cebola grande",
    "avocado": "abacate",
    "cubed avocado": "abacate em cubos",
    "vinegar": "vinagre",
    "canola oil": "óleo de canola",
    "to taste": "a gosto",
    "chopped": "picado",
    "cubed": "em cubos",
    "corn kernels": "grãos de milho",
    "corn": "milho",
    "black beans": "feijão-preto",
    "kidney beans": "feijão-vermelho",
    "honey": "mel",
    "cooked pearl barley": "cevada pérola cozida",
    "cooked brown rice": "arroz integral cozido",
    "pearl barley": "cevada pérola",
    "sunflower seeds": "sementes de girassol",
    "red bell pepper": "pimentão vermelho",
    "bell pepper": "pimentão",
    "green onions": "cebolinha",
    "spring onion": "cebolinha",
    "drained": "escorrido",
    "crushed": "amassado",
    "canned": "enlatado",
    "cold": "frio",
    "or to taste": "ou a gosto",
    "or": "ou",
    "sweetened condensed milk": "leite condensado",
    "brown basmati rice": "arroz basmati integral",
    "white rice": "arroz branco",
    "pigeon peas": "ervilhas-gandules",
    "sprigs": "ramos de",
    "dash": "pitada de",
    "skim milk": "leite desnatado",
    "whole milk": "leite integral",
    "milk": "leite",
    "peanut oil": "óleo de amendoim",
    "olive oil": "azeite de oliva",
    "vegetable oil": "óleo vegetal",
    "wheat flour": "farinha de trigo",
    "all purpose flour": "farinha de trigo",
    "chicken": "frango",
    "beef": "carne bovina",
    "eggs": "ovos",
    "egg": "ovo",
    "rice": "arroz",
    "beans": "feijão",
    "bean": "feijão",
    "potatoes": "batatas",
    "batatas": "batatas",
    "potato": "batata",
    "sweet potato": "batata-doce",
    "carrots": "cenouras",
    "carrot": "cenoura",
    "onion": "cebola",
    "tomato": "tomate",
    "garlic, dried": "alho seco",
    "garlic": "alho",
    "kosher salt": "sal kosher",
    "salt": "sal",
    "cumin": "cominho",
    "paprika": "páprica",
    "pepper": "pimenta",
    "lemon juice": "suco de limão",
    "cilantro": "coentro",
    "water": "água",
    "cinnamon": "canela",
}

PT_BR_STEP_PHRASES = {
    "gather all ingredients": "separe todos os ingredientes",
    "beat egg and water together in small bowl": "bata o ovo e a água em uma tigela pequena",
    "melt butter in a large skillet or wok over medium-low heat": "derreta a manteiga em uma frigideira grande ou wok em fogo médio-baixo",
    "add egg and cook without stirring": "adicione o ovo e cozinhe sem mexer",
    "remove egg from skillet and cut into shreds; set aside": "retire o ovo da frigideira, corte em tiras e reserve",
    "heat oil in the same skillet": "aqueça o óleo na mesma frigideira",
    "stir in rice, chicken, soy sauce, and pepper": "misture o arroz, o frango, o molho de soja e a pimenta",
    "cook and stir for about 5 minutes": "cozinhe e mexa por cerca de 5 minutos",
    "serve hot": "sirva quente",
    "in a large bowl, combine": "em uma tigela grande, misture",
    "to make dressing in a small bowl, whisk together": "para fazer o molho, em uma tigela pequena, misture bem",
    "pour over salad and toss well": "despeje sobre a salada e misture bem",
    "drizzle dressing over the salad": "regue a salada com o molho",
    "heat oil": "aqueça o óleo",
    "in the same skillet": "na mesma frigideira",
    "in small bowl": "em uma tigela pequena",
    "large skillet or wok": "frigideira grande ou wok",
    "add onion": "adicione a cebola",
    "cook and stir": "cozinhe e mexa",
    "stir in shredded egg": "misture o ovo em tiras",
    "stir in": "misture",
    "about 3 minutes": "por cerca de 3 minutos",
    "about 5 minutes": "por cerca de 5 minutos",
    "minutes": "minutos",
    "mix well": "misture bem",
    "simply mix together": "basta misturar",
    "cook rice in water and cinnamon": "cozinhe o arroz em água e canela",
    "when soft add sweetened condensed milk": "quando estiver macio, adicione o leite condensado",
    "when soft add sweetened condensed: milk": "quando estiver macio, adicione o leite condensado",
    "cook the rice": "cozinhe o arroz",
    "add the": "adicione o",
    "add some": "adicione um pouco de",
    "heat the oil": "aqueça o óleo",
    "in a sauté pan": "em uma frigideira",
    "on medium heat": "em fogo médio",
    "on medium to high heat": "em fogo médio-alto",
    "until soft": "até ficar macio",
    "until tender": "até ficar macio",
}

PT_PT_TO_BR = {
    "pequeno-almoço": "café da manhã",
    "pequeno almoço": "café da manhã",
    "sumo": "suco",
    "sumos": "sucos",
    "pimento": "pimentão",
    "pimentos": "pimentões",
    "beringela": "berinjela",
    "courgette": "abobrinha",
    "coentros": "coentro",
    "fiambre": "presunto",
    "natas": "creme de leite",
    "nata": "creme de leite",
    "frigorífico": "geladeira",
    "frigorifico": "geladeira",
    "tacho": "panela",
    "açúcar em pó": "açúcar de confeiteiro",
}

CULINARY_BAD_TRANSLATIONS = {
    "misture-se": "misture",
    "sirva-se": "sirva",
    "afaste-se": "reserve",
    "deixe-se": "deixe",
    "batata de cubo": "corte a batata em cubos",
    "deixa a pele": "deixe a casca",
    "reduza para ferver": "reduza o fogo",
    "milho ser cozido": "milho cozinhar",
    "cortar milho da espiga": "corte o milho da espiga",
    "cortar espiga": "corte a espiga",
    "whisk juntos": "misture bem",
    "asse descoberto": "asse sem cobrir",
    "crosta superior é dourada": "a cobertura ficar dourada",
    "creme de leite azeda": "creme de leite azedo",
}

PT_BR_RECIPE_TITLES = {
    "bean salad": "salada de feijão",
    "green italian rice salad": "salada italiana verde de arroz",
    "oriental pork with rice": "porco oriental com arroz",
    "chicken soup": "sopa de frango",
    "chicken and rice": "frango com arroz",
    "rice and beans": "arroz com feijão",
    "potato soup": "sopa de batata",
    "tortilla de papas": "tortilha de batatas",
    "brochettes de poisson": "espetinhos de peixe",
    "pico de gallo": "pico de gallo",
}


def _quantity_value(value: str) -> float | None:
    """Converte números inteiros, decimais e frações simples."""
    value = value.strip().replace(",", ".")
    try:
        if " " in value:
            whole, fraction = value.split(" ", 1)
            numerator, denominator = fraction.split("/", 1)
            return float(whole) + float(numerator) / float(denominator)
        if "/" in value:
            numerator, denominator = value.split("/", 1)
            return float(numerator) / float(denominator)
        return float(value)
    except (ValueError, ZeroDivisionError):
        return None


def _localized_unit(quantity: str, singular: str, plural: str) -> str:
    number = _quantity_value(quantity)
    # Em receitas, 1/2 colher e 1/4 xícara continuam no singular.
    return singular if number is not None and 0 < number <= 1 else plural


def translate_measurements_to_pt_br(text: str) -> str:
    """Converte unidades culinárias americanas para equivalentes brasileiros.

    As equivalências volumétricas usadas são: 1 tbsp ≈ 15 ml, 1 tsp ≈ 5 ml
    e 1 cup ≈ 240 ml. A saída prioriza a unidade culinária brasileira, sem
    alterar a quantidade informada.
    """
    quantity = r"(\d+(?:[.,]\d+)?(?:\s+\d+\/\d+|\/\d+)?)"
    patterns = (
        (rf"{quantity}\s*(?:tbsps?|tbsp|tablespoons?)\b", "colher (de sopa)", "colheres (de sopa)"),
        (rf"{quantity}\s*(?:tsps?|tsp|teaspoons?)\b", "colher (de chá)", "colheres (de chá)"),
        (rf"{quantity}\s*(?:cups?|xícaras?)\b", "xícara", "xícaras"),
    )
    result = text
    for pattern, singular, plural in patterns:
        def replace(match: re.Match[str]) -> str:
            amount = match.group(1)
            return f"{amount} {_localized_unit(amount, singular, plural)}"

        result = re.sub(pattern, replace, result, flags=re.IGNORECASE)

    # Conversões de massa, que são independentes do ingrediente para fins de
    # apresentação culinária aproximada.
    result = re.sub(
        rf"{quantity}\s*(?:lbs?|pounds?)\b",
        lambda match: f"{_format_converted_quantity(match.group(1), 453.592)} g",
        result,
        flags=re.IGNORECASE,
    )
    result = re.sub(
        rf"{quantity}\s*(?:oz|ounces?)\b",
        lambda match: f"{_format_converted_quantity(match.group(1), 28.35)} g",
        result,
        flags=re.IGNORECASE,
    )
    # O Argos pode traduzir a unidade antes desta etapa. Canonicalizamos
    # novamente para o padrão da aplicação e corrigimos traduções literais
    # inadequadas para receitas, como "dash" -> "traço".
    result = re.sub(r"\bcolheres?\s+de\s+sopa\b", lambda match: (
        "colher (de sopa)" if match.group(0).casefold().startswith("colher ") else "colheres (de sopa)"
    ), result, flags=re.IGNORECASE)
    result = re.sub(r"\bcolheres?\s+de\s+chá\b", lambda match: (
        "colher (de chá)" if match.group(0).casefold().startswith("colher ") else "colheres (de chá)"
    ), result, flags=re.IGNORECASE)
    result = re.sub(r"\btraços?\b", lambda match: (
        "pitada" if match.group(0).casefold() == "traço" else "pitadas"
    ), result, flags=re.IGNORECASE)
    return result


def normalize_ingredient_quantity(original: str, translated: str) -> str:
    """Fixa a unidade com base no texto original, sem depender do modelo.

    ``tbsp``/``tbsps`` significa tablespoon: colher(es) de sopa.
    ``tsp``/``tsps`` significa teaspoon: colher(es) de chá.
    """
    result = translate_measurements_to_pt_br(translated)
    source = original.casefold()
    source_unit = None
    if re.search(r"\b(?:tbsp|tbsps|tablespoon|tablespoons)\b", source):
        source_unit = ("colher (de sopa)", "colheres (de sopa)")
    elif re.search(r"\b(?:tsp|tsps|teaspoon|teaspoons)\b", source):
        source_unit = ("colher (de chá)", "colheres (de chá)")
    elif re.search(r"\b(?:cup|cups)\b", source):
        source_unit = ("xícara", "xícaras")

    if source_unit:
        singular, plural = source_unit
        result = re.sub(
            r"\bcolher(?:es)?\s*(?:\(\s*de\s+(?:sopa|chá)\s*\)|de\s+(?:sopa|chá))",
            lambda match: singular if _localized_unit_from_text(result) else plural,
            result,
            flags=re.IGNORECASE,
        )
    return result


def _localized_unit_from_text(text: str) -> bool:
    """Retorna se a primeira quantidade encontrada é singular."""
    match = re.search(r"\b(\d+(?:[.,]\d+)?(?:\s+\d+/\d+|/\d+)?)\b", text)
    return bool(match and _localized_unit(match.group(1), "singular", "plural") == "singular")


def _format_converted_quantity(value: str, multiplier: float) -> str:
    number = _quantity_value(value)
    if number is None:
        return value
    converted = number * multiplier
    if converted.is_integer():
        return str(int(converted))
    return f"{converted:.1f}".replace(".", ",")


def translate_ingredient_to_pt_br(text: str) -> str:
    """Traduz medidas e um vocabulário local de ingredientes comuns."""
    result = translate_measurements_to_pt_br(text)
    for english, portuguese in sorted(PT_BR_INGREDIENTS.items(), key=lambda pair: len(pair[0]), reverse=True):
        result = re.sub(rf"(?<!\w){re.escape(english)}(?!\w)", portuguese, result, flags=re.IGNORECASE)
    return normalize_culinary_phrasing(to_brazilian_portuguese(result))


def translate_step_to_pt_br(text: str) -> str:
    """Traduz frases culinárias frequentes no fallback local."""
    result = translate_measurements_to_pt_br(text)
    for english, portuguese in sorted(PT_BR_STEP_PHRASES.items(), key=lambda pair: len(pair[0]), reverse=True):
        result = re.sub(re.escape(english), portuguese, result, flags=re.IGNORECASE)
    result = translate_ingredient_to_pt_br(result).strip()
    return result[:1].upper() + result[1:] if result else result


def to_brazilian_portuguese(text: str) -> str:
    """Normaliza vocabulário regional após qualquer mecanismo de tradução."""
    result = text
    for european, brazilian in sorted(PT_PT_TO_BR.items(), key=lambda pair: len(pair[0]), reverse=True):
        result = re.sub(
            rf"(?<!\w){re.escape(european)}(?!\w)",
            brazilian,
            result,
            flags=re.IGNORECASE,
        )
    return result


def normalize_culinary_phrasing(text: str) -> str:
    """Corrige calques literais recorrentes sem alterar quantidades."""
    result = text
    for source, target in sorted(CULINARY_BAD_TRANSLATIONS.items(), key=lambda pair: len(pair[0]), reverse=True):
        def replace(match: re.Match[str], replacement: str = target) -> str:
            if match.group(0)[:1].isupper():
                return replacement[:1].upper() + replacement[1:]
            return replacement

        result = re.sub(
            rf"(?<!\w){re.escape(source)}(?!\w)",
            replace,
            result,
            flags=re.IGNORECASE,
        )
    return result


def translate_title_to_pt_br(text: str) -> str:
    """Traduz títulos conhecidos quando o modelo não puder fazê-lo."""
    normalized = text.strip().casefold()
    if normalized in PT_BR_RECIPE_TITLES:
        return PT_BR_RECIPE_TITLES[normalized]
    result = text
    for english, portuguese in sorted(PT_BR_INGREDIENTS.items(), key=lambda pair: len(pair[0]), reverse=True):
        result = re.sub(rf"(?<!\w){re.escape(english)}(?!\w)", portuguese, result, flags=re.IGNORECASE)
    return normalize_culinary_phrasing(to_brazilian_portuguese(result))


def localize_recipe_fallback(recipe: dict[str, Any]) -> dict[str, Any]:
    """Localiza o que for possível sem inventar dados se o Ollama falhar."""
    localized = dict(recipe)
    localized["titulo"] = translate_title_to_pt_br(recipe.get("titulo", ""))
    localized["ingredientes"] = [
        translate_ingredient_to_pt_br(value)
        for value in recipe.get("ingredientes", [])
    ]
    localized["passo_a_passo"] = [
        translate_step_to_pt_br(value)
        for value in recipe.get("passo_a_passo", [])
    ]
    localized["aviso"] = (
        (recipe.get("aviso") + " " if recipe.get("aviso") else "")
        + "A tradução completa dos passos não ficou disponível; alguns trechos podem permanecer no idioma original."
    )
    return localized


def translate_query(query: str) -> str:
    """Traduz todos os ingredientes conhecidos sem descartar os demais termos.

    As expressões maiores são substituídas primeiro. Assim, ``batata doce``
    vira ``sweet potato`` antes que a regra de ``batata`` seja aplicada.
    """
    translated = query.strip().lower()
    if not translated:
        return translated

    for portuguese, english in sorted(
        COMMON_TRANSLATIONS.items(), key=lambda pair: len(pair[0]), reverse=True
    ):
        pattern = rf"(?<!\w){re.escape(portuguese)}(?!\w)"
        translated = re.sub(pattern, english, translated)

    # Conectivos não acrescentam informação à pesquisa da FatSecret.
    translated = re.sub(r"\b(?:com|e|de|da|do|das|dos)\b", " ", translated)
    return re.sub(r"\s+", " ", translated).strip()


def normalize_choice(value: str) -> str:
    """Normaliza acentos, caixa e pontuação para comparação de títulos."""
    without_accents = "".join(
        char
        for char in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(char)
    )
    return re.sub(r"[^\w\s]", " ", without_accents.casefold())


def normalize_ingredient(value: str) -> str:
    """Normaliza um ingrediente para comparação aproximada e determinística."""
    value = normalize_choice(value)
    # Quantidades e unidades não ajudam a identificar o ingrediente.
    value = re.sub(
        r"\b\d+(?:[.,/]\d+)?\s*(?:g|kg|ml|l|oz|lb|xícara|cup|cups| colher(?:es)?|tbsp|tsp)\b",
        " ",
        value,
    )
    value = re.sub(r"\s+", " ", value).strip()
    aliases = {
        "arroz": "rice",
        "feijao": "bean",
        "feijoes": "bean",
        "ovo": "egg",
        "ovos": "egg",
        "frango": "chicken",
        "leite": "milk",
        "farinha de trigo": "wheat flour",
        "batata": "potato",
        "batatas": "potato",
        "batata doce": "sweet potato",
        "cenoura": "carrot",
        "cenouras": "carrot",
        "cebola": "onion",
        "cebolas": "onion",
        "tomate": "tomato",
        "tomates": "tomato",
        "queijo": "cheese",
        "pao": "bread",
        "pães": "bread",
        "paes": "bread",
        "bread": "bread",
        "queijos": "cheese",
        "cheese": "cheese",
        "macarrao": "pasta",
        "pasta": "pasta",
        "poultry": "chicken",
        "chickens": "chicken",
        "potatoes": "potato",
        "carrots": "carrot",
        "tomatoes": "tomato",
        "onions": "onion",
        "eggs": "egg",
        "beans": "bean",
    }
    return aliases.get(value, value[:-1] if value.endswith("s") and len(value) > 3 else value)


def recipe_uses_available(recipe_ingredient: str, available: str) -> bool:
    recipe_value = normalize_ingredient(recipe_ingredient)
    available_value = normalize_ingredient(available)
    if not recipe_value or not available_value:
        return False
    if recipe_value == available_value:
        return True
    recipe_words = set(recipe_value.split())
    available_words = set(available_value.split())
    return available_value in recipe_words or available_words.issubset(recipe_words)


def calculate_compatibility(recipe: dict[str, Any], available: list[str]) -> dict[str, Any]:
    """Calcula aproveitamento sem afirmar que ingredientes ausentes são opcionais."""
    used = [
        ingredient
        for ingredient in available
        if any(recipe_uses_available(item, ingredient) for item in recipe.get("ingredientes", []))
    ]
    missing = [ingredient for ingredient in available if ingredient not in used]
    percentage = round((len(used) / len(available)) * 100, 1) if available else 0.0
    result = dict(recipe)
    result["compatibilidade"] = {
        "percentual_aproveitamento": percentage,
        "ingredientes_disponiveis": list(available),
        "ingredientes_aproveitados": used,
        "ingredientes_nao_encontrados": missing,
    }
    return result


def is_ingredient_request(text: str) -> bool:
    patterns = (
        r"\btenho\b",
        r"\bdisponho de\b",
        r"na geladeira",
        r"na despensa",
        r"o que dá para",
        r"o que posso",
        r"\bi have\b",
        r"\bi've got\b",
        r"\bwhat can i make\b",
        r"\bwhat can i cook\b",
    )
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def extract_recipe_query(text: str) -> str | None:
    patterns = (
        r"^(?:quero|gostaria de|me dê|me de|procuro|busco)\s+(?:uma\s+)?receita\s+(?:de\s+)?(.+)$",
        r"^receita\s+(?:de\s+)?(.+)$",
        r"^(?:como fazer|como preparar)\s+(.+)$",
    )
    for pattern in patterns:
        match = re.search(pattern, text.strip(), re.IGNORECASE)
        if match and match.group(1).strip():
            return match.group(1).strip()
    return None


DIRECT_FOOD_QUERIES = {
    "pudim", "coxinha", "lasanha", "pizza", "sopa", "salada", "bolo",
    "brigadeiro", "panqueca", "omelete", "hamburguer", "hamburger",
    "potato", "potatoes", "chicken", "rice", "beans", "bread", "pasta",
}


def is_direct_food_query(text: str) -> bool:
    normalized = normalize_choice(text).strip()
    return normalized in DIRECT_FOOD_QUERIES


def is_previous_recipe_request(text: str) -> bool:
    normalized = text.casefold()
    return any(term in normalized for term in ("última receita", "ultima receita", "receita anterior", "mostre novamente", "repita a receita"))


def format_recipe(recipe: dict[str, Any]) -> str:
    lines = [f"## {recipe['titulo']}", "", "### Ingredientes"]
    lines.extend(f"- {item}" for item in recipe["ingredientes"])
    lines.extend(["", "### Passo a passo"])
    lines.extend(f"{index}. {step}" for index, step in enumerate(recipe["passo_a_passo"], 1))
    if not recipe["passo_a_passo"]:
        lines.append("O FatSecret não retornou o passo a passo desta receita.")
    lines.extend(["", f"Fonte: {recipe['fonte']}", f"Link: {recipe.get('url_fonte') or 'Não informado'}"])
    if recipe.get("aviso"):
        lines.extend(["", f"Aviso: {recipe['aviso']}"])
    return "\n".join(lines)


class ChefApp:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.state = ConversationState(messages=[
            {"role": "system", "content": (
                "Você é o CustomChef. Responda em português brasileiro. "
                "Não invente receitas, ingredientes ou instruções. "
                "As receitas devem vir da FatSecret."
            )}
        ])
        self.llm = LLMService(settings)
        self.fatsecret = FatSecretClient(settings, self.state)

    def search_and_prepare(
        self,
        query: str,
        *,
        available_ingredients: list[str] | None = None,
    ) -> str:
        if available_ingredients:
            search_result = parse_json_object(
                self.fatsecret.search_for_ingredients(query, available_ingredients)
            )
        else:
            search_result = parse_json_object(self.fatsecret.search(query))
        if search_result.get("resultado") != "receitas_encontradas":
            return search_result.get("mensagem", "Nenhuma receita encontrada.")
        # No modo de aproveitamento, detalhamos todas as candidatas antes de
        # escolher as três melhores. Pesquisar os três termos juntos não
        # garante que as receitas contenham esses ingredientes.
        limit = len(self.state.candidates) if available_ingredients else self.settings.max_recipe_options
        details = parse_json_object(self.fatsecret.first_complete_options(limit))
        if details.get("resultado") != "opcoes_recuperadas":
            return "Não consegui recuperar receitas completas."

        if available_ingredients:
            scored = [
                calculate_compatibility(recipe, available_ingredients)
                for recipe in self.state.detailed_options
            ]
            # Uma receita que não usa nenhum ingrediente informado é ruído,
            # não uma opção válida de aproveitamento.
            scored = [
                recipe
                for recipe in scored
                if recipe["compatibilidade"]["ingredientes_aproveitados"]
            ]
            if not scored:
                return "Não encontrei receitas que usem nenhum dos ingredientes informados."
            scored.sort(
                key=lambda recipe: recipe["compatibilidade"]["percentual_aproveitamento"],
                reverse=True,
            )
            self.state.detailed_options = scored[: self.settings.max_recipe_options]
        translated = self.llm.translate_options(self.state.detailed_options)
        # As opções exibidas e as opções usadas na seleção precisam ser a
        # mesma coleção. Antes, titulo_pt existia apenas numa variável local,
        # por isso a seleção pelo nome traduzido nunca funcionava.
        self.state.detailed_options = translated
        lines = ["Encontrei estas opções de receitas:", ""]
        for index, recipe in enumerate(translated, 1):
            lines.append(f"{index}. {recipe['titulo_pt']}")
            lines.append(f"   Alguns ingredientes: {', '.join(recipe['ingredientes_pt'])}")
            compatibility = recipe.get("compatibilidade")
            if compatibility:
                lines.append(
                    f"   Aproveitamento: {compatibility['percentual_aproveitamento']:.1f}%"
                )
                lines.append(
                    "   Disponíveis usados: "
                    + (", ".join(compatibility["ingredientes_aproveitados"]) or "nenhum")
                )
                lines.append(
                    "   Ainda faltam: "
                    + (", ".join(compatibility["ingredientes_nao_encontrados"]) or "nenhum dos informados")
                )
        lines.append("\nQual você gostaria de preparar? Responda com o número ou nome.")
        return "\n".join(lines)

    def select_recipe(self, choice: str) -> str:
        if not self.state.detailed_options:
            return "Não existem opções de receitas disponíveis."
        if choice.strip().isdigit():
            index = int(choice.strip()) - 1
            if not 0 <= index < len(self.state.detailed_options):
                return f"Escolha um número entre 1 e {len(self.state.detailed_options)}."
            recipe = self.state.detailed_options[index]
        else:
            normalized_choice = normalize_choice(choice)
            matches = [
                item
                for item in self.state.detailed_options
                if normalized_choice in {
                    normalize_choice(item.get("titulo", "")),
                    normalize_choice(item.get("titulo_pt", "")),
                }
            ]
            if not matches:
                return "Não identifiquei a receita. Informe o número ou o nome exato."
            recipe = matches[0]
        localized_recipe = self.llm.translate_full_recipe(recipe)
        self.state.selected_recipe = localized_recipe
        self.state.last_recipe = localized_recipe
        return format_recipe(localized_recipe)

    def handle(self, text: str) -> str:
        if is_ingredient_request(text):
            data = self.llm.extract_ingredients(text)
            available = data["ingredientes_disponiveis"]
            self.state.available_ingredients = available
            self.state.ingredient_mode = True
            # A busca inicial usa o ingrediente principal; a compatibilidade
            # é calculada somente depois que os ingredientes reais da receita
            # forem recuperados da FatSecret.
            return self.search_and_prepare(
                data["ingrediente_principal"],
                available_ingredients=available,
            )

        query = extract_recipe_query(text)
        if query:
            self.state.available_ingredients.clear()
            self.state.ingredient_mode = False
            return self.search_and_prepare(translate_query(query))

        if is_direct_food_query(text):
            self.state.available_ingredients.clear()
            self.state.ingredient_mode = False
            return self.search_and_prepare(translate_query(text))

        if self.state.detailed_options and self.state.selected_recipe is None:
            return self.select_recipe(text)

        if self.state.last_recipe and is_previous_recipe_request(text):
            return format_recipe(self.state.last_recipe)

        self.state.messages.append({"role": "user", "content": text})
        response = chat(model=self.settings.model, messages=self.state.messages, keep_alive="10m", options={"temperature": 0, "num_predict": 256})
        content = (response.message.content or "").strip()
        self.state.messages.append({"role": "assistant", "content": content})
        return content or "Não consegui gerar uma resposta."


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")
    try:
        app = ChefApp(Settings.from_env())
    except RuntimeError as exc:
        print(f"Configuração inválida: {exc}")
        return

    print("CustomChef iniciado. Digite 'sair' para encerrar.")
    while True:
        try:
            text = input("\nVocê: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nAté logo!")
            break
        if text.casefold() == "sair":
            print("Até logo!")
            break
        if not text:
            continue
        try:
            print(f"\nCustomChef: {app.handle(text)}")
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            LOGGER.exception("Erro controlado no processamento")
            print(f"\nCustomChef: Não consegui concluir a solicitação com segurança. Detalhe: {exc}")
        except Exception:
            LOGGER.exception("Erro inesperado")
            print("\nCustomChef: Ocorreu um erro inesperado. Verifique o Ollama e tente novamente.")


if __name__ == "__main__":
    main()
