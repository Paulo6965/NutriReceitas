#import os
#from dotenv import load_dotenv
#from time import sleep
from ollama import chat # Teoricamente, é a única coisa útil aqui por hora.

#load_dotenv() # Teoricamente não é necessário. Pois não usará chave de API


# PRECISA BAIXAR LLAMA LOCALMENTE.
messages = [
    {
        'role': 'system',
        'content': (
            'Você é um assistente culinário chamado CustomChef.\n'
            'Responda sempre em português brasileiro.\n'
            'Seja direto em perguntas simples.\n'
            'Não use ferramentas sem necessidade.\n'
            'Ao fornecer receitas, detalhe ingredientes, '
            'passo a passo e equipamentos utilizados.'
        )
    }
]

while True:
    user_input = input("\nVocê: ")

    if user_input.lower().strip() == "sair":
        break

    messages.append({
        'role': 'user',
        'content': user_input
    })

    response = chat(
        model='qwen3:4b',
        messages=messages,
        keep_alive='10m',
        options={
            'num_ctx': 4096,
            'num_predict': 256
        }
    )

    answer = response.message.content
    print(f"\nCustomChef: {answer}")

    messages.append({
        'role': 'assistant',
        'content': answer
    })
