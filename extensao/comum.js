// Configuração e regras que a extensão usa sozinha, SEM depender do ACV aberto.
//
// Este arquivo é carregado tanto pelos content scripts quanto pelas telas (popup e Configurações), e é puro o
// suficiente para rodar fora do navegador — `core/extensao-check.ts` o executa em Node para testar as regras.
//
// Divisão de donos (a mesma ideia de "uma fonte por campo" do núcleo):
//   - leve e necessário para operar sozinha (perfil do LinkedIn, pretensão, anos, empresas bloqueadas, ritmo,
//     limites, se a IA pode ser usada) → mora AQUI, em chrome.storage.local;
//   - pesado e que envelhece (currículo em PDF, respostas salvas, histórico) → o dono é o núcleo; a extensão
//     guarda uma CÓPIA em cache e diz na tela quando está operando por ela.
(() => {
  const PADRAO = {
    linkedinPerfilUrl: '',
    pretensaoSalarial: 0,
    anosExperiencia: 0,
    empresasBloqueadas: [],
    iaAtiva: false, // só tem efeito com o ACV aberto: é lá que a IA roda, com as travas dela
    /**
     * O painel aparece sobre as páginas?
     *
     * O `✕` esconde num site só, e só até fechar o navegador — é o "agora não". Isto é o interruptor:
     * desligado, o painel não se monta em lugar nenhum, e a extensão continua inteira pelo ícone da barra
     * (diagnóstico da página, contador do dia, sincronizar, candidatar). Existe porque painel sobreposto que
     * não sai do caminho é motivo para desinstalar a extensão, e desligar o que incomoda tem de ser mais
     * fácil do que isso.
     */
    painelLigado: true,
    // Um por plataforma SERVIDA à extensão (as que exigem conta — ver `plataformasConhecidas`). A chave
    // precisa existir para o limite aparecer na página de opções e poder ser ajustado; domínio ausente cai
    // em LIMITE_PADRAO e fica invisível. O ProgramaThor faltava aqui desde que entrou, em 04/10.
    limiteDiarioPorPlataforma: { 'linkedin.com': 10, 'indeed.com': 10, 'gupy.io': 10, 'programathor.com.br': 10, 'jobs.lever.co': 10, 'job-boards.greenhouse.io': 10, 'boards.greenhouse.io': 10 },
    urlApp: 'http://localhost:5173', // tela do ACV (o start.bat sobe nela); o núcleo em si fica na 4780
    intervaloMinSegundos: 45,
    intervaloMaxSegundos: 120,
  };

  const LIMITE_PADRAO = 10;
  const DIAS_DE_AQUECIMENTO = 3;
  const LIMITE_NO_AQUECIMENTO = 5;

  const semAcento = s => (s ?? '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '');

  /**
   * Nome de empresa comparável: sem acento, sem tipo societário e sem pontuação. "Acme S.A.", "ACME Ltda." e
   * "acme" têm de bater — senão a lista de bloqueio não serve para nada no mundo real.
   */
  const normalizarEmpresa = nome =>
    semAcento(nome)
      .toLowerCase()
      .replace(/[.,|/\\-]+/g, ' ')
      .replace(/\b(s\s?a|sa|ltda|me|eireli|epp|inc|llc|corp|corporation|co|company|group|grupo|holding|tecnologia|servicos|solucoes)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /**
   * A vaga é de uma empresa bloqueada? Compara pelo nome normalizado e também por conter o termo inteiro — quem
   * bloqueia "Acme" quer barrar "Acme Tecnologia do Brasil" também. Entrada vazia nunca bloqueia nada.
   */
  function empresaBloqueada(empresa, lista) {
    const alvo = normalizarEmpresa(empresa);
    if (!alvo) return null;
    for (const bruto of lista ?? []) {
      const b = normalizarEmpresa(bruto);
      if (!b) continue;
      if (alvo === b || new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(alvo)) return bruto;
    }
    return null;
  }

  // Janelas de data do LinkedIn: `f_TPR=r<segundos>` (604800 = última semana, confirmado por captura de tela)
  const JANELAS = { '24h': 86400, semana: 604800, mes: 2592000 };

  /**
   * Monta a URL de busca do LinkedIn já filtrada.
   *
   * Confirmados em uso real: `keywords`, `geoId`, `distance`, `f_AL=true` (Candidatura simplificada) e
   * `f_TPR=r<segundos>` (data do anúncio). Os demais abaixo foram lidos da própria interface do LinkedIn ao
   * aplicar o filtro à mão e NÃO foram verificados aqui — por isso só entram na URL quando pedidos:
   *   f_WT=1|2|3  → presencial | remoto | híbrido
   *   f_E=1..6    → nível de experiência (2 = júnior/iniciante, 3 = pleno)
   *   f_JT=F|P|C|T → tipo (integral, meio período, contrato, temporário)
   * Filtrar por "última semana" é recomendação de quem usa: vaga antiga costuma já ter candidato escolhido.
   */
  function montarUrlBuscaLinkedIn(filtros) {
    const p = new URLSearchParams({ keywords: filtros.palavraChave ?? '' });
    if (filtros.geoId) p.set('geoId', String(filtros.geoId));
    p.set('f_AL', filtros.apenasCandidaturaSimplificada === false ? 'false' : 'true');
    if (filtros.distanciaKm) p.set('distance', String(filtros.distanciaKm));
    p.set('f_TPR', `r${JANELAS[filtros.janelaTempo] ?? JANELAS.semana}`);
    if (filtros.modelo) p.set('f_WT', { presencial: '1', remoto: '2', hibrido: '3' }[filtros.modelo] ?? '');
    if (filtros.nivel) p.set('f_E', String(filtros.nivel));
    if (filtros.tipo) p.set('f_JT', String(filtros.tipo));
    return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
  }

  const hoje = () => new Date().toISOString().slice(0, 10);

  /**
   * Quantas candidaturas ainda cabem hoje nesta plataforma.
   *
   * Aquecimento: plataforma recém-usada começa devagar (5/dia nos 3 primeiros dias) mesmo que o limite
   * configurado seja maior. Quem cria uma conta e dispara 40 candidaturas no mesmo dia chama atenção.
   */
  function quantasCabemHoje(dominio, cfg, contadores) {
    const limite = cfg?.limiteDiarioPorPlataforma?.[dominio] ?? LIMITE_PADRAO;
    const c = contadores?.[dominio] ?? {};
    const feitasHoje = c.dia === hoje() ? (c.feitas ?? 0) : 0;
    const dias = c.desde ? Math.floor((Date.now() - new Date(c.desde).getTime()) / 86400000) : 0;
    const efetivo = !c.desde || dias < DIAS_DE_AQUECIMENTO ? Math.min(limite, LIMITE_NO_AQUECIMENTO) : limite;
    return { cabem: Math.max(0, efetivo - feitasHoje), limite: efetivo, feitasHoje, aquecendo: efetivo < limite };
  }

  /** Espera até a próxima candidatura: sorteada na faixa configurada, nunca um relógio certinho. */
  const proximaEspera = cfg => {
    const min = Math.max(5, cfg?.intervaloMinSegundos ?? PADRAO.intervaloMinSegundos);
    const max = Math.max(min, cfg?.intervaloMaxSegundos ?? PADRAO.intervaloMaxSegundos);
    return Math.round((min + Math.random() * (max - min)) * 1000);
  };

  /**
   * Sites cujos TERMOS DE USO proíbem candidatura automatizada. A extensão não candidata neles, por caminho
   * nenhum — nem o motor dedicado, nem o modo genérico.
   *
   * Por que isto precisa existir como lista explícita: o modo genérico serve justamente para site que o ACV
   * não conhece, então tirar uma plataforma do cadastro NÃO a protege — ela cai no genérico e passa a ser
   * tratada como qualquer outra. Era exatamente o que acontecia com o Jobbol depois de eu removê-lo: o
   * genérico preencheria nome, sobrenome, celular, e-mail e anexaria o currículo.
   *
   * Mora aqui, e não no núcleo, porque tem de valer com o ACV FECHADO — é uma recusa, e recusa que depende
   * de servidor no ar não é recusa. O catálogo da tela (`src/dados.ts`) repete o motivo para a pessoa ler, e
   * um teste cruza os dois.
   */
  const SEM_AUTOMACAO = [
    {
      dominio: 'jobbol.com.br',
      motivo: 'os termos de uso do Jobbol (cláusula 5.3) proíbem candidaturas automáticas ou em massa por sistemas automatizados. O ACV não preenche nem envia aqui: a inscrição é sua, no site.',
    },
  ];

  /** O site aberto proíbe automação nos termos? Devolve o motivo (para a tela mostrar) ou null. */
  const proibeAutomacao = host => {
    const h = String(host ?? '')
      .replace(/^www\./, '')
      .toLowerCase();
    return SEM_AUTOMACAO.find(s => h === s.dominio || h.endsWith(`.${s.dominio}`)) ?? null;
  };

  /** Sinais de que a plataforma percebeu automação. Vendo isto, o robô PARA — não tenta disfarçar nada. */
  const RESTRICAO =
    /unusual activity|atividade incomum|verifique que voc[êe] [ée] humano|verify you are human|security check|verifica[çc][ãa]o adicional|captcha|tempor?ariamente restrit|conta restrita|too many requests/i;

  const api = { PADRAO, JANELAS, SEM_AUTOMACAO, proibeAutomacao, normalizarEmpresa, empresaBloqueada, montarUrlBuscaLinkedIn, quantasCabemHoje, proximaEspera, RESTRICAO, hoje };
  globalThis.ACVComum = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // core/extensao-check.ts roda isto em Node
})();
