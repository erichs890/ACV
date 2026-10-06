// Localização: leitura de "cidade / UF / país" e a regra central de compatibilidade entre uma vaga e as preferências
// da pessoa. Usada pelo score (todas as plataformas), pela busca do Indeed e pela fila — não duplique esta lógica.
//
// Regra (prompt "localização multi-país"):
//  - vaga PRESENCIAL ou HÍBRIDA → compara com a cidade da pessoa: mesma cidade = ok; outra cidade do mesmo estado =
//    compatível com desconto (dá para ir, mas não é o ideal); outro estado ou outro país = incompatível.
//  - vaga 100% REMOTA → compara o país da vaga com os países que a pessoa aceita; remota sem país declarado
//    ("de qualquer lugar") é compatível.
//  - modelo não informado ou dado que falta → compatível: na dúvida o robô mostra a vaga em vez de escondê-la.
import type { Vaga } from '../src/types.ts';
import { PAISES, type PreferenciasLocalizacao } from '../src/paises.ts';
import { normalizar } from './resume/texto.ts';

const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
const ESTADOS: Record<string, string> = {
  acre: 'AC',
  alagoas: 'AL',
  amapa: 'AP',
  amazonas: 'AM',
  bahia: 'BA',
  ceara: 'CE',
  'distrito federal': 'DF',
  'espirito santo': 'ES',
  goias: 'GO',
  maranhao: 'MA',
  'mato grosso': 'MT',
  'mato grosso do sul': 'MS',
  'minas gerais': 'MG',
  para: 'PA',
  paraiba: 'PB',
  parana: 'PR',
  pernambuco: 'PE',
  piaui: 'PI',
  'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN',
  'rio grande do sul': 'RS',
  rondonia: 'RO',
  roraima: 'RR',
  'santa catarina': 'SC',
  'sao paulo': 'SP',
  sergipe: 'SE',
  tocantins: 'TO',
};
const ISO = new Map(PAISES.map(p => [p.iso, p.nome]));
const NOME_DE_PAIS = new Map(PAISES.flatMap(p => [[normalizar(p.nome), p.nome] as const, ...(p.nomes ?? []).map(n => [n, p.nome] as const)]));

const partesDe = (texto: string) =>
  texto
    .split(/\s*[-,/|]\s*/)
    .map(p => p.trim())
    .filter(Boolean);

/** "Campinas - SP", "São Paulo/SP", "Belo Horizonte, Minas Gerais", "São Paulo, SP, BR" → { cidade, uf }. */
export function lerLocal(texto: string): { cidade: string; uf: string } {
  const partes = partesDe(texto);
  const ufExplicita = partes.map(p => p.toUpperCase()).find(p => UFS.has(p)) ?? '';
  // fora UF e país ("BR", "Brasil"): o InHire manda "Cidade, UF, BR"
  const candidatos = partes
    .filter(p => !UFS.has(p.toUpperCase()) && !(p.length === 2 && ISO.has(p.toUpperCase())))
    .map(normalizar)
    .filter(p => !NOME_DE_PAIS.has(p));
  // Com UF explícita, a primeira parte é a cidade mesmo que tenha nome de estado ("São Paulo, SP");
  // sem UF, "Minas Gerais" sozinho é estado e "São Paulo" sozinho é a cidade (que também resolve o estado)
  const ambigua = candidatos.length === 1 && (candidatos[0] === 'sao paulo' || candidatos[0] === 'rio de janeiro');
  const cidade = ufExplicita || ambigua ? (candidatos[0] ?? '') : (candidatos.find(p => !ESTADOS[p]) ?? '');
  const uf = ufExplicita || ESTADOS[candidatos.find(p => ESTADOS[p]) ?? ''] || '';
  return { cidade, uf };
}

/**
 * País declarado num texto de localização (nome de PAISES) ou '' se não der para saber.
 * "Lisboa, PT" → Portugal · "São Paulo, SP, BR" → Brasil · "Campinas - SP" → Brasil (UF brasileira) · "Remoto" → ''.
 * Sigla de duas letras que também é UF ("PA", "SC"...) vale como UF: este app é para quem mora no Brasil.
 */
export function paisDoLocal(texto: string): string {
  const partes = partesDe(texto);
  for (const p of partes) {
    const porNome = NOME_DE_PAIS.get(normalizar(p));
    if (porNome && (p.length > 2 || !UFS.has(p.toUpperCase()))) return porNome;
  }
  const ultima = partes.at(-1)?.toUpperCase() ?? '';
  if (ultima.length === 2 && ISO.has(ultima) && (!UFS.has(ultima) || partes.length >= 3)) return ISO.get(ultima)!;
  for (const p of partes) {
    const outro = OUTROS_PAISES.get(normalizar(p));
    if (outro) return outro;
  }
  const l = lerLocal(texto);
  return l.uf ? 'Brasil' : '';
}

/**
 * Os outros 260 países do mundo, reconhecidos pelo nome — os que NÃO estão em `src/paises.ts`.
 *
 * `PAISES` é a lista de países que a pessoa pode ESCOLHER para trabalho remoto: ela é curta de propósito,
 * porque é um seletor na tela. Mas usá-la também para responder "que país é este lugar?" criava um buraco
 * grande: "Vilnius, Lithuania" não casava com nada, `paisDoLocal` devolvia vazio, e vazio quer dizer "a vaga
 * não diz onde é" — que é tratado como COMPATÍVEL em todos os ramos da regra ("remota, sem restrição de
 * país"). Resultado medido na primeira varredura do Greenhouse (06/10/2026), o primeiro quadro global aqui:
 * vagas em Vilnius e Sofia entraram na lista dele a 78%, e as de Berlim não — só porque a Alemanha por acaso
 * está em `PAISES` e a Lituânia não.
 *
 * Duas listas com papéis diferentes, então, e não duas cópias da mesma coisa: uma diz onde você aceita
 * trabalhar, a outra diz o que é nome de país. A segunda vem do ICU do próprio Node (`Intl.DisplayNames`),
 * em português e em inglês, sem lista escrita à mão para alguém manter.
 */
const OUTROS_PAISES: Map<string, string> = (() => {
  const mapa = new Map<string, string>();
  try {
    const emPt = new Intl.DisplayNames(['pt-BR'], { type: 'region' });
    const emEn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const iso = String.fromCharCode(a, b);
        if (ISO.has(iso)) continue; // país suportado: quem responde é `PAISES`, com o nome que a tela usa
        const pt = emPt.of(iso);
        const en = emEn.of(iso);
        if (!pt || pt === iso) continue;
        for (const nome of [pt, en]) {
          const chave = normalizar(nome ?? '');
          // Nome de uma letra ou que colida com algo já conhecido não entra: o risco é virar falso positivo
          if (chave.length > 3 && !NOME_DE_PAIS.has(chave) && !mapa.has(chave)) mapa.set(chave, pt);
        }
      }
    }
  } catch {
    /* ambiente sem ICU completo: fica só com `PAISES`, que é o comportamento antigo */
  }
  return mapa;
})();

/**
 * O nome do país a partir da sigla ISO, quando a plataforma informa a sigla em campo próprio ("BR", "PT").
 *
 * Existe porque `paisDoLocal` é heurística sobre texto livre e tem um viés deliberado: sigla de duas letras que
 * também é UF brasileira vale como UF, porque este app é para quem mora no Brasil. Isso está certo para
 * "Belém, PA" e errado para o Lever, que manda `country: "PA"` querendo dizer Panamá. Campo declarado não se
 * adivinha — e a tabela de siglas mora aqui, não numa segunda cópia dentro de cada adapter.
 */
export const paisDoIso = (iso: string): string => ISO.get(iso.trim().toUpperCase()) ?? '';

/**
 * **A vaga pode ser em mais de um lugar** — qual deles vale, e ela serve?
 *
 * Mora aqui, e não dentro de um adapter, porque dois já precisam dela e pela mesma razão: o Lever manda
 * `categories.allLocations` (`["Brazil", "Campinas, SP", "São Paulo, SP"]`) e o Greenhouse manda tudo numa
 * string separada por `;` (`"Brasil; São Paulo, São Paulo, Brazil"`). Duas cópias desta regra divergiriam, e
 * é regra de localização — a família de bug que neste projeto já mandou sete currículos para presenciais em
 * outro estado (28/09/2026).
 *
 * Cada lugar passa por `vagaCompativelComLocalizacao`, a regra única, e **vence o melhor**: se existe UM
 * lugar onde dá para trabalhar, a vaga vale, e é esse lugar que fica gravado — para a tela mostrar o motivo
 * certo. Vaga aberta em Campinas e em Fortaleza não é descartada por causa de Campinas.
 *
 * E **lugar vago não compete com lugar específico.** "Brazil" vem na mesma lista que "Campinas, SP" e não tem
 * cidade nem UF: a regra não acha o que reprovar e devolve compatível sem desconto, que é a nota máxima. O
 * rótulo largo venceria as cidades verdadeiras e o conserto não consertaria nada — foi o que o teste pegou na
 * primeira versão disto. Havendo alguma entrada com cidade ou estado, só essas valem; a larga é o país
 * repetido. Sem nenhuma específica, a larga é tudo o que existe e aí ela decide.
 */
export function melhorLugar(locais: string[], vaga: { modelo: Vaga['modelo']; pais: string }, pref: PreferenciasLocalizacao): { local: string; lugar: Compatibilidade } {
  const todos = [...new Set(locais.map(l => l.trim()).filter(Boolean))];
  const especificos = todos.filter(l => {
    const { cidade, uf } = lerLocal(l);
    return !!(cidade || uf);
  });
  const candidatos = especificos.length ? especificos : todos;
  if (!candidatos.length) return { local: '', lugar: vagaCompativelComLocalizacao({ ...vaga, local: '' }, pref) };

  let melhor = { local: candidatos[0], lugar: vagaCompativelComLocalizacao({ ...vaga, local: candidatos[0] }, pref) };
  for (const local of candidatos.slice(1)) {
    if (melhor.lugar.fator >= 1) break; // não há melhor que "sem desconto"
    const lugar = vagaCompativelComLocalizacao({ ...vaga, local }, pref);
    if (lugar.fator > melhor.lugar.fator) melhor = { local, lugar };
  }
  return melhor;
}

export interface Compatibilidade {
  compativel: boolean;
  fator: number; // multiplicador do score: 1 = sem efeito, 0 = incompatível
  motivo: string | null;
}

const OK: Compatibilidade = { compativel: true, fator: 1, motivo: null };

/** A regra central. `vaga.pais` (quando a plataforma informa) vale mais do que o que se lê de `vaga.local`. */
export function vagaCompativelComLocalizacao(vaga: Partial<Pick<Vaga, 'modelo' | 'local' | 'pais'>>, pref: PreferenciasLocalizacao): Compatibilidade {
  const local = vaga.local ?? '';
  const pais = vaga.pais || paisDoLocal(local);

  if (vaga.modelo === 'remoto') {
    if (!pais) return { ...OK, motivo: 'remota, sem restrição de país' };
    if (!pref.paisesRemoto.length) return OK;
    return pref.paisesRemoto.includes(pais) ? { ...OK, motivo: `remota (${pais})` } : { compativel: false, fator: 0, motivo: `remota restrita a ${pais}, fora dos países que você escolheu` };
  }

  if (vaga.modelo === 'presencial' || vaga.modelo === 'hibrido') {
    const tipo = vaga.modelo === 'presencial' ? 'presencial' : 'híbrida';
    const v = lerLocal(local);
    if (!v.cidade && !v.uf && !pais) return OK; // a vaga não diz onde é
    if (!pref.localizacaoPresencial.trim()) return { ...OK, motivo: `${tipo}; preencha sua cidade em Configurações` };
    const m = lerLocal(pref.localizacaoPresencial);
    const meuPais = paisDoLocal(pref.localizacaoPresencial) || 'Brasil';
    if (pais && pais !== meuPais) return { compativel: false, fator: 0, motivo: `${tipo} em ${local || pais}, em outro país` };
    if (v.cidade && v.cidade === m.cidade && (!v.uf || !m.uf || v.uf === m.uf)) return { ...OK, motivo: `${tipo} na sua cidade` };
    if (v.uf && m.uf && v.uf !== m.uf) return { compativel: false, fator: 0, motivo: `${tipo} em ${local}, fora do seu estado` };
    // "Só na minha cidade" (Automação): outra cidade é outra cidade, mesmo no seu estado. O campo existia na
    // tela e ninguém no núcleo o lia — a tela dizia "fora de Fortaleza, só remotas" enquanto o robô mandava
    // currículo para presencial em São Paulo (28/09/2026).
    if (pref.presencialSoNaMinhaCidade && (v.cidade || v.uf)) return { compativel: false, fator: 0, motivo: `${tipo} em ${local}, e você só aceita presencial em ${pref.localizacaoPresencial}` };
    if (v.uf && v.uf === m.uf) return v.cidade && m.cidade ? { compativel: true, fator: 0.6, motivo: `${tipo} em ${local}, outra cidade do seu estado` } : { ...OK, motivo: `${tipo} no seu estado` };
    /**
     * A vaga diz o estado dela e a sua cidade não diz o seu: não dá para afirmar que é o mesmo estado.
     *
     * Antes isto caía no desconto de 40% logo abaixo ("outra cidade") e a vaga seguia viva. Com a cidade
     * gravada como "Fortaleza" (sem o "CE"), foi assim que sete presenciais/híbridas fora do Ceará — São
     * Paulo, Porto Alegre, Blumenau, Manaus, Recife — receberam currículo. Presencial em outra cidade é
     * mudança de vida: na dúvida, não manda, e diz o que falta preencher.
     */
    if (v.uf && !m.uf) return { compativel: false, fator: 0, motivo: `${tipo} em ${local}; informe o estado na sua cidade (ex.: "${m.cidade || 'Fortaleza'} - CE") para o robô saber se é perto` };
    if (v.cidade && m.cidade && v.cidade !== m.cidade) return { compativel: true, fator: 0.6, motivo: `${tipo} em ${local}, outra cidade` };
    return OK;
  }

  /**
   * Modelo não informado: compatível **porque na dúvida se mostra a vaga** — mas só quando há dúvida de verdade.
   *
   * Achado no Greenhouse (06/10/2026), que é o primeiro quadro global aqui: vagas em Vilnius, Sofia e Berlim
   * entravam na lista a 78% porque o Greenhouse não publica modelo de trabalho em campo nenhum, e `indefinido`
   * caía direto neste `OK`. O país, porém, não estava em dúvida: estava escrito.
   *
   * E quando o país é conhecido e estrangeiro, **os dois caminhos possíveis recusam**: se a vaga for remota,
   * ela é remota restrita a um país que você não escolheu; se for presencial ou híbrida, é em outro país.
   * Não há leitura em que ela sirva, então "na dúvida mostra" não se aplica — não sobrou dúvida sobre o que
   * importa. A recusa é escrita assim de propósito: só quando AMBOS os ramos recusariam. Vaga em Portugal com
   * modelo indefinido continua passando (remota serviria, presencial não), que é dúvida legítima.
   */
  const paisEstrangeiro = pais && pais !== (paisDoLocal(pref.localizacaoPresencial) || 'Brasil');
  const foraDoRemoto = pref.paisesRemoto.length > 0 && !pref.paisesRemoto.includes(pais);
  if (paisEstrangeiro && foraDoRemoto) return { compativel: false, fator: 0, motivo: `em ${local || pais}: não dá nem como presencial (outro país) nem como remota (país fora da sua lista)` };
  return OK;
}
