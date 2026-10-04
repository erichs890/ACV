// Orbe de espera da extensão — o mesmo desenho de src/components/Orbe.tsx, em JS puro.
//
// O miolo (PRESET, `globo`, `inclinar` e as sete CENAS) é cópia literal do componente do app, só sem os
// tipos. Foi afinado no olho, estado por estado, e reescrever convidaria a divergir: o orbe da extensão tem
// de ser o MESMO que a pessoa vê no ACV, senão a linguagem de espera se parte em duas.
//
// Diferenças de propósito em relação ao React:
//  - `estado(novo)` troca a cena SEM recriar o canvas nem reiniciar o laço. No app o `useEffect` remonta a
//    cada troca; aqui o painel passa por `conectando -> escrevendo -> enviando` numa candidatura só, e
//    reiniciar a cada passo mataria a sensação de continuidade.
//  - `destruir()` é obrigatório no caminho de desmontagem: site de vaga é aplicativo de uma página só e o
//    painel remonta. Sem isso fica um requestAnimationFrame rodando sobre um canvas órfão por aba navegada.
//  - `documento` é parâmetro porque o canvas precisa nascer do document certo quando vive num shadow root.
(() => {
  const TAU = Math.PI * 2;

  /** Quanto cada tamanho pede de pontos e de velocidade. Ajustado no olho, um de cada vez. */
  const PRESET = {
    20: { globo: 46, fio: 16, orbitaDots: 6, raioPonto: 0.85, vel: 1.15 },
    64: { globo: 150, fio: 34, orbitaDots: 13, raioPonto: 1.35, vel: 1 },
  };

  /** Ângulo áureo: é ele que espalha os pontos sem formar fileira. */
  const AUREO = Math.PI * (3 - Math.sqrt(5));

  /**
   * Esfera de pontos pela espiral de Fibonacci — a base de quase todos os estados.
   *
   * A primeira versão usava anéis de latitude e o resultado, na tela, era uma GRADE: as fileiras se alinhavam e
   * a esfera virava um retângulo de pontos. A espiral distribui sem fileira nenhuma e lê como volume no primeiro
   * olhar, que é o ponto do desenho.
   */
  function globo(n, giro) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = i * AUREO + giro;
      pts.push({ x: r * Math.cos(a), y, z: r * Math.sin(a) });
    }
    return pts;
  }

  /** Inclina a cena no eixo X. Sem isto o polo fica de frente e a esfera parece um disco. */
  function inclinar(pts, ang) {
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
  const distAngular = (a, b) => {
    const d = Math.abs(((a - b) % TAU) + TAU) % TAU;
    return d > Math.PI ? TAU - d : d;
  };

  const CENAS = {
    /**
     * Partículas em órbitas inclinadas, como um átomo pensando.
     *
     * As inclinações são escolhidas a dedo, não calculadas: a primeira versão as espaçava por fórmula e as três
     * caíram quase no mesmo plano — na tela virou uma faixa horizontal, não um átomo.
     */
    pensando: (p, t) => {
      const pts = [];
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
      const pts = [];
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
      const pts = [];
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
      const pts = globo(Math.round(p.globo * 0.55), t * 0.22).map(q => ({ ...q, brilho: 0.3 }));
      const nos = Math.max(10, Math.round(p.globo / 9));
      const voltas = 2.5;
      const nodo = [];
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
      const pts = [];
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

  /**
   * Cria o orbe. Devolve o canvas pronto, mais `estado()` e `destruir()`.
   *
   * `prefers-reduced-motion` desenha UM quadro (em t=0.8, onde toda cena está legível) e não liga o laço.
   * Fora da tela o laço pausa por IntersectionObserver — no painel isso serve para quando ele está recolhido.
   */
  function criar({ estado = 'pensando', tamanho = 20, rotulo = '', documento = document } = {}) {
    const p = PRESET[tamanho] ?? PRESET[20];
    const cv = documento.createElement('canvas');
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2); // além de 2 ninguém vê e a conta dobra
    cv.width = tamanho * dpr;
    cv.height = tamanho * dpr;
    cv.style.width = `${tamanho}px`;
    cv.style.height = `${tamanho}px`;
    cv.style.flexShrink = '0';
    if (rotulo) {
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', rotulo);
    } else {
      cv.setAttribute('aria-hidden', 'true');
    }

    const ctx = cv.getContext('2d');
    const c = tamanho / 2;
    const R = tamanho * 0.4;
    let cena = CENAS[estado] ? estado : 'pensando';
    let quadro = 0;
    let visivel = true;
    let vivo = true;
    const inicio = performance.now();

    // `getComputedStyle` força recálculo de estilo: a cada quadro, vezes o número de orbes na tela, é
    // trabalho à toa 60 vezes por segundo. Relido a cada ~1 s, de sobra para acompanhar o contexto.
    let cor = '#333';
    let proximaCor = 0;

    const desenhar = (t, agora = 0) => {
      if (!ctx) return;
      if (agora >= proximaCor) {
        cor = getComputedStyle(cv).color || cor;
        proximaCor = agora + 1000;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, tamanho, tamanho);
      ctx.fillStyle = cor;
      const pts = CENAS[cena](p, t);
      pts.sort((a, b) => a.z - b.z); // do fundo para a frente: é o que dá volume
      for (const q of pts) {
        const prof = (q.z + 1) / 2;
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

    const parado = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let obs = null;
    if (parado) {
      desenhar(0.8);
    } else {
      const laco = agora => {
        if (!vivo) return;
        if (visivel) desenhar(((agora - inicio) / 1000) * p.vel, agora);
        quadro = requestAnimationFrame(laco);
      };
      quadro = requestAnimationFrame(laco);
      obs = new IntersectionObserver(([e]) => {
        visivel = e.isIntersecting;
      });
      obs.observe(cv);
    }

    return {
      el: cv,
      estado(novo) {
        if (CENAS[novo]) cena = novo;
      },
      destruir() {
        vivo = false;
        cancelAnimationFrame(quadro);
        obs?.disconnect();
      },
    };
  }

  const api = { criar, ESTADOS: Object.keys(CENAS) };
  globalThis.ACVOrbe = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
