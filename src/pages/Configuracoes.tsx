import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { Vaga } from '../types';
import { useSearchParams } from 'react-router-dom';
import { BotaoSalvar, SalvoEm } from '../components/BotaoSalvar';
import {
  Accessibility,
  Bell,
  Briefcase,
  Calendar,
  Car,
  Check,
  CircleCheck,
  DollarSign,
  House,
  Info,
  Languages,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Play,
  Plus,
  RadarIcon,
  Sun,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEstado, type Perfil } from '../estado';
import { AREAS, NIVEIS, NOTIFICACOES, iniciais, termoExcluido } from '../dados';
import { CPF_PATTERN, TELEFONE_PATTERN, mascaraCPF, mascaraMoeda, mascaraTelefone, mascarar } from '../mascaras';
import ConfigIA from './ConfigIA';
import ConfigDescoberta from './ConfigDescoberta';
import ConfigSensiveis from './ConfigSensiveis';
import { PAISES, PAISES_REMOTO_PADRAO } from '../paises';
import { lerTema, salvarTema, type Tema } from '../tema';
import { esquecerAbertura } from '../components/Abertura';

const abas = [
  { id: 'dados', label: 'Meus Dados', icon: User },
  { id: 'perguntas', label: 'Perguntas Automáticas', icon: MessageSquare },
  { id: 'sensiveis', label: 'Autodeclaração e dados sensíveis', icon: ShieldAlert },
  { id: 'ia', label: 'Inteligência Artificial', icon: Sparkles },
  { id: 'descoberta', label: 'Descoberta de vagas', icon: RadarIcon },
  { id: 'aparencia', label: 'Aparência', icon: Palette },
  { id: 'notificacoes', label: 'Notificações', icon: Bell },
  { id: 'conta', label: 'Dados e Privacidade', icon: ShieldCheck },
];

const iconesPergunta: Record<string, LucideIcon> = {
  salario: DollarSign,
  experiencia: Briefcase,
  viagem: Calendar,
  remoto: House,
  cnh: Car,
  inicio: Calendar,
  ingles: Languages,
  pcd: Accessibility,
};

const DURACAO_AVISO = 4000;

export default function Configuracoes() {
  const [params, setParams] = useSearchParams();
  const [toast, setToast] = useState('');
  const [salvoEm, setSalvoEm] = useState(0);
  const timer = useRef<number>(undefined);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const indice = Math.max(
    0,
    abas.findIndex(a => a.id === params.get('tab')),
  );
  const atual = abas[indice].id;

  function ir(i: number) {
    const j = (i + abas.length) % abas.length;
    setParams({ tab: abas[j].id }, { replace: true });
    refs.current[j]?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    const alvos: Record<string, number> = { ArrowRight: indice + 1, ArrowLeft: indice - 1, Home: 0, End: abas.length - 1 };
    if (!(e.key in alvos)) return;
    e.preventDefault();
    ir(alvos[e.key]);
  }

  function avisar(texto: string) {
    setToast(texto);
    setSalvoEm(Date.now()); // acende o "Salvo!" no próprio botão, onde o olho do usuário está
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(''), DURACAO_AVISO);
  }

  return (
    <div className="stagger flex min-h-full flex-col">
      <div role="tablist" aria-label="Configurações" onKeyDown={onKeyDown} className="flex items-end gap-1 overflow-x-auto px-1.5">
        {abas.map(({ id, label, icon: Icon }, i) => (
          <button
            key={id}
            ref={el => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={id === atual}
            aria-controls="painel-aba"
            tabIndex={id === atual ? 0 : -1}
            onClick={() => ir(i)}
            className={`-mb-px flex shrink-0 items-center gap-[7px] rounded-t-[9px] border border-b-0 border-panel-border text-[13px] font-bold ${
              id === atual ? 'relative h-[37px] bg-panel px-[18px] text-blue-dark' : 'h-[31px] bg-page-bg px-4 text-ink hover:bg-panel'
            }`}
          >
            <Icon size={15} aria-hidden />
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="painel-aba" aria-labelledby={`tab-${atual}`} className="relative flex flex-1 flex-col rounded-lg border border-panel-border bg-panel p-[18px]">
        {/* Fixo no canto de baixo: fica ao lado do botão Salvar, visível mesmo em formulário longo e rolado */}
        {toast && (
          <div
            role="status"
            key={salvoEm}
            className="fixed right-6 bottom-6 z-50 overflow-hidden rounded-[9px] bg-green-deep text-[13px] font-bold text-white shadow-lg [animation:aviso-entra_0.35s_cubic-bezier(0.2,0.7,0.2,1)_both] max-md:right-3 max-md:bottom-3"
          >
            <div className="flex items-center gap-[9px] px-3.5 py-2.5">
              <CircleCheck size={20} aria-hidden className="[animation:selo-ok_0.4s_cubic-bezier(0.2,0.7,0.2,1)_both]" />
              {toast}
              <button type="button" aria-label="Fechar aviso" onClick={() => setToast('')} className="rounded p-0.5 hover:bg-white/15">
                <X size={14} aria-hidden />
              </button>
            </div>
            <span aria-hidden className="block h-[3px] origin-left bg-white/45" style={{ animation: `aviso-tempo ${DURACAO_AVISO}ms linear both` }} />
          </div>
        )}
        <SalvoEm.Provider value={salvoEm}>
          {atual === 'dados' && <AbaDados onSalvar={avisar} />}
          {atual === 'perguntas' && <AbaPerguntas onSalvar={avisar} />}
          {atual === 'sensiveis' && <ConfigSensiveis onSalvar={avisar} />}
          {atual === 'ia' && <ConfigIA onSalvar={avisar} />}
          {atual === 'descoberta' && <ConfigDescoberta onSalvar={avisar} />}
          {atual === 'aparencia' && <AbaAparencia />}
          {atual === 'notificacoes' && <AbaNotificacoes onSalvar={avisar} />}
          {atual === 'conta' && <AbaPrivacidade />}
        </SalvoEm.Provider>
      </div>
    </div>
  );
}

function Cabecalho({ titulo, sub }: { titulo: string; sub?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-panel-border pb-3">
      <h2 className="text-lg font-bold">{titulo}</h2>
      {sub && <p className="text-xs text-ink-soft">{sub}</p>}
    </div>
  );
}

function BarraSalvar({ texto, cancelar = true }: { texto: string; cancelar?: boolean }) {
  return (
    <div className="sticky bottom-0 mt-auto flex items-center gap-2.5 rounded-lg border border-panel-border bg-panel px-3.5 py-3">
      <Info size={16} aria-hidden className="shrink-0 text-ink-soft" />
      <p className="flex-1 text-xs text-ink-soft">{texto}</p>
      {cancelar && (
        <button type="reset" className="btn btn-secondary">
          Cancelar
        </button>
      )}
      <BotaoSalvar />
    </div>
  );
}

/**
 * Campo do formulário. `exigido` marca com * o que o ACV precisa para acertar: ou porque as vagas do
 * InHire pedem (LinkedIn, pretensão), ou porque é o que decide a compatibilidade (senioridade, área, cargo).
 */
function Campo({ label, children, exigido, ajuda }: { label: string; children: ReactNode; exigido?: boolean; ajuda?: string }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: `children` e sempre o controle do campo (input/select)
    <label>
      <span className="label">
        {label}
        {exigido && (
          <span className="ml-0.5 text-orange-deep" title="Necessário para a compatibilidade sair certa">
            *
          </span>
        )}
      </span>
      {children}
      {ajuda && <span className="mt-1 block text-[11px] text-ink-soft">{ajuda}</span>}
    </label>
  );
}

/** Multi-seleção de países: campo com autocomplete (datalist nativo) e uma tag removível por país escolhido. */
function SeletorPaises({ valor, onChange }: { valor: string[]; onChange: (v: string[]) => void }) {
  const adicionar = (el: HTMLInputElement) => {
    const pais = PAISES.find(x => x.nome.toLowerCase() === el.value.trim().toLowerCase());
    if (!pais) return;
    if (!valor.includes(pais.nome)) onChange([...valor, pais.nome]);
    el.value = '';
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="busca-pais" className="label">
        Vagas 100% remotas: de quais países
      </label>
      <ul className="flex flex-wrap gap-1.5" aria-label="Países escolhidos">
        {valor.map(n => (
          <li key={n} className="inline-flex items-center gap-1 rounded-[9px] bg-blue-dark px-2 py-0.5 text-[11px] font-bold text-white">
            {n}
            <button type="button" aria-label={`Remover ${n}`} className="rounded p-0.5 hover:bg-white/20" onClick={() => onChange(valor.filter(x => x !== n))}>
              <X size={11} aria-hidden />
            </button>
          </li>
        ))}
        {valor.length === 0 && <li className="text-[11px] text-ink-soft">Nenhum: qualquer vaga remota serve.</li>}
      </ul>
      <input
        id="busca-pais"
        name="buscaPais"
        list="lista-paises"
        placeholder="Digite um país e escolha na lista"
        className="field"
        onChange={e => adicionar(e.currentTarget)}
        onKeyDown={e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          adicionar(e.currentTarget);
        }}
      />
      <datalist id="lista-paises">
        {PAISES.filter(x => !valor.includes(x.nome)).map(x => (
          <option key={x.iso} value={x.nome} />
        ))}
      </datalist>
      <span className="text-[10px] text-ink-soft">
        Vaga remota restrita a um país fora desta lista fica de fora; remota sem país declarado sempre entra. No Indeed, o robô busca no site de cada país escolhido.
      </span>
    </div>
  );
}

function AbaDados({ onSalvar }: { onSalvar: (t: string) => void }) {
  const { estado, salvar } = useEstado();
  const p = estado.perfil!;
  const [sujo, setSujo] = useState(false);
  const [paises, setPaises] = useState<string[]>(p.paisesRemoto ?? PAISES_REMOTO_PADRAO);
  const [excluir, setExcluir] = useState<string[]>(estado.automacao.excluir ?? []);

  const perfilBusca = estado.curriculos[0]?.perfilBusca;

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dados = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    // senioridade/área/rigor moram na automação (o score usa); cargo, cidade e países ficam no perfil
    const { regimePreferido, senioridade, area, cargoRigido, senioridadeRigida, buscaPais: _fora, ...perfil } = dados;
    await salvar({
      perfil: { ...p, ...(perfil as unknown as Perfil), paisesRemoto: paises },
      automacao: {
        ...estado.automacao,
        regimePreferido: regimePreferido as 'CLT' | 'PJ' | 'perguntar',
        senioridade,
        area,
        cargoRigido: cargoRigido === 'sim',
        senioridadeRigida: senioridadeRigida === 'sim',
        excluir,
      },
    });
    setSujo(false);
    onSalvar('Dados salvos. As vagas foram repontuadas com o seu perfil.');
  }

  return (
    <form
      className="flex flex-1 flex-col gap-4"
      onChange={() => setSujo(true)}
      onReset={() => {
        setSujo(false);
        setPaises(p.paisesRemoto ?? PAISES_REMOTO_PADRAO);
        setExcluir(estado.automacao.excluir ?? []);
      }}
      onSubmit={enviar}
    >
      <Cabecalho titulo="Meus dados" sub="o robô usa isto para preencher os formulários das vagas" />
      <div className="flex gap-6 max-md:flex-col">
        <div className="flex w-[190px] shrink-0 flex-col items-center gap-2 self-start rounded-lg border border-panel-border p-3.5 max-md:w-full">
          <span aria-hidden className="flex size-[110px] items-center justify-center rounded-full bg-purple text-3xl font-bold text-white">
            {iniciais(p.nome)}
          </span>
          <p className="text-sm font-bold">{p.nome}</p>
          {p.cargo && <p className="-mt-1 text-[11px] text-ink-soft">{p.cargo}</p>}
        </div>
        <div className="grid flex-1 grid-cols-2 content-start gap-3 max-md:grid-cols-1">
          <Campo label="Nome completo" exigido>
            <input name="nome" autoComplete="name" defaultValue={p.nome} required className="field" />
          </Campo>
          <Campo label="E-mail" exigido>
            <input name="email" type="email" autoComplete="email" defaultValue={p.email} required className="field" />
          </Campo>
          <Campo label="Celular com DDD" exigido>
            <input
              name="telefone"
              type="tel"
              autoComplete="tel"
              inputMode="numeric"
              defaultValue={mascaraTelefone(p.telefone)}
              required
              pattern={TELEFONE_PATTERN}
              title="DDD e número, ex.: (11) 91234-5678"
              onInput={mascarar(mascaraTelefone)}
              className="field"
            />
          </Campo>
          <Campo label="LinkedIn (link do perfil)" exigido ajuda="O InHire exige em praticamente toda vaga.">
            <input name="linkedin" placeholder="https://linkedin.com/in/seu-perfil" defaultValue={p.linkedin ?? ''} required className="field" />
          </Campo>
          <Campo label="Pretensão salarial" exigido ajuda="Campo obrigatório na maioria das vagas do InHire.">
            <input name="pretensao" inputMode="numeric" placeholder="R$ 4.500" defaultValue={mascaraMoeda(p.pretensao ?? '')} onInput={mascarar(mascaraMoeda)} required className="field" />
          </Campo>
          <Campo label="Se a vaga aceitar CLT e PJ">
            <select name="regimePreferido" defaultValue={estado.automacao.regimePreferido} className="field">
              <option value="CLT">Prefiro CLT</option>
              <option value="PJ">Prefiro PJ</option>
              <option value="perguntar">Perguntar sempre</option>
            </select>
          </Campo>
          <Campo label="Cargo desejado" exigido>
            <input name="cargo" placeholder="Ex.: Desenvolvedor Full Stack" defaultValue={p.cargo ?? ''} required className="field" />
          </Campo>
        </div>
      </div>

      <section aria-labelledby="perfil-profissional" className="flex flex-col gap-3 border-t border-panel-border pt-3.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 id="perfil-profissional" className="text-sm font-bold">
            Perfil profissional
          </h3>
          <p className="text-[11px] text-ink-soft">
            é isto que decide a compatibilidade das vagas — o robô tenta deduzir do currículo, mas o que você definir aqui <strong>manda</strong>
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
          <Campo label="Sua senioridade" exigido ajuda="Vagas acima do seu nível perdem pontos; abaixo, também.">
            <select name="senioridade" defaultValue={estado.automacao.senioridade} required className="field">
              <option value="">— escolha —</option>
              {NIVEIS.map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Campo>
          <Campo label="Sua área" exigido ajuda="Vaga de outra área cai pela metade.">
            <select name="area" defaultValue={estado.automacao.area} required className="field">
              <option value="">— escolha —</option>
              {AREAS.map(a => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Campo>
          <Campo label="Rigor de senioridade" ajuda="Rígido corta vaga ACIMA do seu nível. Vaga que não declara o nível continua aparecendo.">
            <select name="senioridadeRigida" defaultValue={estado.automacao.senioridadeRigida ? 'sim' : 'nao'} className="field">
              <option value="nao">Equilibrado — vaga um nível acima ainda conta</option>
              <option value="sim">Rígido — nada acima de {estado.automacao.senioridade || 'o meu nível'}</option>
            </select>
          </Campo>
          <Campo label="Rigor na função" ajuda="Rígido mantém o mundo da tecnologia (dev, IA, QA, dados, segurança) e corta o resto.">
            <select name="cargoRigido" defaultValue={estado.automacao.cargoRigido ? 'sim' : 'nao'} className="field">
              <option value="nao">Equilibrado — aceita funções vizinhas</option>
              <option value="sim">Rígido — só a minha área de atuação</option>
            </select>
          </Campo>
          <div className="col-span-2 max-md:col-span-1">
            <span className="label">Nichos que você NÃO quer</span>
            <ListaTermos
              valor={excluir}
              vagas={estado.vagas}
              onChange={v => {
                setExcluir(v);
                setSujo(true);
              }}
            />
            <p className="mt-1 text-[11px] text-ink-soft">
              Vaga com um destes termos no <strong>título</strong> é zerada e sai da lista, mesmo sendo da sua função. Só o título: uma vaga full stack que cita SAP numa linha de integração não é uma
              vaga de SAP.
            </p>
          </div>
        </div>
        {perfilBusca && (
          <p className="rounded-lg border border-panel-border bg-page-bg p-2.5 text-[11px] text-ink-soft">
            Lido do seu currículo: <strong>{perfilBusca.senioridade}</strong> · {perfilBusca.area} · {perfilBusca.cargos[0] ?? 'cargo não identificado'}
            {' — '}
            {estado.automacao.senioridade || estado.automacao.area ? 'suas escolhas acima estão valendo no lugar.' : 'preencha acima para não depender da dedução.'}
          </p>
        )}
      </section>

      <section aria-labelledby="dados-local" className="flex flex-col gap-3 border-t border-panel-border pt-3.5">
        <h3 id="dados-local" className="text-sm font-bold">
          Onde você aceita trabalhar
        </h3>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Campo label="Vagas presenciais e híbridas: sua cidade">
            <input name="cidade" placeholder="Ex.: Fortaleza - CE" autoComplete="address-level2" defaultValue={p.cidade ?? ''} className="field" />
            <span className="text-[10px] text-ink-soft">
              Uma cidade só. Vaga presencial ou híbrida em outro estado ou país fica de fora; em outra cidade do seu estado, perde pontos. Também é o que vai no campo "cidade" dos formulários.
            </span>
          </Campo>
          <SeletorPaises
            valor={paises}
            onChange={v => {
              setPaises(v);
              setSujo(true);
            }}
          />
        </div>
      </section>

      <section aria-labelledby="dados-extra" className="flex flex-col gap-3 border-t border-panel-border pt-3.5">
        <h3 id="dados-extra" className="text-sm font-bold">
          Dados complementares
        </h3>
        <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
          <Campo label="GitHub">
            <input name="github" defaultValue={p.github ?? ''} className="field" />
          </Campo>
          <Campo label="Portfólio">
            <input name="portfolio" autoComplete="url" defaultValue={p.portfolio ?? ''} className="field" />
          </Campo>
          <Campo label="CPF">
            <input
              name="cpf"
              inputMode="numeric"
              placeholder="000.000.000-00"
              defaultValue={mascaraCPF(p.cpf ?? '')}
              pattern={CPF_PATTERN}
              title="CPF com 11 dígitos"
              onInput={mascarar(mascaraCPF)}
              className="field"
            />
          </Campo>
          <Campo label="Data de nascimento">
            <input name="nascimento" type="date" autoComplete="bday" defaultValue={p.nascimento ?? ''} className="field" />
          </Campo>
          <Campo label="Disponibilidade">
            <select name="disponibilidade" defaultValue={p.disponibilidade ?? ''} className="field">
              <option value="">Selecione</option>
              <option>Imediata</option>
              <option>15 dias</option>
              <option>30 dias</option>
            </select>
          </Campo>
        </div>
        <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
          <Campo label="Escolaridade">
            <input name="escolaridade" defaultValue={p.escolaridade ?? ''} className="field" />
          </Campo>
          <Campo label="Idiomas">
            <input name="idiomas" defaultValue={p.idiomas ?? ''} className="field" />
          </Campo>
          <Campo label="Endereço">
            <input name="endereco" autoComplete="street-address" defaultValue={p.endereco ?? ''} className="field" />
          </Campo>
        </div>
      </section>

      <BarraSalvar texto={sujo ? 'Você tem alterações não salvas nesta aba.' : 'Nome, e-mail, celular, LinkedIn e pretensão entram direto no formulário do InHire.'} />
    </form>
  );
}

function AbaPerguntas({ onSalvar }: { onSalvar: (t: string) => void }) {
  const { estado, salvar } = useEstado();
  const [perguntas, setPerguntas] = useState(estado.perguntas);

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dados = new FormData(e.currentTarget);
    const atualizadas = perguntas.map(q => ({
      ...q,
      pergunta: String(dados.get(`pergunta-${q.id}`) ?? q.pergunta),
      resposta: String(dados.get(`resposta-${q.id}`) ?? ''),
    }));
    setPerguntas(atualizadas);
    await salvar({ perguntas: atualizadas });
    onSalvar('Respostas salvas.');
  }

  return (
    <form className="flex flex-1 flex-col gap-4" onReset={() => setPerguntas(estado.perguntas)} onSubmit={enviar}>
      <Cabecalho titulo="Perguntas automáticas" sub="quando uma vaga fizer uma pergunta parecida, o robô responde com isto; se não houver resposta, ele pausa e pergunta a você" />
      <ul className="flex flex-col gap-2">
        {perguntas.map(q => {
          const Icon = iconesPergunta[q.icone] ?? MessageSquare;
          const idResposta = `resposta-${q.id}`;
          return (
            <li key={q.id} className="flex items-center gap-3 rounded-[7px] border border-panel-border p-2.5 max-md:flex-wrap">
              <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-blue-dark text-white">
                <Icon size={16} />
              </span>
              {q.personalizada ? (
                <input name={`pergunta-${q.id}`} aria-label="Pergunta personalizada" placeholder="Digite a pergunta" defaultValue={q.pergunta} className="field w-[280px] font-bold" />
              ) : (
                <label htmlFor={idResposta} className="w-[280px] text-[13px] font-bold">
                  {q.pergunta}
                </label>
              )}
              <input
                id={idResposta}
                name={idResposta}
                aria-label={q.personalizada ? 'Resposta' : undefined}
                defaultValue={q.resposta}
                placeholder="Sua resposta"
                className="field min-w-[160px] flex-1"
              />
              <button
                type="button"
                aria-label={`Excluir pergunta: ${q.pergunta || 'pergunta personalizada'}`}
                onClick={() => setPerguntas(ps => ps.filter(x => x.id !== q.id))}
                className="btn btn-secondary size-[26px] p-0 text-orange-deep"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-primary self-start" onClick={() => setPerguntas(ps => [...ps, { id: Date.now(), icone: '', pergunta: '', resposta: '', personalizada: true }])}>
        <Plus size={16} aria-hidden />
        Adicionar pergunta personalizada
      </button>
      <BarraSalvar texto="O robô responde automaticamente apenas as perguntas preenchidas acima." />
    </form>
  );
}

/**
 * Aparência: tema e abertura.
 *
 * Não tem botão de salvar, e isso é a regra e não a exceção: o tema se aplica no clique, e você vê o
 * resultado na própria tela em que está escolhendo. Pedir "salvar" depois de a página já ter mudado de cor
 * seria perguntar se é para valer o que já valeu.
 */
function AbaAparencia() {
  const [tema, setTema] = useState<Tema>(() => lerTema());
  const [revista, setRevista] = useState(false);

  const escolher = (t: Tema) => {
    salvarTema(t);
    setTema(t);
  };

  const opcoes: { id: Tema; label: string; descricao: string; icon: LucideIcon }[] = [
    { id: 'claro', label: 'Claro', descricao: 'o de sempre: fundo cinza-claro e painéis brancos', icon: Sun },
    { id: 'escuro', label: 'Escuro', descricao: 'cinza-azulado, para trabalhar de noite sem a tela cegar', icon: Moon },
    { id: 'sistema', label: 'Seguir o Windows', descricao: 'acompanha o tema da máquina, e troca junto quando ele trocar', icon: Monitor },
  ];

  return (
    <div className="flex flex-1 flex-col gap-4">
      <Cabecalho titulo="Aparência" sub="vale neste computador e muda na hora, sem salvar" />

      <fieldset className="flex flex-col gap-2.5">
        <legend className="label">Tema</legend>
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
          {opcoes.map(({ id, label, descricao, icon: Icon }) => {
            const ativo = tema === id;
            return (
              <label
                key={id}
                className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3.5 transition-colors ${ativo ? 'border-blue-dark bg-blue-dark/10' : 'border-panel-border hover:border-ink-soft'}`}
              >
                <span className="flex items-center gap-2">
                  <input type="radio" name="tema" value={id} checked={ativo} onChange={() => escolher(id)} className="sr-only" />
                  <Icon size={16} aria-hidden className={ativo ? 'text-blue-dark' : 'text-ink-soft'} />
                  <span className="text-[13px] font-bold">{label}</span>
                  {ativo && <Check size={14} aria-hidden className="ml-auto text-blue-dark" />}
                </span>
                <span className="flex-1 text-[11px] text-ink-soft">{descricao}</span>
                {/* Amostra do tema, pintada com as cores dele e não com as da tela atual */}
                <span
                  aria-hidden
                  className={`mt-auto flex h-[46px] gap-1.5 overflow-hidden rounded-[6px] border p-1.5 ${id === 'escuro' ? 'border-[#333b47] bg-[#15181d]' : id === 'claro' ? 'border-[#c3c9d1] bg-[#eaeaea]' : 'border-panel-border bg-page-bg'}`}
                >
                  <span className={`w-[18px] rounded-[3px] ${id === 'escuro' ? 'bg-[#171c23]' : id === 'claro' ? 'bg-[#232a34]' : 'bg-side-bottom'}`} />
                  <span className={`flex-1 rounded-[3px] ${id === 'escuro' ? 'bg-[#1d222a]' : id === 'claro' ? 'bg-white' : 'bg-panel'}`} />
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-panel-border p-3.5">
        <div className="flex-1">
          <p className="text-[13px] font-bold">Abertura</p>
          <p className="text-[11px] text-ink-soft">
            O logo se desenhando por 3 segundos quando o ACV abre, com saída a qualquer clique ou tecla. Aparece uma vez por sessão do navegador — e nunca, se o Windows estiver com animações
            reduzidas.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            esquecerAbertura();
            setRevista(true);
          }}
        >
          <Play size={14} aria-hidden />
          Ver de novo
        </button>
      </div>
      {revista && (
        <p role="status" className="-mt-2 text-[11px] text-green-deep">
          Pronto: a abertura volta a tocar quando você recarregar a página (F5).
        </p>
      )}
    </div>
  );
}

function AbaNotificacoes({ onSalvar }: { onSalvar: (t: string) => void }) {
  const { estado, salvar } = useEstado();

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dados = new FormData(e.currentTarget);
    await salvar({ notificacoes: Object.fromEntries(NOTIFICACOES.map(n => [n.id, dados.get(n.id) === 'on'])) });
    onSalvar('Preferências salvas.');
  }

  return (
    <form className="flex flex-1 flex-col gap-3.5" onSubmit={enviar}>
      <Cabecalho titulo="Notificações" sub="avisos do robô" />
      <ul className="flex flex-col gap-2.5">
        {NOTIFICACOES.map(n => (
          <li key={n.id}>
            <label className="flex items-center gap-3 rounded-[7px] border border-panel-border p-[11px]">
              <span className="flex-1">
                <span className="block text-[13px] font-bold">{n.titulo}</span>
                <span className="block text-[11px] text-ink-soft">{n.descricao}</span>
              </span>
              <input type="checkbox" name={n.id} defaultChecked={estado.notificacoes[n.id] ?? n.padrao} className="switch" />
            </label>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-ink-soft">Hoje a confirmação de cada candidatura aparece no log e no Painel. O envio por e-mail ainda não está ligado.</p>
      <BarraSalvar texto="Alterações são aplicadas ao salvar." cancelar={false} />
    </form>
  );
}

function AbaPrivacidade() {
  const { estado, limpar } = useEstado();

  const itens = [
    ['Currículos', estado.curriculos.length],
    ['Empresas do InHire', estado.empresas.length],
    ['Vagas encontradas', estado.vagas.length],
    ['Candidaturas', estado.candidaturas.length],
  ] as const;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <Cabecalho titulo="Dados e privacidade" sub="esta é uma instalação local do ACV" />
      <p className="max-w-[70ch] text-[13px] text-ink-soft">
        Tudo fica neste computador, na pasta <code className="font-mono text-ink">%LOCALAPPDATA%\ACV</code>: seus dados, os PDFs, as vagas encontradas e o perfil do navegador que o robô usa. Nada é
        enviado a servidor nenhum além das próprias páginas de vagas. O InHire não pede login, então nenhuma senha é guardada.
      </p>

      <dl className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
        {itens.map(([rotulo, valor]) => (
          <div key={rotulo} className="rounded-lg border border-panel-border p-3">
            <dt className="text-[11px] text-ink-soft">{rotulo}</dt>
            <dd className="text-xl font-bold tabular-nums">{valor}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-auto flex flex-wrap items-center gap-2.5 rounded-lg border border-orange/50 bg-orange/10 p-3.5">
        <p className="flex-1 text-xs text-ink">Apagar tudo remove seu cadastro, currículos, vagas e histórico deste computador. Não dá para desfazer.</p>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            if (confirm('Apagar todos os dados do ACV neste computador?')) void limpar();
          }}
        >
          <Trash2 size={16} aria-hidden />
          Apagar todos os dados
        </button>
      </div>
    </div>
  );
}

/**
 * Lista de termos livre (os nichos a evitar). Enter ou vírgula adiciona; clique no × remove.
 * Guardado em minúsculas e sem repetir, porque quem compara é `termoExcluido` no score.
 */
function ListaTermos({ valor, vagas, onChange }: { valor: string[]; vagas: Vaga[]; onChange: (v: string[]) => void }) {
  const [texto, setTexto] = useState('');

  /**
   * As opções saem das SUAS vagas, não de uma lista alfabética de tecnologias: cada `skill` que o núcleo já
   * extraiu vira candidata, e ao lado dela vai quantas vagas o corte levaria — com a MESMA regra do score
   * (`termoExcluido`), senão a prévia mentiria. Ordenado pelo que mais pesa.
   */
  const sugestoes = useMemo(() => {
    const tecnologias = new Set<string>();
    for (const v of vagas) for (const s of v.skills ?? []) tecnologias.add(s);
    return [...tecnologias]
      .map(t => ({ termo: t, quantas: vagas.filter(v => termoExcluido(v.titulo, [t])).length }))
      .filter(o => o.quantas > 0 && !valor.includes(o.termo))
      .sort((a, b) => b.quantas - a.quantas);
  }, [vagas, valor]);

  const atingidas = useMemo(() => vagas.filter(v => termoExcluido(v.titulo, valor)), [vagas, valor]);
  const jaEnviadas = atingidas.filter(v => v.status === 'enviada').length;
  const adicionar = () => {
    const novos = texto
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length >= 2 && !valor.includes(t));
    if (novos.length) onChange([...valor, ...novos]);
    setTexto('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-panel-border bg-panel p-1.5">
      {valor.map(t => (
        <span key={t} className="inline-flex items-center gap-1 rounded-[7px] bg-orange-deep px-2 py-0.5 text-[11px] font-bold text-white">
          {t}
          <button type="button" aria-label={`Voltar a aceitar vagas de ${t}`} className="leading-none hover:opacity-70" onClick={() => onChange(valor.filter(x => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        value={texto}
        onChange={e => setTexto(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            adicionar();
          }
        }}
        onBlur={adicionar}
        placeholder={valor.length ? 'mais um...' : 'ex.: sap, cobol, salesforce'}
        aria-label="Nicho a evitar"
        className="min-w-[140px] flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
      />
      {sugestoes.length > 0 && (
        <select
          aria-label="Escolher uma tecnologia das suas vagas"
          value=""
          className="field h-7 w-full text-xs"
          onChange={e => {
            if (e.target.value) onChange([...valor, e.target.value]);
          }}
        >
          <option value="">Escolher das suas vagas...</option>
          {sugestoes.map(o => (
            <option key={o.termo} value={o.termo}>
              {o.termo} — {o.quantas} vaga(s)
            </option>
          ))}
        </select>
      )}
      {valor.length > 0 && (
        <p className={`w-full text-[11px] ${jaEnviadas ? 'font-bold text-orange-deep' : 'text-ink-soft'}`}>
          Esta lista tira <strong>{atingidas.length}</strong> vaga(s) da sua lista
          {jaEnviadas > 0 && ` — e ${jaEnviadas} dela(s) você já enviou currículo`}.
        </p>
      )}
    </div>
  );
}
