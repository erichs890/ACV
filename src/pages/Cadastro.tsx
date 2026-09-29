import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, FileText, FolderOpen, Upload } from 'lucide-react';
import Logo from '../components/Logo';
import { useEstadoBruto } from '../estado';
import { enviarCurriculo } from '../api';
import { formatarTamanho, validarCurriculo } from '../dados';
import { TELEFONE_PATTERN, mascaraTelefone, mascarar } from '../mascaras';
import Orbe from '../components/Orbe';

export default function Cadastro() {
  const { salvar } = useEstadoBruto();
  const navegar = useNavigate();
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [erro, setErro] = useState('');
  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(false);

  function escolher(f?: File) {
    if (!f) return;
    const problema = validarCurriculo(f);
    setErro(problema);
    setArquivo(problema ? null : f);
  }

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!arquivo) {
      setErro('Anexe seu currículo para continuar.');
      return;
    }
    const dados = new FormData(e.currentTarget);
    const linkedin = String(dados.get('linkedin'))
      .trim()
      .replace(/^(?!https?:\/\/)/, 'https://'); // aceita "linkedin.com/in/x" e completa o https://
    setEnviando(true);
    try {
      await enviarCurriculo(arquivo); // o núcleo guarda o PDF, extrai o texto e monta o perfil de busca
      await salvar({
        perfil: {
          nome: String(dados.get('nome')).trim(),
          email: String(dados.get('email')).trim(),
          telefone: String(dados.get('telefone')).trim(),
          linkedin,
        },
      });
      navegar('/painel', { replace: true });
    } catch (err) {
      setErro((err as Error).message);
      setEnviando(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-page-bg p-6 max-md:p-3">
      <main className="stagger w-[520px] max-w-full">
        <div className="mb-5 text-center">
          <Logo className="mx-auto h-[38px] self-center text-ink" />
          <p className="mt-1.5 text-xs text-ink-soft">envio automático de currículos</p>
        </div>

        <form onSubmit={enviar} className="flex flex-col gap-4 rounded-lg border border-panel-border bg-panel p-6 max-md:p-4">
          <div>
            <h1 className="text-[19px] font-bold">Vamos começar</h1>
            <p className="mt-1 text-xs text-ink-soft">Precisamos só destes dados para montar o seu painel.</p>
          </div>

          <label>
            <span className="label">Nome completo</span>
            <input name="nome" type="text" required autoComplete="name" placeholder="Como aparece no currículo" className="field h-9" />
          </label>
          <label>
            <span className="label">E-mail</span>
            <input name="email" type="email" required autoComplete="email" placeholder="voce@email.com" className="field h-9" />
          </label>
          <label>
            <span className="label">Telefone</span>
            <input
              name="telefone"
              type="tel"
              required
              autoComplete="tel"
              inputMode="numeric"
              placeholder="(11) 90000-0000"
              pattern={TELEFONE_PATTERN}
              title="DDD e número, ex.: (11) 91234-5678"
              onInput={mascarar(mascaraTelefone)}
              className="field h-9"
            />
          </label>
          <label>
            <span className="label">Link do seu perfil no LinkedIn</span>
            <input
              name="linkedin"
              type="text"
              required
              inputMode="url"
              autoComplete="url"
              placeholder="https://linkedin.com/in/seu-perfil"
              pattern="(https?://)?([a-z]{2,3}\.)?linkedin\.com/.+"
              title="Cole o endereço do seu perfil, ex.: https://linkedin.com/in/seu-perfil"
              className="field h-9"
            />
            <span className="mt-1 block text-[11px] text-ink-soft">As plataformas pedem esse link na candidatura; o robô preenche por você.</span>
          </label>

          <div>
            <span className="label">Currículo</span>
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
                escolher(e.dataTransfer.files[0]);
              }}
              className={`flex flex-col items-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center ${arrastando ? 'border-blue-dark bg-blue/10' : 'border-panel-border'}`}
            >
              {arquivo ? (
                <>
                  <FileText size={22} aria-hidden className="text-green-deep" />
                  <p className="text-[13px] font-bold">{arquivo.name}</p>
                  <p className="text-[11px] text-ink-soft">{formatarTamanho(arquivo.size)}</p>
                </>
              ) : (
                <>
                  <Upload size={22} aria-hidden className="text-ink-soft" />
                  <p className="text-[13px] font-bold">Arraste seu currículo aqui</p>
                  <p className="text-[11px] text-ink-soft">PDF (recomendado) ou DOCX, até 5 MB</p>
                </>
              )}
              <label className="btn btn-secondary btn-sm mt-1">
                <FolderOpen size={14} aria-hidden />
                {arquivo ? 'Trocar arquivo' : 'Selecionar arquivo'}
                <input type="file" accept=".pdf,.docx" className="sr-only" onChange={e => escolher(e.target.files?.[0])} />
              </label>
            </div>
          </div>

          {erro && (
            <p role="alert" className="text-xs font-bold text-orange-deep">
              {erro}
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-lg" disabled={enviando}>
            {enviando && <Orbe estado="lendo" />}
            {enviando ? 'Analisando o currículo...' : 'Entrar no AutoCV'}
            <ArrowRight size={18} aria-hidden />
          </button>
          <p className="text-center text-[11px] text-ink-soft">Seus dados ficam neste computador.</p>
        </form>
      </main>
    </div>
  );
}
