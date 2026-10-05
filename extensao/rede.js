// Prova de envio pela REDE, não pelo texto da tela (invariante 1 do ACV: "sucesso é a resposta HTTP").
//
// Roda no mundo da própria página (`"world": "MAIN"` no manifest) porque só lá dá para enxergar o `fetch` e o
// `XMLHttpRequest` que a plataforma usa. Ele não lê corpo de requisição, não guarda nada e não manda nada para
// fora: só avisa "saiu um POST para tal caminho e voltou tal status", via evento no DOM, para o content script
// decidir se a candidatura foi mesmo aceita.
//
// ─── Ensaio ─────────────────────────────────────────────────────────────────────────────────────
//
// No modo ensaio o núcleo aborta as rotas de envio no navegador do robô (invariante 5). Aqui não existe
// `page.route`, e o motor não pode simplesmente evitar o clique: formulário que abre por botão de JavaScript
// (LinkedIn, e metade dos sites) só revela os campos DEPOIS do clique — recusando o clique, o ensaio nunca
// mostraria um formulário preenchido, que é a única coisa que ele existe para mostrar.
//
// Então o corte é no mesmo lugar que o do núcleo: na rede, por MÉTODO. Enquanto o ensaio está armado, nada que
// ESCREVE sai desta página — POST, PUT e PATCH são recusados antes de chegar ao servidor, e GET passa inteiro.
// A lição do InHire (23/09/2026) é exatamente essa: cortar por caminho derrubava as LEITURAS que o
// questionário faz para se montar, e o ensaio ficava eternamente em branco. Método é o critério que separa
// "ler a página" de "criar a candidatura".
//
// Uma escrita recusada é informação, não acidente: ela é a resposta para "por onde isso teria enviado?" — a
// pergunta que eu preciso responder para escrever o adapter de uma plataforma nova. Por isso ela é avisada com
// `bloqueado: true` em vez de sumir.
(() => {
  if (window.__acvRede) return;
  window.__acvRede = true;

  let ensaio = false;
  const ESCRITA = /^(POST|PUT|PATCH|DELETE)$/;
  // O content script arma e desarma; só ele fala neste evento, e ele só existe enquanto a tentativa dura
  window.addEventListener('acv-ensaio', e => {
    ensaio = e.detail?.armado === true;
  });
  const barrar = metodo => ensaio && ESCRITA.test(metodo);

  const avisar = (metodo, url, status, bloqueado = false) => {
    try {
      window.dispatchEvent(new CustomEvent('acv-rede', { detail: { metodo, url: String(url).slice(0, 300), status, bloqueado, em: Date.now() } }));
    } catch {
      // página com CSP estranha: sem prova de rede, o motor cai na confirmação da tela e diz isso no log
    }
  };

  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    const metodo = (args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase();
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
    if (barrar(metodo)) {
      avisar(metodo, url, 0, true);
      // 409: a página vê uma recusa do servidor, que é o que o ensaio quer encenar — e não um erro de rede,
      // que muita plataforma trata tentando de novo em seguida
      return new Response('{"acv":"ensaio: envio bloqueado pelo ACV"}', { status: 409, headers: { 'content-type': 'application/json' } });
    }
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

  const enviar = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (barrar(this.__acv?.metodo ?? 'GET')) {
      avisar(this.__acv.metodo, this.__acv.url, 0, true);
      return; // nunca chama o send original: a requisição não existe
    }
    return enviar.apply(this, args);
  };

  /**
   * Envio por `<form method="post">`, que não passa por fetch nem por XHR.
   *
   * É o caminho da candidatura de um clique — exatamente o que `reconhecerEnvio` chama de `clicarEnvia: 'sim'`.
   * Sem isto o ensaio deixaria passar justamente o caso mais direto de todos.
   */
  addEventListener(
    'submit',
    e => {
      const metodo = String(e.target?.getAttribute?.('method') ?? 'get').toUpperCase();
      if (!barrar(metodo)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      avisar(metodo, e.target?.getAttribute?.('action') ?? location.href, 0, true);
    },
    true,
  );
})();
