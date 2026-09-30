// Busca no Divulga Vagas: sitemap → peneira pelo slug → JSON-LD da página. Só HTTP, sem navegador.
// O acervo tem ~41 mil vagas e quase nenhuma é de tecnologia, por isso a peneira pelo slug vem antes de
// qualquer download: ela custa zero e derruba 99% do volume. Ver seletores.ts.
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import type { PreferenciasLocalizacao } from '../../../src/paises.ts';
import type { Log } from '../adapter.ts';
import { kv, vagas } from '../../storage/db.ts';
import { emitir } from '../../events.ts';
import { ler } from '../../estado.ts';
import { calcularScore } from '../../resume/score.ts';
import { inferirSenioridade } from '../../resume/analyzer.ts';
import { extrairSkills, normalizar } from '../../resume/texto.ts';
import { paisDoLocal, vagaCompativelComLocalizacao } from '../../localizacao.ts';
import { htmlParaTexto } from '../inhire/api.ts';
import { DIVULGA, EMPRESA_OCULTA, MAX_VAGAS_POR_VARREDURA, PAUSA_ENTRE_PAGINAS_MS } from './seletores.ts';

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface ItemSitemap {
  id: string;
  slug: string;
  url: string;
}

/** URLs de vaga de um sitemap. O slug já vem separado do id porque é nele que a peneira trabalha. */
export function lerSitemap(xml: string): ItemSitemap[] {
  const itens: ItemSitemap[] = [];
  for (const bruto of xml.match(/<loc>[^<]+<\/loc>/g) ?? []) {
    const url = bruto.replace(/<\/?loc>/g, '').trim();
    const m = url.match(DIVULGA.urlVaga);
    if (m) itens.push({ id: m[2], slug: m[1], url });
  }
  return itens;
}

/**
 * Palavras que fazem uma vaga valer o download, tiradas do perfil de busca do currículo.
 * Só termos de 4+ letras: "ia" ou "qa" dentro de um slug casariam com qualquer coisa ("qualidade", "social").
 */
export function termosDoPerfil(perfil: PerfilBusca, cargoDesejado: string): string[] {
  const cru = [cargoDesejado, ...perfil.cargos, ...perfil.skills].join(' ');
  return [...new Set(normalizar(cru).split(/[^a-z0-9+#.]+/))].filter(t => t.length >= 4);
}

/** O slug da vaga fala de alguma coisa que a pessoa faz? (peneira grosseira; o score decide de verdade) */
export const slugInteressa = (slug: string, termos: string[]) => termos.some(t => slug.includes(t));

export interface JobPosting {
  title?: string;
  description?: string;
  validThrough?: string;
  jobLocationType?: string;
  employmentType?: string;
  skills?: string[] | string;
  jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
}

export function lerJobPosting(html: string): JobPosting | null {
  for (const bloco of html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g) ?? []) {
    try {
      const dado = JSON.parse(bloco.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as { '@graph'?: unknown[]; '@type'?: string };
      const nos = (dado['@graph'] ?? [dado]) as { '@type'?: string }[];
      const jp = nos.find(n => n['@type'] === 'JobPosting');
      if (jp) return jp as JobPosting;
    } catch {
      // bloco de JSON-LD com outra coisa: tenta o próximo
    }
  }
  return null;
}

export const localDe = (jp: JobPosting): string =>
  [jp.jobLocation?.address?.addressLocality, jp.jobLocation?.address?.addressRegion]
    .map(p => (p ?? '').trim())
    .filter(Boolean)
    .join(' - ');

/** Remoto vem do JSON-LD; híbrido o site não marca, só escreve. */
export function modeloDe(jp: JobPosting, titulo: string): Vaga['modelo'] {
  if (/h[íi]brid[oa]/i.test(titulo)) return 'hibrido';
  if (jp.jobLocationType === 'TELECOMMUTE' || /\bremot[oa]\b|home office|teletrabalho/i.test(titulo)) return 'remoto';
  return localDe(jp) ? 'presencial' : 'indefinido';
}

/** Página → Vaga pontuada. `null` = não serve (sem JSON-LD ou com prazo vencido). */
export function montarVaga(item: ItemSitemap, html: string, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao): Vaga | null {
  const jp = lerJobPosting(html);
  if (!jp) return null;
  if (jp.validThrough && new Date(jp.validThrough) < new Date()) return null;

  // "Desenvolvedor Python Sênior – Home Office - Rs | Vaga #34541421": o sufixo é ruído do site
  const titulo = htmlParaTexto(jp.title ?? '')
    .replace(/\s*\|\s*Vaga\s*#\d+\s*$/i, '')
    .trim();
  if (!titulo) return null;
  const requisitos = (Array.isArray(jp.skills) ? jp.skills.join('\n') : (jp.skills ?? '')).trim();
  const descricao = [htmlParaTexto(jp.description ?? ''), requisitos].filter(Boolean).join('\n\n');
  const local = localDe(jp);
  const agora = new Date().toISOString();
  const vaga: Vaga = {
    id: `divulgavagas:${item.id}`,
    plataforma: 'divulgavagas',
    tenant: 'divulgavagas',
    titulo,
    empresa: EMPRESA_OCULTA,
    descricao,
    requisitos,
    regime: /\bPJ\b|pessoa jur[íi]dica/i.test(`${titulo} ${descricao}`) ? 'PJ' : jp.employmentType === 'FULL_TIME' ? 'CLT' : 'indefinido',
    senioridade: inferirSenioridade(titulo, descricao),
    modelo: modeloDe(jp, titulo),
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
  const a = calcularScore(vaga, perfil, { area: cfg.area, cargo: ler.perfil()?.cargo ?? '', senioridade: cfg.senioridade, localizacao: pref });
  vaga.score = a.score;
  vaga.motivo = a.motivo;
  if (!vagaCompativelComLocalizacao(vaga, pref).compativel || vaga.score < cfg.scoreMinimo) vaga.status = 'ignorada';
  return vaga;
}

const baixar = async (url: string) => {
  const r = await fetch(url, { headers: { accept: 'text/html,application/xml', 'user-agent': 'AutoCV/1.0 (uso pessoal)' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Divulga Vagas ${r.status} em ${new URL(url).pathname}`);
  return r.text();
};

/** Mesmo ritmo da revarredura do InHire: o acervo muda devagar e são 5 sitemaps grandes. */
export function divulgaVencido(horas: number): boolean {
  const ultima = kv.get<string | null>('divulgavagas:ultimaBusca', null);
  return !ultima || Date.now() - new Date(ultima).getTime() >= horas * 3_600_000;
}

let buscando = false;

export async function buscarNoDivulgaVagas(perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, log: Log): Promise<Vaga[]> {
  if (buscando) return [];
  buscando = true;
  const novas: Vaga[] = [];
  try {
    const termos = termosDoPerfil(perfil, ler.perfil()?.cargo ?? '');
    if (!termos.length) {
      log('alerta', 'Divulga Vagas: sem cargo nem competências no perfil para peneirar 41 mil vagas.');
      return [];
    }
    let total = 0;
    const candidatas: ItemSitemap[] = [];
    for (const sm of DIVULGA.sitemaps) {
      try {
        const itens = lerSitemap(await baixar(sm));
        total += itens.length;
        candidatas.push(...itens.filter(i => slugInteressa(i.slug, termos) && !vagas.get(`divulgavagas:${i.id}`)));
      } catch (e) {
        log('alerta', `Divulga Vagas: ${(e as Error).message}`);
      }
    }
    // O id cresce com o tempo: ordenar por ele decrescente faz o limite da varredura pegar as MAIS NOVAS,
    // e não as primeiras na ordem do arquivo (os sitemaps não vêm por data).
    const escolhidas = candidatas.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, MAX_VAGAS_POR_VARREDURA);
    log('info', `Divulga Vagas: ${total} vaga(s) no sitemap, ${candidatas.length} com o seu perfil no título, ${escolhidas.length} nova(s) para abrir.`);

    let semDados = 0;
    for (const [k, item] of escolhidas.entries()) {
      if (k > 0) await dormir(PAUSA_ENTRE_PAGINAS_MS);
      try {
        const v = montarVaga(item, await baixar(item.url), perfil, cfg, pref);
        if (!v) {
          semDados++;
          continue;
        }
        vagas.salvar(v);
        novas.push(v);
      } catch (e) {
        log('alerta', `Divulga Vagas: não consegui ler ${item.url} (${(e as Error).message}).`);
      }
    }
    kv.set('divulgavagas:ultimaBusca', new Date().toISOString());
    log('info', `Divulga Vagas: ${novas.length} vaga(s) nova(s)${semDados ? `, ${semDados} sem dados ou com prazo vencido` : ''}.`);
    emitir({ tipo: 'estado' });
  } finally {
    buscando = false;
  }
  return novas;
}
