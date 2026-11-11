// Aplica o tema antes de desenhar a página (evita "piscar" claro → escuro).
// Ordem: escolha salva pelo usuário → preferência do sistema → claro.
(function () {
  let t = null;
  try { t = localStorage.getItem('nr:theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
})();
