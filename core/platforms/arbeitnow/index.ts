// Adapter do Arbeitnow (arbeitnow.com).
// Vagas de tecnologia da Europa com API pública de busca e formulário
// processado pelo motor adaptativo multi-etapa (executarFormulario).
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type DadosCandidatura, type Log, type PlatformAdapter, type ResultadoCandidatura } from '../adapter.ts';
import { executarFormulario } from '../inhire/formulario.ts';
import { navegador } from '../../browser.ts';
import { DIRS } from '../../config.ts';
import { ler } from '../../estado.ts';
import { buscarNoArbeitnow } from './busca.ts';
import { ARBEITNOW } from './seletores.ts';

const MAX_PDF_BYTES = 10 * 1024 * 1024;

const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log): Promise<Vaga[]> => buscarNoArbeitnow(perfil, cfg, ler.localizacao(), log);

async function candidatar(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura> {
  const tamanho = statSync(dados.curriculoPdf).size;
  if (tamanho > MAX_PDF_BYTES) {
    return {
      status: 'erro',
      motivo: `o currículo tem ${(tamanho / 1024 / 1024).toFixed(1)} MB (máximo 10 MB); gere um PDF mais leve`,
    };
  }

  const ctx = await navegador(dados.mostrarNavegador);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  const captura = async (nome: string) => {
    const caminho = join(DIRS.gerados, `${nome}-${Date.now()}.png`);
    await page.screenshot({ path: caminho, fullPage: true }).catch(() => {});
    return caminho;
  };

  try {
    const urlApply = vaga.url.endsWith('/apply') ? vaga.url : `${vaga.url.replace(/\/$/, '')}/apply`;
    log('info', `Abrindo página de candidatura do Arbeitnow: ${urlApply}`);
    await page.goto(urlApply, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Aceita cookies caso apareça modal de consentimento
    const cookiesBtn = page.locator('button:has-text("Accept"), button:has-text("Agree"), button:has-text("Alle akzeptieren")').first();
    if (await cookiesBtn.isVisible().catch(() => false)) {
      await cookiesBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Executa formulário com o motor adaptativo
    const resultado = await executarFormulario(page, dados, log, {
      convencoes: ARBEITNOW.convencoes,
    });

    if (resultado.resultado.status === 'ensaio') {
      resultado.resultado.captura = await captura('arbeitnow-ensaio');
    } else if (resultado.resultado.status === 'erro') {
      resultado.resultado.captura = await captura('arbeitnow-erro');
    }

    return resultado.resultado;
  } catch (e) {
    return {
      status: 'erro',
      motivo: (e as Error).message.split('\n')[0],
      captura: await captura('arbeitnow-erro'),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export const arbeitnow: PlatformAdapter = {
  id: 'arbeitnow',
  nome: 'Arbeitnow',
  buscarVagas,
  candidatar,
};

registrarAdapter(arbeitnow);
