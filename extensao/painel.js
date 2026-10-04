// Painel flutuante do ACV sobre a página da plataforma.
//
// Por que um painel na própria página e não só o popup da barra: a candidatura acontece aqui, e o que você
// precisa ver (a vaga, o contador do dia, o motivo de uma vaga ter sido pulada) é sobre a vaga que está na
// tela. Fica dentro de um shadow DOM: nem o CSS do site entra, nem o nosso vaza para ele.
//
// Ele decide SE deve aparecer mais de uma vez, conforme a página se monta: site de vaga é aplicativo de uma
// página só e no `document_idle` a tela quase sempre ainda está vazia. Decidindo uma vez só, ele simplesmente
// não aparecia no InHire.
//
// O que mudou na remodelagem de 04/10:
//  - o estilo deixou de ser uma string de CSS aqui dentro (que criou uma paleta paralela à do app) e passa a
//    ser as mesmas folhas de ui/, adotadas pelo shadow root ANTES de o painel entrar na página;
//  - o rótulo do botão saiu de um ternário de cinco ramos e virou `ACVAcao.decidir`, que é testado;
//  - o painel se anuncia (`role`, `aria-label`, cabeçalho de verdade) e o diário virou `role="log"`;
//  - `✕` esconde em vez de destruir: antes só voltava recarregando a página.
(() => {
  if (!globalThis.ACVMotor) return;
  const { handlerDe, pareceVaga } = globalThis.ACVExtensao;
  const { empresaBloqueada, montarUrlBuscaLinkedIn, RESTRICAO } = globalThis.ACVComum;
  const { classificar } = globalThis.ACVPlataformas;
  const { decidir } = globalThis.ACVAcao;
  const aoFundo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));

  const handler = handlerDe(location.hostname);
  const dominio = location.hostname.replace(/^www\./, '');
  const MAX_TENTATIVAS = 30;

  let plataformas = [];
  let sitio = null;
  let tentativas = 0;
  let ocupado = false;
  let escondido = false;
  let raiz = null;
  let hospedeiro = null;
  let orbeCta = null;
  let orbeTrabalho = null;

  /**
   * Este site é um que o ACV sabe trabalhar? A lista vem do núcleo — a extensão não guarda mais a própria.
   * Em site desconhecido o painel ainda aparece se a página for uma vaga, para oferecer o modo genérico.
   */
  async function devoAparecer() {
    if (!plataformas.length) plataformas = (await aoFundo({ tipo: 'PLATAFORMAS' }))?.plataformas ?? [];
    sitio = classificar(location.hostname, { plataformas, pareceVaga: pareceVaga() });
    return !!sitio;
  }

  const $ = id => raiz.getElementById(id);

  /** Um passo no diário. `tom` pinta a severidade — antes tudo saía cinza, inclusive "Erro:". */
  function registrar(texto, tom = '') {
    if (!raiz) return;
    const lista = $('log');
    lista.hidden = false;
    const li = document.createElement('li');
    li.className = tom;
    li.textContent = String(texto);
    lista.appendChild(li);
    while (lista.children.length > 14) lista.removeChild(lista.firstChild);
    lista.scrollTop = lista.scrollHeight;
  }

  const pilula = (texto, tom = 'neutra') => `<span class="pilula pilula-${tom}">${texto}</span>`;

  async function pintar() {
    if (!raiz || escondido) return;
    const st = await aoFundo({ tipo: 'STATUS' });
    const cota = await aoFundo({ tipo: 'CABEM', dominio });
    const empresa = handler.empresaDaVaga?.() ?? '';
    const titulo = handler.tituloDaVaga?.() ?? '';
    const bloqueada = empresa ? empresaBloqueada(empresa, st?.cfg?.empresasBloqueadas ?? []) : null;
    const restrita = RESTRICAO.test(document.body.innerText.slice(0, 1200));
    const temVaga = !!titulo && pareceVaga();

    $('contextoNome').textContent = sitio?.nome ?? dominio;
    $('contextoPilula').innerHTML = sitio ? pilula(sitio.pilula, sitio.tom) : '';
    $('vaga').textContent = temVaga ? titulo : 'Nenhuma vaga nesta página';
    $('empresa').textContent = temVaga ? empresa : '';
    $('empresa').hidden = !empresa || !temVaga;
    $('vazio').hidden = temVaga;

    $('etiquetas').innerHTML = [
      st?.sincronizado ? pilula('ACV conectado', 'ok') : pilula('operando em cache', 'atencao'),
      st?.cfg?.iaAtiva ? pilula('IA ativa', 'info') : '',
      pilula(`${cota?.feitasHoje ?? 0} de ${cota?.limite ?? 0} hoje`, cota?.cabem ? 'neutra' : 'erro'),
      cota?.aquecendo ? pilula('aquecendo', 'atencao') : '',
      st?.pendentes ? pilula(`${st.pendentes} p/ sincronizar`, 'atencao') : '',
      bloqueada ? pilula('empresa bloqueada', 'erro') : '',
    ].join('');

    const { principal, alternativa, motivo } = decidir({ ocupado, sincronizado: st?.sincronizado, temVaga, bloqueada, cota, sitio, restrita });

    const b = $('acaoPrincipal');
    b.dataset.acao = principal.id;
    b.disabled = principal.desabilitado;
    b.className = `btn btn-lg btn-largo btn-${principal.variante}`;
    b.textContent = principal.rotulo;
    if (principal.orbe) {
      if (!orbeCta) {
        orbeCta = globalThis.ACVOrbe.criar({ estado: principal.orbe, tamanho: 20, documento: document });
        b.prepend(orbeCta.el);
      } else orbeCta.estado(principal.orbe);
    } else if (orbeCta) {
      orbeCta.destruir();
      orbeCta.el.remove();
      orbeCta = null;
    }

    const alt = $('acaoAlternativa');
    alt.hidden = !alternativa;
    if (alternativa) {
      alt.dataset.acao = alternativa.id;
      alt.textContent = alternativa.rotulo;
    }

    $('motivo').textContent = motivo;
    $('motivo').hidden = !motivo;
    $('trabalhando').hidden = !ocupado;
    $('trabalhandoTexto').textContent = ocupado ? `Trabalhando em "${titulo.slice(0, 48)}"` : '';
    $('avisoConta').hidden = !/linkedin/.test(dominio);
  }

  // ─── As ações, uma função por id devolvido por `decidir` ─────────────────────────────────────
  const ACOES = {
    async nucleo() {
      registrar(`Mandando para o ACV (${sitio?.nome ?? 'adapter'})`);
      // Leva a pessoa para a tela do ACV antes de começar: é lá que o trabalho aparece acontecendo, e sem
      // isso o clique parece não ter feito nada (ainda mais com o app num navegador e a extensão em outro)
      const aba = await aoFundo({ tipo: 'ABRIR_APP' });
      registrar(
        aba?.ok ? (aba.reaproveitada ? 'Abri a aba do ACV que já estava aberta.' : 'Abri o ACV numa aba nova.') : 'Não consegui abrir a tela do ACV; acompanhe por ela mesmo assim.',
        aba?.ok ? '' : 'atencao',
      );
      const r = await aoFundo({ tipo: 'NUCLEO_CANDIDATAR', url: location.href });
      if (!r?.ok) registrar(`Não deu: ${r?.erro ?? 'o ACV não respondeu'}`, 'erro');
      else if (r.status === 'enviada') registrar(`Enviada pelo ACV: "${r.titulo}" (${r.empresa}), compatibilidade ${r.score}.`, 'ok');
      else if (r.status === 'ensaio') registrar('Modo ensaio ligado no ACV: ele preencheu tudo e NÃO enviou. Desligue o ensaio em Automação para valer.', 'atencao');
      else if (r.status === 'aguardando_pergunta') registrar(`A vaga fez uma pergunta nova${r.pergunta ? `: "${r.pergunta}"` : ''}. Responda no ACV e ela segue.`, 'atencao');
      else registrar(`Terminou como "${r.status}"${r.erro ? `: ${r.erro}` : ''}. Veja o log do ACV.`, 'atencao');
    },
    async extensao() {
      registrar('Iniciando a candidatura aqui mesmo');
      const r = await globalThis.ACVMotor.candidatar(registrar);
      if (r.status === 'enviada') {
        registrar('Candidatura enviada.', 'ok');
        if (r.espera) registrar(`Espere ~${Math.round(r.espera / 1000)} s antes da próxima.`);
      } else {
        registrar(`${r.status === 'pergunta' ? 'Parei nesta pergunta' : 'Não enviei'}: ${r.pergunta ? `"${r.pergunta}" — ` : ''}${r.motivo ?? ''}`, r.status === 'pergunta' ? 'atencao' : 'erro');
      }
    },
    async buscar() {
      if (!/linkedin/.test(dominio)) return registrar('A busca por critérios só está montada para o LinkedIn.', 'atencao');
      const st = await aoFundo({ tipo: 'STATUS' });
      location.href = montarUrlBuscaLinkedIn({ palavraChave: st?.cache?.perfil?.cargo ?? '', janelaTempo: 'semana', apenasCandidaturaSimplificada: true });
    },
    config: () => aoFundo({ tipo: 'ABRIR_OPCOES' }),
  };
  ACOES.generico = ACOES.extensao; // o modo genérico é o mesmo motor, só sem handler dedicado

  async function executar(id) {
    const acao = ACOES[id];
    if (!acao) return;
    if (id === 'config' || id === 'buscar') return acao();
    ocupado = true;
    await pintar();
    try {
      await acao();
    } catch (e) {
      registrar(`Erro: ${e.message}`, 'erro');
    } finally {
      ocupado = false;
      await pintar();
    }
  }

  async function montar() {
    hospedeiro = document.createElement('div');
    // Sem `id` nem `class`: era por `#acv-painel` que uma página podia nos achar e aplicar `display: none`.
    // `lang` explícito porque num site em inglês o leitor de tela leria a nossa cópia com pronúncia inglesa.
    hospedeiro.lang = 'pt-BR';
    hospedeiro.setAttribute('role', 'complementary');
    hospedeiro.setAttribute('aria-label', 'Painel do ACV');
    // `closed`: com `open`, um script da página alcança `.shadowRoot` e repinta o painel inteiro
    raiz = hospedeiro.attachShadow({ mode: 'closed' });
    raiz.adoptedStyleSheets = await globalThis.ACVTema.folhas();

    raiz.innerHTML = `
    <div class="caixa">
      <div class="topo">
        <span class="monograma" aria-hidden="true"></span>
        <h2>ACV</h2>
        <button id="recolher" type="button" aria-expanded="true" aria-controls="corpo" title="Recolher">—</button>
        <button id="esconder" type="button" title="Esconder nesta página">✕</button>
      </div>
      <div class="corpo" id="corpo">
        <p class="contexto"><strong id="contextoNome"></strong> <span id="contextoPilula"></span></p>

        <div id="vazio" class="vazio" hidden>
          <span class="marca" aria-hidden="true"></span>
          <span>Abra o anúncio de uma vaga e eu volto a falar.</span>
        </div>

        <h3 class="vaga" id="vaga"></h3>
        <p class="empresa" id="empresa"></p>
        <div class="etiquetas" id="etiquetas"></div>

        <div class="trabalhando" id="trabalhando" role="status" hidden><span id="trabalhandoTexto"></span></div>

        <button class="btn btn-lg btn-largo btn-primary" id="acaoPrincipal" type="button"></button>
        <p class="motivo" id="motivo" hidden></p>
        <button class="btn btn-largo btn-secondary" id="acaoAlternativa" type="button" hidden></button>

        <details id="avisoConta">
          <summary>Sobre automação no LinkedIn</summary>
          <p class="motivo">O LinkedIn proíbe automação no contrato de uso e pode suspender a conta de quem detecta. Uma vaga por clique, poucas por dia. O ACV não disfarça nada.</p>
        </details>

        <details id="guia">
          <summary>Como usar</summary>
          <ol>
            <li class="passo-guia">Entre na sua conta da plataforma normalmente.</li>
            <li class="passo-guia">Pesquise a vaga e ligue o filtro de candidatura simplificada.</li>
            <li class="passo-guia">Abra a vaga que você quer.</li>
            <li class="passo-guia">Confira os seus dados e clique no botão de candidatura.</li>
          </ol>
        </details>

        <ol class="log" id="log" role="log" aria-live="polite" aria-relevant="additions" hidden></ol>

        <div class="rodape">
          <button id="config" type="button">Configurações</button>
          <button id="abrirApp" type="button">Abrir o ACV</button>
        </div>
      </div>
    </div>`;

    // O orbe da faixa de trabalho nasce uma vez e fica
    orbeTrabalho = globalThis.ACVOrbe.criar({ estado: 'enviando', tamanho: 20, documento: document });
    $('trabalhando').prepend(orbeTrabalho.el);

    $('acaoPrincipal').addEventListener('click', e => executar(e.currentTarget.dataset.acao));
    $('acaoAlternativa').addEventListener('click', e => executar(e.currentTarget.dataset.acao));
    $('config').addEventListener('click', () => ACOES.config());
    $('abrirApp').addEventListener('click', () => aoFundo({ tipo: 'ABRIR_APP' }));

    $('recolher').addEventListener('click', () => {
      const c = $('corpo');
      c.hidden = !c.hidden;
      $('recolher').setAttribute('aria-expanded', String(!c.hidden));
      $('recolher').title = c.hidden ? 'Expandir' : 'Recolher';
    });

    // Esconder, não destruir. Antes o ✕ dava `remove()` no host e o painel só voltava recarregando a página.
    $('esconder').addEventListener('click', () => {
      escondido = true;
      hospedeiro.hidden = true;
      aoFundo({ tipo: 'ESCONDER_PAINEL', origem: location.origin });
    });

    // Escape recolhe (não esconde): fechar por tecla acidental um painel que a pessoa não escolheu abrir é
    // pior do que não fechar.
    raiz.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const c = $('corpo');
      if (c.hidden) return;
      c.hidden = true;
      $('recolher').setAttribute('aria-expanded', 'false');
    });

    // Só entra na página DEPOIS de estilo adotado e conteúdo montado: nunca um quadro sem estilo
    document.documentElement.appendChild(hospedeiro);
    await pintar();

    // Lista de vagas troca de vaga sem recarregar a página: o painel acompanha
    let ultima = location.href;
    setInterval(() => {
      if (location.href === ultima) return;
      ultima = location.href;
      pintar();
    }, 1500);
  }

  async function tentar() {
    if (hospedeiro?.isConnected || ++tentativas > MAX_TENTATIVAS) return;
    if ((await aoFundo({ tipo: 'PAINEL_ESCONDIDO', origem: location.origin }))?.escondido) return;
    if (await devoAparecer()) await montar();
  }

  let agendado = null;
  const agendar = () => {
    clearTimeout(agendado);
    agendado = setTimeout(tentar, 800);
  };
  tentar();
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
})();
