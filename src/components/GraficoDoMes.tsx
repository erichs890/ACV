import { useMemo, useRef, useState } from 'react';
import type { Envio } from '../types';

/**
 * Currículos enviados no mês, acumulado, dia por dia.
 *
 * Acumulado e não por dia porque a pergunta é "quanto eu já mandei neste mês": a linha só sobe, e o número
 * grande no canto é a resposta. No dia 1 ela volta para zero sozinha — o recorte é o mês corrente, não uma
 * janela de 30 dias, então virar o mês zera de verdade.
 *
 * Conta só envio REAL: ensaio preenche o formulário e não envia, e contá-lo aqui seria inflar o número que a
 * pessoa usa para saber se está se candidatando o bastante.
 *
 * O desenho é SVG puro (nenhuma biblioteca nova): `pathLength` normaliza o traço para 1, então a animação de
 * desenho é um `stroke-dashoffset` de 1 → 0, independente do tamanho do caminho.
 */
export default function GraficoDoMes({ envios }: { envios: Envio[] }) {
  const { pontos, total, diasNoMes, hoje, mes, pico } = useMemo(() => calcular(envios), [envios]);
  const [ativo, setAtivo] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const L = 100; // largura em unidades de viewBox
  const A = 34; // altura útil da curva
  const teto = Math.max(pico, 1);
  const x = (dia: number) => ((dia - 1) / Math.max(diasNoMes - 1, 1)) * L;
  const y = (v: number) => A - (v / teto) * (A - 3);

  const visiveis = pontos.slice(0, hoje);
  const linha = visiveis.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.dia).toFixed(2)},${y(p.acumulado).toFixed(2)}`).join(' ');
  const area = visiveis.length > 1 ? `${linha} L${x(visiveis[visiveis.length - 1].dia).toFixed(2)},${A} L${x(1).toFixed(2)},${A} Z` : '';
  const ultimo = visiveis[visiveis.length - 1];

  const ondeEstaOMouse = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    setAtivo(Math.min(Math.round(frac * (diasNoMes - 1)), hoje - 1));
  };

  const p = ativo === null ? null : visiveis[ativo];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-end justify-between gap-3">
        <p className="flex items-baseline gap-1.5">
          <span className="text-[26px] font-bold leading-none tabular-nums text-blue-dark">{total}</span>
          <span className="text-[11px] text-ink-soft">
            {total === 1 ? 'currículo enviado' : 'currículos enviados'} em {mes}
          </span>
        </p>
        <p className="text-right text-[11px] text-ink-soft tabular-nums">
          {p ? (
            <>
              dia {p.dia} · <strong className="text-ink">{p.acumulado}</strong> no acumulado
              {p.doDia > 0 && <> · {p.doDia} neste dia</>}
            </>
          ) : (
            <>média de {(total / hoje).toFixed(1).replace('.', ',')} por dia</>
          )}
        </p>
      </div>

      {/*
        O SVG estica sem manter proporção (`preserveAspectRatio="none"`), que é o que faz a curva ocupar a
        caixa inteira em qualquer largura. O preço é que círculo desenhado aqui dentro vira elipse — por isso
        os pontos são <div> posicionados por porcentagem, por cima: redondos em qualquer tamanho de tela.

        `key={mes}` faz a linha se redesenhar do zero quando o mês vira — que é o momento em que ela zera.
      */}
      <div className="relative min-h-0 flex-1">
        <svg
          ref={svgRef}
          key={mes}
          viewBox={`0 0 ${L} ${A}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`${total} currículos enviados em ${mes}, acumulado por dia`}
          onMouseMove={ondeEstaOMouse}
          onMouseLeave={() => setAtivo(null)}
        >
          <title>{`${total} currículos enviados em ${mes}`}</title>
          <defs>
            <linearGradient id="grafico-mes-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-blue-dark)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--color-blue-dark)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Três linhas de base, bem apagadas: dão a altura sem competir com a curva */}
          {[0, 0.5, 1].map(f => (
            <line key={f} x1="0" x2={L} y1={y(teto * f)} y2={y(teto * f)} stroke="var(--color-panel-border)" strokeWidth="0.15" strokeDasharray="1 2" vectorEffect="non-scaling-stroke" />
          ))}

          {area && <path d={area} fill="url(#grafico-mes-area)" className="grafico-mes-area" />}
          {visiveis.length > 1 && (
            <path
              d={linha}
              fill="none"
              stroke="var(--color-blue-dark)"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pathLength={1}
              className="grafico-mes-linha"
            />
          )}

          {p && p !== ultimo && (
            <line x1={x(p.dia)} x2={x(p.dia)} y1={y(p.acumulado)} y2={A} stroke="var(--color-blue-dark)" strokeWidth="0.1" strokeDasharray="1 1.5" vectorEffect="non-scaling-stroke" />
          )}
        </svg>

        {/* A ponta de hoje respira devagar: o único enfeite, e ele diz "ainda está acontecendo" */}
        {ultimo && <Ponto esq={x(ultimo.dia) / L} topo={y(ultimo.acumulado) / A} pulsa />}
        {p && p !== ultimo && <Ponto esq={x(p.dia) / L} topo={y(p.acumulado) / A} />}
      </div>

      <div className="flex justify-between text-[10px] text-ink-soft tabular-nums">
        <span>1</span>
        <span>{Math.round(diasNoMes / 2)}</span>
        <span>{diasNoMes}</span>
      </div>
    </div>
  );
}

/** Ponto sobre a curva, em HTML para não ser esticado junto com o SVG. `esq`/`topo` são frações de 0 a 1. */
function Ponto({ esq, topo, pulsa = false }: { esq: number; topo: number; pulsa?: boolean }) {
  return (
    <span aria-hidden className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${esq * 100}%`, top: `${topo * 100}%` }}>
      {pulsa && <span className="grafico-mes-pulso absolute left-1/2 top-1/2 block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-dark/25" />}
      <span className="relative block h-[7px] w-[7px] rounded-full bg-blue-dark ring-2 ring-panel" />
    </span>
  );
}

/** Acumulado por dia do mês corrente. `hoje` é quantos dias já correram (a linha para aí, não no fim do mês). */
function calcular(envios: Envio[]) {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mesN = agora.getMonth();
  const diasNoMes = new Date(ano, mesN + 1, 0).getDate();

  const porDia = new Array<number>(diasNoMes).fill(0);
  for (const e of envios) {
    if (e.status !== 'Enviado') continue; // ensaio não é candidatura
    const d = new Date(e.enviadaEm);
    if (Number.isNaN(d.getTime()) || d.getFullYear() !== ano || d.getMonth() !== mesN) continue;
    porDia[d.getDate() - 1]++;
  }

  let soma = 0;
  const pontos = porDia.map((doDia, i) => {
    soma += doDia;
    return { dia: i + 1, doDia, acumulado: soma };
  });

  return {
    pontos,
    total: soma,
    diasNoMes,
    hoje: agora.getDate(),
    mes: agora.toLocaleDateString('pt-BR', { month: 'long' }),
    pico: soma,
  };
}
