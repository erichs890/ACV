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
 * Domínios de cada plataforma e QUEM atende cada uma. **Esta é a lista única.**
 *
 * Mora aqui e não em cada adapter porque é a extensão que precisa disto, não o robô — e uma lista só é mais
 * fácil de conferir do que sete campos espalhados. Antes a extensão tinha as suas próprias listas paralelas
 * (`PLATAFORMAS_COM_PAINEL` no painel, os `matches` do manifesto, os limites do `comum.js`), e nenhuma
 * consultava esta: um site podia estar em três delas e faltar na quarta sem ninguém perceber.
 *
 * `importa` diz se dá para trazer uma vaga que o ACV ainda não varreu; nas outras, a vaga precisa já estar
 * na lista (a varredura diária costuma dar conta).
 *
 * `motor` diz por onde a candidatura acontece:
 *  - `nucleo`   — o adapter testado do robô (adapta currículo, respeita ensaio, prova o envio pela resposta)
 *  - `extensao` — só o motor da extensão, no navegador da pessoa (plataforma sem adapter, como LinkedIn)
 *  - `ambos`    — os dois caminhos servem, e a extensão oferece a escolha
 *
 * `login` diz se a plataforma exige conta, e é **o que decide se a extensão aparece ali** (ver
 * `plataformasConhecidas`). Fica aqui e não só em `src/dados.ts` porque o LinkedIn nem está naquele catálogo
 * — e era justamente o buraco: `getPlataforma('linkedin')` caía na primeira plataforma da lista, o InHire.
 * O self-check cruza os dois.
 */
export type MotorDaPlataforma = 'nucleo' | 'extensao' | 'ambos';

export const DOMINIOS: { id: string; dominios: string[]; importa: boolean; motor: MotorDaPlataforma; login: boolean; nome?: string }[] = [
  { id: 'inhire', dominios: ['inhire.app'], importa: true, motor: 'nucleo', login: false },
  { id: 'vagaspj', dominios: ['vagaspj.com.br'], importa: false, motor: 'nucleo', login: false },
  { id: 'divulgavagas', dominios: ['divulgavagas.com.br'], importa: false, motor: 'nucleo', login: false },
  { id: 'quickin', dominios: ['quickin.io'], importa: false, motor: 'nucleo', login: false },
  { id: 'workable', dominios: ['workable.com'], importa: false, motor: 'nucleo', login: false },
  { id: 'arbeitnow', dominios: ['arbeitnow.com'], importa: false, motor: 'nucleo', login: false },
  // `motor: 'extensao'` porque o nucleo NAO envia aqui: o formulario do Lever tem hCaptcha, e quem clica
  // (e resolve o desafio, se aparecer) e a pessoa, no navegador dela. O adapter do nucleo so acha e ranqueia.
  { id: 'lever', dominios: ['jobs.lever.co'], importa: false, motor: 'extensao', login: false, nome: 'Lever' },
  { id: 'indeed', dominios: ['indeed.com'], importa: false, motor: 'ambos', login: true },
  { id: 'programathor', dominios: ['programathor.com.br'], importa: true, motor: 'ambos', login: true },
  // Sem adapter no núcleo: quem candidata é o motor da extensão, no navegador da pessoa. Entram aqui para
  // a extensão parar de guardar a própria lista — `nome` é obrigatório porque não há adapter de onde tirá-lo.
  { id: 'linkedin', dominios: ['linkedin.com'], importa: false, motor: 'extensao', login: true, nome: 'LinkedIn' },
  { id: 'gupy', dominios: ['gupy.io'], importa: false, motor: 'extensao', login: true, nome: 'Gupy' },
];

/**
 * O que a extensão recebe em `GET /extensao/plataformas` — **as plataformas em que o ACV sozinho não termina.**
 *
 * A regra, decidida em 05/10/2026: a extensão existe para fazer o que o ACV sozinho NÃO faz. Num site onde o
 * robô dá conta inteiro ele é melhor que a extensão, e com vantagem — adapta o currículo, respeita o modo
 * ensaio, prova o envio pela resposta HTTP e tem a trava de duplicidade. Painel aparecendo ali é ruído sobre
 * uma página onde não há nada a decidir.
 *
 * Eram duas as coisas que o robô não faz, e por meses só uma delas tinha nome:
 *
 *  - **entrar na sua conta** (`login: true` — LinkedIn, Gupy, Indeed, ProgramaThor);
 *  - **passar por captcha** — e isto apareceu com o Lever (06/10/2026), que não pede login nenhum e por isso
 *    passava pelo filtro antigo como se o robô resolvesse. Não resolve: o `/apply` tem hCaptcha, e captcha é
 *    anti-robô que este projeto não contorna. No seu navegador, com o seu clique, não há nada a contornar.
 *
 * Então o filtro é `login || motor === 'extensao'`: `motor` é justamente o campo que diz QUEM envia, e
 * plataforma cujo envio é da extensão tem de chegar à extensão, qualquer que seja o motivo. Filtrar por
 * `login` era filtrar pelo sintoma de um dos dois casos.
 *
 * As de `motor: 'extensao'` não têm adapter de envio e por isso não podem ser filtradas por `adapters[id]` —
 * senão a extensão ficaria sem saber dos sites que ela mesma atende, que foi o conserto de 03/10. Site
 * desconhecido continua ganhando o modo genérico, que não depende desta lista.
 *
 * O que se perde de propósito: a ponte do InHire (abrir a página de carreiras de uma empresa e importar uma
 * vaga que a varredura não trouxe). Para candidatar numa vaga do InHire ela precisa ter sido varrida.
 */
export const plataformasConhecidas = () => {
  const conexoes = ler.conexoes();
  return DOMINIOS.filter(d => (d.login || d.motor === 'extensao') && (d.motor !== 'nucleo' || adapters[d.id])).map(d => ({
    id: d.id,
    nome: adapters[d.id]?.nome ?? d.nome ?? d.id,
    dominios: d.dominios,
    importa: d.importa,
    motor: d.motor,
    conectada: !!conexoes[d.id],
    /**
     * O adapter do núcleo precisa de conta nesta plataforma, e a sessão DELE está valendo?
     *
     * Dois campos, não um, porque a diferença manda no que a extensão oferece. O adapter do núcleo é o caminho
     * melhor (adapta o currículo, respeita o ensaio, prova o envio pela resposta HTTP) — mas num site com
     * login ele só funciona se o navegador DO ROBÔ tiver a sessão, e esse navegador não é o seu. Sem isto, o
     * painel oferecia "Candidatar pelo ACV" no ProgramaThor e o envio morria em sessão ausente, com a pessoa
     * logada na tela na frente dele. É o mesmo erro de sempre: conferir no ponto errado do ciclo de vida.
     */
    exigeLogin: d.login,
    sessaoValida: conexoes[d.id]?.sessao?.valida === true,
  }));
};

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
  if (!plataforma) throw new Error('o ACV não tem adapter para este site — use o motor da própria extensão');
  // A lista conhece sites que só a extensão atende (LinkedIn, Gupy). Conhecer não é saber candidatar:
  // aqui a ponte recusa com o nome da plataforma, em vez de um "não está carregada no núcleo" técnico.
  if (plataforma.motor === 'extensao') throw new Error(`o ACV não tem adapter para ${plataforma.nome ?? plataforma.id} — a candidatura aí é pelo motor da própria extensão`);
  if (!adapters[plataforma.id]) throw new Error(`a plataforma ${plataforma.id} não está carregada no núcleo`);

  const chave = chaveUrl(url);
  const achada = vagas.listar().find(v => chaveUrl(v.url) === chave);
  if (achada) return achada;

  const inhire = plataforma.id === 'inhire' ? inhireDaUrl(url) : null;
  if (!inhire) {
    throw new Error(
      plataforma.importa
        ? 'não consegui entender o endereço desta vaga'
        : `esta vaga do ${adapters[plataforma.id].nome} ainda não está na lista do ACV — rode uma varredura ("Buscar vagas agora") e tente de novo`,
    );
  }

  const perfil = ler.curriculos()[0]?.perfilBusca;
  if (!perfil) throw new Error('envie um currículo no ACV antes: é dele que sai o seu perfil de busca');
  const cfg = ler.automacao();
  const detalhe = await detalheVaga(inhire.tenant, inhire.jobId).catch(() => null);
  if (!detalhe) throw new Error('o InHire não devolveu esta vaga (pode ter sido encerrada)');

  const vaga = await montarVaga(inhire.tenant, { jobId: inhire.jobId } as ResumoVagaInHire, perfil, filtrosDaAutomacao(cfg, ler.localizacao()));
  vagas.salvar(vaga);
  log.registrar('info', `[extensão] "${vaga.titulo}" (${vaga.empresa}) importada da página que você abriu — compatibilidade ${vaga.score}.`);
  return vaga;
}
