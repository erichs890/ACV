// "Este site aqui, o ACV sabe trabalhar nele?" — e o catálogo de todos os que sabe.
//
// A lista vem do núcleo (`GET /extensao/plataformas`, que serve `DOMINIOS` de core/importar.ts). Antes a
// extensão guardava as próprias listas paralelas e nenhuma consultava aquela; um site podia estar em três
// delas e faltar na quarta sem ninguém perceber.
//
// Módulo PURO de propósito: nada de `chrome`, `document` ou `fetch` aqui dentro. É o que permite rodá-lo no
// sandbox do core/extensao-check.ts, que é onde estas regras ganham teste.
(() => {
  /**
   * Os três níveis, na ordem em que o painel deve preferi-los.
   *
   * `nucleo` ganha de `extensao` quando os dois servem (é o caso do Indeed): o adapter do núcleo adapta o
   * currículo, respeita o modo ensaio e confirma o envio pela resposta do servidor — o motor da extensão não
   * faz nada disso.
   */
  const NIVEIS = {
    nucleo: {
      pilula: 'adapter testado',
      tom: 'ok',
      nota: 'O ACV candidata por você: adapta o currículo, respeita o modo ensaio e confirma o envio pela resposta do servidor.',
    },
    extensao: {
      pilula: 'motor da extensão',
      tom: 'info',
      nota: 'A candidatura acontece aqui mesmo, no seu navegador, sem precisar do ACV aberto.',
    },
    generico: {
      pilula: 'modo genérico',
      tom: 'neutra',
      nota: 'Não conheço este site. Posso tentar: leio o formulário, preencho o que já sei de você e paro na primeira pergunta que não souber responder.',
    },
  };

  const semWww = h =>
    String(h ?? '')
      .replace(/^www\./, '')
      .toLowerCase();
  const bate = (host, dominio) => host === dominio || host.endsWith(`.${dominio}`);

  /** A plataforma da lista que atende este host, ou null. */
  const daLista = (host, plataformas) => (plataformas ?? []).find(p => (p.dominios ?? []).some(d => bate(host, semWww(d)))) ?? null;

  /**
   * O que o painel e o popup mostram para o site aberto agora.
   *
   * `pareceVaga` entra porque em site desconhecido só faz sentido oferecer o modo genérico se a página for
   * mesmo uma vaga — caso contrário não há o que automatizar e o certo é não aparecer.
   */
  function classificar(host, { plataformas = [], pareceVaga = false } = {}) {
    const h = semWww(host);
    const p = daLista(h, plataformas);
    if (!p) return pareceVaga ? { nivel: 'generico', nome: h, ...NIVEIS.generico } : null;

    // `motor: 'ambos'` (Indeed) vale como núcleo, que é o caminho melhor — mas a nota conta que há dois.
    const nivel = p.motor === 'extensao' ? 'extensao' : 'nucleo';
    const dois = p.motor === 'ambos';
    return {
      nivel,
      nome: p.nome ?? h,
      id: p.id,
      importa: !!p.importa,
      conectada: p.conectada !== false,
      dois,
      ...NIVEIS[nivel],
      nota: dois ? `${NIVEIS.nucleo.nota} Aqui também dá pelo motor da extensão, se você preferir.` : NIVEIS[nivel].nota,
    };
  }

  /**
   * A lista inteira, para a página de opções. Ordenada por nível e nome, com as ressalvas que explicam ANTES
   * do clique o que hoje só se descobre pelo erro.
   */
  function catalogo({ plataformas = [] } = {}) {
    const ordem = { nucleo: 0, extensao: 1 };
    return (plataformas ?? [])
      .map(p => {
        const nivel = p.motor === 'extensao' ? 'extensao' : 'nucleo';
        const avisos = [];
        // `importa: false` é o motivo do erro "ainda não está na lista" que hoje só aparece depois do clique
        if (nivel === 'nucleo') avisos.push(p.importa ? { texto: 'qualquer vaga', tom: 'neutra' } : { texto: 'vagas já varridas', tom: 'neutra' });
        if (p.conectada === false) avisos.push({ texto: 'conta não ligada', tom: 'atencao' });
        if (p.motor === 'ambos') avisos.push({ texto: 'dois caminhos', tom: 'neutra' });
        return { id: p.id, nome: p.nome ?? p.id, dominios: p.dominios ?? [], nivel, avisos, ...NIVEIS[nivel] };
      })
      .sort((a, b) => ordem[a.nivel] - ordem[b.nivel] || a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  const api = { classificar, catalogo, NIVEIS, semWww };
  globalThis.ACVPlataformas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // core/extensao-check.ts roda isto em Node
})();
