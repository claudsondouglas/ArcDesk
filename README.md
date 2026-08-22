# ArcDesk

Uma **área de trabalho virtual** para o GNOME Shell: uma grade de ícones sobre o papel de
parede, com apps, pastas virtuais e atalhos de diretório, arrastáveis para onde você quiser.

Faz parte da família **Arc** (ArcDock, ArcBar, ArcTab) e conversa diretamente com a ArcDock:
o menu de contexto de qualquer ícone da dock ganha um *"Adicionar à área de trabalho"*.

## O que ela faz

- **Grade livre.** Cada ícone tem uma posição sua, e ela é respeitada. Nada de reorganização
  automática: o que você arrumou continua arrumado, inclusive depois de desconectar um
  monitor e reconectar.
- **Uma grade independente por monitor.** Cada tela tem os slots dela, cada item lembra em
  qual monitor mora, e dá para arrastar um ícone de uma tela para a outra. Tem uma seção só
  sobre isso logo abaixo.
- **Pastas virtuais.** Solte um ícone no *centro* de outro e os dois viram uma pasta, com
  nome editável e um painel próprio ao abrir. Solte na *borda* e os dois trocam de lugar.
- **Clique simples seleciona, clique duplo abre**, ou clique simples abre direto, se você
  preferir. É uma opção nas preferências.
- **Menu de contexto** em cada ícone: abrir, ações do próprio app (nova janela, janela
  anônima, etc.), renomear e remover da área de trabalho.
- **Menu de contexto no fundo**, no lugar do que a superfície engoliu: trocar o papel de
  parede, configurações de exibição, adicionar widget, organizar ícones e abrir as
  preferências.
- **Widgets** de imagem e de calendário, encaixados nas células da grade.
- **Tema claro ou escuro** para a tinta dos rótulos e das pastas, escolhido conforme o papel
  de parede.
- **Some sozinha** no overview, na tela de bloqueio e, se você quiser, sob uma janela em
  tela cheia.

## Ela é VIRTUAL: não é a sua pasta `~/Desktop`

Isto é o mais importante de entender antes de instalar:

- A ArcDesk **não lê e não escreve nada** em `~/Área de trabalho` / `~/Desktop`.
- Ela **não mostra** os arquivos que já estão lá.
- Colocar um app na área de trabalho da ArcDesk **não cria** um arquivo `.desktop` em lugar
  nenhum.
- Tirar um ícone da área de trabalho **não apaga** absolutamente nada do disco.

O que existe é uma lista de itens guardada nas configurações da extensão (`dconf`), e é ela
que é desenhada. A vantagem é que a sua área de trabalho não vira uma pasta bagunçada; a
consequência é que ela é uma coisa à parte da sua pasta de verdade, e as duas não se
conversam.

## Uma grade independente por monitor

Cada tela ganha uma superfície própria, e cada superfície tem a grade dela, contada a partir
do canto de origem da área de trabalho daquele monitor. Não existe uma grade única espalhada
pelas telas.

- Um item guarda **coluna, linha e monitor** (o campo `mon` da chave `desk-placements`).
  Dois itens podem ocupar a mesma coluna e linha desde que estejam em monitores diferentes.
- **Arrastar entre telas é só arrastar.** Solte o ícone na superfície da outra tela e ele
  passa a morar lá; o monitor novo é gravado na hora. Não existe um comando de "mover para
  o outro monitor", e nem precisa existir.
- O monitor é identificado pelo **índice**, porque é o que o GNOME dá: o objeto de monitor
  não traz nome de conector e o `Meta.Display` não expõe nenhum.
- **Um índice que sumiu degrada, nunca destrói.** Desplugue a tela e os itens dela aparecem
  no monitor primário, no primeiro slot livre, mas o registro guardado fica exatamente como
  estava. Replugue e o arranjo volta inteiro. É de propósito: uma faxina de índices velhos
  achataria uma área de trabalho de duas telas na primeira vez que o notebook saísse da
  dock, e não haveria como desfazer.
- A aba **Items** das preferências mostra em que monitor cada item está guardado, e é só
  leitura: `Monitor 2`, ou `Primary monitor` para um registro gravado antes de este campo
  existir.
- O que a **ArcDock** acrescenta cai no primeiro slot livre do **monitor primário**. A
  ArcDock não sabe nada de monitores, e o valor da ponte é justamente ela não precisar
  saber.
- **Widgets também são por monitor**, e o *"Organizar ícones"* do menu do fundo compacta só
  os ícones daquela tela.
- Uma ressalva: o *"esconder em tela cheia"* olha só o monitor **primário**, e cala o
  conjunto inteiro quando encontra uma janela em tela cheia lá.

## Desative a Desktop Icons NG (DING)

Se a extensão **Desktop Icons NG** estiver ativa, as duas vão desenhar ícones sobre
exatamente os mesmos pixels, uma por cima da outra. Não é um conflito que trave nada, mas é
feio e confuso.

A ArcDesk avisa uma vez, por notificação, quando detecta a DING ligada. Para resolver:

```bash
gnome-extensions disable ding@rastersoft.com
```

Ou pelo aplicativo **Extensões**, desligando *Desktop Icons NG*.

> Se você **precisa** dos arquivos de `~/Desktop` visíveis, mantenha a DING e não use a
> ArcDesk: as duas resolvem o mesmo espaço de maneiras incompatíveis.

## Requisitos

- GNOME Shell **46 a 50**
- Wayland ou Xorg

## Instalação

### 1. Clone dentro da pasta de extensões

O nome da pasta **precisa** ser exatamente `ArcDesk@claudson`, que é o UUID declarado no
`metadata.json`:

```bash
git clone https://github.com/claudsondouglas/ArcDesk.git \
  ~/.local/share/gnome-shell/extensions/ArcDesk@claudson
```

### 2. Compile o schema

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/ArcDesk@claudson/schemas/
```

### 3. Recarregue a shell

- **Wayland:** encerre a sessão e entre de novo. Não existe recarga em tempo de execução.
- **Xorg:** `Alt+F2`, digite `r`, `Enter`.

### 4. Ative

```bash
gnome-extensions enable ArcDesk@claudson
```

Ou pelo aplicativo **Extensões**, procurando por *ArcDesk*.

### 5. Confira

Os ícones aparecem sobre o papel de parede. Se não aparecer nada, olhe o journal:

```bash
journalctl --user -f -o cat _COMM=gnome-shell | grep -i arcdesk
```

## Como usar

- **Adicionar um app:** clique com o botão direito no ícone dele na ArcDock e escolha
  *"Adicionar à área de trabalho"*. Ele cai no primeiro espaço livre do monitor primário.
  Não dá para arrastar um app de fora para dentro: a superfície só aceita arrastes que
  nasceram nela mesma ou em outra superfície da ArcDesk.
- **Mover:** arraste para qualquer célula vazia, na mesma tela ou em outra.
- **Criar uma pasta:** arraste um ícone para o **centro** de outro.
- **Trocar dois de lugar:** arraste um para a **borda** do outro.
- **Desfazer uma pasta:** tire os ícones de dentro. Quando sobra só um, ele volta a ser um
  ícone comum, no lugar onde a pasta estava.
- **Renomear:** botão direito → *"Renomear"*. Em app e em atalho de pasta muda só o rótulo
  da ArcDesk, nunca o aplicativo nem o diretório de verdade.
- **Remover:** botão direito → *"Remover da área de trabalho"*, ou pela aba **Items** das
  preferências.
- **Botão direito no fundo:** *"Alterar plano de fundo…"*, *"Configurações de exibição"*,
  *"Adicionar widget"*, *"Organizar ícones"* (compacta os ícones daquela tela nas primeiras
  casas, na ordem em que a aba Items os mostra) e *"Preferências do ArcDesk"*.

## Preferências

```bash
gnome-extensions prefs ArcDesk@claudson
```

São quatro abas.

**Appearance**

- *Icon size*: de 32 a 128 px, padrão 64. A célula cresce junto com o ícone, então ícone
  maior significa menos slots na tela.
- *Theme*: `Light` ou `Dark`. Os rótulos são brancos nos dois; o tema decide a densidade da
  tinta atrás deles e nas capas de pasta.
- *Labels*: `Below the icon` ou `Hidden`. Sem rótulo a célula encurta e cabem mais linhas.
- *Origin corner*: `Top left` ou `Top right`. As posições são guardadas como índices de
  coluna e linha contados a partir da origem, então trocar o canto espelha a área de
  trabalho inteira.
- *Bottom margin*: de 0 a 256 px livres abaixo da última linha, úteis para reservar espaço
  para a dock.
- *Show monitor boundaries*: borda de diagnóstico em cada superfície, com a geometria dela
  no journal.

**Behavior**

- *Double click to open* (ligado): clique simples seleciona, duplo abre. Desligado, o clique
  simples abre na hora e não existe passo de seleção.
- *Hide while a window is fullscreen* (ligado): para de pintar a área de trabalho sob uma
  janela em tela cheia. É economia de renderização, não visibilidade: a superfície já fica
  abaixo de todas as janelas, mas continuaria pintando debaixo delas.
- *Warn when Desktop Icons NG is enabled* (ligado): a notificação única sobre a DING. A
  própria ArcDesk desliga a chave depois de avisar, para não repetir a cada sessão.

**Items**: a lista do que está na área de trabalho, na ordem da chave `desk-items`, com o
monitor de cada item e um botão de remover. Daqui só dá para *tirar*; colocar é pela ArcDock
ou pela própria área de trabalho.

**Widgets**: adicionar e remover widgets de imagem.

As chaves por trás disso são `icon-size`, `desk-theme`, `label-position`, `grid-origin`,
`grid-bottom-margin`, `hide-in-fullscreen`, `double-click-to-open`, `debug-outline` e
`warn-about-ding`. Mexer em qualquer uma delas reconstrói as superfícies inteiras: é barato,
e evita propagar a mudança por métricas, slots e ícones vezes o número de monitores.

Os dados ficam em chaves separadas, que não são para editar à mão: `desk-items`,
`desk-placements`, `desk-folders`, `desk-item-names` e `desk-widgets`.

## Integração com a ArcDock

Com a **ArcDock** instalada e ativa, os menus de contexto dela ganham as ações *"Adicionar à
área de trabalho"* e *"Remover da área de trabalho"*, nos ícones de app da dock, nas pastas
fixadas e nos ícones da grade de aplicativos. Esses itens só aparecem quando a ArcDesk está
realmente ativa; se você desligar a ArcDesk, eles somem do menu sozinhos.

A ponte é a chave `desk-items`: a ArcDock só precisa acrescentar um id, e a ArcDesk cuida
sozinha de achar um lugar livre para o ícone novo.

## Widgets

Um widget ocupa **células inteiras** da grade, e não pixels soltos: mover e redimensionar
sempre encaixa de volta nos slots. A pegada dele é reservada como se fossem casas ocupadas,
então widget não fica em cima de ícone nem de outro widget: quem não couber é empurrado para
a primeira área livre.

São dois tipos, registrados em `src/widgetRegistry.js`:

| Tipo | Tamanho inicial | Redimensiona | Configurável |
|---|---|---|---|
| **Imagem** | 4 × 4 células | sim, até o mínimo de 80 × 80 px | sim: o arquivo da imagem |
| **Calendário** | 2 × 2 células | não | não |

**Imagem.** Adicione em *Preferências → Widgets → Choose image…*, e ela nasce no monitor
primário. (No menu do fundo, *"Adicionar widget → Imagem"* abre justamente essa aba, porque
uma imagem sem arquivo não teria o que mostrar.) A imagem usa preenchimento `cover`: ocupa
toda a área e corta o excedente. Uma **pressão longa** liga a borda de edição; com ela
ligada, arraste qualquer borda ou canto para redimensionar. O botão direito dá *"Mudar
imagem…"* e *"Remover widget"*.

**Calendário.** Botão direito no fundo → *"Adicionar widget"* → *"Calendário"*, e ele nasce
no monitor onde você clicou. Mostra o mês corrente com o dia de hoje marcado e os dias que
já passaram apagados, vira o mês sozinho, e um clique abre o Calendário do GNOME. Tamanho
fixo de 2 × 2 células e nenhuma configuração: o botão direito só oferece *"Remover widget"*.

Nos dois, arrastar move. Os metadados de cada tipo ficam em `widgets/<tipo>/manifest.json`;
as instâncias ficam na chave `desk-widgets`, cada uma com o tipo, o monitor, a geometria e a
configuração própria. Um tipo que esta versão não conhece é preservado na escrita, então uma
ArcDesk antiga não apaga o widget de uma nova.

## Licença

MIT, como a ArcDock. O texto está em [`LICENSE`](LICENSE).
