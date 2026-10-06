// Quais empresas usam o Greenhouse — mesma pergunta cara do Lever, e a mesma resposta pelo avesso.
//
// Não há índice público de boards: a API responde por empresa e o site não lista clientes. Então é candidato →
// confirmação na API, com a lista inicial em `seed_boards_greenhouse.json` e o "adicionar" para quando você
// topar com um `job-boards.greenhouse.io/<empresa>` por aí.
//
// **Confirmar na API não basta**, e aqui a razão é diferente da do Lever: `coinbase` e `sofi` respondem 200 na
// API e **403 na página do board e na da vaga** — bloqueio por impressão digital do cliente, o mesmo padrão
// que reprovou o Jobbol (403 no Node, 200 no curl, mesmo IP e mesmo segundo). Vaga cuja página não abre é
// vaga em que não se candidata, e insistir ali seria disfarçar o cliente. Os dois ficam de fora, e a
// confirmação exige a página no ar.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Log } from '../adapter.ts';
import { boards } from '../boards.ts';
import { kv } from '../../storage/db.ts';
import { GREENHOUSE } from './seletores.ts';

export const boardsGreenhouse = boards('greenhouse');

const UA = { 'user-agent': 'ACV/1.0 (uso pessoal)' };

/** Uma vaga como a API pública do Greenhouse a devolve (ver o levantamento em `seletores.ts`). */
export interface VagaGreenhouse {
  id: number;
  title: string;
  company_name?: string;
  absolute_url: string;
  /** HTML do anúncio, **duas vezes escapado** (`&lt;p&gt;`). */
  content?: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
  offices?: { name?: string; location?: string }[];
  departments?: ({ name?: string } | string)[];
  metadata?: { name?: string; value?: unknown }[];
}

/** Aceita "quintoandar", "job-boards.greenhouse.io/quintoandar" ou a URL de uma vaga. */
export function extrairSlug(entrada: string): string {
  const s = entrada.trim();
  const naUrl = s.match(/(?:job-boards|boards)\.greenhouse\.io\/([a-zA-Z0-9][a-zA-Z0-9._-]*)/i);
  const cru = naUrl ? naUrl[1] : s.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  return cru.toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

/** As vagas de um board (com o anúncio inteiro), ou `null` quando a API diz que o board não existe. */
export async function vagasDoBoard(slug: string, comConteudo = true): Promise<VagaGreenhouse[] | null> {
  const r = await fetch(comConteudo ? GREENHOUSE.api(slug) : GREENHOUSE.apiLeve(slug), { headers: UA, signal: AbortSignal.timeout(45000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`a API do Greenhouse respondeu HTTP ${r.status}`);
  const j = (await r.json()) as { jobs?: unknown };
  if (!Array.isArray(j.jobs)) throw new Error('a API do Greenhouse não devolveu uma lista de vagas');
  return j.jobs as VagaGreenhouse[];
}

/** A página do board abre? É o que separa board usável de board atrás de bloqueio (casos `coinbase`/`sofi`). */
export async function paginaDoBoardViva(slug: string): Promise<boolean> {
  try {
    return (await fetch(GREENHOUSE.urlBoard(slug), { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(25000) })).ok;
  } catch {
    return false;
  }
}

/** Confere um candidato e devolve o nome da empresa, ou lança dizendo por que não serve. */
export async function confirmarBoard(entrada: string): Promise<{ slug: string; nome: string; vagas: number }> {
  const slug = extrairSlug(entrada);
  if (!slug) throw new Error('informe o board como em job-boards.greenhouse.io/<empresa>');
  const lista = await vagasDoBoard(slug, false);
  if (lista === null) throw new Error(`job-boards.greenhouse.io/${slug} não existe no Greenhouse`);
  if (!(await paginaDoBoardViva(slug))) throw new Error(`a API conhece ${slug}, mas a página job-boards.greenhouse.io/${slug} não abre para o ACV — as vagas dela não seriam alcançáveis`);
  // `company_name` vem pronto na vaga, com espaço sobrando em alguns boards ("Arco Educação ")
  return { slug, nome: (lista[0]?.company_name ?? '').trim() || slug, vagas: lista.length };
}

/** Adiciona um board já confirmado. Lança se ele já estiver na lista. */
export async function adicionarBoard(entrada: string, origem: 'manual' | 'busca', log?: Log): Promise<{ slug: string; nome: string; vagas: number }> {
  const slug = extrairSlug(entrada);
  if (boardsGreenhouse.get(slug)) throw new Error(`${slug} já está na lista`);
  const confirmado = await confirmarBoard(entrada);
  boardsGreenhouse.inserir(confirmado.slug, confirmado.nome, origem);
  log?.('sucesso', `Nova empresa no Greenhouse: ${confirmado.nome} (job-boards.greenhouse.io/${confirmado.slug}), ${confirmado.vagas} vaga(s) publicadas.`);
  return confirmado;
}

// ─── Semente ───
const SEED_VERSAO = 1; // suba quando o JSON ganhar boards: os que faltam entram, e o que você removeu não volta

/** Carrega os boards da lista inicial que ainda não estão cadastrados. Uma vez por versão da semente. */
export function importarSeedGreenhouse(log?: Log, forcar = false): number {
  if (!forcar && kv.get<number>('greenhouse:seedVersao', 0) >= SEED_VERSAO) return 0;
  const caminho = join(dirname(fileURLToPath(import.meta.url)), 'seed_boards_greenhouse.json');
  const seed = JSON.parse(readFileSync(caminho, 'utf8')) as { boards: { slug: string; nome: string }[] };
  let novos = 0;
  for (const b of seed.boards) if (boardsGreenhouse.inserir(b.slug, b.nome, 'seed')) novos++;
  kv.set('greenhouse:seedVersao', SEED_VERSAO);
  if (novos) log?.('info', `${novos} empresa(s) do Greenhouse carregadas da lista inicial.`);
  return novos;
}
