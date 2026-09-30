import { useRef, useState } from 'react';
import { Check, CloudUpload, Copy, CopyCheck, Download, FileCheck, FileText, FolderOpen, FolderPlus, Globe, History, Languages, RefreshCw, ScanSearch, Trash2 } from 'lucide-react';
import Panel from '../components/Panel';
import { useEstado } from '../estado';
import { api, enviarCurriculo, salvarCurriculoComoNovo, traduzirCurriculoIngles, urlDownloadArquivo } from '../api';
import { LIMITE_MB, dataHora, formatarTamanho, validarCurriculo } from '../dados';

export default function Curriculo() {
  const { estado, salvar, registrar } = useEstado();
  const inputRef = useRef<HTMLInputElement>(null);
  const [erro, setErro] = useState('');
  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [verTexto, setVerTexto] = useState(false);
  const [traduzindo, setTraduzindo] = useState(false);
  const [erroTraducao, setErroTraducao] = useState('');
  const [verIngles, setVerIngles] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [salvandoNovo, setSalvandoNovo] = useState(false);

  const curriculos = estado.curriculos;
  const principal = curriculos[0];
  const perfil = principal?.perfilBusca;

  async function gerarVersaoIngles(refazer = false) {
    if (!principal?.id) return;
    setTraduzindo(true);
    setErroTraducao('');
    try {
      await traduzirCurriculoIngles(principal.id, refazer);
      registrar('sucesso', 'Currículo em inglês gerado com sucesso.');
    } catch (e) {
      setErroTraducao((e as Error).message);
      registrar('erro', `Falha ao traduzir currículo: ${(e as Error).message}`);
    } finally {
      setTraduzindo(false);
    }
  }

  async function salvarComoSeparado() {
    if (!principal?.inglesMarkdown) return;
    setSalvandoNovo(true);
    try {
      const nomeBase = principal.nome.replace(/\.[^.]+$/, '');
      await salvarCurriculoComoNovo(`${nomeBase}-EN.pdf`, principal.inglesMarkdown);
      registrar('sucesso', 'Versão em inglês salva na lista de currículos.');
    } catch (e) {
      setErroTraducao((e as Error).message);
    } finally {
      setSalvandoNovo(false);
    }
  }

  function copiarIngles() {
    if (!principal?.inglesMarkdown) return;
    navigator.clipboard.writeText(principal.inglesMarkdown);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  async function enviar(f?: File) {
    if (!f) return;
    const problema = validarCurriculo(f);
    setErro(problema);
    if (problema) return;
    setEnviando(true);
    try {
      await enviarCurriculo(f);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  async function tornarPrincipal(id: number) {
    const escolhido = curriculos.find(c => c.id === id)!;
    await salvar({ curriculos: [escolhido, ...curriculos.filter(c => c.id !== id)] });
    registrar('info', `Currículo principal: ${escolhido.nome}.`);
  }

  async function remover(id: number) {
    const alvo = curriculos.find(c => c.id === id);
    await api(`/curriculos?id=${id}`, { method: 'DELETE' });
    if (alvo) registrar('alerta', `Currículo ${alvo.nome} removido.`);
  }

  return (
    <div className="stagger grid grid-cols-[1fr_340px] items-start gap-4 max-lg:grid-cols-1">
      <div className="flex flex-col gap-4">
        <Panel icon={CloudUpload} title="Enviar currículo" bodyClassName="flex flex-col gap-3 p-3.5">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: arrastar e um atalho; o <input type=file> dentro da area continua sendo o caminho de teclado */}
          <div
            onDragOver={e => {
              e.preventDefault();
              setArrastando(true);
            }}
            onDragLeave={() => setArrastando(false)}
            onDrop={e => {
              e.preventDefault();
              setArrastando(false);
              enviar(e.dataTransfer.files[0]);
            }}
            className={`flex flex-col items-center gap-1.5 rounded-[10px] border-2 border-dashed px-3.5 py-[18px] text-center ${arrastando ? 'border-blue-dark bg-blue/10' : 'border-blue/50 bg-panel'}`}
          >
            <span className="flex size-[52px] items-center justify-center rounded-full bg-blue-dark text-white">
              <CloudUpload size={26} aria-hidden />
            </span>
            <p className="text-[15px] font-bold">{enviando ? 'Lendo o currículo...' : 'Arraste um currículo aqui'}</p>
            <p className="text-xs text-ink-soft">PDF até {LIMITE_MB} MB — o AutoCV lê o texto e monta o perfil de busca</p>
            <label className="btn btn-secondary mt-1">
              <FolderOpen size={16} aria-hidden />
              Selecionar arquivo
              <input ref={inputRef} type="file" accept=".pdf,.docx" className="sr-only" disabled={enviando} onChange={e => enviar(e.target.files?.[0])} />
            </label>
          </div>
          {erro && (
            <p role="alert" className="text-xs font-bold text-orange-deep">
              {erro}
            </p>
          )}
        </Panel>

        <Panel icon={FileCheck} title="Currículo principal" tone="slate">
          {principal ? (
            <div className="flex items-center gap-3.5 max-md:flex-col max-md:items-start">
              <span aria-hidden className="flex size-[52px] shrink-0 items-center justify-center rounded-lg border border-panel-border bg-page-bg">
                <FileText size={26} className="text-ink-soft" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{principal.nome}</p>
                <p className="text-xs text-ink-soft tabular-nums">
                  {formatarTamanho(principal.tamanho)} • enviado em {dataHora(principal.enviadoEm)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {principal.caminho && (
                  <a href={urlDownloadArquivo(principal.caminho, principal.nome)} download={principal.nome} className="btn btn-secondary btn-sm" title="Baixar arquivo original em PDF">
                    <Download size={14} aria-hidden />
                    Baixar original
                  </a>
                )}
                <span className="flex items-center gap-1.5 rounded-[9px] border border-aqua/60 bg-aqua/15 px-2 py-0.5 text-[11px] font-bold text-green-deep">
                  <Check size={13} aria-hidden />
                  Em uso pelo robô
                </span>
              </div>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-ink-soft">Nenhum currículo enviado ainda.</p>
          )}
        </Panel>

        <Panel
          icon={Globe}
          title="Currículo em Inglês (English Resume)"
          tone="blue"
          aside={principal?.inglesMarkdown ? 'Pronto para download' : 'Internacional'}
          bodyClassName="flex flex-col gap-3 p-3.5"
        >
          {principal ? (
            principal.inglesMarkdown ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3 max-md:flex-col max-md:items-start">
                  <div className="flex items-center gap-3">
                    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-blue/40 bg-blue/10 text-blue-deep">
                      <Globe size={20} />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-ink">{principal.nome.replace(/\.[^.]+$/, '')}-EN.pdf</p>
                      <p className="text-xs text-ink-soft tabular-nums">
                        {principal.traduzidoEm ? `Traduzido em ${dataHora(principal.traduzidoEm)} • ` : ''}
                        Formatado em A4 com termos técnicos padronizados
                      </p>
                    </div>
                  </div>
                  <span className="flex items-center gap-1 rounded-[9px] border border-blue/40 bg-blue/10 px-2 py-0.5 text-[11px] font-bold text-blue-deep">
                    <Check size={13} aria-hidden />
                    Versão em inglês disponível
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {principal.inglesPdf && (
                    <a
                      href={urlDownloadArquivo(principal.inglesPdf, `${principal.nome.replace(/\.[^.]+$/, '')}-EN.pdf`)}
                      download={`${principal.nome.replace(/\.[^.]+$/, '')}-EN.pdf`}
                      className="btn btn-primary btn-sm"
                    >
                      <Download size={15} aria-hidden />
                      Baixar em Inglês (PDF)
                    </a>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setVerIngles(v => !v)}>
                    <FileText size={14} aria-hidden />
                    {verIngles ? 'Ocultar texto' : 'Ver texto em inglês'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm text-ink-soft"
                    disabled={traduzindo}
                    onClick={() => gerarVersaoIngles(true)}
                    title="Reexecuta a tradução do currículo principal"
                  >
                    <RefreshCw size={13} aria-hidden className={traduzindo ? 'animate-spin' : ''} />
                    {traduzindo ? 'Traduzindo...' : 'Regenerar tradução'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={salvandoNovo}
                    onClick={salvarComoSeparado}
                    title="Adiciona esta versão em inglês como um currículo independente na lista 'Meus currículos'"
                  >
                    <FolderPlus size={14} aria-hidden />
                    {salvandoNovo ? 'Salvando...' : 'Adicionar aos Meus Currículos'}
                  </button>
                </div>

                {erroTraducao && (
                  <p role="alert" className="text-xs font-bold text-orange-deep">
                    {erroTraducao}
                  </p>
                )}

                {verIngles && (
                  <div className="flex flex-col gap-2 rounded-lg border border-panel-border bg-page-bg p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-ink-soft">Markdown traduzido:</span>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={copiarIngles}>
                        {copiado ? <CopyCheck size={13} className="text-green-dark" /> : <Copy size={13} />}
                        {copiado ? 'Copiado!' : 'Copiar texto'}
                      </button>
                    </div>
                    <pre className="max-h-[320px] overflow-auto font-mono text-[11px] whitespace-pre-wrap">{principal.inglesMarkdown}</pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                <p className="text-xs text-ink-soft">
                  Transforme todo o seu currículo em inglês profissional com diagramação A4 limpa. Preserva suas competências, histórico e métricas — ideal para vagas internacionais (Workable,
                  Arbeitnow, Indeed e empresas globais).
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <button type="button" className="btn btn-primary btn-sm self-start" disabled={traduzindo || !principal.markdown} onClick={() => gerarVersaoIngles(false)}>
                    <Languages size={15} aria-hidden className={traduzindo ? 'animate-spin' : ''} />
                    {traduzindo ? 'Traduzindo currículo para inglês...' : 'Transformar currículo em Inglês'}
                  </button>
                </div>
                {erroTraducao && (
                  <p role="alert" className="text-xs font-bold text-orange-deep">
                    {erroTraducao}
                  </p>
                )}
              </div>
            )
          ) : (
            <p className="py-2 text-center text-xs text-ink-soft">Envie um currículo principal acima para habilitar a transformação em inglês.</p>
          )}
        </Panel>

        <Panel icon={ScanSearch} title="Perfil de busca" tone="purple" aside={perfil ? 'extraído do currículo principal' : undefined} bodyClassName="flex flex-col gap-3 p-3.5">
          {perfil ? (
            <>
              <dl className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
                {[
                  ['Área', perfil.area],
                  ['Senioridade', perfil.senioridade],
                  ['Cargos', perfil.cargos.join(', ') || '—'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-panel-border p-2.5">
                    <dt className="text-[11px] text-ink-soft">{k}</dt>
                    <dd className="text-[13px] font-bold">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="label mb-0">Competências encontradas:</span>
                {perfil.skills.length ? (
                  perfil.skills.map(s => (
                    <span key={s} className="rounded-[9px] border border-blue/40 bg-blue/10 px-2 py-[3px] text-[11px] font-bold text-blue-deep">
                      {s}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-ink-soft">nenhuma do dicionário — a busca vai se apoiar só nos cargos</span>
                )}
              </div>
              <p className="text-[11px] text-ink-soft">É com isto que o robô escolhe e pontua as vagas. A adaptação por vaga só usa competências que já estão aqui — nada é inventado.</p>
              <button type="button" className="btn btn-secondary btn-sm self-start" onClick={() => setVerTexto(v => !v)}>
                {verTexto ? 'Ocultar texto extraído' : 'Ver texto extraído do PDF'}
              </button>
              {verTexto && <pre className="max-h-[320px] overflow-auto rounded-lg border border-panel-border bg-page-bg p-3 font-mono text-[11px] whitespace-pre-wrap">{principal?.markdown}</pre>}
            </>
          ) : (
            <p className="py-2 text-center text-xs text-ink-soft">
              {principal ? 'Não consegui extrair texto deste arquivo. Envie o currículo em PDF com texto (não escaneado).' : 'Envie um currículo em PDF para montar o perfil.'}
            </p>
          )}
        </Panel>
      </div>

      <Panel icon={History} title="Meus currículos" tone="orange" bodyClassName="flex flex-col gap-2.5 p-3.5">
        {curriculos.length === 0 ? (
          <p className="py-4 text-center text-xs text-ink-soft">A lista aparece aqui conforme você envia currículos.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {curriculos.map((c, i) => (
              <li key={c.id} className={`flex flex-col gap-2 rounded-[7px] border p-2.5 ${i === 0 ? 'border-green-dark ring-1 ring-green-dark' : 'border-panel-border'}`}>
                <div className="flex items-center gap-2">
                  <FileText size={16} aria-hidden className="shrink-0 text-ink-soft" />
                  <p className="min-w-0 flex-1 truncate text-xs font-bold">{c.nome}</p>
                  {i === 0 && <span className="rounded-lg bg-green-deep px-[7px] py-0.5 text-[10px] font-bold text-white">principal</span>}
                </div>
                <p className="text-[11px] text-ink-soft tabular-nums">
                  {formatarTamanho(c.tamanho)} • {dataHora(c.enviadoEm)} • {c.perfilBusca ? `${c.perfilBusca.skills.length} competências` : 'sem texto extraído'}
                </p>
                <div className="flex flex-col gap-1.5">
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={i === 0} onClick={() => tornarPrincipal(c.id)}>
                      <Check size={14} aria-hidden />
                      Tornar principal<span className="sr-only"> {c.nome}</span>
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm text-orange-deep" onClick={() => remover(c.id)}>
                      <Trash2 size={14} aria-hidden />
                      Remover<span className="sr-only"> {c.nome}</span>
                    </button>
                  </div>
                  {c.caminho && (
                    <a href={urlDownloadArquivo(c.caminho, c.nome)} download={c.nome} className="btn btn-secondary btn-sm w-full" title={`Baixar ${c.nome}`}>
                      <Download size={13} aria-hidden />
                      Baixar PDF
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
