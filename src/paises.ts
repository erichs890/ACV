// Países para "vagas remotas em quais países" (Configurações › Meus Dados) e, quando existe, o domínio do Indeed
// daquele país. Compartilhado entre front (src/) e núcleo (core/).
//
// Domínios do Indeed: o Indeed mantém um índice de vagas por país, cada um no seu subdomínio. `br.indeed.com` foi
// confirmado ao vivo em 21/09/2026 (busca em Fortaleza respondeu 200 com 48 cards). Os demais seguem a convenção
// pública <iso>.indeed.com (EUA = www, Reino Unido = uk) e NÃO foram abertos por nós — o Indeed desafia navegadores
// automatizados depois de poucas cargas, e não vale gastar isso conferindo domínio. Se um deles estiver errado, a
// busca naquele país falha com erro claro no log e as outras seguem.

export interface Pais {
  nome: string; // como aparece na interface
  iso: string; // ISO 3166-1 alfa-2, como o InHire publica ("São Paulo, SP, BR")
  indeed?: string; // host do Indeed daquele país
  nomes?: string[]; // outras grafias que aparecem em vagas (sem acento, minúsculas)
}

export const PAISES: Pais[] = [
  { nome: 'Brasil', iso: 'BR', indeed: 'br.indeed.com', nomes: ['brazil', 'brasil'] },
  { nome: 'Portugal', iso: 'PT', indeed: 'pt.indeed.com', nomes: ['portugal'] },
  { nome: 'Estados Unidos', iso: 'US', indeed: 'www.indeed.com', nomes: ['estados unidos', 'eua', 'usa', 'united states', 'us'] },
  { nome: 'Canadá', iso: 'CA', indeed: 'ca.indeed.com', nomes: ['canada'] },
  { nome: 'Reino Unido', iso: 'GB', indeed: 'uk.indeed.com', nomes: ['reino unido', 'united kingdom', 'uk', 'inglaterra'] },
  { nome: 'Irlanda', iso: 'IE', indeed: 'ie.indeed.com', nomes: ['irlanda', 'ireland'] },
  { nome: 'Espanha', iso: 'ES', indeed: 'es.indeed.com', nomes: ['espanha', 'espana', 'spain'] },
  { nome: 'França', iso: 'FR', indeed: 'fr.indeed.com', nomes: ['franca', 'france'] },
  { nome: 'Alemanha', iso: 'DE', indeed: 'de.indeed.com', nomes: ['alemanha', 'germany', 'deutschland'] },
  { nome: 'Itália', iso: 'IT', indeed: 'it.indeed.com', nomes: ['italia', 'italy'] },
  { nome: 'Países Baixos', iso: 'NL', indeed: 'nl.indeed.com', nomes: ['paises baixos', 'holanda', 'netherlands'] },
  { nome: 'Suíça', iso: 'CH', indeed: 'ch.indeed.com', nomes: ['suica', 'switzerland'] },
  { nome: 'Austrália', iso: 'AU', indeed: 'au.indeed.com', nomes: ['australia'] },
  { nome: 'Argentina', iso: 'AR', indeed: 'ar.indeed.com', nomes: ['argentina'] },
  { nome: 'Chile', iso: 'CL', indeed: 'cl.indeed.com', nomes: ['chile'] },
  { nome: 'Colômbia', iso: 'CO', indeed: 'co.indeed.com', nomes: ['colombia'] },
  { nome: 'México', iso: 'MX', indeed: 'mx.indeed.com', nomes: ['mexico'] },
  { nome: 'Uruguai', iso: 'UY', indeed: 'uy.indeed.com', nomes: ['uruguai', 'uruguay'] },
  { nome: 'Paraguai', iso: 'PY', nomes: ['paraguai', 'paraguay'] },
  { nome: 'Peru', iso: 'PE', indeed: 'pe.indeed.com', nomes: ['peru'] },
  { nome: 'Angola', iso: 'AO', nomes: ['angola'] },
  { nome: 'Moçambique', iso: 'MZ', nomes: ['mocambique', 'mozambique'] },
  { nome: 'Emirados Árabes Unidos', iso: 'AE', indeed: 'ae.indeed.com', nomes: ['emirados arabes unidos', 'uae', 'dubai'] },
  { nome: 'Japão', iso: 'JP', indeed: 'jp.indeed.com', nomes: ['japao', 'japan'] },
];

export const paisPorNome = (nome: string) => PAISES.find(p => p.nome === nome);

/** Onde a pessoa aceita trabalhar. A cidade vale para presencial e híbrido; os países, só para 100% remoto. */
export interface PreferenciasLocalizacao {
  localizacaoPresencial: string; // uma cidade/região, ex.: "Fortaleza - CE" (é o mesmo campo que preenche "cidade" nos formulários)
  paisesRemoto: string[]; // nomes de PAISES, ex.: ["Brasil", "Portugal"]
  /**
   * Presencial/híbrida só na sua cidade (Automação). Ligado, vaga presencial em qualquer outra cidade é
   * incompatível — nem a de outra cidade do seu estado passa com desconto.
   */
  presencialSoNaMinhaCidade?: boolean;
}

export const PAISES_REMOTO_PADRAO = ['Brasil'];
