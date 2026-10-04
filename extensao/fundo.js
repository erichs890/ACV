// Cérebro da extensão: guarda a configuração, conta as candidaturas do dia e conversa com o ACV QUANDO ele
// estiver aberto. Com o ACV fechado a extensão continua funcionando pela cópia em cache — é a mudança de
// arquitetura desta etapa: a extensão é autossuficiente, e o app é quem sincroniza, não quem manda.
//
// Por que a ponte mora aqui e não no content script: o service worker tem `host_permissions` e fala com o núcleo
// sem esbarrar no CORS nem na CSP do site visitado.
//
// Fronteira de confiança: o núcleo é um servidor local sem senha, então `/extensao/*` exige um token — mas a
// pessoa nunca o vê. A extensão o busca sozinha em `GET /extensao/token`, e é por isso que isso é seguro e
// não um teatro: o núcleo escuta SÓ em 127.0.0.1 e não manda cabeçalho de CORS, então um site qualquer que
// tente a mesma busca não consegue LER a resposta. Quem tem `host_permissions` para 127.0.0.1:4780 — ou
// seja, só esta extensão — passa. O token continua protegendo contra o site que você visita disparar uma
// candidatura na sua máquina; o que ele deixou de fazer é dar trabalho a você. A partir desta etapa a extensão PREENCHE formulários, então ela recebe os dados de verdade do
// perfil (nome, e-mail, telefone, respostas salvas, currículo) — antes só recebia "tem ou não tem". É o preço de
// preencher; o token e o localhost continuam sendo a única porta.
importScripts('comum.js');
const { PADRAO, quantasCabemHoje, hoje } = globalThis.ACVComum;

const NUCLEO = 'http://127.0.0.1:4780';
const VALIDADE_DETECCAO_MS = 7 * 24 * 60 * 60 * 1000; // plataforma muda o fluxo de login: a detecção reexpira

const ler = async (chave, padrao) => (await chrome.storage.local.get(chave))[chave] ?? padrao;
const gravar = (chave, valor) => chrome.storage.local.set({ [chave]: valor });
const lerConfig = async () => ({ ...PADRAO, ...(await ler('config', {})) });

/**
 * O token, pegando-o sozinha quando ainda não tem.
 *
 * Guarda em `chrome.storage.local` para não repetir a busca a cada chamada, e **descarta e repega** se o
 * núcleo recusar: o token é regenerado quando o banco é apagado, e um token velho guardado para sempre
 * deixaria a extensão morta sem explicação.
 */
async function garantirToken(forcar = false) {
  if (!forcar) {
    const guardado = await ler('token', '');
    if (guardado) return guardado;
  }
  try {
    const r = await fetch(`${NUCLEO}/extensao/token`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return '';
    const { token } = await r.json();
    if (token) await gravar('token', token);
    return token ?? '';
  } catch {
    return ''; // núcleo fechado: o cache cobre o resto
  }
}

async function paraONucleo(caminho, dados, jaRepetiu = false) {
  const token = await garantirToken();
  if (!token) throw new Error('o ACV não está no ar — abra o start.bat');
  const r = await fetch(NUCLEO + caminho, {
    method: dados === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: dados === undefined ? undefined : JSON.stringify(dados),
    signal: AbortSignal.timeout(8000), // ACV fechado não pode travar a página de vaga
  });
  // 401 só acontece com token velho: o banco foi apagado e o núcleo gerou outro. Repega e repete UMA vez.
  // A marca de repetição é parâmetro, não campo no corpo — no corpo ela viajaria junto com os dados.
  if (r.status === 401 && !jaRepetiu) {
    const novo = await garantirToken(true);
    if (novo && novo !== token) return paraONucleo(caminho, dados, true);
  }
  if (!r.ok) throw new Error(`${(await r.json().catch(() => ({}))).erro ?? r.status}`);
  return r.json();
}

// ─── Sincronização oportunista ────────────────────────────────────────────────────────────────────
//
// Chamada quando dá, nunca exigida: busca os dados pesados do núcleo (perfil, respostas, currículo) e empurra o
// que a extensão fez enquanto ele estava fechado. Falhou? Segue com o cache e avisa na tela.
async function sincronizar(comCurriculo = false) {
  const pendentes = await ler('pendentes', []);
  if (pendentes.length) {
    // Primeiro o que já aconteceu: histórico perdido não se recupera, cache desatualizado sim
    await paraONucleo('/extensao/candidaturas', { candidaturas: pendentes });
    await gravar('pendentes', []);
  }
  const temCurriculo = !!(await ler('cache', {})).curriculo;
  const dados = await paraONucleo(`/extensao/dados${comCurriculo || !temCurriculo ? '?curriculo=1' : ''}`);
  // Onde o núcleo tem adapter próprio: nesses sites o painel oferece o motor dele, que é o testado
  const { plataformas } = await paraONucleo('/extensao/plataformas').catch(() => ({ plataformas: null }));
  const cache = { ...(await ler('cache', {})), ...dados, em: new Date().toISOString() };
  if (plataformas) cache.plataformas = plataformas;
  await gravar('cache', cache);
  return cache;
}

/**
 * O ícone da barra diz, de relance, se o núcleo está no ar.
 *
 * O desenho é o mesmo nos dois estados; muda só a cor do quadrado — azul quando conectado, cinza quando não.
 * A 16px é a cor do quadrado que se lê, não o traço, então mexer no monograma nesse tamanho seria desperdício.
 *
 * O selo (badge) não repete essa informação: ele carrega um dado que a cor não cabe — quantas candidaturas
 * estão esperando para subir. Sem pendência nenhuma ele some, para o ícone ficar limpo no caso normal.
 */
const ICONE = n => `ui/marca/icone-${n}.png`;
const ICONE_OFF = n => `ui/marca/icone-off-${n}.png`;

async function pintarIcone({ sincronizado, pendentes = 0, cacheEm = null }) {
  const caminho = sincronizado ? ICONE : ICONE_OFF;
  const quando = cacheEm ? new Date(cacheEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;
  const complemento = quando ? `, usando a cópia de ${quando}` : ' e ainda não sincronizei nenhuma vez';
  try {
    await chrome.action.setIcon({ path: { 16: caminho(16), 32: caminho(32), 48: caminho(48) } });
    await chrome.action.setTitle({ title: sincronizado ? 'ACV — conectado ao núcleo' : `ACV — abra o start.bat para conectar${complemento}` });
    await chrome.action.setBadgeText({ text: pendentes > 0 ? String(Math.min(pendentes, 99)) : '' });
    if (pendentes > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#c8481a' }); // --color-orange-deep
      await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
    }
  } catch {
    // Pintar o ícone é conforto, nunca motivo para derrubar o que o chamador estava fazendo
  }
}

/** O que a tela mostra: sincronizado agora, ou operando com a cópia de quando. */
async function status() {
  const [cfg, cache, pendentes, contadores] = [await lerConfig(), await ler('cache', {}), await ler('pendentes', []), await ler('contadores', {})];
  let sincronizado = false;
  try {
    await sincronizar();
    sincronizado = true;
  } catch {
    // ACV fechado é o caso normal desta arquitetura, não um erro
  }
  const atual = await ler('cache', {});
  // Quem descobriu o estado pinta o ícone: é o único lugar que já sabe os três dados de uma vez
  await pintarIcone({ sincronizado, pendentes: pendentes.length, cacheEm: atual.em ?? null });
  return {
    sincronizado,
    cacheEm: atual.em ?? null,
    temCurriculo: !!atual.curriculo,
    pendentes: pendentes.length,
    cfg,
    contadores,
    hoje: Object.fromEntries(Object.keys(cfg.limiteDiarioPorPlataforma ?? {}).map(d => [d, quantasCabemHoje(d, cfg, contadores)])),
    cacheCarregado: !!cache.perfil,
  };
}

/** Dados para preencher: cache primeiro (funciona offline), sincronizando por baixo quando o ACV responde. */
async function dadosParaPreencher() {
  try {
    return await sincronizar();
  } catch {
    return await ler('cache', {});
  }
}

/**
 * Candidatura feita: conta para o limite do dia e vai para o núcleo. Com o ACV fechado ela fica na fila de
 * pendentes e sobe na próxima sincronização — o histórico consolidado não pode depender de o app estar aberto.
 */
async function registrarCandidatura(c) {
  const contadores = await ler('contadores', {});
  const atual = contadores[c.dominio] ?? {};
  contadores[c.dominio] = {
    desde: atual.desde ?? new Date().toISOString(), // começa o aquecimento da plataforma
    dia: hoje(),
    feitas: atual.dia === hoje() ? (atual.feitas ?? 0) + 1 : 1,
  };
  await gravar('contadores', contadores);
  const pendentes = [...(await ler('pendentes', [])), c];
  await gravar('pendentes', pendentes);
  try {
    await paraONucleo('/extensao/candidaturas', { candidaturas: pendentes });
    await gravar('pendentes', []);
    return { sincronizado: true };
  } catch {
    return { sincronizado: false }; // fica pendente; sobe quando o ACV abrir
  }
}

/** Cache de detecção por domínio (Parte B): não reavaliar a mesma plataforma a cada vaga aberta. */
async function cacheDeteccao(dominio, forcar) {
  if (forcar) return null;
  const c = (await ler('deteccoes', {}))[dominio];
  return c && Date.now() - c.em < VALIDADE_DETECCAO_MS ? c : null;
}

/**
 * Leva a pessoa para a tela do ACV.
 *
 * A extensão vive num navegador e o ACV pode estar em OUTRO (o usuário usa Edge para navegar e Firefox para o
 * app) — nenhuma extensão consegue focar a janela de outro navegador, isso o sistema não permite. O que dá, e
 * resolve o problema de verdade, é abrir a mesma tela aqui: o ACV é um servidor local, então a mesma URL serve
 * nos dois. Se já houver uma aba aberta nela, reaproveita em vez de encher o navegador de abas.
 */
async function abrirApp() {
  const { urlApp } = await lerConfig();
  const base = (urlApp || PADRAO.urlApp).replace(/\/+$/, '');
  const abas = await chrome.tabs.query({ url: `${base}/*` }).catch(() => []);
  if (abas[0]) {
    await chrome.tabs.update(abas[0].id, { active: true });
    await chrome.windows.update(abas[0].windowId, { focused: true }).catch(() => {});
    return { aba: abas[0].id, reaproveitada: true };
  }
  const nova = await chrome.tabs.create({ url: base, active: true });
  return { aba: nova.id, reaproveitada: false };
}

/**
 * O ícone precisa de pulso próprio.
 *
 * Sem isto ele só se atualizava quando alguma coisa perguntava o estado (abrir o popup, abrir uma vaga) — e
 * aí, fechado o núcleo, ele ficava azul dizendo "conectado" por tempo indeterminado. Um ícone que mente é
 * pior do que nenhum.
 *
 * A conferência é barata de propósito: uma chamada à rota mais leve do núcleo, em 127.0.0.1, com dois
 * segundos de paciência. Não sincroniza nada — quem sincroniza é `status()`, quando alguém de fato precisa
 * dos dados. O service worker dorme entre um alarme e outro, que é como o MV3 funciona.
 */
const PULSO_MIN = 2;

async function conferirConexao() {
  let sincronizado = false;
  try {
    // `garantirToken` já pareia sozinha na primeira vez: o pulso é também o que conecta a extensão quando
    // você abre o start.bat, sem você fazer nada.
    const token = await garantirToken();
    if (token) {
      const r = await fetch(`${NUCLEO}/extensao/plataformas`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
      sincronizado = r.ok;
    }
  } catch {
    // Núcleo fechado é o caso normal desta arquitetura
  }
  const cache = await ler('cache', {});
  await pintarIcone({ sincronizado, pendentes: (await ler('pendentes', [])).length, cacheEm: cache.em ?? null });
}

chrome.alarms.create('pulso', { periodInMinutes: PULSO_MIN });
chrome.alarms.onAlarm.addListener(a => a.name === 'pulso' && conferirConexao());
chrome.runtime.onStartup.addListener(conferirConexao);
chrome.runtime.onInstalled.addListener(conferirConexao);

const ACOES = {
  CONFIG: async () => ({ cfg: await lerConfig() }),
  CONFIG_GRAVAR: async m => {
    await gravar('config', { ...(await lerConfig()), ...m.cfg });
    return { cfg: await lerConfig() };
  },
  STATUS: () => status(),
  SINCRONIZAR: async () => ({ cache: await sincronizar(true) }),
  DADOS: async () => ({ dados: await dadosParaPreencher() }),
  CANDIDATURA: m => registrarCandidatura(m.candidatura),
  CABEM: async m => {
    const cfg = await lerConfig();
    return quantasCabemHoje(m.dominio, cfg, await ler('contadores', {}));
  },
  // A IA mora no núcleo, com as travas dela (dado pessoal e autodeclaração nunca passam por lá). Se o ACV
  // estiver fechado, a extensão simplesmente não responde sozinha: ela para e chama a pessoa.
  PERGUNTA: async m => {
    const cfg = await lerConfig();
    if (!cfg.iaAtiva) return { resposta: null, motivo: 'a IA está desligada nas configurações da extensão' };
    try {
      return await paraONucleo('/extensao/pergunta', m.dados);
    } catch (e) {
      return { resposta: null, motivo: `o ACV não respondeu (${e.message})` };
    }
  },
  // Primeira visita a uma página de vaga: o cache ainda está vazio, então vale uma tentativa de sincronizar
  // antes de responder — senão o botão "Candidatar pelo ACV" só apareceria a partir da segunda vez.
  PLATAFORMAS: async () => {
    let cache = await ler('cache', {});
    if (!cache.plataformas) {
      await sincronizar().catch(() => {});
      cache = await ler('cache', {});
    }
    return { plataformas: cache.plataformas ?? [] };
  },
  ABRIR_APP: () => abrirApp(),
  // Candidatar com o motor do NÚCLEO (adapter testado) na vaga que está aberta. Exige o ACV aberto.
  NUCLEO_CANDIDATAR: m => paraONucleo('/extensao/candidatar', { url: m.url }),
  CACHE: async m => ({ cache: await cacheDeteccao(m.dominio, m.forcar) }),
  PLATAFORMA_DETECTADA: async m => {
    const todas = await ler('deteccoes', {});
    todas[m.dominio] = { precisaLogin: m.precisaLogin, logadoAtualmente: m.logadoAtualmente, em: Date.now() };
    await gravar('deteccoes', todas);
    return paraONucleo('/extensao/plataforma', m);
  },
  VALIDACAO_CAMPOS: m => paraONucleo('/extensao/campos', m),
  // "Escondi o painel neste site": quem guarda é o worker, não o content script. `chrome.storage.session`
  // nasce fechada para content script e lá isso vira "Access to storage is not allowed from this context" —
  // erro que derrubava a montagem inteira do painel. Session e não local de propósito: esconder vale até
  // fechar o navegador, não para sempre.
  ESCONDER_PAINEL: async m => {
    const mapa = await ler('paineisEscondidos', {});
    mapa[m.origem] = true;
    await chrome.storage.session?.set({ paineisEscondidos: mapa }).catch(() => gravar('paineisEscondidos', mapa));
    return { ok: true };
  },
  PAINEL_ESCONDIDO: async m => {
    const { paineisEscondidos = {} } = (await chrome.storage.session?.get('paineisEscondidos').catch(() => ({}))) ?? {};
    return { escondido: !!paineisEscondidos[m.origem] };
  },
  // O popup pede para o painel reaparecer num site onde a pessoa o escondeu
  MOSTRAR_PAINEL: async m => {
    const mapa = (await chrome.storage.session?.get('paineisEscondidos').catch(() => ({})))?.paineisEscondidos ?? {};
    delete mapa[m.origem];
    await chrome.storage.session?.set({ paineisEscondidos: mapa }).catch(() => {});
    if (m.abaId) await chrome.tabs.reload(m.abaId);
    return { ok: true };
  },
  ABRIR_OPCOES: () => chrome.runtime.openOptionsPage(),
};

chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  const acao = ACOES[msg?.tipo];
  if (!acao) {
    responder({ ok: false, erro: `tipo desconhecido: ${msg?.tipo}` });
    return false;
  }
  Promise.resolve(acao(msg)).then(
    r => responder({ ok: true, ...r }),
    e => responder({ ok: false, erro: e.message }),
  );
  return true; // resposta assíncrona
});
