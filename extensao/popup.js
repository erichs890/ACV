const $ = id => document.getElementById(id);
const mostrar = (msg, erro = false) => {
  $('saida').textContent = msg;
  $('saida').className = erro ? 'erro' : '';
};

chrome.storage.local.get('token').then(({ token }) => {
  if (token) $('token').value = token;
});

$('salvar').addEventListener('click', async () => {
  await chrome.storage.local.set({ token: $('token').value.trim() });
  mostrar('Token salvo.');
});

// "Reavaliar" existe porque a detecção fica em cache por domínio: plataforma muda o fluxo de login com o tempo
$('reavaliar').addEventListener('click', async () => {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(aba.id, { tipo: 'REAVALIAR' }, r => {
    if (chrome.runtime.lastError) return mostrar('Esta página não foi lida pela extensão (recarregue e tente de novo).', true);
    if (!r?.ok) return mostrar(r?.erro ?? 'não consegui avaliar', true);
    const conta = r.precisaLogin === true ? 'exige conta' : r.precisaLogin === false ? 'não exige conta' : 'não sei dizer se exige conta';
    mostrar(`${r.dominio}\nhandler: ${r.handler}\n${conta}${r.logadoAtualmente ? ' · você está logado' : ''}\n${r.campos.length} campo(s) no formulário\n${r.motivo}`);
  });
});
