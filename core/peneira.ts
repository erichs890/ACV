// A peneira que vem ANTES de qualquer download: o slug da vaga fala de alguma coisa que você faz?
//
// Existe porque alguns sites publicam dezenas de milhares de vagas das quais quase nenhuma é de tecnologia, e
// abrir cada página para descobrir isso é inviável — 41 mil páginas no Divulga Vagas, 1.259 no Vagas PJ. O
// slug da URL (`/vagas/empresa/123/desenvolvedor-back-end-nodejs`) já diz o suficiente para descartar 99% de
// graça, e é o que torna a varredura funda possível.
//
// É peneira GROSSEIRA de propósito: ela só precisa não jogar fora uma vaga boa. Quem decide de verdade é
// `calcularScore`, depois de ler a página inteira. Daí o teste de "alguma palavra do seu perfil aparece no
// slug", e não casamento de cargo.
//
// Morava em `core/platforms/divulgavagas/busca.ts`, e quando o Vagas PJ passou a usar sitemap (06/10/2026)
// um adapter estaria importando do outro — ou, pior, haveria duas cópias divergindo. Subiu para cá.
import type { PerfilBusca } from '../src/types.ts';
import { normalizar } from './resume/texto.ts';

/**
 * As palavras que descrevem o que a pessoa faz: cargo desejado + cargos do currículo + competências.
 *
 * Corte em 4 letras porque abaixo disso o termo casa com qualquer coisa ("dev" casaria com "desenvolvimento
 * de pessoas", "ux" com "auxiliar"). Perde "go" e "qa" — o preço de não trazer lixo.
 */
export function termosDoPerfil(perfil: PerfilBusca, cargoDesejado: string): string[] {
  const cru = [cargoDesejado, ...perfil.cargos, ...perfil.skills].join(' ');
  return [...new Set(normalizar(cru).split(/[^a-z0-9+#.]+/))].filter(t => t.length >= 4);
}

/** O slug da vaga fala de alguma coisa que a pessoa faz? (peneira grosseira; o score decide de verdade) */
export const slugInteressa = (slug: string, termos: string[]) => termos.some(t => slug.includes(t));
