import { useEffect, useRef } from 'react';

/**
 * Orbe de espera: uma esfera de pontos que se move de um jeito diferente conforme o que o robô está fazendo.
 *
 * Cada estado é um movimento, não um enfeite trocado de cor — "procurando" varre um meridiano pela esfera,
 * "enviando" solta partículas para fora, "esperando" respira. Quem olha a tela sabe o que está acontecendo
 * antes de ler a legenda, e esperas diferentes param de parecer a mesma coisa.
 *
 * Decisões de desenho:
 *  - Canvas 2D e só `arc()`: nada de WebGL, filtro ou sombra. Roda igual em qualquer navegador e não custa GPU
 *    numa tela que fica aberta o dia todo.
 *  - Monocromático, herdando `currentColor` do elemento: o orbe fica da cor do texto ao redor, então ele
 *    acompanha tema e contexto sem receber uma prop de cor que alguém vai esquecer de atualizar.
 *  - Profundidade vira tamanho e opacidade do ponto: é o que dá volume sem desenhar uma esfera de verdade.
 *  - Dois tamanhos com contagem de pontos própria (não é escala): 20 dentro de um botão, 64 no meio da tela.
 *    Um orbe de 64 reduzido a 20 vira uma mancha.
 *  - `prefers-reduced-motion` desenha um quadro parado, `IntersectionObserver` pausa fora da tela e o
 *    device-pixel-ratio para em 2: o laço não roda à toa.
 */
export type EstadoOrbe = 'pensando' | 'procurando' | 'lendo' | 'escrevendo' | 'enviando' | 'conectando' | 'esperando';

interface Props {
  estado?: EstadoOrbe;
  tamanho?: 20 | 64;
  /** Lido por leitor de tela. Sem ele o orbe é decorativo e some da árvore de acessibilidade. */
  rotulo?: string;
  className?: string;
}

const TAU = Math.PI * 2;

/** Ponto no espaço antes de projetar. `brilho` é o realce do estado (1 = normal). */
interface P3 {
  x: number;
  y: number;
  z: number;
  brilho?: number;
}

/** Quanto cada tamanho pede de pontos e de velocidade. Ajustado no olho, um de cada vez. */
const PRESET = {
  20: { globo: 46, fio: 16, orbitaDots: 6, raioPonto: 0.85, vel: 1.15 },
  64: { globo: 150, fio: 34, orbitaDots: 13, raioPonto: 1.35, vel: 1 },
} as const;

type Preset = (typeof PRESET)[keyof typeof PRESET];

/** Ângulo áureo: é ele que espalha os pontos sem formar fileira. */
const AUREO = Math.PI * (3 - Math.sqrt(5));

/**
 * Esfera de pontos pela espiral de Fibonacci — a base de quase todos os estados.
 *
 * A primeira versão usava anéis de latitude e o resultado, na tela, era uma GRADE: as fileiras se alinhavam e
 * a esfera virava um retângulo de pontos. A espiral distribui sem fileira nenhuma e lê como volume no primeiro
 * olhar, que é o ponto do desenho.
 */
function globo(n: number, giro: number): P3[] {
  const pts: P3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * AUREO + giro;
    pts.push({ x: r * Math.cos(a), y, z: r * Math.sin(a) });
  }
  return pts;
}

/** Inclina a cena no eixo X. Sem isto o polo fica de frente e a esfera parece um disco. */
function inclinar(pts: P3[], ang: number): P3[] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  for (const q of pts) {
    const y = q.y * c - q.z * s;
    q.z = q.y * s + q.z * c;
    q.y = y;
  }
  return pts;
}

/** Distância angular entre dois ângulos, sempre em [0, π]. */
const distAngular = (a: number, b: number) => {
  const d = Math.abs(((a - b) % TAU) + TAU) % TAU;
  return d > Math.PI ? TAU - d : d;
};

const CENAS: Record<EstadoOrbe, (p: Preset, t: number) => P3[]> = {
  /**
   * Partículas em órbitas inclinadas, como um átomo pensando.
   *
   * As inclinações são escolhidas a dedo, não calculadas: a primeira versão as espaçava por fórmula e as três
   * caíram quase no mesmo plano — na tela virou uma faixa horizontal, não um átomo.
   */
  pensando: (p, t) => {
    const pts: P3[] = [];
    const n = p.orbitaDots * 2;
    const ORBITAS = [
      { tilt: 0.15, giro: 0, vel: 1 },
      { tilt: 1.15, giro: 1.05, vel: 1.18 },
      { tilt: 2.05, giro: 2.2, vel: 0.86 },
    ];
    for (const [o, orb] of ORBITAS.entries()) {
      const ct = Math.cos(orb.tilt);
      const st = Math.sin(orb.tilt);
      const cg = Math.cos(orb.giro);
      const sg = Math.sin(orb.giro);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const a = t * 1.5 * orb.vel + o * 1.7 - u * TAU;
        // Círculo no plano XY, inclinado em X e depois girado em Y
        const px = Math.cos(a);
        const py = Math.sin(a) * ct;
        const pz = Math.sin(a) * st;
        // Rastro: a cabeça é viva e a cauda se apaga — é ela que dá o sentido do giro
        pts.push({ x: px * cg + pz * sg, y: py, z: -px * sg + pz * cg, brilho: 0.3 + 2.2 * (1 - u) ** 2.4 });
      }
    }
    return inclinar(pts, 0.26);
  },

  /** Um meridiano varre o globo; o que ele toca acende e incha. */
  procurando: (p, t) => {
    const scan = t * 1.25;
    return inclinar(
      globo(p.globo, t * 0.1).map(q => {
        const lon = Math.atan2(q.z, q.x);
        const perto = Math.max(0, 1 - distAngular(lon, scan) / 0.5);
        const empurrao = 1 + 0.12 * perto; // a varredura levanta os pontos: dá relevo ao facho
        return { x: q.x * empurrao, y: q.y, z: q.z * empurrao, brilho: 0.7 + 2.4 * perto };
      }),
      0.42,
    );
  },

  /** Uma onda de latitude sobe pelo globo, como quem corre os olhos por um texto. */
  lendo: (p, t) => {
    return inclinar(
      globo(p.globo, t * 0.08).map(q => {
        // A onda anda na altura: a faixa acesa atravessa a esfera de baixo para cima
        const onda = Math.max(0, 1 - Math.abs(q.y - Math.sin(t * 0.9) * 0.85) / 0.28);
        const empurrao = 1 + 0.14 * onda;
        return { x: q.x * empurrao, y: q.y, z: q.z * empurrao, brilho: 0.55 + 2.3 * onda };
      }),
      0.42,
    );
  },

  /** Três fios trançam ao redor da esfera: linhas nascendo. */
  escrevendo: (p, t) => {
    const pts: P3[] = [];
    const faixas = 3;
    for (let f = 0; f < faixas; f++) {
      const fase = (f / faixas) * TAU;
      for (let i = 0; i < p.fio; i++) {
        const u = i / p.fio;
        const lon = u * TAU + t * 0.5;
        // Uma volta de seno por fio (não duas): com duas, os três fios se cruzavam no meio e viravam um borrão
        const y = Math.sin(u * TAU + fase) * 0.66;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        // A cabeça de cada fio é mais viva: é o ponto onde a linha está sendo escrita
        const cabeca = Math.max(0, 1 - ((u + 1 - ((t * 0.28) % 1)) % 1) / 0.22);
        pts.push({ x: r * Math.cos(lon), y, z: r * Math.sin(lon), brilho: 0.55 + 2 * cabeca });
      }
    }
    return inclinar(pts, 0.3);
  },

  /**
   * O núcleo solta partículas que se afastam e se apagam: alguma coisa saindo daqui.
   *
   * As partículas saem em RAIOS fixos, cada uma no seu, em vez de espiralarem: espiralando, o desenho virava
   * um emaranhado e não se lia de onde nem para onde nada ia.
   */
  enviando: (p, t) => {
    const pts: P3[] = [];
    const raios = p.orbitaDots;
    const porRaio = 4;
    const dirs = globo(raios, t * 0.2); // direções espalhadas pela esfera, uma por raio
    for (const [r, dir] of dirs.entries()) {
      for (let i = 0; i < porRaio; i++) {
        // Cada partícula segue o SEU raio, reta, do núcleo para fora. Com espiral virava emaranhado e não se
        // lia de onde nem para onde nada estava indo.
        const avanco = (((t * 0.62 + i / porRaio + r * 0.11) % 1) + 1) % 1;
        const d = 0.26 + avanco * 0.95;
        pts.push({ x: dir.x * d, y: dir.y * d, z: dir.z * d, brilho: 2.2 * (1 - avanco) ** 1.5 });
      }
    }
    // O núcleo de onde tudo sai: uma esferinha densa, para o olho achar a origem
    for (const q of globo(Math.round(p.fio * 0.8), -t * 0.6)) {
      pts.push({ x: q.x * 0.2, y: q.y * 0.2, z: q.z * 0.2, brilho: 1.8 });
    }
    return inclinar(pts, 0.3);
  },

  /**
   * Uma constelação se liga, nó a nó, e recomeça.
   *
   * Os nós ficam numa HÉLICE, não na espiral de Fibonacci. Na espiral, dois nós seguidos ficam a 137° um do
   * outro e o fio atravessava a esfera de lado a lado: na tela saía um rabisco. Ordená-los por longitude não
   * bastou — o fio passava a zigue-zaguear na altura. Na hélice ele dá a volta na esfera, que é o que se lê
   * como "ligando uma coisa na outra".
   */
  conectando: (p, t) => {
    // Um globo bem apagado atrás: sem superfície, o fio sozinho lia como rabisco solto no vazio
    const pts: P3[] = globo(Math.round(p.globo * 0.55), t * 0.22).map(q => ({ ...q, brilho: 0.3 }));
    const nos = Math.max(10, Math.round(p.globo / 9));
    const voltas = 2.5;
    const nodo: P3[] = [];
    for (let i = 0; i < nos; i++) {
      const u = i / (nos - 1);
      const y = -0.86 + u * 1.72;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = u * TAU * voltas + t * 0.3;
      nodo.push({ x: r * Math.cos(a), y, z: r * Math.sin(a) });
    }
    const ligados = ((t * 0.42) % 1) * (nos + 1);
    const passos = Math.max(3, Math.round(p.fio / 5));
    for (let i = 0; i < nos; i++) {
      const aceso = Math.max(0, Math.min(1, ligados - i));
      pts.push({ ...nodo[i], brilho: 0.5 + 2.3 * aceso });
      // O fio até o próximo nó, feito de pontos (só arcos, como o resto do desenho)
      const prox = nodo[i + 1];
      if (aceso > 0 && prox) {
        for (let k = 1; k <= passos; k++) {
          const f = (k / (passos + 1)) * aceso;
          pts.push({
            x: nodo[i].x + (prox.x - nodo[i].x) * f,
            y: nodo[i].y + (prox.y - nodo[i].y) * f,
            z: nodo[i].z + (prox.z - nodo[i].z) * f,
            brilho: 0.75,
          });
        }
      }
    }
    return inclinar(pts, 0.35);
  },

  /**
   * Dois anéis perpendiculares que respiram devagar: o robô está parado, esperando você.
   *
   * O segundo anel é girado em Y, não em Z: girar no mesmo plano dava o mesmo círculo por cima do primeiro, e
   * a tela mostrava um anel só.
   */
  esperando: (p, t) => {
    const pts: P3[] = [];
    const n = p.fio + 8;
    const respiro = 0.76 + Math.sin(t * 1.05) * 0.13;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + t * 0.22;
      const c = Math.cos(a) * respiro;
      const s = Math.sin(a) * respiro;
      pts.push({ x: c, y: s, z: 0, brilho: 1.25 }); // anel no plano da tela
      pts.push({ x: 0, y: s, z: c, brilho: 1.25 }); // e o outro atravessando, de perfil
    }
    return inclinar(pts, 0.5);
  },
};

export default function Orbe({ estado = 'pensando', tamanho = 20, rotulo, className = '' }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const p = PRESET[tamanho];
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // além de 2 ninguém vê diferença e a conta dobra
    cv.width = tamanho * dpr;
    cv.height = tamanho * dpr;
    const c = tamanho / 2;
    const R = tamanho * 0.4;

    const parado = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let visivel = true;
    let quadro = 0;
    const inicio = performance.now();

    // A cor vem de `currentColor`, mas `getComputedStyle` força recálculo de estilo: chamá-lo a cada quadro,
    // vezes o número de orbes na tela, é trabalho à toa 60 vezes por segundo. Relido a cada ~1 s, que é de
    // sobra para acompanhar troca de tema ou de contexto.
    let cor = getComputedStyle(cv).color;
    let proximaCor = 0;

    const desenhar = (t: number, agora = 0) => {
      if (agora >= proximaCor) {
        cor = getComputedStyle(cv).color;
        proximaCor = agora + 1000;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, tamanho, tamanho);
      ctx.fillStyle = cor;

      const pts = CENAS[estado](p, t);
      // Do fundo para a frente: ponto da frente cobre o de trás, que é o que dá volume
      pts.sort((a, b) => a.z - b.z);
      for (const q of pts) {
        const prof = (q.z + 1) / 2; // 0 atrás, 1 na frente
        const raio = p.raioPonto * (0.5 + 0.5 * prof);
        const alfa = Math.min(1, (0.16 + 0.62 * prof) * (q.brilho ?? 1));
        if (alfa <= 0.02) continue;
        ctx.globalAlpha = alfa;
        ctx.beginPath();
        ctx.arc(c + q.x * R, c + q.y * R, raio, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    if (parado) {
      desenhar(0.8); // um quadro só, num instante em que a cena está legível
      return;
    }

    const laco = (agora: number) => {
      if (visivel) desenhar(((agora - inicio) / 1000) * p.vel, agora);
      quadro = requestAnimationFrame(laco);
    };
    quadro = requestAnimationFrame(laco);

    // Fora da tela não anima: o painel tem orbe em lugares que ficam abaixo da dobra
    const obs = new IntersectionObserver(([e]) => {
      visivel = e.isIntersecting;
    });
    obs.observe(cv);

    return () => {
      cancelAnimationFrame(quadro);
      obs.disconnect();
    };
  }, [estado, tamanho]);

  return (
    <canvas
      ref={ref}
      width={tamanho}
      height={tamanho}
      style={{ width: tamanho, height: tamanho }}
      className={`shrink-0 ${className}`}
      role={rotulo ? 'img' : undefined}
      aria-label={rotulo}
      aria-hidden={rotulo ? undefined : true}
    />
  );
}
