"""Servidor local do NutriReceitas.

Serve os arquivos estáticos e expõe somente uma ponte HTTP mínima para o
CustomChef. O código do agente, Ollama e credenciais ficam neste processo.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
BACKEND = Path(__file__).resolve().parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from customchef import ChefApp, Settings  # noqa: E402

LOGGER = logging.getLogger("nutrireceitas.server")
SESSIONS: dict[str, ChefApp] = {}
SESSIONS_LOCK = threading.Lock()
MAX_BODY = 32_000


def get_app(session_id: str) -> ChefApp:
    # O identificador não é um segredo; ele apenas separa conversas no processo.
    with SESSIONS_LOCK:
        app = SESSIONS.get(session_id)
        if app is None:
            app = ChefApp(Settings.from_env())
            SESSIONS[session_id] = app
        return app


class Handler(SimpleHTTPRequestHandler):
    server_version = "NutriReceitasLocal/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        LOGGER.info("%s - %s", self.address_string(), fmt % args)

    def _json(self, status: int, payload: dict):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def _private_path(self):
        path = urlparse(self.path).path
        return (path == "/backend" or path.startswith("/backend/")
                or path == "/.env" or path.endswith(".py")
                or path.endswith(".pyc"))

    def _deny_private(self):
        self._json(404, {"error": "not_found"})

    def do_GET(self):
        if self._private_path():
            self._deny_private()
            return
        if urlparse(self.path).path == "/api/health":
            self._json(200, {"ok": True, "service": "local-chef"})
            return
        super().do_GET()

    def do_HEAD(self):
        if self._private_path():
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self):
        if urlparse(self.path).path != "/api/chef":
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                self._json(413, {"error": "payload_too_large"})
                return
            payload = json.loads(self.rfile.read(length))
            message = str(payload.get("message", "")).strip()
            session_id = str(payload.get("sessionId", "")).strip()
            context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
            if not message or not session_id or len(session_id) > 128:
                self._json(400, {"error": "message_and_session_required"})
                return
            # O CustomChef continua sendo a autoridade da conversa. O estoque
            # do frontend é usado apenas para tornar o comando explícito; não
            # executamos código nem aceitamos prompts de sistema do navegador.
            if "estoque" in message.casefold() or "despensa" in message.casefold():
                stock = context.get("stock", [])
                names = [str(item.get("name", "")).strip() for item in stock
                         if isinstance(item, dict) and str(item.get("name", "")).strip()]
                if names:
                    message = "Tenho " + ", ".join(names)
            app = get_app(session_id)
            # A seleção de uma receita produz um payload estruturado para o
            # modal. Limpa o marcador antes de cada mensagem para não reabrir
            # a receita em mensagens posteriores.
            app.state.selected_recipe = None
            result = app.handle(message)
            response = {"ok": True, "reply": result}
            if app.state.selected_recipe:
                response["recipe"] = app.state.selected_recipe
            self._json(200, response)
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid_json"})
        except Exception:
            LOGGER.exception("Falha ao processar /api/chef")
            self._json(500, {"error": "chef_unavailable", "reply": "Não consegui falar com o NutriChef local. Verifique o Ollama, as dependências e as credenciais."})


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    port = int(os.getenv("PORT", "5500"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    LOGGER.info("NutriReceitas em http://127.0.0.1:%d", port)
    LOGGER.info("Código da IA não é servido como arquivo estático; endpoint: /api/chef")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Encerrando")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
