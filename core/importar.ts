// "Estou numa vaga do InHire que achei pelo LinkedIn: candidata por mim, com o motor que já funciona."
//
// A extensão tem motor próprio, mas ele é genérico e novo. Nas plataformas que o núcleo já conhece, o caminho
// bom é outro: o adapter testado, com schema da API, adaptação de currículo, modo ensaio, trava de duplicidade e
// prova de envio. Este módulo é a ponte: recebe a URL que está aberta no seu navegador e devolve a vaga do
// núcleo — a que já estava na lista ou, quando dá, uma importada na hora.
import type { Vaga } from '../src/types.ts';
import { adapters } from './platforms/adapter.ts';
import { detalheVaga, type ResumoVagaInHire } from './platforms/inhire/api.ts';
import { montarVaga } from './platforms/inhire/discovery.ts';
import { filtrosDaAutomacao, ler } from './estado.ts';
import { log, vagas } from './storage/db.ts';

/**
 * Domínios de cada plataforma, para a extensão saber onde oferecer "candidatar pelo AutoCV".
 *
 * Mora aqui e não em cada adapter porque é a extensão que precisa disto, não o robô — e uma lista só é mais
 * fácil de conferir do que sete campos espalhados. `importa` diz se dá para trazer uma vaga que o AutoCV ainda
 * não varreu; nas outras, a vaga precisa já estar na lista (a varredura diária costuma dar conta).
 */
export const DOMINIOS: { id: string; dominios: string[]; importa: boolean }[] = [
  { id: 'inhire', dominios: ['inhire.app'], importa: true },
  { id: 'vagaspj', dominios: ['vagaspj.com.br'], importa: false },
  { id: 'divulgavagas', dominios: ['divulgavagas.com.br'], importa: false },
  { id: 'quickin', dominios: ['quickin.io'], importa: false },
  { id: 'workable', dominios: ['workable.com'], importa: false },
  { id: 'arbeitnow', dominios: ['arbeitnow.com'], importa: false },
  { id: 'indeed', dominios: ['indeed.com'], importa: false },
];

export const plataformasConhecidas = () =>
  DOMINIOS.filter(d => adapters[d.id]).map(d => ({ id: d.id, nome: adapters[d.id].nome, dominios: d.dominios, importa: d.importa, conectada: !!ler.conexoes()[d.id] }));

const daUrl = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** Qual plataforma do núcleo atende esta URL? */
export function plataformaDaUrl(url: string): (typeof DOMINIOS)[number] | null {
  const host = daUrl(url)?.hostname.replace(/^www\./, '') ?? '';
  return DOMINIOS.find(d => d.dominios.some(dom => host === dom || host.endsWith(`.${dom}`))) ?? null;
}

/** Mesma vaga, escrita de outro jeito: query de rastreio, barra no fim e www não mudam a vaga. */
const chaveUrl = (url: string) => {
  const u = daUrl(url);
  return u ? `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '').toLowerCase()}` : url.toLowerCase();
};

/** InHire: `https://<tenant>.inhire.app/[pagina/]vagas/<jobId>/<slug>` */
function inhireDaUrl(url: string): { tenant: string; jobId: string } | null {
  const u = daUrl(url);
  const tenant = u?.hostname.match(/^([^.]+)\.inhire\.app$/i)?.[1];
  const jobId = u?.pathname.match(/\/vagas\/([^/]+)/i)?.[1];
  return tenant && jobId ? { tenant, jobId } : null;
}

/**
 * A vaga desta URL, para o núcleo candidatar.
 *
 * Primeiro procura na lista (o normal: a varredura diária já trouxe). Se não achou e a plataforma permite,
 * importa a vaga sozinha — é o caso de uma empresa do InHire que você descobriu por fora e não está na sua
 * lista de empresas monitoradas. Erro aqui é mensagem para a tela, não exceção técnica.
 */
export async function vagaDaUrl(url: string): Promise<Vaga> {
  const plataforma = plataformaDaUrl(url);
  if (!plataforma) throw new Error('o AutoCV não tem adapter para este site — use o motor da própria extensão');
  if (!adapters[plataforma.id]) throw new Error(`a plataforma ${plataforma.id} não está carregada no núcleo`);

  const chave = chaveUrl(url);
  const achada = vagas.listar().find(v => chaveUrl(v.url) === chave);
  if (achada) return achada;

  const inhire = plataforma.id === 'inhire' ? inhireDaUrl(url) : null;
  if (!inhire) {
    throw new Error(
      plataforma.importa
        ? 'não consegui entender o endereço desta vaga'
        : `esta vaga do ${adapters[plataforma.id].nome} ainda não está na lista do AutoCV — rode uma varredura ("Buscar vagas agora") e tente de novo`,
    );
  }

  const perfil = ler.curriculos()[0]?.perfilBusca;
  if (!perfil) throw new Error('envie um currículo no AutoCV antes: é dele que sai o seu perfil de busca');
  const cfg = ler.automacao();
  const detalhe = await detalheVaga(inhire.tenant, inhire.jobId).catch(() => null);
  if (!detalhe) throw new Error('o InHire não devolveu esta vaga (pode ter sido encerrada)');

  const vaga = await montarVaga(inhire.tenant, { jobId: inhire.jobId } as ResumoVagaInHire, perfil, filtrosDaAutomacao(cfg, ler.localizacao()));
  vagas.salvar(vaga);
  log.registrar('info', `[extensão] "${vaga.titulo}" (${vaga.empresa}) importada da página que você abriu — compatibilidade ${vaga.score}.`);
  return vaga;
}
