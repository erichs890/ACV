// Descoberta de vagas no Lever: uma requisição por empresa traz a lista inteira dela.
//
// É a listagem mais barata do projeto. No Vagas PJ e no Divulga Vagas é preciso abrir a página de cada vaga só
// para saber o que ela é — e por isso existe a peneira de `core/peneira.ts`, que corta pelo slug antes de
// baixar. Aqui a API devolve título, local, país e modelo de trabalho de TODAS as vagas da empresa de uma vez,
// e nenhuma vaga é aberta para ser descartada.
//
// **O corpo do anúncio, porém, nem sempre vem na API** — e isto decidiu metade deste arquivo. Medido em
// 06/10/2026: Neon, dLocal e Coupa mandam o anúncio em `lists[]` (as seções "Requisitos",
// "Responsabilidades"); CI&T, Swile e Zippi mandam `lists: []`, e a Swile e a Zippi nem `openingPlain` têm.
// Nesses, o que a API dá é a apresentação da empresa e os benefícios. Pontuar por isso seria pontuar o "Sobre
// nós": o score é competências (60) + título (40), então uma vaga de Java/Angular ficaria sem competência
// nenhuma e seria descartada por nota baixa — as 158 vagas brasileiras da CI&T, por exemplo. Quando `lists`
// vem vazio, o anúncio é lido da página (`data-qa="job-description"`), uma requisição por vaga NOVA.
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import type { PreferenciasLocalizacao } from '../../../src/paises.ts';
import type { Log } from '../adapter.ts';
import { passo, vistas } from '../../varredura.ts';
import { htmlParaTexto } from '../inhire/api.ts';
import { extrairSkills } from '../../resume/texto.ts';
import { filtrosDaAutomacao } from '../../estado.ts';
import { calcularScore } from '../../resume/score.ts';
import { inferirSenioridade } from '../../resume/analyzer.ts';
import { lerLocal, paisDoIso, paisDoLocal, vagaCompativelComLocalizacao, type Compatibilidade } from '../../localizacao.ts';
import { kv, vagas } from '../../storage/db.ts';
import { emitir } from '../../events.ts';
import { boardsLever, descobrirBoardsLever, importarSeedLever, vagasDoBoard, type VagaLever } from './boards.ts';
import { BOARDS_POR_VARREDURA, DIAS_DE_VALIDADE, FALHAS_PARA_DESATIVAR, MAX_VAGAS_POR_BOARD, MAX_VAGAS_POR_VARREDURA, PAUSA_ENTRE_BOARDS_MS, PAUSA_ENTRE_PAGINAS_MS } from './seletores.ts';

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));
const UA = { 'user-agent': 'ACV/1.0 (uso pessoal)' };

export const idDaVaga = (board: string, id: string) => `lever:${board}:${id}`;

export function modeloDe(workplaceType?: string): Vaga['modelo'] {
  switch ((workplaceType ?? '').toLowerCase()) {
    case 'remote':
      return 'remoto';
    case 'hybrid':
      return 'hibrido';
    case 'onsite':
    case 'on-site':
      return 'presencial';
    default:
      return 'indefinido';
  }
}

/**
 * O regime, e ele quase sempre sai `indefinido` — de propósito.
 *
 * `categories.commitment` é texto livre que a empresa digita. Em 157 vagas medidas veio como tipo de contrato
 * ("Permanent Full Time Employee"), como senioridade ("Mid-Senior Level", "Director"), como modelo de trabalho
 * ("Homeoffice", na CI&T) e como regime ("CLT"). Só o literal passa. Traduzir "Permanent Full Time" para CLT
 * seria adivinhar — empresa estrangeira contratando no Brasil escreve "Permanent" para contrato PJ com a mesma
 * naturalidade — e `regimePreferido` é filtro que tira vaga da fila: errar aqui esconde vaga boa ou manda
 * currículo para um contrato que a pessoa não aceita. `indefinido` passa pelo filtro e deixa ela ler o anúncio.
 */
export function regimeDe(commitment?: string): Vaga['regime'] {
  const c = (commitment ?? '').toUpperCase();
  const clt = /\bCLT\b/.test(c);
  const pj = /\bPJ\b|PESSOA JUR[ÍI]DICA/.test(c);
  if (clt && pj) return 'ambos';
  if (clt) return 'CLT';
  if (pj) return 'PJ';
  return 'indefinido';
}

/** O anúncio vem na API, ou é preciso abrir a página? `lists` é onde o Lever guarda o corpo da vaga. */
export const corpoFaltaNaApi = (v: VagaLever): boolean => !(v.lists ?? []).some(l => (l.content ?? '').trim().length > 0);

/**
 * O anúncio dentro da página da vaga: o que está entre `data-qa="job-description"` e o fim da descrição.
 *
 * Marcador de dado, não estrutura de HTML: `data-qa` existe justamente para automação de teste e não muda a
 * cada ajuste de layout, enquanto contar `<div>` aninhada quebraria no primeiro ajuste de CSS.
 */
export function corpoDaPagina(html: string): string {
  const marca = html.indexOf('data-qa="job-description"');
  if (marca < 0) return '';
  const abre = html.indexOf('>', marca);
  if (abre < 0) return '';
  const resto = html.slice(abre + 1);
  const fim = resto.search(/data-qa="(closing-description|btn-apply-bottom|show-page-apply)"/);
  return htmlParaTexto(fim > 0 ? resto.slice(0, fim) : resto.slice(0, 40_000)).trim();
}

/** O anúncio em texto: o que a API tem (abertura, seções do `lists`, fechamento) mais o corpo lido da página. */
export function descricaoDe(v: VagaLever, corpo = ''): string {
  const partes = [v.openingPlain?.trim() || htmlParaTexto(v.descriptionPlain ?? '').trim(), corpo.trim()];
  for (const l of v.lists ?? []) {
    const texto = htmlParaTexto(l.content ?? '').trim();
    if (texto) partes.push([l.text?.trim(), texto].filter(Boolean).join('\n'));
  }
  if (v.additionalPlain?.trim()) partes.push(v.additionalPlain.trim());
  // O corpo da página repete a abertura que a API já deu: sem isto a descrição sai com o "Sobre nós" em dobro
  const vistos = new Set<string>();
  const unicas: string[] = [];
  for (const p of partes) {
    if (!p || vistos.has(p)) continue;
    vistos.add(p);
    unicas.push(p);
  }
  return unicas.join('\n\n').trim();
}

/** A seção de requisitos, quando a empresa nomeou uma. PT e EN, porque os boards têm as duas. */
const TITULO_DE_REQUISITOS = /requisit|requirement|qualifica|what (you|we).{0,25}(bring|looking for|need)|sobre voc[êe]|o que esperamos|perfil/i;

export function requisitosDe(v: VagaLever): string {
  const secao = (v.lists ?? []).find(l => TITULO_DE_REQUISITOS.test(l.text ?? ''));
  return htmlParaTexto(secao?.content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

/**
 * Onde a vaga é — e **a vaga pode ser em mais de um lugar**.
 *
 * `categories.location` é o rótulo que a empresa escolheu mostrar, e ele pode ser mais largo que a verdade: na
 * CI&T diz "Brazil" enquanto `allLocations` diz `["Brazil", "Campinas, SP", "São Paulo, SP"]`. Usar só o
 * rótulo faria uma vaga HÍBRIDA em Campinas passar como compatível para quem mora em Fortaleza — sem cidade e
 * sem UF no texto, a regra de localização não tem o que reprovar e devolve "compatível". É exatamente o
 * caminho pelo qual sete candidaturas presenciais erradas saíram em 28/09/2026.
 *
 * Então cada lugar possível passa pela regra única (`vagaCompativelComLocalizacao`, nunca uma segunda cópia
 * dela) e vence o melhor: se existe UM lugar onde dá para trabalhar, a vaga vale, e é esse lugar que fica
 * gravado — assim a tela mostra o motivo certo. Vaga aberta em Campinas e em Fortaleza não é descartada por
 * causa de Campinas, e vaga aberta só em Campinas não passa por causa do rótulo "Brazil".
 */
export function melhorLocal(v: VagaLever, pais: string, modelo: Vaga['modelo'], pref: PreferenciasLocalizacao): { local: string; lugar: Compatibilidade } {
  const rotulo = (v.categories?.location ?? '').trim();
  const todos = [...new Set([...(v.categories?.allLocations ?? []).map(l => l.trim()), rotulo].filter(Boolean))];

  /**
   * E **lugar vago não compete com lugar específico.**
   *
   * "Brazil" aparece na mesma `allLocations` que "Campinas, SP" e "São Paulo, SP", e é o primeiro da lista.
   * Pegar o melhor entre os três faria "Brazil" ganhar sempre — ele não tem cidade nem UF, então a regra não
   * tem o que reprovar e devolve compatível sem desconto, que é a nota máxima. O rótulo largo venceria as
   * cidades verdadeiras e o conserto não teria consertado nada (o teste do self-check pegou exatamente isto).
   *
   * Quando alguma entrada diz cidade ou estado, só essas valem: elas são o que a vaga é de fato, e a entrada
   * larga é só o país repetido. Sem nenhuma específica, a larga é tudo o que existe e aí ela decide.
   */
  const especificos = todos.filter(l => {
    const { cidade, uf } = lerLocal(l);
    return !!(cidade || uf);
  });
  const candidatos = especificos.length ? especificos : todos;
  if (!candidatos.length) return { local: '', lugar: vagaCompativelComLocalizacao({ modelo, local: '', pais }, pref) };

  let melhor = { local: candidatos[0], lugar: vagaCompativelComLocalizacao({ modelo, local: candidatos[0], pais }, pref) };
  for (const local of candidatos.slice(1)) {
    if (melhor.lugar.fator >= 1) break; // não há melhor que "sem desconto"
    const lugar = vagaCompativelComLocalizacao({ modelo, local, pais }, pref);
    if (lugar.fator > melhor.lugar.fator) melhor = { local, lugar };
  }
  return melhor;
}

export function montarVaga(board: string, nomeDaEmpresa: string, v: VagaLever, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, corpo = ''): Vaga | null {
  if (!v.id || !v.text?.trim() || !v.hostedUrl) return null;
  // Vaga antiga que ninguém tirou do board já foi preenchida. `createdAt` é em milissegundos.
  if (v.createdAt && Date.now() - v.createdAt > DIAS_DE_VALIDADE * 86_400_000) return null;

  const titulo = v.text.trim();
  const descricao = descricaoDe(v, corpo);
  const modelo = modeloDe(v.workplaceType);
  // O país vem do campo DECLARADO (`country`, em ISO), não do texto do local: "Centro-Oeste do Brasil" não tem
  // cidade nem UF, e `paisDoLocal` lê sigla de duas letras como UF brasileira de propósito (ver localizacao.ts).
  const pais = (v.country ? paisDoIso(v.country) : '') || paisDoLocal((v.categories?.location ?? '').trim());
  const { local, lugar } = melhorLocal(v, pais, modelo, pref);
  const skills = extrairSkills(`${titulo}\n${descricao}`);

  const base = { titulo, empresa: nomeDaEmpresa, modelo, local, pais, descricao, skills };
  const { score, motivo } = calcularScore(base, perfil, filtrosDaAutomacao(cfg, pref));
  const agora = new Date().toISOString();

  return {
    id: idDaVaga(board, v.id),
    plataforma: 'lever',
    tenant: board,
    titulo,
    empresa: nomeDaEmpresa,
    descricao,
    requisitos: requisitosDe(v) || skills.join(', '),
    regime: regimeDe(v.categories?.commitment),
    senioridade: inferirSenioridade(titulo, descricao),
    modelo,
    local: local || (modelo === 'remoto' ? 'Remoto' : pais),
    pais,
    url: v.hostedUrl,
    skills,
    camposConhecidos: [],
    score,
    motivo: [motivo, lugar.compativel ? '' : lugar.motivo].filter(Boolean).join(' · '),
    status: score >= cfg.scoreMinimo && lugar.compativel ? 'encontrada' : 'ignorada',
    encontradaEm: agora,
    atualizadaEm: agora,
  };
}

/** A página da vaga, ou '' se ela não abrir. */
async function pagina(url: string): Promise<string> {
  try {
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    return r.ok ? await r.text() : '';
  } catch {
    return '';
  }
}

let buscando = false;

export async function buscarNoLever(perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, log: Log, manual = false): Promise<Vaga[]> {
  if (buscando) return [];
  buscando = true;
  const novas: Vaga[] = [];
  let examinadas = 0;

  try {
    importarSeedLever(log);
    // A descoberta só roda quando VOCÊ pediu a busca: ela confere dezenas de candidatos a uma requisição por
    // segundo, trabalho demais para a varredura automática de cada 6 h carregar junto.
    if (manual) {
      passo('procurando empresas novas');
      const achados = await descobrirBoardsLever(log);
      if (achados) log('sucesso', `Lever: ${achados} empresa(s) nova(s) entraram na lista.`);
    }

    const lista = boardsLever.aVisitar(BOARDS_POR_VARREDURA);
    if (!lista.length) {
      log('alerta', 'Lever: nenhuma empresa na lista. Adicione um board (jobs.lever.co/<empresa>) para começar.');
      return [];
    }
    log('info', `Lever: lendo ${lista.length} empresa(s) de ${boardsLever.listar().length} cadastradas.`);

    for (const [i, b] of lista.entries()) {
      passo(`empresa ${b.nome}`, i + 1, lista.length);
      if (i > 0) await dormir(PAUSA_ENTRE_BOARDS_MS);
      if (novas.length >= MAX_VAGAS_POR_VARREDURA) {
        log('info', `Lever: teto de ${MAX_VAGAS_POR_VARREDURA} vagas novas nesta rodada; o resto fica para a próxima.`);
        break;
      }

      let publicadas: VagaLever[] | null;
      try {
        publicadas = await vagasDoBoard(b.slug);
      } catch (e) {
        const falhas = b.falhas + 1;
        const desativar = falhas >= FALHAS_PARA_DESATIVAR;
        boardsLever.atualizar(b.slug, { falhas, ativo: !desativar, ultimaVerificacao: new Date().toISOString() });
        log(desativar ? 'alerta' : 'erro', `Lever/${b.nome}: ${(e as Error).message}${desativar ? ` — desativada após ${FALHAS_PARA_DESATIVAR} falhas seguidas` : ''}.`);
        continue;
      }
      if (publicadas === null) {
        boardsLever.atualizar(b.slug, { ativo: false, ultimaVerificacao: new Date().toISOString() });
        log('alerta', `Lever: jobs.lever.co/${b.slug} não existe mais; empresa desativada.`);
        continue;
      }

      examinadas += publicadas.length;

      // O que saiu do board é encerrado no banco, em vez de ficar na tela parecendo disponível
      let encerradas = 0;
      const noAr = new Set(publicadas.map(v => idDaVaga(b.slug, v.id)));
      for (const v of vagas.listar()) {
        if (v.plataforma === 'lever' && v.tenant === b.slug && !noAr.has(v.id) && ['encontrada', 'ignorada', 'na_fila'].includes(v.status)) {
          vagas.atualizar(v.id, { status: 'encerrada', posicao: undefined });
          encerradas++;
        }
      }

      const ineditas = publicadas.filter(v => !vagas.get(idDaVaga(b.slug, v.id)));
      let novasAqui = 0;
      let paginasLidas = 0;
      // "Ficou para depois" e "foi descartada" são coisas diferentes, e o log tem de separá-las: vaga parada
      // no teto volta na próxima rodada, vaga velha ou sem página NÃO volta nunca. Contar as duas juntas
      // dizia "10 para a próxima rodada" sobre dez vagas da Swile que tinham passado dos 180 dias.
      let paradasNoTeto = 0;
      for (const bruta of ineditas) {
        if (novas.length >= MAX_VAGAS_POR_VARREDURA || novasAqui >= MAX_VAGAS_POR_BOARD) {
          paradasNoTeto = ineditas.length - ineditas.indexOf(bruta);
          break;
        }
        let corpo = '';
        if (corpoFaltaNaApi(bruta)) {
          if (paginasLidas > 0) await dormir(PAUSA_ENTRE_PAGINAS_MS);
          paginasLidas++;
          passo(`${b.nome}: lendo o anúncio das vagas novas`, paginasLidas, ineditas.length);
          const html = await pagina(bruta.hostedUrl);
          // Página que não abre é o caso `aircall`: a API serve vaga que já saiu do ar. Não grava nada.
          if (!html) {
            log('alerta', `Lever/${b.nome}: a página de "${bruta.text.slice(0, 50)}" não abriu; vaga não gravada.`);
            continue;
          }
          corpo = corpoDaPagina(html);
        }
        const v = montarVaga(b.slug, b.nome, bruta, perfil, cfg, pref, corpo);
        if (!v) continue;
        vagas.salvar(v);
        novas.push(v);
        novasAqui++;
      }

      boardsLever.atualizar(b.slug, { totalVagas: publicadas.length, falhas: 0, ultimaVerificacao: new Date().toISOString() });
      const descartadas = ineditas.length - novasAqui - paradasNoTeto;
      if (novasAqui || encerradas)
        log(
          'info',
          `Lever/${b.nome}: ${publicadas.length} publicada(s), ${novasAqui} nova(s)${encerradas ? `, ${encerradas} encerrada(s)` : ''}${paradasNoTeto > 0 ? `, ${paradasNoTeto} para a próxima rodada` : ''}${descartadas > 0 ? `, ${descartadas} descartada(s) por idade ou página fora do ar` : ''}.`,
        );
    }

    vistas(examinadas);
    kv.set('lever:ultimaBusca', new Date().toISOString());
    log('info', `Lever: ${novas.length} vaga(s) nova(s) em ${lista.length} empresa(s). O envio é pelo seu navegador — o formulário do Lever tem captcha.`);
    emitir({ tipo: 'estado' });
  } finally {
    buscando = false;
  }

  return novas;
}
