# PROMPT TÉCNICO — AUTOCV: EXTENSÃO AUTOSSUFICIENTE (LINKEDIN, INDEED, GUPY)

Copie e cole o conteúdo abaixo na conversa com o Claude Opus (substitui definitivamente os prompts anteriores de extensão. Mudança de arquitetura: a extensão passa a ser **autossuficiente** — guarda sua própria configuração localmente e funciona mesmo com o app Tauri fechado —, inspirada na análise de um produto concorrente real cuja extensão foi gravada em vídeo e documentada abaixo.)

---

## REFERÊNCIA ANALISADA (concorrente real, para orientar a UX e os parâmetros técnicos — não copiar marca/visual, só o modelo funcional)

Analisamos a extensão de um concorrente (VagaAutomática) em uso real. Pontos confirmados por gravação de tela e transcrição de áudio:

1. A extensão **não depende de um app desktop aberto** — ela é autossuficiente, com configuração própria guardada nela mesma.
2. Tela de **Configurações dentro da extensão**, com: link do perfil do LinkedIn (para a IA extrair habilidades/tempo de experiência reais do perfil, nunca inventar), pretensão salarial (slider + valor), anos de experiência, lista de "Empresas Bloqueadas" (usuário adiciona empresas onde não quer se candidatar — ex.: a própria empresa atual, para buscar emprego sem risco de se candidatar sem querer no próprio empregador), e um toggle "Inteligência Artificial" que liga/desliga a adaptação automática de respostas.
3. A extensão aparece como um **painel flutuante sobreposto à própria página do LinkedIn** (não só um popup da barra de extensões) — com um guia numerado "Como usar" (abra o LinkedIn → vá em Vagas → pesquise a vaga → ative a candidatura simplificada → inicie a extensão) e um botão grande "Iniciar Candidatura", além de um contador de vagas aplicadas na sessão.
4. **Parâmetros de URL reais de busca do LinkedIn**, confirmados por captura de tela, que podemos usar para montar buscas já filtradas programaticamente em vez de depender só de clique em filtro de UI:
   - `f_AL=true` → filtro "Candidatura simplificada" (Easy Apply)
   - `f_TPR=r604800` → filtro de data do anúncio "Última semana" (valor em segundos, 604800 = 7 dias; outros valores comuns de observar/validar: últimas 24h, último mês)
   - `geoId=<id>` → localização (o concorrente recomenda filtrar por "Última semana" para evitar aplicar em vaga que já tem candidato selecionado)
   - `distance=<km>` → raio de distância
   - `keywords=<termo>` → termo de busca
5. O fluxo de uso real: usuário loga normalmente no LinkedIn (sessão própria, sem a extensão interferir no login), pesquisa a vaga manualmente, ativa "Candidatura simplificada" nos filtros, abre o painel da extensão e clica em "Iniciar Candidatura" — a extensão então processa a vaga atualmente aberta (lê descrição, cruza com perfil/currículo, preenche e envia).

Usar esses achados como base da reformulação abaixo — mas manter as proteções e a regra de honestidade que já são identidade do AutoCV desde o início do projeto.

---

## MUDANÇA DE ARQUITETURA: EXTENSÃO AUTOSSUFICIENTE

### O que fica só na extensão (sem depender do app Tauri aberto)

Guardar em `chrome.storage.local` (ou `chrome.storage.sync`, se quisermos que sincronize entre computadores logados na mesma conta do navegador — avaliar qual faz mais sentido, mas por padrão local é suficiente):

```ts
type ConfiguracaoExtensao = {
  linkedinPerfilUrl: string;
  pretensaoSalarial: number;
  anosExperiencia: number;
  empresasBloqueadas: string[];
  iaAtiva: boolean; // liga/desliga adaptação automática de respostas e currículo
  limiteDiarioPorPlataforma: Record<string, number>;
  intervaloMinSegundos: number;
  intervaloMaxSegundos: number;
};
```

- Essa configuração é editável diretamente na própria extensão (painel/popup), **sem exigir que o app Tauri esteja aberto**.
- Dados leves (texto, números, listas curtas) ficam só na extensão. Dados pesados (currículo em PDF, histórico completo de candidaturas, respostas salvas de perguntas extras/sensíveis que já acumulam volume com o tempo) continuam "donos" no app Tauri, mas a extensão mantém uma **cópia em cache local** deles para funcionar offline do app.

### Sincronização oportunista com o app Tauri (quando ele estiver aberto)

- Reaproveitar a mesma ponte de comunicação já especificada (servidor WebSocket local em `127.0.0.1`, autenticado por token) — mas agora o papel dela muda: não é mais "a extensão depende do app para operar", é **sincronização bidirecional quando disponível**:
  - App → Extensão: currículo em PDF atualizado (base64 ou referência), respostas salvas de perguntas extras/sensíveis atualizadas, vagas descobertas pelos módulos de descoberta já existentes (InHire) que possam ser relevantes de contexto.
  - Extensão → App: histórico de candidaturas realizadas (para alimentar o Painel e a fila do app, mantendo a visão consolidada entre todas as plataformas), logs em tempo real (mesmo mecanismo de console de log já existente).
- Se o app estiver fechado, a extensão opera com a **última cópia em cache** desses dados (currículo, respostas salvas) e guarda localmente um log de candidaturas feitas nesse período "offline", sincronizando com o app assim que ele for aberto novamente (reconciliação: enviar o que aconteceu enquanto o app estava fechado).
- Deixar claro na UI da extensão quando ela está "sincronizada com o AutoCV" vs. "operando com dados em cache, abra o AutoCV para atualizar currículo/respostas".

---

## INTERFACE DA EXTENSÃO

### Painel flutuante sobre a página da plataforma (não só popup)

Ao detectar que o usuário está numa página de busca ou de uma vaga específica do LinkedIn (ou Indeed/Gupy, mesma lógica), injetar um painel flutuante (content script, `position: fixed`, canto da tela, recolhível) com:
- Guia numerado de uso (pode ser ocultado depois da primeira vez, com opção de reabrir).
- Botão "Iniciar Candidatura" para a vaga atualmente aberta (modo manual, equivalente ao "Quero me candidatar" já definido no app).
- Indicador de status: "IA ativa" / "IA desativada", contador de candidaturas feitas na sessão atual e no dia (reforçando visualmente o limite diário já configurado).
- Acesso rápido a "Configurações" (abre o painel de configuração descrito acima).

### Popup da extensão (ícone na barra do navegador)

- Atalho para Configurações completas.
- Status de conexão com o app Tauri (conectado/sincronizado vs. operando em cache).
- Resumo do dia: candidaturas feitas por plataforma, respeitando os limites diários configurados.

---

## BUSCA DE VAGAS VIA PARÂMETROS DE URL (LINKEDIN)

Implementar uma função `montarUrlBuscaLinkedIn(filtros)` que constrói a URL de busca já filtrada, usando os parâmetros confirmados:

```ts
function montarUrlBuscaLinkedIn(filtros: {
  palavraChave: string;
  geoId: string;
  distanciaKm?: number;
  apenasCandidaturaSimplificada: boolean; // sempre true neste projeto
  janelaTempo: "24h" | "semana" | "mes";
}): string {
  const params = new URLSearchParams({
    keywords: filtros.palavraChave,
    geoId: filtros.geoId,
    f_AL: filtros.apenasCandidaturaSimplificada ? "true" : "false",
  });
  if (filtros.distanciaKm) params.set("distance", String(filtros.distanciaKm));
  const janelaSegundos = { "24h": 86400, semana: 604800, mes: 2592000 }[filtros.janelaTempo];
  params.set("f_TPR", `r${janelaSegundos}`);
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}
```

- **Validar via teste manual** se existem outros parâmetros relevantes que valham a pena mapear (ex.: filtro de modelo de trabalho remoto/híbrido/presencial, nível de senioridade, tipo de vaga CLT/PJ) — inspecionar a URL gerada pela própria interface do LinkedIn ao aplicar cada filtro manualmente, mesmo método usado para descobrir os parâmetros já confirmados acima.
- Essa URL pode ser usada tanto para abrir a busca automaticamente a partir dos critérios do perfil do usuário (derivado do currículo, como já implementado) quanto como atalho dentro do próprio painel flutuante ("Buscar vagas com meus critérios").
- Manter o fluxo manual também disponível (usuário pesquisa à mão e clica "Iniciar Candidatura" na vaga aberta), para não obrigar o usuário a usar só a busca automática.

---

## REGRA "EMPRESAS BLOQUEADAS"

- Antes de processar qualquer vaga (automático ou manual), verificar se o nome da empresa da vaga corresponde (comparação case-insensitive, tolerando variações comuns como "S.A.", "Ltda", acentuação) a algum item da lista `empresasBloqueadas` do usuário.
- Se corresponder, **pular a vaga silenciosamente no modo automático** (log informativo "Vaga pulada: empresa bloqueada") e, no modo manual, desabilitar/ocultar o botão "Iniciar Candidatura" para aquela vaga com uma mensagem clara do motivo.

---

## O QUE SE MANTÉM INTEGRALMENTE DOS PROMPTS ANTERIORES (não reimplementar do zero)

- Arquitetura `PlatformHandler` + `HandlerGenerico` para descoberta/preenchimento de campos, incluindo suporte a combobox simples e "rico", fluxo em abas, fluxo sequencial tipo Typeform, e tratamento diferenciado de perguntas sensíveis/autodeclaração.
- Detecção automática de necessidade de login e validação prévia de campos obrigatórios antes de iniciar uma candidatura.
- Todas as mitigações de segurança de conta: limite diário configurável por plataforma, intervalo variável (não fixo) entre candidaturas, período de aquecimento para plataforma recém-conectada, pausa automática ao detectar sinal de restrição da plataforma.
- A regra central do projeto: **a IA nunca inventa, exagera ou remove informação real do usuário** ao adaptar currículo ou preencher respostas — mesmo com o toggle "Inteligência Artificial" ligado, a adaptação se limita a reorganizar/priorizar/reescrever com base no que é real, igual já especificado desde o início. O link do perfil do LinkedIn serve exatamente para a IA ter mais contexto real do usuário (habilidades, tempo de experiência) e não precisar inferir ou inventar isso.
- Ordem de segurança no envio: preencher → anexar currículo → enviar → só então confirmar, nunca confirmar antes do envio real ser validado pela própria plataforma.

---

## ENTREGA ESPERADA NESTA ETAPA

1. Migrar a configuração da extensão para `chrome.storage.local`, com a tela de Configurações própria (perfil LinkedIn, pretensão salarial, anos de experiência, empresas bloqueadas, toggle de IA) funcionando de forma independente do app Tauri.
2. Implementar o painel flutuante injetado na página (LinkedIn primeiro) com o guia de uso, botão "Iniciar Candidatura", contador de candidaturas, e status de IA.
3. Implementar `montarUrlBuscaLinkedIn()` e validar/expandir os parâmetros de filtro via teste manual.
4. Implementar a regra de "Empresas Bloqueadas".
5. Implementar a sincronização oportunista com o app Tauri (quando aberto) para currículo, respostas salvas e histórico consolidado, com reconciliação do que foi feito offline.
6. Testar o fluxo completo sem o app Tauri aberto nenhuma vez durante o teste, confirmando que a extensão funciona de ponta a ponta de forma independente, e depois testar a reconexão/sincronização ao abrir o app.

Pode me perguntar antes de começar se algo estiver ambíguo, mas priorize a migração de configuração para `chrome.storage.local` primeiro — é a mudança estrutural da qual tudo mais depende.
