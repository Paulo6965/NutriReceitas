"""CustomChef - assistente culinário baseado em FatSecret + IA (Gemini ou Ollama).

Execução (modo terminal):
    python backend/customchef.py

Variáveis do arquivo .env:
    FATSECRET_CLIENT_ID=...
    FATSECRET_CLIENT_SECRET=...
    LLM_PROVIDER=gemini         # ou "ollama"
    GEMINI_API_KEY=...          # obrigatório com Gemini
    GEMINI_MODEL=gemini-flash-lite-latest   # opcional
    OLLAMA_MODEL=qwen3:4b       # opcional, só com Ollama

Dependências:
    pip install -r backend/requirements.txt
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any

import requests
import urllib3.util.connection as _urllib3_connection

# Servidores na nuvem (ex.: VM da Azure) às vezes tentam IPv6 primeiro sem ter
# rota IPv6: cada chamada ao Gemini/FatSecret fica parada até o tempo limite
# antes de cair para IPv4, e o chat passa de 60 s. Usar só IPv4 evita isso.
_urllib3_connection.HAS_IPV6 = False
from dotenv import load_dotenv


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
    request_timeout: tuple[int, int] = (5, 15)  # (conectar, ler) da FatSecret
    max_tool_rounds: int = 5
    max_recipe_options: int = 3
    # "gemini" (nuvem, plano gratuito) ou "ollama" (modelo rodando no PC).
    llm_provider: str = "ollama"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-flash-lite-latest"

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        client_id = os.getenv("FATSECRET_CLIENT_ID", "").strip()
        client_secret = os.getenv("FATSECRET_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            raise RuntimeError(
                "Configure FATSECRET_CLIENT_ID e FATSECRET_CLIENT_SECRET no .env."
            )
        gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        # Sem LLM_PROVIDER no .env: usa Gemini se houver chave, senão Ollama.
        provider = os.getenv("LLM_PROVIDER", "").strip().lower() or ("gemini" if gemini_key else "ollama")
        if provider not in {"gemini", "ollama"}:
            raise RuntimeError("LLM_PROVIDER deve ser 'gemini' ou 'ollama'.")
        if provider == "gemini" and not gemini_key:
            raise RuntimeError("Configure GEMINI_API_KEY no .env para usar o Gemini.")
        return cls(
            model=os.getenv("OLLAMA_MODEL", "qwen3:4b"),
            fatsecret_client_id=client_id,
            fatsecret_client_secret=client_secret,
            llm_provider=provider,
            gemini_api_key=gemini_key,
            gemini_model=os.getenv("GEMINI_MODEL", "").strip() or "gemini-flash-lite-latest",
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
    # Paginação ("ver mais"): próxima candidata a detalhar (modo prato) e
    # receitas já ranqueadas que ainda não foram mostradas (modo ingredientes).
    next_candidate: int = 0
    ranked_rest: list[dict[str, Any]] = field(default_factory=list)
    # Opções estruturadas da última resposta (título, foto...) para o site
    # montar os cards. Zerado a cada mensagem pelo servidor.
    options_payload: list[dict[str, Any]] | None = None
    has_more: bool = False
    exact_match: bool = True

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


def strip_model_reasoning(content: str, *, json_mode: bool = False) -> str:
    """Remove raciocínio interno e marcadores de saída do Ollama.

    Alguns modelos ainda emitem ``<think>...</think>`` mesmo com ``think=False``.
    Esse conteúdo nunca deve chegar ao usuário nem contaminar os JSONs
    estruturados usados pelas ferramentas.
    """
    text = str(content or "")
    text = re.sub(r"<think(?:ing)?\b[^>]*>.*?</think(?:ing)?>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<analysis\b[^>]*>.*?</analysis>", "", text, flags=re.IGNORECASE | re.DOTALL)
    # Alguns adaptadores entregam somente o fechamento, pois o início do
    # raciocínio foi tratado como metadado. Nesse caso, tudo antes dele é
    # raciocínio e deve ser descartado.
    if re.search(r"</(?:think|thinking|analysis)\s*>", text, flags=re.IGNORECASE):
        text = re.split(r"</(?:think|thinking|analysis)\s*>", text, maxsplit=1, flags=re.IGNORECASE)[-1]
    text = re.sub(r"</?(?:think|thinking|analysis)>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^\s*```(?:json|markdown|text)?\s*|\s*```\s*$", "", text, flags=re.IGNORECASE)
    text = text.strip()
    if json_mode:
        # Se o modelo deixou uma frase fora do JSON, mantém somente o objeto.
        first, last = text.find("{"), text.rfind("}")
        if first >= 0 and last > first:
            text = text[first:last + 1]
    return text.strip()


def parse_json_object(content: str) -> dict[str, Any]:
    try:
        value = json.loads(strip_model_reasoning(content, json_mode=True))
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
        if not response.ok:
            try:
                error_body = response.json()
            except ValueError:
                error_body = response.text[:500]
            raise RuntimeError(f"FatSecret HTTP {response.status_code}: {error_body}")
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("A FatSecret retornou um formato inesperado.")
        return data

    def search(self, query: str, page: int = 0) -> str:
        query = query.strip()
        if not query:
            return json_result({"erro": "Informe ingredientes ou uma receita para pesquisar."})

        # 50 é o máximo por página da FatSecret.
        params = {"search_expression": query, "max_results": 50, "page_number": page}

        def candidates_from(data: dict[str, Any]) -> list[dict[str, Any]]:
            raw = data.get("recipes", {})
            values = as_list(raw.get("recipe") if isinstance(raw, dict) else raw)
            if not values:
                values = as_list(data.get("recipe"))
            return [
                {
                    "recipe_id": str(item["recipe_id"]),
                    "titulo": item["recipe_name"],
                    "descricao": item.get("recipe_description"),
                    "url": item.get("recipe_url"),
                    # Nem toda receita da FatSecret tem foto.
                    "imagem": item.get("recipe_image"),
                    "ingredientes_busca": [
                        str(value) for value in as_list(
                            (item.get("recipe_ingredients") or {}).get("ingredient")
                            if isinstance(item.get("recipe_ingredients"), dict) else None
                        )
                    ],
                }
                for item in values
                if isinstance(item, dict) and item.get("recipe_id") and item.get("recipe_name")
            ]

        def response_info(data: dict[str, Any]) -> str:
            raw = data.get("recipes")
            if data.get("error") is not None:
                return f"raiz={list(data.keys())}, error={data.get('error')}"
            if isinstance(raw, dict):
                return f"raiz={list(data.keys())}, recipes={list(raw.keys())}, total={raw.get('total_results')}"
            return f"raiz={list(data.keys())}, recipes_type={type(raw).__name__}"

        def error_detail(data: dict[str, Any]) -> str | None:
            error = data.get("error")
            if error is None:
                return None
            if isinstance(error, dict):
                code = error.get("code")
                message = error.get("message") or error.get("detail") or error
                return f"código={code}, mensagem={message}" if code is not None else str(message)
            return str(error)

        try:
            # URL-based integration recomendada pela documentação atual.
            data = self.request("recipes/search/v3", params)
            candidates = candidates_from(data)
            LOGGER.info("FatSecret resposta v3 para %r: %s", query, response_info(data))
            api_error = error_detail(data)
            if api_error:
                LOGGER.error("FatSecret erro na busca v3 %r: %s", query, api_error)
                return json_result({"erro": "fatsecret_api_error", "detalhes": api_error})

            # Algumas contas/proxies ainda expõem somente a integração
            # method-based. Ela é oficialmente suportada pela FatSecret e
            # usa a mesma busca, sem exigir que o usuário mude a configuração.
            if not candidates:
                LOGGER.info("Busca v3 sem candidatos para %r; tentando server.api", query)
                data = self.request("server.api", {"method": "recipes.search.v3", **params})
                candidates = candidates_from(data)
                LOGGER.info("FatSecret resposta server.api para %r: %s", query, response_info(data))
                api_error = error_detail(data)
                if api_error:
                    LOGGER.error("FatSecret erro na busca server.api %r: %s", query, api_error)
                    return json_result({"erro": "fatsecret_api_error", "detalhes": api_error})

            # Receitas com foto primeiro (a ordem entre elas é mantida).
            candidates.sort(key=lambda item: not item.get("imagem"))
            self.state.candidates = candidates
            self.state.detailed_options = []
            self.state.selected_recipe = None
            LOGGER.info("FatSecret busca %r: %d candidatos", query, len(candidates))
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
            "bean": ["bean", "beans", "black beans", "kidney beans", "bean salad", "bean soup"],
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
                detail = result.get("detalhes")
                formatted = f"{result['erro']}: {detail}" if detail else str(result["erro"])
                errors.append(formatted)
                # O código 21 é bloqueio de IP. Repetir a mesma consulta com
                # outros termos não pode resolver a restrição e só consome
                # chamadas da API.
                if detail and "código=21" in str(detail):
                    LOGGER.error("FatSecret bloqueou o IP; interrompendo as consultas restantes: %s", detail)
                    break
            # Não interromper aqui: expansões do primeiro ingrediente, como
            # bread/loaf/toast, não podem impedir a consulta dos ingredientes
            # seguintes. O limite é aplicado somente após todas as consultas.

        self.state.candidates = list(merged.values())[:30]
        LOGGER.info("Candidatas únicas encontradas: %d", len(self.state.candidates))
        self.state.detailed_options = []
        self.state.selected_recipe = None
        if not self.state.candidates and not errors:
            # Algumas respostas da API não retornam o campo `receitas` para
            # consultas curtas, embora a busca normal pelo ingrediente
            # principal funcione. Tente novamente sem o modo combinado.
            fallback = parse_json_object(self.search(normalize_ingredient(primary)))
            if fallback.get("resultado") == "receitas_encontradas":
                self.state.candidates = [
                    item for item in fallback.get("receitas", [])
                    if isinstance(item, dict) and item.get("recipe_id")
                ][:30]
                LOGGER.info("Fallback pelo ingrediente principal: %d candidatas", len(self.state.candidates))
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
            if not isinstance(data.get("recipe"), dict):
                data = self.request("server.api", {"method": "recipe.get.v2", "recipe_id": recipe_id})
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
            # Foto: o detalhe às vezes traz recipe_images; a busca às vezes
            # traz recipe_image. Usa o que existir.
            images_raw = raw.get("recipe_images")
            detail_images = as_list(images_raw.get("recipe_image") if isinstance(images_raw, dict) else None)
            candidate = next((item for item in self.state.candidates if item["recipe_id"] == recipe_id), {})
            image = next((url for url in detail_images if isinstance(url, str) and url), None) or candidate.get("imagem")

            recipe = {
                "recipe_id": str(raw.get("recipe_id", recipe_id)),
                "titulo": raw.get("recipe_name"),
                "imagem": image,
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

    def first_complete_options(self, limit: int, start: int = 0) -> str:
        """Detalha até `limit` candidatas a partir de `start` (para o "ver mais")."""
        options: list[dict[str, Any]] = []
        index = start
        while index < len(self.state.candidates) and len(options) < limit:
            candidate = self.state.candidates[index]
            index += 1
            result = parse_json_object(self.details(candidate["recipe_id"], store_last=False))
            if result.get("titulo") and result.get("ingredientes") and not result.get("erro"):
                options.append(result)
        self.state.next_candidate = index
        self.state.detailed_options = options
        if not options:
            return json_result({"erro": "detalhes_nao_encontrados"})
        return json_result({"resultado": "opcoes_recuperadas", "receitas": options})


# ---------------------------------------------------------------------------
# Integração com Ollama
# ---------------------------------------------------------------------------

class LLMService:
    """Camada única de IA: Gemini (nuvem, gratuito) ou Ollama (local).

    O resto do código só chama ``extract_ingredients``, ``translate_options``
    e ``translate_full_recipe``; o provedor é escolhido no ``.env``.
    Se a IA falhar, a tradução cai para o dicionário local
    (``localize_recipe_fallback``) em vez de mostrar o texto em inglês.
    """

    GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    TRANSLATION_RULES = (
        "Você traduz receitas do inglês para o português do Brasil. "
        "Use vocabulário culinário brasileiro (ex.: 'pimenta-do-reino', 'colher de sopa', "
        "'xícara', 'frigideira', 'geladeira'). Use o imperativo nos passos ('Aqueça', 'Misture'). "
        "Preserve todos os números, quantidades e a ordem dos itens. Não resuma, não junte nem "
        "divida itens, não acrescente nada e não deixe trechos em inglês. "
        "Responda somente com JSON válido, sem markdown."
    )

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.http = requests.Session()

    # -- Chamada ao modelo ---------------------------------------------------

    def _complete_json(self, system: str, payload: Any, *, max_tokens: int = 2048) -> dict[str, Any]:
        user = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        if self.settings.llm_provider == "gemini":
            content = self._gemini(system, user, max_tokens)
        else:
            content = self._ollama(system, user, max_tokens)
        return parse_json_object(content)

    # Modelo rápido usado se o configurado travar ou falhar. Vale para o
    # processo inteiro: depois da 1ª troca, as próximas mensagens já usam ele.
    FALLBACK_MODEL = "gemini-flash-lite-latest"
    _model_override: str | None = None
    # (conectar, ler) em segundos. Tem que caber nos ~60 s do proxy do site,
    # somando a interpretação, a FatSecret e a tradução.
    GEMINI_TIMEOUT = (5, 20)

    @classmethod
    def active_gemini_model(cls, settings: "Settings") -> str:
        return cls._model_override or settings.gemini_model

    def _gemini(self, system: str, user: str, max_tokens: int, _retry: bool = False) -> str:
        model = self.active_gemini_model(self.settings)
        try:
            response = self._gemini_post(model, system, user, max_tokens)
        except (requests.Timeout, requests.ConnectionError) as exc:
            if model != self.FALLBACK_MODEL:
                LOGGER.warning("Gemini %s não respondeu (%s); trocando para %s", model, exc, self.FALLBACK_MODEL)
                LLMService._model_override = self.FALLBACK_MODEL
                return self._gemini(system, user, max_tokens, _retry)
            raise RuntimeError(f"Gemini não respondeu a tempo: {exc}") from exc
        if (response.status_code == 404 or response.status_code >= 500) and model != self.FALLBACK_MODEL:
            LOGGER.warning("Gemini %s respondeu HTTP %s; trocando para %s", model, response.status_code, self.FALLBACK_MODEL)
            LLMService._model_override = self.FALLBACK_MODEL
            return self._gemini(system, user, max_tokens, _retry)
        return self._gemini_read(response, system, user, max_tokens, _retry)

    def _gemini_post(self, model: str, system: str, user: str, max_tokens: int) -> requests.Response:
        return self.http.post(
            self.GEMINI_URL.format(model=model),
            headers={"x-goog-api-key": self.settings.gemini_api_key},
            json={
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {
                    "temperature": 0,
                    "responseMimeType": "application/json",
                    # Modelos com "raciocínio" gastam parte destes tokens
                    # pensando; por isso a margem é maior que a resposta.
                    "maxOutputTokens": max_tokens + 4096,
                },
            },
            timeout=self.GEMINI_TIMEOUT,
        )

    def _gemini_read(self, response: requests.Response, system: str, user: str, max_tokens: int, _retry: bool) -> str:
        if response.status_code == 429 and not _retry:
            # Plano gratuito: limite de pedidos por minuto. Espera um pouco
            # e tenta mais uma vez antes de cair no dicionário local.
            LOGGER.warning("Gemini no limite por minuto (429); tentando de novo em 6 s")
            time.sleep(6)
            return self._gemini(system, user, max_tokens, _retry=True)
        if response.status_code == 429:
            raise RuntimeError("Limite gratuito do Gemini atingido (HTTP 429). Aguarde um pouco.")
        if not response.ok:
            raise RuntimeError(f"Gemini HTTP {response.status_code}: {response.text[:300]}")
        data = response.json()
        candidates = data.get("candidates") or []
        if not candidates:
            raise RuntimeError(f"Gemini não retornou resposta: {data.get('promptFeedback')}")
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "".join(part.get("text", "") for part in parts if not part.get("thought"))
        if not text.strip():
            raise RuntimeError("Gemini retornou uma resposta vazia.")
        return text

    def _ollama(self, system: str, user: str, max_tokens: int) -> str:
        # Importado só aqui: quem usa Gemini não precisa ter o Ollama instalado.
        from ollama import chat

        response = chat(
            model=self.settings.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            think=False,
            format="json",
            options={"temperature": 0, "num_predict": max_tokens, "repeat_penalty": 1.15},
        )
        return response.message.content or ""

    # -- Ingredientes -------------------------------------------------------

    def extract_ingredients(self, text: str) -> dict[str, Any]:
        data = self._complete_json(
            "Extraia ingredientes da mensagem. Retorne somente JSON válido no formato "
            '{"ingrediente_principal":"chicken","ingredientes_disponiveis":["chicken","potato","carrot"]}. '
            "Traduza para inglês, preserve todos os ingredientes e não invente nenhum. "
            "Escolha como ingrediente_principal o ingrediente mais adequado para buscar receitas. "
            "O ingrediente_principal deve aparecer na lista. "
            "Se a mensagem não citar nenhum alimento, retorne "
            '{"ingrediente_principal":"","ingredientes_disponiveis":[]}.',
            text,
            max_tokens=256,
        )
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

    def interpret(self, text: str) -> dict[str, Any]:
        """Entende o pedido: um prato ("sorvete de laranja") ou ingredientes que a pessoa tem."""
        data = self._complete_json(
            "Você interpreta mensagens de um app de receitas e responde somente JSON válido no formato "
            '{"tipo":"prato","busca":"orange ice cream","base":"ice cream",'
            '"alternativas":["orange sorbet","sorbet","sherbet"],"ingredientes":[]}.\n'
            'tipo "prato": a pessoa quer um prato, doce, bebida ou tipo de receita '
            '(ex.: "sorvete", "bolo de chocolate", "quero fazer um sorvete de laranja", '
            '"receita de lasanha", "uma sobremesa com morango"). Uma comida citada sozinha '
            '(ex.: "sorvete", "frango", "panqueca") também é "prato". '
            '"busca" é o nome em inglês, curto, com TODOS os detalhes pedidos '
            '(ex.: "ice cream", "orange ice cream", "chocolate cake", "strawberry dessert"). '
            '"base" é o prato sem sabor nem detalhe, em inglês (ex.: "orange ice cream" → "ice cream"; '
            '"chocolate cake" → "cake"; "ice cream" → "ice cream"). '
            '"alternativas" são até 3 sinônimos em inglês do prato pedido e do prato base, nunca categorias '
            'genéricas como "dessert" ou "meal" (ex.: "ice cream" → ["sorbet", "sherbet", "gelato"]; '
            '"orange ice cream" → ["orange sorbet", "sorbet", "sherbet"]; '
            '"pancake" → ["crepe", "hotcake"]).\n'
            'tipo "ingredientes": a pessoa lista o que tem em casa para aproveitar '
            '(ex.: "tenho frango e arroz", "frango, arroz e cebola", "o que faço com ovo e queijo", '
            '"sobrou carne moída"). "ingredientes" é a lista em inglês, no singular; '
            '"busca" é o ingrediente mais importante da lista.\n'
            'tipo "nada": a mensagem não fala de comida.\n'
            "Nunca invente comidas que não estão na mensagem.",
            text,
            max_tokens=200,
        )
        kind = str(data.get("tipo", "")).strip().lower()
        query = str(data.get("busca", "") or "").strip()
        alternatives = [
            str(item).strip() for item in data.get("alternativas") or [] if isinstance(item, str) and item.strip()
        ]
        ingredients = [
            str(item).strip().lower()
            for item in data.get("ingredientes") or []
            if isinstance(item, str) and item.strip()
        ]
        if kind == "ingredientes" and ingredients:
            principal = query.lower() if query.lower() in ingredients else ingredients[0]
            return {"tipo": "ingredientes", "busca": principal, "ingredientes": list(dict.fromkeys(ingredients))}
        if kind == "prato" and query:
            # O prato base ("ice cream") entra logo depois da busca exata.
            base = str(data.get("base", "") or "").strip()
            alternatives = list(dict.fromkeys([base, *alternatives] if base else alternatives))
            alternatives = [term for term in alternatives if term.casefold() != query.casefold()]
            return {"tipo": "prato", "busca": query, "alternativas": alternatives}
        return {"tipo": "nada"}

    # -- Tradução -----------------------------------------------------------

    @staticmethod
    def _valid_text_list(value: Any, expected: int) -> bool:
        return (
            isinstance(value, list)
            and len(value) == expected
            and all(isinstance(item, str) and item.strip() for item in value)
        )

    def translate_options(self, options: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Traduz todas as opções da lista em UMA chamada (antes era uma por opção)."""
        payload = [
            {"titulo": item["titulo"], "ingredientes": item["ingredientes"][:4]}
            for item in options
        ]
        translated: list[Any] = []
        if payload:
            try:
                data = self._complete_json(
                    self.TRANSLATION_RULES
                    + ' Formato: {"receitas":[{"titulo":"...","ingredientes":["..."]}]} '
                    "com o mesmo número de receitas e de ingredientes recebidos.",
                    {"receitas": payload},
                    max_tokens=1024,
                )
                translated = data.get("receitas") if isinstance(data.get("receitas"), list) else []
            except Exception as exc:
                LOGGER.warning("Falha ao traduzir as opções; usando o dicionário local: %s", exc)

        result = []
        for index, (original, sent) in enumerate(zip(options, payload)):
            copy = dict(original)
            item = translated[index] if index < len(translated) and isinstance(translated[index], dict) else {}
            title = item.get("titulo")
            ingredients = item.get("ingredientes")
            if isinstance(title, str) and title.strip() and self._valid_text_list(ingredients, len(sent["ingredientes"])):
                copy["titulo_pt"] = title.strip()
                copy["ingredientes_pt"] = [
                    normalize_ingredient_quantity(src, dst.strip())
                    for src, dst in zip(sent["ingredientes"], ingredients)
                ]
            else:
                fallback_title = translate_title_to_pt_br(sent["titulo"])
                copy["titulo_pt"] = fallback_title[:1].upper() + fallback_title[1:]
                copy["ingredientes_pt"] = [translate_ingredient_to_pt_br(v) for v in sent["ingredientes"]]
            result.append(copy)
        return result

    def translate_full_recipe(self, recipe: dict[str, Any]) -> dict[str, Any]:
        """Traduz título, ingredientes e passos numa chamada só.

        Se alguma parte vier incompleta, tenta de novo só os passos e, se
        ainda assim falhar, usa o dicionário local para aquela parte.
        """
        original_title = recipe.get("titulo", "")
        original_ingredients = list(recipe.get("ingredientes", []))
        original_steps = list(recipe.get("passo_a_passo", []))
        fallback = localize_recipe_fallback(recipe)

        data: dict[str, Any] = {}
        try:
            data = self._complete_json(
                self.TRANSLATION_RULES
                + ' Formato: {"titulo":"...","ingredientes":["..."],"passo_a_passo":["..."]} '
                "com o mesmo número de ingredientes e de passos recebidos.",
                {
                    "titulo": original_title,
                    "ingredientes": original_ingredients,
                    "passo_a_passo": original_steps,
                },
                max_tokens=3072,
            )
        except Exception as exc:
            LOGGER.warning("Falha ao traduzir a receita completa: %s", exc)

        title = data.get("titulo")
        if not isinstance(title, str) or not title.strip():
            title = fallback["titulo"]

        ingredients = data.get("ingredientes")
        if self._valid_text_list(ingredients, len(original_ingredients)):
            ingredients = [
                normalize_ingredient_quantity(src, dst.strip())
                for src, dst in zip(original_ingredients, ingredients)
            ]
        else:
            ingredients = fallback["ingredientes"]

        steps = data.get("passo_a_passo")
        if not self._valid_text_list(steps, len(original_steps)) and original_steps:
            try:
                retry = self._complete_json(
                    self.TRANSLATION_RULES
                    + ' Formato: {"passo_a_passo":["..."]} com exatamente '
                    f"{len(original_steps)} itens, um para cada passo recebido.",
                    {"passo_a_passo": original_steps},
                    max_tokens=2048,
                )
                steps = retry.get("passo_a_passo")
            except Exception as exc:
                LOGGER.warning("Falha ao traduzir os passos: %s", exc)
                steps = None
        used_fallback = not self._valid_text_list(steps, len(original_steps))
        if used_fallback:
            steps = fallback["passo_a_passo"]

        localized = dict(recipe)
        title = to_brazilian_portuguese(title.strip())
        localized["titulo"] = title[:1].upper() + title[1:]
        localized["ingredientes"] = ingredients
        localized["passo_a_passo"] = [
            normalize_culinary_phrasing(to_brazilian_portuguese(step.strip())) for step in steps
        ]
        if used_fallback and original_steps:
            localized["aviso"] = fallback.get("aviso")
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
        r"\btemos\b",
        r"\bdisponho de\b",
        r"\b(?:estou|t[oô]|fiquei) com\b",
        r"\bsobr(?:ou|aram|ando)\b",
        r"\busando\b",
        r"\breceitas? (?:com|usando)\b",
        r"\b(?:fazer|faço|faco|cozinhar|cozinho|preparar|preparo) (?:algo |alguma coisa )?com\b",
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


def extract_ingredients_deterministically(text: str) -> list[str]:
    """Extrai ingredientes conhecidos sem depender da resposta textual do Ollama."""
    normalized = normalize_choice(text)
    matches: list[tuple[int, str]] = []
    aliases = (
        ("batata doce", "sweet potato"),
        ("farinha de trigo", "wheat flour"),
        ("arroz", "rice"),
        ("feijao", "beans"),
        ("frango", "chicken"),
        ("chicken", "chicken"),
        ("queijo", "cheese"),
        ("cheese", "cheese"),
        ("tomate", "tomato"),
        ("tomato", "tomato"),
        ("farinha", "flour"),
        ("flour", "flour"),
        ("pao", "bread"),
        ("bread", "bread"),
        ("batata", "potato"),
        ("potato", "potato"),
        ("ovo", "egg"),
        ("ovos", "egg"),
        ("egg", "egg"),
        ("cebola", "onion"),
        ("onion", "onion"),
        ("cenoura", "carrot"),
        ("carrot", "carrot"),
        ("macarrao", "pasta"),
        ("pasta", "pasta"),
    )
    for source, english in sorted(aliases, key=lambda item: len(item[0]), reverse=True):
        match = re.search(rf"(?<!\w){re.escape(source)}(?!\w)", normalized)
        if match:
            matches.append((match.start(), english))
    found: list[str] = []
    for _, english in sorted(matches, key=lambda item: item[0]):
        if english not in found:
            found.append(english)
    return found


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


def _words(text: str) -> list[str]:
    """Palavras em minúsculas, sem plural simples ("cakes" → "cake")."""
    stop = {"and", "with", "of", "the", "a", "an", "in", "for", "or"}
    words = re.findall(r"[a-z0-9]+", (text or "").casefold())
    return [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words if w not in stop]


def rank_by_relevance(
    candidates: list[dict[str, Any]], query: str, alternatives: list[str] | None = None
) -> tuple[list[dict[str, Any]], bool]:
    """Fica só com as receitas que são o que a pessoa pediu e ordena.

    A FatSecret devolve receitas com QUALQUER palavra da busca (por isso
    "ice cream" trazia salmão com creme). Níveis, do melhor para o pior:
      0. todas as palavras do pedido no nome ("Orange Ice Cream")
      1. todas as palavras no nome/descrição/ingredientes e o prato base no nome
         ("Banana Ice Cream" com suco de laranja nos ingredientes)
      2. um sinônimo inteiro no nome ("Mango Sorbet" para "ice cream")
      3. todas as palavras só na descrição/ingredientes
      4. só parte das palavras no nome (usado apenas se não houver nada melhor)
    No empate, receitas com foto vêm antes.
    Retorna (lista, achou_exato), onde achou_exato = existe nível 0 ou 1.
    """
    wanted = set(_words(query))
    synonyms = [set(_words(term)) for term in alternatives or [] if _words(term)]

    def tier(item: dict[str, Any]) -> tuple[int, int]:
        title = set(_words(item.get("titulo", "")))
        rest = set(_words(item.get("descricao") or ""))
        for line in item.get("ingredientes_busca") or []:
            rest |= set(_words(line))
        everything = title | rest
        partial = len(wanted & title)
        if wanted and wanted <= title:
            return 0, partial
        has_dish_name = any(syn <= title for syn in synonyms)
        if wanted and wanted <= everything and has_dish_name:
            return 1, partial
        if has_dish_name:
            return 2, partial
        if wanted and wanted <= everything:
            return 3, partial
        if partial:
            return 4, partial
        return 5, 0

    scored = [(tier(item), item) for item in candidates]
    best = min((t for (t, _), _ in scored), default=5)
    # Sinônimo no nome (nível 2) já é o prato pedido; o nível 3 (só nos
    # ingredientes, ex.: cheesecake que leva sorvete) entra só se não houver nada melhor.
    limit = 2 if best <= 2 else best
    kept = [(t, item) for t, item in scored if t[0] <= limit]
    kept.sort(key=lambda pair: (pair[0][0], -pair[0][1], not pair[1].get("imagem")))
    return [item for _, item in kept], best <= 1


def is_more_request(text: str) -> bool:
    """"mais", "ver mais", "outras opções", "mostra mais receitas"..."""
    normalized = normalize_choice(text).strip(" .!?")
    return bool(re.fullmatch(
        r"(?:(?:me )?(?:mostr[ae]|ver|quero(?: ver)?|manda|traga|tem) )?(?:mais|outras?|outros)"
        r"(?: (?:opcoes|opcao|receitas?|sugestoes))?(?: por favor)?",
        normalized,
    ))


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


RECIPE_NOT_IDENTIFIED = "Não identifiquei a receita. Informe o número ou o nome exato."


class ChefApp:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.state = ConversationState(messages=[
            {"role": "system", "content": (
                "Você é o CustomChef. Responda em português brasileiro. "
                "Não invente receitas, ingredientes ou instruções. "
                "As receitas devem vir da FatSecret. "
                "Retorne somente a resposta final para o usuário; nunca mostre "
                "raciocínio, análise, planejamento, tags <think> ou comentários sobre suas instruções."
            )}
        ])
        self.llm = LLMService(settings)
        self.fatsecret = FatSecretClient(settings, self.state)

    PAGE_SIZE = 6

    def search_and_prepare(
        self,
        query: str,
        *,
        available_ingredients: list[str] | None = None,
        alternatives: list[str] | None = None,
    ) -> str:
        self.state.ranked_rest = []
        self.state.next_candidate = 0
        if available_ingredients:
            search_result = parse_json_object(
                self.fatsecret.search_for_ingredients(query, available_ingredients)
            )
        else:
            # Modo prato: busca o pedido ("orange ice cream") e até duas
            # alternativas mais amplas ("orange sorbet", "ice cream"), junta
            # tudo e ordena pela relevância em relação ao pedido original.
            search_result = {}
            merged: dict[str, dict[str, Any]] = {}
            terms = list(dict.fromkeys([query, *(alternatives or [])]))[:5]
            searches = [(query, 0), (query, 1), *((term, 0) for term in terms[1:])]
            for term, page in searches:
                result = parse_json_object(self.fatsecret.search(term, page))
                LOGGER.info("Busca de prato %r: %s", term, result.get("resultado") or result.get("erro"))
                if result.get("erro"):
                    if not merged:
                        search_result = result
                    break
                for item in result.get("receitas", []):
                    merged.setdefault(item["recipe_id"], item)
            if merged:
                self.state.candidates, self.state.exact_match = rank_by_relevance(list(merged.values()), query, alternatives or [])
                search_result = {"resultado": "receitas_encontradas"}
            elif not search_result:
                search_result = {"mensagem": "Não encontrei receitas para esse pedido na FatSecret. Tente outro nome."}
        if search_result.get("resultado") != "receitas_encontradas":
            if search_result.get("erro"):
                detail = str(search_result.get("detalhes") or search_result.get("erro"))
                LOGGER.error("FatSecret retornou erro na busca %r: %s", query, detail)
                if "código=21" in detail:
                    return "A FatSecret recusou a consulta agora (bloqueio de IP). Tente de novo em alguns segundos."
                return f"A FatSecret retornou um erro na busca. Veja o terminal do servidor. Detalhe: {detail}"
            if search_result.get("erros"):
                LOGGER.warning("FatSecret respondeu sem resultados para %r. Consultas: %s; erros: %s", query, search_result.get("consultas_realizadas"), search_result.get("erros"))
                return "A FatSecret retornou erro ao pesquisar: " + " | ".join(map(str, search_result["erros"]))
            return search_result.get("mensagem", "Nenhuma receita encontrada.")

        if available_ingredients:
            # No modo de aproveitamento, detalhamos todas as candidatas antes de
            # ranquear. Pesquisar os termos juntos não garante que as receitas
            # contenham esses ingredientes.
            details = parse_json_object(self.fatsecret.first_complete_options(len(self.state.candidates)))
            if details.get("resultado") != "opcoes_recuperadas":
                return "Não consegui recuperar receitas completas."
            scored = [
                calculate_compatibility(recipe, available_ingredients)
                for recipe in self.state.detailed_options
            ]
            # Uma receita que não usa nenhum ingrediente informado é ruído.
            scored = [recipe for recipe in scored if recipe["compatibilidade"]["ingredientes_aproveitados"]]
            if not scored:
                return "Não encontrei receitas que usem nenhum dos ingredientes informados."
            # Maior aproveitamento primeiro; no empate, as que têm foto.
            scored.sort(key=lambda r: (-r["compatibilidade"]["percentual_aproveitamento"], not r.get("imagem")))
            page, self.state.ranked_rest = scored[: self.PAGE_SIZE], scored[self.PAGE_SIZE:]
            self.state.detailed_options = []
            return self.present_options(page, "Encontrei estas opções de receitas:")

        details = parse_json_object(self.fatsecret.first_complete_options(self.PAGE_SIZE))
        if details.get("resultado") != "opcoes_recuperadas":
            return "Não consegui recuperar receitas completas."
        page = self.state.detailed_options
        self.state.detailed_options = []
        intro = (
            "Encontrei estas opções de receitas:"
            if self.state.exact_match
            else "Não achei uma receita exatamente assim na FatSecret. Estas são as mais parecidas:"
        )
        return self.present_options(page, intro)

    def has_more_options(self) -> bool:
        if self.state.ingredient_mode:
            return bool(self.state.ranked_rest)
        return self.state.next_candidate < len(self.state.candidates)

    def more_options(self) -> str:
        if not self.has_more_options():
            return "Não tenho mais receitas para essa busca. Tente pedir outra coisa."
        if self.state.ingredient_mode:
            page = self.state.ranked_rest[: self.PAGE_SIZE]
            self.state.ranked_rest = self.state.ranked_rest[self.PAGE_SIZE:]
        else:
            shown = self.state.detailed_options
            self.fatsecret.first_complete_options(self.PAGE_SIZE, start=self.state.next_candidate)
            page = self.state.detailed_options
            self.state.detailed_options = shown
            if not page:
                return "Não tenho mais receitas para essa busca. Tente pedir outra coisa."
        return self.present_options(page, "Mais opções de receitas:")

    def present_options(self, page: list[dict[str, Any]], intro: str) -> str:
        """Traduz uma página de opções, numera continuando a lista e monta texto + cards."""
        translated = self.llm.translate_options(page)
        first_number = len(self.state.detailed_options) + 1
        # As opções exibidas e as usadas na seleção são a mesma coleção.
        self.state.detailed_options = self.state.detailed_options + translated
        self.state.has_more = self.has_more_options()
        lines = [intro, ""]
        payload = []
        for number, recipe in enumerate(translated, first_number):
            stats = []
            compatibility = recipe.get("compatibilidade")
            if compatibility:
                stats = [
                    f"Aproveitamento: {compatibility['percentual_aproveitamento']:.1f}%",
                    "Disponíveis usados: "
                    + (", ".join(translate_ingredient_to_pt_br(i) for i in compatibility["ingredientes_aproveitados"]) or "nenhum"),
                    "Ainda faltam: "
                    + (", ".join(translate_ingredient_to_pt_br(i) for i in compatibility["ingredientes_nao_encontrados"]) or "nenhum dos informados"),
                ]
            lines.append(f"{number}. {recipe['titulo_pt']}")
            lines.append(f"   Alguns ingredientes: {', '.join(recipe['ingredientes_pt'])}")
            lines.extend(f"   {line}" for line in stats)
            payload.append({
                "numero": number,
                "titulo": recipe["titulo_pt"],
                "imagem": recipe.get("imagem"),
                "ingredientes": recipe["ingredientes_pt"],
                "detalhes": stats,
            })
        self.state.options_payload = payload
        if self.state.has_more:
            lines.append("\nQuer ver outras? Escreva “mais”.")
        lines.append("\nQual você gostaria de preparar? Responda com o número ou nome.")
        return "\n".join(lines)

    def select_recipe(self, choice: str) -> str:
        if not self.state.detailed_options:
            return "Não existem opções de receitas disponíveis."
        # A própria resposta pede formatos como "2."; aceite também
        # "2)", "opção 2" e "receita 2" sem encaminhar a seleção ao LLM.
        number_match = re.fullmatch(r"\s*(?:op(?:ç|c)ão|receita)?\s*(\d+)\s*[.)-]?\s*", choice, re.IGNORECASE)
        if number_match:
            index = int(number_match.group(1)) - 1
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
                return RECIPE_NOT_IDENTIFIED
            recipe = matches[0]
        localized_recipe = self.llm.translate_full_recipe(recipe)
        self.state.selected_recipe = localized_recipe
        self.state.last_recipe = localized_recipe
        return format_recipe(localized_recipe)

    def search_by_ingredients(self, ingredients: list[str], principal: str | None = None) -> str:
        LOGGER.info("Ingredientes identificados: %s", ingredients)
        self.state.available_ingredients = ingredients
        self.state.ingredient_mode = True
        # A busca inicial usa o ingrediente principal; a compatibilidade
        # é calculada depois que os ingredientes reais da receita chegam.
        return self.search_and_prepare(principal or ingredients[0], available_ingredients=ingredients)

    def search_dish(self, query: str, alternatives: list[str] | None = None) -> str:
        LOGGER.info("Prato pedido: %r (alternativas: %s)", query, alternatives)
        self.state.available_ingredients = []
        self.state.ingredient_mode = False
        return self.search_and_prepare(query, alternatives=alternatives)

    def interpret(self, text: str) -> dict[str, Any]:
        """Usa a IA para entender o pedido; sem IA, usa as regras antigas."""
        try:
            return self.llm.interpret(text)
        except Exception as exc:
            LOGGER.warning("IA não conseguiu interpretar %r; usando regras locais: %s", text, exc)
        query = extract_recipe_query(text)
        if query:
            return {"tipo": "prato", "busca": translate_query(query), "alternativas": []}
        if is_direct_food_query(text):
            return {"tipo": "prato", "busca": translate_query(text), "alternativas": []}
        ingredients = extract_ingredients_deterministically(text)
        if ingredients:
            return {"tipo": "ingredientes", "busca": ingredients[0], "ingredientes": ingredients}
        return {"tipo": "nada"}

    def handle(self, text: str) -> str:
        # Saudações não precisam consultar o modelo.
        if normalize_choice(text).strip() in {"oi", "ola", "bom dia", "boa tarde", "boa noite"}:
            return "Olá! Sou o NutriChef. Diga um prato (ex.: “sorvete”) ou o que você tem em casa (ex.: “tenho frango e arroz”)."

        if self.state.last_recipe and is_previous_recipe_request(text):
            return format_recipe(self.state.last_recipe)

        if self.state.candidates and is_more_request(text):
            return self.more_options()

        not_found = None
        if self.state.detailed_options:
            reply = self.select_recipe(text)
            if reply != RECIPE_NOT_IDENTIFIED:
                return reply
            # Não era uma opção da lista: pode ser um novo pedido.
            not_found = reply

        intent = self.interpret(text)
        LOGGER.info("Interpretação de %r: %s", text, intent)
        if intent["tipo"] == "prato":
            return self.search_dish(intent["busca"], intent.get("alternativas"))
        if intent["tipo"] == "ingredientes":
            return self.search_by_ingredients(intent["ingredientes"], intent.get("busca"))
        if not_found:
            return not_found
        return (
            "Posso ajudar a buscar receitas da FatSecret. "
            "Diga um prato (ex.: “sorvete de laranja”) ou os ingredientes que você tem "
            "(ex.: “tenho frango e arroz”)."
        )


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
