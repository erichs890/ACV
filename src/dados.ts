import type { Conexao, Envio, Plataforma, StatusVaga } from './types.ts';

// Catálogo do produto: só plataformas em que vale a pena automatizar. O critério que decidiu a poda de
// 21/09/2026 é um só — **a candidatura tem de acontecer dentro da plataforma**. Site que redireciona para o
// formulário da empresa não tem "um adapter": tem um adapter por empresa, para sempre. Saíram daqui os
// agregadores (Remotive, Working Nomads, JS Remotely, Glassdoor), os que cobram assinatura para candidatar
// (Catho, FlexJobs), os que candidatam "com o perfil" em vez de PDF (Wellfound, PowerToFly), os que nem são
// mural de vaga (Toptal, Job Hunt, Kickresume) e o LinkedIn — este último passa no critério, mas caça
// automação com agressividade e o que se arrisca ali é a conta profissional. Estão todos no histórico do git.
export const PLATAFORMAS: Plataforma[] = [
  {
    id: 'inhire',
    regiao: 'brasil',
    nome: 'InHire',
    sigla: 'ih',
    cor: 'bg-purple',
    disponivel: true,
    site: 'https://inhire.app',
    nota: 'Sem login: cada empresa publica em <empresa>.inhire.app/vagas e a API pública devolve vaga e formulário.',
  },
  {
    id: 'vagaspj',
    regiao: 'brasil',
    nome: 'Vagas PJ',
    sigla: 'pj',
    cor: 'bg-blue-deep',
    disponivel: true,
    site: 'https://www.vagaspj.com.br/buscar-vagas',
    nota: 'Só vagas de contratação PJ. Sem login: a lista vem do feed público e a candidatura é um formulário curto no próprio site.',
  },
  {
    id: 'gupy',
    regiao: 'brasil',
    nome: 'Gupy',
    sigla: 'gu',
    cor: 'bg-blue-dark',
    disponivel: false,
    login: true,
    site: 'https://portal.gupy.io',
    nota: 'Maior fatia das vagas de tecnologia no Brasil e a listagem é pública, mas verificado em 23/09/2026: candidatar EXIGE conta (o botão nasce desabilitado e o fluxo chama a tela de login). Fica atrás das que não pedem login.',
  },
  {
    id: 'divulgavagas',
    regiao: 'brasil',
    nome: 'Divulga Vagas',
    sigla: 'dv',
    cor: 'bg-aqua',
    disponivel: true,
    site: 'https://divulgavagas.com.br',
    nota: 'Sem login e sem captcha. A candidatura é SÓ o PDF: o site preenche nome e e-mail com texto de enfeite, então seus dados de perfil não vão. ~41 mil vagas, quase nenhuma de tecnologia — o robô peneira pelo título antes de abrir.',
  },
  {
    id: 'quickin',
    regiao: 'brasil',
    nome: 'Quickin',
    sigla: 'qk',
    cor: 'bg-purple',
    disponivel: true,
    site: 'https://jobs.quickin.io',
    nota: 'ATS brasileiro com 628 empresas em sitemap público, sem login. Os campos usam id em vez de name. Formulário direto com anexo de currículo e envio confirmado na API.',
  },

  {
    id: 'programathor',
    regiao: 'brasil',
    nome: 'ProgramaThor',
    sigla: 'PT',
    cor: 'bg-blue-deep',
    disponivel: true,
    login: true,
    site: 'https://programathor.com.br/jobs',
    nota: 'Só vagas de tecnologia, e a listagem tem os mesmos filtros que você usa aqui (senioridade e remoto), o que deixa a varredura precisa: ~5.100 vagas em Pleno remoto. Candidatar EXIGE conta — login manual uma vez e a sessão fica no navegador do robô. Os termos de uso não proíbem automação (lidos em 03/10/2026).',
  },
  {
    id: 'vagas',
    regiao: 'brasil',
    nome: 'Vagas.com',
    sigla: 'vg',
    cor: 'bg-green-deep',
    disponivel: false,
    login: true,
    site: 'https://www.vagas.com.br',
    nota: 'Candidatura no próprio site, sem assinatura, com volume brasileiro real. Exige conta.',
  },
  {
    id: 'infojobs',
    regiao: 'brasil',
    nome: 'InfoJobs',
    sigla: 'ij',
    cor: 'bg-blue-dark',
    disponivel: false,
    login: true,
    site: 'https://www.infojobs.com.br',
    nota: 'Candidatura no próprio site, com conta gratuita. Volume menor que Gupy e Vagas.com.',
  },
  {
    id: 'trampos',
    regiao: 'brasil',
    nome: 'Trampos.co',
    sigla: 'tr',
    cor: 'bg-orange-deep',
    disponivel: false,
    login: true,
    site: 'https://trampos.co',
    nota: 'A confirmar: nicho de tecnologia e design, volume pequeno. Falta checar se a candidatura é no site ou se redireciona para a empresa — se redirecionar, sai daqui.',
  },

  {
    id: 'indeed',
    regiao: 'global',
    nome: 'Indeed',
    sigla: 'id',
    cor: 'bg-side-top',
    disponivel: true,
    site: 'https://br.indeed.com',
    login: true,
    nota: 'Login manual uma vez; a sessão fica no perfil do navegador do robô. Semiautomático por construção: o Indeed bloqueia navegador oculto e desafia cargas seguidas, então é uma varredura por dia, em janela visível, e o robô para e chama você diante de um bloqueio.',
  },

  {
    id: 'workable',
    regiao: 'internacional',
    nome: 'Workable',
    sigla: 'wk',
    cor: 'bg-green-deep',
    disponivel: true,
    site: 'https://jobs.workable.com',
    nota: 'Busca pública via API REST com suporte a vagas remotas internacionais e no Brasil. Schema de formulário por vaga para perguntas prévias, e candidatura via modal com confirmação de rede.',
  },
  {
    id: 'arbeitnow',
    regiao: 'internacional',
    nome: 'Arbeitnow',
    sigla: 'an',
    cor: 'bg-amber',
    disponivel: true,
    site: 'https://www.arbeitnow.com',
    nota: 'API pública com vagas de tecnologia europeias e remotas. Candidatura adaptativa em múltiplos formatos (Personio, Ashby, Greenhouse) com preenchimento automático.',
  },

  {
    id: 'remoteok',
    regiao: 'internacional',
    nome: 'RemoteOK',
    sigla: 'ro',
    cor: 'bg-green-deep',
    disponivel: false,
    site: 'https://remoteok.com',
    nota: 'A confirmar: a listagem é fácil (feed público em JSON, remoteok.com/api), mas falta checar se a candidatura é no site ou se redireciona para a empresa — se redirecionar, sai daqui.',
  },
];

/** Grupos da tela de Plataformas: separa o que é do Brasil, o que é global e o que é vaga gringa. */
export const REGIOES: { id: Plataforma['regiao']; titulo: string; texto: string }[] = [
  { id: 'brasil', titulo: 'Brasil', texto: 'Vagas publicadas por empresas brasileiras, em português.' },
  { id: 'global', titulo: 'Globais', texto: 'Operam no Brasil e no exterior; a mesma conta serve para os dois.' },
  { id: 'internacional', titulo: 'Internacionais — EUA e Europa', texto: 'Vagas remotas em inglês. Os países que você aceita ficam em Configurações › Meus Dados.' },
];

export const getPlataforma = (id: string): Plataforma => PLATAFORMAS.find(p => p.id === id) ?? PLATAFORMAS[0];

// ─── Modelos de IA ───────────────────────────────────────────────────────────
// Conferido em 23/09/2026 contra a API (models.list + uma chamada real em cada um) e a tabela oficial de preços.
// Preços em dólares por 1 milhão de tokens: são a ordem de grandeza para comparar, não uma cobrança — quem cobra
// é o provedor, com a sua própria chave.
//
// Esta lista é a ÚNICA fonte: `core/ia.ts` deriva dela as opções válidas e o padrão (o primeiro `recomendado`).
//
// O Google APOSENTA modelo sem tirar da listagem: `gemini-2.5-flash` e `gemini-2.5-pro` ainda aparecem em
// models.list, mas uma chamada real devolve 404 "no longer available to new users" — por isso saíram daqui.
// É a segunda vez que isso acontece (antes foi o 2.0 Flash). `migrarModelo` tira do buraco quem já estava neles.
export interface ModeloIA {
  id: string;
  situacao: 'recomendado' | 'estavel' | 'preview';
  entrada: number; // US$ por 1M tokens de entrada
  saida: number; // US$ por 1M tokens de saída
  nota: string;
}

export const MODELOS_IA: Record<'gemini' | 'anthropic', ModeloIA[]> = {
  gemini: [
    { id: 'gemini-3.8-flash', situacao: 'recomendado', entrada: 0.75, saida: 3.75, nota: 'O mais recente e capaz da linha Flash. Preço promocional até 31/12/2026 (depois dobra).' },
    {
      id: 'gemini-flash-latest',
      situacao: 'estavel',
      entrada: 0.75,
      saida: 3.75,
      nota: 'Aponta sempre para o Flash mais novo, sozinho — é o que não enferruja quando o Google aposenta um modelo. Em troca, o modelo por trás pode mudar sem aviso, e o preço acompanha.',
    },
    { id: 'gemini-3.7-flash', situacao: 'estavel', entrada: 0.75, saida: 3.75, nota: 'Flash da geração anterior, pelo mesmo preço do 3.8.' },
    { id: 'gemini-3.6-flash', situacao: 'estavel', entrada: 0.75, saida: 3.75, nota: 'É para onde o Google manda quem usava o 2.5 Flash. Mesmo preço do 3.8.' },
    { id: 'gemini-3.5-flash', situacao: 'estavel', entrada: 1.5, saida: 9, nota: 'Custa o dobro do 3.8 e rende menos; só vale se os mais novos estiverem instáveis.' },
    { id: 'gemini-3.5-flash-lite', situacao: 'estavel', entrada: 0.3, saida: 2.5, nota: 'Barato e rápido, para adaptar muitos currículos gastando pouco.' },
    { id: 'gemini-flash-lite-latest', situacao: 'estavel', entrada: 0.3, saida: 2.5, nota: 'O mesmo que o Flash-Lite, sempre na versão mais nova. O preço acompanha o modelo do momento.' },
    { id: 'gemini-3.1-flash-lite', situacao: 'estavel', entrada: 0.25, saida: 1.5, nota: 'O mais barato da lista. Menos capaz em textos longos.' },
    {
      id: 'gemini-3.1-pro-preview',
      situacao: 'preview',
      entrada: 2,
      saida: 12,
      nota: 'O mais capaz do Gemini e o mais caro. Em preview: pode mudar ou sair do ar sem aviso, e a cota gratuita dele acaba rápido.',
    },
  ],
  anthropic: [
    { id: 'claude-opus-5', situacao: 'recomendado', entrada: 5, saida: 25, nota: 'O mais capaz do Claude — melhor para respeitar a regra de não inventar nada.' },
    { id: 'claude-sonnet-5', situacao: 'estavel', entrada: 2, saida: 10, nota: 'Equilíbrio entre custo e qualidade.' },
    { id: 'claude-haiku-4-5', situacao: 'estavel', entrada: 1, saida: 5, nota: 'O mais barato do Claude, para volume.' },
  ],
};

/** Modelo que o app usa quando ninguém escolheu (ou quando o escolhido morreu): o primeiro `recomendado`. */
export const modeloPadrao = (provedor: 'gemini' | 'anthropic') => (MODELOS_IA[provedor].find(m => m.situacao === 'recomendado') ?? MODELOS_IA[provedor][0]).id;

export const SITUACAO_MODELO: Record<ModeloIA['situacao'], { rotulo: string; classe: string }> = {
  recomendado: { rotulo: 'Recomendado', classe: 'bg-green-deep text-white' },
  estavel: { rotulo: 'Estável', classe: 'border border-panel-border bg-page-bg text-ink-soft' },
  preview: { rotulo: 'Preview', classe: 'bg-amber text-ink' },
};

/** Faixa de custo relativa ao resto da lista do provedor, pelo preço de saída (que é o que pesa na adaptação). */
export function faixaDeCusto(modelo: ModeloIA, lista: ModeloIA[]): { rotulo: string; classe: string } {
  const precos = [...lista.map(m => m.saida)].sort((a, b) => a - b);
  const posicao = precos.indexOf(modelo.saida) / Math.max(1, precos.length - 1);
  if (posicao <= 0.33) return { rotulo: 'Mais barato', classe: 'text-green-deep' };
  if (posicao <= 0.66) return { rotulo: 'Custo médio', classe: 'text-ink-soft' };
  return { rotulo: 'Mais caro', classe: 'text-orange-deep' };
}

export const precoPorMilhao = (v: number) => `US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A pergunta é sobre ESTA empresa/vaga e não faz sentido reaproveitar em outra?
 *
 * "Quais são as suas impressões sobre as nossas produções?" (Brasil Paralelo) respondida com "excelente" e
 * guardada para "perguntas parecidas" viraria a mesma resposta na vaga de outra empresa — sem sentido, e o
 * recrutador percebe. Nesses casos a caixa "guardar" nasce desmarcada; o usuário ainda pode marcar.
 */
export function perguntaSoDestaVaga(rotulo: string, empresa = ''): boolean {
  const limpar = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const r = limpar(rotulo);
  // Fala da empresa como "nós": nossas produções, nosso produto, trabalhar conosco
  if (/\bnoss[ao]s?\b|\bconosco\b|\bda nossa\b|\bdaqui\b/.test(r)) return true;
  // Fala desta vaga em particular
  if (/\b(esta|essa|nesta|nessa)\s+(vaga|posicao|oportunidade|empresa)\b/.test(r)) return true;
  // Motivação/conhecimento sobre a empresa
  if (/por que (voce )?(quer|gostaria|deseja|escolheu|se interessou)/.test(r)) return true;
  if (/o que voce (sabe|conhece|pensa|acha)/.test(r)) return true;
  if (/\b(ja )?conhece\b/.test(r) && !/\b(ingles|espanhol|ferramenta|tecnologia|metodologia)\b/.test(r)) return true;
  // O nome da empresa aparece na pergunta
  const marcas = limpar(empresa)
    .replace(/\b(ltda|sa|s\/a|tecnologia|consultoria|solucoes|group|brasil|inc|me|eireli)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 4);
  return marcas.some(t => r.includes(t));
}

/**
 * Estamos dentro da janela de envio ("08:00-20:00")? Regra única: o núcleo decide a fila por ela e a tela avisa
 * por ela — duas cópias divergiriam, e o sintoma seria a tela dizer que está tudo certo com o robô parado.
 */
export function dentroDaJanela(janela: string): boolean {
  const [ini, fim] = janela.split('-');
  const agora = new Date().toTimeString().slice(0, 5);
  return agora >= ini && agora <= fim;
}

/** "10 s", "1 min", "8 min", "1 min 30 s": rótulo legível para uma espera em segundos. */
export const textoIntervalo = (s: number) => (s < 60 ? `${s} s` : s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`);

/**
 * A plataforma desta vaga está no foco da automação? (Automação › "Plataformas que entram na fila".)
 *
 * Um só interruptor decide duas coisas de propósito: o robô não enfileira a vaga e ela sai da lista por padrão.
 * Focar em uma plataforma sem limpar a tela não seria foco nenhum. Nada é apagado — a lista tem um botão para
 * mostrar as que ficaram de fora. Conexão sem o campo = no foco (as conexões criadas antes disto continuam valendo).
 */
/**
 * O termo de exclusão que bate no título desta vaga, ou null. Fonte única: o score (`core/resume/score.ts`)
 * corta por aqui e a tela de Configurações conta por aqui — se fossem duas regras, a prévia mentiria.
 *
 * Só o TÍTULO, com borda de palavra. Procurar no texto inteiro excluiria uma vaga full stack que cita SAP
 * numa linha de integração; sem borda, "sap" casaria com "Sapucaia do Sul" (caso real do acervo).
 */
export function termoExcluido(titulo: string, excluir: string[] = []): string | null {
  const limpar = (t: string) =>
    t
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  const t = limpar(titulo);
  for (const bruto of excluir) {
    const termo = limpar(bruto).trim();
    if (!termo) continue;
    if (new RegExp(`(^|[^a-z0-9])${termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)) return bruto.trim();
  }
  return null;
}

export const plataformaNoFoco = (conexoes: Record<string, Conexao>, plataforma: string) => conexoes[plataforma]?.enviar !== false;

export const NIVEIS = ['Estágio', 'Júnior', 'Pleno', 'Sênior', 'Liderança'];
export const AREAS = ['Tecnologia da Informação', 'Dados e Analytics', 'Suporte e Infraestrutura', 'Comercial e Vendas', 'Financeiro e Contábil', 'Recursos Humanos', 'Marketing', 'Administrativo'];
export const REGIMES = [
  ['remoto', 'Remoto'],
  ['hibrido', 'Híbrido'],
  ['presencial', 'Presencial'],
];

export const STATUS_VAGA: Record<StatusVaga, { rotulo: string; classe: string }> = {
  encontrada: { rotulo: 'Encontrada', classe: 'border border-panel-border bg-page-bg text-ink' },
  na_fila: { rotulo: 'Na fila', classe: 'bg-blue-dark text-white' },
  em_andamento: { rotulo: 'Em andamento', classe: 'bg-blue-deep text-white' },
  aguardando_pergunta: { rotulo: 'Aguardando resposta', classe: 'bg-amber text-ink' },
  aguardando_aprovacao: { rotulo: 'Aguardando aprovação', classe: 'bg-amber text-ink' },
  enviada: { rotulo: 'Enviada', classe: 'bg-green-deep text-white' },
  ensaio: { rotulo: 'Ensaio', classe: 'bg-purple text-white' },
  erro: { rotulo: 'Erro', classe: 'bg-orange-deep text-white' },
  ignorada: { rotulo: 'Baixa compatibilidade', classe: 'border border-panel-border bg-page-bg text-ink-soft' },
  encerrada: { rotulo: 'Encerrada', classe: 'border border-panel-border bg-page-bg text-ink-soft line-through' },
};

/**
 * Currículos REALMENTE enviados no mês corrente.
 *
 * Uma regra só, porque havia duas e uma estava errada: o menu comparava `"09"` (mês da data DD/MM) com
 * `"20"` (dois primeiros dígitos do ano) e por isso mostrava 0 para sempre. Ensaio não entra: ele preenche
 * o formulário e não envia nada.
 */
export const enviosDoMes = (envios: Envio[], quando = new Date()): Envio[] =>
  envios.filter(e => {
    if (e.status !== 'Enviado') return false;
    const d = new Date(e.enviadaEm);
    return !Number.isNaN(d.getTime()) && d.getFullYear() === quando.getFullYear() && d.getMonth() === quando.getMonth();
  });

export const tempoAtras = (iso: string | null) => {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
};

export const MODELO = { remoto: 'Remoto', hibrido: 'Híbrido', presencial: 'Presencial', indefinido: 'Modelo não informado' } as const;
export const REGIME_VAGA = { CLT: 'CLT', PJ: 'PJ', ambos: 'CLT ou PJ', indefinido: 'Regime não informado' } as const;

export const NOTIFICACOES = [
  { id: 'cada-envio', titulo: 'Notificar por e-mail a cada envio', descricao: 'Você recebe um e-mail sempre que o robô envia um currículo.', padrao: true },
  { id: 'resposta', titulo: 'Notificar quando houver resposta de empresa', descricao: 'Avisos de entrevistas e mensagens das plataformas.', padrao: true },
  { id: 'resumo', titulo: 'Resumo semanal por e-mail', descricao: 'Toda segunda-feira, com estatísticas da semana.', padrao: true },
  { id: 'erro-conexao', titulo: 'Alertas de erro de conexão', descricao: 'Quando uma plataforma desconectar ou expirar a sessão.', padrao: false },
  { id: 'novidades', titulo: 'Novidades e dicas do ACV', descricao: 'Novidades do produto e dicas de currículo.', padrao: false },
];

export const LIMITE_MB = 5;
export const EXTENSOES = /\.(pdf|docx)$/i;

export function validarCurriculo(arquivo: File): string {
  if (!EXTENSOES.test(arquivo.name)) return 'O currículo precisa ser um arquivo PDF ou DOCX.';
  if (arquivo.size > LIMITE_MB * 1024 * 1024) return `O arquivo passa de ${LIMITE_MB} MB.`;
  return '';
}

export const formatarTamanho = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const iniciais = (nome: string) =>
  nome
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? '')
    .join('') || '?';

export const dataHora = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Aceita "empresa", "empresa.inhire.app" ou a URL completa da página de vagas. */
export function extrairTenant(entrada: string): string {
  const s = entrada.trim().toLowerCase();
  const m = s.match(/([a-z0-9-]+)\.inhire\.app/);
  return (m ? m[1] : s.replace(/^https?:\/\//, '').split(/[/?#.]/)[0]).replace(/[^a-z0-9-]/g, '');
}
