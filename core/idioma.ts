// Em que idioma a vaga está escrita — regra ÚNICA, no molde de `core/localizacao.ts`.
//
// Para que serve: mandar currículo em português para uma vaga escrita em inglês é desperdiçar a candidatura.
// Até 06/10/2026 o ACV não tinha noção de idioma: `executarCandidatura` sempre pegava o PDF principal, e o
// PDF traduzido (que já existia, `Arquivo.inglesPdf`) só servia para download manual. Medido no banco real
// naquele dia: 35 de 4.784 vagas estão em inglês — e 4 delas estavam NA FILA, três com pagamento em dólar.
//
// Por que contagem de palavras funcionais, e não um detector de idioma de verdade: porque o texto é misturado
// de propósito. "Software Development Coordinator - INGLÊS FLUENTE" é uma vaga em português com título em
// inglês; "Python AI Engineer (USD-based pay)" é uma vaga em inglês com nome de tecnologia que é igual nos
// dois idiomas. O que separa um do outro são as palavras de ligação — artigo, preposição, pronome —, que são
// as que ninguém escreve no idioma errado. Nome de tecnologia fica de fora da conta por isso.
//
// Erra para o lado do PORTUGUÊS de propósito: exige folga (mais palavras inglesas E pelo menos 50% a mais
// que as portuguesas) para declarar inglês. Dizer "inglês" numa vaga em português manda o currículo errado
// para um recrutador brasileiro; dizer "português" numa vaga em inglês é o comportamento que já existia.
// Na dúvida, fica com o que já funcionava.

export type IdiomaDaVaga = 'pt' | 'en';

/** Palavras de ligação do inglês: as que não aparecem em texto português por acidente. */
const FUNCIONAIS_EN =
  /\b(the|and|with|you|your|will|our|we|are|is|of|for|to|in|on|as|be|have|has|from|about|their|this|that|who|what|should|would|can|must|requirements|responsibilities|experience|benefits|apply|role|team|work|skills|knowledge|years|strong|ability|including|preferred|plus)\b/gi;

/** As equivalentes em português. Sem acento também, porque anúncio mal digitado é regra, não exceção. */
const FUNCIONAIS_PT =
  /\b(e|de|do|da|dos|das|para|com|em|no|na|nos|nas|por|que|se|um|uma|os|as|ao|à|você|voce|nossa|nosso|será|sera|são|sao|requisitos|atividades|responsabilidades|benefícios|beneficios|experiência|experiencia|conhecimento|conhecimentos|desejável|desejavel|vaga|empresa|área|area|equipe|trabalho|anos|salário|salario)\b/gi;

/**
 * O idioma em que a vaga está escrita.
 *
 * Lê título + o começo da descrição: o fim costuma ter rodapé institucional, aviso de LGPD e texto colado de
 * outra vaga, que sujam a conta sem dizer nada sobre o idioma do anúncio.
 */
export function idiomaDaVaga(vaga: { titulo?: string; descricao?: string; requisitos?: string }): IdiomaDaVaga {
  const texto = `${vaga.titulo ?? ''}\n${(vaga.descricao ?? '').slice(0, 1500)}\n${(vaga.requisitos ?? '').slice(0, 300)}`;
  const en = (texto.match(FUNCIONAIS_EN) ?? []).length;
  const pt = (texto.match(FUNCIONAIS_PT) ?? []).length;
  // O piso de 5 evita que um título de três palavras em inglês decida por uma descrição inteira em português
  return en >= 5 && en > pt * 1.5 ? 'en' : 'pt';
}

/** O rótulo que vai para o log e para a tela. */
export const nomeDoIdioma = (i: IdiomaDaVaga) => (i === 'en' ? 'inglês' : 'português');
