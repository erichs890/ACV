import type { ConfigAutomacao, PerfilBusca, PerguntaExtra, ResumoFormulario, Vaga } from '../../src/types.ts';
import type { ProvaDeLogin } from '../sessao.ts';

export type Log = (tipo: 'sucesso' | 'info' | 'aguardo' | 'erro' | 'alerta', msg: string) => void;

// Perguntas cuja resposta vai para o perfil (Configurações → Meus Dados), não para as perguntas automáticas
export const PERGUNTA_CIDADE = 'Sua cidade e estado, como a vaga pede (ex.: Campinas - SP)';
export const PERGUNTA_CPF = 'Seu CPF (a vaga exige; fica só no seu computador)';

export interface DadosCandidatura {
  nome: string;
  email: string;
  celular: string;
  linkedin: string;
  cidade: string; // "Cidade - UF" do perfil, para vagas que pedem localização
  cpf: string;
  pretensao: string;
  regime: 'CLT' | 'PJ' | null; // null = a plataforma não pediu ou ficou indefinido
  curriculoPdf: string; // caminho do PDF a anexar (original ou adaptado)
  /** Resposta salva para uma pergunta extra; null = não sabemos, pausar e perguntar ao usuário */
  responder: (pergunta: PerguntaExtra) => string | null;
  ensaio: boolean; // preenche tudo mas não envia
  mostrarNavegador: boolean;
}

/**
 * A prova de que a vaga recebeu: a resposta HTTP do envio (invariante 1).
 *
 * Existia só como frase no log ("O InHire aceitou a candidatura (201 em /apply)") e isso já me custou uma
 * resposta errada: perguntado se havia candidaturas duplicadas, eu não tinha como cruzar envio com resposta
 * do servidor e disse que sim — eram pares de ensaio + real. Como dado, dá para contar.
 *
 * Ausente num `enviada` significa algo diferente de "falhou": significa que a confirmação veio do texto da
 * própria plataforma, não da rede. É uma distinção que importa na hora de investigar, então ela fica visível.
 */
export type ProvaDeEnvio = { metodo: string; rota: string; http: number };

export type ResultadoCandidatura =
  | { status: 'enviada'; formulario?: ResumoFormulario; prova?: ProvaDeEnvio }
  | { status: 'ensaio'; captura: string; pronto: boolean; observacao?: string; formulario?: ResumoFormulario } // pronto = a plataforma liberou o botão de envio
  | { status: 'pergunta'; pergunta: PerguntaExtra }
  | { status: 'erro'; motivo: string; captura?: string; formulario?: ResumoFormulario };

export interface OpcoesBusca {
  /** A pessoa clicou em "Buscar vagas agora" (plataformas com limite de varredura automática podem ignorá-lo) */
  manual?: boolean;
}

// Cada plataforma implementa isto. O núcleo (fila, currículo, confirmação) não sabe nada de InHire.
export interface PlatformAdapter {
  id: string;
  nome: string;
  buscarVagas(perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log, opcoes?: OpcoesBusca): Promise<Vaga[]>;
  /** Ausente só em plataforma `somenteDescoberta` — ver abaixo. */
  candidatar?(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura>;
  /**
   * Esta plataforma o ACV só ACHA e ranqueia: nunca candidata, nem com preenchimento assistido.
   *
   * É uma declaração, e não "o método está faltando": método ausente pode ser esquecimento de quem escreveu
   * o adapter; declaração explícita, não. `motivoSomenteDescoberta` é o texto que a tela e o log mostram,
   * para a pessoa nunca ficar sem saber por que não existe botão de enviar ali.
   *
   * Primeiro caso: o Jobbol, cujos termos de uso (5.3) proíbem candidatura automatizada ou em massa.
   */
  somenteDescoberta?: true;
  motivoSomenteDescoberta?: string;
  /** Perguntas que a vaga com certeza vai fazer (schema via API), para resolver antes de abrir o navegador. */
  perguntasPrevias?(vaga: Vaga): Promise<PerguntaExtra[]>;
  /** Plataforma com login: onde entrar e como provar que a sessão do navegador do robô está ativa (core/sessao.ts). */
  sessao?: ProvaDeLogin;
}

export const adapters: Record<string, PlatformAdapter> = {};

/**
 * Esta plataforma é só de descoberta? A pergunta que todo ponto de uso faz — uma função, para não existirem
 * duas formas de perguntar a mesma coisa e uma delas ficar desatualizada.
 *
 * Plataforma desconhecida devolve `false`: quem trata "não tenho adapter para isso" é quem chama, com a
 * mensagem própria dele.
 */
export const soDescobre = (plataforma: string): boolean => {
  const a = adapters[plataforma];
  return !!a && (a.somenteDescoberta === true || !a.candidatar);
};
export const registrarAdapter = (a: PlatformAdapter) => {
  adapters[a.id] = a;
};
