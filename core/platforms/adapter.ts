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

export type ResultadoCandidatura =
  | { status: 'enviada'; formulario?: ResumoFormulario }
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
  candidatar(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura>;
  /** Perguntas que a vaga com certeza vai fazer (schema via API), para resolver antes de abrir o navegador. */
  perguntasPrevias?(vaga: Vaga): Promise<PerguntaExtra[]>;
  /** Plataforma com login: onde entrar e como provar que a sessão do navegador do robô está ativa (core/sessao.ts). */
  sessao?: ProvaDeLogin;
}

export const adapters: Record<string, PlatformAdapter> = {};
export const registrarAdapter = (a: PlatformAdapter) => {
  adapters[a.id] = a;
};
