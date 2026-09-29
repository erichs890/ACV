import type { PerfilBusca, Vaga } from '../../src/types.ts';
import { SOFT, similaridade } from './texto.ts';
import { vagaCompativelComLocalizacao } from '../localizacao.ts';
import type { PreferenciasLocalizacao } from '../../src/paises.ts';
import { familiaDoCargo, familiasAfins, inferirArea, inferirSenioridade, NIVEIS, type Nivel } from './analyzer.ts';

import { termoExcluido } from '../../src/dados.ts';
import { grupoQueNaoEhSeu } from '../../src/sensiveis.ts';

// Reexportado porque o score é o dono conceitual do corte; a regra em si mora em src/ para a tela usar a mesma.
export { termoExcluido };

export interface FiltrosScore {
  area?: string; // área escolhida na Automação (sobrepõe a do currículo)
  cargo?: string; // cargo escolhido na Automação (entra junto com os do currículo)
  senioridade?: string; // senioridade escolhida na Automação (sobrepõe a do currículo)
  localizacao?: PreferenciasLocalizacao; // cidade (presencial/híbrida) e países (remota) que a pessoa aceita
  cargoRigido?: boolean; // true = vaga com cargo fora da sua função é cortada com força
  senioridadeRigida?: boolean; // true = vaga ACIMA do seu nível é cortada (sem nível declarado continua passando)
  autodeclaracoes?: Record<string, string>; // respostas de `sensiveis` — só para recusar vaga reservada a outro grupo
  excluir?: string[]; // nichos que a pessoa não quer, mesmo sendo da função dela (Configurações)
}

// Quantas competências técnicas suas uma vaga precisa citar para ser considerada do seu ramo
const NUCLEO_STACK = 6;

// Leitura de cidade/UF/país e a regra de compatibilidade moram em core/localizacao.ts (todas as plataformas usam)
export { lerLocal } from '../localizacao.ts';

/**
 * Compatibilidade léxica 0–100, só com o que existe de fato nos dois lados:
 *  - 60% competências: técnicas pesam 85%, comportamentais 15% (toda vaga pede "comunicação")
 *  - 40% cargo: similaridade entre o título da vaga e os cargos do currículo (ou o cargo configurado)
 *  - área diferente da do currículo corta o resultado pela metade; área igual dá um empurrão
 *  - vaga um nível acima da senioridade do candidato perde 30%; dois ou mais níveis acima, 65%
 *  - localização (core/localizacao.ts): presencial/híbrida em outra cidade do estado perde 40%, em outro estado/país zera;
 *    remota restrita a um país que a pessoa não escolheu zera
 * Com IA configurada, a busca substitui isto pela avaliação do modelo (core/ia.ts → avaliarVagas).
 */
export function calcularScore(
  vaga: Pick<Vaga, 'titulo' | 'skills' | 'descricao'> & Partial<Pick<Vaga, 'modelo' | 'local' | 'pais'>>,
  perfil: PerfilBusca,
  filtros: FiltrosScore = {},
): { score: number; motivo: string } {
  // Antes de qualquer conta: nicho que a pessoa recusou não é questão de nota, é de vontade dela.
  const excluido = termoExcluido(vaga.titulo, filtros.excluir);
  if (excluido) return { score: 0, motivo: `"${excluido}" está na sua lista de nichos a evitar (Configurações)` };

  // Vaga reservada a um grupo do qual você não declarou fazer parte: concorrer nela ocupa o lugar de quem ela
  // existe para alcançar. Sai da autodeclaração explícita, nunca de inferência (invariante 3).
  const reservada = grupoQueNaoEhSeu(vaga.titulo, filtros.autodeclaracoes ?? {});
  if (reservada) return { score: 0, motivo: reservada };

  const cv = new Set(perfil.skills);
  const tecnicas = vaga.skills.filter(s => !SOFT.has(s));
  const soft = vaga.skills.filter(s => SOFT.has(s));
  const temTec = tecnicas.filter(s => cv.has(s));
  const temSoft = soft.filter(s => cv.has(s));
  const pTec = tecnicas.length ? temTec.length / tecnicas.length : 0;
  const pSoft = soft.length ? temSoft.length / soft.length : 0;

  /**
   * Duas leituras da mesma interseção, porque `pTec` sozinho premia vaga vaga: uma vaga que só cita
   * "sql, rest, testes" dá 100% a qualquer pessoa de TI (caso real: "Analista de Processos" com 75%).
   * `pMinhas` olha do outro lado — quanto do SEU stack principal a vaga realmente pede. Uma vaga genérica
   * casa 3 competências periféricas e não chega perto do seu núcleo; uma vaga do seu ramo casa várias.
   */
  const meuTec = perfil.skills.filter(s => !SOFT.has(s));
  const pMinhas = Math.min(1, temTec.length / Math.max(1, Math.min(meuTec.length, NUCLEO_STACK)));
  const pTecCombinado = 0.6 * pTec + 0.4 * pMinhas;
  const parteSkills = tecnicas.length ? 0.85 * pTecCombinado + 0.15 * pSoft : 0.3 * pSoft;

  const cargos = [...perfil.cargos, filtros.cargo ?? ''].filter(c => c.trim());
  const parteTitulo = cargos.length ? Math.max(...cargos.map(c => similaridade(c, vaga.titulo))) : 0;

  /**
   * Cargo diferente do seu passa a pesar de verdade. Antes o título só disputava 40 dos 100 pontos, então uma
   * função completamente outra sobrevivia com os 60 pontos de competência ("Analista de Processos", 75%).
   * A decisão é pela FAMÍLIA de cargo (a profissão), que a similaridade de texto não consegue separar;
   * só quando nenhum dos lados tem família reconhecida é que vale a semelhança do texto.
   */
  const familiaVaga = familiaDoCargo(vaga.titulo);
  const familiaCv = [filtros.cargo ?? '', ...perfil.cargos].map(familiaDoCargo).find(f => f !== null) ?? null;
  const cargoParecido = familiaVaga && familiaCv ? familiasAfins(familiaVaga, familiaCv) : parteTitulo >= 0.5;
  const fatorCargo = cargoParecido || !cargos.length ? 1 : filtros.cargoRigido ? 0.35 : 0.6;

  /**
   * Os 40 pontos do título eram dados por semelhança de texto, o que punia cargo relevante de nome diferente:
   * "QA Automation Engineer" e "Engenheiro de IA" não se parecem com "Desenvolvedor Full Stack" e perdiam
   * quase tudo aí, mesmo sendo alvos legítimos. Reconhecida a função, o título ganha um piso.
   */
  const pisoTitulo = familiaVaga && familiaCv ? (familiaVaga === familiaCv ? 0.8 : cargoParecido ? 0.65 : 0) : 0;
  const parteTituloEfetiva = Math.max(parteTitulo, pisoTitulo);

  const areaVaga = inferirArea(vaga.skills, `${vaga.titulo}\n${vaga.descricao.slice(0, 800)}`);
  const areaCv = filtros.area?.trim() || perfil.area;
  const areaConhecida = areaVaga !== 'Não identificada' && areaCv !== 'Não identificada';
  const fatorArea = !areaConhecida ? 1 : areaVaga === areaCv ? 1.1 : 0.45;

  const nivelVaga = inferirSenioridade(vaga.titulo, vaga.descricao);
  const nivelCv = filtros.senioridade?.trim() || perfil.senioridade;
  const degraus = NIVEIS.indexOf(nivelVaga as Nivel) - NIVEIS.indexOf(nivelCv as Nivel);
  const senioridadeConhecida = nivelVaga !== 'Indefinida' && NIVEIS.includes(nivelCv as Nivel);
  // Um nível acima é ambição normal e a vaga costuma aceitar: quase não penaliza. Dois ou mais acima você
  // não alcança; dois abaixo é regressão de carreira (um Pleno não deveria disputar estágio).
  const fatorSenioridade = !senioridadeConhecida ? 1 : degraus >= 2 ? 0.35 : degraus === 1 ? 0.9 : degraus <= -2 ? 0.5 : 1;
  // Rigor de senioridade é corte, não desconto: quem pediu "só Pleno" não quer ver Sênior com nota menor,
  // quer não ver. Vaga que não declara o nível (`Indefinida`) escapa do corte de propósito.
  // Rigor de senioridade é corte, não desconto — e só para CIMA. "Sou Pleno, ainda não posso" é sobre a vaga
  // Sênior, não sobre a Júnior: cortar para baixo também tirava 843 vagas de uma vez, entre elas muita coisa
  // que o usuário já vinha se candidatando. Vaga que não declara o nível escapa: o anúncio não disse, o robô
  // não inventa.
  if (filtros.senioridadeRigida && senioridadeConhecida && degraus >= 1) {
    return { score: 0, motivo: `pede ${nivelVaga}, acima do seu nível (${nivelCv}) — você marcou o rigor de senioridade em Configurações` };
  }

  // Localização é regra compartilhada (core/localizacao.ts): fora do estado/país zera, outra cidade do estado
  // perde 40%, remota restrita a país não escolhido zera. Vale para InHire, Indeed e o que vier depois.
  const local = filtros.localizacao ? vagaCompativelComLocalizacao(vaga, filtros.localizacao) : { compativel: true, fator: 1, motivo: null };

  const score = Math.max(0, Math.min(100, Math.round((60 * parteSkills + 40 * parteTituloEfetiva) * fatorCargo * fatorArea * fatorSenioridade * local.fator)));
  const motivo = [
    tecnicas.length ? `${temTec.length}/${tecnicas.length} competências técnicas` : 'vaga sem competência técnica reconhecida',
    cargoParecido ? `cargo parecido${familiaVaga ? ` (${familiaVaga})` : ''}` : `outra função${familiaVaga ? `: ${familiaVaga}` : ''}${filtros.cargoRigido ? ', filtro rígido' : ''}`,
    areaConhecida ? (areaVaga === areaCv ? `mesma área (${areaVaga})` : `área diferente (${areaVaga})`) : null,
    senioridadeConhecida
      ? degraus > 0
        ? `pede ${nivelVaga}, acima do seu nível (${nivelCv})`
        : degraus <= -2
          ? `pede ${nivelVaga}, bem abaixo do seu nível (${nivelCv})`
          : `senioridade ok (${nivelVaga})`
      : null,
    local.motivo,
  ]
    .filter(Boolean)
    .join(' · ');
  return { score, motivo };
}
