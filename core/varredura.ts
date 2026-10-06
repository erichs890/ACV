// Progresso da varredura, compartilhado por todas as plataformas.
//
// Existia só para o InHire (`descoberta.progresso`, que conta empresas) e ficava numa tela diferente do botão
// que dispara a busca. As outras seis plataformas varriam em silêncio: clicar em "Buscar vagas agora" não dava
// sinal de vida nenhum até tudo terminar.
//
// Aqui o estado é um singleton de módulo, como `emitir`: o adapter chama `passo()` no ponto natural dele
// (li o feed, estou na vaga 12 de 40) sem precisar receber mais um parâmetro na assinatura.
import type { PassoDaPlataforma, ProgressoVarredura } from '../src/types.ts';
import { emitir } from './events.ts';
import { evento } from './diario.ts';

const VAZIO: ProgressoVarredura = { rodando: false, plataforma: '', etapa: '', atual: 0, total: 0, feitas: [], restantes: [], novas: 0, conhecidas: 0, iniciadaEm: null, porPlataforma: {} };

let atual: ProgressoVarredura = { ...VAZIO };

export const lerVarredura = (): ProgressoVarredura => ({ ...atual, feitas: [...atual.feitas], restantes: [...atual.restantes], porPlataforma: { ...atual.porPlataforma } });

/** Começa uma varredura. `plataformas` é a fila inteira, para a tela saber o tamanho do trabalho desde o início. */
export function iniciarVarredura(plataformas: string[]): void {
  // Toda plataforma da fila nasce em `espera`: a tela de mapeamento precisa listar as que AINDA não começaram,
  // senão ela só mostra o fim da história e a pessoa não vê o trabalho acontecendo.
  const porPlataforma: Record<string, PassoDaPlataforma> = {};
  for (const id of plataformas) porPlataforma[id] = { estado: 'espera', etapa: '', atual: 0, total: 0, novas: 0, conhecidas: 0 };
  atual = { ...VAZIO, rodando: true, restantes: [...plataformas], iniciadaEm: new Date().toISOString(), porPlataforma };
  emitir({ tipo: 'estado' });
}

/** Passa para a próxima plataforma da fila. */
export function plataformaAtual(id: string): void {
  if (!atual.rodando) return;
  comecouEm = Date.now();
  atual = {
    ...atual,
    plataforma: id,
    etapa: 'começando',
    atual: 0,
    total: 0,
    restantes: atual.restantes.filter(p => p !== id),
    porPlataforma: { ...atual.porPlataforma, [id]: { ...(atual.porPlataforma[id] ?? VAZIO_DA_PLATAFORMA), estado: 'varrendo', etapa: 'começando' } },
  };
  emitir({ tipo: 'estado' });
}

const VAZIO_DA_PLATAFORMA: PassoDaPlataforma = { estado: 'espera', etapa: '', atual: 0, total: 0, novas: 0, conhecidas: 0 };
let comecouEm = 0;

/**
 * Onde a plataforma está agora. `total` 0 = trabalho de tamanho desconhecido (a barra vira indeterminada).
 * Só emite quando algo muda de verdade: a varredura do Divulga Vagas abre 40 páginas e não vale um evento por
 * byte lido.
 */
export function passo(etapa: string, atualN = 0, total = 0): void {
  if (!atual.rodando) return;
  if (atual.etapa === etapa && atual.atual === atualN && atual.total === total) return;
  const id = atual.plataforma;
  atual = {
    ...atual,
    etapa,
    atual: atualN,
    total,
    porPlataforma: id ? { ...atual.porPlataforma, [id]: { ...(atual.porPlataforma[id] ?? VAZIO_DA_PLATAFORMA), estado: 'varrendo', etapa, atual: atualN, total } } : atual.porPlataforma,
  };
  emitir({ tipo: 'estado' });
}

/**
 * Quantas vagas a plataforma examinou nesta rodada (novas + as que já estavam no banco).
 *
 * Não dá para deduzir isso do que o adapter devolve: ele devolve só as inéditas. Sem este número a tela não
 * consegue responder "clicar de novo vai repetir?", que é justamente a pergunta que a barra existe para matar.
 */
let vistasNaPlataforma = 0;
export function vistas(n: number): void {
  vistasNaPlataforma = n;
}

/**
 * Fecha a plataforma atual com o que ela trouxe. `conhecidas` são as que já estavam no banco.
 *
 * `erro` é opcional e existe para o relato: plataforma que varre e devolve zero por semanas é indistinguível,
 * no log de texto, de plataforma que está quebrada — as duas simplesmente não aparecem.
 */
export function terminarPlataforma(id: string, novas: number, erro?: string): void {
  if (!atual.rodando) return;
  const conhecidas = Math.max(0, vistasNaPlataforma - novas);
  evento('varredura.plataforma', { plataforma: id, dados: { vistas: vistasNaPlataforma, novas, conhecidas, erro: erro ?? null } });
  vistasNaPlataforma = 0;
  atual = {
    ...atual,
    feitas: [...atual.feitas, id],
    novas: atual.novas + novas,
    conhecidas: atual.conhecidas + conhecidas,
    etapa: '',
    atual: 0,
    total: 0,
    porPlataforma: {
      ...atual.porPlataforma,
      [id]: {
        ...(atual.porPlataforma[id] ?? VAZIO_DA_PLATAFORMA),
        estado: erro ? 'erro' : 'pronta',
        etapa: '',
        atual: 0,
        total: 0,
        novas,
        conhecidas,
        erro,
        duracaoMs: comecouEm ? Date.now() - comecouEm : undefined,
      },
    },
  };
  emitir({ tipo: 'estado' });
}

/** Fim. O resumo continua legível na tela até a próxima varredura começar. */
export function terminarVarredura(): void {
  atual = { ...atual, rodando: false, plataforma: '', etapa: '', atual: 0, total: 0, restantes: [] };
  emitir({ tipo: 'estado' });
}
