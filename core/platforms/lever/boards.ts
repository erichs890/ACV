// Quais empresas usam o Lever — a única pergunta caríssima desta plataforma.
//
// O Lever não publica índice de boards: `jobs.lever.co/sitemap.xml` é 404, a raiz é a página institucional e
// não lista ninguém, e o Common Crawl (que é como o InHire descobre empresas) devolveu **504 em todas as
// coleções** quando consultado para `url=jobs.lever.co/*` em 06/10/2026. Então a descoberta aqui é pelo
// avesso: candidato → confirmação na própria API pública, que responde 200 para board que existe e 404 para o
// que não existe.
//
// **Confirmar na API não basta, e isso custou uma descoberta errada.** O board `aircall` devolve 77 vagas na
// API e **404 na página do board e na página de cada vaga**: é dado velho servido por uma API que não checa se
// o mural ainda está publicado. Vaga que não abre é vaga em que não se candidata — pior que não achar, porque
// ela entraria na lista com nota e ocuparia o lugar de uma real. Por isso `confirmarBoard` exige as DUAS
// coisas: a API responder e a página do board estar no ar.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Log } from '../adapter.ts';
import { boards } from '../boards.ts';
import { kv } from '../../storage/db.ts';
import { LEVER, PAUSA_ENTRE_BOARDS_MS } from './seletores.ts';

export const boardsLever = boards('lever');

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));
const UA = { 'user-agent': 'ACV/1.0 (uso pessoal)' };

/** Uma vaga como a API pública do Lever a devolve. Campos conferidos em 157 vagas de 5 boards (ver seletores). */
export interface VagaLever {
  id: string;
  text: string;
  country?: string;
  workplaceType?: string;
  createdAt?: number;
  hostedUrl: string;
  applyUrl?: string;
  openingPlain?: string;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: { text?: string; content?: string }[];
  categories?: {
    commitment?: string;
    department?: string;
    location?: string;
    team?: string;
    allLocations?: string[];
  };
}

/** Aceita "neon", "jobs.lever.co/neon", a URL de uma vaga ou a do formulário. */
export function extrairSlug(entrada: string): string {
  const s = entrada.trim();
  const naUrl = s.match(/jobs\.lever\.co\/([a-zA-Z0-9][a-zA-Z0-9._-]*)/i);
  const cru = naUrl ? naUrl[1] : s.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  return cru.toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

/** As vagas publicadas num board, ou `null` quando a API diz que o board não existe (404). */
export async function vagasDoBoard(slug: string): Promise<VagaLever[] | null> {
  const r = await fetch(LEVER.api(slug), { headers: UA, signal: AbortSignal.timeout(25000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`a API do Lever respondeu HTTP ${r.status}`);
  const j = (await r.json()) as unknown;
  if (!Array.isArray(j)) throw new Error('a API do Lever não devolveu uma lista de vagas');
  return j as VagaLever[];
}

/** A página do board está publicada? É o que separa board vivo de dado velho na API (caso `aircall`). */
export async function paginaDoBoardViva(slug: string): Promise<boolean> {
  try {
    const r = await fetch(LEVER.urlBoard(slug), { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** O nome que a empresa usa no board, lido do `<title>` da página dela. Vazio quando não der para ler. */
export async function nomeDoBoard(slug: string): Promise<string> {
  try {
    const h = await (await fetch(LEVER.urlBoard(slug), { headers: UA, signal: AbortSignal.timeout(25000) })).text();
    return (h.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/\s*\|\s*Lever\s*$/i, '')
      .trim();
  } catch {
    return '';
  }
}

/**
 * Confere um candidato e devolve o nome da empresa, ou lança dizendo por que não serve.
 *
 * Lança em vez de devolver `null` porque este é o caminho do "adicionar empresa": quem clicou precisa ler o
 * motivo. A descoberta em massa chama isto dentro de um `try` e conta as recusas sem poluir o log.
 */
export async function confirmarBoard(entrada: string): Promise<{ slug: string; nome: string; vagas: number }> {
  const slug = extrairSlug(entrada);
  if (!slug) throw new Error('informe o board como em jobs.lever.co/<empresa>');
  const lista = await vagasDoBoard(slug);
  if (lista === null) throw new Error(`jobs.lever.co/${slug} não existe no Lever`);
  if (!(await paginaDoBoardViva(slug))) throw new Error(`a API conhece ${slug}, mas a página jobs.lever.co/${slug} não está no ar — as vagas dela não abrem`);
  return { slug, nome: (await nomeDoBoard(slug)) || slug, vagas: lista.length };
}

/** Adiciona um board já confirmado. Lança se ele já estiver na lista. */
export async function adicionarBoard(entrada: string, origem: 'manual' | 'busca', log?: Log): Promise<{ slug: string; nome: string; vagas: number }> {
  const slug = extrairSlug(entrada);
  if (boardsLever.get(slug)) throw new Error(`${slug} já está na lista`);
  const confirmado = await confirmarBoard(entrada);
  boardsLever.inserir(confirmado.slug, confirmado.nome, origem);
  log?.('sucesso', `Nova empresa no Lever: ${confirmado.nome} (jobs.lever.co/${confirmado.slug}), ${confirmado.vagas} vaga(s) publicadas.`);
  return confirmado;
}

// ─── Semente ───
const SEED_VERSAO = 1; // suba quando o JSON ganhar boards: os que faltam entram, e o que você removeu não volta

/** Carrega os boards da lista inicial que ainda não estão cadastrados. Uma vez por versão da semente. */
export function importarSeedLever(log?: Log, forcar = false): number {
  if (!forcar && kv.get<number>('lever:seedVersao', 0) >= SEED_VERSAO) return 0;
  const caminho = join(dirname(fileURLToPath(import.meta.url)), 'seed_boards_lever.json');
  const seed = JSON.parse(readFileSync(caminho, 'utf8')) as { boards: { slug: string; nome: string }[] };
  let novos = 0;
  for (const b of seed.boards) if (boardsLever.inserir(b.slug, b.nome, 'seed')) novos++;
  kv.set('lever:seedVersao', SEED_VERSAO);
  if (novos) log?.('info', `${novos} empresa(s) do Lever carregadas da lista inicial.`);
  return novos;
}

// ─── Descoberta de boards novos ───
/**
 * Os estudos de caso do próprio Lever (`lever.co/case-studies/<slug>`), confirmados na API.
 *
 * É a única fonte pública que existe: o sitemap de `www.lever.co` lista os clientes que o Lever publica como
 * referência, e o slug do estudo de caso costuma ser o slug do board. "Costuma" é o suficiente porque quem
 * decide é a API — um slug que não vira board é descartado sem custo.
 *
 * O que esta fonte NÃO faz, e é honesto dizer: ela acha empresas que o Lever escolheu divulgar, quase todas
 * dos Estados Unidos. As brasileiras (CI&T, Neon, Swile, Zippi, dLocal) não vieram daqui — vieram de testar
 * nomes de empresas de tecnologia do Brasil contra a API, uma a uma, e estão na semente. Para as próximas, o
 * caminho é adicionar à mão quando você topar com um `jobs.lever.co/<empresa>`.
 */
export async function candidatosDoLever(log: Log): Promise<string[]> {
  try {
    const xml = await (await fetch('https://www.lever.co/sitemap.xml', { headers: UA, signal: AbortSignal.timeout(30000) })).text();
    const slugs = [...xml.matchAll(/<loc>https:\/\/www\.lever\.co\/case-studies\/([a-z0-9-]+)<\/loc>/gi)].map(m => m[1]);
    return [...new Set(slugs)];
  } catch (e) {
    log('alerta', `Lever: não consegui ler a lista de clientes do site deles (${(e as Error).message}).`);
    return [];
  }
}

let descobrindo = false;

/** Procura boards novos, confirma cada um e cadastra os que passam. Devolve quantos entraram. */
export async function descobrirBoardsLever(log: Log): Promise<number> {
  if (descobrindo) return 0;
  descobrindo = true;
  try {
    const candidatos = (await candidatosDoLever(log)).filter(s => !boardsLever.get(s));
    if (!candidatos.length) return 0;
    log('info', `Lever: conferindo ${candidatos.length} empresa(s) que ainda não conheço...`);
    let novos = 0;
    for (const s of candidatos) {
      try {
        await adicionarBoard(s, 'busca', log);
        novos++;
      } catch {
        // não é board, ou é board morto: a recusa em massa não vale uma linha de log cada
      }
      await dormir(PAUSA_ENTRE_BOARDS_MS);
    }
    kv.set('lever:ultimaDescoberta', new Date().toISOString());
    return novos;
  } finally {
    descobrindo = false;
  }
}
