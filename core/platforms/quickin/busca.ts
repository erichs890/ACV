import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import type { PreferenciasLocalizacao } from '../../../src/paises.ts';
import type { Log } from '../adapter.ts';
import { htmlParaTexto } from '../inhire/api.ts';
import { extrairSkills } from '../../resume/texto.ts';
import { calcularScore } from '../../resume/score.ts';
import { vagaCompativelComLocalizacao } from '../../localizacao.ts';
import { kv, vagas } from '../../storage/db.ts';
import { emitir } from '../../events.ts';
import { MAX_VAGAS_POR_VARREDURA, PAUSA_ENTRE_PAGINAS_MS, QUICKIN } from './seletores.ts';

export interface ItemVagaQuickin {
  empresa: string;
  id: string;
  url: string;
  slug: string;
}

export interface JobPostingQuickin {
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string;
  hiringOrganization?: { name?: string };
  jobLocation?: {
    address?: {
      addressLocality?: string;
      addressRegion?: string;
      addressCountry?: string;
    };
  };
  jobLocationType?: string;
}

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

async function baixar(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

/** Extrai a lista de empresas (slugs) a partir do sitemap.xml principal. */
export function extrairEmpresasDoSitemapIndex(xml: string): string[] {
  const re = /<loc>https:\/\/jobs\.quickin\.io\/sitemaps\/([a-z0-9_-]+)-jobs\.xml<\/loc>/gi;
  return Array.from(xml.matchAll(re), m => m[1]);
}

/** Lê os URLs de vagas de um sitemap de empresa. */
export function lerSitemapEmpresa(xml: string, empresa: string): ItemVagaQuickin[] {
  const re = /<loc>(https:\/\/jobs\.quickin\.io\/([^/]+)\/jobs\/([a-z0-9]+))<\/loc>/gi;
  return Array.from(xml.matchAll(re), m => ({
    url: m[1],
    empresa: m[2] || empresa,
    id: m[3],
    slug: m[3],
  }));
}

/** Extrai o JSON-LD JobPosting da página HTML da vaga. */
export function lerJobPosting(html: string): JobPostingQuickin | null {
  const re = /<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed['@type'] === 'JobPosting') return parsed as JobPostingQuickin;
      if (Array.isArray(parsed)) {
        const achado = parsed.find(item => item['@type'] === 'JobPosting');
        if (achado) return achado as JobPostingQuickin;
      }
    } catch {
      // ignora bloco malformado
    }
  }
  return null;
}

export function modeloDe(jp: JobPostingQuickin, titulo: string, descricao: string): Vaga['modelo'] {
  if (jp.jobLocationType === 'TELECOMMUTE') return 'remoto';
  const texto = `${titulo} ${descricao}`.toLowerCase();
  if (/\b(remoto|home office|teletrabalho|remote)\b/i.test(texto)) return 'remoto';
  if (/\bh[íi]brid[oa]\b/i.test(texto)) return 'hibrido';
  if (/\bpresencial\b/i.test(texto)) return 'presencial';
  return 'indefinido';
}

export function regimeDe(jp: JobPostingQuickin): Vaga['regime'] {
  const t = (jp.employmentType || '').toUpperCase();
  if (t === 'FULL_TIME') return 'CLT';
  if (t === 'CONTRACTOR' || t === 'PART_TIME') return 'PJ';
  return 'indefinido';
}

export function montarVaga(item: ItemVagaQuickin, html: string, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao): Vaga | null {
  const jp = lerJobPosting(html);
  if (!jp?.title) return null;

  if (jp.validThrough && new Date(jp.validThrough).getTime() < Date.now()) return null;

  const descricao = htmlParaTexto(jp.description || '');
  const titulo = jp.title.trim();
  const empresa = jp.hiringOrganization?.name?.trim() || item.empresa;
  const modelo = modeloDe(jp, titulo, descricao);
  const regime = regimeDe(jp);

  const loc = jp.jobLocation?.address;
  const cidade = loc?.addressLocality ?? '';
  const uf = loc?.addressRegion ?? '';
  const pais = loc?.addressCountry ?? 'Brasil';
  const local = [cidade, uf].filter(Boolean).join(' - ') || (modelo === 'remoto' ? 'Remoto' : pais);

  const skills = extrairSkills(`${titulo}\n${descricao}`);
  const base = {
    titulo,
    empresa,
    modelo,
    local,
    pais,
    descricao,
    skills,
  };

  const { score, motivo } = calcularScore(base, perfil, { ...cfg, localizacao: pref });
  const lugar = vagaCompativelComLocalizacao({ modelo, local, pais }, pref);
  const motivoCompleto = [motivo, lugar.compativel ? '' : lugar.motivo].filter(Boolean).join(' · ');

  const passaScore = score >= cfg.scoreMinimo;
  const passaLugar = lugar.compativel;
  const status = passaScore && passaLugar ? 'encontrada' : 'ignorada';
  const agora = new Date().toISOString();

  return {
    id: `quickin:${item.id}`,
    plataforma: 'quickin',
    tenant: item.empresa,
    titulo,
    empresa,
    local,
    pais,
    modelo,
    regime,
    score,
    motivo: motivoCompleto,
    requisitos: skills.join(', '),
    descricao,
    skills,
    camposConhecidos: [],
    status,
    url: item.url,
    encontradaEm: agora,
    atualizadaEm: agora,
  };
}

let buscando = false;

export async function buscarNoQuickin(perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, log: Log): Promise<Vaga[]> {
  if (buscando) return [];
  buscando = true;
  const novas: Vaga[] = [];

  try {
    log('info', 'Quickin: obtendo índice público de empresas...');
    const indexXml = await baixar(QUICKIN.sitemapIndex);
    const empresas = extrairEmpresasDoSitemapIndex(indexXml);
    if (!empresas.length) {
      log('alerta', 'Quickin: nenhuma empresa encontrada no índice.');
      return [];
    }

    // Amostra rotativa de empresas para cada varredura (evita varrer 628 sitemaps de uma vez)
    // Sorteia 15 empresas a cada varredura para acompanhar ativamente o ecossistema
    const shuffled = [...empresas].sort(() => 0.5 - Math.random()).slice(0, 15);
    const vagasParaAbrir: ItemVagaQuickin[] = [];

    for (const emp of shuffled) {
      if (vagasParaAbrir.length >= MAX_VAGAS_POR_VARREDURA) break;
      try {
        await dormir(200);
        const empXml = await baixar(QUICKIN.sitemaps(emp));
        const lista = lerSitemapEmpresa(empXml, emp);
        for (const item of lista) {
          if (!vagas.get(`quickin:${item.id}`)) {
            vagasParaAbrir.push(item);
          }
        }
      } catch {
        // sitemap de empresa específica pode estar indisponível
      }
    }

    log('info', `Quickin: ${vagasParaAbrir.length} vaga(s) nova(s) para analisar em ${shuffled.length} empresas.`);

    for (const [k, item] of vagasParaAbrir.slice(0, MAX_VAGAS_POR_VARREDURA).entries()) {
      if (k > 0) await dormir(PAUSA_ENTRE_PAGINAS_MS);
      try {
        const html = await baixar(item.url);
        const v = montarVaga(item, html, perfil, cfg, pref);
        if (!v) continue;

        vagas.salvar(v);
        novas.push(v);
      } catch (e) {
        log('alerta', `Quickin: falha ao ler ${item.url} (${(e as Error).message}).`);
      }
    }

    kv.set('quickin:ultimaBusca', new Date().toISOString());
    log('info', `Quickin: ${novas.length} vaga(s) adicionada(s).`);
    emitir({ tipo: 'estado' });
  } finally {
    buscando = false;
  }

  return novas;
}
