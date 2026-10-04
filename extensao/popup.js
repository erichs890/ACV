const $ = id => document.getElementById(id);
const aoFundo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));
const mostrar = (msg, erro = false) => {
  $('saida').textContent = msg;
  $('saida').className = erro ? 'erro' : '';
};

async function pintar() {
  const st = await aoFundo({ tipo: 'STATUS' });
  if (!st?.ok && !st?.cfg) return mostrar('não consegui ler o estado da extensão', true);
  // Sem cache nenhum a frase vira "cópia de nunca", que não é português. Nesse caso o que a pessoa precisa
  // saber é outra coisa: o servidor nunca respondeu ainda.
  const quando = st.cacheEm ? `cópia de ${new Date(st.cacheEm).toLocaleString('pt-BR')}` : 'ainda sem cópia dos seus dados — abra o server.bat';
  $('conexao').innerHTML = st.sincronizado
    ? '<span class="etiqueta ok">ACV conectado</span>'
    : `<span class="etiqueta atencao">${st.cacheEm ? 'operando em cache' : 'desconectado'}</span><br><small>${quando}${st.pendentes ? ` · ${st.pendentes} candidatura(s) a sincronizar` : ''}</small>`;
  $('hoje').innerHTML = Object.entries(st.hoje ?? {})
    .map(([d, c]) => `<tr><td>${d}${c.aquecendo ? ' <span class="etiqueta atencao">aquecendo</span>' : ''}</td><td class="n">${c.feitasHoje} / ${c.limite}</td></tr>`)
    .join('');
}

$('config').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('sincronizar').addEventListener('click', async () => {
  mostrar('sincronizando...');
  const r = await aoFundo({ tipo: 'SINCRONIZAR' });
  mostrar(r?.ok ? 'Sincronizado com o ACV.' : `Não consegui: ${r?.erro ?? 'ACV fechado'}`, !r?.ok);
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
