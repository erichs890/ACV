import type { Arquivo, ConfigAutomacao, Conexao, Envio, Estado, EstadoRobo, Perfil, Pergunta, Vaga } from '../src/types.ts';
import { candidaturas, empresas, kv, log, vagas } from './storage/db.ts';
import { emitir } from './events.ts';
import { iaParaFront } from './ia.ts';
import { descobertaParaFront } from './platforms/inhire/discovery.ts';
import { SENSIVEIS_PADRAO, type ConfigSensiveis } from '../src/sensiveis.ts';
import { lerDeteccoes } from './extensao.ts';
import { PAISES_REMOTO_PADRAO, type PreferenciasLocalizacao } from '../src/paises.ts';

export const AUTOMACAO_PADRAO: ConfigAutomacao = {
  configurada: false,
  area: '',
  senioridade: '',
  regimes: ['remoto', 'hibrido', 'presencial'],
  intervaloSegundos: 180,
  limiteDiario: 20,
  janela: '08:00-20:00',
  modo: 'manual',
  adaptar: true,
  preview: 'mostrar',
  regimePreferido: 'CLT',
  ensaio: true,
  mostrarNavegador: false,
  navegador: 'edge',
  scoreMinimo: 30,
  cargoRigido: false,
  presencialSoNaMinhaCidade: true,
  modoPerguntas: 'manual',
};

const PERGUNTAS_PADRAO: Pergunta[] = [
  { id: 1, icone: 'salario', pergunta: 'Pretensão salarial', resposta: '', personalizada: false },
  { id: 2, icone: 'experiencia', pergunta: 'Anos de experiência', resposta: '', personalizada: false },
  { id: 3, icone: 'viagem', pergunta: 'Disponibilidade para viagem', resposta: '', personalizada: false },
  { id: 4, icone: 'remoto', pergunta: 'Pretende trabalhar remoto?', resposta: '', personalizada: false },
  { id: 5, icone: 'cnh', pergunta: 'Possui CNH?', resposta: '', personalizada: false },
  { id: 6, icone: 'inicio', pergunta: 'Disponibilidade de início', resposta: '', personalizada: false },
  { id: 7, icone: 'ingles', pergunta: 'Nível de inglês', resposta: '', personalizada: false },
  { id: 8, icone: 'pcd', pergunta: 'Possui deficiência (PcD)?', resposta: '', personalizada: false },
];

const FILA = new Set<Vaga['status']>(['na_fila', 'em_andamento', 'aguardando_pergunta', 'aguardando_aprovacao']);

export const ler = {
  perfil: () => kv.get<Perfil | null>('perfil', null),
  curriculos: () => kv.get<Arquivo[]>('curriculos', []),
  conexoes: () => kv.get<Record<string, Conexao>>('conexoes', {}),
  automacao: (): ConfigAutomacao => {
    // Só as chaves que existem hoje: campo removido do produto continua no blob gravado e voltaria a aparecer
    // no front como se ainda valesse algo. O padrão define o que é configuração; o resto é resíduo.
    const salvo = kv.get<Record<string, unknown>>('automacao', {});
    const atual = { ...AUTOMACAO_PADRAO } as Record<string, unknown>;
    for (const chave of Object.keys(AUTOMACAO_PADRAO)) if (salvo[chave] !== undefined) atual[chave] = salvo[chave];
    return atual as unknown as ConfigAutomacao;
  },
  robo: () => kv.get<EstadoRobo>('robo', 'pausado'),
  perguntas: () => kv.get<Pergunta[]>('perguntas', PERGUNTAS_PADRAO),
  localizacao: (): PreferenciasLocalizacao => {
    const p = kv.get<Perfil | null>('perfil', null);
    return { localizacaoPresencial: p?.cidade ?? '', paisesRemoto: p?.paisesRemoto ?? PAISES_REMOTO_PADRAO };
  },
  sensiveis: () => ({ ...SENSIVEIS_PADRAO, ...kv.get<Partial<ConfigSensiveis>>('sensiveis', {}) }),
  notificacoes: () => kv.get<Record<string, boolean>>('notificacoes', {}),
  proximoEnvioEm: () => kv.get<string | null>('proximoEnvioEm', null),
  ultimaBusca: () => kv.get<string | null>('ultimaBusca', null),
};

// Chaves que o front pode gravar direto (o resto é derivado ou controlado pelo núcleo)
const GRAVAVEIS = ['perfil', 'curriculos', 'conexoes', 'automacao', 'robo', 'perguntas', 'sensiveis', 'notificacoes'] as const;

export function salvarParcial(parcial: Partial<Estado>) {
  for (const chave of GRAVAVEIS) if (chave in parcial) kv.set(chave, parcial[chave]);
  emitir({ tipo: 'estado' });
}

export function montarEstado(): Estado {
  const todas = vagas.listar();
  const lista = candidaturas.listar();
  const envios: Envio[] = lista.map(c => {
    const d = new Date(c.enviadaEm);
    return {
      id: c.id,
      vaga: c.titulo,
      empresa: c.empresa,
      plataforma: c.plataforma,
      data: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      hora: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      status: c.resultado === 'ensaio' ? 'Pendente' : 'Enviado',
    };
  });
  return {
    perfil: ler.perfil(),
    curriculos: ler.curriculos(),
    conexoes: ler.conexoes(),
    automacao: ler.automacao(),
    ia: iaParaFront(),
    empresas: empresas.listar(),
    descoberta: descobertaParaFront(),
    robo: ler.robo(),
    envios,
    candidaturas: lista,
    vagas: todas,
    fila: todas.filter(v => FILA.has(v.status)).sort((a, b) => (a.posicao ?? 0) - (b.posicao ?? 0)),
    log: log.listar(),
    perguntas: ler.perguntas(),
    sensiveis: ler.sensiveis(),
    deteccoes: lerDeteccoes(),
    notificacoes: ler.notificacoes(),
    proximoEnvioEm: ler.proximoEnvioEm(),
    ultimaBusca: ler.ultimaBusca(),
  };
}
