// Tradução profissional de currículo para inglês.
// Se a IA estiver configurada (Gemini ou Claude em Configurações › Inteligência Artificial),
// utiliza o modelo com prompt executivo especializado em currículos técnicos.
// Caso a IA não esteja configurada ou ocorra falha de rede/cota, utiliza o motor de tradução
// de alto desempenho (Google GTX) com preservação estrita de Markdown e formatação.

import { completar, iaAtiva } from '../ia.ts';

const PROMPT_SISTEMA_IA = `You are a professional executive resume translator and localization consultant for international technology careers.
Your job is to translate Brazilian Portuguese tech resumes into fluent, idiomatic, professional English suitable for US, European, and global tech roles.

Strict Rules:
1. Maintain the exact Markdown formatting, structure, headers (# and ##), bullet points (- or •), bold tags (**), links, emails, and layout.
2. Standardize section headers:
   - "Resumo" / "Resumo Profissional" / "Sobre" -> "Professional Summary"
   - "Experiência" / "Experiência Profissional" / "Histórico" -> "Professional Experience"
   - "Formação" / "Formação Acadêmica" / "Educação" -> "Education"
   - "Habilidades" / "Competências" / "Competências Técnicas" -> "Technical Skills"
   - "Projetos" / "Projetos Relevantes" -> "Key Projects"
   - "Certificações" / "Cursos" -> "Certifications"
   - "Idiomas" -> "Languages"
3. Use strong, action-oriented past tense verbs for past achievements (e.g., Developed, Engineered, Designed, Implemented, Streamlined, Led, Optimized, Reduced, Increased).
4. Accurately translate career levels: "Júnior" -> "Junior", "Pleno" -> "Mid-Level", "Sênior" -> "Senior", "Estagiário" -> "Intern".
5. Translate time and date references: "Presente" / "Atual" / "Atualmente" -> "Present", "Janeiro" -> "January", etc.
6. Never invent, embellish, or omit facts, numbers, dates, tools, companies, or metrics.
7. Return ONLY the translated Markdown. Do not include any introductory commentary or markdown code fences (like \`\`\`markdown).`;

/** Traduz texto via motor de tradução Google GTX livre e sem dependências de chave. */
async function traduzirViaGtx(texto: string): Promise<string> {
  if (!texto.trim()) return '';
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=pt&tl=en&dt=t&q=${encodeURIComponent(texto)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Falha na tradução GTX: HTTP ${resp.status}`);
  const dados = (await resp.json()) as [Array<[string, string]>];
  return dados[0].map(item => item[0]).join('');
}

/** Pós-processamento para garantir cabeçalhos padronizados e convenções idiomáticas de currículo em inglês. */
function normalizarCabecalhosIngles(md: string): string {
  let resultado = md;
  const mapa: Array<[RegExp, string]> = [
    [/^##\s*(?:Resumo\s*Profissional|Professional\s*Summary|Summary|Sobre|About\s*Me)\b/im, '## Professional Summary'],
    [/^##\s*(?:Experi[êe]ncia\s*Profissional|Professional\s*Experience|Work\s*Experience|Hist[óo]rico\s*Profissional)\b/im, '## Professional Experience'],
    [/^##\s*(?:Forma[çc][ãa]o\s*Acad[êe]mica|Academic\s*Training|Academic\s*Formation|Education|Educa[çc][ãa]o)\b/im, '## Education'],
    [/^##\s*(?:Compet[êe]ncias\s*T[ée]cnicas|Technical\s*Skills|Skills|Habilidades|Compet[êe]ncias)\b/im, '## Technical Skills'],
    [/^##\s*(?:Certifica[çc][õo]es|Certifications|Cursos\s*e\s*Certifica[çc][õo]es)\b/im, '## Certifications'],
    [/^##\s*(?:Projetos|Key\s*Projects|Projetos\s*Relevantes|Projects)\b/im, '## Key Projects'],
    [/^##\s*(?:Idiomas|Languages)\b/im, '## Languages'],
    [/\b(?:Presente|Atual|Atualmente)\b/gi, 'Present'],
  ];

  for (const [re, subst] of mapa) {
    resultado = resultado.replace(re, subst);
  }

  // Remove eventuais blocos de código markdown triplos ```markdown no início ou fim
  resultado = resultado
    .replace(/^```markdown\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  return resultado;
}

/**
 * Traduz o Markdown do currículo completo para inglês.
 * Prioriza a IA configurada no sistema; se inativa ou se falhar, utiliza o motor GTX com chunking por parágrafos.
 */
export async function traduzirCurriculoParaIngles(markdown: string): Promise<string> {
  const limpo = markdown.trim();
  if (!limpo) return '';

  // 1. Tenta tradução por IA caso configurada
  if (iaAtiva()) {
    try {
      const respostaIA = await completar(PROMPT_SISTEMA_IA, limpo);
      if (respostaIA?.trim()) {
        return normalizarCabecalhosIngles(respostaIA);
      }
    } catch {
      // Falha na chamada da IA (cota, timeout, chave) cai suavemente para o motor GTX
    }
  }

  // 2. Motor de tradução GTX com divisão por blocos/parágrafos para preservar integridade
  const blocos = limpo.split(/\n{2,}/);
  const traduzidos: string[] = [];

  for (const bloco of blocos) {
    const b = bloco.trim();
    if (!b) continue;

    // Se for cabeçalho de seção padrão, mapeia direto
    if (/^##\s*(?:Resumo|Experi|Forma|Habil|Compet|Certif|Projet|Idioma)/i.test(b)) {
      traduzidos.push(normalizarCabecalhosIngles(b));
      continue;
    }

    try {
      const parteTraduzida = await traduzirViaGtx(b);
      traduzidos.push(parteTraduzida);
    } catch {
      // Se falhar a tradução de um bloco isolado, mantém o bloco original
      traduzidos.push(b);
    }
  }

  return normalizarCabecalhosIngles(traduzidos.join('\n\n'));
}
