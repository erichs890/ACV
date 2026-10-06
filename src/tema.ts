// Tema claro/escuro do app.
//
// Mora no navegador (`localStorage`) e não no núcleo, de propósito: é preferência de TELA, de quem está
// olhando, e não dado do robô. Mandá-la ao núcleo significaria esperar o servidor responder para saber de
// que cor pintar a página — e é justamente isso que não pode acontecer, porque o tema tem de valer no
// primeiro quadro (ver `index.html`).
//
// São três opções e não duas: `sistema` segue o Windows, e é o que faz o app acompanhar quando a pessoa
// troca o tema da máquina no fim do dia. `claro` e `escuro` são a escolha explícita, que ganha do sistema.

export type Tema = 'claro' | 'escuro' | 'sistema';

/**
 * A chave do `localStorage`.
 *
 * **`index.html` repete esta string num script embutido**, e a repetição é consciente: aquele script roda
 * antes de qualquer módulo para o app não piscar branco antes de ficar escuro, e script embutido não
 * importa módulo. São três linhas lá; mexeu aqui, mexa lá — o comentário de lá aponta para cá.
 */
export const CHAVE_TEMA = 'acv:tema';

const ESCUROS = new Set<string>(['claro', 'escuro', 'sistema']);

export function lerTema(): Tema {
  try {
    const t = localStorage.getItem(CHAVE_TEMA) ?? '';
    return ESCUROS.has(t) ? (t as Tema) : 'sistema';
  } catch {
    return 'sistema'; // navegador com armazenamento bloqueado: o sistema decide, e nada quebra
  }
}

/** O tema que de fato vai para a tela: `sistema` vira o que o Windows estiver usando agora. */
export const temaEfetivo = (t: Tema): 'claro' | 'escuro' => (t === 'sistema' ? (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro') : t);

/**
 * Pinta a página. `data-tema` fica no `<html>` porque é dele que o CSS parte, e `color-scheme` vai junto
 * para o navegador pintar barra de rolagem, seletor de data e caixa de seleção no tom certo — sem isso o
 * tema fica escuro e os controles nativos continuam brancos.
 */
export function aplicarTema(t: Tema): void {
  const efetivo = temaEfetivo(t);
  const raiz = document.documentElement;
  raiz.dataset.tema = efetivo;
  raiz.style.colorScheme = efetivo === 'escuro' ? 'dark' : 'light';
}

export function salvarTema(t: Tema): void {
  try {
    localStorage.setItem(CHAVE_TEMA, t);
  } catch {
    // sem armazenamento, o tema vale só até fechar a aba — melhor que não deixar escolher
  }
  aplicarTema(t);
}

/**
 * Enquanto estiver em `sistema`, acompanha a troca de tema do Windows ao vivo.
 * Devolve a função que desfaz o laço (para o `useEffect` de quem chamou).
 */
export function seguirSistema(quando: () => void): () => void {
  const consulta = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  if (!consulta) return () => {};
  consulta.addEventListener('change', quando);
  return () => consulta.removeEventListener('change', quando);
}
