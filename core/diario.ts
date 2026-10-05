// Diário: o histórico do robô em arquivo de texto, dentro do projeto.
//
// A tela guarda 300 linhas no SQLite e joga o resto fora — que é justamente o que faz falta quando algo deu
// errado ontem e a gente vai investigar hoje. Aqui cada dia tem o seu arquivo, com data completa, e nada é
// apagado antes de DIAS_GUARDADOS. É um arquivo de texto de propósito: dá para abrir, colar e ler.
//
// Fica em `diario/` na raiz do projeto (fora do git) para ser fácil de achar e de me mandar.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LinhaLog } from '../src/types.ts';

export const DIR_DIARIO = join(process.cwd(), 'diario');
// Teste roda com ACV_DIR apontando para uma pasta temporária: o diário do uso real não pode receber as
// linhas dos cenários falsos ("Vaga 53 em Acme"), senão o histórico que existe para investigar vira ficção.
const LIGADO = !process.env.ACV_DIR;
const DIAS_GUARDADOS = 14;
const ARQUIVO = /^acv-(\d{4}-\d{2}-\d{2})\.log$/;

if (LIGADO) mkdirSync(DIR_DIARIO, { recursive: true });

/**
 * Data LOCAL em AAAA-MM-DD.
 *
 * `toISOString` é UTC: às 21h de Brasília ele já diz "amanhã", então o diário trocava de arquivo às 21h e
 * gravava a data de amanhã ao lado da hora de hoje. Bug visto no primeiro dia de uso (28/09/2026).
 */
const dia = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const caminhoDoDia = (d = new Date()) => join(DIR_DIARIO, `acv-${dia(d)}.log`);

/** Apaga os diários velhos. Roda uma vez por dia, na primeira linha escrita. */
let ultimaFaxina = '';
function faxina(hoje: string) {
  if (ultimaFaxina === hoje) return;
  ultimaFaxina = hoje;
  const limite = dia(new Date(Date.now() - DIAS_GUARDADOS * 86_400_000));
  try {
    for (const nome of readdirSync(DIR_DIARIO)) {
      const m = ARQUIVO.exec(nome) ?? /^eventos-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(nome);
      if (m && m[1] < limite) unlinkSync(join(DIR_DIARIO, nome));
    }
  } catch {
    /* diário é conveniência: nunca derruba o robô */
  }
}

/**
 * Grava uma linha no diário de hoje. Nunca lança: um disco cheio não pode impedir uma candidatura.
 *
 * O `hora` que chega é o mesmo que aparece na tela (HH:MM:SS), então a linha do arquivo e a da tela casam na
 * hora de comparar as duas.
 */
export function anotar(linha: LinhaLog): void {
  if (!LIGADO) return;
  try {
    const hoje = dia();
    faxina(hoje);
    appendFileSync(caminhoDoDia(), `${hoje} ${linha.hora} [${linha.tipo}] ${linha.msg}\n`, 'utf8');
  } catch {
    /* idem */
  }
}

/** Marca o começo de uma execução: sem isto, dois dias de log viram um borrão só. */
export function abrirDiario(versao: string): void {
  anotar({ hora: new Date().toLocaleTimeString('pt-BR', { hour12: false }), tipo: 'info', msg: `─── ACV iniciado (${versao}) ───` });
}

// ─── Eventos: o mesmo histórico, em forma de dado ───────────────────────────────────────────────
//
// Por que um segundo arquivo ao lado do de texto, em vez de só o de texto: a linha em português é boa para
// LER e péssima para CONTAR. "Falha ao candidatar: Desenvolvedor(a) Fullstack (Net e Angular/React) Pleno"
// não diz a plataforma, não diz o id da vaga, não diz se havia prova de rede, e agrupar 200 dessas exige
// adivinhar o formato de cada frase. Toda vez que eu precisei responder "isso é duplicata?" ou "por que essa
// morreu?", o trabalho foi reconstruir dado a partir de prosa — e uma vez eu errei a resposta por causa disso
// (afirmei que havia duplicatas; eram ensaio + real, e a coluna que resolvia não estava na frase).
//
// Então: `diario/eventos-AAAA-MM-DD.jsonl`, um objeto por linha, campos estáveis. JSONL e não JSON porque se
// escreve acrescentando (nunca reescreve o arquivo), sobrevive a um processo morto no meio, e continua
// servindo para `grep`. É a forma que `core/relato.ts` lê para montar o resumo que vai para análise.
//
// Regra para quem acrescentar evento novo: `nome` em `assunto.fato` (minúsculo, estável — é por ele que se
// agrupa), e em `dados` nada de dado pessoal. O diário é o arquivo que a pessoa cola num chat para pedir
// ajuda: CPF, telefone, endereço e o texto do currículo não entram aqui. Título de vaga e nome de empresa
// são públicos e entram, porque sem eles não se acha o caso.
const ARQUIVO_EVENTOS = /^eventos-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const caminhoDosEventos = (d = new Date()) => join(DIR_DIARIO, `eventos-${dia(d)}.jsonl`);

export type Evento = {
  em: string;
  evento: string;
  plataforma?: string;
  vaga?: string;
  dados?: Record<string, unknown>;
};

/** Grava um evento. Nunca lança, pela mesma razão do `anotar`: observar não pode atrapalhar trabalhar. */
export function evento(nome: string, info: Omit<Evento, 'em' | 'evento'> = {}): void {
  if (!LIGADO) return;
  try {
    faxina(dia());
    const linha: Evento = { em: new Date().toISOString(), evento: nome, ...info };
    appendFileSync(caminhoDosEventos(), `${JSON.stringify(linha)}\n`, 'utf8');
  } catch {
    /* idem */
  }
}

/** Os eventos dos últimos `dias` dias, em ordem de tempo. Linha corrompida é pulada, não derruba a leitura. */
export function lerEventos(dias = 7): Evento[] {
  const limite = dia(new Date(Date.now() - (dias - 1) * 86_400_000));
  const fora: Evento[] = [];
  try {
    for (const nome of readdirSync(DIR_DIARIO).sort()) {
      const m = ARQUIVO_EVENTOS.exec(nome);
      if (!m || m[1] < limite) continue;
      for (const l of readFileSync(join(DIR_DIARIO, nome), 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try {
          fora.push(JSON.parse(l) as Evento);
        } catch {
          /* linha escrita pela metade por um processo morto no meio: pula */
        }
      }
    }
  } catch {
    /* sem pasta de diário ainda */
  }
  return fora;
}
