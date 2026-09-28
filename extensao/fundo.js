// Ponte entre o content script e o núcleo do AutoCV (http://127.0.0.1:4780).
//
// Por que a ponte mora aqui e não no content script: o service worker tem `host_permissions` e fala com o núcleo
// sem esbarrar no CORS nem na CSP do site visitado. O content script nunca fala com o núcleo direto.
//
// Segurança: o núcleo é um servidor local sem senha. Qualquer extensão instalada poderia conversar com ele, por
// isso toda rota `/extensao/*` exige o token que o AutoCV mostra em Plataformas — a pessoa cola no popup uma vez.
const NUCLEO = 'http://127.0.0.1:4780';
const VALIDADE_MS = 7 * 24 * 60 * 60 * 1000; // plataformas mudam o fluxo de login: a detecção reexpira sozinha

const token = async () => (await chrome.storage.local.get('token')).token ?? '';

async function paraONucleo(caminho, dados) {
  const t = await token();
  if (!t) throw new Error('sem token: abra o popup do AutoCV e cole o token que aparece em Plataformas');
  const r = await fetch(NUCLEO + caminho, {
    method: dados === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: dados === undefined ? undefined : JSON.stringify(dados),
  });
  if (!r.ok) throw new Error(`${(await r.json().catch(() => ({}))).erro ?? r.status}`);
  return r.json();
}

/** Cache por domínio: não reavaliar a mesma plataforma a cada vaga aberta. `forcar` invalida na hora. */
async function cacheValido(dominio, forcar) {
  if (forcar) return null;
  const { deteccoes = {} } = await chrome.storage.local.get('deteccoes');
  const c = deteccoes[dominio];
  return c && Date.now() - c.em < VALIDADE_MS ? c : null;
}

async function guardarCache(dominio, dados) {
  const { deteccoes = {} } = await chrome.storage.local.get('deteccoes');
  deteccoes[dominio] = { ...dados, em: Date.now() };
  await chrome.storage.local.set({ deteccoes });
}

chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  (async () => {
    try {
      if (msg.tipo === 'CACHE') return responder({ ok: true, cache: await cacheValido(msg.dominio, msg.forcar) });
      if (msg.tipo === 'PERFIL') return responder({ ok: true, perfil: await paraONucleo('/extensao/perfil') });
      if (msg.tipo === 'PLATAFORMA_DETECTADA') {
        await guardarCache(msg.dominio, { precisaLogin: msg.precisaLogin, logadoAtualmente: msg.logadoAtualmente });
        return responder({ ok: true, ...(await paraONucleo('/extensao/plataforma', msg)) });
      }
      if (msg.tipo === 'VALIDACAO_CAMPOS') return responder({ ok: true, ...(await paraONucleo('/extensao/campos', msg)) });
      responder({ ok: false, erro: `tipo desconhecido: ${msg.tipo}` });
    } catch (e) {
      responder({ ok: false, erro: e.message });
    }
  })();
  return true; // resposta assíncrona
});
