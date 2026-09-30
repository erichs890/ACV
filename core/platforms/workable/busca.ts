import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import type { PreferenciasLocalizacao } from '../../../src/paises.ts';
import type { Log } from '../adapter.ts';
import { htmlParaTexto } from '../inhire/api.ts';
import { extrairSkills } from '../../resume/texto.ts';
import { calcularScore } from '../../resume/score.ts';
import { paisDoLocal, vagaCompativelComLocalizacao } from '../../localizacao.ts';
import { kv, vagas } from '../../storage/db.ts';
import { emitir } from '../../events.ts';
import { ler } from '../../estado.ts';
import { MAX_VAGAS_POR_VARREDURA, PAUSA_ENTRE_CONSULTAS_MS, WORKABLE } from './seletores.ts';

export interface WorkableJobItem {
  id: string;
  title: string;
  description?: string;
  requirementsSection?: string;
  benefitsSection?: string;
  employmentType?: string;
  workplace?: 'remote' | 'on_site' | 'hybrid' | string;
  url: string;
  location?: {
    city?: string;
    subregion?: string;
    countryName?: string;
  };
  locations?: string[];
  company?: {
    id?: string;
    title?: string;
    website?: string;
    image?: string;
  };
  created?: string;
  updated?: string;
}

export interface WorkableApiResponse {
  totalSize?: number;
  nextPageToken?: string;
  jobs?: WorkableJobItem[];
}

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

export function modeloDe(workplace?: string): Vaga['modelo'] {
  if (!workplace) return 'indefinido';
  const w = workplace.toLowerCase();
  if (w === 'remote' || w.includes('telecommute')) return 'remoto';
  if (w === 'hybrid') return 'hibrido';
  if (w === 'on_site' || w === 'onsite') return 'presencial';
  return 'indefinido';
}

export function regimeDe(employmentType?: string): Vaga['regime'] {
  if (!employmentType) return 'indefinido';
  const e = employmentType.toLowerCase();
  if (/full[- ]?time|permanent|efetivo/i.test(e)) return 'CLT';
  if (/contract|contractor|pj|freelance/i.test(e)) return 'PJ';
  return 'indefinido';
}

export function montarVaga(raw: WorkableJobItem, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao): Vaga | null {
  if (!raw.id || !raw.title || !raw.url) return null;

  const descHtml = [raw.description, raw.requirementsSection, raw.benefitsSection].filter(Boolean).join('\n\n');
  const descricao = htmlParaTexto(descHtml);
  const modelo = modeloDe(raw.workplace);
  const regime = regimeDe(raw.employmentType);

  const cidade = raw.location?.city ?? '';
  const estadoOuRegiao = raw.location?.subregion ?? '';
  const paisNome = raw.location?.countryName ?? '';
  const local = [cidade, estadoOuRegiao, paisNome].filter(Boolean).join(', ') || raw.locations?.[0] || (modelo === 'remoto' ? 'Remoto' : '');
  const pais = (paisNome ? paisDoLocal(paisNome) : '') || paisDoLocal(local) || paisNome;

  const skillsTexto = extrairSkills(`${raw.title}\n${descricao}`);
  const base = {
    titulo: raw.title,
    empresa: raw.company?.title || 'Empresa confidencial',
    modelo,
    local,
    pais,
    descricao,
    skills: skillsTexto,
  };

  const { score, motivo } = calcularScore(base, perfil, { ...cfg, localizacao: pref });
  const lugar = vagaCompativelComLocalizacao({ modelo, local, pais }, pref);
  const compatibilidadeLugar = lugar.compativel ? '' : lugar.motivo;
  const motivoCompleto = [motivo, compatibilidadeLugar].filter(Boolean).join(' · ');

  const passaScore = score >= cfg.scoreMinimo;
  const passaLugar = lugar.compativel;
  const status = passaScore && passaLugar ? 'encontrada' : 'ignorada';
  const agora = new Date().toISOString();

  return {
    id: `workable:${raw.id}`,
    plataforma: 'workable',
    tenant: raw.company?.id || 'workable',
    titulo: raw.title,
    empresa: raw.company?.title || 'Empresa confidencial',
    local,
    pais,
    modelo,
    regime,
    score,
    motivo: motivoCompleto,
    requisitos: skillsTexto.join(', '),
    descricao,
    skills: skillsTexto,
    camposConhecidos: [],
    status,
    url: raw.url,
    encontradaEm: agora,
    atualizadaEm: agora,
  };
}

export async function consultarApiWorkable(termo: string, localizacao?: string): Promise<WorkableJobItem[]> {
  const url = new URL(WORKABLE.api.jobs);
  if (termo) url.searchParams.set('query', termo);
  if (localizacao) url.searchParams.set('location', localizacao);

  const resp = await fetch(url.toString(), {
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    if (resp.status === 429) throw new Error('Workable: limite de requisições excedido temporariamente (429)');
    throw new Error(`Workable API respondeu HTTP ${resp.status}`);
  }

  const json = (await resp.json()) as WorkableApiResponse;
  return json.jobs ?? [];
}

let buscando = false;

export async function buscarNoWorkable(perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, log: Log): Promise<Vaga[]> {
  if (buscando) return [];
  buscando = true;
  const novas: Vaga[] = [];

  try {
    const cargoPrincipal = ler.perfil()?.cargo || perfil.cargos[0] || '';
    const termosBusca: string[] = [];
    if (cargoPrincipal) termosBusca.push(cargoPrincipal);
    for (const c of perfil.cargos) {
      if (c && !termosBusca.includes(c)) termosBusca.push(c);
      if (termosBusca.length >= 2) break;
    }
    if (!termosBusca.length && perfil.skills.length) {
      termosBusca.push(perfil.skills[0]);
    }

    if (!termosBusca.length) {
      log('alerta', 'Workable: informe um cargo ou adicione competências no perfil para pesquisar.');
      return [];
    }

    const locais: string[] = [];
    if (pref.localizacaoPresencial) locais.push(pref.localizacaoPresencial);
    for (const p of pref.paisesRemoto) {
      if (p && !locais.includes(p)) locais.push(p);
    }
    if (!locais.length) locais.push('Brazil', 'Remote');

    let totalEncontradas = 0;
    const vistosIds = new Set<string>();

    for (const termo of termosBusca) {
      for (const loc of locais.slice(0, 3)) {
        if (novas.length >= MAX_VAGAS_POR_VARREDURA) break;
        try {
          await dormir(PAUSA_ENTRE_CONSULTAS_MS);
          const lista = await consultarApiWorkable(termo, loc);
          totalEncontradas += lista.length;

          for (const item of lista) {
            if (novas.length >= MAX_VAGAS_POR_VARREDURA) break;
            if (!item.id || vistosIds.has(item.id)) continue;
            vistosIds.add(item.id);

            const jaExiste = vagas.get(`workable:${item.id}`);
            if (jaExiste) continue;

            const v = montarVaga(item, perfil, cfg, pref);
            if (!v) continue;

            vagas.salvar(v);
            novas.push(v);
          }
        } catch (e) {
          log('alerta', `Workable: consulta "${termo}" em "${loc}" falhou (${(e as Error).message}).`);
        }
      }
    }

    kv.set('workable:ultimaBusca', new Date().toISOString());
    log('info', `Workable: ${totalEncontradas} vaga(s) analisada(s), ${novas.length} nova(s) gravada(s).`);
    emitir({ tipo: 'estado' });
  } finally {
    buscando = false;
  }

  return novas;
}
