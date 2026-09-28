// Diário: o histórico do robô em arquivo de texto, dentro do projeto.
//
// A tela guarda 300 linhas no SQLite e joga o resto fora — que é justamente o que faz falta quando algo deu
// errado ontem e a gente vai investigar hoje. Aqui cada dia tem o seu arquivo, com data completa, e nada é
// apagado antes de DIAS_GUARDADOS. É um arquivo de texto de propósito: dá para abrir, colar e ler.
//
// Fica em `diario/` na raiz do projeto (fora do git) para ser fácil de achar e de me mandar.
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LinhaLog } from '../src/types.ts';

export const DIR_DIARIO = join(process.cwd(), 'diario');
// Teste roda com AUTOCV_DIR apontando para uma pasta temporária: o diário do uso real não pode receber as
// linhas dos cenários falsos ("Vaga 53 em Acme"), senão o histórico que existe para investigar vira ficção.
const LIGADO = !process.env.AUTOCV_DIR;
const DIAS_GUARDADOS = 14;
const ARQUIVO = /^autocv-(\d{4}-\d{2}-\d{2})\.log$/;

if (LIGADO) mkdirSync(DIR_DIARIO, { recursive: true });

const dia = (d = new Date()) => d.toISOString().slice(0, 10);
export const caminhoDoDia = (d = new Date()) => join(DIR_DIARIO, `autocv-${dia(d)}.log`);

/** Apaga os diários velhos. Roda uma vez por dia, na primeira linha escrita. */
let ultimaFaxina = '';
function faxina(hoje: string) {
  if (ultimaFaxina === hoje) return;
  ultimaFaxina = hoje;
  const limite = new Date(Date.now() - DIAS_GUARDADOS * 86_400_000).toISOString().slice(0, 10);
  try {
    for (const nome of readdirSync(DIR_DIARIO)) {
      const m = ARQUIVO.exec(nome);
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
  anotar({ hora: new Date().toLocaleTimeString('pt-BR', { hour12: false }), tipo: 'info', msg: `─── AutoCV iniciado (${versao}) ───` });
}
