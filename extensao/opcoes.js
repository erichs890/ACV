// Tela de Configurações da extensão. Grava em chrome.storage.local pelo service worker — a extensão é dona
// desta configuração e funciona com o ACV fechado.
const $ = id => document.getElementById(id);
const aoFundo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));
const { PADRAO } = globalThis.ACVComum;

let cfg = { ...PADRAO };
let empresas = [];

const dinheiro = v => (v ? `R$ ${Number(v).toLocaleString('pt-BR')}` : 'não informada');

function pintarEmpresas() {
  $('empresas').innerHTML = '';
  for (const [i, nome] of empresas.entries()) {
    const li = document.createElement('li');
    li.textContent = nome;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', `Desbloquear ${nome}`);
    x.addEventListener('click', () => {
      empresas.splice(i, 1);
      pintarEmpresas();
    });
    li.appendChild(x);
    $('empresas').appendChild(li);
  }
}

function pintarLimites() {
  $('limites').innerHTML = '';
  for (const [dominio, valor] of Object.entries(cfg.limiteDiarioPorPlataforma ?? {})) {
    const campo = document.createElement('div');
    campo.className = 'linha';
    campo.style.marginTop = '6px';
    campo.innerHTML = `<label style="flex:1;margin:0;align-self:center">${dominio}</label>`;
    const n = document.createElement('input');
    n.type = 'number';
    n.min = '1';
    n.max = '100';
    n.value = String(valor);
    n.setAttribute('aria-label', `Limite diário em ${dominio}`);
    n.addEventListener('input', () => {
      cfg.limiteDiarioPorPlataforma[dominio] = Math.max(1, Number(n.value) || 1);
    });
    campo.appendChild(n);
    $('limites').appendChild(campo);
  }
}

async function carregar() {
  const r = await aoFundo({ tipo: 'CONFIG' });
  cfg = { ...PADRAO, ...(r?.cfg ?? {}) };
  empresas = [...(cfg.empresasBloqueadas ?? [])];
  for (const campo of ['linkedinPerfilUrl', 'anosExperiencia', 'intervaloMinSegundos', 'intervaloMaxSegundos', 'urlApp']) $(campo).value = cfg[campo] ?? '';
  $('pretensaoSalarial').value = String(cfg.pretensaoSalarial ?? 0);
  $('pretensaoTexto').textContent = dinheiro(cfg.pretensaoSalarial);
  $('iaAtiva').checked = !!cfg.iaAtiva;
  $('token').value = (await chrome.storage.local.get('token')).token ?? '';
  pintarEmpresas();
  pintarLimites();
  mostrarSincronia(await aoFundo({ tipo: 'STATUS' }));
}

function mostrarSincronia(st) {
  if (!st) return;
  const quando = st.cacheEm ? new Date(st.cacheEm).toLocaleString('pt-BR') : 'nunca';
  $('sincronia').textContent = st.sincronizado
    ? `Conectado ao ACV. Última cópia: ${quando}.${st.temCurriculo ? ' Currículo em cache.' : ' Sem currículo em cache ainda.'}`
    : `ACV fechado — operando com a cópia de ${quando}.${st.pendentes ? ` ${st.pendentes} candidatura(s) esperando para subir.` : ''}`;
}

$('pretensaoSalarial').addEventListener('input', e => {
  $('pretensaoTexto').textContent = dinheiro(e.target.value);
});

$('addEmpresa').addEventListener('click', () => {
  const nome = $('novaEmpresa').value.trim();
  if (!nome || empresas.some(e => e.toLowerCase() === nome.toLowerCase())) return;
  empresas.push(nome);
  $('novaEmpresa').value = '';
  pintarEmpresas();
});
$('novaEmpresa').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('addEmpresa').click();
});

$('salvar').addEventListener('click', async () => {
  const novo = {
    ...cfg,
    linkedinPerfilUrl: $('linkedinPerfilUrl').value.trim(),
    urlApp: $('urlApp').value.trim() || PADRAO.urlApp,
    pretensaoSalarial: Number($('pretensaoSalarial').value) || 0,
    anosExperiencia: Number($('anosExperiencia').value) || 0,
    empresasBloqueadas: empresas,
    iaAtiva: $('iaAtiva').checked,
    intervaloMinSegundos: Math.max(5, Number($('intervaloMinSegundos').value) || PADRAO.intervaloMinSegundos),
    intervaloMaxSegundos: Math.max(5, Number($('intervaloMaxSegundos').value) || PADRAO.intervaloMaxSegundos),
  };
  if (novo.intervaloMaxSegundos < novo.intervaloMinSegundos) novo.intervaloMaxSegundos = novo.intervaloMinSegundos;
  await chrome.storage.local.set({ token: $('token').value.trim() });
  const r = await aoFundo({ tipo: 'CONFIG_GRAVAR', cfg: novo });
  cfg = r?.cfg ?? novo;
  $('estado').textContent = 'Salvo.';
  setTimeout(() => {
    $('estado').textContent = '';
  }, 2500);
});

$('sincronizar').addEventListener('click', async () => {
  $('estado').textContent = 'Sincronizando...';
  const r = await aoFundo({ tipo: 'SINCRONIZAR' });
  $('estado').textContent = r?.ok ? 'Sincronizado.' : `Não consegui: ${r?.erro ?? 'ACV fechado'}`;
  mostrarSincronia(await aoFundo({ tipo: 'STATUS' }));
});

carregar();
