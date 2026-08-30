import speech_recognition as sr

reconhecedor = sr.Recognizer()

with sr.Microphone() as microfone:

    try:
        audio = reconhecedor.listen(
            microfone,
            timeout=5,
            phrase_time_limit=5
        )

        texto = reconhecedor.recognize_google(
            audio,
            language="pt-BR"
        )

        # Envia somente o texto reconhecido
        print(texto)

    except sr.WaitTimeoutError:
        print("ERRO_TIMEOUT")

    except sr.UnknownValueError:
        print("ERRO_NAO_ENTENDI")

    except sr.RequestError:
        print("ERRO_CONEXAO")