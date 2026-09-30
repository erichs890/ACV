// Cliente do núcleo local (core/server.ts). Só fala com localhost.
export const URL_CORE = import.meta.env.VITE_CORE_URL ?? 'http://localhost:4780';

export async function api<T = unknown>(caminho: string, init?: RequestInit): Promise<T> {
  const r = await fetch(URL_CORE + caminho, { headers: { 'content-type': 'application/json' }, ...init });
  if (!r.ok) {
    const erro = (await r.json().catch(() => ({}))) as { erro?: string };
    throw new Error(erro.erro ?? `${r.status} ${r.statusText}`);
  }
  return r.json() as Promise<T>;
}

export const post = <T = unknown>(caminho: string, dados: unknown = {}) => api<T>(caminho, { method: 'POST', body: JSON.stringify(dados) });

export async function enviarCurriculo(arquivo: File) {
  const r = await fetch(`${URL_CORE}/curriculos?nome=${encodeURIComponent(arquivo.name)}`, { method: 'POST', body: arquivo });
  if (!r.ok) throw new Error('falha ao enviar o currículo ao núcleo');
  return r.json();
}

export const urlArquivo = (caminho: string) => `${URL_CORE}/arquivo?caminho=${encodeURIComponent(caminho)}`;

export const urlDownloadArquivo = (caminho: string, nome?: string) => `${URL_CORE}/arquivo?caminho=${encodeURIComponent(caminho)}&baixar=1${nome ? `&nome=${encodeURIComponent(nome)}` : ''}`;

export async function traduzirCurriculoIngles(id: number, refazer = false): Promise<{ inglesMarkdown: string; pdf: string; caminho: string; nome: string }> {
  return post('/curriculo/ingles', { id, refazer });
}

export async function salvarCurriculoComoNovo(nome: string, markdown: string) {
  return post('/curriculo/salvar-markdown', { nome, markdown });
}
