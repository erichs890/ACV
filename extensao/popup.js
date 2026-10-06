// O popup da barra responde três perguntas, nesta ordem de urgência:
//   1. dá para usar nesta página? (cartão "Esta aba" — é novo, e é o que levou a pessoa a abrir o popup)
//   2. quanto já mandei hoje?
//   3. o ACV está no ar?
//
// Antes eram três botões empilhados de largura total e um `#saida` que recebia despejo de texto cru — com o
// botão primário no lugar errado ("Configurações", que é manutenção).
const $ = id => document.getElementById(id);
const aoFundo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));
const { classificar } = globalThis.ACVPlataformas;

const pilula = (texto, tom = 'neutra') => `<span class="pilula pilula-${tom}">${texto}</span>`;
const quando = iso => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null);

/** Orbe de espera dentro de um elemento, trocado por texto quando a resposta chega. */
function esperando(el, estado = 'conectando') {
  el.textContent = '';
  const o = globalThis.ACVOrbe.criar({ estado, tamanho: 20 });
  el.append(o.el);
  return () => o.destruir();
}

async function pintar() {
  const pararOrbe = esperando($('conexao'));
  const st = await aoFundo({ tipo: 'STATUS' });
  pararOrbe();

  if (!st) {
    $('conexao').innerHTML = pilula('não consegui ler', 'erro');
    return;
  }

  $('conexao').innerHTML = st.sincronizado ? pilula('ACV conectado', 'ok') : pilula(st.cacheEm ? 'operando em cache' : 'desconectado', 'atencao');
  $('ligacao').textContent = st.sincronizado
    ? 'O ACV está no ar e os seus dados estão em dia.'
    : st.cacheEm
      ? `O ACV está fechado. Usando a cópia de ${quando(st.cacheEm)}.${st.pendentes ? ` ${st.pendentes} candidatura(s) esperando para subir.` : ''}`
      : 'Ainda sem cópia dos seus dados. Abra o start.bat — não há nada para configurar.';

  // Contadores do dia: barra por plataforma, e um estado vazio de verdade (antes a tabela só sumia)
  const hoje = Object.entries(st.hoje ?? {});
  $('hoje').innerHTML = hoje.length
    ? hoje
        .map(([dominio, c]) => {
          const pct = c.limite ? Math.min(100, Math.round((c.feitasHoje / c.limite) * 100)) : 0;
          return `<div>
            <div class="topo"><span>${dominio}</span>${c.aquecendo ? pilula('aquecendo', 'atencao') : ''}<span class="conta">${c.feitasHoje} / ${c.limite}</span></div>
            <div class="barra${c.cabem ? '' : ' cheia'}"><span style="width:${pct}%"></span></div>
          </div>`;
        })
        .join('')
    : '<p class="vazio">Nenhuma candidatura hoje ainda.</p>';
}

/** O que esta aba é: plataforma conhecida, motor da extensão, modo genérico — ou nada disso. */
async function pintarAba() {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { plataformas = [] } = (await aoFundo({ tipo: 'PLATAFORMAS' })) ?? {};
  let host = '';
  try {
    const u = new URL(aba?.url ?? '');
    // `chrome-extension://` e `chrome://` TÊM host (o id da extensão), então testar só o host não basta:
    // sem isto o popup se anunciava como um site chamado "ipbiphjgjkolckmeboanhpjmojfpegah".
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
  } catch {
    // aba interna do navegador (about:blank, nova aba) — não há URL
  }
  if (!host) {
    $('abaSite').textContent = 'Esta aba não é uma página da web.';
    $('mostrarPainel').disabled = true;
    $('reavaliar').disabled = true;
    return;
  }
  const sitio = classificar(host, { plataformas, pareceVaga: true });
  $('abaSite').innerHTML = sitio ? `<strong>${sitio.nome}</strong> ${pilula(sitio.pilula, sitio.tom)}<br>${sitio.nota}` : `<strong>${host}</strong><br>Não reconheço este site como mural de vagas.`;
}

/**
 * O interruptor do painel flutuante.
 *
 * Três botões parecidos e três coisas diferentes, então o texto de cada um tem de dizer qual é qual:
 * "Mostrar o painel nesta página" desfaz o `✕` (que vale num site só, até fechar o navegador), e este liga e
 * desliga o painel em TODA página, para sempre, até você religar aqui. O resto da extensão não muda: este
 * popup continua diagnosticando a página e contando o dia.
 */
async function pintarInterruptor() {
  const { cfg } = (await aoFundo({ tipo: 'CONFIG' })) ?? {};
  const ligado = cfg?.painelLigado !== false;
  $('alternarPainel').textContent = ligado ? 'Desativar o painel' : 'Ativar o painel';
  $('estadoPainel').textContent = ligado
    ? 'O painel aparece sobre as páginas de vaga. Desativar some com ele em todos os sites — a extensão continua funcionando por aqui.'
    : 'O painel está desativado e não aparece em site nenhum.';
  $('mostrarPainel').disabled = !ligado;
}

$('alternarPainel').addEventListener('click', async () => {
  const { cfg } = (await aoFundo({ tipo: 'CONFIG' })) ?? {};
  // Só o campo que mudou: `CONFIG_GRAVAR` funde com o que já está lá, e devolver a config inteira de volta
  // faria o popup reescrever (e poder desatualizar) tudo o que a página de Configurações edita.
  await aoFundo({ tipo: 'CONFIG_GRAVAR', cfg: { painelLigado: cfg?.painelLigado === false } });
  await pintarInterruptor(); // as abas abertas reagem sozinhas, pelo onChanged do painel
});

$('mostrarPainel').addEventListener('click', async () => {
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
  await aoFundo({ tipo: 'MOSTRAR_PAINEL', abaId: aba?.id, origem: new URL(aba.url).origin });
  window.close();
});

// `diagnosticar()` devolve um `motivo` legível e pronto, e o popup antigo jogava fora — imprimia
// "handler: generico" e a contagem de campos. Agora é o motivo que aparece.
$('reavaliar').addEventListener('click', async () => {
  const parar = esperando($('diagnostico'), 'procurando');
  const [aba] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(aba.id, { tipo: 'REAVALIAR' }, r => {
    parar();
    if (chrome.runtime.lastError || !r?.ok) {
      $('diagnostico').textContent = 'Esta página não foi lida pela extensão. Recarregue e tente de novo.';
      return;
    }
    const conta = r.precisaLogin === null ? 'não sei dizer se exige conta' : r.precisaLogin ? 'exige conta' : 'não exige conta';
    $('diagnostico').innerHTML =
      [pilula(conta, r.precisaLogin === null ? 'neutra' : 'info'), r.logadoAtualmente ? pilula('você está logado', 'ok') : '', pilula(`${r.campos.length} campo(s)`, 'neutra')].join(' ') +
      (r.motivo ? `<br>${r.motivo}` : '');
  });
});

$('sincronizar').addEventListener('click', async () => {
  const parar = esperando($('ligacao'), 'conectando');
  const r = await aoFundo({ tipo: 'SINCRONIZAR' });
  parar();
  if (!r?.ok) $('ligacao').textContent = `Não consegui: ${r?.erro ?? 'o ACV está fechado'}`;
  else await pintar();
});

$('config').addEventListener('click', () => aoFundo({ tipo: 'ABRIR_OPCOES' }));

pintar();
pintarAba();
pintarInterruptor();
