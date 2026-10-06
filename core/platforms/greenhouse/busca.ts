// Descoberta de vagas no Greenhouse: uma requisição por empresa, e ela traz o anúncio INTEIRO.
//
// É a varredura mais barata do projeto — mais até que a do Lever, onde metade dos boards obriga a abrir a
// página de cada vaga para ter o corpo do anúncio. Aqui `?content=true` devolve tudo: 91 vagas do QuintoAndar
// com 10 mil caracteres de anúncio cada, numa só requisição. Nenhuma página é aberta em nenhum momento.
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import type { PreferenciasLocalizacao } from '../../../src/paises.ts';
import type { Log } from '../adapter.ts';
import { passo, vistas } from '../../varredura.ts';
import { htmlParaTexto } from '../inhire/api.ts';
import { extrairSkills } from '../../resume/texto.ts';
import { filtrosDaAutomacao } from '../../estado.ts';
import { calcularScore } from '../../resume/score.ts';
import { inferirSenioridade } from '../../resume/analyzer.ts';
import { melhorLugar, paisDoLocal } from '../../localizacao.ts';
import { kv, vagas } from '../../storage/db.ts';
import { emitir } from '../../events.ts';
import { boardsGreenhouse, importarSeedGreenhouse, vagasDoBoard, type VagaGreenhouse } from './boards.ts';
import { BOARDS_POR_VARREDURA, DIAS_DE_VALIDADE, FALHAS_PARA_DESATIVAR, MAX_VAGAS_POR_BOARD, MAX_VAGAS_POR_VARREDURA, PAUSA_ENTRE_BOARDS_MS } from './seletores.ts';

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

export const idDaVaga = (board: string, id: number | string) => `greenhouse:${board}:${id}`;

/**
 * O `content` do Greenhouse vem com o HTML **duas vezes escapado**: `&lt;p&gt;Olá&lt;/p&gt;`.
 *
 * Sem desfazer isso primeiro, `htmlParaTexto` não vê tag nenhuma (para ele o texto não tem `<`), devolve a
 * string com `&lt;p&gt;` dentro, e as competências saem de um texto cheio de marcação — o score pontuaria
 * lixo. Desescapar e só então tirar as tags.
 */
export function anuncioEmTexto(content = ''): string {
  const umaVez = content
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return htmlParaTexto(umaVez).trim();
}

/**
 * Os lugares possíveis desta vaga.
 *
 * `location.name` é texto livre e pode trazer VÁRIOS lugares separados por `;`
 * ("Brasil; São Paulo, São Paulo, Brazil"). E quando ele diz só "Brasil", é em `offices[].name` que está a
 * cidade de verdade — medido no QuintoAndar, onde vagas com `location: "Brasil"` têm `offices: ["São Paulo"]`.
 * Quem escolhe entre os candidatos é `melhorLugar`, a regra compartilhada com o Lever.
 */
export const locaisDe = (v: VagaGreenhouse): string[] => [...(v.location?.name ?? '').split(';'), ...(v.offices ?? []).map(o => o.name ?? o.location ?? '')];

/**
 * O modelo de trabalho, que o Greenhouse **não tem como campo** — está escrito no texto do local.
 *
 * Medido em 667 vagas: "Brazil (Remote)", "Brazil (São Paulo - Hybrid)", "Remoto", "São Paulo, São Paulo,
 * Brazil". Quando o local não diz nada, o começo do anúncio é a segunda chance; não dizendo nada também, fica
 * `indefinido` — que passa pelos filtros e deixa a pessoa ler, em vez de inventar presencial e esconder a vaga.
 */
export function modeloDe(local: string, anuncio = ''): Vaga['modelo'] {
  const texto = `${local}\n${anuncio.slice(0, 1200)}`;
  if (/\bh[íi]brid[oa]\b|\bhybrid\b/i.test(texto)) return 'hibrido';
  if (/\bremot[oa]\b|\bremote\b|home office|teletrabalho|anywhere/i.test(texto)) return 'remoto';
  if (/\bpresencial\b|\bon[- ]?site\b|\bin[- ]office\b/i.test(texto)) return 'presencial';
  return 'indefinido';
}

/** A seção de requisitos dentro do anúncio, quando a empresa nomeou uma. */
const TITULO_DE_REQUISITOS = /^(requisitos?|requirements?|qualifica[çc][õo]es|qualifications|what (you|we).{0,25}(bring|looking for|need)|o que esperamos|sobre voc[êe])\b.*$/im;

export function requisitosDe(anuncio: string): string {
  const m = anuncio.match(TITULO_DE_REQUISITOS);
  if (!m || m.index === undefined) return '';
  return anuncio
    .slice(m.index, m.index + 2000)
    .replace(/\s+/g, ' ')
    .trim();
}

export function montarVaga(board: string, nomeDoBoard: string, v: VagaGreenhouse, perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao): Vaga | null {
  if (!v.id || !v.title?.trim() || !v.absolute_url) return null;
  // Vaga parada há meio ano no board já foi preenchida e ninguém a tirou do ar
  const quando = v.updated_at ?? v.first_published;
  if (quando && Date.now() - new Date(quando).getTime() > DIAS_DE_VALIDADE * 86_400_000) return null;

  const titulo = v.title.trim();
  const descricao = anuncioEmTexto(v.content);
  const rotulo = (v.location?.name ?? '').trim();
  const modelo = modeloDe(rotulo, descricao);
  // Não há campo de país: ele sai do texto do local, com `melhorLugar` decidindo qual dos lugares vale
  const pais = paisDoLocal(rotulo.split(';')[0] ?? '');
  const { local, lugar } = melhorLugar(locaisDe(v), { modelo, pais }, pref);
  const skills = extrairSkills(`${titulo}\n${descricao}`);
  // `company_name` vem pronto na vaga; o nome do board é a reserva (e alguns vêm com espaço sobrando)
  const empresa = (v.company_name ?? '').trim() || nomeDoBoard;

  const base = { titulo, empresa, modelo, local, pais, descricao, skills };
  const { score, motivo } = calcularScore(base, perfil, filtrosDaAutomacao(cfg, pref));
  const agora = new Date().toISOString();

  return {
    id: idDaVaga(board, v.id),
    plataforma: 'greenhouse',
    tenant: board,
    titulo,
    empresa,
    descricao,
    requisitos: requisitosDe(descricao) || skills.join(', '),
    // O Greenhouse não publica tipo de contrato em campo nenhum. Deduzir do texto seria adivinhar contrato, e
    // `regimePreferido` tira vaga da fila com base nisto: `indefinido` passa e deixa a pessoa ler o anúncio.
    regime: 'indefinido',
    senioridade: inferirSenioridade(titulo, descricao),
    modelo,
    local: local || rotulo || (modelo === 'remoto' ? 'Remoto' : pais),
    pais,
    url: v.absolute_url,
    skills,
    camposConhecidos: [],
    score,
    motivo: [motivo, lugar.compativel ? '' : lugar.motivo].filter(Boolean).join(' · '),
    status: score >= cfg.scoreMinimo && lugar.compativel ? 'encontrada' : 'ignorada',
    encontradaEm: agora,
    atualizadaEm: agora,
  };
}

let buscando = false;

export async function buscarNoGreenhouse(perfil: PerfilBusca, cfg: ConfigAutomacao, pref: PreferenciasLocalizacao, log: Log): Promise<Vaga[]> {
  if (buscando) return [];
  buscando = true;
  const novas: Vaga[] = [];
  let examinadas = 0;

  try {
    importarSeedGreenhouse(log);
    const lista = boardsGreenhouse.aVisitar(BOARDS_POR_VARREDURA);
    if (!lista.length) {
      log('alerta', 'Greenhouse: nenhuma empresa na lista. Adicione um board (job-boards.greenhouse.io/<empresa>) para começar.');
      return [];
    }
    log('info', `Greenhouse: lendo ${lista.length} empresa(s) de ${boardsGreenhouse.listar().length} cadastradas.`);

    for (const [i, b] of lista.entries()) {
      passo(`empresa ${b.nome}`, i + 1, lista.length);
      if (i > 0) await dormir(PAUSA_ENTRE_BOARDS_MS);
      if (novas.length >= MAX_VAGAS_POR_VARREDURA) {
        log('info', `Greenhouse: teto de ${MAX_VAGAS_POR_VARREDURA} vagas novas nesta rodada; o resto fica para a próxima.`);
        break;
      }

      let publicadas: VagaGreenhouse[] | null;
      try {
        publicadas = await vagasDoBoard(b.slug);
      } catch (e) {
        const falhas = b.falhas + 1;
        const desativar = falhas >= FALHAS_PARA_DESATIVAR;
        boardsGreenhouse.atualizar(b.slug, { falhas, ativo: !desativar, ultimaVerificacao: new Date().toISOString() });
        log(desativar ? 'alerta' : 'erro', `Greenhouse/${b.nome}: ${(e as Error).message}${desativar ? ` — desativada após ${FALHAS_PARA_DESATIVAR} falhas seguidas` : ''}.`);
        continue;
      }
      if (publicadas === null) {
        boardsGreenhouse.atualizar(b.slug, { ativo: false, ultimaVerificacao: new Date().toISOString() });
        log('alerta', `Greenhouse: job-boards.greenhouse.io/${b.slug} não existe mais; empresa desativada.`);
        continue;
      }

      examinadas += publicadas.length;

      // O que saiu do board é encerrado no banco, em vez de ficar na tela parecendo disponível
      let encerradas = 0;
      const noAr = new Set(publicadas.map(v => idDaVaga(b.slug, v.id)));
      for (const v of vagas.listar()) {
        if (v.plataforma === 'greenhouse' && v.tenant === b.slug && !noAr.has(v.id) && ['encontrada', 'ignorada', 'na_fila'].includes(v.status)) {
          vagas.atualizar(v.id, { status: 'encerrada', posicao: undefined });
          encerradas++;
        }
      }

      const ineditas = publicadas.filter(v => !vagas.get(idDaVaga(b.slug, v.id)));
      let novasAqui = 0;
      let paradasNoTeto = 0;
      for (const bruta of ineditas) {
        if (novas.length >= MAX_VAGAS_POR_VARREDURA || novasAqui >= MAX_VAGAS_POR_BOARD) {
          paradasNoTeto = ineditas.length - ineditas.indexOf(bruta);
          break;
        }
        const v = montarVaga(b.slug, b.nome, bruta, perfil, cfg, pref);
        if (!v) continue;
        vagas.salvar(v);
        novas.push(v);
        novasAqui++;
      }

      boardsGreenhouse.atualizar(b.slug, { totalVagas: publicadas.length, falhas: 0, ultimaVerificacao: new Date().toISOString() });
      const descartadas = ineditas.length - novasAqui - paradasNoTeto;
      if (novasAqui || encerradas)
        log(
          'info',
          `Greenhouse/${b.nome}: ${publicadas.length} publicada(s), ${novasAqui} nova(s)${encerradas ? `, ${encerradas} encerrada(s)` : ''}${paradasNoTeto > 0 ? `, ${paradasNoTeto} para a próxima rodada` : ''}${descartadas > 0 ? `, ${descartadas} descartada(s) por idade` : ''}.`,
        );
    }

    vistas(examinadas);
    kv.set('greenhouse:ultimaBusca', new Date().toISOString());
    log('info', `Greenhouse: ${novas.length} vaga(s) nova(s) em ${lista.length} empresa(s). O envio é pelo seu navegador — o formulário tem captcha.`);
    emitir({ tipo: 'estado' });
  } finally {
    buscando = false;
  }

  return novas;
}
