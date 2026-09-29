import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  CircleCheck,
  ExternalLink,
  FileDown,
  FileText,
  Hourglass,
  ListOrdered,
  MessageCircleQuestion,
  Pause,
  Play,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  Target,
  Terminal,
  X,
} from 'lucide-react';
import type { LinhaLog, ProgressoVarredura, Vaga } from '../types';
import Panel from '../components/Panel';
import Orbe from '../components/Orbe';
import EtiquetaStatus from '../components/EtiquetaStatus';
import VerMais from '../components/VerMais';
import { BotaoSalvar } from '../components/BotaoSalvar';
import Modal from '../components/Modal';
import { statusRobo } from '../components/Sidebar';
import { useEstado, type ConfigAutomacao } from '../estado';
import { post, urlArquivo } from '../api';
import { MODELO, PLATAFORMAS, REGIMES, plataformaNoFoco, REGIME_VAGA, formatarTamanho, getPlataforma, perguntaSoDestaVaga, textoIntervalo } from '../dados';

const titulos = { ativo: 'Robô ligado', pausado: 'Robô parado', erro: 'Robô com erro' };
const coresLog: Record<LinhaLog['tipo'], string> = { sucesso: 'text-aqua', info: 'text-white/85', aguardo: 'text-amber', erro: 'text-orange-light', alerta: 'text-amber' };

const alternar = (lista: string[], v: string) => (lista.includes(v) ? lista.filter(x => x !== v) : [...lista, v]);
const cartao = 'rounded-[7px] border border-panel-border hover:border-ink-soft has-checked:border-blue-dark has-checked:ring-1 has-checked:ring-blue-dark';

// Espera entre uma candidatura e a próxima. Abaixo de 1 min serve para testar e para fila curta; em envio
// real, ritmo muito rápido é o que chama a atenção do antibot da plataforma.
const INTERVALOS: [number, string][] = [
  [10, 'A cada 10 segundos'],
  [30, 'A cada 30 segundos'],
  [60, 'A cada 1 minuto'],
  [180, 'A cada 3 minutos'],
  [600, 'A cada 10 minutos'],
  [1800, 'A cada 30 minutos'],
];

/**
 * O valor gravado SEMPRE precisa existir como opção. Um `<select>` com valor fora da lista mostra a primeira
 * opção enquanto o estado continua no valor antigo: o usuário vê "10 segundos", salva, e grava o de antes —
 * foi o que aconteceu com os 480 s vindos da migração de minutos para segundos.
 */
function opcoesIntervalo(atual: number): [number, string][] {
  if (INTERVALOS.some(([s]) => s === atual)) return INTERVALOS;
  return [[atual, `A cada ${textoIntervalo(atual)} (atual)`], ...INTERVALOS];
}

const MODOS_PERGUNTA: { id: ConfigAutomacao['modoPerguntas']; curto: string; titulo: string; texto: string; etiqueta?: string; precisaIA?: boolean }[] = [
  {
    id: 'manual',
    curto: 'Eu respondo',
    titulo: 'Padrão — eu respondo as perguntas novas',
    texto: 'Quando uma empresa faz uma pergunta que você ainda não respondeu, o robô pausa só aquela vaga e espera você digitar. A fila continua com as outras.',
  },
  {
    id: 'duvida',
    curto: 'Só na dúvida',
    titulo: 'Só na dúvida — a IA resolve o que dá e me chama no resto',
    precisaIA: true,
    texto:
      'Pergunta técnica com resposta certa ("qual padrão trata falhas transitórias?") a IA responde sozinha. Ela só devolve para você o que depende de você: conhecimento que o seu currículo não mostra (você pode ter e não ter escrito) e dado pessoal.',
  },
  {
    id: 'sem_piedade',
    curto: 'Sem Piedade',
    titulo: 'Sem Piedade — a IA responde e não para',
    precisaIA: true,
    etiqueta: 'envio 100% automático',
    texto:
      'A IA responde TODAS as perguntas e nunca para para perguntar. O que o currículo não sustenta vira "ainda estou aprendendo" em vez de voltar para você. Nada é inventado, mas ninguém confere antes de enviar.',
  },
];

export default function Automacao() {
  const { estado, salvar, registrar } = useEstado();
  const [cfg, setCfg] = useState<ConfigAutomacao>(estado.automacao);
  const [base, setBase] = useState<ConfigAutomacao>(estado.automacao); // última configuração vinda do núcleo
  const sujo = JSON.stringify(cfg) !== JSON.stringify(base);
  useEffect(() => {
    // Configuração mudou no núcleo (outra aba, pendência que fixou o regime...): acompanha se não houver rascunho
    if (JSON.stringify(estado.automacao) === JSON.stringify(base)) return;
    setBase(estado.automacao);
    if (!sujo) setCfg(estado.automacao);
  }, [estado.automacao, sujo, base]); // eslint-disable-line react-hooks/exhaustive-deps
  const [buscando, setBuscando] = useState(false);
  const [salvoEm, setSalvoEm] = useState(0);
  const [reavaliando, setReavaliando] = useState(false); // marca de tempo do ultimo salvamento, para o "Salvo!" do botao
  const [adaptacaoDe, setAdaptacaoDe] = useState<string | null>(null); // vaga cujo currículo adaptado está aberto
  const [mostrarIgnoradas, setMostrarIgnoradas] = useState(false);
  const [mostrarEnviadas, setMostrarEnviadas] = useState(false);
  const [mostrarForaDoFoco, setMostrarForaDoFoco] = useState(false);
  const set = (mudanca: Partial<ConfigAutomacao>) => setCfg(c => ({ ...c, ...mudanca }));

  const conectadas = PLATAFORMAS.filter(p => estado.conexoes[p.id]);
  const empresasAtivas = estado.empresas.filter(e => e.ativo).length;
  const ativo = estado.robo === 'ativo';
  // Perguntas postas em espera nesta sessão: a vaga continua pendente no núcleo, só o modal não volta.
  // Sem isto não havia saída não-destrutiva: fechar no X, no Esc ou clicando fora descartava a vaga.
  const [adiadas, setAdiadas] = useState<string[]>([]);
  const comPendencia = estado.vagas.filter(v => v.pendencia);
  const pendente = comPendencia.find(v => !adiadas.includes(v.id));
  const abertas = estado.vagas.filter(v => v.status !== 'encerrada');
  // Vaga já enviada sai da lista: o trabalho com ela acabou, e ficar olhando currículo que já foi só atrapalha
  // quem procura o que ainda falta. O histórico completo fica no Painel, em "Últimas candidaturas".
  const v = estado.varredura;
  const varrendo = v.rodando || estado.descoberta.varrendo;
  const noFoco = (v: Vaga) => plataformaNoFoco(estado.conexoes, v.plataforma);
  // Plataforma fora do foco sai da lista junto com a fila: focar sem limpar a tela não seria foco nenhum.
  // Nada é apagado — o rodapé tem um botão para mostrá-las.
  const foraDoFoco = abertas.filter(v => !noFoco(v) && v.status !== 'ignorada' && v.status !== 'enviada');
  const enviadas = abertas.filter(v => v.status === 'enviada' && noFoco(v));
  const ignoradas = abertas.filter(v => v.status === 'ignorada' && noFoco(v));
  const encontradas = abertas.filter(v => v.status !== 'ignorada' && v.status !== 'enviada' && noFoco(v));
  const listadas = [...encontradas, ...(mostrarIgnoradas ? ignoradas : []), ...(mostrarEnviadas ? enviadas : []), ...(mostrarForaDoFoco ? foraDoFoco : [])].sort((a, b) => b.score - a.score);

  async function guardar(ligar: boolean) {
    const form = document.getElementById('form-automacao') as HTMLFormElement | null;
    if (form && !form.reportValidity()) return; // campo inválido (ex.: compatibilidade > 100): o navegador aponta qual
    const nova = { ...cfg, configurada: true };
    await salvar({ automacao: nova });
    setBase(nova);
    setCfg(nova);
    setSalvoEm(Date.now()); // acende o "Salvo!" no botão — a frase da barra sozinha passava despercebida
    registrar(
      'sucesso',
      `Configuração salva: modo ${cfg.modo === 'automatico' ? 'automático' : 'manual'}, ${cfg.adaptar ? 'com' : 'sem'} adaptação de currículo, ensaio ${cfg.ensaio ? 'ligado' : 'desligado'}.`,
    );
    if (ligar && !ativo) await post('/robo', { ligar: true });
  }
  const aoEnviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void guardar(false);
  };

  /**
   * Grava sozinho, sem precisar do botão. O foco das plataformas e o modo de perguntas já faziam isso; o resto
   * da tela não, e ficava a dúvida do que estava valendo — ainda mais depois de ligar o robô com uma alteração
   * pendente na tela.
   *
   * Meio segundo de espera porque campo de número dispara `onChange` a cada tecla: sem isso, digitar "70" no
   * score mínimo gravaria 7 e depois 70. E só grava se o formulário estiver válido — score 150 continua sendo
   * recusado pelo navegador, como antes.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `cfg` é o gatilho certo; `guardar` é recriada a cada render e zeraria o timer sem parar
  useEffect(() => {
    if (!sujo || !estado.automacao.configurada) return;
    const t = setTimeout(() => {
      const form = document.getElementById('form-automacao') as HTMLFormElement | null;
      if (form && !form.checkValidity()) return; // `checkValidity`, não `reportValidity`: não abre balão sozinho
      void guardar(false);
    }, 500);
    return () => clearTimeout(t);
  }, [cfg]);

  async function reavaliar() {
    setReavaliando(true);
    try {
      await post('/repontuar-ia', { limite: 60 });
    } finally {
      // O trabalho segue no núcleo; o log mostra o andamento e o resultado
      setTimeout(() => setReavaliando(false), 4000);
    }
  }

  /**
   * Quais plataformas entram na fila. Um interruptor só, porque o efeito é um só: focar. A plataforma
   * desligada não enfileira e também some da lista de vagas — continua conectada e sendo varrida, e o rodapé
   * da lista tem um botão para ver o que ficou de fora.
   *
   * Grava em `conexoes`, que é a fonte de verdade de plataforma, e grava na hora: está fora do formulário,
   * então esperar o "Salvar alterações" faria o usuário ligar o robô com a seleção antiga.
   */
  async function alternarFoco(id: string) {
    const conexao = estado.conexoes[id];
    if (!conexao) return;
    const enviar = conexao.enviar === false;
    await salvar({ conexoes: { ...estado.conexoes, [id]: { ...conexao, enviar } } });
    const nome = PLATAFORMAS.find(x => x.id === id)?.nome ?? id;
    registrar(enviar ? 'sucesso' : 'alerta', enviar ? `${nome} voltou para a fila e para a lista de vagas.` : `${nome} saiu da fila e da lista de vagas (continua conectada e sendo varrida).`);
  }

  /** Troca fora do formulário: grava na hora, senão o usuário mudaria e ligaria o robô com o modo antigo. */
  async function trocarModoPerguntas(m: ConfigAutomacao['modoPerguntas']) {
    if (m === estado.automacao.modoPerguntas) return;
    set({ modoPerguntas: m });
    setBase(b => ({ ...b, modoPerguntas: m }));
    await salvar({ automacao: { ...estado.automacao, modoPerguntas: m } });
    registrar(
      'info',
      m === 'sem_piedade'
        ? 'Modo Sem Piedade: a IA responde tudo e não para mais para perguntar.'
        : m === 'duvida'
          ? 'Modo Só na dúvida: a IA responde o que dá e devolve para você o que depende de você.'
          : 'Modo padrão: perguntas novas pausam a vaga e esperam você.',
    );
  }

  async function buscar() {
    setBuscando(true);
    try {
      await post('/buscar');
    } finally {
      setBuscando(false);
    }
  }

  return (
    <div className="stagger grid grid-cols-[1fr_380px] items-start gap-[15px] max-lg:grid-cols-1">
      <div className="flex flex-col gap-4">
        <section aria-label="Status do robô" className="flex flex-wrap items-center gap-3.5 rounded-lg border border-black/50 bg-side-bottom px-3.5 py-3 text-white">
          <span className={`relative flex size-[34px] shrink-0 items-center justify-center rounded-full border-2 ${ativo ? 'border-aqua/40' : 'border-white/20'}`}>
            {ativo && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-aqua/30" />}
            <span aria-hidden className={`size-3.5 rounded-full ${statusRobo[estado.robo].dot}`} />
          </span>
          <div role="status" className="min-w-[180px] flex-1">
            <p className={`text-base font-bold ${ativo ? 'text-aqua' : ''}`}>{titulos[estado.robo]}</p>
            <p className="text-xs text-white/70">
              {estado.automacao.configurada ? `Modo ${estado.automacao.modo === 'automatico' ? 'automático' : 'manual'} · ${empresasAtivas} empresa(s) do InHire` : 'Ainda não configurado'}
              {estado.automacao.ensaio && ' · modo ensaio (nada é enviado)'}
            </p>
          </div>
          <button type="button" className="btn btn-primary" disabled={buscando || varrendo} onClick={buscar}>
            {varrendo ? <Orbe estado="procurando" /> : <Search size={16} aria-hidden />}
            {varrendo ? 'Procurando...' : 'Procurar vagas'}
          </button>
          {/* O score por competências conta palavras; a IA lê o currículo e a vaga e separa função de função */}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={reavaliando || estado.ia.provedor === 'nenhum' || !estado.ia.chaveDefinida}
            title={
              estado.ia.provedor === 'nenhum' || !estado.ia.chaveDefinida ? 'Configure a IA em Configurações › Inteligência Artificial' : 'A IA lê o seu currículo e reavalia as vagas mais compatíveis'
            }
            onClick={reavaliar}
          >
            <Sparkles size={16} aria-hidden />
            {reavaliando ? 'Reavaliando...' : 'Reavaliar com IA'}
          </button>
          {ativo ? (
            <button type="button" className="btn btn-danger" onClick={() => post('/robo', { ligar: false })}>
              <Pause size={16} aria-hidden />
              Pausar
            </button>
          ) : (
            <button type="button" className="btn btn-success" onClick={() => guardar(true)}>
              <Play size={16} aria-hidden />
              {estado.automacao.configurada ? (sujo ? 'Salvar e ligar' : 'Ligar') : 'Configurar e ligar'}
            </button>
          )}
        </section>

        {/* Antes de ligar: qual é a regra quando uma empresa faz uma pergunta que você nunca respondeu */}
        <section aria-label="Perguntas das empresas" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-panel-border bg-panel px-3.5 py-2.5">
          <MessageCircleQuestion size={16} aria-hidden className="shrink-0 text-ink-soft" />
          <p className="text-xs font-bold">Quando a empresa fizer uma pergunta nova</p>
          <div className="flex flex-wrap gap-1.5">
            {MODOS_PERGUNTA.map(m => {
              const escolhido = estado.automacao.modoPerguntas === m.id;
              const bloqueado = !!m.precisaIA && (estado.ia.provedor === 'nenhum' || !estado.ia.chaveDefinida);
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={escolhido}
                  disabled={bloqueado}
                  title={bloqueado ? 'Configure a IA em Configurações › Inteligência Artificial' : m.texto}
                  onClick={() => trocarModoPerguntas(m.id)}
                  className={`rounded-[9px] border px-2.5 py-1 text-[11px] font-bold ${
                    escolhido ? 'border-blue-dark bg-blue-dark text-white' : 'border-panel-border bg-page-bg text-ink hover:border-ink-soft'
                  } ${bloqueado ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  {m.curto}
                </button>
              );
            })}
          </div>
          <p className="min-w-[220px] flex-1 text-[11px] text-ink-soft">{MODOS_PERGUNTA.find(m => m.id === estado.automacao.modoPerguntas)?.texto}</p>
        </section>

        {estado.automacao.ensaio && ativo && (
          <p className="rounded-lg border border-amber bg-amber/15 p-3 text-xs text-amber-ink">
            <strong>Modo ensaio ligado:</strong> o robô abre a vaga, preenche o formulário e anexa o currículo, mas não clica em enviar. Confira uma captura de tela na lista abaixo e, quando estiver
            confiante, desligue o ensaio na configuração.
          </p>
        )}

        {comPendencia.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-amber bg-amber/15 px-3.5 py-2.5">
            <p className="text-[11px] text-amber-ink">
              <strong>
                {comPendencia.length} vaga(s) esperando você
                {adiadas.length ? ` · ${adiadas.length} em espera nesta sessão` : ''}.
              </strong>{' '}
              Elas não seguram a fila: as outras continuam sendo enviadas.
            </p>
            <div className="flex gap-2">
              {adiadas.length > 0 && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdiadas([])}>
                  Retomar as adiadas
                </button>
              )}
              {ativo && (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => post('/robo', { ligar: false })}>
                  <Pause size={14} aria-hidden />
                  Pausar o robô
                </button>
              )}
            </div>
          </div>
        )}

        {(varrendo || v.feitas.length > 0) && <PainelVarredura varredura={v} />}

        <Panel
          icon={Target}
          title="Vagas encontradas"
          tone="purple"
          aside={
            encontradas.length || enviadas.length
              ? [encontradas.length ? `${encontradas.length} compatíveis` : '', ignoradas.length ? `${ignoradas.length} abaixo do mínimo` : '', enviadas.length ? `${enviadas.length} já enviadas` : '']
                  .filter(Boolean)
                  .join(' · ')
              : undefined
          }
          bodyClassName="p-0"
        >
          {listadas.length === 0 ? (
            <p className="p-5 text-center text-xs text-ink-soft">
              {empresasAtivas
                ? estado.vagas.length
                  ? `Nenhuma vaga chegou aos ${estado.automacao.scoreMinimo}% de compatibilidade mínima.`
                  : 'Nenhuma vaga ainda. Clique em "Buscar vagas agora".'
                : 'Conecte o InHire e escolha as empresas em Plataformas para buscar vagas.'}
            </p>
          ) : (
            <VerMais itens={listadas} nome="vagas">
              {visiveis => (
                <ul className="divide-y divide-panel-border">
                  {visiveis.map(v => (
                    <VagaItem
                      key={v.id}
                      vaga={v}
                      manual={estado.automacao.modo === 'manual'}
                      pdfEnviado={estado.candidaturas.find(c => c.vagaId === v.id)?.curriculo}
                      onVerAdaptacao={() => setAdaptacaoDe(v.id)}
                    />
                  ))}
                </ul>
              )}
            </VerMais>
          )}
          {ignoradas.length > 0 && (
            <button
              type="button"
              className="w-full border-t border-panel-border px-3.5 py-2 text-left text-[11px] font-bold text-ink-soft hover:bg-page-bg"
              onClick={() => setMostrarIgnoradas(m => !m)}
            >
              {mostrarIgnoradas ? 'Ocultar' : 'Mostrar'} {ignoradas.length} vaga(s) abaixo de {estado.automacao.scoreMinimo}% de compatibilidade
            </button>
          )}
          {foraDoFoco.length > 0 && (
            <button
              type="button"
              className="w-full border-t border-panel-border px-3.5 py-2 text-left text-[11px] font-bold text-ink-soft hover:bg-page-bg"
              onClick={() => setMostrarForaDoFoco(m => !m)}
            >
              {mostrarForaDoFoco ? 'Ocultar' : 'Mostrar'} {foraDoFoco.length} vaga(s) de plataforma fora do foco
            </button>
          )}
          {enviadas.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-panel-border px-3.5 py-2">
              <button type="button" className="text-left text-[11px] font-bold text-ink-soft hover:underline" onClick={() => setMostrarEnviadas(m => !m)}>
                {mostrarEnviadas ? 'Ocultar' : 'Mostrar'} {enviadas.length} vaga(s) com currículo já enviado
              </button>
              <Link to="/painel" className="text-[11px] font-bold text-blue-dark underline underline-offset-2">
                Histórico completo no Painel
              </Link>
            </div>
          )}
        </Panel>

        <Panel icon={SlidersHorizontal} title="Configuração da automação" bodyClassName="p-3.5">
          <form id="form-automacao" className="flex flex-col gap-4" onSubmit={aoEnviar}>
            <Passo n={1} titulo="Modo de operação">
              <div className="grid grid-cols-2 gap-2.5 max-md:grid-cols-1">
                <label className={`flex items-start gap-2.5 p-3 ${cartao}`}>
                  <input type="radio" name="modo" checked={cfg.modo === 'manual'} onChange={() => set({ modo: 'manual' })} className="mt-0.5 size-[17px]" />
                  <span>
                    <span className="block text-xs font-bold">Manual</span>
                    <span className="block text-[11px] text-ink-soft">O robô lista as vagas compatíveis; você escolhe em quais se candidatar com "Quero me candidatar".</span>
                  </span>
                </label>
                <label className={`flex items-start gap-2.5 p-3 ${cartao}`}>
                  <input type="radio" name="modo" checked={cfg.modo === 'automatico'} onChange={() => set({ modo: 'automatico' })} className="mt-0.5 size-[17px]" />
                  <span>
                    <span className="block text-xs font-bold">Automático</span>
                    <span className="block text-[11px] text-ink-soft">O robô busca vagas de hora em hora e se candidata sozinho, respeitando o ritmo abaixo. Pausa só se precisar de você.</span>
                  </span>
                </label>
              </div>
            </Passo>

            <Passo n={2} titulo="Plataformas e currículo">
              {conectadas.length === 0 ? (
                <p className="text-xs text-ink-soft">
                  Nenhuma plataforma conectada.{' '}
                  <Link to="/plataformas" className="font-bold text-blue-dark underline">
                    Conectar o InHire
                  </Link>
                </p>
              ) : (
                <>
                  <p className="mb-2 text-[11px] text-ink-soft">
                    Quais entram na fila. Desmarcar uma tira as vagas dela da fila <strong>e da lista acima</strong> — serve para focar em uma só. Ela continua conectada e sendo varrida, e nada é
                    apagado.
                  </p>
                  <div className="grid grid-cols-2 gap-2.5 max-lg:grid-cols-1">
                    {conectadas.map(p => {
                      const ativa = plataformaNoFoco(estado.conexoes, p.id);
                      const quantas = estado.vagas.filter(v => v.plataforma === p.id && !['encerrada', 'ignorada', 'enviada'].includes(v.status)).length;
                      return (
                        <label
                          key={p.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-[7px] border px-2.5 py-2 ${ativa ? 'border-panel-border' : 'border-dashed border-panel-border opacity-60'}`}
                        >
                          <input type="checkbox" checked={ativa} onChange={() => alternarFoco(p.id)} className="size-[15px] shrink-0 accent-green-deep" />
                          <span aria-hidden className={`size-2 shrink-0 rounded-full ${ativa ? p.cor : 'bg-ink-soft/40'}`} />
                          <span className="min-w-0">
                            <span className="block text-xs font-bold">{p.nome}</span>
                            {/* "N empresas monitoradas" só existe no InHire; nas outras era um número emprestado */}
                            <span className="block text-[10px] text-ink-soft">
                              {ativa ? `${quantas} vaga(s) na lista${p.id === 'inhire' ? ` · ${empresasAtivas} empresa(s) monitoradas` : ''}` : `fora do foco · ${quantas} vaga(s) escondida(s)`}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {conectadas.every(p => !plataformaNoFoco(estado.conexoes, p.id)) && (
                    <p role="alert" className="mt-2 text-[11px] font-bold text-orange-deep">
                      Nenhuma plataforma selecionada: o robô não tem de onde tirar vaga para a fila.
                    </p>
                  )}
                </>
              )}
              {estado.curriculos.length === 0 ? (
                <p className="mt-3 text-xs text-ink-soft">
                  Nenhum currículo enviado.{' '}
                  <Link to="/curriculo" className="font-bold text-blue-dark underline">
                    Enviar currículo
                  </Link>
                </p>
              ) : (
                <div className="mt-3 flex items-center gap-2.5 rounded-[7px] border border-panel-border p-[9px]">
                  <FileText size={26} strokeWidth={1.25} aria-hidden className="shrink-0 text-ink-soft" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold">{estado.curriculos[0].nome}</span>
                    <span className="block text-[11px] text-ink-soft">{formatarTamanho(estado.curriculos[0].tamanho)} · currículo principal (troque na tela Currículo)</span>
                  </span>
                </div>
              )}
            </Passo>

            <Passo n={3} titulo="Filtros de vaga">
              <div className="grid grid-cols-2 gap-2.5 max-lg:grid-cols-1">
                <label>
                  <span className="label">Compatibilidade mínima (%)</span>
                  <input type="number" min={0} max={100} value={cfg.scoreMinimo} onChange={e => set({ scoreMinimo: +e.target.value })} className="field tabular-nums" />
                </label>

                <fieldset>
                  <legend className="label">Modelos de trabalho aceitos</legend>
                  <div className="flex flex-wrap gap-2.5">
                    {REGIMES.map(([id, rotulo]) => (
                      <label key={id} className={`flex items-center gap-2 px-3 py-2 text-xs ${cartao}`}>
                        <input type="checkbox" checked={cfg.regimes.includes(id)} onChange={() => set({ regimes: alternar(cfg.regimes, id) })} className="size-[17px] shrink-0" />
                        {rotulo}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              {/* Área, cargo, senioridade e rigor moram no perfil: um campo, um dono. Aqui só o espelho. */}
              <div className="mt-3 rounded-[7px] border border-panel-border bg-page-bg p-2.5">
                <p className="text-[11px] text-ink-soft">
                  Quem você é decide a compatibilidade:{' '}
                  <strong className="text-ink">{estado.automacao.senioridade || estado.curriculos[0]?.perfilBusca?.senioridade || 'senioridade não definida'}</strong> ·{' '}
                  <strong className="text-ink">{estado.automacao.area || estado.curriculos[0]?.perfilBusca?.area || 'área não definida'}</strong> ·{' '}
                  <strong className="text-ink">{estado.perfil?.cargo || 'cargo não definido'}</strong> · {estado.automacao.cargoRigido ? 'só a sua área de atuação' : 'aceita funções vizinhas'} ·{' '}
                  {estado.automacao.presencialSoNaMinhaCidade ? `fora de ${estado.perfil?.cidade || 'sua cidade'}, só remotas` : 'aceita presencial em qualquer lugar'}.{' '}
                  <Link to="/configuracoes?tab=dados" className="font-bold text-blue-dark hover:underline">
                    Alterar em Configurações
                  </Link>
                </p>
              </div>
            </Passo>

            <Passo n={4} titulo="Currículo por vaga">
              <div className="grid grid-cols-3 gap-2.5 max-lg:grid-cols-1">
                <label className={`flex items-center gap-2.5 px-3 py-2.5 ${cartao}`}>
                  <input type="checkbox" checked={cfg.adaptar} onChange={e => set({ adaptar: e.target.checked })} className="size-[17px] shrink-0" />
                  <span>
                    <span className="block text-xs font-bold">Adaptar o currículo para cada vaga</span>
                    <span className="block text-[10px] text-ink-soft">
                      {estado.ia.provedor !== 'nenhum' && estado.ia.chaveDefinida
                        ? `Reescrita por ${estado.ia.provedor === 'gemini' ? 'Gemini' : 'Claude'} (${estado.ia.modelo}) + validação. `
                        : 'Só regras: reordena e destaca o que já está no currículo. '}
                      Nunca inventa.{' '}
                      <Link to="/configuracoes?tab=ia" className="font-bold text-blue-dark underline">
                        Configurar IA
                      </Link>
                    </span>
                  </span>
                </label>
                <label>
                  <span className="label">Antes de enviar</span>
                  <select value={cfg.preview} onChange={e => set({ preview: e.target.value as ConfigAutomacao['preview'] })} disabled={!cfg.adaptar} className="field">
                    <option value="mostrar">Mostrar o currículo adaptado e pedir aprovação</option>
                    <option value="direto">Enviar direto, sem mostrar</option>
                  </select>
                </label>
                <label>
                  <span className="label">Se a vaga aceitar CLT e PJ</span>
                  <select value={cfg.regimePreferido} onChange={e => set({ regimePreferido: e.target.value as ConfigAutomacao['regimePreferido'] })} className="field">
                    <option value="CLT">Prefiro CLT</option>
                    <option value="PJ">Prefiro PJ</option>
                    <option value="perguntar">Perguntar sempre</option>
                  </select>
                </label>
              </div>
            </Passo>

            <Passo n={5} titulo="Ritmo de envio">
              <div className="flex items-end gap-3.5">
                <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-full bg-orange text-white max-lg:hidden">
                  <Hourglass size={26} />
                </span>
                <div className="grid flex-1 grid-cols-3 gap-2.5 max-lg:grid-cols-1">
                  <label>
                    <span className="label">Intervalo entre candidaturas</span>
                    <select value={cfg.intervaloSegundos} onChange={e => set({ intervaloSegundos: +e.target.value })} className="field">
                      {opcoesIntervalo(cfg.intervaloSegundos).map(([segundos, rotulo]) => (
                        <option key={segundos} value={segundos}>
                          {rotulo}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="label">Limite por dia</span>
                    <input type="number" min={1} max={100} value={cfg.limiteDiario} onChange={e => set({ limiteDiario: +e.target.value })} className="field tabular-nums" />
                  </label>
                  <label>
                    <span className="label">Janela de funcionamento</span>
                    <select value={cfg.janela} onChange={e => set({ janela: e.target.value })} className="field">
                      <option value="08:00-20:00">08:00 às 20:00</option>
                      <option value="09:00-18:00">09:00 às 18:00</option>
                      <option value="00:00-23:59">Qualquer horário</option>
                    </select>
                  </label>
                </div>
              </div>
            </Passo>

            <Passo n={6} titulo="Perguntas das empresas">
              <div className="flex flex-col gap-2">
                {MODOS_PERGUNTA.map(m => {
                  const escolhido = cfg.modoPerguntas === m.id;
                  const bloqueado = !!m.precisaIA && (estado.ia.provedor === 'nenhum' || !estado.ia.chaveDefinida);
                  return (
                    <label
                      key={m.id}
                      className={`flex items-start gap-2.5 rounded-[7px] border p-3 ${escolhido ? 'border-blue-dark ring-1 ring-blue-dark' : 'border-panel-border hover:border-ink-soft'} ${bloqueado ? 'opacity-60' : ''}`}
                    >
                      <input type="radio" name="modoPerguntas" checked={escolhido} disabled={bloqueado} onChange={() => set({ modoPerguntas: m.id })} className="mt-0.5 size-[17px] shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-bold">{m.titulo}</span>
                          {m.etiqueta && <span className="rounded-[9px] bg-orange-deep px-2 py-0.5 text-[10px] font-bold text-white">{m.etiqueta}</span>}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-ink-soft">{m.texto}</span>
                        {bloqueado && <span className="mt-1 block text-[11px] font-bold text-amber-ink">Precisa de uma IA configurada em Configurações › Inteligência Artificial.</span>}
                      </span>
                    </label>
                  );
                })}
                {cfg.modoPerguntas !== 'manual' && (
                  <p className="rounded-lg border border-amber bg-amber/15 p-2.5 text-[11px] text-amber-ink">
                    Em qualquer modo com IA: autodeclaração (gênero, cor/raça, deficiência, religião, saúde) e dado pessoal (CPF, endereço, contato, pretensão) nunca vão para a IA — vêm da sua
                    política em Configurações ou voltam para você. Resposta longa, com jeito de texto de IA, ou opção que não existe na vaga é recusada e a vaga volta a esperar.
                    {cfg.modoPerguntas === 'sem_piedade' && ' No Sem Piedade, tudo o mais é respondido e enviado sem você conferir.'}
                  </p>
                )}
              </div>
            </Passo>

            <Passo n={7} titulo="Segurança">
              <div className="grid grid-cols-2 gap-2.5 max-lg:grid-cols-1">
                <label className={`flex items-center gap-2.5 px-3 py-2.5 ${cartao}`}>
                  <input type="checkbox" checked={cfg.ensaio} onChange={e => set({ ensaio: e.target.checked })} className="size-[17px] shrink-0" />
                  <span>
                    <span className="block text-xs font-bold">Modo ensaio (não envia)</span>
                    <span className="block text-[10px] text-ink-soft">Preenche e anexa, tira uma captura e para antes de enviar. Recomendado nas primeiras vezes.</span>
                  </span>
                </label>
                <label className={`flex items-center gap-2.5 px-3 py-2.5 ${cartao}`}>
                  <input type="checkbox" checked={cfg.mostrarNavegador} onChange={e => set({ mostrarNavegador: e.target.checked })} className="size-[17px] shrink-0" />
                  <span>
                    <span className="block text-xs font-bold">Mostrar o navegador enquanto trabalha</span>
                    <span className="block text-[10px] text-ink-soft">Abre uma janela do navegador para você acompanhar cada passo.</span>
                  </span>
                </label>
                <label className={`flex flex-col gap-1 px-3 py-2.5 ${cartao}`}>
                  <span className="text-xs font-bold">Navegador do robô</span>
                  <select value={cfg.navegador} onChange={e => set({ navegador: e.target.value as 'edge' | 'firefox' })} className="field">
                    <option value="edge">Microsoft Edge / Chrome (o que já está instalado)</option>
                    <option value="firefox">Firefox (versão do Playwright)</option>
                  </select>
                  <span className="block text-[10px] text-ink-soft">
                    O Firefox usado é uma cópia própria do robô, não o seu Firefox: favoritos, extensões e logins dele não aparecem, e o login do Indeed precisa ser refeito ao trocar. O PDF do
                    currículo continua sendo gerado pelo Edge/Chrome, às escondidas.
                  </span>
                </label>
              </div>
            </Passo>
            <div className="sticky bottom-0 flex items-center gap-2.5 rounded-lg border border-panel-border bg-panel px-3.5 py-3">
              <p role="status" className={`flex-1 text-xs ${sujo ? 'font-bold text-amber-ink' : 'text-ink-soft'}`}>
                {sujo && <Orbe estado="escrevendo" className="mr-1 inline-block align-[-5px]" />}
                {sujo ? 'Salvando...' : 'Tudo salvo — esta tela grava sozinha. As mudanças valem para as próximas candidaturas.'}
              </p>
              <button type="button" className="btn btn-secondary" disabled={!sujo} onClick={() => setCfg(base)}>
                Descartar
              </button>
              <BotaoSalvar salvoEm={salvoEm} disabled={!sujo}>
                Salvar configuração
              </BotaoSalvar>
            </div>
          </form>
        </Panel>
      </div>

      <div className="flex flex-col gap-4">
        <Panel icon={ListOrdered} title="Fila de envio" tone="green" aside={estado.fila.length > 0 ? `${estado.fila.length} vagas` : undefined} bodyClassName="flex flex-col">
          {estado.fila.length === 0 ? (
            <p className="p-4 text-center text-xs text-ink-soft">
              {estado.automacao.modo === 'manual' ? 'Escolha vagas na lista ao lado com "Quero me candidatar".' : 'A fila enche sozinha quando o robô encontrar vagas compatíveis.'}
            </p>
          ) : (
            <VerMais itens={estado.fila} nome="vagas">
              {visiveis => (
                <ol className="flex-1 overflow-y-auto">
                  {visiveis.map((v, i) => (
                    <li key={v.id} className="flex h-12 items-center gap-2 border-b border-panel-border px-2.5">
                      <span className="w-6 text-[11px] font-bold text-ink-soft tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-bold">{v.titulo}</p>
                        <p className="truncate text-[10px] text-ink-soft">{v.empresa}</p>
                      </div>
                      <EtiquetaStatus status={v.status} />
                      <button
                        type="button"
                        aria-label={`Tirar ${v.titulo} da fila`}
                        disabled={v.status === 'em_andamento'}
                        onClick={() => post('/fila/remover', { id: v.id })}
                        className="btn btn-secondary size-[26px] p-0"
                      >
                        <X size={13} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </VerMais>
          )}
          {estado.proximoEnvioEm && ativo && (
            <p className="border-t border-panel-border px-2.5 py-2 text-[11px] text-ink-soft tabular-nums">
              Próxima candidatura liberada às {new Date(estado.proximoEnvioEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </Panel>

        <Panel icon={Terminal} title="Log de atividade" tone="slate" className="h-[300px]" bodyClassName="flex flex-col bg-side-bottom">
          {estado.log.length === 0 ? (
            <p className="p-4 text-center text-xs text-white/70">Nada registrado ainda.</p>
          ) : (
            <ol aria-label="Eventos recentes" className="flex flex-1 flex-col gap-[3px] overflow-y-auto p-2.5">
              {estado.log.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: LinhaLog nao tem id proprio; a lista so cresce no topo e nunca e reordenada
                <li key={`${l.hora}-${i}`} className="flex gap-1.5 text-[11px]">
                  <span className="shrink-0 text-white/50 tabular-nums">[{l.hora}]</span>
                  <span className={coresLog[l.tipo]}>{l.msg}</span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      {pendente && (
        // `key` por vaga: cada pergunta é uma decisão própria, então o modal remonta e reabre na seguinte
        <Pendencia key={pendente.id} vaga={pendente} roboAtivo={ativo} onAdiar={() => setAdiadas(a => [...a, pendente.id])} onAdiarTudo={() => setAdiadas(comPendencia.map(v => v.id))} />
      )}
      {adaptacaoDe && <Adaptacao vaga={estado.vagas.find(v => v.id === adaptacaoDe)!} onFechar={() => setAdaptacaoDe(null)} />}
    </div>
  );
}

/** Página de carreira de onde a vaga veio ("radix.inhire.app"); cai no nome da plataforma se a URL não der. */
function origemDaVaga(v: Vaga): string {
  try {
    return new URL(v.url).host.replace(/^www\./, '');
  } catch {
    return v.tenant || getPlataforma(v.plataforma).nome;
  }
}

function VagaItem({ vaga: v, manual, pdfEnviado, onVerAdaptacao }: { vaga: Vaga; manual: boolean; pdfEnviado?: string; onVerAdaptacao: () => void }) {
  const plataforma = getPlataforma(v.plataforma);
  const podeCandidatar = ['encontrada', 'erro', 'ensaio'].includes(v.status);
  return (
    <li className="flex flex-wrap items-center gap-3 px-3.5 py-3">
      <div className="w-14 shrink-0 text-center">
        <span className={`block text-xl font-bold tabular-nums ${v.score >= 60 ? 'text-green-deep' : v.score >= 40 ? 'text-amber-ink' : 'text-ink-soft'}`}>{v.score}%</span>
        <span className="text-[10px] text-ink-soft">compatível</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-bold">
          <a href={v.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-dark hover:underline">
            {v.titulo}
            <ExternalLink size={12} aria-hidden />
          </a>
          <EtiquetaStatus status={v.status} />
          {/* Origem: em qual plataforma o robô achou a vaga (e, no título, a página exata) */}
          <span className={`inline-flex items-center gap-1 rounded-[9px] px-2 py-0.5 text-[10px] font-bold text-white ${plataforma.cor}`} title={`Encontrada em ${origemDaVaga(v)}`}>
            {plataforma.nome}
          </span>
        </p>
        <p className="text-[11px] text-ink-soft">
          {v.empresa} · {MODELO[v.modelo]} · {v.local || v.pais || 'local não informado'} · {REGIME_VAGA[v.regime]}
          {v.senioridade && v.senioridade !== 'Indefinida' && ` · ${v.senioridade}`} · via {origemDaVaga(v)}
        </p>
        {v.motivo && <p className="mt-0.5 text-[11px] text-ink">{v.motivo}</p>}
        {v.skills.length > 0 && <p className="mt-0.5 text-[11px] text-ink-soft">Pede: {v.skills.join(', ')}</p>}
        {v.erro && <p className="mt-0.5 text-[11px] font-bold text-orange-deep">{v.erro}</p>}
        {v.formulario && (
          <p className="mt-0.5 text-[11px] text-ink-soft">
            Formulário: {v.formulario.etapas} etapa(s), {v.formulario.campos} campos, {v.formulario.perguntas} pergunta(s) extra{v.formulario.typeform ? ', com Typeform' : ''}
            {v.formulario.incomum && <span className="font-bold text-amber-ink"> · estrutura incomum, confira a captura</span>}
          </p>
        )}
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-bold">
          <button type="button" onClick={onVerAdaptacao} className="inline-flex items-center gap-1 text-purple hover:underline">
            <Sparkles size={12} aria-hidden />
            Currículo adaptado
          </button>
          {pdfEnviado && (
            <a href={urlArquivo(pdfEnviado)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-dark hover:underline">
              <FileDown size={12} aria-hidden />
              PDF usado na candidatura
            </a>
          )}
          {v.captura && (
            <a href={urlArquivo(v.captura)} target="_blank" rel="noreferrer" className="text-blue-dark hover:underline">
              Ver captura de tela
            </a>
          )}
        </p>
      </div>
      {manual && podeCandidatar && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => post('/candidatar', { id: v.id })}>
          <Send size={14} aria-hidden />
          Quero me candidatar
        </button>
      )}
    </li>
  );
}

interface RespostaAdaptacao {
  markdown: string;
  diff: string[];
  viaIA: boolean;
  pdf?: string;
  original: string;
}

// Modal "Currículo adaptado": gera (ou mostra a já gerada), compara com o original e abre o PDF
function Adaptacao({ vaga, onFechar }: { vaga: Vaga; onFechar: () => void }) {
  const [dados, setDados] = useState<RespostaAdaptacao | null>(null);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function gerar(refazer = false) {
    setOcupado(true);
    setErro('');
    try {
      setDados(await post<RespostaAdaptacao>('/preview/gerar', { id: vaga.id, refazer }));
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  async function abrirPdf() {
    setOcupado(true);
    try {
      const { pdf } = await post<{ pdf: string }>('/preview/pdf', { id: vaga.id });
      setDados(d => (d ? { ...d, pdf } : d));
      window.open(urlArquivo(pdf), '_blank', 'noreferrer');
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  if (!dados && !ocupado && !erro) void gerar();

  return (
    <Modal
      aberto
      onFechar={onFechar}
      icon={Sparkles}
      titulo={`Currículo adaptado — ${vaga.titulo}`}
      largo
      rodape={
        <>
          <button type="button" className="btn btn-secondary" disabled={ocupado} onClick={() => gerar(true)}>
            <RefreshCw size={16} aria-hidden />
            Gerar de novo
          </button>
          <button type="button" className="btn btn-primary" disabled={ocupado || !dados} onClick={abrirPdf}>
            <FileDown size={16} aria-hidden />
            {dados?.pdf ? 'Abrir PDF' : 'Gerar e abrir PDF'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onFechar}>
            Fechar
          </button>
        </>
      }
    >
      {erro && (
        <p role="alert" className="text-xs font-bold text-orange-deep">
          {erro}
        </p>
      )}
      {!dados && !erro && ocupado && (
        <div className="flex flex-col items-center gap-2 py-6 text-blue-dark">
          <Orbe estado="escrevendo" tamanho={64} rotulo="Gerando a adaptação do currículo" />
          <p className="text-xs text-ink-soft">Gerando a adaptação...</p>
        </div>
      )}
      {dados && (
        <>
          <div className="rounded-lg border border-panel-border bg-page-bg p-3">
            <p className="label mb-1.5">O que mudou {dados.viaIA ? '(reescrito pela IA e validado)' : '(adaptação por regras)'}</p>
            {dados.diff.length ? (
              <ul className="list-disc pl-4 text-xs">
                {dados.diff.map(d => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-soft">Nada a mudar: o original já está alinhado com esta vaga.</p>
            )}
            <p className="mt-1.5 text-[11px] text-ink-soft">Nenhuma competência, cargo ou dado foi acrescentado: a validação compara com o original antes de aceitar.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            {[
              ['Original', dados.original],
              ['Adaptado', dados.markdown],
            ].map(([t, md]) => (
              <div key={t}>
                <p className="label">{t}</p>
                <pre className="max-h-[360px] overflow-auto rounded-lg border border-panel-border p-2.5 font-mono text-[11px] whitespace-pre-wrap">{md}</pre>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * Duas saídas sem perder nada, e é a diferença entre elas que resolve a fila grande:
 *  - "Responder depois" adia ESTA e abre a próxima, para ir peneirando uma a uma;
 *  - fechar (X, Esc, clique fora) adia TODAS de uma vez — é como sair da frente quando são dezessete.
 * Nenhuma das duas mexe na vaga: quem desiste dela é o "Pular esta vaga".
 */
function Pendencia({ vaga, onAdiar, onAdiarTudo, roboAtivo }: { vaga: Vaga; onAdiar: () => void; onAdiarTudo: () => void; roboAtivo: boolean }) {
  const p = vaga.pendencia!;
  // Pergunta sobre esta empresa ("nossas produções") não deve nascer marcada para reaproveitar em outra vaga
  const soDestaVaga = p.tipo === 'pergunta' && perguntaSoDestaVaga(p.pergunta.rotulo, vaga.empresa);
  const [resposta, setResposta] = useState('');
  const [guardar, setGuardar] = useState(!soDestaVaga);

  if (p.tipo === 'pergunta') {
    const q = p.pergunta;
    return (
      <Modal
        aberto
        // Fechar (X, Esc, clique fora) põe em espera. Antes isto DESCARTAVA a vaga: nenhuma saída era inocente.
        onFechar={onAdiarTudo}
        icon={MessageCircleQuestion}
        titulo={q.sensivel ? 'O InHire pede uma autodeclaração' : 'O InHire perguntou'}
        rodape={
          <>
            <button type="button" className="btn btn-secondary" onClick={onAdiar}>
              Responder depois
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => post('/fila/remover', { id: vaga.id })}>
              Pular esta vaga
            </button>
            <button type="button" className="btn btn-primary" disabled={!resposta.trim()} onClick={() => post('/responder', { id: vaga.id, resposta: resposta.trim(), salvar: guardar })}>
              Responder e continuar
            </button>
          </>
        }
      >
        <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-soft">
          <span>
            Vaga <strong className="text-ink">{vaga.titulo}</strong> em {vaga.empresa}
          </span>
          {/* Daqui de dentro, porque o <dialog> fica em top layer e tapa o botão de pausar da página */}
          {roboAtivo && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => post('/robo', { ligar: false })}>
              <Pause size={13} aria-hidden />
              Pausar o robô
            </button>
          )}
        </p>
        <p className="text-[11px] text-ink-soft">
          "Responder depois" pula para a próxima pergunta; fechar no X adia todas. Nos dois casos a vaga continua esperando e não segura a fila — quem desiste dela é o "Pular esta vaga".
        </p>
        {q.sensivel && (
          <p className="rounded-lg border border-amber bg-amber/15 p-2.5 text-[11px] text-amber-ink">
            <strong>Pergunta de autodeclaração (dado sensível).</strong> O robô não responde isso sozinho nem reaproveita respostas parecidas: sua escolha vale só para esta pergunta exata. Você pode
            definir uma regra em{' '}
            <Link to="/configuracoes?aba=sensiveis" className="font-bold underline">
              Configurações › Autodeclaração
            </Link>
            .
          </p>
        )}
        <p className="text-sm font-bold">{q.rotulo}</p>
        {q.tipo === 'opcoes' && q.opcoes?.length ? (
          <div className="flex flex-col gap-1.5">
            {q.opcoes.map(o => (
              <label key={o} className={`flex items-center gap-2 px-3 py-2 text-xs ${cartao}`}>
                <input type="radio" name="opcao" value={o} checked={resposta === o} onChange={() => setResposta(o)} className="size-4" />
                {o}
              </label>
            ))}
          </div>
        ) : q.tipo === 'multipla' && q.opcoes?.length ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] text-ink-soft">Marque todas que se aplicam.</p>
            {q.opcoes.map(o => {
              const marcadas = resposta ? resposta.split(' | ') : [];
              const marcada = marcadas.includes(o);
              return (
                <label key={o} className={`flex items-center gap-2 px-3 py-2 text-xs ${cartao}`}>
                  <input type="checkbox" checked={marcada} onChange={() => setResposta((marcada ? marcadas.filter(m => m !== o) : [...marcadas, o]).join(' | '))} className="size-4" />
                  {o}
                </label>
              );
            })}
          </div>
        ) : (
          <textarea value={resposta} onChange={e => setResposta(e.target.value)} rows={3} placeholder="Sua resposta" className="field" />
        )}
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={guardar} onChange={e => setGuardar(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
          <span>
            {q.sensivel ? 'Guardar só para esta pergunta exata' : 'Guardar esta resposta para perguntas parecidas'}
            {soDestaVaga && !q.sensivel && <span className="block text-[11px] text-ink-soft">Esta pergunta é sobre {vaga.empresa} — reaproveitar a resposta em outra empresa não faria sentido.</span>}
          </span>
        </label>
      </Modal>
    );
  }

  return (
    <Modal
      aberto
      // Fechar põe em espera; cancelar a candidatura é o botão, não um Esc sem querer
      onFechar={onAdiarTudo}
      icon={Sparkles}
      titulo={`Currículo adaptado — ${vaga.titulo}`}
      largo
      rodape={
        <>
          <button type="button" className="btn btn-secondary" onClick={onAdiar}>
            Decidir depois
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => post('/preview', { id: vaga.id, decisao: 'cancelar' })}>
            Cancelar candidatura
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => post('/preview', { id: vaga.id, decisao: 'original' })}>
            Usar o original
          </button>
          <button type="button" className="btn btn-success" onClick={() => post('/preview', { id: vaga.id, decisao: 'adaptado' })}>
            Aprovar e enviar
          </button>
        </>
      }
    >
      <div className="rounded-lg border border-panel-border bg-page-bg p-3">
        <p className="label mb-1.5">O que mudou</p>
        <ul className="list-disc pl-4 text-xs">
          {p.diff.map(d => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        <p className="mt-1.5 text-[11px] text-ink-soft">Nenhuma competência, cargo ou dado foi acrescentado: a validação compara palavra por palavra com o original.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        {[
          ['Original', p.original],
          ['Adaptado', p.adaptado],
        ].map(([t, md]) => (
          <div key={t}>
            <p className="label">{t}</p>
            <pre className="max-h-[360px] overflow-auto rounded-lg border border-panel-border p-2.5 font-mono text-[11px] whitespace-pre-wrap">{md}</pre>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function Passo({ n, titulo, children }: { n: number; titulo: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 border-b border-panel-border pb-3 last:border-0">
      <legend className="mb-[9px] flex items-center gap-2 text-sm font-bold">
        <span className="flex size-[22px] items-center justify-center rounded-full bg-blue-dark text-xs text-white">{n}</span>
        {titulo}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * O que está acontecendo durante a varredura, plataforma por plataforma.
 *
 * Antes só o InHire dava sinal de vida, e numa tela diferente do botão que dispara a busca: clicar em
 * "Procurar vagas" parecia não fazer nada por minutos. `conhecidas` é o número que responde à pergunta
 * "clicar de novo vai repetir vaga?" — ele mostra, a cada rodada, quantas o robô já tinha e não regravou.
 */
function PainelVarredura({ varredura }: { varredura: ProgressoVarredura }) {
  const { rodando, plataforma, etapa, atual, total, feitas, restantes, novas, conhecidas } = varredura;
  const nome = (id: string) => PLATAFORMAS.find(p => p.id === id)?.nome ?? id;

  /**
   * Porcentagem do trabalho TODO, não da plataforma atual: cada plataforma vale uma fatia igual, e a que está
   * rodando contribui com a fração que já andou. É o que responde "falta muito?" — a barra por plataforma
   * sozinha zerava a cada troca e dava a impressão de que nunca acabava.
   */
  const fatias = feitas.length + restantes.length + (rodando && plataforma ? 1 : 0);
  const dentroDaAtual = total > 0 ? atual / total : 0;
  const geral = fatias > 0 ? Math.min(100, Math.round(((feitas.length + dentroDaAtual) / fatias) * 100)) : 100;
  const faltam = restantes.length + (rodando && plataforma ? 1 : 0);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-panel-border bg-panel p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-2 text-[13px] font-bold">
          {rodando && (
            <span className="text-blue-dark">
              <Orbe estado="procurando" />
            </span>
          )}
          {rodando ? (
            <>
              Procurando em <span className="text-blue-dark">{nome(plataforma)}</span>
              {etapa && <span className="font-normal text-ink-soft"> — {etapa}</span>}
            </>
          ) : (
            'Varredura concluída'
          )}
        </p>
        <p className="text-[11px] text-ink-soft tabular-nums">
          {rodando && (
            <>
              <strong className="text-base text-ink">{geral}%</strong> · {faltam === 1 ? 'última plataforma' : `faltam ${faltam} plataformas`} ·{' '}
            </>
          )}
          <strong className="text-green-deep">{novas}</strong> vaga(s) nova(s)
          {conhecidas > 0 && <> · {conhecidas} que o robô já tinha (não duplicadas)</>}
        </p>
      </div>

      {rodando && (
        <div
          role="progressbar"
          aria-label="Progresso da varredura"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={geral}
          aria-valuetext={`${geral}% — ${etapa || nome(plataforma)}`}
          className="h-2 w-full overflow-hidden rounded-full bg-page-bg"
        >
          <div className="h-full rounded-full bg-blue-dark transition-all duration-300" style={{ width: `${geral}%` }} />
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {feitas.map(id => (
          <span key={id} className="inline-flex items-center gap-1 rounded-[9px] border border-panel-border bg-page-bg px-2 py-0.5 text-[10px] font-bold text-ink-soft">
            <CircleCheck size={10} aria-hidden />
            {nome(id)}
          </span>
        ))}
        {rodando && plataforma && (
          <span className="inline-flex items-center gap-1 rounded-[9px] bg-blue-dark px-2 py-0.5 text-[10px] font-bold text-white">
            {nome(plataforma)}
            {total > 0 && (
              <span className="tabular-nums">
                {' '}
                {atual}/{total}
              </span>
            )}
          </span>
        )}
        {restantes.map(id => (
          <span key={id} className="rounded-[9px] border border-dashed border-panel-border px-2 py-0.5 text-[10px] font-bold text-ink-soft opacity-60">
            {nome(id)}
          </span>
        ))}
      </div>
    </div>
  );
}
