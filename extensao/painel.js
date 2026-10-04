// Painel flutuante do ACV sobre a página da plataforma.
//
// Por que um painel na própria página e não só o popup da barra: a candidatura acontece aqui, e o que você
// precisa ver (a vaga, o contador do dia, o motivo de uma vaga ter sido pulada) é sobre a vaga que está na tela.
// Fica dentro de um shadow DOM: nem o CSS do site entra, nem o nosso vaza para ele.
//
// Ele decide SE deve aparecer mais de uma vez, conforme a página se monta: site de vaga é aplicativo de uma
// página só e no `document_idle` a tela quase sempre ainda está vazia. Decidindo uma vez só, ele simplesmente
// não aparecia no InHire.
(() => {
  if (!globalThis.ACVMotor) return;
  const { handlerDe, pareceVaga } = globalThis.ACVExtensao;
  const { empresaBloqueada, montarUrlBuscaLinkedIn } = globalThis.ACVComum;
  const aoFundo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));

  const handler = handlerDe(location.hostname);
  // Plataformas que a própria extensão atende (candidatura aqui mesmo, com o motor dela)
  const PLATAFORMAS_COM_PAINEL = ['linkedin.com', 'indeed.com', 'gupy.io'];
  const dominio = location.hostname.replace(/^www\./, '');
  const bate = d => dominio === d || dominio.endsWith(`.${d}`);
  const MAX_TENTATIVAS = 30;

  let doNucleo = null;
  let tentativas = 0;
  let ocupado = false;
  let raiz = null;

  /**
   * Este site é um dos que o ACV já sabe candidatar sozinho (InHire, Vagas PJ, Divulga Vagas...)? Então o
   * caminho bom não é o motor daqui: é mandar a URL para o núcleo e deixar o adapter dele trabalhar — ele tem
   * schema da API, adaptação de currículo, modo ensaio e prova de envio. A lista vem do próprio núcleo.
   */
  async function devoAparecer() {
    if (PLATAFORMAS_COM_PAINEL.some(bate)) return true;
    if (!doNucleo) {
      const { plataformas = [] } = (await aoFundo({ tipo: 'PLATAFORMAS' })) ?? {};
      doNucleo = plataformas.find(p => (p.dominios ?? []).some(bate)) ?? null;
    }
    return !!doNucleo || pareceVaga();
  }

  const CSS = `
  :host { all: initial; }
  .caixa { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 320px; max-height: 80vh; overflow:auto;
           font: 13px/1.45 system-ui, sans-serif; color: #1b1b1f; background: #fff; border: 1px solid #c9c9d1;
           border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
  .topo { display:flex; align-items:center; gap:8px; padding:10px 12px; background:#1b3a8f; color:#fff; border-radius:11px 11px 0 0; }
  .topo strong { font-size:13px; flex:1; }
  .topo button { background:transparent; border:1px solid rgba(255,255,255,.45); color:#fff; border-radius:6px; cursor:pointer; font:inherit; padding:1px 7px; }
  .corpo { padding:12px; display:flex; flex-direction:column; gap:10px; }
  .vaga { font-weight:700; }
  .cinza { color:#55555f; font-size:12px; }
  button.acao { width:100%; padding:10px; border-radius:8px; border:0; background:#17683a; color:#fff; font:inherit; font-weight:700; cursor:pointer; }
  button.acao:disabled { background:#c9c9d1; color:#55555f; cursor:not-allowed; }
  button.secundaria { background:#fff; color:#1b1b1f; border:1px solid #c9c9d1; font-weight:600; }
  ol { margin:0; padding-left:18px; } ol li { margin-bottom:3px; font-size:12px; color:#55555f; }
  .etiquetas { display:flex; flex-wrap:wrap; gap:6px; }
  .etiqueta { border:1px solid #c9c9d1; border-radius:9px; padding:1px 7px; font-size:11px; font-weight:700; }
  .ok { background:#e6f4ec; border-color:#17683a; color:#17683a; }
  .atencao { background:#fdf3e2; border-color:#a86a00; color:#a86a00; }
  .erro { background:#fdecea; border-color:#a03000; color:#a03000; }
  .log { background:#f6f6f8; border:1px solid #e3e3e8; border-radius:8px; padding:8px; max-height:140px; overflow:auto;
         font:11px/1.4 ui-monospace, monospace; white-space:pre-wrap; }
  .aviso { background:#fdf3e2; border:1px solid #a86a00; color:#7a4d00; border-radius:8px; padding:8px; font-size:11px; }
  .trabalhando { display:flex; align-items:center; gap:8px; background:#eef2fb; border:1px solid #1b3a8f; color:#1b3a8f;
                 border-radius:8px; padding:8px; font-size:12px; font-weight:600; }
  .giro { width:14px; height:14px; flex:0 0 auto; border:2px solid #1b3a8f; border-top-color:transparent; border-radius:50%;
          animation: girar .8s linear infinite; }
  @keyframes girar { to { transform: rotate(360deg); } }`;

  const $ = id => raiz.getElementById(id);
  const registrar = msg => {
    const l = $('log');
    l.hidden = false;
    l.textContent += `${msg}\n`;
    l.scrollTop = l.scrollHeight;
  };
  const etiqueta = (texto, classe = '') => `<span class="etiqueta ${classe}">${texto}</span>`;

  async function pintar() {
    const empresa = handler.empresaDaVaga?.() ?? '';
    const titulo = handler.tituloDaVaga?.() ?? '';
    $('trabalhando').hidden = !ocupado;
    if (ocupado) $('trabalhandoTexto').textContent = `O ACV está trabalhando em "${(titulo || 'esta vaga').slice(0, 60)}". Acompanhe na aba dele.`;
    $('vaga').textContent = titulo ? `${titulo}${empresa ? ` — ${empresa}` : ''}` : 'Abra uma vaga para começar';
    const st = await aoFundo({ tipo: 'STATUS' });
    const cota = await aoFundo({ tipo: 'CABEM', dominio });
    const bloqueada = empresaBloqueada(empresa, st?.cfg?.empresasBloqueadas);
    $('avisoConta').hidden = !/linkedin/.test(dominio);
    $('etiquetas').innerHTML = [
      etiqueta(st?.sincronizado ? 'ACV conectado' : 'operando em cache', st?.sincronizado ? 'ok' : 'atencao'),
      etiqueta(st?.cfg?.iaAtiva ? 'IA ativa' : 'IA desligada', st?.cfg?.iaAtiva ? 'ok' : ''),
      etiqueta(`${cota?.feitasHoje ?? 0} de ${cota?.limite ?? 0} hoje`, cota?.cabem ? '' : 'erro'),
      cota?.aquecendo ? etiqueta('aquecendo', 'atencao') : '',
      st?.pendentes ? etiqueta(`${st.pendentes} p/ sincronizar`, 'atencao') : '',
      bloqueada ? etiqueta('empresa bloqueada', 'erro') : '',
    ].join('');

    // Em plataforma do núcleo, o motor de lá é o principal e o daqui vira alternativa
    $('nucleo').hidden = !doNucleo;
    $('explicaNucleo').hidden = !doNucleo;
    if (doNucleo) {
      $('explicaNucleo').textContent = `O ACV tem adapter próprio para ${doNucleo.nome}: ele adapta o currículo, respeita o modo ensaio e confirma o envio pela resposta do servidor.`;
      $('candidatar').classList.add('secundaria');
      $('nucleo').disabled = ocupado || !st?.sincronizado;
      $('nucleo').textContent = ocupado ? 'Conectando à vaga no ACV...' : st?.sincronizado ? `Candidatar pelo ACV (${doNucleo.nome})` : 'Abra o ACV para candidatar por ele';
    }

    const b = $('candidatar');
    b.disabled = ocupado || !!bloqueada || !cota?.cabem;
    b.textContent = ocupado
      ? 'Candidatando...'
      : bloqueada
        ? `Bloqueada: ${bloqueada}`
        : !cota?.cabem
          ? 'Limite de hoje alcançado'
          : doNucleo
            ? 'Candidatar aqui mesmo (motor da extensão)'
            : 'Iniciar candidatura';
  }

  function montar() {
    const hospedeiro = document.createElement('div');
    hospedeiro.id = 'acv-painel';
    raiz = hospedeiro.attachShadow({ mode: 'open' });
    raiz.innerHTML = `<style>${CSS}</style>
    <div class="caixa">
      <div class="topo"><strong>ACV</strong><button id="recolher" title="Recolher">—</button><button id="fechar" title="Fechar">✕</button></div>
      <div class="corpo" id="corpo">
        <div id="guia">
          <p class="cinza"><b>Como usar</b></p>
          <ol>
            <li>Entre na sua conta da plataforma normalmente.</li>
            <li>Pesquise a vaga e ligue o filtro de candidatura simplificada.</li>
            <li>Abra a vaga que você quer.</li>
            <li>Confira os seus dados e clique no botão de candidatura.</li>
          </ol>
          <button class="acao secundaria" id="ocultarGuia">Entendi, ocultar</button>
        </div>
        <div class="aviso" id="avisoConta">O LinkedIn proíbe automação no contrato de uso e pode suspender a conta de quem detecta. Use com parcimônia: uma vaga por clique, poucas por dia. O ACV não disfarça nada.</div>
        <p class="vaga" id="vaga">—</p>
        <div class="etiquetas" id="etiquetas"></div>
        <div class="trabalhando" id="trabalhando" hidden><span class="giro"></span><span id="trabalhandoTexto"></span></div>
        <button class="acao" id="nucleo" hidden>Candidatar pelo ACV</button>
        <p class="cinza" id="explicaNucleo" hidden></p>
        <button class="acao" id="candidatar">Iniciar candidatura</button>
        <button class="acao secundaria" id="buscar">Buscar vagas com meus critérios</button>
        <button class="acao secundaria" id="config">Configurações</button>
        <div class="log" id="log" hidden></div>
      </div>
    </div>`;
    document.documentElement.appendChild(hospedeiro);

    // Candidatura pelo NÚCLEO: o adapter testado do ACV, na vaga que está aberta aqui
    $('nucleo').addEventListener('click', async () => {
      ocupado = true;
      await pintar();
      registrar(`— mandando para o ACV (${doNucleo.nome}) —`);
      try {
        // Leva a pessoa para a tela do ACV antes de começar: é lá que o trabalho aparece acontecendo, e sem
        // isso o clique parece não ter feito nada (ainda mais com o app num navegador e a extensão em outro)
        const aba = await aoFundo({ tipo: 'ABRIR_APP' });
        registrar(aba?.ok ? (aba.reaproveitada ? 'Abri a aba do ACV que já estava aberta.' : 'Abri o ACV numa aba nova.') : 'Não consegui abrir a tela do ACV; acompanhe por ela mesmo assim.');
        const r = await aoFundo({ tipo: 'NUCLEO_CANDIDATAR', url: location.href });
        if (!r?.ok) registrar(`Não deu: ${r?.erro ?? 'o ACV não respondeu'}`);
        else if (r.status === 'enviada') registrar(`✓ Enviada pelo ACV: "${r.titulo}" (${r.empresa}), compatibilidade ${r.score}.`);
        else if (r.status === 'ensaio') registrar('Modo ensaio ligado no ACV: ele preencheu tudo e NÃO enviou. Desligue o ensaio em Automação para valer.');
        else if (r.status === 'aguardando_pergunta') registrar(`A vaga fez uma pergunta nova${r.pergunta ? `: "${r.pergunta}"` : ''}. Responda no ACV e ela segue.`);
        else registrar(`Terminou como "${r.status}"${r.erro ? `: ${r.erro}` : ''}. Veja o log do ACV.`);
      } catch (e) {
        registrar(`Erro: ${e.message}`);
      } finally {
        ocupado = false;
        await pintar();
      }
    });

    // Candidatura com o motor da própria extensão (plataforma sem adapter no núcleo)
    $('candidatar').addEventListener('click', async () => {
      ocupado = true;
      await pintar();
      registrar('— iniciando —');
      try {
        const r = await globalThis.ACVMotor.candidatar(registrar);
        registrar(r.status === 'enviada' ? '✓ Candidatura enviada.' : `${r.status === 'pergunta' ? 'Parei nesta pergunta' : 'Não enviei'}: ${r.pergunta ? `"${r.pergunta}" — ` : ''}${r.motivo ?? ''}`);
        if (r.status === 'enviada' && r.espera) registrar(`Espere ~${Math.round(r.espera / 1000)} s antes da próxima.`);
      } catch (e) {
        registrar(`Erro: ${e.message}`);
      } finally {
        ocupado = false;
        await pintar();
      }
    });

    $('buscar').addEventListener('click', async () => {
      if (!/linkedin/.test(dominio)) return registrar('A busca por critérios só está montada para o LinkedIn.');
      const st = await aoFundo({ tipo: 'STATUS' });
      location.href = montarUrlBuscaLinkedIn({ palavraChave: st?.cache?.perfil?.cargo ?? '', janelaTempo: 'semana', apenasCandidaturaSimplificada: true });
    });

    $('config').addEventListener('click', () => aoFundo({ tipo: 'ABRIR_OPCOES' }));
    $('fechar').addEventListener('click', () => hospedeiro.remove());
    $('recolher').addEventListener('click', () => {
      const c = $('corpo');
      c.hidden = !c.hidden;
    });
    $('ocultarGuia').addEventListener('click', () => {
      $('guia').hidden = true;
      chrome.storage.local.set({ guiaVisto: true });
    });
    chrome.storage.local.get('guiaVisto').then(({ guiaVisto }) => {
      if (guiaVisto) $('guia').hidden = true;
    });

    pintar();
    // Lista de vagas troca de vaga sem recarregar a página: o painel acompanha
    let ultima = location.href;
    setInterval(() => {
      if (location.href === ultima) return;
      ultima = location.href;
      pintar();
    }, 1500);
  }

  async function tentar() {
    if (document.getElementById('acv-painel') || ++tentativas > MAX_TENTATIVAS) return;
    if (await devoAparecer()) montar();
  }

  let agendado = null;
  const agendar = () => {
    clearTimeout(agendado);
    agendado = setTimeout(tentar, 800);
  };
  tentar();
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
})();
