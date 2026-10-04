# Extrai a marca do mockup em papel (acv.jpg) e gera os arquivos da identidade.
#   python brand/gerar-logo.py    — só precisa rodar de novo se a arte original mudar.
from PIL import Image, ImageDraw
import numpy as np, os, shutil

os.chdir(r"C:/Users/diluc/OneDrive/Documentos/GitHub/AutoCV")
os.makedirs('public', exist_ok=True)
os.makedirs('brand', exist_ok=True)

im = Image.open('brand/acv.jpg').convert('RGB')
L = np.asarray(im.convert('L')).astype(float)

# Alpha por rampa de luminância: papel (>=225) some, marca (<=120) fica sólida, e a faixa entre os dois
# vira a borda antialiasada. O papel mais escuro medido foi 229, então 225 não encosta na textura.
alpha = np.clip((225.0 - L) / (225.0 - 120.0), 0.0, 1.0)
alpha[alpha < 0.03] = 0.0

TINTA = (31, 41, 55)  # marca escura sobre fundo claro
AZUL = (23, 37, 84)  # fundo do ícone (mesma família do topo da sidebar)


def recortar(a, pad=0.05):
    ys, xs = np.where(a > 0.12)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    p = int(round(max(x1 - x0, y1 - y0) * pad))
    return a[max(0, y0 - p) : y1 + p, max(0, x0 - p) : x1 + p]


def rgba(a, cor):
    h, w = a.shape
    img = np.zeros((h, w, 4), dtype=np.uint8)
    img[..., :3] = cor
    img[..., 3] = np.round(a * 255).astype(np.uint8)
    return Image.fromarray(img, 'RGBA')


# ─── 1) Marca completa (monograma + rastro), branca com alpha ──────────────────
# É usada como MÁSCARA no CSS: a cor sai de `currentColor`, então serve na sidebar escura e no painel claro.
cheia = recortar(alpha, 0.05)
rgba(cheia, (255, 255, 255)).save('public/logo.png', optimize=True)
print('marca completa: %dx%d (%.2f:1)' % (cheia.shape[1], cheia.shape[0], cheia.shape[1] / cheia.shape[0]))

# ─── 2) Ícone: só o monograma, branco sobre quadrado sólido ────────────────────
# Duas decisões, tomadas olhando a prova ampliada:
#  - o rastro do avião sai. A marca inteira é 1,7:1; espremida num quadrado de 16px ela vira um risco.
#  - fundo sólido em vez de transparente. A marca é fina e cinza: solta, some na aba escura do navegador
#    e quase não aparece na clara. O quadrado ancora a forma e fica igual nos dois temas.
# O corte não pode ser por densidade: o avião tem colunas tão cheias quanto partes do monograma.
# O desenho tem um vale de verdade entre os dois (o rastro fino), e é nele que se corta.
col = (alpha > 0.12).sum(axis=0)
pico = int(col.argmax())
direita = pico + int(np.argmin(col[pico : pico + 350]))  # vale logo depois do monograma
esquerda = int(np.where(col > col.max() * 0.25)[0].min())  # antes disso é só a cauda do rastro
print('corte do monograma: colunas %d..%d (pico em %d)' % (esquerda, direita, pico))
mono = recortar(alpha[:, esquerda:direita], 0.02)
print('monograma:      %dx%d (%.2f:1)' % (mono.shape[1], mono.shape[0], mono.shape[1] / mono.shape[0]))

CANTO = 0.18  # raio dos cantos, em fração do lado


def icone(n, ocupacao=0.74, fundo=AZUL, raio=CANTO):
    """Monograma branco centralizado num quadrado arredondado. Renderiza em 8x e reduz: bordas limpas."""
    g = 8
    lado = n * g
    tela = Image.new('RGBA', (lado, lado), (0, 0, 0, 0))
    mascara = Image.new('L', (lado, lado), 0)
    ImageDraw.Draw(mascara).rounded_rectangle([0, 0, lado - 1, lado - 1], radius=int(lado * raio), fill=255)
    tela.paste(Image.new('RGBA', (lado, lado), fundo + (255,)), (0, 0), mascara)
    alvo = int(lado * ocupacao)
    esc = min(alvo / mono.shape[1], alvo / mono.shape[0])
    m = rgba(mono, (255, 255, 255)).resize((max(1, int(mono.shape[1] * esc)), max(1, int(mono.shape[0] * esc))), Image.LANCZOS)
    tela.paste(m, ((lado - m.width) // 2, (lado - m.height) // 2), m)
    return tela.resize((n, n), Image.LANCZOS)


# A 16px o desenho não aguenta 74% de ocupação nem canto arredondado: engrossa e vira borrão.
# O 128 existe para o `icons` da extensão (diálogo de instalação e chrome://extensions). Deixar o
# Chrome reduzir o 192 para 128 amolece justamente o ajuste que esta tabela faz à mão.
tamanhos = {16: (0.86, 0.10), 32: (0.80, 0.14), 48: (0.76, 0.16), 128: (0.74, 0.18), 192: (0.74, 0.18), 512: (0.74, 0.18)}
for n, (oc, r) in tamanhos.items():
    icone(n, oc, raio=r).save(f'public/favicon-{n}.png', optimize=True)

# .ico multi-tamanho, cada um renderizado com os seus próprios ajustes
icone(48, 0.76, raio=0.16).save('public/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])

# apple-touch-icon: iOS ignora transparência e já arredonda sozinho — quadrado cheio, sem canto
icone(180, 0.72, raio=0.0).convert('RGB').save('public/apple-touch-icon.png', optimize=True)

# A extensão carregada descompactada só lê de dentro da própria pasta — `../public` não existe para
# ela. Por isso os arquivos são copiados; o que não se duplica é o GERADOR, que continua sendo este.
MARCA_EXT = 'extensao/ui/marca'
os.makedirs(MARCA_EXT, exist_ok=True)
DA_EXTENSAO = {16: tamanhos[16], 32: tamanhos[32], 48: tamanhos[48], 128: tamanhos[128]}
for n, (oc, r) in DA_EXTENSAO.items():
    icone(n, oc, raio=r).save(f'{MARCA_EXT}/icone-{n}.png', optimize=True)

# Variante apagada: é o que o ícone da barra mostra quando o núcleo está fechado. O desenho é o MESMO —
# muda só o fundo, de azul para cinza. A 16px a cor do quadrado é o que se lê de relance; mexer no traço
# nesse tamanho não se enxerga.
CINZA = (107, 116, 128)  # --color-ink-soft, o mesmo cinza de texto secundário do app
for n, (oc, r) in DA_EXTENSAO.items():
    icone(n, oc, fundo=CINZA, raio=r).save(f'{MARCA_EXT}/icone-off-{n}.png', optimize=True)

shutil.copyfile('public/logo.png', f'{MARCA_EXT}/logo.png')

for f in sorted(os.listdir('public')):
    print('  public/%-22s %6.1f KB' % (f, os.path.getsize('public/' + f) / 1024))
for f in sorted(os.listdir(MARCA_EXT)):
    print('  %s/%-14s %6.1f KB' % (MARCA_EXT, f, os.path.getsize(f'{MARCA_EXT}/' + f) / 1024))
