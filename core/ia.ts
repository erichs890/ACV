import Anthropic from '@anthropic-ai/sdk';
import type { ConfigIA, ProvedorIA } from '../src/types.ts';
import { MODELOS_IA, modeloPadrao } from '../src/dados.ts';
import { kv } from './storage/db.ts';
import { similaridade } from './resume/texto.ts';

// Provedor de IA para a adaptação de currículo. A chave fica só no SQLite local (%LOCALAPPDATA%\ACV)
// e nunca é devolvida ao front — o front só vê se existe e os 4 últimos caracteres.

// As opções válidas e o padrão saem de `src/dados.ts` — uma lista só, com id, preço e nota juntos.
// Duas listas em arquivos diferentes já divergiram antes: a do front oferecia modelo que o núcleo recusava.
export const MODELOS: Record<Exclude<ProvedorIA, 'nenhum'>, { padrao: string; opcoes: string[] }> = {
  gemini: { padrao: modeloPadrao('gemini'), opcoes: MODELOS_IA.gemini.map(m => m.id) },
  anthropic: { padrao: modeloPadrao('anthropic'), opcoes: MODELOS_IA.anthropic.map(m => m.id) },
};

interface IAArmazenada {
  provedor: ProvedorIA;
  modelo: string;
  chave: string;
}

export const lerIA = (): IAArmazenada => kv.get<IAArmazenada>('ia', { provedor: 'nenhum', modelo: '', chave: '' });

export function salvarIA(parcial: { provedor?: ProvedorIA; modelo?: string; chave?: string }) {
  const atual = lerIA();
  const provedor = parcial.provedor ?? atual.provedor;
  const modelo = (parcial.modelo?.trim() || (provedor !== atual.provedor ? '' : atual.modelo) || (provedor === 'nenhum' ? '' : MODELOS[provedor].padrao)).trim();
  const chave = parcial.chave?.trim() ? parcial.chave.trim() : atual.chave; // chave vazia = manter a atual
  kv.set('ia', { provedor, modelo, chave });
}

/**
 * Modelo salvo que o provedor não oferece mais (o gemini-2.0-flash foi desligado pelo Google) vira o padrão atual.
 * Sem isto, a adaptação por IA falharia em toda vaga com um 404 do provedor até alguém abrir Configurações.
 */
export function migrarModelo(log: (tipo: 'info' | 'alerta', msg: string) => void) {
  const { provedor, modelo } = lerIA();
  if (provedor === 'nenhum' || !modelo) return;
  const { padrao, opcoes } = MODELOS[provedor];
  if (opcoes.includes(modelo)) return;
  salvarIA({ modelo: padrao });
  log('alerta', `O modelo "${modelo}" não está mais disponível; a IA passou a usar "${padrao}". Confira em Configurações › Inteligência Artificial.`);
}

export function iaParaFront(): ConfigIA {
  const { provedor, modelo, chave } = lerIA();
  return { provedor, modelo, chaveDefinida: chave.length > 0, chaveFinal: chave.slice(-4) };
}

export const iaAtiva = () => {
  const ia = lerIA();
  return ia.provedor !== 'nenhum' && ia.chave.length > 0;
};

async function gemini(modelo: string, chave: string, system: string, usuario: string): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': chave },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: usuario }] }],
      generationConfig: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(90000),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${j.error?.message ?? 'erro desconhecido'}`);
  const texto = j.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!texto) throw new Error(`Gemini não devolveu texto (${j.candidates?.[0]?.finishReason ?? 'sem candidato'})`);
  return texto;
}

async function anthropic(modelo: string, chave: string, system: string, usuario: string): Promise<string> {
  const client = new Anthropic({ apiKey: chave });
  try {
    const resposta = await client.messages.create({
      model: modelo,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: usuario }],
    });
    if (resposta.stop_reason === 'refusal') throw new Error('o modelo recusou a tarefa');
    const texto = resposta.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    if (!texto) throw new Error('resposta vazia');
    return texto;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic: chave inválida');
    if (e instanceof Anthropic.NotFoundError) throw new Error(`Anthropic: modelo "${modelo}" não encontrado`);
    if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic: limite de requisições, tente de novo em instantes');
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic ${e.status}: ${e.message}`);
    throw e;
  }
}

/** Uma chamada de texto → texto no provedor configurado. */
export async function completar(system: string, usuario: string): Promise<string> {
  const { provedor, modelo, chave } = lerIA();
  if (provedor === 'nenhum' || !chave) throw new Error('IA não configurada');
  return provedor === 'gemini' ? gemini(modelo, chave, system, usuario) : anthropic(modelo, chave, system, usuario);
}

const SYSTEM_AVALIACAO = `Você é um recrutador experiente. Recebe um currículo e uma lista de vagas e avalia, para cada vaga, a compatibilidade REAL do candidato de 0 a 100, considerando área de atuação, cargo, senioridade e competências que o currículo de fato comprova. Vaga de área diferente da do candidato = nota baixa (0–20). Mesma área e cargo parecido com as competências principais atendidas = nota alta (70–100).
Responda SOMENTE com um array JSON, sem comentários, no formato: [{"id":"...","score":0,"motivo":"uma frase curta em português"}]`;

/** Erro de cota/limite do provedor: passa se esperar, ao contrário de chave inválida ou modelo inexistente. */
export const eDeCota = (e: unknown) => /\b429\b|quota|rate limit|limite de requisi|resource.?exhausted/i.test((e as Error).message ?? '');

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface OpcoesAvaliacao {
  /** Chamado a cada lote concluído, para a interface mostrar andamento numa lista longa. */
  aoProgredir?: (feitas: number, total: number) => void;
  /** Estourou a cota e não adianta insistir: para e devolve o que já avaliou, em vez de perder tudo. */
  aoPausar?: (motivo: string, avaliadas: number) => void;
}

const TENTATIVAS_COTA = 3;
const ESPERA_COTA_MS = [5000, 20000, 60000];

/**
 * Avalia a compatibilidade de várias vagas contra o currículo, em lotes.
 *
 * Cota estourada (429) é o caso comum nas chaves gratuitas — e antes derrubava a avaliação inteira, deixando
 * TODAS as vagas com o score léxico sem que ninguém percebesse. Agora espera e tenta de novo; se insistir em
 * falhar, devolve o que já conseguiu avaliar e avisa por `aoPausar`.
 */
export async function avaliarVagas(
  curriculoMd: string,
  vagas: { id: string; titulo: string; descricao: string }[],
  senioridade = '',
  opcoes: OpcoesAvaliacao = {},
): Promise<Map<string, { score: number; motivo: string }>> {
  const resultado = new Map<string, { score: number; motivo: string }>();
  for (let i = 0; i < vagas.length; i += 6) {
    const lote = vagas.slice(i, i + 6);
    const usuario = `${senioridade ? `SENIORIDADE DO CANDIDATO: ${senioridade} (vaga que pede nível acima disso = nota baixa)\n` : ''}CURRÍCULO:\n${curriculoMd.slice(0, 8000)}\n\nVAGAS:\n${lote.map(v => `--- id: ${v.id}\nTÍTULO: ${v.titulo}\n${v.descricao.slice(0, 2500)}`).join('\n\n')}`;

    let bruto = '';
    for (let tentativa = 0; ; tentativa++) {
      try {
        bruto = await completar(SYSTEM_AVALIACAO, usuario);
        break;
      } catch (e) {
        if (!eDeCota(e) || tentativa >= TENTATIVAS_COTA - 1) {
          if (eDeCota(e)) {
            opcoes.aoPausar?.((e as Error).message, resultado.size);
            return resultado; // o que já foi avaliado vale; o resto fica com o score por competências
          }
          throw e;
        }
        await dormir(ESPERA_COTA_MS[tentativa] ?? 60000);
      }
    }

    const inicio = bruto.indexOf('[');
    const fim = bruto.lastIndexOf(']');
    if (inicio < 0 || fim < inicio) throw new Error('resposta da IA sem JSON');
    const lista = JSON.parse(bruto.slice(inicio, fim + 1)) as { id?: string; score?: number; motivo?: string }[];
    for (const item of lista) {
      const id = String(item.id ?? '');
      const score = Number(item.score);
      if (lote.some(v => v.id === id) && Number.isFinite(score)) resultado.set(id, { score: Math.max(0, Math.min(100, Math.round(score))), motivo: String(item.motivo ?? '').slice(0, 200) });
    }
    opcoes.aoProgredir?.(Math.min(i + 6, vagas.length), vagas.length);
  }
  return resultado;
}

/**
 * Modo "Sem Piedade": a IA responde a pergunta aberta que a empresa fez, no lugar de pausar para o usuário.
 *
 * Três regras duras, nesta ordem de importância:
 *  1. só o que o currículo sustenta — nada inventado, nada suposto;
 *  2. o MENOS possível: uma frase curta, às vezes duas palavras. Resposta longa é o que denuncia robô;
 *  3. português de gente. Sem travessão, sem "vale ressaltar", sem "como profissional", sem lista, sem emoji.
 */
const SYSTEM_RESPOSTA = `Você responde formulários de vaga no lugar de um candidato, em português do Brasil, na primeira pessoa.

REGRAS ABSOLUTAS:
- Responda SOMENTE com o que o currículo comprova. Se o currículo não sustenta, dê uma resposta curta e neutra, sem inventar experiência, número, empresa, curso ou ferramenta.
- Responda o MÍNIMO POSSÍVEL. Uma frase curta. Muitas perguntas se respondem em duas ou três palavras. Nunca mais de 2 frases.
- Escreva como uma pessoa escreve às pressas num formulário: direto, simples, sem floreio.
- PROIBIDO: travessão (—), listas, marcadores, emoji, aspas, negrito, "vale ressaltar", "é importante destacar", "além disso", "em resumo", "como profissional", "enquanto desenvolvedor", "sou apaixonado", "busco constantemente", "de forma proativa", "agregar valor", "espero ter ajudado", qualquer menção a IA ou a currículo anexado.
- Não repita a pergunta. Não comece com "Sim, claro" nem com saudação.
- Se a pergunta pedir uma opção de uma lista, responda copiando EXATAMENTE uma das opções, e nada mais.
- NUNCA fale sobre o currículo nem sobre falta de informação. Nada de "não informado", "não consta no currículo", "não possuo informações". Quem responde é a pessoa, não alguém lendo o currículo dela.
- Tecnologia, ferramenta ou prática que o currículo NÃO mostra: nunca responda um "não" seco e nunca invente experiência. Diga, em uma frase curta, que ainda não usou no trabalho e que está aprendendo. Exemplos do tom: "Ainda não usei em projeto, estou estudando.", "Ainda estou aprendendo, sem experiência profissional ainda.". Em Sim/Não com lista, escolha a opção negativa, sem acrescentar texto.
- Escala de tempo ou de domínio sobre algo que ESTÁ no currículo, mas sem anos declarados: use o tempo total de carreira como referência e escolha a opção de quem usa aquilo profissionalmente. Não caia na opção mais baixa só porque o currículo não diz quantos anos de cada tecnologia.
- ATENÇÃO — isso vale SÓ para o que falta no currículo. Se o currículo mostra a tecnologia, responda no nível que ele comprova: escolha a opção que corresponde à experiência real, sem se diminuir e sem exagerar. "Ser modesto" NÃO é escolher a opção mais baixa de uma escala quando o currículo sustenta mais. Em escala de domínio, use os anos de experiência e os projetos descritos para escolher a opção certa.
- Se a pergunta exigir algo que o currículo não permite responder com honestidade (opinião sobre a empresa, dado pessoal, preferência que não está lá), responda exatamente a palavra PULAR e nada mais.

DOIS TIPOS DE PERGUNTA, E ELES NÃO SE RESPONDEM IGUAL:
- CONHECIMENTO TÉCNICO: tem resposta certa e não depende do currículo ("qual padrão trata falhas transitórias?", "o que garante consistência eventual entre serviços?", "quais práticas são de código limpo?"). Responda pelo conhecimento técnico, escolhendo a opção ou as opções corretas. Não diga que não sabe por causa do currículo: isto é uma prova, não uma entrevista sobre você.
- AUTORRELATO: fala da SUA experiência, tempo ou nível ("quantos anos com Java?", "qual seu nível em Kubernetes?", "você já trabalhou com X?"). Aqui vale o currículo, e só ele.

MARCAR VÁRIAS: se a pergunta pedir para marcar todas as que se aplicam, responda TODAS as opções corretas separadas por | (barra vertical), copiando cada uma exatamente. Uma só quando só uma estiver certa.

Responda apenas com o texto da resposta.`;

/**
 * Acréscimo do modo "Só na dúvida": em vez de assumir por conta própria o que o currículo não mostra, a IA
 * devolve a pergunta. É a diferença entre os dois modos com IA — no Sem Piedade ela nunca devolve nada.
 */
const REGRA_CAUTELOSA = `
MODO CAUTELOSO (vale mais que as regras acima quando houver conflito):
- Pergunta de CONHECIMENTO TÉCNICO: responda normalmente. É para isso que você está aqui.
- AUTORRELATO sobre algo que o currículo NÃO mostra: não invente e NÃO responda "estou aprendendo". Responda exatamente PULAR. A pessoa pode ter essa experiência sem ter posto no currículo, e quem decide é ela.
- Qualquer dado pessoal (documento, endereço, contato, dinheiro, data) ou opinião sobre a empresa: PULAR.
- Na dúvida entre responder e PULAR, escolha PULAR.`;

/** O modelo avisa que não dá para responder com honestidade; a vaga volta para o usuário. */
const PULAR = /^pular\.?$/i;

/** Marcas que denunciam texto de IA ou resposta longa demais; se aparecer, a resposta é recusada. */
export const CHEIRO_DE_IA =
  /—|\*\*|^[-*•]\s|vale (ressaltar|destacar|lembrar)|[ée] importante (notar|destacar|ressaltar|mencionar)|al[ée]m disso|em resumo|como (um |uma )?(profissional|desenvolvedor|candidato)|enquanto (profissional|desenvolvedor)|sou apaixonad|busco constantemente|de forma proativa|agregar valor|espero ter ajudado|fico feliz em|como (uma )?(ia|intelig[êe]ncia artificial)|n[ãa]o tenho acesso|com base (no|em) meu curr[íi]culo|conforme meu curr[íi]culo|n[ãa]o (possuo|tenho|disponho de) (informa|dados|detalhes)|informa[çc][õo]es suficientes|n[ãa]o (informado|consta|especificado|mencionado|declarado)|n[ãa]o (foi|est[áa]) (informado|especificado)|(no|do|em meu) curr[íi]culo|n[ãa]o (é|e) poss[íi]vel (responder|determinar|inferir|afirmar)|com os dados dispon[íi]veis/i;

const MAX_RESPOSTA = 240;

/** Limpa o que o modelo costuma acrescentar por conta própria (aspas, markdown, prefácio). */
export function limparResposta(bruto: string): string {
  return bruto
    .trim()
    .replace(/^[`"'*\s]+|[`"'*\s]+$/g, '')
    .replace(/^resposta\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A opção da vaga que corresponde ao que o modelo respondeu, ou null.
 *
 * Exigir igualdade exata descartava resposta boa: o modelo devolve "Avançado" e a opção é "Avançado — uso
 * diário", então a vaga parava para o usuário sem motivo. O motor de formulário já casa por similaridade;
 * aqui o critério é o mesmo (0,7), e só isso separa "aproveitar a resposta" de "perguntar à toa".
 */
export function casarComOpcao(opcoes: string[], resposta: string): string | null {
  const alvo = limparResposta(resposta).toLowerCase();
  const exata = opcoes.find(o => limparResposta(o).toLowerCase() === alvo);
  if (exata) return exata;
  let melhor: { opcao: string; s: number } | null = null;
  for (const o of opcoes) {
    const s = similaridade(o, resposta);
    if (s >= 0.7 && (!melhor || s > melhor.s)) melhor = { opcao: o, s };
  }
  return melhor?.opcao ?? null;
}

export interface PerguntaParaIA {
  rotulo: string;
  tipo: 'texto' | 'opcoes' | 'multipla' | 'arquivo';
  opcoes?: string[];
}

/**
 * Devolve a resposta ou null quando não dá para confiar (texto com cheiro de IA, longo demais, ou opção que
 * não existe na vaga). null faz a vaga pausar para o usuário, como no modo normal.
 */
export async function responderPergunta(
  curriculoMd: string,
  vaga: { titulo: string; empresa: string; descricao: string },
  pergunta: PerguntaParaIA,
  opcoes_: { cauteloso?: boolean } = {},
): Promise<string | null> {
  const lista = (pergunta.opcoes ?? []).map(o => `- ${o}`).join('\n');
  const opcoes = lista ? `\nOPÇÕES (responda copiando uma delas, exatamente):\n${lista}` : '';
  const usuario = [
    `VAGA: ${vaga.titulo} na ${vaga.empresa}`,
    vaga.descricao.slice(0, 1200),
    '',
    'CURRÍCULO DO CANDIDATO:',
    curriculoMd.slice(0, 6000),
    '',
    'PERGUNTA DO FORMULÁRIO:',
    `${pergunta.rotulo}${opcoes}`,
  ].join('\n');

  const bruto = await completar(opcoes_.cauteloso ? SYSTEM_RESPOSTA + REGRA_CAUTELOSA : SYSTEM_RESPOSTA, usuario);
  const texto = limparResposta(bruto);
  if (!texto || PULAR.test(texto)) return null;
  // "Marque todas que se aplicam": o motor espera "A | B". Casar só uma deixava a resposta pela metade.
  if (pergunta.tipo === 'multipla' && pergunta.opcoes?.length) {
    const escolhidas = texto
      .split('|')
      .map(t => casarComOpcao(pergunta.opcoes ?? [], t))
      .filter((o): o is string => !!o);
    const unicas = [...new Set(escolhidas)];
    return unicas.length ? unicas.join(' | ') : null;
  }
  if (pergunta.opcoes?.length) return casarComOpcao(pergunta.opcoes, texto);
  if (texto.length > MAX_RESPOSTA) return null;
  if (CHEIRO_DE_IA.test(texto)) return null;
  return texto;
}

/** Chamada mínima para validar chave e modelo. */
export async function testarIA(): Promise<string> {
  const texto = await completar('Responda exatamente com a palavra OK, sem mais nada.', 'Teste de conexão.');
  const { provedor, modelo } = lerIA();
  return `${provedor === 'gemini' ? 'Gemini' : 'Anthropic'} (${modelo}) respondeu: ${texto.trim().slice(0, 40)}`;
}
