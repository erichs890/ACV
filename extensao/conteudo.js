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
  function areaDoFormulario(raiz) {
    if (raiz && raiz !== document) return raiz;
    const dialogo = todos('dialog[open],[role="dialog"],[aria-modal="true"]').find(visivel);
    if (dialogo) return dialogo;
    const forms = todos('form')
      .map(f => ({ f, n: [...f.querySelectorAll('input,select,textarea')].filter(visivel).length }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n);
    return forms[0]?.f ?? document.body;
  }

  /** Campos da etapa atual. Cada um traz o `el` para o motor preencher; o diagnóstico manda só o descritivo. */
  function descobrirCamposFormulario(raiz) {
    const area = areaDoFormulario(raiz);
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
        return { pergunta: rotulo.replace(/\s*\*\s*$/, '').slice(0, 120), tipo: tipoDe(c), obrigatorio: marcado, incerto: !marcado && !dentroDeOpcional, el: c };
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

  /**
   * O que É o botão de candidatura desta página — **sem clicar nele**.
   *
   * Isto existe por causa de uma falha achada no ProgramaThor (04/10/2026) que valia para qualquer site: o
   * motor chamava `abrir()`, que clica no botão "Quero me candidatar" supondo que ele ABRE um formulário. Em
   * quadro de vagas com candidatura de um clique (o currículo já está na conta), aquele botão **é o envio**.
   * O que acontecia: a candidatura saía durante o "abrir", o motor não achava formulário nenhum depois e
   * devolvia `erro` — reportando falha de um envio que já tinha acontecido, e convidando a pessoa a clicar de
   * novo. Dois currículos na mesa do mesmo recrutador, e a invariante 1 do projeto quebrada no meio.
   *
   * `clicarEnvia` responde a única pergunta que importa antes do clique:
   *  - `nao`    — é um link com destino: clicar NAVEGA (foi o caso deslogado do ProgramaThor, que leva ao login)
   *  - `sim`    — é o botão de envio de um `<form method="post">`: clicar MANDA, e o motor trata como etapa final
   *  - `talvez` — botão de JavaScript, destino invisível daqui (é o caso do Easy Apply do LinkedIn, que abre
   *               um diálogo). Clicar é a única forma de saber, então clica — e `motor.js` tem a rede embaixo:
   *               antes de declarar erro por "não achei o botão", confere se houve prova de envio na rede.
   *
   * Serve também de relatório: vai no diagnóstico e para o diário, que é como eu descubro o formulário logado
   * de uma plataforma sem ter a conta de ninguém.
   */
  function reconhecerEnvio(cta) {
    const b = cta ?? botaoCandidatar();
    if (!b) return null;
    const href = b.getAttribute('href') ?? '';
    const form = b.closest('form');
    const metodo = (form?.getAttribute('method') ?? 'get').toLowerCase();
    const tipo = (b.getAttribute('type') ?? '').toLowerCase();
    const navega = !!href && !/^#|^javascript:/i.test(href);
    const submete = !!form && metodo === 'post' && b.tagName !== 'A' && tipo !== 'button';
    return {
      tag: b.tagName.toLowerCase(),
      rotulo: texto(b).slice(0, 60),
      href: href.slice(0, 120),
      classe: String(b.className ?? '').slice(0, 80),
      clicarEnvia: navega ? 'nao' : submete ? 'sim' : 'talvez',
      form: form
        ? {
            action: (form.getAttribute('action') ?? '').slice(0, 120),
            metodo,
            campos: [...form.elements]
              .map(c => c.name)
              .filter(Boolean)
              .slice(0, 25),
          }
        : null,
      el: b,
    };
  }

  const descobirCamposSeguro = () => {
    try {
      return descobrirCamposFormulario();
    } catch {
      return [];
    }
  };

  /** Dados da vaga pelo anúncio estruturado (JobPosting), que metade dos sites de vaga publica. */
  function doJsonLd() {
    for (const s of todos('script[type="application/ld+json"]')) {
      try {
        const bruto = JSON.parse(s.textContent ?? '');
        const j = (Array.isArray(bruto) ? bruto : [bruto, ...(bruto['@graph'] ?? [])]).find(x => /JobPosting/i.test(x?.['@type'] ?? ''));
        if (j) return { titulo: j.title ?? '', empresa: j.hiringOrganization?.name ?? '', descricao: String(j.description ?? '').replace(/<[^>]+>/g, ' ') };
      } catch {
        // anúncio com JSON quebrado é comum; o genérico cai nas heurísticas de DOM
      }
    }
    return null;
  }

  /**
   * Motor genérico: o que vale para plataforma que ninguém mapeou ainda. Handler dedicado sobrescreve só o que
   * difere — é por isso que os textos de botão ficam em expressão, e não em seletor de CSS.
   */
  const GENERICO = {
    dominios: [],
    detectaTelaLogin,
    precisaLogin,
    descobrirCamposFormulario,
    dialogo: () => todos('dialog[open],[role="dialog"],[aria-modal="true"]').find(visivel) ?? null,
    tituloDaVaga: () => doJsonLd()?.titulo || texto(document.querySelector('h1')).slice(0, 180),
    empresaDaVaga: () => doJsonLd()?.empresa || texto(document.querySelector('[class*="company" i],[data-testid*="company" i]')).slice(0, 120),
    descricaoDaVaga: () => (doJsonLd()?.descricao || texto(document.querySelector('[class*="description" i],[id*="description" i]'))).slice(0, 4000),
    reconhecerEnvio,
    abrir() {
      // O formulário já está na página? Então não há o que abrir (InHire, Vagas PJ e afins são assim)
      if (descobrirCamposFormulario().length) return false;
      // `this` é o handler fundido: plataforma com CTA próprio (ProgramaThor) reconhece o botão certo
      const r = this.reconhecerEnvio?.() ?? reconhecerEnvio();
      if (!r) return false;
      // Clicar neste botão JÁ envia: quem clica é a etapa final do motor, com prova de rede, nunca o "abrir"
      if (r.clicarEnvia === 'sim') return 'envia_direto';
      r.el.click();
      return true;
    },
    botaoProximo: /^(avan[çc]ar|continuar|pr[óo]xim[oa]|seguinte|next|continue|revisar|review)/i,
    botaoFinal: /^(enviar( candidatura| curr[íi]culo| inscri[çc][ãa]o)?|continuar inscri[çc][ãa]o|submit( application)?|finalizar|concluir)/i,
    sucesso: /candidatura (foi )?enviada|inscri[çc][ãa]o (foi )?realizada|recebemos (sua|seu)|application (sent|submitted|received)|candidatura conclu[ií]da/i,
  };

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

  /**
   * LinkedIn — "Candidatura simplificada" (Easy Apply): a candidatura acontece num diálogo, em etapas, com
   * "Avançar" → "Revisar" → "Enviar candidatura".
   *
   * NÃO VERIFICADO AO VIVO: exige conta e cada teste criaria candidatura real numa vaga real. Os seletores vêm
   * dos rótulos de acessibilidade que o LinkedIn usa em pt-BR e en, com o texto do botão como reserva. Trate a
   * primeira candidatura como o teste: acompanhe pela janela.
   *
   * AVISO DE CONTA: o LinkedIn proíbe automação no contrato de uso e suspende quem detecta. É a sua conta
   * profissional. Por isso aqui não há disfarce nenhum — só ritmo humano, limite por dia e parada imediata ao
   * primeiro sinal de restrição.
   */
  const LINKEDIN = {
    dominios: ['linkedin.com'],
    detectaTelaLogin: () => /\/(login|uas\/login|checkpoint|authwall)/i.test(location.pathname),
    precisaLogin() {
      if (/\/(login|authwall|checkpoint)/i.test(location.pathname)) return { precisa: true, logado: false, motivo: 'esta é a tela de entrada do LinkedIn' };
      const eu = document.querySelector('.global-nav__me, [data-control-name="nav.settings"], img.global-nav__me-photo');
      return { precisa: true, logado: !!eu, motivo: eu ? 'o seu avatar está no cabeçalho' : 'não achei o seu avatar no cabeçalho' };
    },
    descobrirCamposFormulario,
    // ─── o que o motor precisa saber de específico desta plataforma ───
    dialogo: () => todos('[role="dialog"], .jobs-easy-apply-modal').find(visivel) ?? null,
    empresaDaVaga: () => texto(document.querySelector('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, [data-test-job-card-company-name]')).slice(0, 120),
    tituloDaVaga: () => texto(document.querySelector('h1.job-title, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title')).slice(0, 180),
    descricaoDaVaga: () => texto(document.querySelector('#job-details, .jobs-description__content')).slice(0, 4000),
    abrir: () => {
      const b = todos('button').find(e => visivel(e) && /candidatura simplificada|easy apply/i.test(`${e.getAttribute('aria-label') ?? ''} ${texto(e)}`));
      if (b) b.click();
      return !!b;
    },
    botaoProximo: /^(avan[çc]ar|continuar( para a pr[óo]xima etapa)?|next|continue|revisar( sua candidatura)?|review)/i,
    botaoFinal: /^(enviar candidatura|submit application|enviar)/i,
    sucesso: /candidatura enviada|sua candidatura foi enviada|application sent|candidatura conclu[ií]da/i,
  };

  /**
   * ProgramaThor — quadro de vagas brasileiro, ~22 mil vagas (1.468 páginas de listagem).
   *
   * CONFIRMADO AO VIVO, DESLOGADO (04/10/2026): o topo oferece "ENTRAR" → `/users/sign_in`, e **todos** os
   * quatro caminhos de candidatura da página de uma vaga apontam para o login ou o cadastro — inclusive o CTA
   * grande, que é `<a class="btn btn-success btn-lg" href="/users/sign_up">Quero me candidatar</a>`. Então,
   * deslogado, `clicarEnvia` dá `nao` e o motor nem tenta.
   *
   * NÃO CONFIRMADO: o que esse mesmo CTA é quando você ESTÁ logado — outra página com formulário, um modal, ou
   * o próprio envio de um clique. Não tenho a conta e não vou criar uma; e clicar para descobrir mandaria uma
   * candidatura real. Quem resolve isso é `reconhecerEnvio()`, que descreve o botão sem tocar nele: abra uma
   * vaga logado e o relatório vai para o diário. Até lá, as convenções de botão herdadas do genérico valem.
   *
   * Por que um handler dedicado se o genérico já "funcionava": o genérico não sabia dizer se você está logado
   * (caiu em "você já está logado aqui, então não dá para saber se a candidatura exige conta" — verdadeiro e
   * inútil). Aqui o sinal é direto e nasce da página real.
   */
  const PROGRAMATHOR = {
    dominios: ['programathor.com.br'],
    detectaTelaLogin: () => /\/users\/(sign_in|sign_up|password|confirmation|auth)/i.test(location.pathname),
    precisaLogin() {
      if (/\/users\/(sign_in|sign_up|password|confirmation|auth)/i.test(location.pathname)) return { precisa: true, logado: false, motivo: 'esta é a tela de entrada do ProgramaThor' };
      // O caminho de candidatura apontando para login/cadastro é o sinal mais forte, e é o que eu vi na página
      const cta = PROGRAMATHOR.cta();
      const destino = cta?.getAttribute('href') ?? '';
      if (/\/users\/(sign_in|sign_up)/.test(destino)) return { precisa: true, logado: false, motivo: 'o botão "Quero me candidatar" ainda leva para o cadastro' };
      // Reserva: o "ENTRAR" do topo, que só existe deslogado
      const entrar = todos('a[href="/users/sign_in"]').some(visivel);
      if (entrar) return { precisa: true, logado: false, motivo: 'o topo ainda oferece ENTRAR' };
      if (cta) return { precisa: true, logado: true, motivo: 'o botão de candidatura não leva mais ao cadastro: a sua sessão está valendo' };
      /**
       * Nem CTA, nem ENTRAR. A tentação é concluir "logado" — e foi o que eu fiz na primeira versão, o que é
       * dizer que está tudo bem porque não achei nada. Sem botão de candidatura esta página não tem o que
       * automatizar, e o motivo importa: pode ser vaga encerrada, candidatura já enviada, ou um layout que eu
       * não conheço. Falar isso em voz alta é o que me permite consertar; "logado" esconderia.
       */
      const jaFoi = /voc[êe] (j[áa] )?se candidatou|candidatura (j[áa] )?enviada/i.test(document.body.innerText.slice(0, 4000));
      const encerrada = /vaga (encerrada|preenchida|fechada)|n[ãa]o est[áa] mais (dispon[íi]vel|aceitando)/i.test(document.body.innerText.slice(0, 4000));
      return {
        precisa: true,
        logado: !entrar,
        motivo: jaFoi ? 'você já se candidatou a esta vaga' : encerrada ? 'esta vaga está encerrada' : 'não achei o botão de candidatura nesta página (layout desconhecido)',
      };
    },
    empresaDaVaga: () => texto(document.querySelector('.company-name, [class*="company" i] a, [class*="empresa" i]')).slice(0, 120) || doJsonLd()?.empresa || '',

    /**
     * O CTA de candidatura, e só ele.
     *
     * O genérico procura o primeiro elemento visível cujo texto casa com /candidat/ — e nesta página isso dá o
     * link errado: o topo tem "Como candidato" e "ENTRAR COMO CANDIDATO" ANTES do botão de verdade. Deslogado
     * dava na mesma por acidente (todos apontam para o cadastro); logado daria um retrato do botão errado, e é
     * do retrato que depende a decisão de clicar ou não. O CTA real, confirmado ao vivo, é
     * `<a class="btn btn-success btn-lg">Quero me candidatar</a>` — classe E texto, porque qualquer um dos
     * dois sozinho é frágil.
     */
    cta: () =>
      todos('a.btn-success,button.btn-success,a.btn-lg,[class*="btn-success" i]')
        .filter(visivel)
        .find(e => /quero me candidatar|candidatar/i.test(texto(e))) ?? botaoCandidatar(),
    reconhecerEnvio: () => reconhecerEnvio(PROGRAMATHOR.cta()),
  };

  /**
   * Lever (jobs.lever.co) — o caso em que o núcleo NÃO pode terminar o trabalho.
   *
   * Não é por login: o Lever não pede conta nenhuma para se candidatar. É por captcha — o `/apply` roda
   * hCaptcha antes de deixar o POST sair (`core/platforms/lever/seletores.ts` tem o levantamento). O robô do
   * núcleo pararia ali, e contornar captcha é o que este projeto não faz. Aqui, no SEU navegador, não há nada
   * a contornar: o preenchimento é automático, o clique é seu, e se o desafio aparecer você responde.
   *
   * O que o genérico já acerta e por isso não está repetido aqui: os rótulos visíveis do formulário
   * ("Full name", "Email", "Phone", "Current location", "LinkedIn URL", "ATTACH RESUME/CV") casam todos com
   * `CONHECIDOS`, e "Submit application" casa com `botaoFinal`. Os campos extras da empresa são
   * `cards[<uuid>][fieldN]` e seguem o caminho normal: resposta salva preenche, sem resposta a vaga para.
   *
   * O que ele erra, e é só isto:
   *  - **não existe `h1` em nenhuma das duas páginas.** O título mora num `h2` dentro de `.posting-headline`,
   *    então `tituloDaVaga` do genérico voltava vazio;
   *  - **a página do `/apply` não tem JSON-LD** (a da vaga tem) e não tem nenhuma classe com "company", então
   *    o seletor de reserva do genérico também não acha nada: a empresa sai vazia.
   *
   * Vazio é o pior caso justamente por ser silencioso — não há erro, só uma chave incompleta. E título e
   * empresa vazios não são cosmética: são a chave de `jaEnviei({url, titulo, empresa})`. Sem eles a
   * trava de duplicidade cai para "mesma URL", e a mesma vaga republicada com outro id passaria (invariante 4).
   * Nas duas páginas o `<title>` é `"<Empresa> - <Título da vaga>"`, e é de lá que o nome da empresa sai.
   */
  const LEVER = {
    dominios: ['jobs.lever.co'],
    detectaTelaLogin: () => false,
    precisaLogin: () => ({ precisa: false, logado: true, motivo: 'o Lever não pede conta para se candidatar' }),
    descobrirCamposFormulario,
    tituloDaVaga: () => texto(document.querySelector('.posting-headline h2, h2')).slice(0, 180) || doJsonLd()?.titulo || '',
    // O primeiro pedaço do <title> antes do " - ". O resto é o título da vaga, que tem hífen dentro
    // ("... - Pleno") — daí cortar só na PRIMEIRA ocorrência.
    empresaDaVaga: () => (document.title.split(' - ')[0] ?? '').trim().slice(0, 120) || doJsonLd()?.empresa || '',
    descricaoDaVaga: () => texto(document.querySelector('[data-qa="job-description"]')).slice(0, 4000) || doJsonLd()?.descricao || '',
  };

  /**
   * Greenhouse (job-boards.greenhouse.io) — o segundo caso de "o núcleo não termina por causa de captcha".
   *
   * Aqui é reCAPTCHA Enterprise invisível no formulário (`core/platforms/greenhouse/seletores.ts` tem o
   * levantamento). Mesma conclusão do Lever: o robô pararia ali, contornar captcha é o que não se faz, e o
   * caminho honesto é este — o seu navegador, o seu clique, você respondendo o desafio se ele aparecer.
   *
   * **O que o genérico já acerta aqui, e não está repetido:** o título vem no `h1` (ao contrário do Lever,
   * que não tem `h1` nenhum), os campos do formulário são montados por JavaScript mas o motor lê o DOM vivo,
   * e "Enviar inscrição" / "Submit application" casam com `botaoFinal`.
   *
   * **O que ele erra:** a empresa. Não há JSON-LD nesta página e nenhuma classe com "company", então o
   * seletor de reserva do genérico não acha nada e a empresa sai vazia — e é dela, com o título, que depende
   * `jaEnviei({url, titulo, empresa})`, a trava de currículo repetido (invariante 4). O `<title>` é
   * `"Job Application for <vaga> at <Empresa>"`, e o nome está depois do ÚLTIMO " at " (o título da vaga pode
   * ter " at " dentro, "Engineer at Scale" por exemplo — daí o último, e não o primeiro).
   */
  const GREENHOUSE = {
    dominios: ['greenhouse.io'],
    detectaTelaLogin: () => false,
    precisaLogin: () => ({ precisa: false, logado: true, motivo: 'o Greenhouse não pede conta para se candidatar' }),
    descobrirCamposFormulario,
    empresaDaVaga: () => {
      const t = document.title.replace(/^Job Application for\s+/i, '');
      const i = t.toLowerCase().lastIndexOf(' at ');
      return (i > 0 ? t.slice(i + 4) : '').trim().slice(0, 120) || doJsonLd()?.empresa || '';
    },
    descricaoDaVaga: () => texto(document.querySelector('.job__description, #content')).slice(0, 4000) || doJsonLd()?.descricao || '',
  };

  const REGISTRO = [INDEED, LINKEDIN, PROGRAMATHOR, LEVER, GREENHOUSE];

  /**
   * O handler desta página: o dedicado do domínio POR CIMA do genérico, nunca no lugar dele.
   *
   * Antes isto devolvia o dedicado puro, e um handler que só queria acrescentar diagnóstico acabava
   * APAGANDO o resto. O do Indeed define 4 dos 12 campos: sem a fusão, o motor ficava sem `abrir`,
   * `botaoProximo`, `botaoFinal` e `sucesso` naquele site — ou seja, nunca achava o botão de enviar e nunca
   * reconhecia a confirmação. Handler dedicado é complemento, não substituição.
   */
  const handlerDe = host => {
    const dedicado = REGISTRO.find(h => h.dominios.some(d => host === d || host.endsWith(`.${d}`)));
    return dedicado ? { ...GENERICO, ...dedicado } : GENERICO;
  };

  // ─── Diagnóstico ──────────────────────────────────────────────────────────────────────────────
  const dominioBase = host => host.replace(/^www\./, '');

  /**
   * É mesmo uma página de vaga? Em site DESCONHECIDO, é isto que decide se o painel aparece.
   *
   * Duas das três condições antigas faziam o painel invadir a web inteira:
   *
   *  - **`/login` no caminho da URL** punha o painel em TODA tela de entrada que existe — banco, e-mail,
   *    painel de hospedagem. Ela nem servia para o que parecia: em plataforma conhecida o painel já aparece
   *    de qualquer jeito (`classificar` só chega aqui quando o site NÃO está no cadastro), então o único
   *    efeito dela era ruído em site alheio. Saiu.
   *  - **um botão com "aplicar"/"inscrever"** é fraco sozinho: "Aplicar" aparece em simulador de banco, em
   *    site de curso e no portfólio dele. Agora o botão precisa de companhia — a página tem de falar de vaga
   *    no título ou no caminho, ou ter um campo de anexo de currículo.
   *
   * O `JobPosting` no JSON-LD continua bastando sozinho: ali é a própria página se declarando uma vaga.
   */
  // Com borda de palavra: sem ela, "job" casaria dentro de "adjob" e "apply" dentro de "supply"
  const CONTEXTO_DE_VAGA = /\b(vagas?|carreiras?|trabalhe[- ]conosco|oportunidades?|recrutamento|jobs?|careers?|position|opening|hiring|apply)\b/i;
  const temJobPosting = () => todos('script[type="application/ld+json"]').some(s => /"@type"\s*:\s*"?JobPosting/i.test(s.textContent ?? ''));
  const campoDeCurriculo = () =>
    todos('input[type="file"]').some(e => /curr[íi]culo|curriculum|resume|\bcv\b|anexo/i.test(`${e.name} ${e.id} ${e.getAttribute('aria-label') ?? ''} ${e.closest('label')?.textContent ?? ''}`));

  const pareceVaga = () => {
    if (temJobPosting()) return true;
    if (!botaoCandidatar()) return false;
    return CONTEXTO_DE_VAGA.test(`${document.title} ${location.pathname}`) || campoDeCurriculo();
  };

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
      campos: handler.descobrirCamposFormulario().map(({ el: _el, ...c }) => c),
      // `el` é um nó do DOM: fica aqui dentro, nunca cruza a ponte para o núcleo
      envio: (({ el: _el, ...r } = {}) => (r.tag ? r : null))(handler.reconhecerEnvio?.() ?? undefined),
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
    [/anos de experi[êe]ncia|years of experience|tempo de experi[êe]ncia/i, 'anosExperiencia'],
  ];
  const normal = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  /** Qual chave do perfil responde este campo? (nome, email, celular...) ou null se for pergunta da empresa. */
  const chaveDoCampo = campo => CONHECIDOS.find(([re]) => re.test(campo.pergunta))?.[1] ?? null;

  /**
   * Resposta pronta para esta pergunta da empresa, ou null.
   *
   * Casamento quase exato de propósito: a extensão NUNCA deduz resposta por parecença. Pergunta de
   * autodeclaração (gênero, raça, PcD) cai aqui e sai como null — e null significa parar e chamar a pessoa,
   * nunca chutar. É o invariante 3 do projeto valendo também fora do núcleo.
   */
  function respostaSalva(pergunta, salvas) {
    const p = normal(pergunta);
    const achada = (salvas ?? []).find(q => {
      const n = normal(q.pergunta ?? q);
      return n === p || (n.length > 12 && (p.includes(n) || n.includes(p)));
    });
    const r = achada?.resposta;
    return r?.trim() ? r : null;
  }

  /** O campo tem como ser respondido com o que já existe? (usado no diagnóstico, sem preencher nada) */
  function temDado(campo, perfil) {
    const chave = chaveDoCampo(campo);
    if (chave) return perfil.tem ? perfil.tem[chave] === true : !!perfil.perfil?.[chave];
    return !!respostaSalva(campo.pergunta, perfil.perguntas);
  }

  // Usado pelo motor (motor.js), pelo painel (painel.js) e, fora do navegador, por core/extensao-check.ts
  const api = {
    diagnosticar,
    precisaLogin,
    descobrirCamposFormulario,
    handlerDe,
    temDado,
    respostaSalva,
    chaveDoCampo,
    texto,
    visivel,
    todos,
    rotuloDe,
    pareceVaga,
    reconhecerEnvio,
    GENERICO,
    INDEED,
    LINKEDIN,
    PROGRAMATHOR,
  };
  globalThis.ACVExtensao = api;
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;

  // Marca que a extensão leu esta página. Serve para você (e para o teste) saber se ela está ativa aqui.
  document.documentElement.dataset.acv = 'lido';

  const aoNucleo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));

  async function reportar(forcar = false) {
    if (!forcar && !pareceVaga()) return;
    const d = diagnosticar();
    const { cache } = await aoNucleo({ tipo: 'CACHE', dominio: d.dominio, forcar });
    // Domínio já avaliado e sem novidade: não repete o relato a cada vaga aberta
    const novidade = !cache || cache.precisaLogin !== d.precisaLogin || cache.logadoAtualmente !== d.logadoAtualmente || cache.envio !== (d.envio?.clicarEnvia ?? null);
    if (novidade) await aoNucleo({ tipo: 'PLATAFORMA_DETECTADA', ...d, campos: undefined });

    if (!d.campos.length) return;
    const { dados } = await aoNucleo({ tipo: 'DADOS' });
    if (!dados?.perfil) return;
    const faltando = d.campos.filter(c => (c.obrigatorio || c.incerto) && !temDado(c, dados));
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
    reportar().catch(e => console.debug('[ACV] não consegui relatar:', e.message)); // nunca atrapalhar a navegação
  }

  const agendar = () => {
    clearTimeout(pendente);
    pendente = setTimeout(tentar, 800); // a tela precisa parar de mudar antes de valer a leitura
  };

  tentar();
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('popstate', agendar);
})();
