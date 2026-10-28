import os
from dotenv import load_dotenv
from google import genai
from time import sleep

load_dotenv()

api_key = os.getenv("API_KEY")
MAX_RETRIES = int(os.getenv("MAX_RETRIES"))

if not api_key:
    raise ValueError("Error: API_KEY is not set in the .env file.")

print("Chave carregada com sucesso!")

client = genai.Client(api_key=api_key)

chat = client.chats.create(
    model="gemini-3.8-flash"
)

while True:
    print("\n[digite 'sair' para fechar o programa]")
    user_input = str(input("Seu prompt: "))

    if user_input.lower() == "sair":
        break

    attempt = 1
    while attempt < MAX_RETRIES:
        try:
            response = chat.send_message(
                message=user_input
            )

            print("CustomChef: ", response.text)
            break

        except Exception as e:
            print(f"Erro encontrado: {e}")

            if "503" not in str(e):
                raise

            if attempt == MAX_RETRIES - 1:
                print("Não foi possível obter uma resposta após várias tentativas.")
                break

            delay = 2 ** attempt

            print(
                f"Serviço sobrecarregado. "
                f"Tentando novamente em {delay}s..."
            )

            sleep(delay)
            attempt += 1

client.close()