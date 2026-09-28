// Diagnóstico universal de página de vaga, no SEU navegador (nenhuma automação aqui: nada é preenchido, clicado
// ou enviado — esta etapa só olha e relata).
//
// Arquitetura (espelha `PlatformAdapter` do núcleo): um `PlatformHandler` por plataforma com particularidade, e o
// `GENERICO` para todo o resto. Domínio sem handler dedicado já funciona pelo genérico, sem código novo.
//
//   interface PlatformHandler {
//     dominios: string[];                  // sufixos de domínio ("indeed.com" cobre br.indeed.com)
//     detectaTelaLogin(): boolean;         // a página ATUAL é a tela de login?
//     precisaLogin(): {precisa, logado, motivo};  // a plataforma exige conta? (null = não sei)
//     descobrirCamposFormulario(): Campo[];       // leitura, sem preencher
//   }
//
// `preencherCampo`, `avancarEtapa` e `detectaEnvioConcluido` chegam com o motor de preenchimento (Parte D); por
// enquanto quem preenche é o núcleo, via Playwright. Handler dedicado sobrescreve só o que difere e chama o
// genérico no resto — é para isso que `GENERICO` é exportado abaixo.
(() => {
  const texto = el => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const visivel = el => !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const todos = sel => [...document.querySelectorAll(sel)];

  const URL_LOGIN = /\/(login|log-in|signin|sign-in|entrar|acessar|auth|authenticate|account\/login|session)/i;
  const TEXTO_CANDIDATAR = /candidat|inscrever|aplicar|apply|enviar (o )?curr[íi]culo|quero me candidatar/i;
  const TEXTO_SAIR = /^(sair|logout|log ?out|sign ?out|encerrar sess[ãa]o|desconectar)$/i;
  // Sinais de sessão ativa: menu de conta, avatar, "Sair". Genéricos de propósito — valem em site nenhum específico.
  const SINAIS_LOGADO = '[aria-label*="conta" i],[aria-label*="perfil" i],[aria-label*="account" i],[aria-label*="profile" i],img[alt*="avatar" i],[data-testid*="avatar" i],[class*="avatar" i]';

  // ─── Descoberta de campos (leitura) ───────────────────────────────────────────────────────────
  const IGNORAR = /^(q|search|busca|keyword|where|onde|location_search|csrf|token|utm)/i;

  /** Rótulo do campo: <label for>, aria-label, aria-labelledby, <label> em volta, placeholder — nessa ordem. */
  function rotuloDe(campo) {
    const porId = campo.id && document.querySelector(`label[for="${CSS.escape(campo.id)}"]`);
    const porAria = campo.getAttribute('aria-labelledby') && document.getElementById(campo.getAttribute('aria-labelledby'));
    return (
      texto(porId) ||
      campo.getAttribute('aria-label') ||
      texto(porAria) ||
      texto(campo.closest('label')) ||
      campo.placeholder ||
      texto(campo.closest('[class*="field" i],[class*="campo" i],[class*="form-group" i]')).slice(0, 80) ||
      textoAcima(campo) ||
      campo.name ||
      ''
    ).trim();
  }

  const tipoDe = campo => {
    const t = campo.tagName.toLowerCase();
    if (t === 'select') return 'lista';
    if (t === 'textarea') return 'texto_longo';
    if (campo.getAttribute('role') === 'combobox' || campo.getAttribute('aria-haspopup') === 'listbox') return 'lista';
    return { file: 'arquivo', email: 'email', tel: 'telefone', number: 'numero', checkbox: 'caixa', radio: 'opcao' }[campo.type] ?? 'texto';
  };

  /**
   * O texto que vem logo acima/antes do campo. Último recurso antes de cair no `name` técnico ("country",
   * "phoneCountry"), e o único jeito de nomear um grupo de rádios sem <fieldset> — sem ele a pergunta "Você já
   * trabalhou aqui?" virava a pergunta "Não", que é a primeira opção. Sobe no máximo 4 níveis e ignora qualquer
   * bloco que contenha campos (senão pegaria a pergunta anterior do formulário).
   */
  function textoAcima(el) {
    for (let no = el, i = 0; no && i < 4; no = no.parentElement, i++) {
      for (let irmao = no.previousElementSibling; irmao; irmao = irmao.previousElementSibling) {
        const t = texto(irmao);
        if (t && t.length < 160 && !irmao.querySelector('input,select,textarea,[role="combobox"]')) return t;
      }
    }
    return '';
  }

  /** Pergunta de um grupo de opções: legenda do fieldset ou rótulo do radiogroup. Vazio para campo comum. */
  function rotuloDoGrupo(campo) {
    if (campo.type !== 'radio' && campo.type !== 'checkbox') return '';
    let grupo = campo.closest('fieldset,[role="radiogroup"],[role="group"]');
    if (!grupo && campo.name) {
      // Sobe até o bloco que contém TODAS as opções do mesmo name — aí o texto acima dele é a pergunta
      const total = document.getElementsByName(campo.name).length;
      for (let no = campo.parentElement, i = 0; no && i < 5; no = no.parentElement, i++) {
        if (no.querySelectorAll(`[name="${CSS.escape(campo.name)}"]`).length === total) {
          grupo = no;
          break;
        }
      }
    }
    if (!grupo) return '';
    return texto(grupo.querySelector('legend')) || grupo.getAttribute('aria-label') || texto(document.getElementById(grupo.getAttribute('aria-labelledby'))) || textoAcima(grupo);
  }

  /**
   * Onde está o formulário de candidatura: o diálogo aberto, senão o <form> com mais campos visíveis, senão a
   * página inteira. Sem supor layout — o mesmo princípio do motor do núcleo.
   */
  function areaDoFormulario() {
    const dialogo = todos('dialog[open],[role="dialog"],[aria-modal="true"]').find(visivel);
    if (dialogo) return dialogo;
    const forms = todos('form')
      .map(f => ({ f, n: [...f.querySelectorAll('input,select,textarea')].filter(visivel).length }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n);
    return forms[0]?.f ?? document.body;
  }

  function descobrirCamposFormulario() {
    const area = areaDoFormulario();
    const vistos = new Set();
    return [...area.querySelectorAll('input,select,textarea,[role="combobox"]')]
      .filter(c => visivel(c) && !['hidden', 'submit', 'button', 'search', 'image'].includes(c.type) && !IGNORAR.test(c.name || ''))
      .map(c => {
        // Rádio/caixa: a pergunta é a do GRUPO (legenda do fieldset), não o rótulo da opção — senão "Regime: CLT/PJ"
        // viraria a pergunta "CLT"
        const rotulo = rotuloDoGrupo(c) || rotuloDe(c);
        // Rádio e caixa do mesmo grupo são UMA pergunta
        const chave = c.type === 'radio' ? `radio:${c.name}` : `${rotulo}|${c.name}|${c.type}`;
        if (!rotulo || vistos.has(chave)) return null;
        vistos.add(chave);
        const marcado = c.required || c.getAttribute('aria-required') === 'true' || /\*\s*$/.test(rotulo);
        // "Não sei dizer" é resposta legítima: o núcleo manda revisar à mão em vez de fingir certeza
        const dentroDeOpcional = /opcional|optional/i.test(rotulo);
        return { pergunta: rotulo.replace(/\s*\*\s*$/, '').slice(0, 120), tipo: tipoDe(c), obrigatorio: marcado, incerto: !marcado && !dentroDeOpcional };
      })
      .filter(Boolean);
  }

  // ─── Precisa de conta? ────────────────────────────────────────────────────────────────────────
  const detectaTelaLogin = () => URL_LOGIN.test(location.pathname) || (!!document.querySelector('input[type="password"]') && !!document.querySelector('form'));

  const botaoCandidatar = () =>
    todos('a,button,[role="button"]')
      .filter(visivel)
      .find(e => TEXTO_CANDIDATAR.test(texto(e)) && texto(e).length < 60);

  /**
   * Conservador por definição: só afirma "exige conta" quando a própria página mostra isso (o botão de
   * candidatura aponta para o login, ou há formulário de senha). Na dúvida devolve `null` — quem decide é a
   * pessoa. NÃO clica no botão para descobrir: um clique automático aqui seria uma ação no site sem o seu aval.
   */
  function precisaLogin() {
    const logado = todos(SINAIS_LOGADO).some(visivel) || todos('a,button').some(e => TEXTO_SAIR.test(texto(e)));
    if (detectaTelaLogin()) return { precisa: true, logado: false, motivo: 'esta é a tela de login da plataforma' };
    const botao = botaoCandidatar();
    const destino = botao?.getAttribute('href') ?? botao?.closest('form')?.getAttribute('action') ?? '';
    if (destino && URL_LOGIN.test(destino)) return { precisa: true, logado, motivo: 'o botão de candidatura leva para a tela de login' };
    if (document.querySelector('input[type="password"]')) return { precisa: true, logado, motivo: 'a página tem campo de senha' };
    if (logado) return { precisa: null, logado: true, motivo: 'você já está logado aqui, então não dá para saber se a candidatura exige conta' };
    // Formulário de candidatura na própria página (e-mail ou anexo à vista, sem senha): dá para candidatar sem conta
    const campos = descobirCamposSeguro();
    if (campos.length >= 3 && campos.some(c => c.tipo === 'email' || c.tipo === 'arquivo')) return { precisa: false, logado, motivo: 'o formulário de candidatura está na própria página' };
    if (botao) return { precisa: null, logado: false, motivo: 'o botão de candidatura não revela o destino (pode abrir um modal); revise manualmente' };
    return { precisa: null, logado, motivo: 'não achei o botão de candidatura nesta página' };
  }

  const descobirCamposSeguro = () => {
    try {
      return descobrirCamposFormulario();
    } catch {
      return [];
    }
  };

  const GENERICO = { dominios: [], detectaTelaLogin, precisaLogin, descobrirCamposFormulario };

  // Handler dedicado: o que o núcleo já sabe do Indeed (core/platforms/indeed/seletores.ts), levantado ao vivo.
  const INDEED = {
    dominios: ['indeed.com'],
    detectaTelaLogin: () => /secure\.indeed\.com\/(auth|account)|\/account\/login/i.test(location.href),
    precisaLogin() {
      if (/verifica[çc][ãa]o adicional|additional verification|security check/i.test(document.body.innerText.slice(0, 800)))
        return { precisa: null, logado: false, motivo: 'o Indeed mostrou a verificação anti-robô; não dá para diagnosticar' };
      // "Acessar" é como o Indeed em pt-BR chama o entrar — só aparece deslogado
      const entrar = todos('a,button').some(e => /^\s*(acessar|entrar|sign in)\s*$/i.test(texto(e)) && visivel(e));
      return { precisa: true, logado: !entrar, motivo: entrar ? 'o cabeçalho mostra "Acessar"' : 'o cabeçalho não mostra "Acessar"' };
    },
    descobrirCamposFormulario,
  };

  const REGISTRO = [INDEED];
  const handlerDe = host => REGISTRO.find(h => h.dominios.some(d => host === d || host.endsWith(`.${d}`))) ?? GENERICO;

  // ─── Diagnóstico ──────────────────────────────────────────────────────────────────────────────
  const dominioBase = host => host.replace(/^www\./, '');

  /** Só reporta o que é mesmo página de vaga: anúncio com JobPosting ou botão de candidatura à vista. */
  const pareceVaga = () => todos('script[type="application/ld+json"]').some(s => /"@type"\s*:\s*"?JobPosting/i.test(s.textContent ?? '')) || !!botaoCandidatar() || URL_LOGIN.test(location.pathname);

  function diagnosticar() {
    const handler = handlerDe(location.hostname);
    const login = handler.precisaLogin();
    return {
      dominio: dominioBase(location.hostname),
      url: location.href,
      handler: handler === GENERICO ? 'generico' : handler.dominios[0],
      precisaLogin: login.precisa,
      logadoAtualmente: login.logado,
      motivo: login.motivo,
      telaDeLogin: handler.detectaTelaLogin(),
      campos: handler.descobrirCamposFormulario(),
    };
  }

  // O que o núcleo diz que já tem no perfil (só quais campos existem; valor nenhum sai do núcleo)
  const CONHECIDOS = [
    [/nome|full name/i, 'nome'],
    [/e-?mail/i, 'email'],
    [/celular|telefone|whats|phone|contato/i, 'celular'],
    [/linkedin/i, 'linkedin'],
    [/cidade|localidade|munic[íi]pio|estado|uf|city|location/i, 'cidade'],
    [/cpf|documento/i, 'cpf'],
    [/pretens[ãa]o|sal[áa]rio|remunera[çc][ãa]o|salary/i, 'pretensao'],
    [/curr[íi]culo|curriculum|resume|cv\b|anexar/i, 'curriculo'],
    [/regime|tipo de contrata|v[íi]nculo|\bclt\b|\bpj\b/i, 'regime'],
  ];
  const normal = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function temDado(campo, perfil) {
    const achado = CONHECIDOS.find(([re]) => re.test(campo.pergunta));
    if (achado) return perfil.tem?.[achado[1]] === true;
    // Pergunta da empresa: vale se já existe resposta salva parecida (o núcleo manda só os enunciados)
    const p = normal(campo.pergunta);
    return (perfil.perguntas ?? []).some(q => {
      const n = normal(q);
      return n === p || (n.length > 8 && (p.includes(n) || n.includes(p)));
    });
  }

  // Testável fora da extensão (core/extensao-check.ts injeta este arquivo numa página e chama isto)
  const api = { diagnosticar, precisaLogin, descobrirCamposFormulario, handlerDe, temDado, GENERICO, INDEED };
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    globalThis.AutoCVExtensao = api;
    return;
  }

  const aoNucleo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));

  async function reportar(forcar = false) {
    if (!forcar && !pareceVaga()) return;
    const d = diagnosticar();
    const { cache } = await aoNucleo({ tipo: 'CACHE', dominio: d.dominio, forcar });
    // Domínio já avaliado e sem novidade: não repete o relato a cada vaga aberta
    const novidade = !cache || cache.precisaLogin !== d.precisaLogin || cache.logadoAtualmente !== d.logadoAtualmente;
    if (novidade) await aoNucleo({ tipo: 'PLATAFORMA_DETECTADA', ...d, campos: undefined });

    if (!d.campos.length) return;
    const { perfil } = await aoNucleo({ tipo: 'PERFIL' });
    if (!perfil) return;
    const faltando = d.campos.filter(c => (c.obrigatorio || c.incerto) && !temDado(c, perfil));
    if (faltando.length) await aoNucleo({ tipo: 'VALIDACAO_CAMPOS', dominio: d.dominio, url: d.url, camposFaltando: faltando });
  }

  chrome.runtime.onMessage.addListener((msg, _r, responder) => {
    if (msg?.tipo !== 'REAVALIAR') return;
    reportar(true).then(
      () => responder({ ok: true, ...diagnosticar() }),
      e => responder({ ok: false, erro: e.message }),
    );
    return true;
  });

  /**
   * Quando olhar a página.
   *
   * Não basta olhar uma vez ao carregar: site de vaga hoje é aplicativo de uma página só (InHire, Gupy,
   * LinkedIn). No `document_idle` a tela quase sempre ainda está vazia, e trocar de vaga não recarrega nada —
   * some o conteúdo antigo, entra o novo, e nenhum script novo roda. Foi exatamente assim que o primeiro teste
   * contra o InHire real não relatou nada.
   *
   * Então: um observador do DOM, com folga entre as tentativas. Ele cobre os dois casos de uma vez (a tela que
   * demora a renderizar e a navegação interna), e para de tentar depois de algumas rodadas na mesma URL para
   * não ficar varrendo uma página que nunca vai ser vaga.
   */
  const MAX_TENTATIVAS = 30;
  let urlRelatada = '';
  let tentativas = 0;
  let pendente = null;

  function tentar() {
    if (location.href === urlRelatada) return; // esta URL já foi relatada
    if (++tentativas > MAX_TENTATIVAS) return;
    if (!pareceVaga()) return;
    urlRelatada = location.href;
    tentativas = 0;
    reportar().catch(e => console.debug('[AutoCV] não consegui relatar:', e.message)); // nunca atrapalhar a navegação
  }

  const agendar = () => {
    clearTimeout(pendente);
    pendente = setTimeout(tentar, 800); // a tela precisa parar de mudar antes de valer a leitura
  };

  tentar();
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('popstate', agendar);
})();
