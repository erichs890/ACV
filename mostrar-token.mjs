// Espera o núcleo subir e mostra o token da extensão na janela do server.bat.
//
// Existe porque o token é pareado uma vez e, rodando só o servidor, não há tela onde lê-lo (ele mora em
// Plataformas › Extensão, que é do app em 5173). Em batch puro, ler um campo de JSON é sofrimento; aqui são
// cinco linhas e o Node já é pré-requisito do projeto.
//
// A rota é aberta de propósito e só atende 127.0.0.1 — é assim que a extensão se pareia com o núcleo.
const ALVO = 'http://127.0.0.1:4780/extensao/token';
const TENTATIVAS = 40;

for (let i = 0; i < TENTATIVAS; i++) {
  try {
    const r = await fetch(ALVO, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const { token } = await r.json();
      console.log(`\n  Token da extensão:  ${token}`);
      console.log('  Cole no popup da extensão (uma vez só).\n');
      process.exit(0);
    }
  } catch {
    // Ainda subindo: tenta de novo
  }
  await new Promise(r => setTimeout(r, 500));
}
console.log('\n  Não consegui ler o token (o servidor demorou a responder). Abra o ACV e veja em Plataformas › Extensão.\n');
