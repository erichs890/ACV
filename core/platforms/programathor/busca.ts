// Busca no ProgramaThor: a listagem filtrada dá os candidatos, o JSON-LD de cada vaga nova dá o resto.
// Sem login, sem navegador — só HTTP. Ver seletores.ts para o que foi confirmado no site.
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import type { PreferenciasLocalizacao } from '../../../src/paises.ts';
import type { Log } from '../adapter.ts';
import { kv, vagas } from '../../storage/db.ts';
import { emitir } from '../../events.ts';
import { passo, vistas } from '../../varredura.ts';
import { filtrosDaAutomacao } from '../../estado.ts';
import { calcularScore } from '../../resume/score.ts';
import { inferirSenioridade } from '../../resume/analyzer.ts';
import { extrairSkills } from '../../resume/texto.ts';
import { paisDoLocal, vagaCompativelComLocalizacao } from '../../localizacao.ts';
import { htmlParaTexto } from '../inhire/api.ts';
import { MAX_PAGINAS_POR_VARREDURA, MAX_VAGAS_POR_VARREDURA, PAUSA_ENTRE_PAGINAS_MS, PROGRAMATHOR } from './seletores.ts';

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface ItemListagem {
  id: string;
  slug: string;
  url: string;
}

/** As vagas listadas numa página. O card tem mais coisa, mas quem manda é o JSON-LD da página da vaga. */
export function lerListagem(html: string): ItemListagem[] {
  const vistos = new Set<string>();
  const itens: ItemListagem[] = [];
  for (const m of html.matchAll(/href="\/jobs\/(\d+)-([a-z0-9-]+)"/gi)) {
    if (vistos.has(m[1])) continue;
    vistos.add(m[1]);
    itens.push({ id: m[1], slug: m[2], url: `${PROGRAMATHOR.base}/jobs/${m[1]}-${m[2]}` });
  }
  return itens;
}

export interface JobPosting {
  title?: string;
  description?: string;
  employmentType?: string;
  datePosted?: string;
  validThrough?: string;
  jobLocationType?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
}

/**
 * Troca caracteres de controle por espaço.
 *
 * É uma função e não uma regex porque a faixa de controle dentro de uma expressão regular é ilegível — e o
 * linter a reprova, com razão. Assim dá para ler o que acontece.
 */
const semControle = (t: string) => Array.from(t, c => (c.charCodeAt(0) < 0x20 ? ' ' : c)).join('');

/**
 * O JobPosting da página.
 *
 * O `JSON.parse` direto falha: o site embute quebras de linha cruas dentro das strings da descrição, o que é
 * JSON inválido. Limpar os caracteres de controle antes de analisar resolve sem mascarar erro de verdade —
 * se o documento estivesse quebrado de outro jeito, continuaria lançando.
 */
export function lerJobPosting(html: string): JobPosting | null {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(semControle(m[1])) as JobPosting & { '@type'?: string };
      if (d['@type'] === 'JobPosting') return d;
    } catch {
      // outro bloco de dados estruturados (BreadcrumbList) ou JSON quebrado: segue para o próximo
    }
  }
  return null;
}

/** "São Paulo - SP" a partir do endereço do JSON-LD. */
export function localDe(jp: JobPosting): string {
  const a = jp.jobLocation?.address;
  const cidade = (a?.addressLocality ?? '').trim();
  const uf = (a?.addressRegion ?? '').trim();
  if (!cidade || cidade === '-') return jp.jobLocationType === 'TELECOMMUTE' ? 'Remoto' : '';
  return uf && uf !== '-' ? `${cidade} - ${uf}` : cidade;
}

/**
 * O modelo de trabalho.
 *
 * O JSON-LD NÃO traz isso: ele dá o endereço e nada mais, então uma vaga presencial em São Paulo chegaria
 * como 'indefinido' — e 'indefinido' escapa da regra de localização, que é exatamente o buraco por onde
 * sete presenciais fora do Ceará receberam currículo em 28/09. A página, porém, DIZ: "São Paulo (Híbrido)"
 * e "Modelo: Híbrido". É de lá que isto lê, e o texto da vaga fica como reserva.
 */
export function modeloDe(jp: JobPosting, html: string, titulo: string, descricao: string): Vaga['modelo'] {
  const declarado = html.match(/Modelo:\s*(Remoto|H[íi]brido|Presencial)/i)?.[1] ?? html.match(/Localiza[çc][ãa]o:[\s\S]{0,120}?\((Remoto|H[íi]brido|Presencial)\)/i)?.[1] ?? '';
  if (/remoto/i.test(declarado)) return 'remoto';
  if (/h[íi]brido/i.test(declarado)) return 'hibrido';
  if (/presencial/i.test(declarado)) return 'presencial';
  if (jp.jobLocationType === 'TELECOMMUTE') return 'remoto';
  const t = `${titulo}\n${descricao.slice(0, 1200)}`;
  if (/\bh[íi]brid[oa]\b/i.test(t)) return 'hibrido';
  if (/\b(100% remoto|totalmente remoto|remote first|trabalho remoto|remoto)\b/i.test(t)) return 'remoto';
  if (/\bpresencial\b/i.test(t)) return 'presencial';
  return 'indefinido';
}

const regimeDe = (jp: JobPosting, texto: string): Vaga['regime'] => {
  if (jp.employmentType === 'CONTRACTOR' || /\bPJ\b/.test(texto)) return 'PJ';
  return 'CLT';
};

export function montarVaga(item: ItemListagem, html: string, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao): Vaga | null {
  const jp = lerJobPosting(html);
  if (!jp) return null;
  if (PROGRAMATHOR.encerrada.test(html)) return null;
  if (jp.validThrough && new Date(jp.validThrough) < new Date()) return null;

  const titulo = htmlParaTexto(jp.title ?? '').trim();
  if (!titulo) return null;
  const descricao = htmlParaTexto(jp.description ?? '');
  const local = localDe(jp);
  const agora = new Date().toISOString();
  const vaga: Vaga = {
    id: `programathor:${item.id}`,
    plataforma: 'programathor',
    tenant: (jp.hiringOrganization?.name ?? '').trim().toLowerCase().replace(/\s+/g, '-') || 'empresa',
    titulo,
    empresa: (jp.hiringOrganization?.name ?? '').trim() || 'Empresa não informada',
    descricao,
    requisitos: '',
    regime: regimeDe(jp, `${titulo}\n${descricao.slice(0, 600)}`),
    senioridade: inferirSenioridade(titulo, descricao),
    modelo: modeloDe(jp, html, titulo, descricao),
    local,
    pais: paisDoLocal(local) || (jp.jobLocation?.address?.addressCountry === 'BR' ? 'Brasil' : ''),
    url: item.url,
    skills: extrairSkills(`${titulo}\n${descricao}`),
    camposConhecidos: [],
    score: 0,
    status: 'encontrada',
    encontradaEm: agora,
    atualizadaEm: agora,
  };
  const a = calcularScore(vaga, perfil, filtrosDaAutomacao(cfg, pref));
  vaga.score = a.score;
  vaga.motivo = a.motivo;
  if (!vagaCompativelComLocalizacao(vaga, pref).compativel || vaga.score < cfg.scoreMinimo) vaga.status = 'ignorada';
  return vaga;
}

/**
 * Os filtros da listagem, montados a partir da configuração do ACV.
 *
 * É o que torna esta varredura barata: em vez de ler 23 mil vagas do sitemap e descartar quase todas, o
 * próprio site já devolve só o recorte da pessoa. `?expertise=Pleno&remoto=true` sai de 23.509 para ~5.100.
 */
export function filtrosDoPerfil(cfg: ConfigAutomacao, perfil: PerfilBusca): { expertise?: string; remoto?: boolean } {
  const nivel = (cfg.senioridade || perfil.senioridade || '').trim();
  return {
    // O site só tem estes três; Estágio, Especialista e Liderança não existem como filtro lá
    expertise: ['Júnior', 'Pleno', 'Sênior'].includes(nivel) ? nivel : undefined,
    remoto: cfg.regimes?.includes('remoto') && !cfg.regimes.includes('presencial'),
  };
}

let buscando = false;

export async function buscarNoProgramaThor(perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log, pref: PreferenciasLocalizacao): Promise<Vaga[]> {
  if (buscando) return [];
  buscando = true;
  try {
    const filtros = filtrosDoPerfil(cfg, perfil);
    const candidatas: ItemListagem[] = [];
    let total = 0;
    for (let pagina = 1; pagina <= MAX_PAGINAS_POR_VARREDURA; pagina++) {
      passo('lendo a listagem filtrada', pagina, MAX_PAGINAS_POR_VARREDURA);
      const html = await (await fetch(PROGRAMATHOR.listagem(filtros, pagina))).text();
      const itens = lerListagem(html);
      if (!itens.length) break; // acabaram as páginas
      total += itens.length;
      candidatas.push(...itens.filter(i => !vagas.get(`programathor:${i.id}`)));
      if (pagina < MAX_PAGINAS_POR_VARREDURA) await dormir(PAUSA_ENTRE_PAGINAS_MS);
    }

    const escolhidas = candidatas.slice(0, MAX_VAGAS_POR_VARREDURA);
    vistas(total);
    log('info', `ProgramaThor: ${total} vaga(s) na listagem${filtros.expertise ? ` de ${filtros.expertise}` : ''}${filtros.remoto ? ' remotas' : ''}, ${escolhidas.length} nova(s) para abrir.`);

    const novas: Vaga[] = [];
    for (const [k, item] of escolhidas.entries()) {
      passo('abrindo as vagas novas', k + 1, escolhidas.length);
      if (k > 0) await dormir(PAUSA_ENTRE_PAGINAS_MS);
      try {
        const vaga = montarVaga(item, await (await fetch(item.url)).text(), perfil, cfg, pref);
        if (!vaga) continue;
        vagas.salvar(vaga);
        if (vaga.status === 'encontrada') novas.push(vaga);
      } catch (e) {
        log('alerta', `ProgramaThor: não consegui ler ${item.url} (${(e as Error).message.slice(0, 80)}).`);
      }
    }

    kv.set('programathor:ultimaBusca', new Date().toISOString());
    emitir({ tipo: 'estado' });
    return novas;
  } finally {
    buscando = false;
  }
}
