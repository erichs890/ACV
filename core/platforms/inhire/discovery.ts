import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigDescoberta, PerfilBusca, Vaga } from '../../../src/types.ts';
import type { Log } from '../adapter.ts';
import { detalheVaga, htmlParaTexto, listarVagas, urlVaga, configTenant, type ResumoVagaInHire } from './api.ts';
import { empresas, kv, vagas } from '../../storage/db.ts';
import { calcularScore, type FiltrosScore } from '../../resume/score.ts';
import { inferirSenioridade } from '../../resume/analyzer.ts';
import { paisDoLocal } from '../../localizacao.ts';
import { extrairSkills } from '../../resume/texto.ts';
import { emitir } from '../../events.ts';
import { passo, vistas } from '../../varredura.ts';

/**
 * Descoberta de vagas no InHire — separada da candidatura.
 * Fonte A: lista persistente de empresas (`empresas_inhire`), revisitada periodicamente pela API pública.
 * Fonte B: descoberta de novas empresas via Google Programmable Search (site:inhire.app), 1x/dia, se configurada.
 */

const PAUSA_ENTRE_EMPRESAS_MS = 2000;
const PAUSA_ENTRE_VAGAS_MS = 150; // só para vagas novas; as conhecidas não são reconsultadas
const FALHAS_PARA_DESATIVAR = 3;
const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Configuração (kv 'descoberta'; a chave do Google nunca vai ao front) ───
interface DescobertaArmazenada {
  intervaloHoras: number;
  fonteB: boolean;
  googleCx: string;
  googleKey: string;
  ultimaVarredura: string | null;
  ultimaFonteB: string | null;
}
const PADRAO: DescobertaArmazenada = { intervaloHoras: 6, fonteB: true, googleCx: '', googleKey: '', ultimaVarredura: null, ultimaFonteB: null };
export const lerDescoberta = (): DescobertaArmazenada => ({ ...PADRAO, ...kv.get<Partial<DescobertaArmazenada>>('descoberta', {}) });
export function salvarDescoberta(p: Partial<DescobertaArmazenada>) {
  const atual = lerDescoberta();
  kv.set('descoberta', { ...atual, ...p, googleKey: p.googleKey?.trim() ? p.googleKey.trim() : atual.googleKey });
}
let varrendo = false;
let progresso: ConfigDescoberta['progresso'] = null;
export const descobertaParaFront = (): ConfigDescoberta => {
  const d = lerDescoberta();
  return {
    intervaloHoras: d.intervaloHoras,
    fonteB: d.fonteB,
    googleCx: d.googleCx,
    googleKeyDefinida: d.googleKey.length > 0,
    ultimaVarredura: d.ultimaVarredura,
    ultimaFonteB: d.ultimaFonteB,
    varrendo,
    descobrindo,
    progresso,
  };
};

// Poucas requisições em paralelo por empresa: rápido o bastante sem parecer tráfego abusivo
const PARALELO = 3;
async function emLotes<T, R>(itens: T[], fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const saida: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < itens.length; i += PARALELO) {
    saida.push(...(await Promise.allSettled(itens.slice(i, i + PARALELO).map(fn))));
    if (i + PARALELO < itens.length) await dormir(PAUSA_ENTRE_VAGAS_MS);
  }
  return saida;
}

// ─── Seed ───
const SEED_VERSAO = 1; // suba quando o JSON ganhar empresas: as que faltam entram, as removidas pelo usuário não voltam

/** Importa as empresas da lista inicial que ainda não estão na tabela (uma vez por versão do seed, ou forçado). */
export function importarSeed(log?: Log, forcar = false) {
  if (!forcar && kv.get<number>('seedVersao', 0) >= SEED_VERSAO) return 0;
  const caminho = join(dirname(fileURLToPath(import.meta.url)), 'seed_empresas_inhire.json');
  const seed = JSON.parse(readFileSync(caminho, 'utf8')) as { empresas: { subdominio: string; nome: string }[] };
  const antes = new Set(empresas.listar().map(e => e.subdominio));
  for (const e of seed.empresas) empresas.inserir(e.subdominio, e.nome, 'seed');
  const novas = seed.empresas.filter(e => !antes.has(e.subdominio)).length;
  kv.set('seedVersao', SEED_VERSAO);
  if (novas) {
    log?.('info', `${novas} empresa(s) do InHire carregadas da lista inicial.`);
    salvarDescoberta({ ultimaVarredura: null }); // varre em seguida
  }
  return novas;
}

/** Versões anteriores guardavam as empresas em automacao.tenants; traz para a tabela e limpa. */
export function migrarTenantsAntigos(log?: Log) {
  const automacao = kv.get<{ tenants?: string[] }>('automacao', {});
  if (!automacao.tenants?.length) return;
  for (const t of automacao.tenants) empresas.inserir(t, t, 'manual');
  const { tenants: _fora, ...resto } = automacao;
  kv.set('automacao', resto);
  log?.('info', `${automacao.tenants.length} empresa(s) já cadastradas passaram para a lista de empresas monitoradas.`);
}

/** Aceita "empresa", "empresa.inhire.app" ou a URL da página de vagas. */
export function extrairSubdominio(entrada: string): string {
  const s = entrada.trim().toLowerCase();
  const m = s.match(/([a-z0-9-]+)\.inhire\.app/);
  const slug = m ? m[1] : s.replace(/^https?:\/\//, '').split(/[/?#.]/)[0];
  return slug === 'www' || slug === 'api' ? '' : slug.replace(/[^a-z0-9-]/g, '');
}

/** Adiciona uma empresa depois de confirmar na API que ela existe e está ativa. */
export async function adicionarEmpresa(entrada: string, origem: 'manual' | 'busca', log?: Log): Promise<{ subdominio: string; nome: string }> {
  const subdominio = extrairSubdominio(entrada);
  if (!subdominio) throw new Error('informe o subdomínio como em <empresa>.inhire.app');
  if (empresas.get(subdominio)) throw new Error(`${subdominio} já está na lista`);
  const cfg = await configTenant(subdominio);
  if (!cfg) throw new Error(`${subdominio}.inhire.app não existe`);
  if (cfg.status !== 'active') throw new Error(`${cfg.name || subdominio} está inativa no InHire`);
  empresas.inserir(subdominio, cfg.name || subdominio, origem);
  log?.('sucesso', `Nova empresa no InHire: ${cfg.name || subdominio} (${subdominio}.inhire.app)${origem === 'busca' ? ' — achada pela busca' : ''}.`);
  emitir({ tipo: 'estado' });
  return { subdominio, nome: cfg.name || subdominio };
}

// ─── Fonte A: varredura da lista ───
const MODELO: Record<string, Vaga['modelo']> = { Remote: 'remoto', Hybrid: 'hibrido', 'On-site': 'presencial' };
const regimeDe = (tipos: string[]): Vaga['regime'] => {
  const t = tipos.map(x => x.toUpperCase());
  const clt = t.some(x => x.includes('CLT'));
  const pj = t.some(x => x.includes('PJ'));
  return clt && pj ? 'ambos' : clt ? 'CLT' : pj ? 'PJ' : 'indefinido';
};
const requisitosDe = (texto: string) => (texto.match(/requisitos?[\s\S]*?(?=\n(?:benef|diferen|compet|sobre|o que oferecemos|faixa)|$)/i)?.[0] ?? '').trim().slice(0, 2000);
const idVaga = (tenant: string, jobId: string) => `inhire:${tenant}:${jobId}`;

export async function montarVaga(tenant: string, resumo: ResumoVagaInHire, perfil: PerfilBusca, filtros: FiltrosScore): Promise<Vaga> {
  const d = await detalheVaga(tenant, resumo.jobId);
  const descricao = htmlParaTexto(d.description ?? '');
  const skills = extrairSkills(`${d.displayName}\n${descricao}`);
  const vaga: Vaga = {
    id: idVaga(tenant, d.jobId),
    plataforma: 'inhire',
    tenant,
    titulo: d.displayName.trim(),
    empresa: d.tenantName || tenant,
    descricao,
    requisitos: requisitosDe(descricao),
    regime: regimeDe(d.contractType ?? []),
    senioridade: inferirSenioridade(d.displayName, descricao),
    modelo: MODELO[d.workplaceType ?? ''] ?? 'indefinido',
    local: d.location ?? '',
    pais: paisDoLocal(d.location ?? ''),
    url: urlVaga(tenant, d.jobId, d.displayName, d.careerPageId),
    skills,
    camposConhecidos: d.settings?.fields ?? [],
    score: 0,
    status: 'encontrada',
    encontradaEm: new Date().toISOString(),
    atualizadaEm: new Date().toISOString(),
  };
  const a = calcularScore(vaga, perfil, filtros);
  vaga.score = a.score;
  vaga.motivo = a.motivo;
  return vaga;
}

/** Visita cada empresa ativa, grava vagas novas, marca as que sumiram como encerradas. Devolve as novas. */
export async function varrer(perfil: PerfilBusca, filtros: FiltrosScore & { scoreMinimo: number }, log: Log): Promise<Vaga[]> {
  if (varrendo) {
    log('alerta', 'Já existe uma varredura em andamento.');
    return [];
  }
  varrendo = true;
  emitir({ tipo: 'estado' });
  const novas: Vaga[] = [];
  try {
    const lista = empresas.listar().filter(e => e.ativo);
    log('info', `Varredura iniciada: ${lista.length} empresa(s) do InHire.`);
    const conhecidas = new Map(
      vagas
        .listar()
        .filter(v => v.plataforma === 'inhire')
        .map(v => [v.id, v]),
    );

    for (const [i, e] of lista.entries()) {
      progresso = { atual: i + 1, total: lista.length, empresa: e.nome || e.subdominio };
      // A barra do botão "Procurar vagas" também precisa saber: o InHire é a parte mais longa da varredura
      // (uma requisição por empresa) e sem isto ela ficava parada em "começando" o tempo todo.
      passo(`empresa ${e.nome || e.subdominio}`, i + 1, lista.length);
      if (i % 5 === 0) emitir({ tipo: 'estado' });
      if (i > 0) await dormir(PAUSA_ENTRE_EMPRESAS_MS);
      let resultado: Awaited<ReturnType<typeof listarVagas>>;
      try {
        resultado = await listarVagas(e.subdominio);
      } catch (err) {
        const falhas = e.falhas + 1;
        const desativar = falhas >= FALHAS_PARA_DESATIVAR;
        empresas.atualizar(e.subdominio, { falhas, ativo: !desativar, ultimaVerificacao: new Date().toISOString() });
        log(desativar ? 'alerta' : 'erro', `${e.nome || e.subdominio}: ${(err as Error).message}${desativar ? ' — desativada após 3 falhas seguidas' : ''}.`);
        continue;
      }
      const publicadas = new Set(resultado.vagas.map(v => idVaga(e.subdominio, v.jobId)));
      const pendentes = resultado.vagas.filter(v => !conhecidas.has(idVaga(e.subdominio, v.jobId)));
      let novasAqui = 0;
      const lidas = await emLotes(pendentes, resumo => montarVaga(e.subdominio, resumo, perfil, filtros));
      for (const [k, r] of lidas.entries()) {
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (v.score < filtros.scoreMinimo) v.status = 'ignorada';
          vagas.salvar(v);
          novas.push(v);
          novasAqui++;
        } else {
          log('alerta', `${e.nome}: não consegui ler a vaga "${pendentes[k].displayName}" (${(r.reason as Error).message}); pulada.`);
        }
      }
      let encerradas = 0;
      for (const v of conhecidas.values()) {
        if (v.tenant === e.subdominio && !publicadas.has(v.id) && ['encontrada', 'ignorada', 'na_fila'].includes(v.status)) {
          vagas.atualizar(v.id, { status: 'encerrada', posicao: undefined });
          encerradas++;
        }
      }
      empresas.atualizar(e.subdominio, { nome: resultado.tenantName || e.nome, totalVagas: resultado.vagas.length, falhas: 0, ultimaVerificacao: new Date().toISOString() });
      if (novasAqui || encerradas)
        log('info', `${resultado.tenantName || e.subdominio}: ${resultado.vagas.length} vagas publicadas, ${novasAqui} nova(s)${encerradas ? `, ${encerradas} encerrada(s)` : ''}.`);
    }
    vistas(conhecidas.size);
    salvarDescoberta({ ultimaVarredura: new Date().toISOString() });
    log('sucesso', `Varredura concluída: ${novas.length} vaga(s) nova(s) em ${lista.length} empresa(s).`);
  } finally {
    varrendo = false;
    progresso = null;
    emitir({ tipo: 'estado' });
  }
  return novas;
}

// ─── Fonte B: novas empresas ───
// Subdomínios de infraestrutura do próprio InHire (nunca são empresas)
const INFRA = /^(www|api|app|status|inhub|data-viz|inhire-admin|saml-setup|mcp|mcp-dev|.*\.plugin)$/;
let descobrindo = false;

/** Common Crawl: índice público e gratuito da web; lista URLs já rastreadas em *.inhire.app. Sem chave. */
async function candidatosCommonCrawl(log: Log, maxIndices = 10): Promise<Set<string>> {
  const achados = new Set<string>();
  let colecoes: { id: string }[];
  try {
    colecoes = (await (await fetch('https://index.commoncrawl.org/collinfo.json', { signal: AbortSignal.timeout(20000) })).json()) as { id: string }[];
  } catch (e) {
    log('alerta', `Common Crawl indisponível agora (${(e as Error).message}).`);
    return achados;
  }
  for (const { id } of colecoes.slice(0, maxIndices)) {
    try {
      const r = await fetch(`https://index.commoncrawl.org/${id}-index?url=*.inhire.app&output=json&fl=url&filter==status:200`, { signal: AbortSignal.timeout(90000) });
      if (!r.ok) continue;
      for (const linha of (await r.text()).split('\n')) {
        try {
          const s = extrairSubdominio((JSON.parse(linha) as { url: string }).url);
          if (s && !INFRA.test(s)) achados.add(s);
        } catch {
          /* linha vazia ou inválida */
        }
      }
    } catch {
      /* índice fora do ar: segue para o próximo */
    }
    await dormir(1000);
  }
  return achados;
}

/** Google Programmable Search (opcional): só roda se chave e cx estiverem configurados. */
async function candidatosGoogle(perfil: PerfilBusca | undefined): Promise<Set<string>> {
  const d = lerDescoberta();
  const achados = new Set<string>();
  if (!d.googleKey || !d.googleCx) return achados;
  const consultas = [
    'site:inhire.app vagas',
    'site:inhire.app "candidatar"',
    ...(perfil ? [`site:inhire.app vagas ${perfil.area}`, ...perfil.cargos.slice(0, 2).map(c => `site:inhire.app ${c}`)] : []),
  ];
  for (const q of consultas) {
    for (const start of [1, 11]) {
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(d.googleKey)}&cx=${encodeURIComponent(d.googleCx)}&q=${encodeURIComponent(q)}&start=${start}&num=10`;
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const j = (await r.json().catch(() => ({}))) as { error?: { message?: string }; items?: { link?: string }[] };
      if (!r.ok) throw new Error(`Google Search ${r.status}: ${j.error?.message ?? 'erro'}`);
      for (const item of j.items ?? []) {
        const s = extrairSubdominio(item.link ?? '');
        if (s && !INFRA.test(s)) achados.add(s);
      }
      if ((j.items?.length ?? 0) < 10) break;
      await dormir(500);
    }
  }
  return achados;
}

/** Junta as fontes, confirma cada subdomínio na API do InHire e adiciona as empresas ativas. */
export async function descobrirEmpresas(perfil: PerfilBusca | undefined, log: Log): Promise<number> {
  if (descobrindo) throw new Error('já existe uma descoberta em andamento');
  descobrindo = true;
  try {
    log('info', `Procurando empresas que usam o InHire (Common Crawl${lerDescoberta().googleKey ? ' + Google' : ''})...`);
    const candidatos = new Set<string>();
    for (const s of await candidatosCommonCrawl(log)) candidatos.add(s);
    try {
      for (const s of await candidatosGoogle(perfil)) candidatos.add(s);
    } catch (e) {
      log('alerta', `Google: ${(e as Error).message}`);
    }
    const novosCandidatos = [...candidatos].filter(s => !empresas.get(s));
    log('info', `${candidatos.size} subdomínio(s) encontrados, ${novosCandidatos.length} ainda não conhecidos; conferindo na API do InHire...`);
    let novas = 0;
    let inativas = 0;
    for (const s of novosCandidatos) {
      try {
        await adicionarEmpresa(s, 'busca', log);
        novas++;
      } catch {
        inativas++; // não existe mais ou está inativa: não vale registrar cada uma
      }
      await dormir(400);
    }
    salvarDescoberta({ ultimaFonteB: new Date().toISOString(), ...(novas ? { ultimaVarredura: null } : {}) }); // com empresas novas, a varredura roda em seguida
    log(novas ? 'sucesso' : 'info', `Descoberta concluída: ${novas} empresa(s) nova(s)${inativas ? `, ${inativas} descartada(s) por estarem inativas ou não existirem` : ''}.`);
    return novas;
  } finally {
    descobrindo = false;
    emitir({ tipo: 'estado' });
  }
}

export const estaDescobrindo = () => descobrindo;
