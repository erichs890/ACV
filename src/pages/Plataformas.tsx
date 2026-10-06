import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ExternalLink, KeyRound, Plug, Plus, Puzzle, RadarIcon, Search, Trash2, Unplug } from 'lucide-react';
import Modal from '../components/Modal';
import Panel from '../components/Panel';
import { useEstado } from '../estado';
import { api, post } from '../api';
import { GRUPOS_DE_ACESSO, PLATAFORMAS, REGIOES, tempoAtras } from '../dados';
import type { Plataforma } from '../types';
import Orbe from '../components/Orbe';

/** Quantas vagas dessa plataforma estão vivas na lista (o card mostra isso quando ela está conectada). */
const contarVagas = (vagas: { plataforma: string; status: string }[], id: string) => vagas.filter(v => v.plataforma === id && v.status !== 'encerrada').length;

/**
 * O texto do card. Era um ternário aninhado por id que ia crescer a cada plataforma nova — agora o caso
 * específico fica aqui e o resto cai na `nota` do catálogo, que toda plataforma já tem.
 */
function descricaoDoCard(p: Plataforma, conectada: boolean, vagas: number, empresasInhire: number): string {
  if (!conectada) return p.nota ?? 'Integração ainda não implementada.';
  if (p.id === 'inhire') return `${empresasInhire} empresa(s) monitoradas · ${vagas} vagas ativas`;
  if (p.id === 'indeed') return `${vagas} vagas com candidatura simplificada · o robô usa janela visível`;
  return `${vagas} vaga(s) acompanhada(s) · candidatura no próprio site`;
}

export default function Plataformas() {
  const { estado, salvar, registrar } = useEstado();
  const [erro, setErro] = useState('');
  const [adicionando, setAdicionando] = useState(false);
  const [loginDe, setLoginDe] = useState<string | null>(null); // plataforma do modal "Fazer login"

  const conectadas = Object.keys(estado.conexoes).length;
  const conexaoInhire = estado.conexoes.inhire;
  const ativas = estado.empresas.filter(e => e.ativo);
  const vagasAtivas = estado.vagas.filter(v => v.plataforma === 'inhire' && !['encerrada'].includes(v.status)).length;
  const vagasPorEmpresa = (sub: string) => estado.vagas.filter(v => v.tenant === sub && v.status !== 'encerrada').length;

  // `conexoes` é a única fonte de verdade de plataforma ligada (o core lê dela; `automacao.plataformas` era um espelho que podia divergir)
  async function conectar(id = 'inhire') {
    await salvar({ conexoes: { ...estado.conexoes, [id]: { conectadaEm: estado.conexoes[id]?.conectadaEm ?? new Date().toISOString() } } });
    if (id !== 'inhire') {
      registrar('sucesso', `${PLATAFORMAS.find(p => p.id === id)?.nome ?? id} conectado: a próxima varredura já traz as vagas de lá.`);
      return;
    }
    const { total } = await post<{ total: number }>('/empresas/seed');
    registrar('sucesso', `InHire conectado: ${total} empresa(s) monitoradas.`);
  }

  async function desconectar(id = 'inhire') {
    // `conexoes` é a única fonte de verdade de plataforma ligada
    const { [id]: _fora, ...resto } = estado.conexoes;
    await salvar({ conexoes: resto });
    registrar(
      'alerta',
      id === 'inhire'
        ? 'InHire desconectado (a lista de empresas foi mantida).'
        : id === 'indeed'
          ? 'Indeed desconectado (a sessão continua no navegador do robô até você sair por lá).'
          : `${PLATAFORMAS.find(p => p.id === id)?.nome ?? id} desconectado (as vagas já encontradas continuam na lista).`,
    );
  }

  async function adicionar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const campo = e.currentTarget.elements.namedItem('empresa') as HTMLInputElement;
    setAdicionando(true);
    setErro('');
    try {
      await post('/empresas', { entrada: campo.value });
      campo.value = '';
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setAdicionando(false);
    }
  }

  return (
    <div className="stagger flex flex-col gap-4">
      <div className="rounded-lg border border-panel-border bg-panel px-3 py-[9px]">
        <p className="text-[13px] font-bold">
          {conectadas} {conectadas === 1 ? 'plataforma conectada' : 'plataformas conectadas'}{' '}
          <span className="text-xs font-normal text-ink-soft">
            • {PLATAFORMAS.filter(p => p.disponivel).length} com adapter pronto · {PLATAFORMAS.filter(p => p.login).length} exigem login · as outras chegam como plugins
          </span>
        </p>
      </div>

      {/* Agrupado por LOGIN, e não por região: região é geografia, login é o que muda o que VOCÊ tem de fazer.
          A região continua visível como etiqueta em cada cartão. Dentro de cada grupo, as prontas primeiro —
          cartão indisponível no topo é uma lista que começa pelo que não dá para usar. */}
      {GRUPOS_DE_ACESSO.map(g => {
        const doGrupo = PLATAFORMAS.filter(p => (g.id === 'com-login') === !!p.login).sort((a, b) => Number(b.disponivel) - Number(a.disponivel) || a.nome.localeCompare(b.nome, 'pt-BR'));
        const quantasVagas = (id: string) => contarVagas(estado.vagas, id);
        if (!doGrupo.length) return null;
        const ligadas = doGrupo.filter(p => estado.conexoes[p.id]).length;
        const prontas = doGrupo.filter(p => p.disponivel).length;
        return (
          <section key={g.id} aria-labelledby={`grupo-${g.id}`} className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-panel-border pb-1.5">
              <h2 id={`grupo-${g.id}`} className="inline-flex items-center gap-1.5 text-[13px] font-bold">
                {g.id === 'com-login' ? <KeyRound size={13} aria-hidden className="text-amber-ink" /> : <Plug size={13} aria-hidden className="text-green-deep" />}
                {g.titulo}
              </h2>
              <span className="rounded-[9px] border border-panel-border bg-page-bg px-2 py-0.5 text-[10px] font-bold text-ink-soft tabular-nums">
                {ligadas ? `${ligadas} de ${prontas} conectada(s)` : `${prontas} pronta(s) de ${doGrupo.length}`}
              </span>
              <p className="min-w-[200px] flex-1 text-[11px] text-ink-soft">{g.texto}</p>
            </div>
            <ul className="grid grid-cols-4 gap-3.5 max-lg:grid-cols-2 max-md:grid-cols-1">
              {doGrupo.map(p => {
                const conexao = estado.conexoes[p.id];
                return (
                  <li key={p.id} className={`flex min-h-[150px] flex-col gap-2.5 rounded-lg border border-panel-border bg-panel p-3 ${p.disponivel ? '' : 'opacity-60'}`} aria-disabled={!p.disponivel}>
                    <div className="flex items-center gap-2.5">
                      <span aria-hidden className={`flex size-[42px] shrink-0 items-center justify-center rounded-[10px] text-[17px] font-bold text-white ${p.disponivel ? p.cor : 'bg-ink-soft/50'}`}>
                        {p.sigla}
                      </span>
                      <div className="flex flex-col items-start gap-1">
                        <h3 className="text-[15px] font-bold">{p.nome}</h3>
                        <span
                          className={`inline-flex items-center gap-[5px] rounded-[9px] px-2 py-0.5 text-[10px] font-bold ${conexao ? (conexao.sessao?.valida === false ? 'bg-orange-deep text-white' : 'bg-green-deep text-white') : 'border border-panel-border bg-page-bg text-ink'}`}
                        >
                          <span aria-hidden className="size-1.5 rounded-full bg-current" />
                          {conexao ? (conexao.sessao?.valida === false ? 'Sessão expirada' : 'Conectado') : p.disponivel ? 'Não conectado' : 'Indisponível'}
                        </span>
                        {/* A região saiu do cabeçalho quando o agrupamento virou login; continua aqui, por cartão */}
                        <span className="rounded-[9px] border border-panel-border bg-page-bg px-2 py-0.5 text-[10px] font-bold text-ink-soft">
                          {REGIOES.find(r => r.id === p.regiao)?.titulo ?? p.regiao}
                        </span>
                        {/* Só-descoberta é a outra coisa que muda o que você faz: o robô acha, o envio é seu */}
                        {p.somenteDescoberta && (
                          <span
                            className="inline-flex items-center gap-[5px] rounded-[9px] border border-amber bg-amber/20 px-2 py-0.5 text-[10px] font-bold text-amber-ink"
                            title={p.motivoSomenteDescoberta}
                          >
                            <Search size={10} aria-hidden />
                            Só encontra vagas
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Preso em 5 linhas: a nota do Jobbol é um parágrafo inteiro (os quatro motivos de ele estar fora) e,
                        solta, esticava a linha inteira da grade — os cartões ao lado ficavam com meio palmo de vazio.
                        O texto completo continua acessível no `title`, para quem quiser ler. */}
                    <p className="line-clamp-5 text-xs text-ink-soft" title={descricaoDoCard(p, !!conexao, quantasVagas(p.id), ativas.length)}>
                      {descricaoDoCard(p, !!conexao, quantasVagas(p.id), ativas.length)}
                    </p>
                    {conexao?.sessao?.valida === false && (
                      <p role="alert" className="text-[11px] font-bold text-orange-deep">
                        A sessão caiu: as vagas de {p.nome} ficam paradas até você entrar de novo.
                      </p>
                    )}
                    {p.site && (
                      <a
                        href={p.site}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1 truncate text-[11px] font-bold text-blue-deep underline underline-offset-2"
                        title={p.site}
                      >
                        <ExternalLink size={12} aria-hidden className="shrink-0" />
                        {p.site.replace(/^https?:\/\//, '')}
                        <span className="sr-only"> — abrir o site de {p.nome}</span>
                      </a>
                    )}
                    {/* Espelho: quem edita o foco é a Automação (uma fonte por campo) */}
                    {conexao && p.disponivel && conexao.enviar === false && (
                      <p className="rounded-[7px] border border-dashed border-panel-border bg-page-bg px-2.5 py-2 text-[11px] leading-tight text-ink-soft">
                        <strong className="text-ink">Fora do foco da automação.</strong> Continua conectada e sendo varrida, mas as vagas dela não entram na fila nem na lista.{' '}
                        <Link to="/automacao" className="font-bold text-blue-dark underline">
                          Mudar em Automação
                        </Link>
                      </p>
                    )}
                    <div className="mt-auto flex flex-col gap-1.5">
                      {p.login && conexao?.sessao?.valida === false && (
                        <button type="button" className="btn btn-success btn-sm w-full" onClick={() => setLoginDe(p.id)}>
                          <KeyRound size={14} aria-hidden />
                          Entrar de novo
                          <span className="sr-only"> em {p.nome}</span>
                        </button>
                      )}
                      {conexao && p.disponivel ? (
                        <button type="button" className="btn btn-secondary btn-sm w-full" onClick={() => desconectar(p.id)}>
                          <Unplug size={14} aria-hidden />
                          Desconectar
                        </button>
                      ) : (
                        <button type="button" className="btn btn-success btn-sm w-full" disabled={!p.disponivel} onClick={p.login ? () => setLoginDe(p.id) : () => conectar(p.id)}>
                          {p.login ? <KeyRound size={14} aria-hidden /> : <Plug size={14} aria-hidden />}
                          {!p.disponivel ? 'Indisponível' : p.login ? 'Entrar e conectar' : 'Conectar'}
                          <span className="sr-only"> {p.nome}</span>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <ModalLogin plataforma={loginDe} onFechar={() => setLoginDe(null)} />

      <Extensao />

      {conexaoInhire && (
        <Panel
          icon={Building2}
          title="Empresas monitoradas no InHire"
          tone="purple"
          aside={`última varredura ${tempoAtras(estado.descoberta.ultimaVarredura)} · ${ativas.length} ativas · ${vagasAtivas} vagas`}
          bodyClassName="flex flex-col gap-3 p-3.5"
        >
          <p className="text-xs text-ink-soft">
            O InHire não tem busca geral: cada empresa publica em <code className="font-mono">empresa.inhire.app/vagas</code>. O robô descobre as empresas sozinho — começa com uma lista inicial
            verificada e, uma vez por dia, procura novas em índices públicos da web e confirma cada uma na API do InHire. Depois revisita todas a cada {estado.descoberta.intervaloHoras} h. Se souber
            de alguma que ele ainda não achou, cole o endereço.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={adicionar} className="flex min-w-[320px] flex-1 gap-2">
              <input name="empresa" type="text" placeholder="ex.: db1 ou https://db1.inhire.app/vagas" aria-label="Adicionar empresa InHire" className="field flex-1" />
              <button type="submit" className="btn btn-secondary" disabled={adicionando}>
                <Plus size={16} aria-hidden />
                {adicionando ? 'Conferindo...' : 'Adicionar'}
              </button>
            </form>
            <button type="button" className="btn btn-secondary" disabled={estado.descoberta.descobrindo} onClick={() => api('/descoberta/buscar', { method: 'POST' })}>
              <Search size={16} aria-hidden />
              {estado.descoberta.descobrindo ? 'Procurando empresas...' : 'Descobrir empresas agora'}
            </button>
            <button type="button" className="btn btn-primary" disabled={estado.descoberta.varrendo} onClick={() => api('/buscar', { method: 'POST' })}>
              <RadarIcon size={16} aria-hidden />
              {estado.descoberta.varrendo ? 'Varrendo...' : 'Forçar varredura agora'}
            </button>
          </div>
          {(estado.descoberta.descobrindo || estado.descoberta.varrendo) && (
            <div className="rounded-lg border border-amber bg-amber/15 p-2.5 text-[11px] text-amber-ink">
              {estado.descoberta.descobrindo && <p>Procurando empresas em índices públicos e confirmando cada uma na API do InHire — leva alguns minutos.</p>}
              {estado.descoberta.varrendo && estado.descoberta.progresso && (
                <>
                  <p className="font-bold">
                    Varrendo {estado.descoberta.progresso.atual} de {estado.descoberta.progresso.total}: {estado.descoberta.progresso.empresa}
                  </p>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={estado.descoberta.progresso.total}
                    aria-valuenow={estado.descoberta.progresso.atual}
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-amber/40"
                  >
                    <div className="h-full bg-amber-ink" style={{ width: `${(estado.descoberta.progresso.atual / estado.descoberta.progresso.total) * 100}%` }} />
                  </div>
                  <p className="mt-1">Cada vaga nova é lida uma vez; as próximas varreduras são rápidas. As vagas já aparecem em Automação conforme chegam.</p>
                </>
              )}
            </div>
          )}
          {erro && (
            <p role="alert" className="text-xs font-bold text-orange-deep">
              {erro}
            </p>
          )}
          {estado.empresas.length === 0 ? (
            <p className="py-3 text-center text-xs text-ink-soft">Nenhuma empresa ainda.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left text-xs">
                <thead className="text-[11px]">
                  <tr className="h-[30px] border-b border-panel-border">
                    <th scope="col" className="px-2 font-bold">
                      Empresa
                    </th>
                    <th scope="col" className="font-bold">
                      Subdomínio
                    </th>
                    <th scope="col" className="w-[110px] font-bold">
                      Vagas ativas
                    </th>
                    <th scope="col" className="w-[130px] font-bold">
                      Última verificação
                    </th>
                    <th scope="col" className="w-[90px] font-bold">
                      Origem
                    </th>
                    <th scope="col" className="w-[170px] pr-2 text-right font-bold">
                      Ações
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {estado.empresas.map(e => (
                    <tr key={e.subdominio} className={`h-9 border-b border-panel-border/60 last:border-0 ${e.ativo ? '' : 'text-ink-soft'}`}>
                      <td className="px-2 font-bold">{e.nome || e.subdominio}</td>
                      <td>
                        <a href={e.urlVagas} target="_blank" rel="noreferrer" className="font-mono text-blue-dark hover:underline">
                          {e.subdominio}.inhire.app
                        </a>
                      </td>
                      <td className="tabular-nums">
                        {vagasPorEmpresa(e.subdominio)}
                        {e.totalVagas !== vagasPorEmpresa(e.subdominio) && <span className="text-ink-soft"> / {e.totalVagas} publicadas</span>}
                      </td>
                      <td className="text-ink-soft">
                        {tempoAtras(e.ultimaVerificacao)}
                        {e.falhas > 0 && <span className="text-orange-deep"> · {e.falhas} falha(s)</span>}
                      </td>
                      <td className="text-ink-soft">{{ seed: 'lista inicial', manual: 'você', busca: 'busca' }[e.origem]}</td>
                      <td className="pr-2 text-right">
                        <button type="button" className="btn btn-secondary btn-sm mr-1.5" onClick={() => post('/empresas/ativar', { subdominio: e.subdominio, ativo: !e.ativo })}>
                          {e.ativo ? 'Pausar' : 'Reativar'}
                        </button>
                        <button
                          type="button"
                          aria-label={`Remover ${e.nome || e.subdominio}`}
                          className="btn btn-secondary btn-sm px-2 text-orange-deep"
                          onClick={() => api(`/empresas?subdominio=${encodeURIComponent(e.subdominio)}`, { method: 'DELETE' })}
                        >
                          <Trash2 size={13} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

/**
 * A extensão de navegador (pasta `extensao/`) roda no navegador DA PESSOA, na sessão dela, e só relata: se a
 * plataforma exige conta e quais campos obrigatórios o perfil não cobre. Nenhuma candidatura sai por ela.
 * Aqui ficam o token (a fronteira de confiança com o núcleo) e o que ela já viu.
 */
function Extensao() {
  const { estado } = useEstado();
  const [token, setToken] = useState('');
  const [erro, setErro] = useState('');
  const detectadas = estado.deteccoes ?? [];

  async function mostrarToken() {
    setErro('');
    try {
      const r = await api<{ token: string }>('/extensao/token');
      setToken(r.token);
      await navigator.clipboard?.writeText(r.token).catch(() => {});
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  const conta = (d: (typeof detectadas)[number]) => (d.precisaLogin === true ? 'Exige conta' : d.precisaLogin === false ? 'Não exige conta' : 'Não deu para saber se exige conta');

  return (
    <Panel
      icon={Puzzle}
      title="Extensão do navegador"
      tone="slate"
      aside={detectadas.length ? `${detectadas.length} plataforma(s) vista(s)` : 'nenhuma plataforma vista ainda'}
      bodyClassName="flex flex-col gap-3 p-3.5"
    >
      <p className="text-xs text-ink-soft">
        A extensão olha as páginas de vaga que <strong className="text-ink">você</strong> abre no seu navegador de sempre e diz duas coisas: se aquela plataforma exige conta e quais campos
        obrigatórios ela vai pedir que o seu perfil ainda não responde. Ela não preenche, não clica e não envia nada — quem candidata continua sendo o robô. Para instalar: em
        <code className="mx-1 font-mono">chrome://extensions</code>, ligue o "Modo do desenvolvedor" e use "Carregar sem compactação" na pasta <code className="font-mono">extensao/</code> do ACV.
        Depois abra o popup dela e cole o token abaixo.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={mostrarToken}>
          <KeyRound size={14} aria-hidden />
          {token ? 'Copiado' : 'Mostrar token da extensão'}
        </button>
        {token && <code className="select-all rounded border border-panel-border bg-page-bg px-2 py-1 font-mono text-[11px]">{token}</code>}
      </div>
      {erro && (
        <p role="alert" className="text-xs font-bold text-orange-deep">
          {erro}
        </p>
      )}
      {detectadas.length === 0 ? (
        <p className="py-2 text-center text-xs text-ink-soft">Nada visto ainda. Abra uma vaga qualquer no navegador com a extensão instalada e ela aparece aqui.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {detectadas.map(d => (
            <li key={d.dominio} className="rounded-[7px] border border-panel-border bg-page-bg px-2.5 py-2 text-xs">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <strong className="font-mono text-[12px]">{d.dominio}</strong>
                <span className={`rounded-[9px] px-1.5 py-0.5 text-[10px] font-bold ${d.precisaLogin === null ? 'bg-amber/30 text-amber-ink' : 'border border-panel-border text-ink-soft'}`}>
                  {conta(d)}
                </span>
                {d.logadoAtualmente && <span className="text-[10px] font-bold text-green-deep">você está logado</span>}
                <span className="text-[10px] text-ink-soft">{d.handler === 'generico' ? 'motor genérico (sem handler dedicado)' : `handler ${d.handler}`}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-ink-soft">{d.motivo}</p>
              {!!d.camposFaltando?.length && (
                <p className="mt-1 text-[11px] text-orange-deep">
                  <strong>Falta no seu perfil:</strong> {d.camposFaltando.map(c => `${c.pergunta}${c.obrigatorio ? '' : ' (talvez opcional)'}`).join(' · ')}.{' '}
                  <Link to="/configuracoes" className="font-bold text-blue-dark underline">
                    Completar em Configurações
                  </Link>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * "Fazer login manualmente": o núcleo abre uma janela visível do navegador do robô na página de login; a pessoa
 * entra como sempre (senha, código, captcha) e o ACV só espera a página sair do login e provar a sessão.
 * Genérico: vale para qualquer plataforma com `login: true` no catálogo e `sessao` no adapter.
 */
function ModalLogin({ plataforma, onFechar }: { plataforma: string | null; onFechar: () => void }) {
  const { registrar } = useEstado();
  const [esperando, setEsperando] = useState(false);
  const [erro, setErro] = useState('');
  const p = PLATAFORMAS.find(x => x.id === plataforma);

  async function entrar() {
    if (!p) return;
    setEsperando(true);
    setErro('');
    try {
      await post('/sessao/entrar', { plataforma: p.id });
      registrar('sucesso', `${p.nome} conectado.`);
      onFechar();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEsperando(false);
    }
  }

  async function cancelar() {
    if (esperando) await post('/sessao/cancelar').catch(() => {});
    onFechar();
  }

  return (
    <Modal
      aberto={!!p}
      onFechar={cancelar}
      titulo={`Entrar em ${p?.nome ?? ''}`}
      icon={KeyRound}
      rodape={
        <>
          <button type="button" className="btn btn-secondary" onClick={cancelar}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={entrar} disabled={esperando}>
            {esperando && <Orbe estado="esperando" />}
            {esperando ? 'Aguardando o seu login...' : 'Abrir a janela de login'}
          </button>
        </>
      }
    >
      {esperando ? (
        <div role="status" className="flex items-center gap-3.5 text-sm">
          <span className="text-blue-dark">
            <Orbe estado="esperando" tamanho={64} />
          </span>
          Faça login na janela que abriu. Assim que terminar, vamos continuar automaticamente.
        </div>
      ) : (
        <p className="text-xs text-ink-soft">
          Vai abrir uma janela do navegador do robô, identificada como do ACV, na página de login de {p?.nome}. Entre como sempre — senha, código por e-mail, captcha, o que {p?.nome} pedir. O ACV não
          vê nem guarda a sua senha: ele só espera a página sair do login e confere se a sessão ficou ativa. A sessão fica no perfil do navegador do robô, e cai de volta para "Sessão expirada" se{' '}
          {p?.nome} deslogar.
        </p>
      )}
      {erro && (
        <p role="alert" className="text-xs font-bold text-orange-deep">
          {erro}
        </p>
      )}
    </Modal>
  );
}
