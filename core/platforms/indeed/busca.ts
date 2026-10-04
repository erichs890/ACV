// Busca no Indeed: só vagas com "Candidatar-se facilmente", presenciais no domínio do país da pessoa e remotas no
// domínio de cada país escolhido. Ver seletores.ts para o que foi confirmado ao vivo e os limites de projeto.
import type { Page } from 'playwright';
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import { PAISES, type PreferenciasLocalizacao } from '../../../src/paises.ts';
import type { Log } from '../adapter.ts';
import { navegador } from '../../browser.ts';
import { kv, vagas } from '../../storage/db.ts';
import { emitir } from '../../events.ts';
import { filtrosDaAutomacao, ler } from '../../estado.ts';
import { calcularScore } from '../../resume/score.ts';
import { inferirSenioridade } from '../../resume/analyzer.ts';
import { extrairSkills } from '../../resume/texto.ts';
import { paisDoLocal, vagaCompativelComLocalizacao } from '../../localizacao.ts';
import { htmlParaTexto } from '../inhire/api.ts';
import { HORAS_DE_PAUSA_APOS_BLOQUEIO, HORAS_ENTRE_VARREDURAS_AUTOMATICAS, INDEED, MAX_CONSULTAS, MINUTOS_PARA_RESOLVER_VERIFICACAO, PAUSA_ENTRE_CARGAS_MS } from './seletores.ts';

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));
const HORA = 3_600_000;

/** Resultado cru de um card, vindo do JSON embutido (preferido) ou do DOM (reserva). */
export interface ResultadoIndeed {
  jobkey: string;
  titulo: string;
  empresa: string;
  local: string;
  facil: boolean; // "Candidatar-se facilmente": a candidatura acontece dentro do Indeed
  trecho: string; // HTML ou texto curto
  tipos: string[]; // "Tipo de vaga": CLT, PJ, Meio período...
  suidsRemoto: string[]; // atributos do grupo "remote"
}

export interface Consulta {
  host: string;
  pais: string;
  remoto: boolean;
  url: string;
}

/** Domínio do Indeed de um país (nome de src/paises.ts); undefined se o Indeed não opera lá. */
export const hostDe = (pais: string) => PAISES.find(p => p.nome === pais)?.indeed;

export function urlDeBusca(host: string, cargo: string, local: string, remoto: boolean): string {
  const p = new URLSearchParams({ q: cargo });
  if (local) p.set('l', local);
  if (remoto) p.set('sc', INDEED.filtroRemoto);
  return `https://${host}/jobs?${p.toString()}`;
}

/**
 * Plano de cargas de uma varredura: presenciais/híbridas só no domínio do país onde a pessoa mora, com a cidade;
 * remotas em cada país escolhido, sem cidade e com o filtro de remoto. Países sem Indeed ficam de fora (com aviso).
 */
export function planejarConsultas(cargos: string[], pref: PreferenciasLocalizacao, log?: Log): Consulta[] {
  const consultas: Consulta[] = [];
  const meuPais = paisDoLocal(pref.localizacaoPresencial) || 'Brasil';
  for (const cargo of cargos.slice(0, MAX_CONSULTAS)) {
    const hostLocal = hostDe(meuPais);
    if (pref.localizacaoPresencial.trim() && hostLocal)
      consultas.push({ host: hostLocal, pais: meuPais, remoto: false, url: urlDeBusca(hostLocal, cargo, pref.localizacaoPresencial.replace(/\s*[-/]\s*/, ', '), false) });
    for (const pais of pref.paisesRemoto) {
      const host = hostDe(pais);
      if (!host) {
        log?.('alerta', `Indeed: não há site do Indeed mapeado para ${pais}; vagas remotas de lá não serão buscadas.`);
        continue;
      }
      consultas.push({ host, pais, remoto: true, url: urlDeBusca(host, cargo, '', true) });
    }
  }
  return consultas;
}

const REGIME = (tipos: string[]): Vaga['regime'] => {
  const t = tipos.join(' ').toUpperCase();
  const clt = /\bCLT\b|EFETIVO/.test(t);
  const pj = /\bPJ\b|AUT[ÔO]NOMO|PESSOA JUR[ÍI]DICA|FREELANCE/.test(t);
  return clt && pj ? 'ambos' : clt ? 'CLT' : pj ? 'PJ' : 'indefinido';
};

/** Modelo de trabalho pelos atributos da própria vaga; a consulta só desempata quando a vaga não diz nada. */
export function modeloDe(r: Pick<ResultadoIndeed, 'suidsRemoto' | 'local'>, consultaRemota: boolean): Vaga['modelo'] {
  const remoto = r.suidsRemoto.includes(INDEED.suidRemoto);
  const hibrido = r.suidsRemoto.includes(INDEED.suidHibrido);
  if (hibrido) return 'hibrido'; // "Home Office" + "Modelo Híbrido" juntos = híbrido
  if (remoto || /\bremot[oa]\b|home office|teletrabalho|\bremote\b/i.test(r.local)) return 'remoto';
  return consultaRemota ? 'remoto' : 'presencial';
}

/** Card → Vaga do ACV (mesma tabela e mesmo score do InHire; `plataforma` e `pais` distinguem a origem). */
export function montarVagaIndeed(r: ResultadoIndeed, c: Consulta, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao): Vaga {
  const descricao = htmlParaTexto(r.trecho);
  const modelo = modeloDe(r, c.remoto);
  const agora = new Date().toISOString();
  const vaga: Vaga = {
    id: `indeed:${r.jobkey}`, // o jobkey é global: a mesma vaga indexada em dois domínios vira uma só
    plataforma: 'indeed',
    tenant: c.host,
    titulo: r.titulo.trim(),
    empresa: r.empresa.trim() || 'Empresa não informada',
    descricao,
    requisitos: '',
    regime: REGIME(r.tipos),
    senioridade: inferirSenioridade(r.titulo, descricao),
    modelo,
    local: r.local,
    // Remota: o país é o do site onde ela foi publicada (a vaga pode nem citar cidade). Presencial: lê do local.
    pais: modelo === 'remoto' ? c.pais : paisDoLocal(r.local) || c.pais,
    url: `https://${c.host}/viewjob?jk=${r.jobkey}`,
    skills: extrairSkills(`${r.titulo}\n${descricao}`),
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

export type Bloqueio = 'bloqueado' | 'verificacao' | null;

export async function detectarBloqueio(page: Page): Promise<Bloqueio> {
  const texto = await page.evaluate(() => `${document.title} ${document.body?.innerText.slice(0, 800) ?? ''}`).catch(() => '');
  if (INDEED.bloqueado.test(texto)) return 'bloqueado';
  if (INDEED.verificacao.test(texto)) return 'verificacao';
  return null;
}

/** Lê os cards da página atual: JSON embutido primeiro, DOM como reserva. */
export async function lerResultados(page: Page): Promise<{ resultados: ResultadoIndeed[]; fonte: 'json' | 'dom' }> {
  return page.evaluate(() => {
    const w = window as unknown as { mosaic?: { providerData?: Record<string, { metaData?: { mosaicProviderJobCardsModel?: { results?: Record<string, unknown>[] } } }> } };
    const brutos = w.mosaic?.providerData?.['mosaic-provider-jobcards']?.metaData?.mosaicProviderJobCardsModel?.results;
    if (brutos?.length) {
      const resultados = brutos
        .filter(r => r.jobkey && !r.expired)
        .map(r => {
          const grupos = (r.taxonomyAttributes as { label: string; attributes: { label: string; suid: string }[] }[] | undefined) ?? [];
          return {
            jobkey: String(r.jobkey),
            titulo: String(r.displayTitle ?? r.title ?? ''),
            empresa: String(r.company ?? ''),
            local: String(r.formattedLocation ?? ''),
            facil: r.indeedApplyEnabled === true,
            trecho: String(r.snippet ?? ''),
            tipos: [...((r.jobTypes as string[] | undefined) ?? []), ...(grupos.find(g => g.label === 'job-types')?.attributes.map(a => a.label) ?? [])],
            suidsRemoto: grupos.find(g => g.label === 'remote')?.attributes.map(a => a.suid) ?? [],
          };
        });
      return { resultados, fonte: 'json' as const };
    }
    const resultados = [...document.querySelectorAll('.job_seen_beacon')]
      .map(c => {
        const a = c.querySelector('a[data-jk]');
        const texto = c.textContent ?? '';
        return {
          jobkey: a?.getAttribute('data-jk') ?? '',
          titulo: a?.textContent?.trim() ?? '',
          empresa: c.querySelector('[data-testid="company-name"]')?.textContent?.trim() ?? '',
          local: c.querySelector('[data-testid="text-location"]')?.textContent?.trim() ?? '',
          facil: /candidat[ae]r?-se facilmente|candidatura simplificada|easily apply/i.test(texto),
          trecho: c.querySelector('[data-testid="belowJobSnippet"], .job-snippet')?.textContent?.trim() ?? '',
          tipos: [] as string[],
          suidsRemoto: [] as string[],
        };
      })
      .filter(r => r.jobkey);
    return { resultados, fonte: 'dom' as const };
  });
}

interface EstadoIndeed {
  ultimaBusca: string | null;
  pausaAte: string | null;
  motivoPausa: string;
}
export const lerEstadoIndeed = (): EstadoIndeed => ({ ultimaBusca: null, pausaAte: null, motivoPausa: '', ...kv.get<Partial<EstadoIndeed>>('indeed', {}) });
const salvarEstadoIndeed = (p: Partial<EstadoIndeed>) => kv.set('indeed', { ...lerEstadoIndeed(), ...p });

/** Hora da varredura automática diária? (nunca durante a pausa que segue um bloqueio) */
export function indeedVencido(): boolean {
  const e = lerEstadoIndeed();
  if (e.pausaAte && new Date(e.pausaAte) > new Date()) return false;
  return !e.ultimaBusca || Date.now() - new Date(e.ultimaBusca).getTime() >= HORAS_ENTRE_VARREDURAS_AUTOMATICAS * HORA;
}

let buscando = false;

/**
 * Varredura do Indeed. `manual` = a pessoa clicou em "Buscar vagas agora": ignora o limite de uma varredura
 * automática por dia (mas não a pausa depois de um bloqueio).
 */
export async function buscarNoIndeed(perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, log: Log, manual: boolean): Promise<Vaga[]> {
  if (buscando) return [];
  const estado = lerEstadoIndeed();
  if (estado.pausaAte && new Date(estado.pausaAte) > new Date()) {
    log(manual ? 'alerta' : 'info', `Indeed em pausa até ${new Date(estado.pausaAte).toLocaleString('pt-BR')} (${estado.motivoPausa}).`);
    return [];
  }
  if (!manual && estado.ultimaBusca && Date.now() - new Date(estado.ultimaBusca).getTime() < HORAS_ENTRE_VARREDURAS_AUTOMATICAS * HORA) return [];

  const cargos = [...new Set([ler.perfil()?.cargo ?? '', ...perfil.cargos].map(c => c?.trim()).filter((c): c is string => !!c))];
  if (!cargos.length) {
    log('alerta', 'Indeed: sem cargo para pesquisar (o currículo não trouxe cargos e o filtro de cargo da Automação está vazio).');
    return [];
  }
  const consultas = planejarConsultas(cargos, pref, log);
  if (!consultas.length) {
    log('alerta', 'Indeed: preencha sua cidade ou escolha ao menos um país para vagas remotas em Configurações › Meus Dados.');
    return [];
  }

  buscando = true;
  const novas: Vaga[] = [];
  let descartadasExternas = 0;
  try {
    log('info', `Indeed: ${consultas.length} busca(s) em janela visível (o Indeed bloqueia navegador oculto), uma a cada ${PAUSA_ENTRE_CARGAS_MS / 1000} s.`);
    const ctx = await navegador(true);
    const page = await ctx.newPage();
    try {
      for (const [i, c] of consultas.entries()) {
        if (i > 0) await dormir(PAUSA_ENTRE_CARGAS_MS);
        await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page
          .locator('.job_seen_beacon, #mosaic-provider-jobcards')
          .first()
          .waitFor({ state: 'attached', timeout: 15000 })
          .catch(() => {});

        let bloqueio = await detectarBloqueio(page);
        if (bloqueio === 'verificacao') {
          log('aguardo', `O Indeed pediu uma verificação. Resolva na janela do navegador em até ${MINUTOS_PARA_RESOLVER_VERIFICACAO} min; o robô não faz isso por você.`);
          emitir({ tipo: 'aviso', nivel: 'info', msg: 'O Indeed pediu uma verificação: resolva na janela do navegador.' });
          const fim = Date.now() + MINUTOS_PARA_RESOLVER_VERIFICACAO * 60_000;
          while (Date.now() < fim) {
            await dormir(3000);
            bloqueio = await detectarBloqueio(page);
            if (bloqueio !== 'verificacao') break;
          }
        }
        if (bloqueio) {
          const motivo = bloqueio === 'bloqueado' ? 'o Indeed bloqueou o acesso deste navegador' : 'a verificação do Indeed não foi resolvida';
          salvarEstadoIndeed({ pausaAte: new Date(Date.now() + HORAS_DE_PAUSA_APOS_BLOQUEIO * HORA).toISOString(), motivoPausa: motivo });
          log('erro', `Indeed: ${motivo}. Busca interrompida e pausada por ${HORAS_DE_PAUSA_APOS_BLOQUEIO} h; nada foi contornado.`);
          emitir({ tipo: 'aviso', nivel: 'erro', msg: `Indeed: ${motivo}.` });
          break;
        }

        const { resultados, fonte } = await lerResultados(page);
        let novasAqui = 0;
        for (const r of resultados) {
          if (!r.facil) {
            descartadasExternas++; // candidatura no site da empresa: fora do escopo, nem entra na tabela
            continue;
          }
          if (vagas.get(`indeed:${r.jobkey}`)) continue; // já conhecida (inclusive por outro domínio)
          const v = montarVagaIndeed(r, c, perfil, cfg, pref);
          vagas.salvar(v);
          novas.push(v);
          novasAqui++;
        }
        log(
          'info',
          `Indeed ${c.pais} (${c.remoto ? 'remotas' : 'presenciais/híbridas'}): ${resultados.length} resultado(s), ${resultados.filter(r => r.facil).length} com candidatura simplificada, ${novasAqui} nova(s)${fonte === 'dom' ? ' — lidas do DOM (o JSON da página mudou)' : ''}.`,
        );
        emitir({ tipo: 'estado' });
      }
    } finally {
      await page.close().catch(() => {});
    }
    salvarEstadoIndeed({ ultimaBusca: new Date().toISOString() });
    if (descartadasExternas) log('info', `Indeed: ${descartadasExternas} vaga(s) descartadas por levarem a um site externo de candidatura.`);
  } finally {
    buscando = false;
  }
  return novas;
}
