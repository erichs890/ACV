// Busca no Vagas PJ: o feed RSS dá a lista, a página de cada vaga nova dá o resto (JSON-LD JobPosting).
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
import { MAX_VAGAS_POR_VARREDURA, PAUSA_ENTRE_PAGINAS_MS, VAGASPJ } from './seletores.ts';

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface ItemFeed {
  id: string; // número da vaga na URL
  empresaSlug: string;
  url: string;
  titulo: string;
}

/** Itens do feed RSS. O título vem "Cargo – Empresa"; quem manda mesmo é o JSON-LD da página. */
export function lerFeed(xml: string): ItemFeed[] {
  const itens: ItemFeed[] = [];
  for (const bloco of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const url = (bloco.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim().replace(/\\\//g, '/');
    const m = url.match(VAGASPJ.urlVaga);
    if (!m) continue;
    itens.push({ id: m[2], empresaSlug: m[1], url, titulo: htmlParaTexto((bloco.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\\\//g, '/')).trim() });
  }
  return itens;
}

export interface JobPosting {
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  jobLocationType?: string;
  occupationalCategory?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
}

/** O JobPosting do `application/ld+json` da página (ele vem dentro de um `@graph`). */
export function lerJobPosting(html: string): JobPosting | null {
  for (const bloco of html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g) ?? []) {
    const cru = bloco.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    try {
      const dado = JSON.parse(cru) as { '@graph'?: unknown[]; '@type'?: string };
      const nos = (dado['@graph'] ?? [dado]) as { '@type'?: string }[];
      const jp = nos.find(n => n['@type'] === 'JobPosting');
      if (jp) return jp as JobPosting;
    } catch {
      // bloco de JSON-LD com outra coisa (ou quebrado): tenta o próximo
    }
  }
  return null;
}

/** "Fortaleza - CE" a partir do endereço do JSON-LD; '' quando a vaga não diz onde é. */
export function localDe(jp: JobPosting): string {
  const e = jp.jobLocation?.address ?? {};
  return [e.addressLocality, e.addressRegion]
    .map(p => (p ?? '').trim())
    .filter(Boolean)
    .join(' - ');
}

/**
 * Remoto vem do JSON-LD (`TELECOMMUTE`). Híbrido o site não marca em lugar nenhum estruturado: está escrito no
 * título ("| Híbrido em Fortaleza/CE") ou no texto. Sem nada disso e com endereço, é presencial.
 */
export function modeloDe(jp: JobPosting, titulo: string, descricao: string): Vaga['modelo'] {
  if (VAGASPJ.hibrido.test(titulo) || VAGASPJ.hibrido.test(descricao.slice(0, 1500))) return 'hibrido';
  if (jp.jobLocationType === 'TELECOMMUTE' || VAGASPJ.remoto.test(titulo)) return 'remoto';
  return localDe(jp) ? 'presencial' : 'indefinido';
}

/** Página da vaga → Vaga do AutoCV, já pontuada. `null` = a vaga não serve (candidatura externa ou vencida). */
export function montarVaga(item: ItemFeed, html: string, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao): Vaga | null {
  const jp = lerJobPosting(html);
  if (!jp) return null;
  if (html.includes('data-externa="1"')) return null; // candidatura no site da empresa
  if (jp.validThrough && new Date(jp.validThrough) < new Date()) return null;

  const titulo = htmlParaTexto(jp.title ?? item.titulo).trim();
  const descricao = htmlParaTexto(jp.description ?? '');
  const local = localDe(jp);
  const modelo = modeloDe(jp, titulo, descricao);
  const agora = new Date().toISOString();
  const vaga: Vaga = {
    id: `vagaspj:${item.id}`,
    plataforma: 'vagaspj',
    tenant: item.empresaSlug,
    titulo,
    empresa: (jp.hiringOrganization?.name ?? '').trim() || 'Empresa não informada',
    descricao,
    requisitos: '',
    regime: 'PJ', // o site inteiro é de contratação PJ (employmentType CONTRACTOR em todas)
    senioridade: inferirSenioridade(titulo, descricao),
    modelo,
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

const baixar = async (url: string) => {
  const r = await fetch(url, { headers: { accept: 'text/html,application/xml', 'user-agent': 'AutoCV/1.0 (uso pessoal)' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Vagas PJ ${r.status} em ${new URL(url).pathname}`);
  return r.text();
};

let buscando = false;

export async function buscarNoVagasPJ(perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, log: Log): Promise<Vaga[]> {
  if (buscando) return [];
  buscando = true;
  const novas: Vaga[] = [];
  try {
    passo('lendo o feed de vagas');
    const itens = lerFeed(await baixar(VAGASPJ.feed));
    if (!itens.length) {
      log('alerta', 'Vagas PJ: o feed não devolveu nenhuma vaga (o formato pode ter mudado).');
      return [];
    }
    const ineditas = itens.filter(i => !vagas.get(`vagaspj:${i.id}`)).slice(0, MAX_VAGAS_POR_VARREDURA);
    vistas(itens.length);
    log('info', `Vagas PJ: ${itens.length} vaga(s) no feed, ${ineditas.length} ainda não conhecida(s).`);

    let descartadas = 0;
    for (const [k, item] of ineditas.entries()) {
      passo('abrindo as vagas novas', k + 1, ineditas.length);
      if (k > 0) await dormir(PAUSA_ENTRE_PAGINAS_MS);
      try {
        const v = montarVaga(item, await baixar(item.url), perfil, cfg, pref);
        if (!v) {
          descartadas++;
          continue;
        }
        vagas.salvar(v);
        novas.push(v);
      } catch (e) {
        log('alerta', `Vagas PJ: não consegui ler ${item.url} (${(e as Error).message}).`);
      }
    }
    kv.set('vagaspj:ultimaBusca', new Date().toISOString());
    log('info', `Vagas PJ: ${novas.length} vaga(s) nova(s)${descartadas ? `, ${descartadas} descartada(s) por candidatura externa ou prazo vencido` : ''}.`);
    emitir({ tipo: 'estado' });
  } finally {
    buscando = false;
  }
  return novas;
}
