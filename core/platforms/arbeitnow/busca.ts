import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import type { PreferenciasLocalizacao } from '../../../src/paises.ts';
import type { Log } from '../adapter.ts';
import { htmlParaTexto } from '../inhire/api.ts';
import { extrairSkills } from '../../resume/texto.ts';
import { calcularScore } from '../../resume/score.ts';
import { paisDoLocal, vagaCompativelComLocalizacao } from '../../localizacao.ts';
import { kv, vagas } from '../../storage/db.ts';
import { emitir } from '../../events.ts';
import { ARBEITNOW, MAX_VAGAS_POR_VARREDURA } from './seletores.ts';

export interface ArbeitnowJobItem {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at: number;
}

export interface ArbeitnowApiResponse {
  data: ArbeitnowJobItem[];
  links?: { next?: string };
  meta?: { current_page?: number };
}

export function modeloDe(item: ArbeitnowJobItem): Vaga['modelo'] {
  if (item.remote) return 'remoto';
  const loc = (item.location || '').toLowerCase();
  if (loc.includes('remote') || loc.includes('telecommute')) return 'remoto';
  if (loc.includes('hybrid') || loc.includes('híbrid')) return 'hibrido';
  if (loc) return 'presencial';
  return 'indefinido';
}

export function regimeDe(item: ArbeitnowJobItem): Vaga['regime'] {
  const tipos = (item.job_types || []).join(' ').toLowerCase();
  if (/full[- ]?time/i.test(tipos)) return 'CLT';
  if (/contract|freelance|part[- ]?time/i.test(tipos)) return 'PJ';
  return 'indefinido';
}

export function montarVaga(raw: ArbeitnowJobItem, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao): Vaga | null {
  if (!raw.slug || !raw.title || !raw.url) return null;

  const descricao = htmlParaTexto(raw.description || '');
  const modelo = modeloDe(raw);
  const regime = regimeDe(raw);

  const local = raw.location?.trim() || (modelo === 'remoto' ? 'Remoto' : 'Alemanha');
  const pais = paisDoLocal(local) || (modelo === 'remoto' ? '' : 'Alemanha');

  const skills = extrairSkills(`${raw.title}\n${(raw.tags || []).join(' ')}\n${descricao}`);
  const base = {
    titulo: raw.title,
    empresa: raw.company_name || 'Empresa confidencial',
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
    id: `arbeitnow:${raw.slug}`,
    plataforma: 'arbeitnow',
    tenant: 'arbeitnow',
    titulo: raw.title,
    empresa: raw.company_name || 'Empresa confidencial',
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
    url: raw.url,
    encontradaEm: agora,
    atualizadaEm: agora,
  };
}

let buscando = false;

export async function buscarNoArbeitnow(perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, log: Log): Promise<Vaga[]> {
  if (buscando) return [];
  buscando = true;
  const novas: Vaga[] = [];

  try {
    log('info', 'Arbeitnow: consultando API pública...');
    const resp = await fetch(ARBEITNOW.api, {
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        log('alerta', 'Arbeitnow: cota temporária excedida (429); tentando na próxima varredura.');
        return [];
      }
      throw new Error(`HTTP ${resp.status}`);
    }

    const json = (await resp.json()) as ArbeitnowApiResponse;
    const lista = json.data || [];
    log('info', `Arbeitnow: ${lista.length} vaga(s) recebidas da API.`);

    for (const raw of lista) {
      if (novas.length >= MAX_VAGAS_POR_VARREDURA) break;
      if (!raw.slug) continue;

      const jaExiste = vagas.get(`arbeitnow:${raw.slug}`);
      if (jaExiste) continue;

      const v = montarVaga(raw, perfil, cfg, pref);
      if (!v) continue;

      vagas.salvar(v);
      novas.push(v);
    }

    kv.set('arbeitnow:ultimaBusca', new Date().toISOString());
    log('info', `Arbeitnow: ${novas.length} vaga(s) nova(s) gravada(s).`);
    emitir({ tipo: 'estado' });
  } catch (e) {
    log('alerta', `Arbeitnow: falha na busca (${(e as Error).message}).`);
  } finally {
    buscando = false;
  }

  return novas;
}
