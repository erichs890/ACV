import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ListOrdered, Radar, TriangleAlert } from 'lucide-react';
import Modal from './Modal';
import Orbe from './Orbe';
import { getPlataforma, textoIntervalo } from '../dados';
import type { PassoDaPlataforma, ProgressoVarredura, Vaga } from '../types';

/**
 * A tela do mapeamento: a varredura de todas as plataformas acontecendo, uma linha por portal.
 *
 * Por que uma tela e não a barrinha que já existia: a barra mostra a plataforma ATUAL, e a pessoa não via o
 * trabalho — sete plataformas varrendo durante minutos, e na tela só "InHire: empresa Tecla T". Aqui cada
 * portal tem a sua linha, com o que ele está fazendo agora e o que trouxe quando termina, e nada desaparece
 * quando a próxima começa.
 *
 * Decisões de desenho que não são enfeite:
 *
 *  - **A animação é o `Orbe`**, o mesmo do resto do app. Inventar um segundo vocabulário de espera deixaria
 *    duas linguagens visuais na mesma aplicação; e o orbe já respeita `prefers-reduced-motion` e pausa fora
 *    da tela, que é trabalho que não vale refazer.
 *  - **Linha que termina não some.** O valor da tela é a soma: ver que o InHire trouxe 40 e o Vagas PJ 84.
 *  - **Total desconhecido é barra indeterminada**, não uma barra fingindo 50%. `total: 0` quer dizer "não sei
 *    quantas páginas isso tem", e mentir sobre isso é pior do que não saber.
 *  - **A tela não fecha sozinha ao terminar.** O fim é justamente o momento de ler o resultado e decidir.
 */
interface Props {
  aberto: boolean;
  onFechar: () => void;
  varredura: ProgressoVarredura;
  fila: Vaga[];
  filaAlvo: number;
  /** Chamado pelo botão do rodapé quando a fila está pronta: liga o robô e fecha. */
  onComecarEnvio: () => void;
}

const ORDEM: Record<PassoDaPlataforma['estado'], number> = { varrendo: 0, pronta: 1, erro: 2, espera: 3 };

export default function TelaDeMapeamento({ aberto, onFechar, varredura, fila, filaAlvo, onComecarEnvio }: Props) {
  const { porPlataforma, rodando, novas, conhecidas, iniciadaEm } = varredura;

  /**
   * Cronômetro próprio, de 1 s.
   *
   * O tempo não pode vir do estado do servidor: o núcleo emite evento quando algo MUDA, e numa plataforma
   * lenta isso é uma vez por página — o relógio ficaria congelado no meio da varredura, parecendo travado.
   */
  const [agora, setAgora] = useState(Date.now());
  useEffect(() => {
    if (!aberto || !rodando) return;
    const t = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [aberto, rodando]);

  const linhas = useMemo(
    () =>
      Object.entries(porPlataforma)
        .map(([id, p]) => ({ id, ...p, nome: getPlataforma(id).nome, cor: getPlataforma(id).cor }))
        .sort((a, b) => ORDEM[a.estado] - ORDEM[b.estado] || a.nome.localeCompare(b.nome, 'pt-BR')),
    [porPlataforma],
  );

  const prontas = linhas.filter(l => l.estado === 'pronta' || l.estado === 'erro').length;
  const decorrido = iniciadaEm ? Math.max(0, Math.round((agora - new Date(iniciadaEm).getTime()) / 1000)) : 0;
  const filaCheia = fila.length >= filaAlvo;

  /**
   * O quanto já andou, de 0 a 1 — a resposta para "quanto falta".
   *
   * Não é só `prontas / total`: com sete portais isso dá uma barra que fica parada minutos e salta de 14% em
   * 14%, e numa plataforma lenta (o InHire abre uma página por empresa) ela pareceria travada. A fração da
   * plataforma ATUAL entra junto, então a barra anda continuamente enquanto há trabalho acontecendo.
   *
   * A plataforma que não sabe o próprio tamanho (`total: 0`) contribui com meia unidade, e não com zero: ela
   * está trabalhando, e marcar zero faria a barra parar justamente onde ela está andando.
   */
  const emCurso = linhas.find(l => l.estado === 'varrendo');
  const fracaoDaAtual = emCurso ? (emCurso.total > 0 ? Math.min(1, emCurso.atual / emCurso.total) : 0.5) : 0;
  const progresso = linhas.length ? Math.min(1, (prontas + fracaoDaAtual) / linhas.length) : 0;
  const novasNaVarredura = novas;

  // Rola para a plataforma que está varrendo: com sete portais a lista passa da altura da tela
  const emFoco = useRef<HTMLLIElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: depende SO da plataforma atual de proposito — rolar a cada mudanca de etapa daria um solavanco por pagina aberta
  useEffect(() => {
    emFoco.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [varredura.plataforma]);

  return (
    <Modal
      aberto={aberto}
      onFechar={onFechar}
      titulo={rodando ? 'Mapeando as suas plataformas' : 'Mapeamento concluído'}
      icon={Radar}
      largo
      rodape={
        <>
          <p role="status" className="flex-1 text-xs text-ink-soft tabular-nums">
            {rodando ? (
              // A contagem de plataformas mora no topo, junto da barra. Repetir aqui com OUTRA conta — as que
              // TERMINARAM, contra a que está em andamento — punha "0 de 6" embaixo e "Varrendo 1 de 6" em
              // cima, na mesma tela. Aqui fica o que o topo não diz: quanto já entrou na fila.
              <>
                {fila.length} na fila · {textoIntervalo(decorrido)} de varredura
              </>
            ) : (
              <>
                {novas} vaga(s) nova(s) · {conhecidas} já conhecida(s) · {textoIntervalo(decorrido)}
              </>
            )}
          </p>
          <button type="button" className="btn btn-secondary" onClick={onFechar}>
            {rodando ? 'Deixar rodando' : 'Fechar'}
          </button>
          {/* Só aparece quando há o que enviar: botão de enviar com a fila vazia é um botão que não faz nada */}
          {!rodando && fila.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={onComecarEnvio}>
              <ListOrdered size={15} aria-hidden />
              Começar a enviar ({fila.length})
            </button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* A barra geral, antes de tudo: "quanto falta" é a primeira pergunta de quem abre esta tela.
            Ela anda continuamente porque inclui a fração da plataforma atual — contar só as que terminaram
            daria uma barra parada por minutos, saltando de uma plataforma em uma plataforma. */}
        <div className="rounded-lg border border-panel-border bg-page-bg px-3.5 py-3">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <p className="text-sm font-bold">
              {rodando ? (
                <>
                  Varrendo {prontas + 1 > linhas.length ? linhas.length : prontas + 1} de {linhas.length} plataformas
                </>
              ) : (
                <>Varredura concluída — {linhas.length} plataformas</>
              )}
            </p>
            <span className="text-xs text-ink-soft tabular-nums">
              {Math.round(progresso * 100)}% · {textoIntervalo(decorrido)}
            </span>
            {rodando && emCurso && (
              <span className="truncate text-xs text-blue-dark">
                {emCurso.nome}: {emCurso.etapa || 'começando'}
              </span>
            )}
            {/* Só aparece quando há o que contar: "+0" enquanto a primeira plataforma ainda varre parece erro,
                e o número só sobe quando cada uma TERMINA (é ela que reporta o que trouxe). */}
            {novasNaVarredura > 0 && <span className="ml-auto text-xs font-bold text-green-deep tabular-nums">+{novasNaVarredura} nesta varredura</span>}
          </div>
          <div
            className="mt-2 h-2.5 overflow-hidden rounded-full bg-panel-border"
            role="progressbar"
            aria-valuenow={Math.round(progresso * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Andamento da varredura"
          >
            <div className={`h-full rounded-full transition-[width] duration-500 ${rodando ? 'bg-blue-dark' : 'bg-green-deep'}`} style={{ width: `${Math.max(2, progresso * 100)}%` }} />
          </div>
          <p className="mt-1.5 text-[11px] text-ink-soft">
            {rodando
              ? 'São as plataformas que você conectou em Plataformas. Cada uma é varrida inteira antes da próxima; as que terminam ficam na lista com o que trouxeram.'
              : `${conhecidas} vaga(s) já estavam no banco e não entraram de novo. As compatíveis já foram para a fila automaticamente.`}
          </p>
        </div>

        {/* O estado da fila, que é o objetivo de tudo isto: o mapeamento existe para a fila ficar no ponto */}
        <div className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 ${filaCheia ? 'border-green-deep bg-green-deep/10' : 'border-panel-border bg-page-bg'}`}>
          <Orbe estado={rodando ? 'procurando' : filaCheia ? 'pensando' : 'esperando'} tamanho={64} rotulo={rodando ? 'Varrendo as plataformas' : 'Mapeamento concluído'} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">
              Fila com {fila.length} de {filaAlvo} vagas
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              {rodando
                ? 'A fila se forma enquanto a varredura roda — você pode revisar e tirar o que não quiser antes de enviar.'
                : filaCheia
                  ? 'Fila no ponto. Revise e clique em começar a enviar.'
                  : fila.length > 0
                    ? 'A fila não encheu até o alvo: ou não há mais vagas compatíveis, ou o limite diário está apertando. O log diz qual dos dois.'
                    : 'Nenhuma vaga entrou na fila. Veja o log: pode ser nota mínima, nicho a evitar, ou plataforma fora do foco.'}
            </p>
          </div>
          <div className="h-2 w-28 shrink-0 overflow-hidden rounded-full bg-panel-border" role="progressbar" aria-valuenow={fila.length} aria-valuemin={0} aria-valuemax={filaAlvo}>
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${filaCheia ? 'bg-green-deep' : 'bg-blue-dark'}`}
              style={{ width: `${Math.min(100, (fila.length / Math.max(1, filaAlvo)) * 100)}%` }}
            />
          </div>
        </div>

        <ol aria-label="Plataformas sendo varridas" className="flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto">
          {linhas.map(l => (
            <li
              key={l.id}
              ref={l.estado === 'varrendo' ? emFoco : undefined}
              className={`flex items-center gap-3 rounded-[7px] border px-3 py-2.5 transition-colors ${
                l.estado === 'varrendo' ? 'border-blue-dark bg-blue-dark/5' : l.estado === 'erro' ? 'border-orange-deep/60 bg-orange-deep/5' : 'border-panel-border'
              }`}
            >
              <span className={`inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-[11px] font-bold text-white ${l.cor}`} aria-hidden>
                {l.nome.slice(0, 2)}
              </span>

              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[13px] font-bold">
                  {l.nome}
                  {l.estado === 'pronta' && <CheckCircle2 size={13} className="text-green-deep" aria-hidden />}
                  {l.estado === 'erro' && <TriangleAlert size={13} className="text-orange-deep" aria-hidden />}
                </p>
                <p className="truncate text-[11px] text-ink-soft">
                  {l.estado === 'espera' && 'na fila para varrer'}
                  {l.estado === 'varrendo' && (l.etapa || 'começando')}
                  {l.estado === 'pronta' && (
                    <>
                      {l.novas} nova(s)
                      {l.conhecidas > 0 && ` · ${l.conhecidas} já conhecida(s)`}
                      {l.duracaoMs !== undefined && ` · ${textoIntervalo(Math.round(l.duracaoMs / 1000))}`}
                    </>
                  )}
                  {l.estado === 'erro' && <span className="text-orange-deep">{l.erro ?? 'falhou'}</span>}
                </p>

                {/* Barra só enquanto varre. `total: 0` = não sei o tamanho: barra indeterminada, nunca um
                    número inventado. */}
                {l.estado === 'varrendo' && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel-border">
                    {l.total > 0 ? (
                      <div className="h-full rounded-full bg-blue-dark transition-[width] duration-300" style={{ width: `${Math.min(100, (l.atual / l.total) * 100)}%` }} />
                    ) : (
                      <div className="h-full w-1/3 animate-[indeterminada_1.4s_ease-in-out_infinite] rounded-full bg-blue-dark" />
                    )}
                  </div>
                )}
              </div>

              <div className="w-16 shrink-0 text-right">
                {l.estado === 'varrendo' ? (
                  <Orbe estado="procurando" tamanho={20} rotulo={`Varrendo ${l.nome}`} />
                ) : l.estado === 'pronta' ? (
                  <span className="text-lg font-bold text-green-deep tabular-nums">+{l.novas}</span>
                ) : l.estado === 'erro' ? (
                  <span className="text-[11px] font-bold text-orange-deep">erro</span>
                ) : (
                  <span className="text-[11px] text-ink-soft">aguarda</span>
                )}
                {l.estado === 'varrendo' && l.total > 0 && (
                  <span className="block text-[10px] text-ink-soft tabular-nums">
                    {l.atual}/{l.total}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  );
}
