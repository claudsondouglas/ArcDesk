/**
 * Constantes de ajuste do ArcDesk. Só objetos congelados: este arquivo é
 * importado pelo shell E pelo prefs.js (processo separado), então não pode
 * ter estado, import de gi:// nem nada que dependa do compositor.
 */

export const SIZE = Object.freeze({
    // ICON/ICON_MIN/ICON_MAX espelham a key "icon-size" do gschema (default
    // 64, <range min="32" max="128">) — mudar um exige mudar o outro. O valor
    // que chega do GSettings é RECLAMPEADO em JS contra MIN/MAX: uma key
    // adulterada (dconf editado à mão, backup de outra versão) não pode pedir
    // um ícone de 10x e estourar a célula para fora da área de trabalho.
    ICON: 64,
    ICON_MIN: 32,
    ICON_MAX: 128,
    // A célula padrão fica quadrada: 64px de arte + 8px de distância até o
    // nome + 16px de uma linha + 2*12px de folga = 112px, a mesma largura de
    // 64px de arte + 2*24px. O Y é menor porque o rótulo já ocupa a parte
    // inferior da célula.
    CELL_PAD_X: 24,
    CELL_PAD_Y: 12,
    // Faixa do rótulo: GAP entre a arte e a primeira linha, altura de UMA
    // linha e quantas linhas cabem. A altura da célula soma
    // LABEL_GAP + LABEL_LINES*LABEL_LINE_HEIGHT, e não a altura medida do
    // St.Label: medir faria uma célula de nome curto ficar mais baixa que a
    // do vizinho e desalinharia a grade inteira.
    LABEL_GAP: 8,
    LABEL_LINE_HEIGHT: 16,
    LABEL_LINES: 1,
    // Largura a partir da qual o nome recebe ellipsis. Fixa, e não derivada
    // do ícone, pelo mesmo motivo: o que precisa ficar alinhado é a COLUNA.
    LABEL_MAX_WIDTH: 104,
    // Margem entre a borda da área de trabalho e a primeira/última célula.
    GRID_MARGIN_X: 12,
    GRID_MARGIN_Y: 12,
    // Espelha `grid-bottom-margin` no gschema. Valor lógico, multiplicado
    // pela escala do monitor antes de entrar no cálculo da grade.
    GRID_BOTTOM_MARGIN: 0,
    GRID_BOTTOM_MARGIN_MAX: 256,
    // Quanto a placa do slot (o realce de seleção/alvo) cresce para além da
    // célula em cada lado. É por isso que artRect() é medido da CÉLULA e
    // nunca da placa: mirar na placa faria o ícone voador pousar maior.
    SLOT_PAD: 8,
    // Valor legado, mantido para compatibilidade com código externo que
    // eventualmente importe SIZE. A margem usada hoje é configurável.
    DOCK_RESERVE: 96,
});

/**
 * Tipos de item que vivem em `desk-items`, como `type:value`.
 * PATH é uma pasta de verdade do sistema de arquivos, aberta no gerenciador
 * de arquivos; FOLDER é uma pasta VIRTUAL, que só existe em `desk-folders`.
 * Os dois nomes convivem porque as duas coisas convivem na mesma grade.
 */
export const ItemType = Object.freeze({
    APP: 'app',
    FOLDER: 'folder',
    PATH: 'path',
});

// Valores idênticos aos choices da key "desk-theme" no gschema — mudar um
// exige mudar o outro.
export const DeskTheme = Object.freeze({
    LIGHT: 'light',
    DARK: 'dark',
});

// Valores idênticos aos choices da key "label-position" no gschema — mudar
// um exige mudar o outro.
export const LabelPosition = Object.freeze({
    BELOW: 'below',
    HIDDEN: 'hidden',
});

// Valores idênticos aos choices da key "grid-origin" no gschema — mudar um
// exige mudar o outro. A origem só decide de que canto a coluna zero é
// contada; o que fica gravado em `desk-placements` são sempre índices de
// coluna/linha a partir dela, nunca pixels.
export const GridOrigin = Object.freeze({
    TOP_LEFT: 'top-left',
    TOP_RIGHT: 'top-right',
});

export const ANIM = Object.freeze({
    // Hover: só a ARTE cresce, nunca a célula. Escalar a célula mudaria a
    // alocação e empurraria a linha inteira a cada passada de mouse.
    HOVER_MS: 160,
    HOVER_ICON_SCALE: 1.12,
    // Seleção: mais curta que o hover porque é resposta a um clique, e um
    // clique já é a confirmação de que o usuário quis aquilo.
    SELECT_MS: 120,
    // Reacomodação de ícones quando a grade muda de tamanho (troca de
    // monitor, mudança de tamanho de ícone).
    REFLOW_MS: 170,
    // Voo do fantasma do drop até a célula de destino.
    FLY_MS: 200,
    // Voo para DENTRO de uma pasta: mais longo e terminando menor, porque a
    // arte precisa ler como "entrou ali" e não como "pousou em cima".
    FLY_FOLDER_MS: 240,
    FLY_FOLDER_SCALE: 0.42,
    // Folga do watchdog do voo. Uma transição REMOVIDA nunca dispara o
    // onComplete dela, e sem esta testemunha independente a represa do
    // rebuild ficaria fechada para sempre — "só funciona na primeira vez".
    FLY_WATCHDOG_SLACK_MS: 400,
    // Entrada de um ícone novo na grade.
    APPEAR_POP_MS: 260,
    // Acender/apagar a placa do slot.
    SLOT_MS: 120,
    // Fusão de dois ícones numa pasta: o alvo encolhe um pouco enquanto a
    // arte de origem cai dentro dele.
    MERGE_MS: 140,
    MERGE_ICON_SCALE: 0.72,
    POPUP_OPEN_MS: 200,
    POPUP_CLOSE_MS: 160,
    // Escala de onde o painel da pasta parte. Não é zero: partir de zero faz
    // o primeiro frame ser um ponto sem forma, e o zoom pelo canto perde a
    // leitura de "este painel saiu daquele ícone".
    POPUP_MIN_OPEN_SCALE: 0.25,
    // Fade da célula de origem ao começar/terminar um arrasto.
    DRAG_FADE_MS: 120,
});

export const TIMING = Object.freeze({
    // Tempo de pressão antes de o arrasto ser reconhecido — o mesmo knob que
    // vai em makeDraggable({timeoutThreshold}). Curto demais e um clique
    // trêmulo vira arrasto; longo demais e mover um ícone parece travado.
    DRAG_HOLD_MS: 200,
    // Quanto o ponteiro precisa PARAR sobre um ícone para que a fusão seja
    // oferecida. Sem a espera, atravessar a grade acenderia halo de fusão em
    // cada ícone do caminho.
    MERGE_DWELL_MS: 250,
    // Janela monotônica (MICROssegundos) em que um clique que chega DEPOIS
    // do drag-end é engolido. Do GNOME 49 em diante o clique é reconhecido
    // por um gesture que roda FORA da propagação de eventos do dnd e pode
    // chegar com _dragging já falso. Relógio monotônico e não timeout: ele
    // morre junto com o objeto e não é mais um recurso para cancelar.
    DRAG_CLICK_GUARD_US: 250000,
    // Usado só quando Clutter.Settings.double_click_time não pode ser lido
    // (o caminho de emergência de doubleClick.js).
    DOUBLE_CLICK_FALLBACK_MS: 400,
});

export const MERGE = Object.freeze({
    // Fatia de cada borda da célula que NÃO funde: soltar ali significa
    // trocar de lugar. É o que dá ao usuário como recusar uma pasta sem ter
    // que mirar no vão entre duas células.
    EDGE_RATIO: 0.28,
    // Quanto o halo de fusão cresce além da arte do ícone alvo.
    HALO_PAD: 8,
});

export const State = Object.freeze({
    IDLE: 'idle',
    DRAGGING: 'dragging',
    FLYING: 'flying',
});

/** Nome de uma pasta virtual recém-criada, antes de o usuário renomear. */
export const DEFAULT_FOLDER_NAME = 'Pasta';
