import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, RadarIcon, Search } from 'lucide-react';
import { BotaoSalvar } from '../components/BotaoSalvar';
import { useEstado } from '../estado';
import { post } from '../api';
import Orbe from '../components/Orbe';
import { tempoAtras } from '../dados';

// Aba "Descoberta de vagas": ritmo da revarredura (Fonte A) e descoberta de empresas novas via Google (Fonte B)
export default function ConfigDescoberta({ onSalvar }: { onSalvar: (t: string) => void }) {
  const { estado } = useEstado();
  const d = estado.descoberta;
  const [intervalo, setIntervalo] = useState(d.intervaloHoras);
  const [fonteB, setFonteB] = useState(d.fonteB);
  const [cx, setCx] = useState(d.googleCx);
  const [chave, setChave] = useState('');
  const [mostrar, setMostrar] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; msg: string } | null>(null);
  const [buscando, setBuscando] = useState(false);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    await post('/descoberta', { intervaloHoras: intervalo, fonteB, googleCx: cx.trim(), googleKey: chave.trim() || undefined });
    setChave('');
    onSalvar('Configuração de descoberta salva.');
  }

  async function buscarAgora() {
    setBuscando(true);
    setResultado(null);
    try {
      await post('/descoberta', { intervaloHoras: intervalo, fonteB, googleCx: cx.trim(), googleKey: chave.trim() || undefined });
      setChave('');
      await post('/descoberta/buscar');
      setResultado({ ok: true, msg: 'Descoberta iniciada em segundo plano. Acompanhe no log da Automação; as empresas novas aparecem em Plataformas.' });
    } finally {
      setBuscando(false);
    }
  }

  return (
    <form className="flex flex-1 flex-col gap-4" onSubmit={salvar}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-panel-border pb-3">
        <h2 className="text-lg font-bold">Descoberta de vagas</h2>
        <p className="text-xs text-ink-soft">como o robô encontra empresas e vagas no InHire</p>
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-bold">Revarredura das empresas monitoradas</h3>
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
          <label>
            <span className="label">Revisitar cada empresa a cada</span>
            <select value={intervalo} onChange={e => setIntervalo(+e.target.value)} className="field">
              {[1, 3, 6, 12, 24].map(h => (
                <option key={h} value={h}>
                  {h} hora{h > 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-lg border border-panel-border p-2.5 text-xs">
            <p className="text-[11px] text-ink-soft">Última varredura</p>
            <p className="font-bold">{tempoAtras(d.ultimaVarredura)}</p>
          </div>
          <div className="rounded-lg border border-panel-border p-2.5 text-xs">
            <p className="text-[11px] text-ink-soft">Empresas monitoradas</p>
            <p className="font-bold tabular-nums">
              {estado.empresas.filter(e => e.ativo).length} ativas de {estado.empresas.length}
            </p>
          </div>
        </div>
        <p className="text-[11px] text-ink-soft">
          A varredura roda em segundo plano mesmo com o robô parado, com pausa de 2 s entre empresas. Vagas já conhecidas não são reconsultadas; as que sumiram são marcadas como encerradas.
        </p>
      </section>

      <section className="flex flex-col gap-3 border-t border-panel-border pt-3.5">
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={fonteB} onChange={e => setFonteB(e.target.checked)} className="switch" />
          <span>
            <span className="block text-sm font-bold">Descobrir empresas novas automaticamente (1x por dia)</span>
            <span className="block text-[11px] text-ink-soft">
              Consulta o Common Crawl (índice público e gratuito da web) por endereços em *.inhire.app, confirma cada subdomínio na API do InHire e adiciona os ativos à lista. Não precisa de chave.
            </span>
          </span>
        </label>
        <p className="text-xs font-bold">Complemento opcional: Google Programmable Search</p>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <label>
            <span className="label">Chave da Google Custom Search API {d.googleKeyDefinida && <span className="font-normal">— guardada; cole outra para trocar</span>}</span>
            <span className="relative block">
              <input
                type={mostrar ? 'text' : 'password'}
                value={chave}
                onChange={e => setChave(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={d.googleKeyDefinida ? '••••••••••••' : 'AIza...'}
                className="field pr-9 font-mono"
              />
              <button
                type="button"
                aria-label={mostrar ? 'Ocultar chave' : 'Mostrar chave'}
                onClick={() => setMostrar(m => !m)}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-soft hover:text-ink"
              >
                {mostrar ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
              </button>
            </span>
          </label>
          <label>
            <span className="label">ID do mecanismo de busca (cx)</span>
            <input value={cx} onChange={e => setCx(e.target.value)} placeholder="ex.: a1b2c3d4e5f6g7h8i" className="field font-mono" />
            <span className="mt-1 block text-[11px] text-ink-soft">
              Crie em programmablesearchengine.google.com com "pesquisar toda a web"; a chave vem do Google Cloud (Custom Search JSON API, 100 consultas grátis por dia).
            </span>
          </label>
        </div>
        {resultado && (
          <p role="status" className={`text-xs font-bold ${resultado.ok ? 'text-green-deep' : 'text-orange-deep'}`}>
            {resultado.msg}
          </p>
        )}
        <p className="text-[11px] text-ink-soft">Última descoberta: {tempoAtras(d.ultimaFonteB)}. O Google, quando configurado, soma resultados mais recentes aos do Common Crawl.</p>
      </section>

      <div className="sticky bottom-0 mt-auto flex flex-wrap items-center gap-2.5 rounded-lg border border-panel-border bg-panel px-3.5 py-3">
        <RadarIcon size={16} aria-hidden className="shrink-0 text-ink-soft" />
        <p className="flex-1 text-xs text-ink-soft">
          Revarredura a cada {d.intervaloHoras} h · descoberta automática {d.fonteB ? 'ligada' : 'desligada'}
        </p>
        <button type="button" className="btn btn-secondary" disabled={buscando || d.descobrindo} onClick={buscarAgora}>
          <Search size={16} aria-hidden />
          {d.descobrindo && <Orbe estado="procurando" />}
          {d.descobrindo ? 'Procurando...' : 'Descobrir empresas agora'}
        </button>
        <BotaoSalvar>Salvar</BotaoSalvar>
      </div>
    </form>
  );
}
