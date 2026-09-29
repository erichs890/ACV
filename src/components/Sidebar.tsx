import { NavLink } from 'react-router-dom';
import { Bot, FileText, Gauge, Plug, Settings, type LucideIcon } from 'lucide-react';
import type { EstadoRobo } from '../types';
import Logo from './Logo';
import { useEstado } from '../estado';
import { enviosDoMes } from '../dados';

export const navItens: { to: string; label: string; curto: string; icon: LucideIcon }[] = [
  { to: '/painel', label: 'Painel', curto: 'Painel', icon: Gauge },
  { to: '/curriculo', label: 'Currículo', curto: 'Currículo', icon: FileText },
  { to: '/plataformas', label: 'Plataformas', curto: 'Plataformas', icon: Plug },
  { to: '/automacao', label: 'Automação', curto: 'Automação', icon: Bot },
  { to: '/configuracoes', label: 'Configurações', curto: 'Config.', icon: Settings },
];

export const statusRobo: Record<EstadoRobo, { texto: string; dot: string }> = {
  ativo: { texto: 'Robô ativo', dot: 'bg-aqua' },
  pausado: { texto: 'Robô parado', dot: 'bg-ink-soft' },
  erro: { texto: 'Robô com erro', dot: 'bg-orange' },
};

interface Props {
  aberto: boolean;
  onFechar: () => void;
}

export default function Sidebar({ aberto, onFechar }: Props) {
  const { estado } = useEstado();
  const status = statusRobo[estado.robo];
  const enviosNoMes = enviosDoMes(estado.envios).length;

  return (
    <>
      {aberto && <button type="button" aria-label="Fechar menu" onClick={onFechar} className="fixed inset-0 z-30 bg-black/60 md:hidden" />}
      <aside
        onKeyDown={e => e.key === 'Escape' && onFechar()}
        className={`flex w-[220px] shrink-0 flex-col border-r border-black/50 bg-linear-to-b from-side-top to-side-bottom max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 ${aberto ? '' : 'max-md:hidden'}`}
      >
        <div className="flex h-[91px] shrink-0 flex-col justify-center gap-2 border-b border-black/50 bg-white/5 px-4">
          <Logo className="h-[50px] text-white" />
          <span className="text-[11px] whitespace-nowrap text-white/70">envio automático de currículos</span>
        </div>

        <nav aria-label="Principal" className="flex flex-col gap-[3px] px-2 py-2.5">
          {navItens.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onFechar}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-2.5 py-[9px] text-sm font-bold transition-colors ${
                  isActive ? 'bg-blue-dark text-white ring-1 ring-blue-deep ring-inset' : 'text-white/80 hover:bg-white/10 hover:text-white active:bg-white/15'
                }`
              }
            >
              <Icon size={18} aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="flex-1" />

        <dl className="m-3 flex flex-col gap-2 rounded-lg border border-white/15 bg-white/5 p-3 text-[11px] text-white/70">
          <div className="flex items-center justify-between gap-2">
            <dt>Envios este mês</dt>
            <dd className="text-[13px] font-bold text-white tabular-nums">{enviosNoMes}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt>Plataformas conectadas</dt>
            <dd className="text-[13px] font-bold text-white tabular-nums">{Object.keys(estado.conexoes).length}</dd>
          </div>
        </dl>

        <div role="status" className="flex h-10 shrink-0 items-center gap-2 border-t border-black/50 px-4 text-xs font-bold">
          <span aria-hidden className={`size-2.5 rounded-full ${status.dot}`} />
          <span className={estado.robo === 'ativo' ? 'text-aqua' : 'text-white/80'}>{status.texto}</span>
        </div>
      </aside>
    </>
  );
}
