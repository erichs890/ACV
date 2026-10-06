import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A abertura do ACV: o logo se desenhando, por 3 segundos, com saída a qualquer momento.
 *
 * **Por que não são simplesmente os 3 primeiros segundos do vídeo.** `vidlog.mp4` tem 8 s e é um desenho:
 * aos 2,4 s existe só um traço diagonal, o monograma fecha por volta dos 5,0 s e os últimos 3 s são o logo
 * parado. Cortar em 3 s mostraria o risco e nunca o logo — o oposto do que o vídeo serve para mostrar.
 * Então o que toca são os 5 s de DESENHO acelerados para caber em 3 s: você vê a revelação inteira, no
 * tempo que pediu, terminando exatamente no logo completo.
 *
 * O que ela não faz, de propósito:
 *  - **não atrasa o app.** Ela aparece POR CIMA, enquanto o React monta e o núcleo é consultado atrás dela;
 *    os 3 s são gastos numa espera que já existia, e não somados a ela.
 *  - **não prende ninguém.** Clique, tecla, Esc ou o botão saem na hora. E some sozinha se o vídeo não
 *    carregar, se der erro ou se o navegador recusar tocar — abertura que trava o acesso ao app é defeito,
 *    não enfeite.
 *  - **não repete.** Uma vez por sessão do navegador: abrir o ACV mostra, recarregar a página no meio do
 *    trabalho não. Para rever, há o botão em Configurações › Aparência.
 *  - **não se impõe.** Com `prefers-reduced-motion` ela nem monta.
 */
const DURACAO_MS = 3000;
/** Onde o desenho fecha, no tempo do arquivo. Depois disto o vídeo é só o logo parado. */
const FIM_DO_DESENHO_S = 5;
const SAIDA_MS = 420;
const CHAVE_SESSAO = 'acv:abertura-vista';

export function aberturaJaFoiVista(): boolean {
  try {
    return sessionStorage.getItem(CHAVE_SESSAO) === '1';
  } catch {
    return false;
  }
}

export function esquecerAbertura(): void {
  try {
    sessionStorage.removeItem(CHAVE_SESSAO);
  } catch {
    /* sem armazenamento: a abertura volta no próximo carregamento de qualquer jeito */
  }
}

export default function Abertura({ onFim }: { onFim: () => void }) {
  const [saindo, setSaindo] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  const encerrado = useRef(false);

  const encerrar = useCallback(() => {
    if (encerrado.current) return;
    encerrado.current = true;
    try {
      sessionStorage.setItem(CHAVE_SESSAO, '1');
    } catch {
      /* sem armazenamento, ela reaparece no próximo carregamento — chato, não quebrado */
    }
    setSaindo(true);
    setTimeout(onFim, SAIDA_MS);
  }, [onFim]);

  useEffect(() => {
    // O foco vai para o botão de pular: quem usa teclado alcança a saída sem adivinhar
    botao.current?.focus();
    const relogio = setTimeout(encerrar, DURACAO_MS);
    const porTecla = () => encerrar();
    globalThis.addEventListener('keydown', porTecla);
    return () => {
      clearTimeout(relogio);
      globalThis.removeEventListener('keydown', porTecla);
    };
  }, [encerrar]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    // 5 s de desenho em 3 s de relógio
    v.playbackRate = FIM_DO_DESENHO_S / (DURACAO_MS / 1000);
    // `muted` já está no elemento: sem isso o navegador recusa tocar sozinho e a tela ficaria parada
    v.play().catch(encerrar);
  }, [encerrar]);

  return (
    // A tela inteira é atalho de saída, e sem `aria-label`: rótulo em `div` sem papel não é anunciado. O
    // caminho acessível é o botão com texto que recebe o foco abaixo, mais o ouvinte de tecla global.
    // biome-ignore lint/a11y/noStaticElementInteractions: ver acima
    // biome-ignore lint/a11y/useKeyWithClickEvents: qualquer tecla encerra, por um ouvinte global
    <div
      onClick={encerrar}
      className="abertura fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden [animation:abertura-entra_0.25s_ease-out_both]"
      style={saindo ? { animation: `abertura-sai ${SAIDA_MS}ms cubic-bezier(0.4, 0, 0.2, 1) both` } : undefined}
    >
      <video
        ref={video}
        src="/vidlog.mp4"
        muted
        playsInline
        preload="auto"
        aria-hidden
        onEnded={encerrar}
        onError={encerrar}
        // `darken` no claro, `invert` + `lighten` no escuro (src/index.css): o papel do vídeo some no fundo e
        // sobra só a tinta, sem moldura e sem retângulo branco numa tela escura
        className="abertura-video w-[min(560px,78vw)] max-w-full"
      />

      <div className="mt-6 flex flex-col items-center gap-3">
        <span aria-hidden className="block h-[3px] w-[180px] overflow-hidden rounded-full bg-panel-border">
          <span className="block h-full origin-left rounded-full bg-blue-dark" style={{ animation: `abertura-tempo ${DURACAO_MS}ms linear both` }} />
        </span>
        <button ref={botao} type="button" onClick={encerrar} className="rounded-[6px] px-3 py-1.5 text-[11px] font-bold text-ink-soft transition-colors hover:bg-panel hover:text-ink">
          Pular abertura
        </button>
      </div>
    </div>
  );
}
