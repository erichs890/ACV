// Motor de candidatura da extensão: preenche o formulário da vaga aberta, avança as etapas e envia.
//
// Três regras que mandam aqui, herdadas do núcleo e não negociáveis:
//   1. SÓ PREENCHE O QUE JÁ É SEU. Campo fixo vem do seu perfil; pergunta da empresa só é respondida com uma
//      resposta já salva (casamento quase exato) ou pela IA do ACV, que tem as travas dela. Nada é deduzido
//      por parecença — autodeclaração (gênero, raça, PcD) cai sempre no "pare e pergunte".
//   2. ENVIAR PRIMEIRO, CONFIRMAR DEPOIS. O desfecho sai da resposta HTTP (rede.js) e, só na falta dela, da tela.
//      Nunca clica no botão final duas vezes.
//   3. SEM DISFARCE. Ritmo humano, limite por dia e parada imediata ao primeiro sinal de restrição da
//      plataforma. Nenhuma tentativa de esconder que isto é um programa.
(() => {
  const { texto, visivel, todos, handlerDe, descobrirCamposFormulario, chaveDoCampo, respostaSalva } = globalThis.ACVExtensao;
  const { empresaBloqueada, RESTRICAO } = globalThis.ACVComum;

  const esperar = ms => new Promise(r => setTimeout(r, ms));
  const aoFundo = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));

  // ─── Prova de envio (rede.js, no mundo da página) ─────────────────────────────────────────────
  const respostas = [];
  addEventListener('acv-rede', e => {
    respostas.push(e.detail);
    if (respostas.length > 80) respostas.shift();
  });

  /**
   * Arma (ou desarma) o corte de escrita do ensaio em `rede.js`, que roda no mundo da página.
   *
   * O corte vale só enquanto a tentativa dura: armado para sempre, o ensaio quebraria a navegação normal da
   * pessoa naquela aba. Por isso quem arma também desarma, no `finally`.
   */
  const armarEnsaio = armado => {
    try {
      window.dispatchEvent(new CustomEvent('acv-ensaio', { detail: { armado } }));
    } catch {
      // sem rede.js nesta página (domínio fora dos `matches` do manifesto): o motor avisa e não ensaia
    }
  };

  /** As escritas que o ensaio recusou — a resposta para "por onde isso teria enviado?". */
  const escritasBarradas = desde => respostas.filter(r => r.em >= desde && r.bloqueado).map(r => `${r.metodo} ${r.url}`);

  /** Houve POST/PUT para o próprio site, com 2xx, depois do clique final? É a prova de que a vaga recebeu. */
  async function provaDeEnvio(desde, segundos = 20) {
    const fim = Date.now() + segundos * 1000;
    while (Date.now() < fim) {
      const ok = respostas.find(r => r.em >= desde && /^(POST|PUT|PATCH)$/.test(r.metodo) && r.status >= 200 && r.status < 300 && !/analytics|metric|telemetry|tracking|beacon|log/i.test(r.url));
      if (ok) return ok;
      await esperar(400);
    }
    return null;
  }

  // ─── Preenchimento ────────────────────────────────────────────────────────────────────────────
  // React e Angular ignoram `input.value = x`: o valor tem de passar pelo setter nativo para o framework ver.
  function escrever(el, valor) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, valor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Marca a opção cujo texto é exatamente a resposta (ou a contém). Sem opção certa, devolve false: não chuta. */
  function escolherOpcao(campo, valor) {
    const alvo = valor.toLowerCase().trim();
    if (campo.el.tagName === 'SELECT') {
      const op = [...campo.el.options].find(o => o.text.toLowerCase().trim() === alvo) ?? [...campo.el.options].find(o => o.text.toLowerCase().includes(alvo));
      if (!op) return false;
      campo.el.value = op.value;
      campo.el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const grupo = campo.el.name ? [...document.getElementsByName(campo.el.name)] : [campo.el];
    const certo = grupo.find(i => {
      const rot = texto(i.closest('label') ?? document.querySelector(`label[for="${CSS.escape(i.id)}"]`) ?? i.parentElement);
      return rot.toLowerCase().trim() === alvo || (alvo.length > 2 && rot.toLowerCase().includes(alvo));
    });
    if (!certo) return false;
    certo.click();
    return certo.checked !== false;
  }

  async function anexarCurriculo(el, curriculo) {
    if (!curriculo?.base64) return false;
    const bytes = Uint8Array.from(atob(curriculo.base64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], curriculo.nome || 'curriculo.pdf', { type: 'application/pdf' }));
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await esperar(1500); // a plataforma costuma subir o arquivo antes de liberar o "Avançar"
    return true;
  }

  /** Valor para um campo fixo (nome, e-mail, celular...), vindo do seu perfil ou da config da extensão. */
  function valorFixo(chave, dados, cfg) {
    const p = dados?.perfil ?? {};
    const mapa = {
      nome: p.nome,
      email: p.email,
      celular: p.telefone,
      linkedin: p.linkedin || cfg.linkedinPerfilUrl,
      cidade: p.cidade,
      cpf: p.cpf,
      pretensao: p.pretensao || (cfg.pretensaoSalarial ? String(cfg.pretensaoSalarial) : ''),
      regime: dados?.regimePreferido,
      anosExperiencia: cfg.anosExperiencia ? String(cfg.anosExperiencia) : '',
    };
    return mapa[chave]?.toString().trim() || null;
  }

  const preenchido = campo => {
    if (campo.tipo === 'arquivo') return campo.el.files?.length > 0;
    if (campo.tipo === 'opcao' || campo.tipo === 'caixa') return (campo.el.name ? [...document.getElementsByName(campo.el.name)] : [campo.el]).some(i => i.checked);
    return !!campo.el.value?.trim() && campo.el.value.trim() !== '+55';
  };

  /**
   * Preenche o que dá na etapa atual. Devolve a primeira pergunta que ficou sem resposta — o motor para nela e
   * chama você, em vez de inventar. Pergunta não obrigatória sem resposta é simplesmente deixada em branco.
   */
  async function preencherEtapa(raiz, dados, cfg, vaga, log) {
    const campos = descobrirCamposFormulario(raiz);
    for (const campo of campos) {
      if (preenchido(campo)) continue;
      // A resposta que VOCÊ salvou vem primeiro; o campo fixo do perfil é a reserva. Sem esta ordem, uma
      // pergunta da empresa que se parece com um campo fixo ("Quantos anos de experiência COM REACT?") era
      // respondida pelo "anos de experiência" do perfil — e, se ele estivesse vazio, a resposta salva nem
      // chegava a ser consultada.
      const chave = chaveDoCampo(campo);
      let valor = respostaSalva(campo.pergunta, dados?.perguntas) ?? (chave ? valorFixo(chave, dados, cfg) : null);

      if (!valor && campo.tipo === 'arquivo' && /curr[íi]culo|resume|cv/i.test(campo.pergunta)) {
        if (await anexarCurriculo(campo.el, dados?.curriculo)) {
          log(`Currículo anexado (${dados.curriculo.nome}).`);
          continue;
        }
        if (campo.obrigatorio) return { pergunta: campo, motivo: 'o currículo ainda não está no cache — abra o ACV uma vez para a extensão copiá-lo' };
        continue;
      }

      // Sem resposta pronta: a IA do ACV pode responder (com as travas dela). Ela recusa dado pessoal e
      // autodeclaração, e com o ACV fechado nem é consultada — nos dois casos a vaga para e espera você.
      if (!valor && (campo.obrigatorio || campo.tipo === 'opcao')) {
        const opcoes = campo.el.tagName === 'SELECT' ? [...campo.el.options].map(o => o.text.trim()).filter(t => t && !/^(selecione|select|escolha)/i.test(t)) : [];
        const r = await aoFundo({ tipo: 'PERGUNTA', dados: { pergunta: campo.pergunta, opcoes, vaga } });
        if (r?.resposta) {
          valor = r.resposta;
          log(`IA do ACV respondeu "${campo.pergunta}": ${valor}`);
        } else if (campo.obrigatorio) {
          return { pergunta: campo, motivo: r?.motivo ?? 'não tenho resposta salva para esta pergunta' };
        }
      }
      if (!valor) continue;

      if (campo.tipo === 'lista' || campo.tipo === 'opcao' || campo.tipo === 'caixa') {
        if (!escolherOpcao(campo, valor) && campo.obrigatorio) return { pergunta: campo, motivo: `a resposta salva ("${valor}") não é uma das opções desta vaga` };
      } else {
        escrever(campo.el, valor);
      }
      log(`Preenchido: ${campo.pergunta}`);
      await esperar(120 + Math.random() * 280); // digitar tudo no mesmo milissegundo não é uso normal de site
    }
    return null;
  }

  const botao = (raiz, re) =>
    todos('button, [role="button"]')
      .filter(b => visivel(b) && !b.disabled && (raiz === document ? true : raiz.contains(b)))
      .find(b => re.test(`${b.getAttribute('aria-label') ?? ''}`.trim()) || re.test(texto(b)));

  // ─── Candidatura ──────────────────────────────────────────────────────────────────────────────
  const MAX_ETAPAS = 12;

  /**
   * Candidata na vaga que está aberta nesta aba. Um clique seu = uma candidatura: o motor não varre a lista de
   * resultados sozinho. Devolve sempre o que aconteceu, inclusive quando desiste no meio.
   */
  /**
   * Uma candidatura, ponta a ponta, nesta página.
   *
   * O corte de escrita do ensaio é desarmado no `finally` abaixo, em `candidatar`: armado e esquecido, ele
   * quebraria a navegação normal da pessoa nesta aba depois do ensaio terminar — qualquer formulário do site
   * pararia de funcionar, e ninguém ligaria uma coisa à outra.
   */
  async function tentarCandidatar(log = () => {}) {
    const handler = handlerDe(location.hostname);
    const dominio = location.hostname.replace(/^www\./, '');
    const { cfg } = await aoFundo({ tipo: 'CONFIG' });
    const empresa = handler.empresaDaVaga?.() ?? '';
    const titulo = handler.tituloDaVaga?.() ?? document.title;

    if (RESTRICAO.test(document.body.innerText.slice(0, 2000)))
      return { status: 'erro', motivo: 'a plataforma está pedindo verificação (anti-robô). O ACV não contorna isso: resolva na tela e tente mais tarde.' };

    const bloqueada = empresaBloqueada(empresa, cfg.empresasBloqueadas);
    if (bloqueada) return { status: 'bloqueada', motivo: `"${empresa}" está na sua lista de empresas bloqueadas (${bloqueada}).` };

    /**
     * Uma vaga, uma candidatura (invariante 4) — a trava que faltava aqui.
     *
     * Vem ANTES do limite do dia e antes de qualquer preenchimento: o pior desfecho possível neste projeto é
     * dois currículos na mesa do mesmo recrutador, e o motor não tinha nada que impedisse clicar duas vezes
     * na mesma vaga. O núcleo não salvava (a deduplicação dele usa `url|enviadaEm`, e a data muda a cada
     * tentativa), e com o ACV fechado não há núcleo nenhum para salvar.
     */
    const antes = await aoFundo({ tipo: 'JA_ENVIEI', url: location.href });
    if (antes?.ja)
      return {
        status: 'repetida',
        motivo: `você já se candidatou a esta vaga em ${new Date(antes.quando).toLocaleString('pt-BR')}. Mandar o currículo duas vezes para o mesmo recrutador queima o candidato, então eu não repito.`,
      };

    const cota = await aoFundo({ tipo: 'CABEM', dominio });
    if (!cota?.cabem)
      return { status: 'limite', motivo: `limite de ${cota?.limite ?? 0} candidatura(s) por dia nesta plataforma já alcançado${cota?.aquecendo ? ' (plataforma em aquecimento)' : ''}.` };

    const { dados } = await aoFundo({ tipo: 'DADOS' });
    if (!dados?.perfil?.nome) return { status: 'erro', motivo: 'ainda não tenho os seus dados: abra o ACV uma vez com a extensão conectada (Plataformas › Extensão).' };

    log(`Vaga: ${titulo} — ${empresa || 'empresa não informada'}`);
    /**
     * `abrir` pode devolver `'envia_direto'`: o botão de candidatura É o envio (quadro de vagas em que o
     * currículo já está na conta). Nesse caso ele NÃO foi clicado — quem clica é a etapa final abaixo, que
     * espera a prova de rede. Clicar aqui mandaria a candidatura antes de preencher, e o motor devolveria
     * `erro` depois de um envio consumado: era isso que a invariante 1 proíbe.
     */
    /**
     * Invariante 5 do projeto, agora valendo aqui: ensaio não envia.
     *
     * O ensaio é configuração do núcleo (Automação › modo ensaio) e chega junto dos dados. Até hoje o motor da
     * extensão não o conhecia: a tela do ACV dizia "nada será enviado" e um clique no painel mandava currículo
     * de verdade. Enquanto o painel preferia o adapter do núcleo isso quase não aparecia — no momento em que a
     * extensão virou o caminho principal de um site com login, virou armadilha.
     *
     * Com o ACV fechado vale o último valor sincronizado (fica no `cache` do worker), como todo o resto.
     */
    const ensaio = dados.ensaio === true;
    if (ensaio) {
      // `dataset` do DOM, e NÃO `window.__acvRede`: `rede.js` roda no mundo da página e este arquivo no mundo
      // isolado do content script — os dois `window` são objetos diferentes, e a variável nunca cruzava. O DOM
      // é compartilhado, que é por isso que os eventos `acv-rede`/`acv-ensaio` já funcionavam entre os dois.
      if (document.documentElement.dataset.acvRede !== '1')
        return {
          status: 'erro',
          motivo:
            'o modo ensaio está ligado no ACV, mas nesta página eu não consigo garantir que nada seja enviado (falta o monitor de rede). Não vou arriscar: desligue o ensaio para candidatar de verdade, ou me peça para incluir este site.',
        };
      armarEnsaio(true);
      log('Modo ensaio LIGADO: vou preencher tudo e nenhuma escrita sai desta página.');
    }
    const aberturaEm = Date.now();
    // No ensaio o clique de abrir acontece normalmente: quem segura o envio é o corte de escrita, não a
    // recusa do clique — formulário que abre por botão de JavaScript só revela os campos depois dele
    const abertura = handler.abrir?.();
    if (abertura === 'envia_direto') log('Aqui a candidatura é de um clique só: vou preencher o que houver e então enviar.');
    else if (abertura) {
      log('Formulário de candidatura aberto.');
      await esperar(1500);
    }

    const vaga = { titulo, empresa, descricao: handler.descricaoDaVaga?.() ?? '' };
    let enviado = false;
    for (let etapa = 1; etapa <= MAX_ETAPAS; etapa++) {
      const raiz = handler.dialogo?.() ?? document;
      const parada = await preencherEtapa(raiz, dados, cfg, vaga, log);
      if (parada) return { status: 'pergunta', pergunta: parada.pergunta.pergunta, motivo: parada.motivo };

      // No envio de um clique, o próprio botão de candidatura é o botão final — e só na primeira etapa
      const direto = abertura === 'envia_direto' && etapa === 1 ? (handler.reconhecerEnvio?.()?.el ?? null) : null;
      const final = (handler.botaoFinal && botao(raiz, handler.botaoFinal)) ?? direto;
      const proximo = handler.botaoProximo && botao(raiz, handler.botaoProximo);
      const alvo = final ?? proximo;
      if (!alvo) {
        if (handler.sucesso?.test(document.body.innerText)) break; // já terminou numa etapa anterior
        /**
         * Último recurso, e o mais importante: pode ser que o clique de `abrir` já tenha enviado — botão de
         * JavaScript não deixa ver o destino antes, e `reconhecerEnvio` devolveu `talvez`. Antes de acusar
         * erro, pergunto à rede. Sucesso é a resposta HTTP, não o que está na tela: dizer "erro" aqui faria a
         * pessoa clicar de novo e mandar a segunda candidatura.
         *
         * No ensaio a mesma pergunta tem outra resposta: a escrita que o corte recusou prova que ali era o
         * envio. Isso é o ensaio dando certo — e a rota recusada é justamente o que eu preciso saber para
         * escrever o adapter desta plataforma.
         */
        if (ensaio) {
          const barradas = escritasBarradas(aberturaEm);
          if (barradas.length) {
            log(`Ensaio: a candidatura era de um clique, e o envio foi bloqueado em ${barradas.join(', ')}.`);
            return { status: 'ensaio', motivo: `modo ensaio: aqui a candidatura é de um clique, e o envio foi bloqueado em ${barradas[0]}. Nada chegou à plataforma.`, rotas: barradas };
          }
        }
        const prova = await provaDeEnvio(aberturaEm, 3);
        if (prova) {
          log(`A candidatura saiu no próprio clique de abrir. Prova de envio: ${prova.metodo} ${new URL(prova.url, location.origin).pathname} → HTTP ${prova.status}.`);
          enviado = true;
          break;
        }
        return { status: 'erro', motivo: `não achei o botão para seguir na etapa ${etapa}; o layout da plataforma deve ter mudado.` };
      }

      const desde = Date.now();
      log(`${final ? 'Enviando candidatura' : `Avançando (etapa ${etapa})`}: "${texto(alvo) || alvo.getAttribute('aria-label')}"`);
      alvo.click();

      if (final) {
        /**
         * No ensaio o botão final É clicado — é o único jeito de saber se a plataforma liberou o envio, que é
         * a pergunta que o ensaio existe para responder. O que impede a candidatura de sair é o corte de
         * escrita armado acima, e o que ele recusou vira o relatório: a rota por onde o envio teria ido.
         */
        if (ensaio) {
          await esperar(1200);
          const barradas = escritasBarradas(desde);
          log(barradas.length ? `Ensaio: o envio foi bloqueado em ${barradas.join(', ')}.` : 'Ensaio: cliquei em enviar e nenhuma escrita saiu — nada chegou à plataforma.');
          return {
            status: 'ensaio',
            motivo: barradas.length
              ? `modo ensaio: o formulário foi preenchido e o envio foi bloqueado em ${barradas[0]}. Nada chegou à plataforma.`
              : 'modo ensaio: o formulário foi preenchido e nada foi enviado.',
            rotas: barradas,
          };
        }
        // Daqui para a frente NÃO se clica de novo: se o envio saiu, clicar outra vez manda duas candidaturas
        const prova = await provaDeEnvio(desde);
        const naTela = handler.sucesso?.test(document.body.innerText);
        if (!prova && !naTela) return { status: 'erro', motivo: 'cliquei em enviar e não vi nem resposta do servidor nem confirmação na tela — confira a vaga antes de tentar de novo.' };
        log(
          prova
            ? `Prova de envio: ${prova.metodo} ${new URL(prova.url, location.origin).pathname} → HTTP ${prova.status}.`
            : 'Sem resposta de rede visível; confirmado pelo texto da própria plataforma.',
        );
        enviado = true;
        break;
      }
      await esperar(900);
    }
    if (!enviado) return { status: 'erro', motivo: `o formulário passou de ${MAX_ETAPAS} etapas sem chegar ao envio.` };

    const candidatura = { dominio, url: location.href, titulo, empresa, enviadaEm: new Date().toISOString() };
    const r = await aoFundo({ tipo: 'CANDIDATURA', candidatura });
    log(r?.sincronizado ? 'Candidatura registrada no ACV.' : 'Candidatura registrada aqui; vai para o ACV assim que você abri-lo.');
    return { status: 'enviada', espera: globalThis.ACVComum.proximaEspera(cfg) };
  }

  const candidatar = async (log = () => {}) => {
    try {
      return await tentarCandidatar(log);
    } finally {
      armarEnsaio(false);
    }
  };

  globalThis.ACVMotor = { candidatar, preencherEtapa, escrever, escolherOpcao, provaDeEnvio, valorFixo, armarEnsaio };
})();
