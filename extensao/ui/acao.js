// O que o botão do painel oferece agora, e por quê.
//
// Antes isto era um ternário de cinco ramos decidindo rótulo e `disabled` ao mesmo tempo, com a decisão do
// botão do núcleo morando dez linhas acima — duas decisões sobre o mesmo assunto, em dois lugares, sem teste.
// Aqui é uma lista de casos em ordem de prioridade: lê-se de cima para baixo e o primeiro que bate ganha.
//
// Módulo PURO: nada de `chrome`, `document` ou DOM. É o que permite testá-lo no sandbox do
// core/extensao-check.ts, sem navegador.
(() => {
  /**
   * `situacao` é tudo o que o painel sabe no momento:
   *   ocupado      — uma candidatura em andamento agora
   *   sincronizado — o núcleo respondeu
   *   temVaga      — a página aberta é mesmo uma vaga
   *   bloqueada    — nome da empresa, se você a bloqueou
   *   cota         — { cabem, feitasHoje, limite, aquecendo }
   *   sitio        — o que `plataformas.classificar` devolveu (ou null)
   *   restrita     — a plataforma mostrou verificação anti-robô
   *   ensaio       — o modo ensaio está ligado no ACV (Automação): preencher sim, enviar não
   *
   * Devolve `{ principal, alternativa }`, cada uma `{ id, rotulo, variante, desabilitado, orbe }`, mais um
   * `motivo` que explica por que o botão está como está — o painel o mostra abaixo quando desabilitado.
   */
  function decidir(situacao = {}) {
    const { ocupado, sincronizado, temVaga, bloqueada, cota, sitio, restrita, ensaio } = situacao;
    const nivel = sitio?.nivel ?? null;
    const b = (id, rotulo, extra = {}) => ({ id, rotulo, variante: 'primary', desabilitado: false, orbe: null, ...extra });

    // A ordem importa: o primeiro caso que bate é o que manda. Tudo o que IMPEDE vem antes do que oferece.
    if (restrita)
      return {
        principal: b('restrita', 'A plataforma pediu verificação', { variante: 'secondary', desabilitado: true }),
        alternativa: null,
        motivo: 'Parei aqui — o ACV não disfarça nada. Resolva no site e recarregue a página.',
      };

    if (ocupado)
      return {
        principal: b('ocupado', nivel === 'nucleo' ? 'Conectando à vaga no ACV...' : 'Candidatando...', { desabilitado: true, orbe: nivel === 'nucleo' ? 'conectando' : 'enviando' }),
        alternativa: null,
        motivo: '',
      };

    if (bloqueada)
      return {
        principal: b('bloqueada', `Empresa bloqueada: ${bloqueada}`, { variante: 'secondary', desabilitado: true }),
        alternativa: { id: 'config', rotulo: 'Desbloquear nas Configurações', variante: 'secondary', desabilitado: false, orbe: null },
        motivo: 'Você bloqueou esta empresa nas Configurações. Nada sai daqui.',
      };

    if (cota && !cota.cabem)
      return {
        principal: b('limite', `Limite de hoje alcançado (${cota.feitasHoje} de ${cota.limite})`, { variante: 'secondary', desabilitado: true }),
        alternativa: { id: 'config', rotulo: 'Ajustar o limite', variante: 'secondary', desabilitado: false, orbe: null },
        motivo: cota.aquecendo ? 'Plataforma nova começa devagar de propósito: é o que mantém a conta fora do radar. O limite sobe sozinho nos próximos dias.' : 'Volta a zero à meia-noite.',
      };

    if (!temVaga)
      return {
        principal: b('sem_vaga', 'Abra uma vaga para começar', { variante: 'secondary', desabilitado: true }),
        alternativa: { id: 'buscar', rotulo: 'Buscar vagas com meus critérios', variante: 'secondary', desabilitado: false, orbe: null },
        motivo: 'Abra o anúncio de uma vaga e eu volto a falar.',
      };

    // Daqui para baixo dá para candidatar: o que muda é POR ONDE
    if (nivel === 'nucleo' && !sincronizado)
      return {
        principal: b('nucleo_fechado', 'Abra o start.bat para candidatar pelo ACV', { variante: 'secondary', desabilitado: true }),
        alternativa: { id: 'extensao', rotulo: 'Candidatar aqui mesmo (motor da extensão)', variante: 'secondary', desabilitado: false, orbe: null },
        motivo: `O ACV tem adapter próprio para ${sitio?.nome ?? 'este site'} e ele é o caminho melhor — mas precisa estar no ar.`,
      };

    if (nivel === 'nucleo')
      return {
        principal: b('nucleo', `Candidatar pelo ACV (${sitio?.nome ?? 'adapter'})`),
        alternativa: sitio?.dois ? { id: 'extensao', rotulo: 'Candidatar aqui mesmo (motor da extensão)', variante: 'secondary', desabilitado: false, orbe: null } : null,
        motivo: '',
      };

    /**
     * O ensaio entra no RÓTULO, não só no aviso depois.
     *
     * Dizer "Iniciar candidatura" e então explicar que nada foi enviado inverte a ordem: quem clica precisa
     * saber o que vai acontecer antes. E o contrário é pior ainda — acreditar que o ensaio protege e descobrir
     * pelo e-mail do recrutador que não protegia.
     */
    const AVISO_ENSAIO = 'Modo ensaio ligado no ACV (Automação): eu preencho tudo e paro antes de enviar.';

    if (nivel === 'extensao')
      return {
        principal: b('extensao', ensaio ? 'Ensaiar candidatura (não envia)' : 'Iniciar candidatura'),
        alternativa: { id: 'buscar', rotulo: 'Buscar vagas com meus critérios', variante: 'secondary', desabilitado: false, orbe: null },
        motivo: ensaio ? AVISO_ENSAIO : (sitio?.semSessaoDoNucleo && sitio?.nota) || '',
      };

    if (nivel === 'generico')
      return {
        principal: b('generico', ensaio ? 'Ensaiar no modo genérico (não envia)' : 'Tentar no modo genérico'),
        alternativa: null,
        motivo: ensaio ? `${AVISO_ENSAIO} ${sitio?.nota ?? ''}`.trim() : (sitio?.nota ?? ''),
      };

    // Site que não é vaga e não está na lista: o painel nem deveria ter aparecido
    return { principal: b('nada', 'Nada para fazer nesta página', { variante: 'secondary', desabilitado: true }), alternativa: null, motivo: '' };
  }

  const api = { decidir };
  globalThis.ACVAcao = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // core/extensao-check.ts roda isto em Node
})();
