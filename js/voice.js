/* NutriReceitas — voice.js
   Entrada de ingredientes por voz, com DOIS motores:

   1. Nativo (Web Speech API): Chrome, Edge e Safari. Rápido, mas usa o serviço online do navegador.
   2. Local (Whisper, via Transformers.js): roda DENTRO do navegador — funciona no Firefox, Brave,
      Opera e nos demais. Na primeira vez baixa o modelo (~75 MB, fica guardado em cache);
      depois funciona até sem internet.

   O site escolhe o motor sozinho e, se o nativo falhar, troca para o local automaticamente.
   Requisitos: http://localhost ou https:// (como arquivo, o microfone é bloqueado) e permissão do microfone. */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $('#mic-btn'); const micStatus = $('#mic-status');
const MIC_IDLE = 'Dica: toque no microfone e fale seus ingredientes.';
const SILENCE_MS = 1800;     // silêncio depois de falar = terminou
const MAX_REC_MS = 15000;    // gravação máxima no motor local
const WHISPER_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const WHISPER_MODEL = 'Xenova/whisper-base';

// Navegadores que expõem a API nativa mas ela não funciona de verdade
const nativeBroken = () => !!navigator.brave || /\bOPR\/|Opera|OPX\//.test(navigator.userAgent)
  || !!navigator.userAgentData?.brands?.some(b => /Opera|Brave/i.test(b.brand));

const Voice = {
  engine: null,            // 'native' | 'local'
  busy: false, listening: false, errorShown: false,

  status(html) { micStatus.innerHTML = html; },
  idle() { this.status(esc(MIC_IDLE)); },
  err(msg) { this.status(`<span class="voice-err">⚠ ${esc(msg)}</span>`); toast(msg); this.errorShown = true; },
  setListening(on) {
    this.listening = on; micBtn.classList.toggle('listening', on); micBtn.setAttribute('aria-pressed', String(on));
    chatInput.placeholder = on ? 'Ouvindo…' : PLACEHOLDERS[0];
  },
  pickEngine() {
    if (this.engine) return this.engine;
    return this.engine = SR && !nativeBroken() ? 'native' : 'local';
  },
  problem() {
    if (location.protocol === 'file:') return 'Para usar o microfone, abra o site pelo atalho "iniciar-site.bat" (endereço http://localhost) — aberto como arquivo, o navegador bloqueia o microfone.';
    if (!window.isSecureContext) return 'O microfone só funciona em endereço seguro (https:// ou localhost).';
    if (!navigator.mediaDevices?.getUserMedia) return 'Este navegador não permite acessar o microfone.';
    return null;
  },
  micError(err) {
    return err?.name === 'NotAllowedError' ? 'Permissão do microfone negada. Clique no cadeado ao lado do endereço do site e permita o microfone.'
      : err?.name === 'NotFoundError' ? 'Nenhum microfone encontrado. Conecte um microfone e tente de novo.'
      : err?.name === 'NotReadableError' ? 'O microfone está sendo usado por outro programa.'
      : 'Não foi possível acessar o microfone.';
  },
  send(text) {
    text = (text || '').trim();
    chatInput.value = '';
    if (text) { handleChat(text); this.idle(); }
    else if (!this.errorShown) this.status('Não entendi. Toque no microfone e fale de novo, perto dele.');
    this.errorShown = false;
  },

  async toggle() {
    if (this.busy) return;
    if (this.listening) return this.stop();
    const p = this.problem(); if (p) return this.err(p);
    this.errorShown = false;
    return this.pickEngine() === 'native' ? this.startNative() : this.startLocal();
  },
  stop() { this.engine === 'native' ? this.native?.stop() : this.local?.stop(); },

  // ---------------------------------------------------------------- motor nativo
  async startNative() {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
    catch (e) { return this.err(this.micError(e)); }

    const rec = new SR(); this.native = rec;
    let finalText = '', silence = null, started = false;
    rec.lang = 'pt-BR'; rec.interimResults = true; rec.continuous = true;

    // Se o nativo não "acordar" em 2,5 s, ele não funciona neste navegador → usa o motor local
    const watchdog = setTimeout(() => { if (!started) { try { rec.abort(); } catch {} this.fallbackToLocal(); } }, 2500);

    rec.onstart = () => {
      started = true; clearTimeout(watchdog); this.setListening(true);
      this.status('<span class="voice-on">● Ouvindo…</span> fale seus ingredientes. Toque no microfone para terminar.');
    };
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += ' ' + t; else interim += t;
      }
      chatInput.value = (finalText + ' ' + interim).replace(/\s+/g, ' ').trim();
      clearTimeout(silence); silence = setTimeout(() => rec.stop(), SILENCE_MS);
    };
    rec.onerror = (ev) => {
      clearTimeout(watchdog);
      // Falhas do serviço do navegador → troca para o motor local e tenta de novo
      if (['network', 'service-not-allowed', 'language-not-supported'].includes(ev.error)) { this.native = null; return this.fallbackToLocal(); }
      const msgs = {
        'not-allowed': 'Permissão do microfone negada. Clique no cadeado ao lado do endereço e permita o microfone.',
        'audio-capture': 'Não encontrei um microfone funcionando.',
        'no-speech': 'Não ouvi nada. Toque no microfone e fale perto dele.',
      };
      if (ev.error !== 'aborted') this.err(msgs[ev.error] || 'Não consegui ouvir, tente de novo.');
    };
    rec.onend = () => {
      clearTimeout(silence); clearTimeout(watchdog);
      if (this.engine !== 'native') return;            // já trocou para o local
      this.setListening(false);
      this.send(chatInput.value);
    };
    try { rec.start(); } catch { this.fallbackToLocal(); }
  },
  fallbackToLocal() {
    if (this.engine === 'local') return;
    this.engine = 'local'; this.setListening(false);
    toast('Usando o reconhecimento de voz local (funciona em qualquer navegador)');
    this.startLocal();
  },

  // ---------------------------------------------------------------- motor local (Whisper)
  pipe: null, loading: null,
  loadModel() {
    if (this.pipe) return Promise.resolve(this.pipe);
    if (!this.loading) {
      this.loading = (async () => {
        const { pipeline, env } = await import(WHISPER_LIB);
        env.allowLocalModels = false;            // baixa do Hugging Face e guarda no cache do navegador
        const files = {};
        const pipe = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
          progress_callback: (p) => {
            if (p.status !== 'progress' || !p.total) return;
            files[p.file] = [p.loaded, p.total];
            const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
            this.modelProgress = Math.round(l / t * 100);
            if (!this.listening) this.status(`⏳ Preparando o reconhecimento de voz (só na primeira vez)… ${this.modelProgress}%`);
          },
        });
        this.pipe = pipe; return pipe;
      })().catch(e => { this.loading = null; throw e; });
    }
    return this.loading;
  },

  async startLocal() {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return this.err(this.micError(e)); }

    const modelReady = this.loadModel();          // baixa/carrega o modelo enquanto a pessoa fala
    modelReady.catch(() => {});

    const chunks = [];
    const mr = new MediaRecorder(stream);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let spoke = false, lastVoice = performance.now(), meter = null, maxTimer = null;

    const finish = () => {
      clearInterval(meter); clearTimeout(maxTimer);
      if (mr.state !== 'inactive') mr.stop();
    };
    this.local = { stop: finish };

    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); ctx.close();
      this.setListening(false);
      if (!spoke) { this.status('Não ouvi nada. Toque no microfone e fale perto dele.'); return; }
      this.busy = true;
      try {
        this.status('⏳ Entendendo o que você falou…');
        const pipe = await modelReady;
        const audio = await this.decode(new Blob(chunks, { type: mr.mimeType }));
        const out = await pipe(audio, { language: 'portuguese', task: 'transcribe' });
        this.send(this.clean(out.text));
      } catch (e) {
        this.err(/fetch|network|Failed to fetch|import/i.test(String(e)) ? 'Não consegui baixar o reconhecimento de voz. Verifique sua internet e tente de novo.' : 'Não consegui entender o áudio. Tente de novo.');
      } finally { this.busy = false; }
    };

    mr.start(250);
    this.setListening(true);
    this.status('<span class="voice-on">● Gravando…</span> fale seus ingredientes. Toque no microfone para terminar.');

    // Detecta voz/silêncio pelo volume: depois de falar, 1,8 s de silêncio encerra
    meter = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
      if (rms > 0.02) { spoke = true; lastVoice = performance.now(); }
      else if (spoke && performance.now() - lastVoice > SILENCE_MS) finish();
    }, 100);
    maxTimer = setTimeout(finish, MAX_REC_MS);
  },

  // Converte o áudio gravado para 16 kHz mono (formato que o Whisper espera)
  async decode(blob) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    try {
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
      return audio.getChannelData(0);
    } finally { ctx.close(); }
  },
  // Limpa marcações que o Whisper às vezes devolve ("[música]", "(silêncio)")
  clean(t) { return String(t || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); },
};

micBtn.setAttribute('aria-pressed', 'false');
micBtn.addEventListener('click', () => Voice.toggle());

// Avisa logo de cara se a voz não vai funcionar neste endereço
(() => { const p = Voice.problem(); if (p) Voice.status(`<span class="voice-err">⚠ ${esc(p)}</span>`); })();
