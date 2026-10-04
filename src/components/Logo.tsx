/**
 * Marca do ACV.
 *
 * O PNG entra como MÁSCARA, não como imagem: o desenho é monocromático, então a cor vem de `currentColor`
 * (`bg-current`). Com isso o mesmo arquivo serve na sidebar escura (branca) e nos painéis claros (escura),
 * sem dois arquivos para manter em sincronia.
 *
 * `aria-label` mantém o nome no lugar do texto que a logo substituiu: quem usa leitor de tela continua ouvindo
 * "ACV", e não um espaço em branco.
 */
const ARQUIVO = '/logo.png';
const PROPORCAO = '666 / 390'; // do recorte gerado em brand/gerar-logo.py

export default function Logo({ className = '' }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="ACV"
      // `self-start` porque num flex-col o item esticaria para a largura toda e, com a máscara centralizada,
      // a marca apareceria no meio enquanto o texto ao lado fica à esquerda. A largura sai da proporção.
      className={`inline-block shrink-0 self-start bg-current ${className}`}
      style={{
        aspectRatio: PROPORCAO,
        maskImage: `url(${ARQUIVO})`,
        WebkitMaskImage: `url(${ARQUIVO})`,
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  );
}
