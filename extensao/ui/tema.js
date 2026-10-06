// Entrega as folhas de estilo do ACV para o shadow root do painel.
//
// Por que `adoptedStyleSheets` e não um `<link>` dentro do shadow root: o `<link>` funciona, mas aplica de
// forma assíncrona e invisível — não dá para esperar por ele sem `onload`, e nesse intervalo o painel já
// está no DOM da página sem estilo nenhum. Com folhas construídas, o painel só entra na página DEPOIS de
// adotá-las. E por que não a string de CSS embutida no JS, que era o jeito antigo: foi exatamente ela que
// criou a paleta paralela que esta remodelagem veio consertar. Duplicação de CSS não é risco teórico aqui.
//
// As folhas são buscadas uma vez por aba e ficam memoizadas: o painel remonta em site de uma página só.
(() => {
  const ARQUIVOS = ['ui/tokens.css', 'ui/marca.css', 'ui/base.css', 'ui/painel.css'];

  /**
   * Folha de emergência, síncrona.
   *
   * Se o `fetch` falhar — `web_accessible_resources` mal declarado, extensão recarregando no meio —, o painel
   * fica feio, não quebrado. Prefiro um retângulo branco legível a uma pilha de texto sem estilo sobre a
   * página de alguém.
   */
  function emergencia() {
    const f = new CSSStyleSheet();
    f.replaceSync(`
      :host { all: initial; display: block !important; position: fixed !important;
              inset: auto 16px 16px auto !important; z-index: 2147483000 !important; width: 340px !important; }
      .caixa { border: 1px solid #c3c9d1; border-radius: 10px; background: #fff; color: #333;
               font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 10px 34px rgb(0 0 0 / 18%); }
      .topo { display: flex; align-items: center; gap: 8px; height: 35px; padding: 0 12px;
              background: #1a6dc4; color: #fff; }
      .corpo { display: flex; flex-direction: column; gap: 10px; padding: 12px; }
      :host([hidden]) { display: none !important; }
      [hidden] { display: none; }
    `);
    return f;
  }

  let promessa = null;

  async function folhas() {
    if (promessa) return promessa;
    promessa = (async () => {
      try {
        const textos = await Promise.all(ARQUIVOS.map(async a => (await fetch(chrome.runtime.getURL(a))).text()));
        return textos.map(t => {
          const f = new CSSStyleSheet();
          f.replaceSync(t);
          return f;
        });
      } catch {
        return [emergencia()];
      }
    })();
    return promessa;
  }

  globalThis.ACVTema = { folhas, emergencia };
})();
