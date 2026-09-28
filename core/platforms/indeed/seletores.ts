// Convenções do Indeed, centralizadas. Levantado em 21/09/2026 com UMA carga de br.indeed.com/jobs em janela visível.
//
// O QUE FOI CONFIRMADO AO VIVO
//  - Navegador headless recebe 403 "Solicitação bloqueada". O mesmo Edge em janela visível, sem nenhuma alteração,
//    recebe 200. Depois de poucas cargas automáticas seguidas o Indeed passa a responder "Verificação adicional
//    necessária" (desafio da Cloudflare). Consequências de projeto, que NÃO são negociáveis neste adapter:
//      · o Indeed roda sempre com o navegador à mostra;
//      · poucas cargas por varredura, com pausa longa entre elas, e no máximo uma varredura automática por dia;
//      · diante de bloqueio ou verificação o robô PARA e avisa a pessoa (que pode resolver a verificação na janela);
//        ele não disfarça automação, não troca impressão digital do navegador e não resolve captcha.
//  - A página de resultados embute o JSON `window.mosaic.providerData['mosaic-provider-jobcards'].metaData
//    .mosaicProviderJobCardsModel.results[]` com, por vaga: jobkey, displayTitle, company, formattedLocation,
//    jobLocationCity/State, indeedApplyEnabled (booleano = "Candidatar-se facilmente"), thirdPartyApplyUrl,
//    jobTypes, snippet (HTML curto) e taxonomyAttributes (grupos "job-types", "remote"...).
//  - No grupo "remote": suid DSQF7 = "Home Office" (remoto) e PAXZC = "Modelo Híbrido".
//  - Reserva pelo DOM: cards `.job_seen_beacon`, título/jk em `a[data-jk]`, empresa em [data-testid="company-name"],
//    local em [data-testid="text-location"], selo com o texto "Candidate-se facilmente".
//
// O QUE NÃO FOI CONFIRMADO
//  - O parâmetro de URL do filtro "Candidatar-se facilmente": o modelo tem `indeedApplyOnlyFilterUsed` (o filtro
//    existe no servidor), mas os filtros são menus em JS e nenhum link da página revela o parâmetro. Não gastamos
//    cargas adivinhando: filtramos por `indeedApplyEnabled`, que vem na mesma resposta e é exato.
//  - O fluxo de candidatura (smartapply.indeed.com) e o login: exigem conta e criariam candidaturas reais. O código
//    usa o motor de formulário genérico com as convenções abaixo e está marcado como não verificado.
//  - Os domínios além de br.indeed.com (ver src/paises.ts).

export const INDEED = {
  // Filtro de remoto na URL (suid confirmado nos atributos da própria página)
  filtroRemoto: '0kf:attr(DSQF7);',
  suidRemoto: 'DSQF7',
  suidHibrido: 'PAXZC',

  // Telas em que o Indeed recusa ou desafia o navegador
  bloqueado: /solicita[çc][ãa]o bloqueada|o sistema bloqueou voc[êe]|blocked - indeed|you have been blocked|request blocked/i,
  verificacao: /verifica[çc][ãa]o adicional|additional verification|security check|um momento|just a moment|verify you are human|confirme que [ée] humano/i,

  // Página da vaga
  descricao: '#jobDescriptionText',
  botaoCandidatar: '#indeedApplyButton, button[id*="indeedApply"], [data-testid*="indeedApply"] button',
  textoCandidatar: /candidat[ae]r?-se (facilmente|agora)|candidatura simplificada|apply now|easily apply/i,
  login: /secure\.indeed\.com\/(auth|account)|\/account\/login/i,
  // Link de entrar do cabeçalho deslogado: "Acessar" em pt-BR (visto ao vivo; nenhum seletor de href o pegava, por isso texto)
  textoEntrar: /^\s*(acessar|entrar|sign in|log ?in)\s*$/i,

  // Motor de formulário: botões e confirmação do fluxo "Candidatar-se facilmente" (NÃO verificado ao vivo)
  convencoes: {
    proximo: /^(continuar|continue|pr[óo]ximo|next|avan[çc]ar|revisar( a| sua)? candidatura|review( your)? application)$/i,
    final: /enviar (sua |a )?candidatura|submit (your )?application|enviar candidatura/i,
    sucesso: /(sua )?candidatura (foi )?enviada|your application has been submitted|application submitted|candidatura conclu[ií]da/i,
    nome: 'o Indeed',
  },
};

// Ritmo: o Indeed desafia quem carrega páginas em sequência rápida. Isto é cortesia/limite de carga, não disfarce.
export const PAUSA_ENTRE_CARGAS_MS = 30_000;
export const MAX_CONSULTAS = 2; // cargos pesquisados por varredura
export const HORAS_ENTRE_VARREDURAS_AUTOMATICAS = 24;
export const HORAS_DE_PAUSA_APOS_BLOQUEIO = 12;
export const MINUTOS_PARA_RESOLVER_VERIFICACAO = 3;
