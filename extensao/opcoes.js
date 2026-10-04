// Tela de Configurações da extensão. Grava em chrome.storage.local pelo service worker — a extensão é dona
// desta configuração e funciona com o ACV fechado.
const $ = id => document.getElementById(id);
const aoFundo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));
const { PADRAO } = globalThis.ACVComum;
const { catalogo } = globalThis.ACVPlataformas;

let sujo = false;

let cfg = { ...PADRAO };
let empresas = [];

const dinheiro = v => (v ? `R$ ${Number(v).toLocaleString('pt-BR')}` : 'não informada');

function pintarEmpresas() {
  $('empresas').innerHTML = '';
  $('semEmpresas').hidden = empresas.length > 0;
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
    const id = `limite-${dominio.replace(/\W/g, '-')}`;
    const rot = document.createElement('label');
    rot.setAttribute('for', id); // era um <label> órfão, sem `for`, com aria-label no input
    rot.textContent = dominio;
    const n = document.createElement('input');
    n.className = 'field';
    n.id = id;
    n.type = 'number';
    n.min = '1';
    n.max = '100';
    n.value = String(valor);
    n.addEventListener('input', () => {
      cfg.limiteDiarioPorPlataforma[dominio] = Math.max(1, Number(n.value) || 1);
      marcarSujo();
    });
    campo.appendChild(rot);
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
  pintarEmpresas();
  pintarLimites();
  mostrarSincronia(await aoFundo({ tipo: 'STATUS' }));
  pintarSites();
  // Qualquer mexida num campo marca a tela como suja: antes dava para fechar a aba e perder tudo em silêncio
  for (const el of document.querySelectorAll('input')) el.addEventListener('input', marcarSujo);
  sujo = false;
  $('estado').textContent = '';
}

/**
 * A lista que o núcleo já servia e a extensão nunca mostrou.
 *
 * As ressalvas (`vagas já varridas`, `conta não ligada`) explicam ANTES do clique o que hoje só se descobre
 * pelo erro — "esta vaga ainda não está na lista do ACV" e "cliquei e não fez nada".
 */
async function pintarSites() {
  const { plataformas = [] } = (await aoFundo({ tipo: 'PLATAFORMAS' })) ?? {};
  const lista = catalogo({ plataformas });
  $('semSites').hidden = lista.length > 0;
  $('sites').innerHTML = lista
    .map(
      p => `<li>
        <span class="nome">${p.nome}</span>
        <span class="pilula pilula-${p.tom}">${p.pilula}</span>
        ${p.avisos.map(a => `<span class="pilula pilula-${a.tom}">${a.texto}</span>`).join('')}
        <span class="dominios">${p.dominios.join(', ')}</span>
        <p class="nota">${p.nota}</p>
      </li>`,
    )
    .join('');
}

function marcarSujo() {
  if (sujo) return;
  sujo = true;
  $('estado').textContent = 'Alterações não salvas.';
  $('estado').classList.add('sujo');
}

function mostrarSincronia(st) {
  if (!st) return;
  const quando = st.cacheEm ? new Date(st.cacheEm).toLocaleString('pt-BR') : null;
  $('sincronia').textContent = st.sincronizado
    ? `Conectado ao ACV. Última cópia: ${quando}.${st.temCurriculo ? ' Currículo em cache.' : ' Sem currículo em cache ainda.'}`
    : quando
      ? `ACV fechado — operando com a cópia de ${quando}.${st.pendentes ? ` ${st.pendentes} candidatura(s) esperando para subir.` : ''}`
      : 'ACV fechado e ainda sem cópia dos seus dados. Abra o start.bat.';
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
  // O salvamento corrigia valores em silêncio (`Math.max(5, …)` e a troca do intervalo máximo). Agora ele
  // conta o que ajustou: mudar o número da pessoa sem avisar é pior do que recusar.
  const ajustes = [];
  if (Number($('intervaloMinSegundos').value) < 5) ajustes.push('a espera mínima subiu para 5 s');
  if (novo.intervaloMaxSegundos < novo.intervaloMinSegundos) {
    novo.intervaloMaxSegundos = novo.intervaloMinSegundos;
    ajustes.push(`a espera máxima subiu para ${novo.intervaloMinSegundos} s (não pode ser menor que a mínima)`);
  }
  const r = await aoFundo({ tipo: 'CONFIG_GRAVAR', cfg: novo });
  cfg = r?.cfg ?? novo;
  $('intervaloMaxSegundos').value = String(cfg.intervaloMaxSegundos);
  sujo = false;
  $('estado').classList.remove('sujo');
  $('estado').textContent = ajustes.length ? `Salvo — ${ajustes.join('; ')}.` : 'Salvo.';
  setTimeout(() => {
    if (!sujo) $('estado').textContent = '';
  }, 4000);
});

// Fechar a aba com alteração pendente deixava de avisar
globalThis.addEventListener('beforeunload', e => {
  if (!sujo) return;
  e.preventDefault();
  e.returnValue = '';
});

$('sincronizar').addEventListener('click', async () => {
  $('estado').textContent = 'Sincronizando...';
  const r = await aoFundo({ tipo: 'SINCRONIZAR' });
  $('estado').textContent = r?.ok ? 'Sincronizado.' : `Não consegui: ${r?.erro ?? 'ACV fechado'}`;
  mostrarSincronia(await aoFundo({ tipo: 'STATUS' }));
  await pintarSites();
});

carregar();
