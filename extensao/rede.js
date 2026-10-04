// Prova de envio pela REDE, não pelo texto da tela (invariante 1 do ACV: "sucesso é a resposta HTTP").
//
// Roda no mundo da própria página (`"world": "MAIN"` no manifest) porque só lá dá para enxergar o `fetch` e o
// `XMLHttpRequest` que a plataforma usa. Ele não lê corpo de requisição, não guarda nada e não manda nada para
// fora: só avisa "saiu um POST para tal caminho e voltou tal status", via evento no DOM, para o content script
// decidir se a candidatura foi mesmo aceita.
(() => {
  if (window.__acvRede) return;
  window.__acvRede = true;

  const avisar = (metodo, url, status) => {
    try {
      window.dispatchEvent(new CustomEvent('acv-rede', { detail: { metodo, url: String(url).slice(0, 300), status, em: Date.now() } }));
    } catch {
      // página com CSP estranha: sem prova de rede, o motor cai na confirmação da tela e diz isso no log
    }
  };

  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    const metodo = (args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase();
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
    try {
      const r = await fetchOriginal.apply(this, args);
      avisar(metodo, url, r.status);
      return r;
    } catch (e) {
      avisar(metodo, url, 0);
      throw e;
    }
  };

  const abrir = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
    this.__acv = { metodo: String(metodo).toUpperCase(), url };
    this.addEventListener('loadend', () => avisar(this.__acv.metodo, this.__acv.url, this.status));
    return abrir.call(this, metodo, url, ...resto);
  };
})();
