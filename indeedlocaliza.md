# PROMPT TÉCNICO — ACV: PLATAFORMA INDEED (CANDIDATURA SIMPLIFICADA) + LOCALIZAÇÃO MULTI-PAÍS PARA REMOTO

Copie e cole o conteúdo abaixo na conversa com o Fable (complementa todos os prompts anteriores. Tem duas partes: a Parte A adiciona uma segunda plataforma usando a arquitetura modular `PlatformAdapter` já criada; a Parte B muda a estrutura de localização do perfil do usuário, e essa mudança afeta tanto o InHire quanto o Indeed).

---

## PARTE A — NOVO ADAPTER: INDEED (SOMENTE VAGAS COM "CANDIDATAR-SE FACILMENTE")

### Escopo

Implementar `IndeedAdapter` seguindo a mesma interface `PlatformAdapter` já usada pelo InHire (login/sessão, busca de vagas, preenchimento e envio de candidatura). Na aba "Plataformas" do app, o card "Indeed" passa a ficar **ativo** (junto com o InHire); os demais continuam "Indisponível".

**Restrição central:** o robô só deve considerar vagas do Indeed que tenham o selo/filtro **"Candidatar-se facilmente"** (também aparece como "Candidate-se facilmente" ou "Candidatura simplificada" dependendo da tela — é a nomenclatura oficial do Indeed para o fluxo em que a candidatura acontece dentro do próprio Indeed, sem redirecionar para o site da empresa). Qualquer vaga que redirecione para um site externo de candidatura deve ser **descartada na etapa de busca**, nem entrando na fila — não tentar automatizar formulários de terceiros fora do Indeed.

### 1. Busca de vagas

- Investigar (DevTools/Network, mesmo método já usado no InHire) se a busca de vagas do Indeed tem um **filtro nativo na URL ou nos parâmetros de busca** para restringir resultados só a vagas com candidatura simplificada (algo como um parâmetro `sjrs=` ou filtro de UI "Candidatar-se facilmente" na barra lateral de filtros) — se existir, usar isso diretamente na query, é muito mais eficiente do que abrir cada vaga para checar.
- Se não houver parâmetro de URL confiável, como fallback: extrair a lista de vagas da página de resultados e verificar, para cada uma, se o card/listagem exibe o selo "Candidatar-se facilmente" antes de abrir a vaga — descartar as que não têm.
- Aplicar os mesmos filtros de área/cargo/senioridade já derivados do perfil do currículo do usuário (reaproveitar a mesma lógica de perfil de busca já implementada para o InHire).
- Extrair de cada vaga: título, empresa, descrição completa, requisitos, regime (CLT/PJ, quando informado — no Indeed geralmente aparece como "Tipo de vaga"), modelo de trabalho (presencial/híbrido/remoto) e localização.
- Persistir na mesma tabela `vagas` já usada pelo InHire, com uma coluna indicando a plataforma de origem (`inhire` / `indeed`), para o restante do pipeline (score de compatibilidade, fila, Painel) continuar funcionando de forma unificada entre plataformas.

### 2. Login/sessão

- Implementar autenticação no Indeed (login com e-mail/senha ou sessão via cookies persistidos localmente e criptografados, mesmo padrão de segurança já definido para o InHire).
- Tratar possíveis captchas/verificações extras de login de forma segura: se o Indeed exigir verificação manual (captcha, confirmação por e-mail), pausar e notificar o usuário para completar manualmente uma vez, em vez de tentar contornar automaticamente.

### 3. Preenchimento e envio da candidatura ("Candidatar-se facilmente")

- O fluxo de "Candidatar-se facilmente" do Indeed normalmente abre um formulário (modal ou painel dentro da própria página, sem sair do domínio Indeed) pedindo dados como currículo, telefone, e às vezes perguntas de triagem específicas da vaga (múltipla escolha, sim/não, texto livre) — ou seja, **reaproveitar integralmente o motor de formulário adaptativo já construído** para o InHire (descoberta de campos, classificação fixo/pergunta extra, tratamento de perguntas sensíveis/autodeclaração, suporte a combobox simples e "rico", suporte a fluxo sequencial tipo Typeform se aparecer) — não reimplementar essa lógica do zero para o Indeed. O `IndeedAdapter` deve chamar o mesmo motor genérico, passando os seletores/contexto específicos do Indeed.
- Investigar via DevTools se o Indeed permite anexar um currículo em PDF diretamente (upload de arquivo) ou se força o uso do "currículo Indeed" (perfil preenchido na própria plataforma) — se for isso, documentar essa diferença, porque pode exigir manter um "currículo Indeed" sincronizado com o currículo principal do usuário como pré-requisito, algo que o InHire não tinha.
- Manter a mesma ordem de segurança já definida: preencher formulário → anexar currículo → enviar → só então registrar confirmação (nunca confirmar antes de o Indeed retornar sucesso real).
- Aplicar a mesma regra de adaptação de currículo por vaga já definida (nunca inventar informação, apenas reorganizar/priorizar com base no currículo real do usuário).

### 4. Integração com fila, modo automático/manual e preview

Reaproveitar sem alteração toda a lógica já especificada nos prompts anteriores: fila com timer, modo automático vs. manual ("Quero me candidatar"), preview do currículo adaptado configurável, tratamento de perguntas extras via evento em tempo real, e distinção entre pergunta comum e pergunta sensível de autodeclaração.

---

## PARTE B — LOCALIZAÇÃO MULTI-PAÍS PARA VAGAS REMOTAS

### Problema atual

O perfil do usuário hoje só permite uma localização única, mas isso não cobre o caso real: o usuário quer se candidatar a vagas **presenciais** apenas na própria cidade (ex.: Fortaleza), mas a vagas **100% remotas** de **múltiplos países** (ex.: Brasil e Portugal), já que trabalho remoto internacional é elegível mesmo morando no Brasil.

### Mudança no modelo de dados do perfil

Substituir o campo único de localização por dois campos independentes em Configurações → Meus Dados (ou em uma nova seção "Preferências de Localização"):

```ts
type PreferenciasLocalizacao = {
  localizacaoPresencial: string; // uma cidade/região só, ex: "Fortaleza, CE"
  paisesRemoto: string[]; // multi-seleção, ex: ["Brasil", "Portugal"]
};
```

- **`localizacaoPresencial`**: campo único (autocomplete de cidade, se possível), usado apenas para filtrar vagas presenciais e híbridas.
- **`paisesRemoto`**: campo de multi-seleção (chips/tags, permitindo adicionar quantos países quiser), usado apenas para filtrar vagas 100% remotas. Interface: campo de busca com autocomplete de países, e cada país selecionado vira uma tag removível (padrão comum de multi-select).

### Como isso afeta a busca de vagas (InHire e Indeed)

A lógica de filtro de vaga por localização precisa considerar o **modelo de trabalho da vaga** antes de decidir qual critério de localização aplicar:

- Se a vaga é **presencial** ou **híbrida** → comparar com `localizacaoPresencial`. Só entra na fila/resultado se a localização da vaga bater (mesma cidade/região, ou dentro de um raio razoável, se quiser adicionar essa flexibilidade depois).
- Se a vaga é **100% remota** → comparar com `paisesRemoto`. A vaga entra no resultado se o país dela (ou o país-alvo declarado pela empresa, quando a vaga remota é restrita a candidatos de um país específico) estiver na lista de `paisesRemoto` do usuário — **ou** se a vaga remota não especificar restrição de país nenhuma (remoto "de qualquer lugar"), tratar como compatível também.
- Implementar essa regra como uma função central reutilizável (ex.: `vagaCompativelComLocalizacao(vaga, preferencias) -> bool`) chamada por ambos os adapters (InHire e Indeed) e pelo cálculo de score de compatibilidade, para não duplicar a lógica em cada plataforma.

### Como isso afeta a busca no Indeed especificamente

O Indeed opera em **domínios separados por país** (ex. `indeed.com.br`, `indeed.pt`, `indeed.com`), cada um com seu próprio índice de vagas — uma vaga remota aberta para Portugal pode estar listada só no domínio `indeed.pt`, não no `indeed.com.br`. Portanto:

- Para vagas **presenciais**, buscar apenas no domínio correspondente à `localizacaoPresencial` do usuário (ex.: `indeed.com.br` para uma busca em Fortaleza).
- Para vagas **remotas**, rodar uma busca **separada em cada domínio correspondente a cada país de `paisesRemoto`** (ex.: uma busca em `indeed.com.br` com filtro "remoto" e outra em `indeed.pt` com filtro "remoto"), consolidando os resultados na mesma tabela `vagas` e removendo duplicatas (uma mesma vaga pode aparecer indexada em mais de um domínio Indeed).
- Documentar no código o mapeamento país → domínio Indeed usado (confirmar os domínios reais via teste manual antes de codificar, já que o Indeed pode ter nomenclaturas específicas por país que não seguem um padrão único previsível).

### Como isso afeta a busca no InHire

Como o InHire não segmenta por domínio de país da mesma forma (cada empresa tem seu próprio subdomínio, independente de país), o filtro de localização remota/presencial se aplica **depois** da extração de vagas (na função central `vagaCompativelComLocalizacao`), usando o campo de localização/modelo de trabalho que já é extraído de cada vaga no módulo de descoberta.

---

## ENTREGA ESPERADA NESTA ETAPA

1. **Parte B primeiro** (mudança de modelo de dados e UI de localização), já que a Parte A depende dela para filtrar corretamente as buscas no Indeed por país.
2. Implementar `IndeedAdapter`: login/sessão, busca de vagas restrita a "Candidatar-se facilmente" (com o filtro de URL, se existir, ou o fallback de checagem por selo).
3. Conectar o `IndeedAdapter` ao motor de formulário adaptativo já existente (reaproveitando, não reimplementando).
4. Implementar a busca multi-domínio para vagas remotas por país (`paisesRemoto`).
5. Testar de ponta a ponta: uma vaga presencial em Fortaleza sendo encontrada e uma vaga 100% remota de Portugal sendo encontrada e filtrada corretamente, ambas no Indeed; e confirmar que a Parte B não quebrou o filtro de localização já existente no InHire.
6. Atualizar a aba Plataformas para refletir Indeed como "Conectado"/ativo junto ao InHire.

Pode me perguntar antes de começar se algo estiver ambíguo, mas priorize confirmar via DevTools se existe mesmo um filtro de URL nativo para "Candidatar-se facilmente" antes de implementar o fallback por selo — isso muda bastante a eficiência da busca.
