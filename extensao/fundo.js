// Cérebro da extensão: guarda a configuração, conta as candidaturas do dia e conversa com o AutoCV QUANDO ele
// estiver aberto. Com o AutoCV fechado a extensão continua funcionando pela cópia em cache — é a mudança de
// arquitetura desta etapa: a extensão é autossuficiente, e o app é quem sincroniza, não quem manda.
//
// Por que a ponte mora aqui e não no content script: o service worker tem `host_permissions` e fala com o núcleo
// sem esbarrar no CORS nem na CSP do site visitado.
//
// Fronteira de confiança: o núcleo é um servidor local sem senha, então `/extensao/*` exige o token que a pessoa
// cola uma vez. A partir desta etapa a extensão PREENCHE formulários, então ela recebe os dados de verdade do
// perfil (nome, e-mail, telefone, respostas salvas, currículo) — antes só recebia "tem ou não tem". É o preço de
// preencher; o token e o localhost continuam sendo a única porta.
importScripts('comum.js');
const { PADRAO, quantasCabemHoje, hoje } = globalThis.AutoCVComum;

const NUCLEO = 'http://127.0.0.1:4780';
const VALIDADE_DETECCAO_MS = 7 * 24 * 60 * 60 * 1000; // plataforma muda o fluxo de login: a detecção reexpira

const ler = async (chave, padrao) => (await chrome.storage.local.get(chave))[chave] ?? padrao;
const gravar = (chave, valor) => chrome.storage.local.set({ [chave]: valor });
const lerConfig = async () => ({ ...PADRAO, ...(await ler('config', {})) });

async function paraONucleo(caminho, dados) {
  const token = await ler('token', '');
  if (!token) throw new Error('sem token: abra o popup do AutoCV e cole o token que aparece em Plataformas');
  const r = await fetch(NUCLEO + caminho, {
    method: dados === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: dados === undefined ? undefined : JSON.stringify(dados),
    signal: AbortSignal.timeout(8000), // AutoCV fechado não pode travar a página de vaga
  });
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

/** O que a tela mostra: sincronizado agora, ou operando com a cópia de quando. */
async function status() {
  const [cfg, cache, pendentes, contadores] = [await lerConfig(), await ler('cache', {}), await ler('pendentes', []), await ler('contadores', {})];
  let sincronizado = false;
  try {
    await sincronizar();
    sincronizado = true;
  } catch {
    // AutoCV fechado é o caso normal desta arquitetura, não um erro
  }
  const atual = await ler('cache', {});
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

/** Dados para preencher: cache primeiro (funciona offline), sincronizando por baixo quando o AutoCV responde. */
async function dadosParaPreencher() {
  try {
    return await sincronizar();
  } catch {
    return await ler('cache', {});
  }
}

/**
 * Candidatura feita: conta para o limite do dia e vai para o núcleo. Com o AutoCV fechado ela fica na fila de
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
    return { sincronizado: false }; // fica pendente; sobe quando o AutoCV abrir
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
  // A IA mora no núcleo, com as travas dela (dado pessoal e autodeclaração nunca passam por lá). Se o AutoCV
  // estiver fechado, a extensão simplesmente não responde sozinha: ela para e chama a pessoa.
  PERGUNTA: async m => {
    const cfg = await lerConfig();
    if (!cfg.iaAtiva) return { resposta: null, motivo: 'a IA está desligada nas configurações da extensão' };
    try {
      return await paraONucleo('/extensao/pergunta', m.dados);
    } catch (e) {
      return { resposta: null, motivo: `o AutoCV não respondeu (${e.message})` };
    }
  },
  // Primeira visita a uma página de vaga: o cache ainda está vazio, então vale uma tentativa de sincronizar
  // antes de responder — senão o botão "Candidatar pelo AutoCV" só apareceria a partir da segunda vez.
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
