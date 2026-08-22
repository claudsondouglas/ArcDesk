# ArcDesk

Uma **área de trabalho virtual** para o GNOME Shell: uma grade de ícones sobre
o papel de parede, com apps, pastas virtuais e atalhos de diretório, arrastáveis
para onde você quiser.

Faz parte da família **Arc** (ArcDock, ArcBar, ArcTab) e conversa diretamente
com a ArcDock: o menu de contexto de qualquer ícone da dock ganha um
*"Adicionar à área de trabalho"*.

## O que ela faz

- **Grade livre.** Cada ícone tem uma posição sua, e ela é respeitada. Nada de
  reorganização automática: o que você arrumou continua arrumado, inclusive
  depois de desconectar um monitor e reconectar.
- **Pastas virtuais.** Solte um ícone no *centro* de outro e os dois viram uma
  pasta, com nome editável e um painel próprio ao abrir. Solte na *borda* e os
  dois trocam de lugar.
- **Clique simples seleciona, clique duplo abre** — ou clique simples abre
  direto, se você preferir. É uma opção nas preferências.
- **Menu de contexto** em cada ícone: abrir, ações do próprio app (nova janela,
  janela anônima, etc.), fixar/desafixar na ArcDock e remover da área de
  trabalho.
- **Tema claro ou escuro** para a tinta dos rótulos e das pastas, escolhido
  conforme o papel de parede.
- **Some sozinha** no overview, na tela de bloqueio e — se você quiser — sob
  uma janela em tela cheia.

## Ela é VIRTUAL — não é a sua pasta `~/Desktop`

Isto é o mais importante de entender antes de instalar:

- A ArcDesk **não lê e não escreve nada** em `~/Área de trabalho` / `~/Desktop`.
- Ela **não mostra** os arquivos que já estão lá.
- Colocar um app na área de trabalho da ArcDesk **não cria** um arquivo
  `.desktop` em lugar nenhum.
- Tirar um ícone da área de trabalho **não apaga** absolutamente nada do disco.

O que existe é uma lista de itens guardada nas configurações da extensão
(`dconf`), e é ela que é desenhada. A vantagem é que a sua área de trabalho não
vira uma pasta bagunçada; a consequência é que ela é uma coisa à parte da sua
pasta de verdade, e as duas não se conversam.

## Desative a Desktop Icons NG (DING)

Se a extensão **Desktop Icons NG** estiver ativa, as duas vão desenhar ícones
sobre exatamente os mesmos pixels, uma por cima da outra. Não é um conflito
que trave nada, mas é feio e confuso.

A ArcDesk avisa uma vez, por notificação, quando detecta a DING ligada. Para
resolver:

```bash
gnome-extensions disable ding@rastersoft.com
```

Ou pelo aplicativo **Extensões**, desligando *Desktop Icons NG*.

> Se você **precisa** dos arquivos de `~/Desktop` visíveis, mantenha a DING e
> não use a ArcDesk — as duas resolvem o mesmo espaço de maneiras incompatíveis.

## Requisitos

- GNOME Shell **46 a 50**
- Wayland ou Xorg

## Instalação

### 1. Clone dentro da pasta de extensões

O nome da pasta **precisa** ser exatamente `ArcDesk@claudson` — é o UUID
declarado no `metadata.json`:

```bash
git clone https://github.com/claudsondouglas/ArcDesk.git \
  ~/.local/share/gnome-shell/extensions/ArcDesk@claudson
```

### 2. Compile o schema

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/ArcDesk@claudson/schemas/
```

### 3. Recarregue a shell

- **Wayland:** encerre a sessão e entre de novo. Não existe recarga em tempo
  de execução.
- **Xorg:** `Alt+F2`, digite `r`, `Enter`.

### 4. Ative

```bash
gnome-extensions enable ArcDesk@claudson
```

Ou pelo aplicativo **Extensões**, procurando por *ArcDesk*.

### 5. Confira

Os ícones aparecem sobre o papel de parede. Se não aparecer nada, olhe o
journal:

```bash
journalctl --user -f -o cat _COMM=gnome-shell | grep -i arcdesk
```

## Como usar

- **Adicionar um app:** clique com o botão direito no ícone dele na ArcDock e
  escolha *"Adicionar à área de trabalho"*. Ele cai no primeiro espaço livre.
- **Mover:** arraste para qualquer célula vazia.
- **Criar uma pasta:** arraste um ícone para o **centro** de outro.
- **Trocar dois de lugar:** arraste um para a **borda** do outro.
- **Desfazer uma pasta:** tire os ícones de dentro. Quando sobra só um, ele
  volta a ser um ícone comum, no lugar onde a pasta estava.
- **Remover:** botão direito → *"Remover da área de trabalho"*, ou pela aba
  **Items** das preferências.

As preferências abrem com:

```bash
gnome-extensions prefs ArcDesk@claudson
```

E têm quatro abas: **Appearance** (tamanho do ícone, tema, rótulos, canto de
origem da grade), **Behavior** (clique duplo, esconder em tela cheia, aviso da
DING), **Items** (a lista do que está na área de trabalho) e **Widgets**.

## Integração com a ArcDock

Com a **ArcDock** instalada e ativa, os menus de contexto dela ganham as ações
*"Adicionar à área de trabalho"* e *"Remover da área de trabalho"* — nos ícones
de app da dock, nas pastas fixadas e nos ícones da grade de aplicativos. Esses
itens só aparecem quando a ArcDesk está realmente ativa; se você desligar a
ArcDesk, eles somem do menu sozinhos.

A ponte é a chave `desk-items`, que a ArcDock só precisa acrescentar um id — a
ArcDesk cuida sozinha de achar um lugar livre para o ícone novo.

## Widgets de imagem

Abra **Preferências do ArcDesk → Widgets → Choose image…** para colocar uma
imagem no monitor primário. Arraste a imagem para movê-la. Uma pressão longa
ativa a borda branca de edição; então arraste qualquer borda ou canto para
redimensionar. A prévia acompanha o ponteiro suavemente e encaixa no slot mais
próximo ao soltar. Ela nasce com **4 × 4 células**, movimento e tamanho
encaixam na grade, e a imagem usa preenchimento `cover`
(ocupa toda a área e corta o excedente). As instâncias ficam na key
`desk-widgets`; os metadados de cada tipo ficam em
`widgets/<tipo>/manifest.json`, e tipos executáveis são registrados
explicitamente em `src/widgetRegistry.js`.

## Licença

MIT, como a ArcDock.
