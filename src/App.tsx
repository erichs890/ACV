import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { CircleAlert, CircleCheck, Info, RefreshCw, X } from 'lucide-react';
import Logo from './components/Logo';
import Orbe from './components/Orbe';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import Footer from './components/Footer';
import BottomNav from './components/BottomNav';
import Cadastro from './pages/Cadastro';
import Painel from './pages/Painel';
import Curriculo from './pages/Curriculo';
import Plataformas from './pages/Plataformas';
import Automacao from './pages/Automacao';
import Configuracoes from './pages/Configuracoes';
import { useEstadoBruto } from './estado';

const titulos: Record<string, string> = {
  '/painel': 'Painel',
  '/curriculo': 'Currículo',
  '/plataformas': 'Plataformas',
  '/automacao': 'Automação',
  '/configuracoes': 'Configurações',
};

const iconeAviso = { sucesso: CircleCheck, erro: CircleAlert, info: Info };
const corAviso = { sucesso: 'border-aqua/60 bg-green-deep text-white', erro: 'border-orange/60 bg-orange-deep text-white', info: 'border-panel-border bg-side-bottom text-white' };

function Layout() {
  const { avisos, fecharAviso } = useEstadoBruto();
  const [menuAberto, setMenuAberto] = useState(false);
  const titulo = titulos[useLocation().pathname] ?? 'ACV';

  useEffect(() => {
    document.title = `${titulo} — ACV`;
  }, [titulo]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar aberto={menuAberto} onFechar={() => setMenuAberto(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar titulo={titulo} onAbrirMenu={() => setMenuAberto(true)} />
        <main className="flex-1 overflow-y-auto p-[18px] max-md:p-[11px] max-md:pb-[70px]">
          <Outlet />
        </main>
        <Footer />
      </div>
      <BottomNav />
      <div role="status" aria-live="polite" className="fixed right-4 bottom-10 z-50 flex w-[340px] max-w-[calc(100%-32px)] flex-col gap-2 max-md:bottom-[70px]">
        {avisos.map(a => {
          const Icone = iconeAviso[a.nivel];
          return (
            <div key={a.id} className={`flex items-start gap-2 rounded-[9px] border px-3.5 py-2.5 text-[13px] font-bold shadow-lg ${corAviso[a.nivel]}`}>
              <Icone size={18} aria-hidden className="mt-px shrink-0" />
              <span className="flex-1">{a.msg}</span>
              <button type="button" aria-label="Fechar aviso" onClick={() => fecharAviso(a.id)} className="rounded p-0.5 hover:bg-white/15">
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Conectando({ offline, tentar }: { offline: boolean; tentar: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-page-bg p-6">
      <div className="w-[460px] max-w-full rounded-lg border border-panel-border bg-panel p-6 text-center">
        <Logo className="mx-auto h-[38px] self-center text-ink" />
        {offline ? (
          <>
            <p className="mt-4 text-sm font-bold">O núcleo do ACV não está rodando.</p>
            <p className="mt-1.5 text-xs text-ink-soft">
              Ele é o processo que busca vagas e preenche candidaturas. Abra o app pelo <code className="font-mono">start.bat</code> ou rode <code className="font-mono">npm run core</code> em outro
              terminal.
            </p>
            <button type="button" className="btn btn-primary mt-4" onClick={tentar}>
              <RefreshCw size={16} aria-hidden />
              Tentar de novo
            </button>
          </>
        ) : (
          <div className="mt-4 flex flex-col items-center gap-2 text-blue-dark">
            <Orbe estado="conectando" tamanho={64} rotulo="Conectando ao núcleo" />
            <p className="text-xs text-ink-soft">Conectando ao núcleo...</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const { estado, offline, recarregar } = useEstadoBruto();

  useEffect(() => {
    if (!estado?.perfil) document.title = 'ACV';
  }, [estado?.perfil]);

  if (!estado) return <Conectando offline={offline} tentar={recarregar} />;

  // Sem cadastro, o app inteiro é o formulário de entrada
  if (!estado.perfil) {
    return (
      <Routes>
        <Route path="*" element={<Cadastro />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="painel" element={<Painel />} />
        <Route path="curriculo" element={<Curriculo />} />
        <Route path="plataformas" element={<Plataformas />} />
        <Route path="automacao" element={<Automacao />} />
        <Route path="configuracoes" element={<Configuracoes />} />
        <Route path="*" element={<Navigate to="/painel" replace />} />
      </Route>
    </Routes>
  );
}
