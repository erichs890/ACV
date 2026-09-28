// Login manual assistido para plataforma com conta (Indeed hoje; Gupy e outras depois).
//
// O AutoCV abre uma janela VISÍVEL do navegador do robô na página de login; a pessoa entra como sempre (senha,
// código, captcha — tudo com ela). O robô só observa o ESTADO da página (URL saiu do login + prova de "logado"
// do adapter), nunca o que é digitado: nenhum campo do formulário é lido, instrumentado ou registrado.
//
// Exige interface gráfica (janela à mostra). Depois de conectada, a sessão fica no PERFIL PERSISTENTE do
// navegador do robô (cookies + localStorage, cifrados em repouso pelo próprio Edge/Chrome/Firefox com a conta
// do Windows), e é de lá que busca e candidatura a reaproveitam — em headless ou não, conforme cada adapter.
// `storageState()` não é copiado para o banco: seria uma segunda cópia, com cifra caseira e a chave ao lado.
// ponytail: se um dia a sessão precisar sair do perfil (outro motor, backup), aí sim gravar o storageState cifrado.
import type { Page } from 'playwright';
import { navegador } from './browser.ts';
import { emitir } from './events.ts';
import { ler, salvarParcial } from './estado.ts';
import { adapters } from './platforms/adapter.ts';
import { log } from './storage/db.ts';

/** O que cada adapter com login declara: onde entrar, como reconhecer as telas de login e o estado logado. */
export interface ProvaDeLogin {
  /** Página de login da plataforma */
  urlLogin: string;
  /** URLs das telas de autenticação (senha, código, recuperação): enquanto a página está numa delas, a pessoa ainda está entrando */
  telasDeLogin: RegExp;
  /** Página que carrega logada (ou manda para o login) */
  urlProva: string;
  /** true = a página está no estado "logado" */
  logado: (page: Page) => Promise<boolean>;
}

const MINUTOS_PARA_ENTRAR = 10;

const provaDe = (id: string): ProvaDeLogin => {
  const prova = adapters[id]?.sessao;
  if (!prova) throw new Error(`${adapters[id]?.nome ?? id} não usa login.`);
  return prova;
};

function gravarSessao(id: string, valida: boolean) {
  const atual = ler.conexoes()[id];
  salvarParcial({ conexoes: { ...ler.conexoes(), [id]: { ...atual, conectadaEm: atual?.conectadaEm ?? new Date().toISOString(), sessao: { validadaEm: new Date().toISOString(), valida } } } });
}

/** Abre a URL de prova no navegador do robô e diz se a sessão está logada. */
export async function validarSessao(id: string): Promise<boolean> {
  const prova = provaDe(id);
  const ctx = await navegador(true);
  const page = await ctx.newPage();
  try {
    await page.goto(prova.urlProva, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500); // cabeçalhos com o nome da pessoa costumam vir por JS
    return await prova.logado(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// Uma entrada por vez; `cancelarLogin` fecha a janela e a espera termina em "cancelado"
let cancelar: (() => void) | null = null;
export const entrando = () => cancelar !== null;

/** Página de aviso que fica na primeira aba: identifica a janela como do AutoCV, para ninguém fechá-la sem querer. */
const AVISO = (nome: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><html lang="pt-BR"><title>AutoCV — entre no ${nome} na outra aba</title><body style="font:16px system-ui;margin:48px;max-width:640px">
<h1 style="font-size:22px">Esta janela é do robô do AutoCV</h1><p>Entre na sua conta do <b>${nome}</b> na outra aba desta janela. O AutoCV não vê nem guarda a sua senha: ele só espera a página sair da tela de login. Depois disso pode fechar tudo.</p></body></html>`,
  )}`;

/**
 * Abre a janela, espera a pessoa entrar e valida. Detecção por ESTADO, não por tempo: a URL precisa sair das
 * telas de login e ficar fora por 3 checagens seguidas; então a prova de "logado" decide. Espera generosa
 * (2FA, captcha, digitação lenta): ${MINUTOS_PARA_ENTRAR} min. Devolve o motivo quando não conecta.
 */
export async function entrarNaJanela(id: string): Promise<{ ok: true } | { ok: false; motivo: string }> {
  if (cancelar) return { ok: false, motivo: 'já existe um login em andamento' };
  const prova = provaDe(id);
  const nome = adapters[id].nome;
  const ctx = await navegador(true);
  const aviso = await ctx.newPage();
  const page = await ctx.newPage();
  let cancelado = false;
  cancelar = () => {
    cancelado = true;
    page.close().catch(() => {});
  };
  try {
    await aviso.goto(AVISO(nome)).catch(() => {});
    await page.goto(prova.urlLogin, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.bringToFront().catch(() => {});
    log.registrar('aguardo', `Entre na sua conta do ${nome} na janela que abriu (até ${MINUTOS_PARA_ENTRAR} min). O AutoCV não vê nem guarda a sua senha.`);
    const fim = Date.now() + MINUTOS_PARA_ENTRAR * 60_000;
    let fora = 0;
    while (Date.now() < fim) {
      await new Promise(r => setTimeout(r, 2000));
      if (cancelado) return { ok: false, motivo: 'login cancelado' };
      if (page.isClosed()) return { ok: false, motivo: `a janela do ${nome} foi fechada antes de terminar o login` };
      fora = prova.telasDeLogin.test(page.url()) ? 0 : fora + 1;
      if (fora >= 3) break;
    }
    if (fora < 3) return { ok: false, motivo: `tempo esgotado (${MINUTOS_PARA_ENTRAR} min) sem sair da tela de login do ${nome}. Tente de novo.` };
    await page.close().catch(() => {});
    if (!(await validarSessao(id))) return { ok: false, motivo: `você saiu da tela de login, mas o ${nome} não mostrou a sessão ativa. Tente de novo.` };
    gravarSessao(id, true);
    log.registrar('sucesso', `${nome} conectado: a sessão fica no perfil do navegador do robô.`);
    return { ok: true };
  } finally {
    cancelar = null;
    await aviso.close().catch(() => {});
    await page.close().catch(() => {});
  }
}

export function cancelarLogin() {
  cancelar?.();
}

/** Sinal de sessão caída durante o uso: a plataforma continua conectada, mas a fila dela para até reconectar. */
export function marcarSessaoExpirada(id: string) {
  if (!ler.conexoes()[id] || ler.conexoes()[id].sessao?.valida === false) return;
  gravarSessao(id, false);
  log.registrar('alerta', `A sessão do ${adapters[id]?.nome ?? id} expirou: as vagas dele ficam paradas até você entrar de novo em Plataformas.`);
  emitir({ tipo: 'aviso', nivel: 'erro', msg: `Sessão do ${adapters[id]?.nome ?? id} expirada — entre de novo em Plataformas.` });
}

/** A fila pode mexer com esta plataforma? Sem login (plataforma pública) ou sessão válida = sim. */
export const sessaoValida = (id: string) => ler.conexoes()[id]?.sessao?.valida !== false;
