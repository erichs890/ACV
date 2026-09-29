import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Bot, CheckCircle2, Clock, FileText, ListOrdered, Pause, Play, Plug, RadarIcon, Send, Table, Target, TrendingUp } from 'lucide-react';
import Panel from '../components/Panel';
import Badge from '../components/Badge';
import StatCard from '../components/StatCard';
import BarChart from '../components/BarChart';
import EtiquetaStatus from '../components/EtiquetaStatus';
import GraficoDoMes from '../components/GraficoDoMes';
import { useEstado } from '../estado';
import { post } from '../api';
import { enviosDoMes, getPlataforma, plataformaNoFoco, tempoAtras } from '../dados';

const POR_PAGINA = 10;
const pg = 'flex h-6 w-[26px] items-center justify-center rounded border text-xs font-bold tabular-nums aria-disabled:cursor-not-allowed aria-disabled:opacity-40';
const dataCurta = (d: Date) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

export default function Painel() {
  const { estado } = useEstado();
  const [pagina, setPagina] = useState(1);
  const { envios, fila, vagas, automacao, robo } = estado;

  if (!automacao.configurada) return <PrimeirosPassos />;

  const hoje = dataCurta(new Date());
  const abertas = vagas.filter(v => v.status !== 'encerrada');
  // Conta só as plataformas no foco da automação: senão o número aqui briga com a lista da Automação
  const compativeis = abertas.filter(v => v.status !== 'ignorada' && plataformaNoFoco(estado.conexoes, v.plataforma)).length;
  const foraDoFoco = abertas.filter(v => !plataformaNoFoco(estado.conexoes, v.plataforma)).length;
  const empresasAtivas = estado.empresas.filter(e => e.ativo).length;
  const serie = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 6 + i);
    return {
      rotulo: d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''),
      valor: envios.filter(e => e.data === dataCurta(d)).length,
    };
  });
  // Só envio real: ensaio preenche o formulário e não manda nada, e contá-lo aqui inflaria o número que você
  // usa para saber se está se candidatando o bastante.
  // Ensaio preenche o formulário e não manda nada: contá-lo como candidatura faria a tela mentir para você,
  // e era o que acontecia — o topo dizia 138 enquanto o gráfico do mês dizia 125.
  const enviados = envios.filter(e => e.status === 'Enviado');
  const ensaios = envios.length - enviados.length;
  const enviadosNoMes = enviosDoMes(envios).length;
  const paginas = Math.max(1, Math.ceil(envios.length / POR_PAGINA));
  const visiveis = envios.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
  const irPara = (p: number) => p >= 1 && p <= paginas && setPagina(p);

  return (
    <div className="stagger flex flex-col gap-4 max-md:gap-2.5">
      <section aria-label="Resumo" className="grid grid-cols-4 gap-4 max-md:grid-cols-2 max-md:gap-2.5">
        <StatCard icon={Send} tom="bg-blue-dark" valor={enviados.length} label="Candidaturas" nota={ensaios > 0 ? `${ensaios} ensaio(s) não contam: preenchem sem enviar` : undefined} />
        <StatCard icon={Clock} tom="bg-green-dark" valor={enviados.filter(e => e.data === hoje).length} label="Envios hoje" />
        <StatCard icon={ListOrdered} tom="bg-orange" valor={fila.length} label="Vagas na fila" />
        <StatCard
          icon={Target}
          tom="bg-purple"
          valor={compativeis}
          label="Vagas compatíveis"
          nota={foraDoFoco ? `${abertas.length} ativas · ${foraDoFoco} fora do foco` : `${abertas.length} vagas ativas no total`}
        />
      </section>
      <p className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-soft max-md:-mt-1">
        <span className="inline-flex items-center gap-1">
          <RadarIcon size={12} aria-hidden />
          Última varredura {tempoAtras(estado.descoberta.ultimaVarredura)}
          {estado.descoberta.varrendo && ' (em andamento)'}
        </span>
        <span>· {empresasAtivas} empresas monitoradas</span>
        <span>· {abertas.length} vagas ativas</span>
        <span>· próxima a cada {estado.descoberta.intervaloHoras} h</span>
      </p>

      <div className="grid h-[380px] grid-cols-[1fr_330px] gap-4 max-lg:grid-cols-[1fr_300px] max-md:h-auto max-md:grid-cols-1">
        <Panel icon={Activity} title="Atividade do Robô" className="max-md:hidden" bodyClassName="flex flex-col gap-2.5 p-3.5">
          <p className="text-xs text-ink-soft">Candidaturas por dia — últimos 7 dias</p>
          {envios.length === 0 ? (
            <Vazio texto="Nenhuma candidatura ainda. Quando o robô começar a enviar, o gráfico aparece aqui." />
          ) : (
            <BarChart dados={serie} legenda="Candidaturas por dia — últimos 7 dias" />
          )}
        </Panel>

        <Panel icon={ListOrdered} title="Fila do robô" tone="green" bodyClassName="flex flex-col gap-2.5 p-3">
          {fila.length === 0 ? (
            <Vazio texto={automacao.modo === 'manual' ? 'Nada na fila. Em modo manual, escolha as vagas em Automação.' : 'Nada na fila. Ligue o robô para ele buscar vagas compatíveis.'} />
          ) : (
            <ol aria-label="Próximos envios" className="flex flex-col gap-1.5">
              {fila.slice(0, 4).map(v => (
                <li key={v.id} className="flex items-center gap-2 rounded-md border border-panel-border px-[9px] py-[7px]">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold">{v.titulo}</p>
                    <p className="text-[11px] text-ink-soft">{v.empresa}</p>
                  </div>
                  <EtiquetaStatus status={v.status} />
                </li>
              ))}
            </ol>
          )}
          <div className="mt-auto grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-danger" disabled={robo !== 'ativo'} onClick={() => post('/robo', { ligar: false })}>
              <Pause size={16} aria-hidden />
              Pausar
            </button>
            <button type="button" className="btn btn-success" disabled={robo === 'ativo'} onClick={() => post('/robo', { ligar: true })}>
              <Play size={16} aria-hidden />
              Ligar
            </button>
          </div>
        </Panel>
      </div>

      <Panel icon={TrendingUp} title="Currículos enviados no mês" className="h-[215px] max-md:h-[190px]" bodyClassName="flex flex-col gap-1.5 p-3.5">
        {enviadosNoMes === 0 ? <Vazio texto="Nenhum currículo enviado neste mês ainda. A linha começa a subir no primeiro envio e zera sozinha no dia 1º." /> : <GraficoDoMes envios={envios} />}
      </Panel>

      <Panel icon={Table} title="Últimas candidaturas" tone="slate" aside={envios.length > 0 ? `${envios.length} no total` : undefined} bodyClassName="">
        {envios.length === 0 ? (
          <div className="p-6">
            <Vazio texto="Nenhuma candidatura enviada ainda. Busque vagas em Automação e ligue o robô para começar." />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto max-md:hidden">
              <table className="w-full min-w-[860px] border-collapse text-left text-xs">
                <thead className="text-[11px]">
                  <tr className="h-[30px] border-b border-panel-border">
                    <th scope="col" className="px-3.5 font-bold">
                      Vaga
                    </th>
                    <th scope="col" className="w-[200px] font-bold">
                      Empresa
                    </th>
                    <th scope="col" className="w-[190px] font-bold">
                      Plataforma
                    </th>
                    <th scope="col" className="w-[150px] font-bold">
                      Data / Hora
                    </th>
                    <th scope="col" className="w-[144px] pr-3.5 font-bold">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map(e => {
                    const p = getPlataforma(e.plataforma);
                    return (
                      <tr key={e.id} className="h-[38px] border-b border-panel-border/60 last:border-0">
                        <td className="px-3.5 font-bold text-blue-dark">{e.vaga}</td>
                        <td>{e.empresa}</td>
                        <td>
                          <span className="flex items-center gap-[7px]">
                            <span aria-hidden className={`flex size-5 items-center justify-center rounded-[5px] text-[10px] font-bold text-white ${p.cor}`}>
                              {p.sigla}
                            </span>
                            {p.nome}
                          </span>
                        </td>
                        <td className="text-ink-soft tabular-nums">
                          {e.data} {e.hora}
                        </td>
                        <td className="pr-3.5">
                          <Badge status={e.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <ul className="hidden flex-col gap-2 p-2.5 max-md:flex">
              {visiveis.map(e => (
                <li key={e.id} className="rounded-[7px] border border-panel-border p-[9px]">
                  <p className="text-[13px] font-bold text-blue-dark">{e.vaga}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <p className="flex-1 text-[11px] text-ink-soft tabular-nums">
                      {e.empresa} • {getPlataforma(e.plataforma).nome} • {e.hora}
                    </p>
                    <Badge status={e.status} />
                  </div>
                </li>
              ))}
            </ul>

            {paginas > 1 && (
              <nav aria-label="Paginação" className="flex h-[42px] items-center gap-[5px] border-t border-panel-border px-3.5 max-md:hidden">
                <p className="mr-auto text-[11px] text-ink-soft tabular-nums">
                  Mostrando {(pagina - 1) * POR_PAGINA + 1}–{(pagina - 1) * POR_PAGINA + visiveis.length} de {envios.length}
                </p>
                <button type="button" aria-label="Página anterior" aria-disabled={pagina === 1} onClick={() => irPara(pagina - 1)} className={`${pg} border-panel-border bg-panel hover:bg-page-bg`}>
                  «
                </button>
                {Array.from({ length: paginas }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    type="button"
                    aria-label={`Página ${p}`}
                    aria-current={p === pagina ? 'page' : undefined}
                    onClick={() => irPara(p)}
                    className={`${pg} ${p === pagina ? 'border-blue-dark bg-blue-dark text-white' : 'border-panel-border bg-panel hover:bg-page-bg'}`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Próxima página"
                  aria-disabled={pagina === paginas}
                  onClick={() => irPara(pagina + 1)}
                  className={`${pg} border-panel-border bg-panel hover:bg-page-bg`}
                >
                  »
                </button>
              </nav>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

function Vazio({ texto }: { texto: string }) {
  return <p className="flex flex-1 items-center justify-center p-4 text-center text-xs text-ink-soft">{texto}</p>;
}

function PrimeirosPassos() {
  const { estado } = useEstado();
  const passos = [
    { icon: FileText, texto: 'Envie seu currículo em PDF', pronto: estado.curriculos.some(c => c.perfilBusca), to: '/curriculo', acao: 'Ver currículo' },
    { icon: Plug, texto: 'Conecte o InHire e escolha as empresas', pronto: Object.keys(estado.conexoes).length > 0, to: '/plataformas', acao: 'Conectar' },
    { icon: Play, texto: 'Configure e ligue o robô', pronto: estado.automacao.configurada, to: '/automacao', acao: 'Configurar' },
  ];

  return (
    <div className="stagger flex min-h-full items-center justify-center p-[22px] max-md:p-0">
      <section aria-labelledby="passos-titulo" className="flex w-[620px] max-w-full flex-col items-center gap-3.5 rounded-xl border border-panel-border bg-panel p-9 text-center max-md:p-5">
        <span className="flex size-24 items-center justify-center rounded-full bg-blue-dark text-white">
          <Bot size={44} aria-hidden />
        </span>
        <h2 id="passos-titulo" className="text-[22px] font-bold">
          Falta pouco, {estado.perfil?.nome.split(' ')[0]}
        </h2>
        <p className="text-sm text-ink-soft">Conecte o InHire e configure a automação para o robô começar a buscar vagas e enviar seu currículo.</p>
        <ol className="flex w-full flex-col gap-2.5">
          {passos.map(({ icon: Icon, texto, pronto, to, acao }) => (
            <li key={texto} className="flex items-center gap-3 rounded-lg border border-panel-border p-3 text-left">
              <span className={`flex size-[34px] shrink-0 items-center justify-center rounded-[9px] ${pronto ? 'bg-green-deep text-white' : 'border border-panel-border bg-page-bg'}`}>
                {pronto ? <CheckCircle2 size={18} aria-hidden /> : <Icon size={16} aria-hidden />}
              </span>
              <span className="flex-1 text-[13px] font-bold">{texto}</span>
              {pronto ? (
                <span className="text-[11px] font-bold text-green-deep">Pronto</span>
              ) : (
                <Link to={to} className="btn btn-primary btn-sm">
                  {acao}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
