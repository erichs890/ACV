// Verificação executável de ponta a ponta dos adapters:
// Divulga Vagas, Quickin, Workable e Arbeitnow contra servidores locais mock.
// Testa com o navegador real (Edge/Chrome headless via Playwright):
//   - Preenchimento real de formulários e upload de PDF
//   - Prova de rede (HTTP 2xx na rota de envio)
//   - Tolerância a variações na redação da tela de sucesso
//   - Recusa pelo servidor (HTTP 4xx) com motivo real
//   - Modo ensaio (zero requisições de envio disparadas)
//   - Proteção de declarações sensíveis (ex: PcD no Divulga Vagas)
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'autocv-adapters-check-'));
process.env.AUTOCV_DIR = DIR;
process.env.AUTOCV_PERFIL = join(DIR, 'navegador');

const { divulgavagas } = await import('./platforms/divulgavagas/index.ts');
const { quickin } = await import('./platforms/quickin/index.ts');
const { workable } = await import('./platforms/workable/index.ts');
const { arbeitnow } = await import('./platforms/arbeitnow/index.ts');
const { fecharNavegador } = await import('./browser.ts');

import type { DadosCandidatura } from './platforms/adapter.ts';
import type { Vaga } from '../src/types.ts';

const curriculo = join(DIR, 'cv.pdf');
writeFileSync(curriculo, '%PDF-1.4 teste curriculo');

const dadosBase: DadosCandidatura = {
  nome: 'Marina Pitanga',
  email: 'marina@exemplo.com',
  celular: '11982324410',
  linkedin: 'https://linkedin.com/in/marina',
  cidade: 'Campinas - SP',
  cpf: '52998224725',
  pretensao: '4500',
  regime: 'CLT',
  curriculoPdf: curriculo,
  responder: () => null,
  ensaio: false,
  mostrarNavegador: false,
};

const silencio = () => {};

// ============================================================================
// 1. DIVULGA VAGAS
// ============================================================================
console.log('\n--- Testando Adapter: Divulga Vagas ---');

const paginaDivulga = (desfecho: 'sucesso' | 'redacao-nova' | 'recusa', pcd = false) => `<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><title>Divulga Vagas - Candidatura</title>
<body>
<form id="cvForm" action="/envioCV" method="POST" enctype="multipart/form-data">
  <input type="hidden" name="id_vaga" value="999123">
  <input type="file" id="arquivo_1" name="curriculo" required>
  <label><input type="checkbox" id="politica" name="politica" required> Aceito os termos e política</label>
  <div id="pcd-container" style="display: ${pcd ? 'block' : 'none'};">
    <label><input type="checkbox" id="pcd" name="pcd"> Estou ciente de que esta é uma vaga para PCD e me enquadro nos requisitos.</label>
  </div>
  <button type="submit">Enviar Currículo</button>
</form>
<div id="msg"></div>
<script>
document.getElementById('cvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/envioCV', { method: 'POST', body: new FormData(e.target) });
  const form = document.getElementById('cvForm');
  const msg = document.getElementById('msg');
  ${
    desfecho === 'sucesso'
      ? `form.remove(); msg.textContent = 'Currículo enviado com sucesso!';`
      : desfecho === 'redacao-nova'
        ? `form.remove(); msg.textContent = 'Recebemos o documento. Entraremos em contato.';`
        : `msg.textContent = 'Erro ao processar envio.';`
  }
});
</script>
</body></html>`;

function subirDivulga(desfecho: 'sucesso' | 'redacao-nova' | 'recusa', pcd = false): Promise<{ url: string; servidor: Server; posts: number }> {
  const estado = { posts: 0 };
  const servidor = createServer((req, res) => {
    if (req.url?.includes('/envioCV')) {
      estado.posts++;
      if (desfecho === 'recusa') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Arquivo corrompido' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(paginaDivulga(desfecho, pcd));
  });

  return new Promise(resolve => {
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/envioCurriculo/999123`,
        servidor,
        get posts() {
          return estado.posts;
        },
      });
    });
  });
}

const vagaDivulga = (url: string): Vaga => ({
  id: 'divulgavagas:999123',
  plataforma: 'divulgavagas',
  tenant: 'divulgavagas',
  titulo: 'Desenvolvedora Back-end',
  empresa: 'Empresa Confidencial',
  descricao: '',
  requisitos: '',
  regime: 'CLT',
  modelo: 'remoto',
  local: 'Remoto',
  url,
  skills: [],
  camposConhecidos: [],
  score: 85,
  status: 'em_andamento',
  encontradaEm: new Date().toISOString(),
  atualizadaEm: new Date().toISOString(),
});

// A) Caminho feliz
{
  const s = await subirDivulga('sucesso');
  try {
    const r = await divulgavagas.candidatar(vagaDivulga(s.url), dadosBase, silencio);
    assert.equal(r.status, 'enviada', `esperava enviada, veio ${r.status}`);
    assert.equal(s.posts, 1, 'esperava exatamente 1 envio');
    console.log('✓ Divulga Vagas: Envio aceito e confirmado na tela → enviada (1 POST)');
  } finally {
    s.servidor.close();
  }
}

// B) Prova de rede > redação da tela
{
  const s = await subirDivulga('redacao-nova');
  try {
    const r = await divulgavagas.candidatar(vagaDivulga(s.url), dadosBase, silencio);
    assert.equal(r.status, 'enviada', `esperava enviada por prova de rede, veio ${r.status}`);
    assert.equal(s.posts, 1, 'esperava exatamente 1 envio');
    console.log('✓ Divulga Vagas: Prova de rede HTTP 200 garante envio mesmo com tela diferente');
  } finally {
    s.servidor.close();
  }
}

// C) Recusa do servidor
{
  const s = await subirDivulga('recusa');
  try {
    const r = await divulgavagas.candidatar(vagaDivulga(s.url), dadosBase, silencio);
    assert.equal(r.status, 'erro', 'esperava erro na recusa');
    assert.match(r.status === 'erro' ? r.motivo : '', /400|recusou/);
    console.log('✓ Divulga Vagas: Recusa do servidor capturada com sucesso');
  } finally {
    s.servidor.close();
  }
}

// D) Ensaio
{
  const s = await subirDivulga('sucesso');
  try {
    const r = await divulgavagas.candidatar(vagaDivulga(s.url), { ...dadosBase, ensaio: true }, silencio);
    assert.equal(r.status, 'ensaio', `esperava ensaio, veio ${r.status}`);
    assert.equal(s.posts, 0, 'em modo ensaio NENHUMA requisição pode ser disparada');
    console.log('✓ Divulga Vagas: Modo ensaio não dispara POST (0 POST)');
  } finally {
    s.servidor.close();
  }
}

// E) Invariante PcD: não assina autodeclaração
{
  const s = await subirDivulga('sucesso', true);
  try {
    const r = await divulgavagas.candidatar(vagaDivulga(s.url), dadosBase, silencio);
    assert.equal(r.status, 'erro', 'esperava recusa por vaga PcD exclusiva');
    assert.match(r.status === 'erro' ? r.motivo : '', /PcD/i);
    assert.equal(s.posts, 0, 'não pode enviar currículo em vaga PcD com autodeclaração');
    console.log('✓ Divulga Vagas: Proteção de vaga exclusiva PcD acionada corretamente');
  } finally {
    s.servidor.close();
  }
}

// ============================================================================
// 2. QUICKIN
// ============================================================================
console.log('\n--- Testando Adapter: Quickin ---');

const paginaQuickin = (desfecho: 'sucesso' | 'redacao-nova' | 'recusa') => `<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><title>Quickin Jobs - Apply</title>
<body>
<form id="applyForm">
  <input id="name" required>
  <input id="email" type="email" required>
  <input placeholder="(00) 00000-0000" id="phone">
  <input id="salary">
  <input id="city">
  <input id="address">
  <input type="file" id="validatedCustomFile" required>
  <input type="checkbox" id="consent" required>
  <button type="submit">Finalizar Inscrição</button>
</form>
<div id="status"></div>
<script>
document.getElementById('applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/public/acme/apply', { method: 'POST', body: '{}' });
  const form = document.getElementById('applyForm');
  const status = document.getElementById('status');
  ${
    desfecho === 'sucesso'
      ? `form.remove(); status.textContent = 'Candidatura enviada com sucesso!';`
      : desfecho === 'redacao-nova'
        ? `form.remove(); status.textContent = 'Obrigado. Dados recebidos!';`
        : `status.textContent = 'Erro ao registrar candidatura';`
  }
});
</script>
</body></html>`;

function subirQuickin(desfecho: 'sucesso' | 'redacao-nova' | 'recusa'): Promise<{ url: string; servidor: Server; posts: number }> {
  const estado = { posts: 0 };
  const servidor = createServer((req, res) => {
    if (req.url?.includes('/public/acme/apply')) {
      estado.posts++;
      if (desfecho === 'recusa') {
        res.writeHead(422, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'E-mail já cadastrado nesta vaga' }));
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end('{"id":"cand-123"}');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(paginaQuickin(desfecho));
  });

  return new Promise(resolve => {
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/acme/apply?job_id=job987`,
        servidor,
        get posts() {
          return estado.posts;
        },
      });
    });
  });
}

const vagaQuickin = (url: string): Vaga => ({
  id: 'quickin:job987',
  plataforma: 'quickin',
  tenant: 'acme',
  titulo: 'Pessoa Engenheira de Software',
  empresa: 'Acme Corp',
  descricao: '',
  requisitos: '',
  regime: 'CLT',
  modelo: 'remoto',
  local: 'Remoto',
  url,
  skills: [],
  camposConhecidos: [],
  score: 88,
  status: 'em_andamento',
  encontradaEm: new Date().toISOString(),
  atualizadaEm: new Date().toISOString(),
});

// A) Caminho feliz
{
  const s = await subirQuickin('sucesso');
  try {
    const r = await quickin.candidatar(vagaQuickin(s.url), dadosBase, silencio);
    assert.equal(r.status, 'enviada', `esperava enviada, veio ${r.status}`);
    assert.equal(s.posts, 1, 'esperava exatamente 1 envio');
    console.log('✓ Quickin: Envio aceito e confirmado na tela → enviada (1 POST)');
  } finally {
    s.servidor.close();
  }
}

// B) Prova de rede HTTP 201
{
  const s = await subirQuickin('redacao-nova');
  try {
    const r = await quickin.candidatar(vagaQuickin(s.url), dadosBase, silencio);
    assert.equal(r.status, 'enviada', `esperava enviada, veio ${r.status}`);
    assert.equal(s.posts, 1, 'esperava exatamente 1 envio');
    console.log('✓ Quickin: Prova de rede HTTP 201 garante envio mesmo sem texto padrão na tela');
  } finally {
    s.servidor.close();
  }
}

// C) Recusa do servidor
{
  const s = await subirQuickin('recusa');
  try {
    const r = await quickin.candidatar(vagaQuickin(s.url), dadosBase, silencio);
    assert.equal(r.status, 'erro', 'esperava erro');
    assert.match(r.status === 'erro' ? r.motivo : '', /422|recusou/);
    console.log('✓ Quickin: Recusa HTTP 422 tratada como erro');
  } finally {
    s.servidor.close();
  }
}

// D) Ensaio
{
  const s = await subirQuickin('sucesso');
  try {
    const r = await quickin.candidatar(vagaQuickin(s.url), { ...dadosBase, ensaio: true }, silencio);
    assert.equal(r.status, 'ensaio', `esperava ensaio, veio ${r.status}`);
    assert.equal(s.posts, 0, 'em modo ensaio 0 POSTs');
    console.log('✓ Quickin: Modo ensaio preenche formulário e não envia (0 POST)');
  } finally {
    s.servidor.close();
  }
}

// ============================================================================
// 3. WORKABLE
// ============================================================================
console.log('\n--- Testando Adapter: Workable ---');

const paginaWorkable = (desfecho: 'sucesso' | 'redacao-nova' | 'recusa') => `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Workable Job Page</title>
<body>
<button data-ui="overview-apply-now" id="apply-btn">Apply now</button>

<div data-ui="dialog" data-role="dialog-container" id="modal" style="display: none;">
  <form id="workableForm">
    <input name="firstname" required>
    <input name="lastname" required>
    <input name="email" type="email" required>
    <input name="phone" required>
    <input name="address">
    <input name="city">
    <input type="file" required>
    <button type="submit" data-ui="application-form-submit">Submit application</button>
  </form>
</div>
<div id="feedback"></div>

<script>
document.getElementById('apply-btn').addEventListener('click', () => {
  document.getElementById('modal').style.display = 'block';
});

document.getElementById('workableForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/v1/jobs/w123/apply?lng=en', { method: 'POST', body: '{}' });
  const modal = document.getElementById('modal');
  const fb = document.getElementById('feedback');
  ${
    desfecho === 'sucesso'
      ? `modal.remove(); fb.textContent = 'Application submitted successfully! Thank you for applying.';`
      : desfecho === 'redacao-nova'
        ? `modal.remove(); fb.textContent = 'We have received your application.';`
        : `fb.textContent = 'Submission failed';`
  }
});
</script>
</body></html>`;

function subirWorkable(desfecho: 'sucesso' | 'redacao-nova' | 'recusa'): Promise<{ url: string; servidor: Server; posts: number }> {
  const estado = { posts: 0 };
  const servidor = createServer((req, res) => {
    if (req.url?.includes('/api/v1/jobs/w123/apply')) {
      estado.posts++;
      if (desfecho === 'recusa') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'You have already applied' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"applied"}');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(paginaWorkable(desfecho));
  });

  return new Promise(resolve => {
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/view/w123/full-stack-engineer`,
        servidor,
        get posts() {
          return estado.posts;
        },
      });
    });
  });
}

const vagaWorkable = (url: string): Vaga => ({
  id: 'workable:w123',
  plataforma: 'workable',
  tenant: 'workable',
  titulo: 'Full Stack Engineer',
  empresa: 'TechCorp',
  descricao: '',
  requisitos: '',
  regime: 'CLT',
  modelo: 'remoto',
  local: 'Remoto',
  url,
  skills: [],
  camposConhecidos: [],
  score: 82,
  status: 'em_andamento',
  encontradaEm: new Date().toISOString(),
  atualizadaEm: new Date().toISOString(),
});

// A) Caminho feliz
{
  const s = await subirWorkable('sucesso');
  try {
    const r = await workable.candidatar(vagaWorkable(s.url), dadosBase, silencio);
    assert.equal(r.status, 'enviada', `esperava enviada, veio ${r.status}`);
    assert.equal(s.posts, 1, 'esperava exatamente 1 envio');
    console.log('✓ Workable: Envio aceito e modal submetido com sucesso (1 POST)');
  } finally {
    s.servidor.close();
  }
}

// B) Prova de rede HTTP 200
{
  const s = await subirWorkable('redacao-nova');
  try {
    const r = await workable.candidatar(vagaWorkable(s.url), dadosBase, silencio);
    assert.equal(r.status, 'enviada', `esperava enviada, veio ${r.status}`);
    assert.equal(s.posts, 1, 'esperava exatamente 1 envio');
    console.log('✓ Workable: Prova de rede /api/v1/jobs/.../apply garante envio');
  } finally {
    s.servidor.close();
  }
}

// C) Recusa do servidor
{
  const s = await subirWorkable('recusa');
  try {
    const r = await workable.candidatar(vagaWorkable(s.url), dadosBase, silencio);
    assert.equal(r.status, 'erro', 'esperava erro');
    assert.match(r.status === 'erro' ? r.motivo : '', /400|recusou/);
    console.log('✓ Workable: Recusa HTTP 400 identificada');
  } finally {
    s.servidor.close();
  }
}

// D) Ensaio
{
  const s = await subirWorkable('sucesso');
  try {
    const r = await workable.candidatar(vagaWorkable(s.url), { ...dadosBase, ensaio: true }, silencio);
    assert.equal(r.status, 'ensaio', `esperava ensaio, veio ${r.status}`);
    assert.equal(s.posts, 0, 'em modo ensaio 0 POSTs');
    console.log('✓ Workable: Modo ensaio preenche modal sem disparar POST (0 POST)');
  } finally {
    s.servidor.close();
  }
}

// ============================================================================
// 4. ARBEITNOW
// ============================================================================
console.log('\n--- Testando Adapter: Arbeitnow ---');

const paginaArbeitnow = (_desfecho: 'sucesso' | 'ensaio', idioma: 'en' | 'de') => `<!doctype html>
<html lang="${idioma}"><meta charset="utf-8"><title>Arbeitnow Application</title>
<body>
<form id="jobForm" method="POST">
  <label for="name">${idioma === 'de' ? 'Vollständiger Name' : 'Full Name'}</label>
  <input id="name" name="name" required>

  <label for="email">E-Mail</label>
  <input id="email" name="email" type="email" required>

  <label for="phone">${idioma === 'de' ? 'Telefon' : 'Phone'}</label>
  <input id="phone" name="phone" required>

  <label for="resume">${idioma === 'de' ? 'Lebenslauf' : 'Resume / CV'}</label>
  <input id="resume" name="resume" type="file" required>

  <button type="button" id="submitBtn">${idioma === 'de' ? 'Bewerbung absenden' : 'Submit Application'}</button>
</form>
<div id="resultado"></div>
<script>
document.getElementById('submitBtn').addEventListener('click', () => {
  const form = document.getElementById('jobForm');
  const res = document.getElementById('resultado');
  form.remove();
  res.textContent = '${idioma === 'de' ? 'Vielen Dank für Ihre Bewerbung!' : 'Thank you for your application!'}';
});
</script>
</body></html>`;

function subirArbeitnow(desfecho: 'sucesso' | 'ensaio', idioma: 'en' | 'de'): Promise<{ url: string; servidor: Server }> {
  const servidor = createServer((req, res) => {
    // Simula redirecionamento /apply para formulário
    if (req.url?.endsWith('/apply')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(paginaArbeitnow(desfecho, idioma));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(paginaArbeitnow(desfecho, idioma));
  });

  return new Promise(resolve => {
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/jobs/tech/senior-backend-engineer`,
        servidor,
      });
    });
  });
}

const vagaArbeitnow = (url: string): Vaga => ({
  id: 'arbeitnow:senior-backend-engineer',
  plataforma: 'arbeitnow',
  tenant: 'arbeitnow',
  titulo: 'Senior Backend Engineer',
  empresa: 'EuroTech Berlin',
  descricao: '',
  requisitos: '',
  regime: 'CLT',
  modelo: 'remoto',
  local: 'Berlin, Germany',
  url,
  skills: [],
  camposConhecidos: [],
  score: 84,
  status: 'em_andamento',
  encontradaEm: new Date().toISOString(),
  atualizadaEm: new Date().toISOString(),
});

// A) Caminho feliz em inglês
{
  const s = await subirArbeitnow('sucesso', 'en');
  try {
    const r = await arbeitnow.candidatar(vagaArbeitnow(s.url), dadosBase, silencio);
    assert.equal(r.status, 'enviada', `esperava enviada, veio ${r.status}`);
    console.log('✓ Arbeitnow (EN): Motor adaptativo preenche e submete formulário → enviada');
  } finally {
    s.servidor.close();
  }
}

// B) Convenção em alemão (DE)
{
  const s = await subirArbeitnow('sucesso', 'de');
  try {
    const r = await arbeitnow.candidatar(vagaArbeitnow(s.url), dadosBase, silencio);
    assert.equal(r.status, 'enviada', `esperava enviada, veio ${r.status}`);
    console.log('✓ Arbeitnow (DE): Convenções multilíngues identificam campos e botão de envio em alemão');
  } finally {
    s.servidor.close();
  }
}

// C) Modo ensaio
{
  const s = await subirArbeitnow('ensaio', 'en');
  try {
    const r = await arbeitnow.candidatar(vagaArbeitnow(s.url), { ...dadosBase, ensaio: true }, silencio);
    assert.equal(r.status, 'ensaio', `esperava ensaio, veio ${r.status}`);
    console.log('✓ Arbeitnow: Modo ensaio conclui sem submeter');
  } finally {
    s.servidor.close();
  }
}

await fecharNavegador();
console.log('\nTodos os 4 adapters verificados com sucesso de ponta a ponta!\n');
