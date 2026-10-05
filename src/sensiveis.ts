// Perguntas de autodeclaração / dados pessoais sensíveis (LGPD): identidade de gênero, orientação sexual, raça/cor,
// deficiência, religião, saúde... Categoria à parte no motor de formulário: NUNCA respondida por similaridade de
// texto, só por escolha explícita do usuário para a pergunta literal ou pela política definida em Configurações.
// Nada aqui infere resposta a partir de nome, foto, currículo ou qualquer outro dado — por decisão de projeto.
// Lista versionada: acrescente termos conforme aparecerem em novas vagas. Compartilhado entre front (src/) e núcleo (core/).

export interface CategoriaSensivel {
  id: string;
  rotulo: string;
  exemplo: string; // como a pergunta costuma aparecer
  termos: string[]; // sem acento, minúsculas; casados por palavra inteira
  /**
   * Respostas como as vagas realmente escrevem (levantadas nos formulários do InHire em 20/09/2026).
   * Existem para você escolher numa lista em vez de adivinhar o texto exato: o casamento com a opção da
   * vaga é por similaridade, então "Mulher Cisgênero" acha "Mulher cisgênero" e "Mulher cis".
   */
  opcoesComuns: string[];
}

export const PREFIRO_NAO_RESPONDER = 'Prefiro não responder';

export const CATEGORIAS_SENSIVEIS: CategoriaSensivel[] = [
  {
    id: 'genero',
    rotulo: 'Identidade de gênero',
    exemplo: 'Qual é a sua identidade de gênero?',
    termos: ['identidade de genero', 'genero', 'transgenero', 'cisgenero'],
    opcoesComuns: ['Mulher Cisgênero', 'Homem Cisgênero', 'Mulher Transgênero', 'Homem Transgênero', 'Não-binário', 'Agênero', 'Outro', PREFIRO_NAO_RESPONDER],
  },
  {
    id: 'orientacao',
    rotulo: 'Orientação sexual',
    exemplo: 'Qual é a sua orientação sexual?',
    termos: ['orientacao sexual', 'sexualidade'],
    opcoesComuns: ['Heterossexual', 'Homossexual', 'Bissexual', 'Pansexual', 'Assexual', 'Outra', PREFIRO_NAO_RESPONDER],
  },
  {
    id: 'raca',
    rotulo: 'Cor, raça ou etnia',
    exemplo: 'Qual é a sua cor ou raça?',
    termos: ['cor ou raca', 'raca', 'etnia', 'etnico', 'racial', 'sua cor', 'cor/raca', 'pessoa preta', 'pessoa parda', 'indigena'],
    opcoesComuns: ['Branca', 'Preta', 'Parda', 'Amarela', 'Indígena', PREFIRO_NAO_RESPONDER],
  },
  {
    id: 'pcd',
    rotulo: 'Pessoa com deficiência (PcD)',
    exemplo: 'Deseja se candidatar como pessoa com deficiência?',
    termos: ['pessoa com deficiencia', 'pessoas com deficiencia', 'pcd', 'deficiencia', 'laudo medico', 'cid'],
    opcoesComuns: ['Não', 'Sim', PREFIRO_NAO_RESPONDER],
  },
  {
    id: 'religiao',
    rotulo: 'Religião ou crença',
    exemplo: 'Qual é a sua religião?',
    termos: ['religiao', 'religiosa', 'religioso', 'crenca'],
    opcoesComuns: ['Católica', 'Evangélica', 'Espírita', 'Umbanda ou Candomblé', 'Judaica', 'Islâmica', 'Sem religião', 'Outra', PREFIRO_NAO_RESPONDER],
  },
  {
    id: 'saude',
    rotulo: 'Saúde, gestação e vida familiar',
    exemplo: 'Possui alguma condição de saúde?',
    termos: ['condicao de saude', 'doenca', 'gestante', 'gravida', 'gravidez', 'estado civil', 'possui filhos', 'tem filhos'],
    opcoesComuns: ['Não', 'Sim', PREFIRO_NAO_RESPONDER],
  },
  {
    id: 'grupos',
    rotulo: 'Grupos de diversidade',
    exemplo: 'Você pertence a um dos grupos abaixo?',
    termos: ['grupos abaixo', 'grupo de diversidade', 'grupos de diversidade', 'grupos minorizados', 'grupo minorizado', 'diversidade', 'lgbt', 'lgbtqia'],
    opcoesComuns: ['Nenhuma das opções', 'Mulher', 'Pessoa preta', 'Pessoa parda', 'Indígena', 'LGBTQIA+', 'Pessoa com deficiência', '50+', PREFIRO_NAO_RESPONDER],
  },
];

export const normalizarSensivel = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Categoria sensível da pergunta, por palavra-chave (não por similaridade); null se for uma pergunta comum. */
export function categoriaSensivel(rotulo: string): CategoriaSensivel | null {
  const n = ` ${normalizarSensivel(rotulo)} `;
  for (const cat of CATEGORIAS_SENSIVEIS) for (const termo of cat.termos) if (n.includes(` ${termo} `) || n.includes(` ${termo}/`) || n.includes(`/${termo} `)) return cat;
  return null;
}

/**
 * Dado da vida da pessoa que a IA não tem como saber e não pode chutar: documento, endereço, contato,
 * dinheiro, data. Diferente de `categoriaSensivel` (autodeclaração, que é escolha do usuário por lei):
 * aqui o problema é factual — errar o CPF ou inventar um bairro vai num formulário real de uma empresa real.
 * A maioria destes campos o motor de formulário já preenche sozinho pelo perfil; esta regra pega os que
 * aparecem como pergunta em texto livre.
 */
export const DADO_PESSOAL =
  /\bcpf\b|\brg\b|\bpis\b|\bctps\b|carteira de trabalho|t[íi]tulo de eleitor|passaporte|\bcnh\b|habilita[çc][ãa]o|\bcnpj\b|endere[çc]o|\bbairro\b|\brua\b|\bcep\b|complemento|n[úu]mero da casa|data de nascimento|nascimento|\bidade\b|estado civil|nome (da m[ãa]e|do pai|completo da m[ãa]e)|pretens[ãa]o|sal[áa]rio|remunera[çc][ãa]o|quanto (voc[êe] )?(ganha|recebe)|banco|ag[êe]ncia|conta corrente|\bchave pix\b|telefone|celular|whatsapp|e-?mail/i;

/** Opção "prefiro não responder", nas variações que os formulários usam. */
export const PREFIRO_NAO = /prefiro n[ãa]o (responder|informar|declarar|dizer|opinar)|n[ãa]o (desejo|quero) (declarar|informar|responder)|prefiro n[ãa]o\b|n[ãa]o informar/i;

export type ModoSensivel = 'perguntar' | 'prefiro_nao' | 'padrao';
export interface ConfigSensiveis {
  modo: ModoSensivel; // perguntar: sempre pausa · prefiro_nao: marca "prefiro não responder" quando opcional · padrao: usa as respostas abaixo
  padroes: Record<string, string>; // categoria.id → resposta exata (texto da opção) definida pelo usuário
}
export const SENSIVEIS_PADRAO: ConfigSensiveis = { modo: 'perguntar', padroes: {} };

/**
 * Decisão para uma pergunta sensível (função pura, testada no self-check). Ordem:
 *  1. resposta que o usuário já deu para esta pergunta LITERAL (igualdade, não similaridade);
 *  2. resposta padrão da categoria definida em Configurações (modo "padrao"), se bater com uma opção;
 *  3. modo "prefiro_nao" + pergunta opcional + opção "prefiro não responder" disponível;
 *  4. Sem Piedade (`aceitarPreferirNao`): a opção "prefiro não declarar", quando a vaga oferece — inclusive
 *     em pergunta OBRIGATÓRIA;
 *  5. null → pausar e perguntar ao usuário, sinalizando que é autodeclaração.
 * `casar` aproxima a resposta às opções da vaga (ou devolve o texto quando a pergunta é livre).
 *
 * Sobre a regra 4, que é a delicada: **não é a IA respondendo autodeclaração**, e não fere a invariante 3.
 * Escolher "prefiro não declarar" é a única resposta que não afirma nada sobre a pessoa — é a recusa a
 * declarar, e ela é verdadeira para qualquer um. Quem escolheu foi o usuário, um nível acima, ao marcar Sem
 * Piedade ("responda tudo e não me pare"). A regra 3 continua existindo porque o modo `prefiro_nao` de
 * Configurações vale para TODOS os modos de pergunta e só em campo opcional: o dono de `sensiveis.modo`
 * segue sendo Configurações › Autodeclaração, e isto aqui é um segundo LEITOR, com a condição escrita no
 * nome do parâmetro.
 *
 * E a regra 4 exige `opcoes`: em pergunta sensível de TEXTO LIVRE ela não vale. Escrever "prefiro não
 * declarar" num campo aberto seria o robô redigindo uma frase em nome da pessoa num campo de autodeclaração,
 * que é coisa diferente de marcar uma opção que o próprio formulário oferece.
 */
export function decidirSensivel(
  pergunta: { rotulo: string; opcoes?: string[]; obrigatoria?: boolean },
  salvas: { pergunta: string; resposta: string }[],
  cfg: ConfigSensiveis,
  casar: (resposta: string) => string | null,
  opcoes: { aceitarPreferirNao?: boolean } = {},
): string | null {
  const cat = categoriaSensivel(pergunta.rotulo);
  if (!cat) return null;
  const alvo = normalizarSensivel(pergunta.rotulo);
  const literal = salvas.find(s => s.resposta.trim() && normalizarSensivel(s.pergunta) === alvo);
  if (literal) return casar(literal.resposta.trim());
  const padrao = cfg.modo === 'padrao' ? cfg.padroes[cat.id]?.trim() : '';
  if (padrao) {
    const r = casar(padrao);
    if (r) return r;
  }
  const recusa = (pergunta.opcoes ?? []).find(o => PREFIRO_NAO.test(o));
  if (cfg.modo === 'prefiro_nao' && pergunta.obrigatoria === false && recusa) return recusa;
  // Sem Piedade: a obrigatoriedade deixa de importar, porque marcar a recusa SATISFAZ o formulário sem
  // declarar nada falso. O que continua importando é a opção existir — sem ela não há resposta segura.
  if (opcoes.aceitarPreferirNao && recusa) return recusa;
  return null;
}

/**
 * Vaga reservada a um grupo específico (afirmativa/exclusiva) e a regra para saber se ela é sua.
 *
 * Caso real (28/09/2026): saíram candidaturas para "Vaga Afirmativa para PCD | Analista de Desenvolvimento
 * Full Stack" e para "Software Engineer (afirmativa para mulheres)" — o usuário declarou PcD "Não" e
 * "Homem Cisgênero". Concorrer numa vaga reservada a um grupo do qual você não faz parte não é agressivo só
 * com a empresa: ocupa o lugar de quem a vaga existe para alcançar, e o processo cai na primeira triagem.
 *
 * A decisão sai SÓ da autodeclaração explícita (invariante 3): nada de inferir de nome, currículo ou IA.
 * Sem resposta declarada para a categoria, a vaga passa — o robô não adivinha o que você não disse.
 *
 * `soTambem` é o detalhe que muda tudo: "vaga afirmativa TAMBÉM para pessoas com deficiência" é aberta a
 * todo mundo, e reprovar essas cortaria vaga boa por engano.
 */
interface GrupoReservado {
  id: string; // categoria de CATEGORIAS_SENSIVEIS
  rotulo: string;
  /** No título: exclusividade declarada para o grupo. */
  marca: RegExp;
  /** Faz parte do grupo? Recebe a resposta declarada (já em minúsculas, sem acento). */
  pertence: (resposta: string) => boolean;
}

/**
 * Marca de exclusividade no título. Regex literal de propósito: montar isto com `new RegExp` e template
 * literal já custou caro — `\b` dentro de uma template string é um backspace, não uma borda de palavra, e a
 * regra passou a não casar com nada em silêncio.
 */
const RESERVA = /afirmativ[ao]s?|exclusiv[ao]s?|inclusiv[ao]s?|reservad[ao]s?|destinad[ao]s?/;
const TAMBEM = /\btambem\b/; // "afirmativa TAMBÉM para..." é aberta a todos

const GRUPOS_RESERVADOS: GrupoReservado[] = [
  {
    id: 'pcd',
    rotulo: 'pessoas com deficiência',
    marca: /\b(pcds?|deficiencia|deficientes?)\b/,
    pertence: r => r.startsWith('sim'),
  },
  {
    id: 'genero',
    rotulo: 'mulheres',
    marca: /\b(mulher|mulheres|femini[nc][oa]s?)\b/,
    pertence: r => r.includes('mulher'),
  },
  {
    id: 'genero',
    rotulo: 'pessoas trans',
    marca: /\b(trans|transgener[oa]s?|travestis?)\b/,
    pertence: r => r.includes('trans') || r.includes('travesti') || r.includes('nao binari'),
  },
  {
    id: 'raca',
    rotulo: 'pessoas negras',
    marca: /\b(negr[ao]s?|pret[ao]s?|pard[ao]s?|racial)\b/,
    pertence: r => r.startsWith('pret') || r.startsWith('pard') || r.startsWith('negr'),
  },
  {
    id: 'raca',
    rotulo: 'pessoas indígenas',
    marca: /\bindigenas?\b/,
    pertence: r => r.startsWith('indigena'),
  },
  {
    id: 'orientacao',
    rotulo: 'pessoas LGBTQIA+',
    marca: /\blgbt\w*\b/,
    pertence: r => !!r && !r.startsWith('hetero') && !PREFIRO_NAO.test(r),
  },
];

/**
 * A vaga é reservada a um grupo do qual você NÃO declarou fazer parte? Devolve o motivo, ou '' se pode ir.
 * Só o título, como os nichos a evitar: o corpo do anúncio fala de diversidade em toda vaga.
 */
export function grupoQueNaoEhSeu(titulo: string, padroes: Record<string, string>): string {
  const t = normalizarSensivel(titulo);
  if (!RESERVA.test(t)) return '';
  for (const g of GRUPOS_RESERVADOS) {
    if (!g.marca.test(t)) continue;
    if (TAMBEM.test(t)) continue; // "afirmativa TAMBÉM para..." é aberta a todos
    const declarado = normalizarSensivel(padroes[g.id] ?? '');
    if (!declarado || PREFIRO_NAO.test(declarado)) continue; // você não disse: o robô não adivinha
    if (!g.pertence(declarado)) return `vaga reservada a ${g.rotulo}, e você declarou "${padroes[g.id]}" em Configurações`;
  }
  return '';
}
