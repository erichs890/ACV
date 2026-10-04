import { chromium, firefox, type Browser, type BrowserContext } from 'playwright';
import { DIRS } from './config.ts';
import { kv, log } from './storage/db.ts';

// Uma única sessão de navegador (nunca duas candidaturas em paralelo).
//
// Motor escolhido em Automação › Segurança (`automacao.navegador`):
//  - 'edge'    → o Edge/Chrome já instalado na máquina (o Chromium do Playwright é o último recurso);
//  - 'firefox' → o Firefox DO PLAYWRIGHT. O Playwright não consegue dirigir o Firefox instalado no Windows: ele usa
//                uma build própria (`npx playwright install firefox`, ~130 MB em %LOCALAPPDATA%\ms-playwright).
//                Se ela não existir, o robô avisa e cai para o Edge em vez de parar.
// Cada motor tem o seu perfil (cookies e logins não são compatíveis entre eles): entrar no Indeed com um não vale
// para o outro.
export type Motor = 'edge' | 'firefox';
let contexto: BrowserContext | null = null;
let visivel = false;
let motorAtual: Motor = 'edge';

const motorEscolhido = (): Motor => (kv.get<{ navegador?: Motor }>('automacao', {}).navegador === 'firefox' ? 'firefox' : 'edge');

/** O contexto pode estar "vivo" no objeto e morto no sistema (usuário fechou a janela, processo caiu). */
async function saudavel(c: BrowserContext): Promise<boolean> {
  try {
    const p = await c.newPage();
    await p.close();
    return true;
  } catch {
    return false;
  }
}

async function abrirChromium(perfil: string, mostrar: boolean, erros: string[]): Promise<BrowserContext | null> {
  for (const channel of ['msedge', 'chrome', undefined] as const) {
    try {
      return await chromium.launchPersistentContext(perfil, { channel, headless: !mostrar, locale: 'pt-BR', viewport: { width: 1280, height: 900 } });
    } catch (e) {
      erros.push(`${channel ?? 'chromium'}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return null;
}

export async function navegador(mostrar: boolean): Promise<BrowserContext> {
  const motor = motorEscolhido();
  if (contexto && (visivel !== mostrar || motorAtual !== motor)) await fecharNavegador();
  // Sem esta checagem, um navegador morto trava TODAS as candidaturas seguintes com o mesmo erro até reiniciar o núcleo
  if (contexto && !(await saudavel(contexto))) await fecharNavegador();
  if (contexto) return contexto;
  const erros: string[] = [];
  // ACV_PERFIL: outro diretório de perfil (o self-check usa um temporário para não colidir com o núcleo rodando)
  const base = process.env.ACV_PERFIL ?? DIRS.navegador;

  if (motor === 'firefox') {
    try {
      contexto = await firefox.launchPersistentContext(`${base}-firefox`, { headless: !mostrar, locale: 'pt-BR', viewport: { width: 1280, height: 900 } });
      motorAtual = 'firefox';
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      erros.push(`firefox: ${msg}`);
      log.registrar(
        'alerta',
        /Executable doesn't exist/i.test(msg)
          ? 'Firefox do Playwright não está instalado (rode "npx playwright install firefox" na pasta do ACV). Usando o Edge desta vez.'
          : `Não consegui abrir o Firefox (${msg}). Usando o Edge desta vez.`,
      );
    }
  }
  if (!contexto) {
    contexto = await abrirChromium(base, mostrar, erros);
    motorAtual = 'edge';
  }
  if (!contexto) throw new Error(`Nenhum navegador disponível. Instale o Microsoft Edge ou o Google Chrome. (${erros.join(' | ')})`);
  visivel = mostrar;
  contexto.on('close', () => {
    contexto = null;
  });
  return contexto;
}

export async function fecharNavegador() {
  const c = contexto;
  contexto = null;
  await c?.close().catch(() => {});
}

/**
 * Navegador só para gerar PDF. O Playwright só sabe fazer `page.pdf()` em Chromium OCULTO — nem no Firefox, nem no
 * Edge com a janela à mostra. Por isso o PDF do currículo adaptado nunca usa a sessão de navegação: abre um Chromium
 * oculto, imprime e fecha.
 */
export async function comNavegadorDePdf<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  const erros: string[] = [];
  for (const channel of ['msedge', 'chrome', undefined] as const) {
    let b: Browser | null = null;
    try {
      b = await chromium.launch({ channel, headless: true });
    } catch (e) {
      erros.push(`${channel ?? 'chromium'}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    try {
      return await fn(b);
    } finally {
      await b.close().catch(() => {});
    }
  }
  throw new Error(`Para gerar o PDF do currículo é preciso o Microsoft Edge ou o Google Chrome instalado. (${erros.join(' | ')})`);
}
