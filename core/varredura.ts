// Progresso da varredura, compartilhado por todas as plataformas.
//
// Existia só para o InHire (`descoberta.progresso`, que conta empresas) e ficava numa tela diferente do botão
// que dispara a busca. As outras seis plataformas varriam em silêncio: clicar em "Buscar vagas agora" não dava
// sinal de vida nenhum até tudo terminar.
//
// Aqui o estado é um singleton de módulo, como `emitir`: o adapter chama `passo()` no ponto natural dele
// (li o feed, estou na vaga 12 de 40) sem precisar receber mais um parâmetro na assinatura.
import type { ProgressoVarredura } from '../src/types.ts';
import { emitir } from './events.ts';

const VAZIO: ProgressoVarredura = { rodando: false, plataforma: '', etapa: '', atual: 0, total: 0, feitas: [], restantes: [], novas: 0, conhecidas: 0, iniciadaEm: null };

let atual: ProgressoVarredura = { ...VAZIO };

export const lerVarredura = (): ProgressoVarredura => ({ ...atual, feitas: [...atual.feitas], restantes: [...atual.restantes] });

/** Começa uma varredura. `plataformas` é a fila inteira, para a tela saber o tamanho do trabalho desde o início. */
export function iniciarVarredura(plataformas: string[]): void {
  atual = { ...VAZIO, rodando: true, restantes: [...plataformas], iniciadaEm: new Date().toISOString() };
  emitir({ tipo: 'estado' });
}

/** Passa para a próxima plataforma da fila. */
export function plataformaAtual(id: string): void {
  if (!atual.rodando) return;
  atual = { ...atual, plataforma: id, etapa: 'começando', atual: 0, total: 0, restantes: atual.restantes.filter(p => p !== id) };
  emitir({ tipo: 'estado' });
}

/**
 * Onde a plataforma está agora. `total` 0 = trabalho de tamanho desconhecido (a barra vira indeterminada).
 * Só emite quando algo muda de verdade: a varredura do Divulga Vagas abre 40 páginas e não vale um evento por
 * byte lido.
 */
export function passo(etapa: string, atualN = 0, total = 0): void {
  if (!atual.rodando) return;
  if (atual.etapa === etapa && atual.atual === atualN && atual.total === total) return;
  atual = { ...atual, etapa, atual: atualN, total };
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

/** Fecha a plataforma atual com o que ela trouxe. `conhecidas` são as que já estavam no banco. */
export function terminarPlataforma(id: string, novas: number): void {
  if (!atual.rodando) return;
  const conhecidas = Math.max(0, vistasNaPlataforma - novas);
  vistasNaPlataforma = 0;
  atual = {
    ...atual,
    feitas: [...atual.feitas, id],
    novas: atual.novas + novas,
    conhecidas: atual.conhecidas + conhecidas,
    etapa: '',
    atual: 0,
    total: 0,
  };
  emitir({ tipo: 'estado' });
}

/** Fim. O resumo continua legível na tela até a próxima varredura começar. */
export function terminarVarredura(): void {
  atual = { ...atual, rodando: false, plataforma: '', etapa: '', atual: 0, total: 0, restantes: [] };
  emitir({ tipo: 'estado' });
}
