# PROMPT TÉCNICO — AUTOCV: EXTENSÃO UNIVERSAL (DETECÇÃO DE LOGIN + VALIDAÇÃO DE CAMPOS OBRIGATÓRIOS POR PLATAFORMA)

Copie e cole o conteúdo abaixo na conversa com o Claude Opus (complementa o prompt anterior "Extensão de Navegador + Ponte Local". Generaliza a extensão para ser **plataforma-agnóstica**, capaz de lidar com qualquer site de vaga com login — LinkedIn, Indeed, Gupy, InfoJobs, e outras que surgirem —, em vez de ter lógica fixa por plataforma. Este prompt cobre duas capacidades novas: 1) a extensão identificar sozinha se uma plataforma exige conta/login, e 2) validar quais dados são exigidos pela plataforma antes de tentar automatizar, avisando o que falta.)

---

## CONTEXTO

A extensão prevista no prompt anterior foi desenhada com content scripts específicos por plataforma (Indeed primeiro, depois LinkedIn e Gupy). Isso funciona, mas escala mal — toda vez que quisermos suportar uma nova plataforma (InfoJobs, Catho, Trampos.co, Empregos.com.br, o que for), teríamos que escrever um content script novo do zero. Queremos generalizar a arquitetura para que a extensão seja **universal**: capaz de operar em qualquer plataforma de vaga, com handlers específicos só onde forem realmente necessários (particularidades de UI), e um motor genérico de fallback para o resto.

---

## PARTE A — ARQUITETURA "PLATFORM HANDLER" NA EXTENSÃO

Replicar, dentro da extensão, o mesmo princípio de modularidade já usado no core do app (`PlatformAdapter` no Rust) — criar uma interface `PlatformHandler` em JS/TS:

```ts
interface PlatformHandler {
  dominios: string[]; // ex: ["linkedin.com"], ["*.indeed.com", "indeed.com.br"]
  precisaLogin(): Promise<boolean>;
  detectaTelaLogin(): boolean;
  descobrirCamposFormulario(): Promise<CampoFormulario[]>;
  preencherCampo(campo: CampoFormulario, valor: string): Promise<void>;
  avancarEtapa(): Promise<boolean>;
  detectaEnvioConcluido(): Promise<boolean>;
}
```

- Manter um **registro central** (`registroPlataformas.ts` ou similar) mapeando domínio → handler específico, quando existir um implementado (ex.: `LinkedinHandler`, `IndeedHandler`, `GupyHandler`, `InfoJobsHandler`).
- Se o domínio atual **não tiver handler específico registrado**, cair automaticamente no `HandlerGenerico` (Parte C abaixo), que tenta aplicar as mesmas heurísticas já construídas para o motor de formulário adaptativo do InHire (agora reimplementadas em JS, rodando como content script) — reaproveitar a lógica conceitual já validada: descoberta de campos por `role`/`aria-label`, classificação fixo/pergunta extra/pergunta sensível, suporte a combobox simples e "rico" (texto duplo), suporte a fluxo sequencial tipo Typeform, navegação entre etapas por destravamento.
- Isso significa: plataformas conhecidas e com particularidades específicas ganham handler dedicado (mais robusto); plataformas novas/desconhecidas já funcionam de forma best-effort pelo genérico, sem precisar de código novo para cada uma.

---

## PARTE B — DETECÇÃO AUTOMÁTICA DE "PRECISA DE CONTA/LOGIN"

Ao carregar em qualquer página de vaga (de qualquer domínio, conhecido ou não), a extensão deve determinar automaticamente se aquela plataforma exige login para se candidatar, sem depender de uma lista fixa mantida manualmente:

### Heurísticas de detecção (`precisaLogin()`)

1. **Checar indícios de sessão já autenticada** na própria página: presença de elementos típicos de usuário logado (avatar, nome, menu de conta, botão "Sair"/"Logout") via seletores genéricos comuns (`[aria-label*="conta" i]`, `[aria-label*="perfil" i]`, `img[alt*="avatar" i]`, etc.) — se detectar isso, considerar `logado = true` e seguir.
2. **Se não achar sinais de logado**, tentar identificar o botão/ação de candidatura na página (heurística por texto: "Candidatar-se", "Aplicar", "Apply", "Enviar candidatura", "Inscrever-se") e simular apenas a **detecção de resultado do clique** (não o clique real automatizado sem confirmação, nesta fase de diagnóstico): se ao clicar (ou ao inspecionar o comportamento esperado do botão via atributos como `href` apontando para `/login`, ou um modal de login que abre) a plataforma redireciona para uma URL de login (`/login`, `/signin`, `/entrar`, `/auth`) ou abre um modal com campos de usuário/senha, marcar `precisaLogin = true`.
3. Persistir o resultado dessa detecção (por domínio) num cache local da extensão, para não precisar reavaliar isso toda vez que o usuário abrir uma vaga da mesma plataforma — mas permitir invalidar esse cache manualmente (ex.: se a plataforma mudar o comportamento, ou se o usuário desconectar a conta).
4. Reportar o resultado de volta ao app Tauri via o protocolo já definido (novo tipo de evento, ex. `{"tipo": "PLATAFORMA_DETECTADA", "dominio": "...", "precisaLogin": true, "logadoAtualmente": false}`), para a tela Plataformas do app conseguir exibir automaticamente novas plataformas encontradas e seu status de login, mesmo sem terem sido cadastradas manualmente antes.

### Onde isso é usado

Na aba Plataformas do app, além dos cards já fixos (LinkedIn, Indeed, Gupy, InfoJobs), adicionar uma seção "Plataformas detectadas automaticamente" que lista qualquer domínio novo que a extensão tenha reportado durante o uso (ex.: o usuário abriu manualmente uma vaga da Trampos.co, a extensão rodou a detecção, e agora ela aparece na lista com status "Detectada — sem handler dedicado, usando motor genérico" e indicação se precisa de login ou não).

---

## PARTE C — VALIDAÇÃO DE CAMPOS OBRIGATÓRIOS POR PLATAFORMA (ANTES DE AUTOMATIZAR)

Antes de a extensão tentar de fato preencher e enviar uma candidatura numa plataforma (seja com handler dedicado ou com o genérico), rodar uma etapa de **validação prévia** que evita começar uma candidatura destinada a travar no meio por falta de dado:

1. `descobrirCamposFormulario()` roda em modo "somente leitura" primeiro: mapeia todos os campos do formulário de candidatura daquela vaga (mesma lógica de descoberta já especificada), sem preencher nada ainda.
2. Para cada campo descoberto, cruzar com os dados disponíveis no perfil do usuário (enviados pelo app Tauri via a ponte de comunicação): nome, e-mail, telefone, LinkedIn, pretensão salarial, regime preferido, currículo, e respostas salvas de perguntas extras/sensíveis.
3. Montar uma lista de **campos obrigatórios sem dado disponível** (nem no perfil, nem em resposta salva) e enviar de volta ao app um evento de diagnóstico, ex.:
```json
{
  "tipo": "VALIDACAO_CAMPOS",
  "vagaId": "abc123",
  "dominio": "infojobs.com.br",
  "camposFaltando": [
    { "pergunta": "Link do portfólio", "obrigatorio": true },
    { "pergunta": "Pretensão salarial em EUR", "obrigatorio": true }
  ]
}
```
4. **Antes de iniciar a automação de fato** (tanto no modo automático quanto no manual — inclusive antes de mostrar a vaga como "candidatável" na fila), se houver campos obrigatórios faltando, o app deve avisar o usuário (mesmo mecanismo de pausa/input dinâmico já existente) **em vez de deixar a extensão tentar candidatar e travar no meio do formulário**. Isso evita candidaturas incompletas/abandonadas no meio, que podem ficar mal vistas pela plataforma ou pela empresa.
5. Essa validação prévia também serve como uma funcionalidade de produto interessante por si só: ao conectar uma plataforma nova pela primeira vez, rodar essa validação numa vaga de exemplo e mostrar ao usuário, de cara, "essa plataforma vai pedir X, Y, Z que você ainda não configurou" — incentivando o usuário a completar o perfil/Configurações antes de ligar a automação.

---

## PARTE D — MOTOR GENÉRICO (`HandlerGenerico`) COMO FALLBACK UNIVERSAL

Implementar o `HandlerGenerico` reaproveitando, em JavaScript/TypeScript (portando a lógica já validada em Rust/Playwright para o contexto do content script), os seguintes comportamentos já especificados nos prompts anteriores do motor de formulário do InHire:

- Descoberta de campos por `role`/`aria-label`/estrutura DOM, com fallback quando não há atributo semântico.
- Classificação em: campo fixo conhecido, pergunta extra (busca por resposta salva ou pausa), pergunta sensível/autodeclaração (nunca reuso por similaridade, política de opcional/obrigatório já definida).
- Suporte a dropdown/combobox simples e "rico" (texto duplo).
- Suporte a navegação por abas que destravam e a fluxo sequencial (uma pergunta por tela, tipo Typeform), com detecção de qual paradigma está em uso na tela atual.
- Limite de iterações de segurança e pausa com log claro quando encontra um tipo de campo não reconhecido, em vez de travar silenciosamente ou preencher errado.

O `HandlerGenerico` deve ser o "motor de verdade" por trás de qualquer plataforma sem handler dedicado — e handlers dedicados (LinkedIn, Indeed, Gupy) podem, inclusive, **reaproveitar/chamar** o genérico internamente para as partes do formulário que seguem padrões comuns, sobrescrevendo só os pontos específicos daquela plataforma (ex.: o jeito peculiar de o LinkedIn abrir o modal de candidatura simplificada).

---

## REQUISITOS NÃO FUNCIONAIS

- Toda detecção automática (precisa login, campos faltando) deve ser **conservadora**: na dúvida, reportar como "não tenho certeza, revise manualmente" em vez de assumir e deixar a automação seguir com informação errada.
- Cache de detecção por domínio (Parte B) deve ter validade (ex.: reavaliar a cada X dias ou quando o usuário forçar manualmente), já que plataformas mudam o fluxo de login/candidatura com o tempo.
- Logs de diagnóstico dessa etapa (detecção de login, validação de campos) devem aparecer no mesmo console de log em tempo real já usado no restante do app, com uma tag clara indicando que vieram da extensão e de qual domínio.

---

## ENTREGA ESPERADA NESTA ETAPA

1. Refatorar a extensão para a interface `PlatformHandler` + registro central de domínios (Parte A), migrando os handlers já existentes (Indeed) para esse formato.
2. Implementar a detecção automática de login (Parte B) e a integração com a tela Plataformas do app para listar plataformas detectadas dinamicamente.
3. Implementar a validação prévia de campos obrigatórios (Parte C), incluindo o evento `VALIDACAO_CAMPOS` e a pausa/aviso ao usuário antes de iniciar automação com dados faltando.
4. Implementar o `HandlerGenerico` (Parte D), portando a lógica já validada do motor de formulário do InHire.
5. Testar contra pelo menos uma plataforma **sem handler dedicado** (ex.: InfoJobs, usando só o genérico) para validar que a detecção de login, a validação de campos e o preenchimento funcionam de forma aceitável mesmo sem código específico para ela.

Pode me perguntar antes de começar se algo estiver ambíguo, mas priorize a Parte A (arquitetura de handler) primeiro, já que as outras partes dependem dela para se encaixar de forma organizada.
