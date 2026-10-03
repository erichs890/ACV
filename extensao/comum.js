// Configuração e regras que a extensão usa sozinha, SEM depender do AutoCV aberto.
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
    iaAtiva: false, // só tem efeito com o AutoCV aberto: é lá que a IA roda, com as travas dela
    limiteDiarioPorPlataforma: { 'linkedin.com': 10, 'indeed.com': 10, 'gupy.io': 10 },
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

  /** Sinais de que a plataforma percebeu automação. Vendo isto, o robô PARA — não tenta disfarçar nada. */
  const RESTRICAO =
    /unusual activity|atividade incomum|verifique que voc[êe] [ée] humano|verify you are human|security check|verifica[çc][ãa]o adicional|captcha|tempor?ariamente restrit|conta restrita|too many requests/i;

  const api = { PADRAO, JANELAS, normalizarEmpresa, empresaBloqueada, montarUrlBuscaLinkedIn, quantasCabemHoje, proximaEspera, RESTRICAO, hoje };
  globalThis.AutoCVComum = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // core/extensao-check.ts roda isto em Node
})();
