const $ = id => document.getElementById(id);
const aoFundo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));
const mostrar = (msg, erro = false) => {
  $('saida').textContent = msg;
  $('saida').className = erro ? 'erro' : '';
};

async function pintar() {
  const st = await aoFundo({ tipo: 'STATUS' });
  if (!st?.ok && !st?.cfg) return mostrar('não consegui ler o estado da extensão', true);
  const quando = st.cacheEm ? new Date(st.cacheEm).toLocaleString('pt-BR') : 'nunca';
  $('conexao').innerHTML = st.sincronizado
    ? '<span class="etiqueta ok">AutoCV conectado</span>'
    : `<span class="etiqueta atencao">operando em cache</span><br><small>cópia de ${quando}${st.pendentes ? ` · ${st.pendentes} candidatura(s) a sincronizar` : ''}</small>`;
  $('hoje').innerHTML = Object.entries(st.hoje ?? {})
    .map(([d, c]) => `<tr><td>${d}${c.aquecendo ? ' <span class="etiqueta atencao">aquecendo</span>' : ''}</td><td class="n">${c.feitasHoje} / ${c.limite}</td></tr>`)
    .join('');
}

$('config').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('sincronizar').addEventListener('click', async () => {
  mostrar('sincronizando...');
  const r = await aoFundo({ tipo: 'SINCRONIZAR' });
  mostrar(r?.ok ? 'Sincronizado com o AutoCV.' : `Não consegui: ${r?.erro ?? 'AutoCV fechado'}`, !r?.ok);
  pintar();
});

// A detecção fica em cache por domínio: plataforma muda o fluxo de login com o tempo
$('reavaliar').addEventListener('click', async () => {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(aba.id, { tipo: 'REAVALIAR' }, r => {
    if (chrome.runtime.lastError) return mostrar('Esta página não foi lida pela extensão (recarregue e tente de novo).', true);
    if (!r?.ok) return mostrar(r?.erro ?? 'não consegui avaliar', true);
    const conta = r.precisaLogin === true ? 'exige conta' : r.precisaLogin === false ? 'não exige conta' : 'não sei dizer se exige conta';
    mostrar(`${r.dominio}\nhandler: ${r.handler}\n${conta}${r.logadoAtualmente ? ' · você está logado' : ''}\n${r.campos.length} campo(s) no formulário`);
  });
});

pintar();
