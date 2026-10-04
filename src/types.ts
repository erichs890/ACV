// Tipos compartilhados entre o front (src/) e o núcleo (core/)
import type { ConfigSensiveis } from './sensiveis.ts';
export type { ConfigSensiveis } from './sensiveis.ts';

export type StatusEnvio = 'Enviado' | 'Visualizado' | 'Pendente' | 'Erro';
export type EstadoRobo = 'ativo' | 'pausado' | 'erro';

export interface Plataforma {
  id: string;
  nome: string;
  sigla: string;
  cor: string; // classe Tailwind de fundo do logo
  disponivel: boolean; // só o InHire por enquanto
  regiao: 'brasil' | 'global' | 'internacional'; // agrupa a lista de Plataformas
  site?: string; // endereço oficial, para quando formos escrever o adapter
  nota?: string; // o que já se sabe da plataforma (idioma, acesso, tipo de conta) antes de integrar
  login?: boolean; // exige conta: conecta entrando numa janela do robô (core/sessao.ts)
}

export interface Envio {
  id: number;
  vaga: string;
  empresa: string;
  plataforma: string; // Plataforma.id
  enviadaEm: string; // ISO — a data crua; `data`/`hora` são só a formatação para a tela
  data: string; // DD/MM
  hora: string; // HH:MM
  status: StatusEnvio;
}

export interface PontoAtividade {
  rotulo: string;
  valor: number;
}

export interface LinhaLog {
  hora: string;
  msg: string;
  tipo: 'sucesso' | 'info' | 'aguardo' | 'erro' | 'alerta';
}

export interface Pergunta {
  id: number;
  icone: string;
  pergunta: string;
  resposta: string;
  personalizada: boolean;
}

// ─── Currículo ───────────────────────────────────────────────
export interface PerfilBusca {
  area: string;
  cargos: string[];
  skills: string[];
  senioridade: string;
}

export interface Arquivo {
  id: number;
  nome: string;
  tamanho: number;
  enviadoEm: string; // ISO
  caminho?: string; // no disco (núcleo)
  markdown?: string; // texto extraído do PDF
  perfilBusca?: PerfilBusca;
  inglesMarkdown?: string; // versão traduzida para inglês
  inglesPdf?: string; // caminho do PDF traduzido no disco
  traduzidoEm?: string; // ISO
}

// ─── Usuário ─────────────────────────────────────────────────
export interface Perfil {
  nome: string;
  email: string;
  telefone: string;
  cargo?: string;
  cidade?: string; // localização para vagas presenciais e híbridas (e o que vai no campo "cidade" dos formulários)
  paisesRemoto?: string[]; // países aceitos para vagas 100% remotas (src/paises.ts); ausente = só Brasil
  linkedin?: string;
  github?: string;
  portfolio?: string;
  endereco?: string;
  cpf?: string;
  nascimento?: string;
  disponibilidade?: string;
  pcd?: string;
  escolaridade?: string;
  idiomas?: string;
  pretensao?: string;
}

export interface Conexao {
  conectadaEm: string; // ISO
  usuario?: string;
  /**
   * A plataforma está no foco da automação? Ausente = sim (as conexões antigas continuam valendo).
   * Desligada, ela continua sendo varrida e as vagas continuam gravadas, mas não entram na fila e saem da
   * lista por padrão (há um botão para mostrá-las). Editável só em Automação; Plataformas espelha.
   * Fica aqui, e não em `automacao`, para não existir um segundo lugar dizendo quais plataformas valem.
   */
  enviar?: boolean;
  /** Plataformas com login: última validação da sessão no navegador do robô (core/sessao.ts) */
  sessao?: { validadaEm: string; valida: boolean };
}

export interface ConfigAutomacao {
  configurada: boolean;
  area: string;
  senioridade: string; // '' = a detectada no currículo
  regimes: string[]; // remoto | hibrido | presencial
  intervaloSegundos: number; // espera entre uma candidatura e a próxima
  limiteDiario: number;
  janela: string; // "08:00-20:00"
  modo: 'automatico' | 'manual';
  adaptar: boolean; // adaptar o currículo por vaga
  preview: 'mostrar' | 'direto';
  regimePreferido: 'CLT' | 'PJ' | 'perguntar'; // quando a vaga aceita os dois
  ensaio: boolean; // preenche tudo, não envia
  mostrarNavegador: boolean;
  navegador: 'edge' | 'firefox'; // firefox = build do Playwright (não o Firefox instalado); o PDF é sempre via Chromium oculto
  scoreMinimo: number; // 0–100
  cargoRigido: boolean; // só vagas da mesma função que a sua passam com nota cheia
  /**
   * Só vagas do seu nível exato. Escolheu Pleno: vaga que pede Júnior ou Sênior é zerada e sai da lista.
   * Vaga que NÃO diz o nível continua passando — o robô não tem como inventar o que o anúncio não escreveu,
   * e cortá-las apagaria metade do mercado.
   */
  senioridadeRigida: boolean;
  /**
   * Nichos que você não quer, mesmo sendo da sua função: "sap", "salesforce", "cobol"...
   * Vaga com um destes termos no TÍTULO é zerada e sai da lista. Só o título de propósito — uma vaga
   * full stack que cita SAP numa linha de integração não é uma vaga de SAP.
   */
  excluir: string[];
  presencialSoNaMinhaCidade: boolean; // presencial/híbrido fora da sua cidade nem entra na lista
  // manual: toda pergunta nova pausa · duvida: a IA resolve o que o currículo e o conhecimento técnico
  // sustentam e devolve o resto · sem_piedade: a IA responde tudo e nunca devolve
  modoPerguntas: 'manual' | 'duvida' | 'sem_piedade';
}

// ─── Descoberta de vagas (InHire) ────────────────────────────
export interface EmpresaInHire {
  subdominio: string; // <subdominio>.inhire.app
  nome: string;
  urlVagas: string;
  ativo: boolean;
  origem: 'seed' | 'manual' | 'busca';
  ultimaVerificacao: string | null; // ISO
  totalVagas: number; // vagas publicadas na última verificação
  falhas: number; // verificações seguidas com erro
  criadaEm: string;
}

/** Progresso da varredura em todas as plataformas (core/varredura.ts). Uma barra só, para o botão de buscar. */
export interface ProgressoVarredura {
  rodando: boolean;
  plataforma: string; // id da plataforma sendo varrida agora
  etapa: string; // o que está acontecendo, em português ("lendo o feed", "abrindo a vaga 12 de 40")
  atual: number;
  total: number; // 0 = tamanho desconhecido; a barra fica indeterminada
  feitas: string[];
  restantes: string[];
  novas: number; // vagas inéditas achadas nesta varredura
  conhecidas: number; // vagas que o robô já tinha: é o que garante que clicar de novo não repete
  iniciadaEm: string | null;
}

export interface ConfigDescoberta {
  intervaloHoras: number; // revarredura da lista de empresas (Fonte A)
  fonteB: boolean; // descoberta ativa de novas empresas via API de busca (1x/dia)
  googleCx: string; // ID do mecanismo (Programmable Search Engine)
  googleKeyDefinida: boolean; // a chave em si nunca sai do núcleo
  ultimaVarredura: string | null;
  ultimaFonteB: string | null;
  varrendo: boolean;
  descobrindo: boolean;
  progresso: { atual: number; total: number; empresa: string } | null; // durante a varredura
}

// ─── IA (adaptação de currículo) ─────────────────────────────
export type ProvedorIA = 'nenhum' | 'gemini' | 'anthropic';
export interface ConfigIA {
  provedor: ProvedorIA;
  modelo: string;
  chaveDefinida: boolean; // a chave em si nunca sai do núcleo
  chaveFinal: string; // últimos 4 caracteres, para reconhecer
}

// ─── Vagas e candidaturas ────────────────────────────────────
export type StatusVaga = 'encontrada' | 'na_fila' | 'em_andamento' | 'aguardando_pergunta' | 'aguardando_aprovacao' | 'enviada' | 'ensaio' | 'erro' | 'ignorada' | 'encerrada';
export type Regime = 'CLT' | 'PJ' | 'ambos' | 'indefinido';

export interface PerguntaExtra {
  rotulo: string;
  tipo: 'texto' | 'opcoes' | 'multipla' | 'arquivo'; // multipla = várias opções, resposta guardada como "A | B"
  opcoes?: string[];
  obrigatoria?: boolean; // false = o formulário avança sem resposta
  sensivel?: string; // categoria de autodeclaração (src/sensiveis.ts): a interface avisa e a resposta nunca é reaproveitada por similaridade
}

/** Estrutura do formulário descoberta na última tentativa (cache/diagnóstico) */
export interface ResumoFormulario {
  etapas: number;
  campos: number;
  perguntas: number; // perguntas extras respondidas
  typeform: boolean;
  incomum: boolean; // campo de tipo desconhecido ou muitas etapas: vale conferir a captura
}

export type Pendencia = { tipo: 'pergunta'; pergunta: PerguntaExtra } | { tipo: 'aprovacao'; original: string; adaptado: string; diff: string[] };

export interface Vaga {
  id: string;
  plataforma: string;
  tenant: string;
  titulo: string;
  empresa: string;
  descricao: string;
  requisitos: string;
  regime: Regime;
  senioridade?: string; // pedida pela vaga (Estágio…Liderança ou Indefinida)
  modelo: 'remoto' | 'hibrido' | 'presencial' | 'indefinido';
  local: string;
  pais?: string; // país da vaga quando a plataforma informa (nome de src/paises.ts); senão é lido de `local`
  url: string;
  skills: string[];
  camposConhecidos: string[];
  score: number;
  motivo?: string; // explicação do score (IA) ou resumo léxico
  adaptado?: { markdown: string; diff: string[]; viaIA: boolean; pdf?: string }; // última adaptação gerada para esta vaga
  status: StatusVaga;
  posicao?: number;
  pedidaPorVoce?: boolean; // você clicou em "Candidatar": nenhum filtro do robô (foco, score) tira esta da fila
  pendencia?: Pendencia;
  erro?: string;
  captura?: string; // captura de tela (ensaio/erro)
  formulario?: ResumoFormulario;
  decisaoPreview?: 'adaptado' | 'original';
  respostaTemporaria?: string; // rótulo da pergunta cuja resposta não deve ser guardada
  tentativas?: number; // falhas transitórias seguidas (rede, timeout): a vaga volta para a fila com espera crescente
  proximaTentativaEm?: string; // ISO: antes disso a fila não pega esta vaga de novo
  encontradaEm: string;
  atualizadaEm: string;
}

export interface Candidatura {
  id: number;
  vagaId: string;
  titulo: string;
  empresa: string;
  plataforma: string;
  url: string;
  enviadaEm: string;
  nome: string;
  email: string;
  celular: string;
  curriculo: string; // caminho do PDF enviado
  versao: 'original' | 'adaptada';
  regime: string;
  resultado: 'enviada' | 'ensaio';
}

/** Campo obrigatório que a extensão achou no formulário e o perfil não tem como responder. */
export interface CampoFaltando {
  pergunta: string;
  obrigatorio: boolean;
  /** A extensão não conseguiu decidir se é obrigatório — revise manualmente (política conservadora) */
  incerto?: boolean;
}

/** Plataforma que a extensão viu no seu navegador, tenha ou não adapter no núcleo. */
export interface PlataformaDetectada {
  dominio: string;
  /** null = a detecção não teve certeza */
  precisaLogin: boolean | null;
  logadoAtualmente: boolean;
  motivo: string;
  /** 'generico' ou o domínio do handler dedicado que atendeu */
  handler: string;
  /** O que é o botão de candidatura, lido SEM clicar nele (conteudo.js › reconhecerEnvio) */
  envio?: { tag: string; rotulo: string; href: string; classe: string; clicarEnvia: 'sim' | 'nao' | 'talvez'; form: { action: string; metodo: string; campos: string[] } | null };
  detectadaEm: string;
  camposFaltando?: CampoFaltando[];
  camposEm?: string;
}

// ─── Estado completo (o que o núcleo entrega ao front) ──────
export interface Estado {
  perfil: Perfil | null;
  curriculos: Arquivo[]; // o primeiro é o principal
  conexoes: Record<string, Conexao>;
  automacao: ConfigAutomacao;
  ia: ConfigIA;
  empresas: EmpresaInHire[];
  descoberta: ConfigDescoberta;
  varredura: ProgressoVarredura;
  robo: EstadoRobo;
  envios: Envio[];
  candidaturas: Candidatura[];
  vagas: Vaga[];
  fila: Vaga[];
  log: LinhaLog[];
  perguntas: Pergunta[];
  sensiveis: ConfigSensiveis; // política para perguntas de autodeclaração
  deteccoes: PlataformaDetectada[]; // o que a extensão de navegador relatou (core/extensao.ts)
  notificacoes: Record<string, boolean>;
  proximoEnvioEm: string | null;
  ultimaBusca: string | null;
}
