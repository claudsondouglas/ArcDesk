import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { notifyArcDockAppClick } from './arcdockBridge.js';
import { ANIM, DeskTheme, GridOrigin, ItemType, LabelPosition, SIZE } from './config.js';
import { DeskBackgroundMenu } from './deskBackgroundMenu.js';
import { DeskIcon } from './deskIcon.js';
import { DeskSlot, SlotPaint } from './deskSlot.js';
import { GhostFlight } from './ghostFlight.js';
import { RenameDialog } from './renameDialog.js';
import { SignalTracker } from './trackers.js';
import { WidgetHost } from './widgetHost.js';
import { availableWidgets } from './widgetRegistry.js';

/**
 * Marca posta no actor da superfície.
 *
 * Serve ao handler de 'child-added' do grupo de fundo: com uma superfície
 * POR MONITOR, cada uma delas entrando no grupo dispara o sinal para todas
 * as outras, e sem esta marca as N superfícies ficariam se reerguendo umas
 * por cima das outras a cada montagem.
 */
const SURFACE_MARK = '_arcDeskSurface';

// O widget OCUPA células inteiras, mas não pinta até as linhas externas da
// grade. Um recuo de 1/8 em cada lado deixa um widget 1×1 usando 75% da
// célula, com o mesmo tipo de respiro visual que existe em volta dos ícones.
const WIDGET_CELL_INSET_RATIO = 0.125;

/**
 * A superfície da área de trabalho de UM monitor: o actor, as métricas, a
 * grade de casas e o delegate de drop.
 *
 * Existe uma DeskSurface por monitor, todas construídas pelo DeskManager e
 * todas dividindo o MESMO `DeskLayout` — que chega injetado, nunca
 * construído aqui. Cada superfície desenha só as entradas cujo `mon` é o
 * índice dela, e toda escrita no modelo carrega esse índice.
 *
 * ---------------------------------------------------------------------
 * A CAMADA — é aqui que dá para errar de forma catastrófica.
 * ---------------------------------------------------------------------
 *
 * O actor é um `St.Widget` dentro de `Main.layoutManager._backgroundGroup`,
 * dimensionado por `Layout.MonitorConstraint({index: monitorIndex,
 * workArea: false})` — `index` e `primary` são MUTUAMENTE EXCLUSIVOS no
 * MonitorConstraint, definir um zera o outro. Três armadilhas, cada uma com
 * um sintoma diferente:
 *
 * 1. **Nunca filho direto de `global.window_group`.** O
 *    `sync_actor_stacking()` do mutter só rebaixa actors de JANELA e de
 *    FUNDO num restack e deixa todo o resto onde está — um St.Widget solto
 *    ali termina ACIMA de todas as janelas no primeiro restack, isto é,
 *    ícones de desktop pintados por cima do navegador.
 * 2. **Nunca ancorado em `bgManager.backgroundActor`.** Esse actor é
 *    DESTRUÍDO a cada troca de wallpaper (e a cada transição de slideshow),
 *    levando junto tudo que estiver pendurado nele. A âncora é o GRUPO, e
 *    a posição dentro dele é reafirmada com `set_child_above_sibling(…,
 *    null)` a cada `child-added` do grupo — e não só a cada
 *    `monitors-changed`. Todo papel de parede novo (inclusive cada
 *    transição automática de um wallpaper dinâmico) faz o
 *    BackgroundManager criar um actor de fundo e adicioná-lo ao grupo, o
 *    que o põe ACIMA de nós: sem o reerguimento a área de trabalho
 *    simplesmente desaparece por trás do papel de parede horas depois do
 *    login.
 * 3. **Construir DEPOIS do startup.** `global.window_group.set_clip(...)`
 *    está ativo durante a animação de entrada da sessão; montar a grade no
 *    meio disso mede uma área de trabalho que ainda vai mudar. Se
 *    `Main.layoutManager._startingUp`, tudo espera o 'startup-complete'.
 *
 * Esconder no overview e na tela de bloqueio é AUTOMÁTICO — o
 * `_backgroundGroup` é filho do `window_group`, cuja visibilidade o Shell
 * já dirige por `Main.sessionMode.hasWindows && !inOverview`. Não há uma
 * linha de código aqui para isso, e não deve haver.
 *
 * ---------------------------------------------------------------------
 * FOCO DE TECLADO.
 * ---------------------------------------------------------------------
 *
 * A seleção toma apenas foco normal para receber Escape/Enter/Menu. Nunca
 * usa `Main.pushModal`: um modal também captura o ponteiro e pode deixar
 * janelas e a outra tela sem clique. O foco é liberado no Escape, overview,
 * desmapeamento e destroy, e se transfere normalmente ao clicar fora.
 */
export class DeskSurface {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {DeskLayout} params.layout      o modelo COMPARTILHADO, do
     *   gerente. Nunca construir um aqui: uma segunda instância brigaria
     *   com a supressão de eco das escritas.
     * @param {number}  params.monitorIndex   qual monitor esta grade pinta
     * @param {number}  params.iconSize
     * @param {string}  params.theme          DeskTheme
     * @param {string}  params.labelPosition  LabelPosition
     * @param {string}  params.gridOrigin     GridOrigin
     * @param {boolean} params.doubleClickToOpen
     * @param {function} params.buildEntries  () => Entry[] — TODAS as
     *   entradas, de todos os monitores. Quem constrói é o gerente, porque
     *   `build()` precisa das grades de todos os monitores de uma vez.
     * @param {function} params.onOpenFolder  (folderEntry, anchorRect) => void
     * @param {function} params.onCloseFolder () => void
     * @param {function} params.onFolderDragMode (active) => void — desbota
     *   ou devolve o painel de pasta durante um arraste de dentro dele.
     * @param {function} params.onDropOnOther (sourceIcon, dragActor) =>
     *   boolean — avisa o gerente de que um item de OUTRA superfície caiu
     *   aqui; false significa recusado.
     * @param {function} params.onDragOverHere () => void — o ponteiro de
     *   um arraste de OUTRA superfície está sobre esta; o gerente faz a de
     *   origem voltar a acender só o buraco dela.
     * @param {function} params.onRefreshAll () => void — remontagem de
     *   todas as grades, para mutações que podem atravessar monitores.
     * @param {function} params.onMoveWidget (widgetId, monitorIndex,
     *   stageRect) => boolean — pede ao gerente que encaminhe um widget
     *   solto sobre outra tela para a superfície correspondente.
     * @param {boolean} params.debugOutline — borda de diagnóstico
     * @param {number} params.gridBottomMargin — margem lógica inferior
     * @param {function} params.onOpenPrefs   () => void
     */
    constructor(params = {}) {
        this._settings = params.settings ?? null;
        this._layout = params.layout ?? null;
        const monitorIndex = Math.round(params.monitorIndex ?? 0);
        this._monitorIndex =
            Number.isFinite(monitorIndex) && monitorIndex >= 0 ? monitorIndex : 0;
        // Reclampeado apesar de a extensão já clampear: uma key adulterada
        // não pode pedir um ícone de 10x e comer a tela inteira.
        this._iconSize = Math.max(
            SIZE.ICON_MIN,
            Math.min(SIZE.ICON_MAX, Math.round(params.iconSize ?? SIZE.ICON))
        );
        // Valor desconhecido cai no claro: o claro é sempre a base e o
        // escuro é ADITIVO (regra do common.css), então um tema não
        // reconhecido dá uma superfície com estilo, não uma sem.
        this._theme =
            params.theme === DeskTheme.DARK ? DeskTheme.DARK : DeskTheme.LIGHT;
        this._labelPosition =
            params.labelPosition === LabelPosition.HIDDEN
                ? LabelPosition.HIDDEN
                : LabelPosition.BELOW;
        this._gridOrigin =
            params.gridOrigin === GridOrigin.TOP_RIGHT
                ? GridOrigin.TOP_RIGHT
                : GridOrigin.TOP_LEFT;
        this._doubleClickToOpen = params.doubleClickToOpen !== false;
        this._debugOutline = params.debugOutline === true;
        const bottomMargin = Number.isFinite(params.gridBottomMargin)
            ? Math.round(params.gridBottomMargin)
            : SIZE.GRID_BOTTOM_MARGIN;
        this._gridBottomMargin = Math.max(
            0,
            Math.min(SIZE.GRID_BOTTOM_MARGIN_MAX, bottomMargin)
        );
        const fn = (value) => (typeof value === 'function' ? value : null);
        this._buildEntries = fn(params.buildEntries);
        this._onOpenFolder = fn(params.onOpenFolder);
        this._onCloseFolder = fn(params.onCloseFolder);
        this._onFolderDragMode = fn(params.onFolderDragMode);
        this._onDropOnOther = fn(params.onDropOnOther);
        this._onDragOverHere = fn(params.onDragOverHere);
        this._onRefreshAll = fn(params.onRefreshAll);
        this._onMoveWidget = fn(params.onMoveWidget);
        this._onOpenPrefs = fn(params.onOpenPrefs);
        this._widgetStore = params.widgetStore ?? null;
        this._primaryMonitor = params.primaryMonitor === true;

        this._signals = new SignalTracker();

        // TODAS as entradas do modelo, de todos os monitores. `_entries` é
        // o recorte deste monitor (o que se desenha); a lista completa
        // continua necessária porque uma pasta aberta pode estar na OUTRA
        // tela e um app arrastado para fora dela precisa ser reconhecido
        // aqui (ver _folderContaining).
        this._allEntries = [];
        this._entries = [];
        this._icons = new Map();
        this._slots = [];
        this._widgets = new Map();
        this._metrics = null;
        this._built = false;
        // Lido já no construtor, e não só no _build(): o gerente pergunta o
        // tamanho da grade (`gridSize`) para montar o modelo, e isso pode
        // acontecer antes de esta superfície ter sido montada.
        this._scaleFactor = this._readScaleFactor();

        this._selected = null;
        this._menuIcon = null;
        this._menuWidget = null;
        // Menu do fundo (botão direito no pixel vazio), criado só no
        // primeiro uso — ver DeskBackgroundMenu.
        this._bgMenu = null;
        this._renameDialog = null;

        // --- Estado do arraste em curso ---
        // Retrato do que o DROP precisa saber, tirado enquanto o ícone
        // ainda está vivo (ver _onIconDragBegin).
        this._drag = null;
        // A ÚNICA casa acesa por vez e a pintura com que ela está acesa. O
        // par anda junto porque a MESMA casa troca de pintura no meio do
        // gesto (a de origem nasce EMPTY e vira TARGET quando o ponteiro
        // volta para cima dela).
        this._paintedSlot = -1;
        this._paintedAs = SlotPaint.NONE;
        this._originSlot = -1;
        // Ícone escondido à mão enquanto o fantasma dele voa.
        this._flySource = null;
        // O painel de pasta é do GERENTE — ele é chrome, tem que ficar acima
        // das janelas, e aqui embaixo (dentro do _backgroundGroup) ficaria
        // atrás de todas. Mas é a superfície que conduz o gesto, e arrastar
        // um app para FORA de uma pasta exige tirar o painel da frente: é o
        // que o callback `onFolderDragMode` faz, sem que esta classe precise
        // segurar uma referência a um actor que não é dela.
        //
        // O arraste corrente mexeu no modelo? É o que decide, no fim do
        // gesto, entre devolver o painel (nada mudou, ele continua servindo)
        // e fechá-lo de vez (o app saiu da pasta e o painel mostra uma
        // lista que já não existe).
        this._dragChanged = false;
        // Ícone que a próxima remontagem deve fazer quicar: a pasta que
        // acabou de nascer ou de engolir um app.
        this._popId = null;
        this._refreshPending = false;
        this._refreshId = 0;

        // Voo do ícone da mão do usuário até a casa. Ele é quem conta os
        // fantasmas no ar e quem tem o relógio que garante que a represa
        // sempre abre; `onIdle` é o instante em que o último pousou.
        this._flight = new GhostFlight({
            onIdle: () => this._guard(() => this._flushRefresh(), 'flight idle')(),
        });

        // Política de dnd COMPARTILHADA por todos os ícones: um objeto só
        // para a superfície inteira. Ela não tem estado por ícone — quem é
        // a célula chega sempre como argumento — e uma remontagem cria
        // dezenas delas de uma vez.
        this._iconDnd = {
            canMerge: (source, target) =>
                this._dndGuard(() => this._canMerge(source, target), 'canMerge', false),
            merge: (source, target, dragActor) =>
                this._dndGuard(() => this._merge(source, target, dragActor), 'merge', false),
            swap: (source, target, dragActor) =>
                this._dndGuard(() => this._swap(source, target, dragActor), 'swap', false),
            onDragBegin: (icon) => this._guard(() => this._onIconDragBegin(icon), 'drag begin')(),
            onDragEnd: (icon) => this._guard(() => this._onIconDragEnd(icon), 'drag end')(),
            onMergeHover: (icon, hovering) =>
                this._guard(() => this._onMergeHover(icon, hovering), 'merge hover')(),
        };
        this._iconMenu = this._menuPolicy();

        this._buildActor();

        // A grade só é montada depois que a sessão terminou de subir: o
        // clip do window_group está vivo durante a animação de startup e a
        // área de trabalho medida ali ainda vai mudar.
        if (Main.layoutManager._startingUp) {
            log(`[ArcDesk] surface mon=${this._monitorIndex} created ` +
                '(grid deferred to startup-complete)');
            this._signals.connect(Main.layoutManager, 'startup-complete', () =>
                this._guard(() => this._build(), 'startup build')());
        } else {
            log(`[ArcDesk] surface mon=${this._monitorIndex} created`);
            this._build();
        }
    }

    // --- API pública ---

    get actor() {
        return this._actor;
    }

    get metrics() {
        return this._metrics;
    }

    /** O modelo COMPARTILHADO. Esta classe não é dona dele. */
    get layout() {
        return this._layout;
    }

    get monitorIndex() {
        return this._monitorIndex;
    }

    /**
     * O tamanho da grade deste monitor, para o `build()` do gerente.
     *
     * Calcula as métricas na hora quando ainda não há: o gerente precisa da
     * grade de TODOS os monitores para construir o modelo, e isso pode ser
     * perguntado antes de a sessão terminar de subir — quando esta
     * superfície ainda não montou nada. A conta é pura (lê a área de
     * trabalho e as constantes) e não toca em nenhum actor.
     */
    get gridSize() {
        const m = this._metrics ?? this._computeMetrics();
        return m ? { cols: m.cols, rows: m.rows } : null;
    }

    /**
     * Remonta a grade a partir do modelo.
     *
     * NUNCA chamada de dentro de um acceptDrop — ver _scheduleRefresh().
     */
    refresh() {
        if (!this._actor) return;
        if (!this._metrics) this._metrics = this._computeMetrics();
        if (!this._slots.length) this._buildSlots();

        // Não deveria acontecer: remontar com um gesto em curso destrói o
        // ícone de ORIGEM antes de o dnd processar o drop. O retrato de
        // _onIconDragBegin salva o drop, mas a condição em si é um bug — e
        // diagnosticá-la ao vivo custa um logout inteiro, então ela grita
        // no journal na hora. Uma vez por gesto: com o ícone de origem
        // morto o 'drag-end' dele não volta mais para cá.
        if (this._drag && !this._drag.gridCleared) {
            this._drag.gridCleared = true;
            console.warn('[ArcDesk] desk grid rebuilt mid-drag');
        }

        const selectedId = this._selected?.id ?? null;
        // Construção pelo gerente: `build()` precisa das grades de todos os
        // monitores juntas, senão os itens dos outros seriam tratados como
        // fora de alcance e cairiam no primário.
        this._allEntries = this._entriesFromModel();
        this._entries = this._ownEntries(this._allEntries);

        this._clearTargetSlot();
        // Soltos das casas ANTES de morrerem: uma casa que fique apontando
        // para um ícone destruído tentaria removê-lo de si mesma no próximo
        // setIcon(), e o actor já não tem pai nenhum.
        this._detachIcons();
        this._destroyIcons();
        for (const entry of this._entries) {
            if (!entry) continue;
            const slot = this.slotAt(entry.col, entry.row);
            // Sem casa: a grade encolheu abaixo do que o modelo clampeia
            // (um monitor minúsculo). A POSIÇÃO guardada não é tocada — ela
            // é autoritativa —, o item só não é desenhado nesta sessão.
            if (!slot) continue;
            const icon = this._createIcon(entry);
            if (!icon) continue;
            slot.setIcon(icon);
            this._icons.set(entry.id, icon);
        }

        if (selectedId) this._setSelected(this._icons.get(selectedId) ?? null);
        // Os fantasmas saem SÓ depois de a grade nova estar de pé: matá-los
        // no fim do voo deixaria um quadro sem ícone nenhum no lugar, e é
        // justamente essa emenda que faz o item parecer ter pousado na casa.
        this._flight?.clear();
        this._restoreFlySource();
        if (this._popId) {
            this._icons.get(this._popId)?.playAppearPop();
            this._popId = null;
        }
        // Uma linha por remontagem, e ela responde a pergunta que já custou
        // caro: "a superfície foi construída" e "a grade foi montada com
        // itens dentro" são estados diferentes, e sem isto o journal não
        // distingue os dois.
        log(`[ArcDesk] grid built mon=${this._monitorIndex} ` +
            `cols=${this._metrics.cols} rows=${this._metrics.rows} ` +
            `items=${this._icons.size}`);
    }

    /**
     * Agenda a remontagem respeitando a represa.
     *
     * É por aqui que o gerente pede uma remontagem — nunca por `refresh()`
     * direto. Uma superfície que ainda não montou nada é ignorada de
     * propósito: ela vai montar sozinha no 'startup-complete', e antecipar
     * isso mediria uma área de trabalho que ainda vai mudar.
     */
    scheduleRefresh() {
        if (!this._built) return;
        this._scheduleRefresh();
    }

    /**
     * "O modelo mudou por causa do arraste que está em curso."
     *
     * Chamado pelo gerente quando foi a superfície do OUTRO monitor que
     * gravou a mudança: só a superfície de origem conduz o fim do gesto, e
     * é este flag que faz o painel de pasta fechar de vez em vez de voltar.
     * Sem um arraste vivo aqui, é um no-op.
     */
    noteDragChanged() {
        if (this._drag) this._dragChanged = true;
    }

    /**
     * "O ponteiro está noutra tela": volta a acender só a casa de ORIGEM.
     *
     * Chamado pelo gerente na superfície de origem quando o arraste
     * atravessou para outro monitor. Sem arraste vivo aqui é um no-op, e
     * `_paintSlot` já ignora repetição — pode vir a cada movimento do
     * ponteiro sem custo.
     */
    showOriginHole() {
        if (!this._drag) return;
        this._paintSlot(this._originSlot, SlotPaint.EMPTY);
    }

    /**
     * Recalcula as métricas e repõe as casas, SEM recriar os ícones.
     *
     * Caminho de área de trabalho que mudou de tamanho (dock aparecendo,
     * painel escondendo, monitor trocado). Os ícones são reaproveitados
     * porque cada um carrega uma textura, e recriá-los a cada
     * 'workareas-changed' — que chega em rajada durante um redimensionamento
     * — seria refazer dezenas delas por segundo.
     *
     * Só duas mudanças obrigam a remontagem de verdade: a ARTE mudou de
     * tamanho (scale factor) ou o rótulo mudou de largura. Nos dois casos o
     * ícone existente está com a geometria errada por dentro e não há como
     * reaproveitá-lo.
     */
    relayout() {
        if (!this._actor || !this._built) return;
        const previous = this._metrics;
        this._metrics = this._computeMetrics();
        const next = this._metrics;
        if (!previous ||
            previous.artSize !== next.artSize ||
            previous.labelWidth !== next.labelWidth) {
            this.refresh();
            this.refreshWidgets();
            return;
        }
        this._buildSlots();
        if (!this._replaceIcons()) this.refresh();
        this.refreshWidgets();
    }

    /**
     * Liga e desliga a PINTURA desta grade (o caminho da tela cheia).
     *
     * Sempre com uma linha no journal: esconder a superfície é
     * indistinguível de "não desenhou nada" olhando para a tela, e essa
     * ambiguidade já custou uma sessão inteira de diagnóstico.
     */
    setVisible(visible) {
        if (!this._actor) return;
        const next = !!visible;
        if (this._actor.visible === next) return;
        log(`[ArcDesk] surface mon=${this._monitorIndex} ` +
            `${next ? 'shown' : 'hidden'}`);
        if (next) {
            this._actor.show();
            return;
        }
        // O grab cai JUNTO: uma superfície escondida segurando o teclado da
        // sessão é o grab órfão do parágrafo do topo, com a agravante de
        // não haver nada na tela para o usuário associar ao travamento.
        this._releaseFocus();
        this._closeBackgroundMenu();
        this._actor.hide();
    }

    iconById(id) {
        if (!id) return null;
        return this._icons.get(id) ?? null;
    }

    slotAt(col, row) {
        const m = this._metrics;
        if (!m) return null;
        if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return null;
        return this._slots[row * m.cols + col] ?? null;
    }

    /**
     * Constrói um ícone para uma célula DENTRO do painel de pasta.
     *
     * Existe para que essas células nasçam com as MESMAS políticas de dnd e
     * de menu das da grade. Um ícone criado sem elas é inerte: não arrasta,
     * e um app que entrou numa pasta nunca mais sairia dela.
     *
     * O painel é quem destrói o que este método devolve — ele criou a
     * célula, e `DeskIcon.destroy()` é o que devolve o cursor e solta o
     * monitor global de arraste.
     */
    createFolderIcon(item) {
        if (!item || !this._metrics) return null;
        return this._createIcon(item);
    }

    destroy() {
        // PRIMEIRA linha, antes de qualquer coisa que possa lançar: um grab
        // que sobrevive ao destroy deixa a sessão sem teclado e sem
        // ponteiro. Este é o caminho normal quando a extensão é desabilitada
        // com o usuário tendo acabado de clicar na área de trabalho.
        this._releaseFocus();
        const safe = (fn) => {
            try {
                fn();
            } catch (e) {
                logError(e, '[ArcDesk] surface destroy step failed');
            }
        };
        safe(() => this._signals.disconnectAll());
        safe(() => this._cancelRefresh());
        // O painel de pasta é chrome, filho do uiGroup: ninguém o esconderia
        // junto e ele ficaria de pé sobre a sessão com a área de trabalho já
        // destruída. (Quem o DESTRÓI é o gerente; daqui só se pede o fecho.)
        safe(() => this._onCloseFolder?.());
        safe(() => this._closeIconMenu());
        // O actor deste menu mora no uiGroup: ninguém o destrói junto com a
        // superfície, então é obrigatório fazê-lo à mão.
        safe(() => this._bgMenu?.destroy());
        this._bgMenu = null;
        safe(() => this._renameDialog?.destroy());
        this._renameDialog = null;
        safe(() => this._destroyWidgets());
        // Antes dos ícones: um fantasma no ar mora na camada do GhostFlight,
        // que é filha solta do uiGroup.
        safe(() => this._flight?.destroy());
        this._flight = null;
        // Os ícones morrem ANTES das casas e explicitamente: o destroy() do
        // DeskIcon devolve o cursor e solta o monitor global de arraste, e a
        // casa não sabe fazer nada disso (por isso ela nunca destrói o
        // próprio ícone).
        safe(() => this._destroyIcons());
        safe(() => this._destroySlots());
        // O modelo NÃO é destruído aqui: ele é do gerente e é compartilhado
        // com as outras superfícies. Só a referência é solta.
        this._layout = null;
        this._widgetStore = null;
        safe(() => {
            if (this._actor) {
                this._actor.remove_all_transitions();
                this._actor.destroy();
            }
        });
        this._actor = null;
        this._metrics = null;
        this._entries = [];
        this._allEntries = [];
        this._drag = null;
        this._selected = null;
        this._menuIcon = null;
        this._flySource = null;
        this._iconDnd = null;
        this._iconMenu = null;
        this._buildEntries = null;
        this._onOpenFolder = null;
        this._onCloseFolder = null;
        this._onFolderDragMode = null;
        this._onDropOnOther = null;
        this._onDragOverHere = null;
        this._onRefreshAll = null;
        this._onMoveWidget = null;
        this._onOpenPrefs = null;
        this._settings = null;
        this._built = false;
        // De novo, e de propósito: qualquer passo acima poderia, em teoria,
        // ter reentrado por um sinal e retomado o grab. Devolver duas vezes
        // não custa nada; deixar um de pé custa a sessão.
        this._releaseFocus();
    }

    // --- Construção da camada ---

    _buildActor() {
        this._actor = new St.Widget({
            style_class: 'arc-desk',
            // Reactive porque é ela que recebe o clique no fundo vazio (o
            // que limpa a seleção) e é ela que toma o foco. NÃO é uma
            // parede para nada: está embaixo de todas as janelas, e o
            // único actor abaixo dela é o wallpaper.
            reactive: true,
            can_focus: true,
            // LAYOUT FIXO, e NUNCA `layout_manager: null`.
            //
            // A intenção é a certa — as casas têm posição explícita,
            // calculada pelas métricas, e um BoxLayout aqui reintroduziria
            // exatamente a reorganização automática que uma grade LIVRE
            // existe para não ter. Mas `null` não expressa isso: expressa
            // "não aloque nada".
            //
            // `ClutterActor:layout-manager` não é CONSTRUCT, então o GJS a
            // aplica DEPOIS da construção, sobre o ClutterFixedLayout padrão
            // que o `clutter_actor_constructor` já criou —
            // `clutter_actor_set_layout_manager(actor, NULL)` desreferencia
            // esse padrão e guarda NULL, e nada o recria (o getter não tem
            // default preguiçoso). O `st_widget_allocate` então chega em
            // `clutter_layout_manager_allocate` com NULL e cai no
            // `g_return_if_fail(CLUTTER_IS_LAYOUT_MANAGER(manager))`: a
            // superfície é alocada, e NENHUM filho dela jamais recebe
            // alocação. O sintoma é um retângulo do tamanho certo,
            // transparente e completamente vazio, com o journal repetindo
            // "needs an allocation" para cada casa e cada ícone — sem
            // prefixo [ArcDesk] nenhum, o que esconde a causa de um grep.
            layout_manager: new Clutter.FixedLayout(),
        });
        this._actor[SURFACE_MARK] = true;
        if (this._theme === DeskTheme.DARK)
            this._actor.add_style_class_name('arc-desk-dark');
        if (this._debugOutline)
            this._actor.add_style_class_name('arc-desk-debug-outline');
        // `index` (e não `primary`): uma superfície por monitor. As duas
        // propriedades são MUTUAMENTE EXCLUSIVAS no MonitorConstraint —
        // definir `index` zera `primary` e vice-versa.
        //
        // O ACTOR cobre o monitor inteiro, inclusive atrás do painel. A
        // grade continua limitada à área útil em _computeMetrics(); separar
        // as duas geometrias permite diagnosticar a tela inteira sem pôr
        // ícones sob o painel.
        this._actor.add_constraint(
            new Layout.MonitorConstraint({
                index: this._monitorIndex,
                workArea: false,
            })
        );

        const group = Main.layoutManager._backgroundGroup;
        group.add_child(this._actor);
        // Acima dos actors de wallpaper, e reafirmado a cada filho novo do
        // grupo: TODA troca de papel de parede (inclusive cada transição
        // automática de um wallpaper dinâmico) faz o BackgroundManager
        // adicionar um actor de fundo aqui dentro, e um filho novo nasce
        // por cima de nós. Sem isto a área de trabalho some atrás do papel
        // de parede horas depois do login, sem nada no journal.
        this._raise();
        this._signals.connect(group, 'child-added', (_group, child) => {
            // As outras superfícies não contam: são N irmãs entrando no
            // mesmo grupo, e reerguer a nossa a cada uma delas seria N²
            // reordenações no login — e um sobe-desce entre irmãs que não
            // se sobrepõem, já que cada uma vive no seu monitor.
            if (child?.[SURFACE_MARK]) return;
            this._guard(() => this._raise(), 'raise on child-added')();
        });

        this._signals.connect(this._actor, 'button-press-event', (actor, event) =>
            this._guard(() => this._onButtonPress(actor, event), 'button press')() ??
            Clutter.EVENT_PROPAGATE);
        this._signals.connect(this._actor, 'key-press-event', (actor, event) =>
            this._guard(() => this._onKeyPress(event), 'key press')() ??
            Clutter.EVENT_PROPAGATE);
        // Rede para o caminho que NÃO emite 'showing' nenhum: a tela de
        // bloqueio e a troca de session mode escondem o window_group
        // inteiro, e a superfície desmapeia junto. Sem isto, um grab tomado
        // um instante antes ficaria de pé por cima do lock screen.
        this._signals.connect(this._actor, 'notify::mapped', () => {
            if (!this._actor?.mapped) this._releaseFocus();
        });

        // O delegate de reordenação mora na SUPERFÍCIE, do jeito que o
        // launcher do ArcDock o põe na página: o dnd acha o alvo subindo a
        // árvore de actors a partir do pixel sob o ponteiro, então uma casa
        // vazia — ou o vão entre duas — chega aqui de graça. As casas
        // não-reactive não atrapalham: o pick do dnd é PickMode.ALL.
        this._actor._delegate = {
            handleDragOver: (source, actor, x, y) =>
                this._dndGuard(
                    () => this._handleDragOver(source, x, y),
                    'handleDragOver',
                    DND.DragMotionResult.NO_DROP
                ),
            acceptDrop: (source, actor, x, y) =>
                this._dndGuard(
                    () => this._acceptDrop(source, actor, x, y),
                    'acceptDrop',
                    false
                ),
        };
    }

    _raise() {
        try {
            this._actor?.get_parent()?.set_child_above_sibling(this._actor, null);
        } catch (e) {
            logError(e, '[ArcDesk] raising the surface failed');
        }
    }

    /** Tudo que depende da sessão já estar de pé. */
    _build() {
        if (!this._actor || this._built) return;
        this._built = true;
        this._scaleFactor = this._readScaleFactor();
        this._metrics = this._computeMetrics();
        this._buildSlots();
        this.refresh();
        this.refreshWidgets();

        // Área de trabalho muda de forma: monitor entrando/saindo, painel
        // ou dock mudando de tamanho, resolução trocada.
        //
        // Quem RECONSTRÓI o conjunto de superfícies no monitors-changed é o
        // gerente (a contagem de monitores pode mudar, e aí não basta um
        // relayout). Daqui só saem as duas coisas que são desta superfície
        // e que precisam acontecer mesmo que o gerente aja depois: devolver
        // o grab, cuja geometria virou pó, e reafirmar a posição no grupo
        // de fundo.
        this._signals.connect(Main.layoutManager, 'monitors-changed', () =>
            this._guard(() => {
                this._releaseFocus();
                this._raise();
            }, 'monitors-changed')());
        this._signals.connect(global.display, 'workareas-changed', () =>
            this._guard(() => this.relayout(), 'workareas-changed')());
        this._signals.connect(
            St.ThemeContext.get_for_stage(global.stage),
            'notify::scale-factor',
            () =>
                this._guard(() => {
                    this._scaleFactor = this._readScaleFactor();
                    // relayout() já detecta que a ARTE mudou de tamanho e
                    // cai numa remontagem de verdade — as texturas dos
                    // ícones precisam nascer na densidade nova.
                    this.relayout();
                }, 'scale-factor')()
        );
        // `installed-changed` NÃO é escutado aqui: a lista de apps é do
        // gerente (é ele quem chama `build()`), e uma assinatura por
        // superfície daria N varreduras do AppSystem por evento. O mesmo
        // vale para o `onExternalChange()` do modelo — N assinaturas
        // dariam N remontagens por mudança — e para a tela cheia, que agora
        // é decidida monitor a monitor lá.

        // Overview subindo: o painel de pasta é chrome e ficaria de pé por
        // cima dele, e o grab tem que voltar antes de o usuário começar a
        // navegar. NADA aqui esconde a superfície — isso é automático.
        this._signals.connect(Main.overview, 'showing', () =>
            this._guard(() => {
                this._onCloseFolder?.();
                this._closeIconMenu();
                this._closeWidgetMenu();
                this._closeBackgroundMenu();
                this._releaseFocus();
            }, 'overview showing')());
    }

    // --- Métricas ---

    _readScaleFactor() {
        try {
            const monitor = Main.layoutManager.monitors?.[this._monitorIndex];
            const monitorScale = monitor?.geometry_scale;
            if (Number.isFinite(monitorScale) && monitorScale > 0)
                return monitorScale;
            const scale = St.ThemeContext.get_for_stage(global.stage)?.scale_factor;
            if (Number.isFinite(scale) && scale > 0) return scale;
        } catch (e) {
            logError(e, '[ArcDesk] scale factor read failed');
        }
        return 1;
    }

    /**
     * Geometria da grade.
     *
     * DUAS unidades convivem aqui, e confundi-las é o bug clássico de
     * HiDPI:
     *
     * - `iconSize` é LÓGICO. É o que vai para o `St.Icon`, que multiplica
     *   pelo scale factor por dentro na hora de carregar a textura. Passar
     *   um valor já multiplicado daria um ícone do DOBRO do tamanho pedido
     *   numa tela 2x.
     * - Todo o resto (`cellWidth`, `cellHeight`, `artSize`, `labelWidth`,
     *   margens) é FÍSICO. Tamanho fixado em JS via `set_width`/
     *   `set_position` é coordenada de stage, e o Clutter não aplica scale
     *   factor nenhum nele — quem multiplica é o CSS do St, e nada disto
     *   passa por CSS.
     *
     * A última coluna/linha existe sempre que a ARTE do ícone cabe. Exigir
     * que a célula inteira caiba desperdiça quase um passo da grade à
     * direita e embaixo, embora o padding invisível possa ultrapassar sem
     * problema. Não há reserva global para a dock: ela ocupa só o centro,
     * e reservar sua altura na largura toda impediria usar os cantos.
     */
    _computeMetrics() {
        const scale = this._scaleFactor;
        const px = (n) => Math.round(n * scale);
        const area = this._workArea();
        const monitor =
            Main.layoutManager.monitors?.[this._monitorIndex] ??
            Main.layoutManager.primaryMonitor ?? area;
        // O actor começa no monitor inteiro, mas a grade começa na work
        // area. Converter stage -> local é indispensável quando o painel
        // cria um recuo no topo ou quando o monitor não nasce em 0,0.
        const workOffsetX = area.x - monitor.x;
        const workOffsetY = area.y - monitor.y;

        const iconSize = this._iconSize;
        const artSize = px(iconSize);
        // A faixa do rótulo some inteira com os rótulos escondidos: manter a
        // reserva daria uma grade de células altas e vazias.
        const labelBand =
            this._labelPosition === LabelPosition.HIDDEN
                ? 0
                : px(SIZE.LABEL_GAP + SIZE.LABEL_LINES * SIZE.LABEL_LINE_HEIGHT);
        const cellWidth = artSize + 2 * px(SIZE.CELL_PAD_X);
        const cellHeight = artSize + labelBand + 2 * px(SIZE.CELL_PAD_Y);
        const marginX = px(SIZE.GRID_MARGIN_X);
        const marginY = px(SIZE.GRID_MARGIN_Y);
        const bottomMargin = px(this._gridBottomMargin);
        // Conta pela arte visível, não pela caixa completa. O primeiro ícone
        // começa depois do margin + padding; cada seguinte avança um pitch
        // de célula. O +1 inclui a primeira posição.
        const cols = Math.max(
            1,
            1 + Math.floor(
                (area.width - marginX - px(SIZE.CELL_PAD_X) - artSize) /
                cellWidth
            )
        );
        const rows = Math.max(
            1,
            1 + Math.floor(
                (area.height - marginY - bottomMargin -
                    px(SIZE.CELL_PAD_Y) - artSize) /
                cellHeight
            )
        );

        const metrics = {
            cols,
            rows,
            cellWidth,
            cellHeight,
            // Lógico, para o DeskIcon; físico, para todo o resto.
            iconSize,
            artSize,
            // Onde a ARTE começa dentro da célula.
            artTop: px(SIZE.CELL_PAD_Y),
            // Canto superior ESQUERDO do bloco da grade, nas coordenadas
            // locais da superfície. Com a origem à direita o bloco encosta
            // na borda direita; qual coluna fica onde dentro dele é assunto
            // de _cellPosition().
            originX:
                this._gridOrigin === GridOrigin.TOP_RIGHT
                    ? workOffsetX + area.width - marginX -
                        (cols - 1) * cellWidth -
                        px(SIZE.CELL_PAD_X) - artSize
                    : workOffsetX + marginX,
            originY: workOffsetY + marginY,
            // Rótulo nunca mais largo que a célula: um rótulo no tamanho
            // cheio vazaria por cima da célula vizinha.
            labelWidth: Math.max(
                artSize,
                Math.min(px(SIZE.LABEL_MAX_WIDTH), cellWidth - px(SIZE.CELL_PAD_X))
            ),
            // Retângulo útil em coordenadas de STAGE, para o painel de
            // pasta: ele não sabe nada da nossa geometria e precisa saber
            // onde pode caber.
            bounds: {
                x: area.x,
                y: area.y,
                width: area.width,
                height: area.height,
            },
            // Limites locais da área útil. A grade de ícones deixa o padding
            // invisível da última célula ultrapassar a borda; widgets pintam
            // a caixa toda e, por isso, precisam respeitar estes limites.
            workLeft: workOffsetX,
            workRight: workOffsetX + area.width,
            workTop: workOffsetY,
            workBottom: workOffsetY + area.height,
            marginX,
            marginY,
            bottomMargin,
        };
        if (this._debugOutline) {
            console.warn(
                `[ArcDesk] monitor ${this._monitorIndex}: ` +
                `geometry=${monitor?.width ?? '?'}x${monitor?.height ?? '?'}+` +
                `${monitor?.x ?? '?'},${monitor?.y ?? '?'} ` +
                `workarea=${area.width}x${area.height}+${area.x},${area.y} ` +
                `scale=${scale} cell=${cellWidth}x${cellHeight} ` +
                `bottom-margin=${bottomMargin} grid=${cols}x${rows}`
            );
        }
        return metrics;
    }

    /**
     * A área de trabalho DO NOSSO monitor, lida do LayoutManager e não da
     * alocação do actor.
     *
     * O actor cobre o monitor inteiro; esta área menor serve apenas para
     * posicionar a grade longe dos struts do painel.
     *
     * O índice pode ter deixado de existir entre o construtor e esta
     * leitura (monitor desplugado antes de o gerente reconstruir o
     * conjunto): a queda é para o monitor primário, e daí para o stage
     * inteiro. Uma área de tamanho zero daria uma grade de zero casas, que
     * recusa todo drop sem explicação.
     */
    _workArea() {
        const monitors = Main.layoutManager.monitors ?? [];
        const index =
            this._monitorIndex < monitors.length
                ? this._monitorIndex
                : Main.layoutManager.primaryIndex;
        const area =
            index >= 0 ? Main.layoutManager.getWorkAreaForMonitor(index) : null;
        if (area && Number.isFinite(area.width) && area.width > 0)
            return area;
        const monitor = monitors[index] ?? Main.layoutManager.primaryMonitor;
        if (monitor) return monitor;
        return { x: 0, y: 0, width: global.stage.width, height: global.stage.height };
    }

    // --- Entradas do modelo ---

    /**
     * TODAS as entradas, de todos os monitores.
     *
     * Vem do gerente porque `build()` precisa das grades de todos os
     * monitores de uma vez. A queda — construir só com a nossa grade — é
     * para o caso de uma superfície sem gerente: desenha esta tela e nada
     * mais, em vez de não desenhar nada.
     */
    _entriesFromModel() {
        if (this._buildEntries) return this._buildEntries() ?? [];
        // Sem gerente não há o que construir: `build()` exige as grades de
        // TODOS os monitores e esta classe só conhece a sua. Não é uma
        // configuração suportada, e o aviso existe para que ela apareça no
        // journal em vez de virar um silencioso "não desenha nada".
        console.warn('[ArcDesk] surface has no buildEntries callback');
        return [];
    }

    /**
     * O recorte deste monitor: é só isto que a grade desenha.
     *
     * Uma entrada sem `mon` inteiro é tratada como sendo do PRIMÁRIO — é a
     * mesma regra do modelo para um registro escrito pela v1, e mantém a
     * grade desenhando (no primário, como antes) caso o modelo em uso ainda
     * não conheça monitores.
     */
    _ownEntries(entries) {
        const primary = Main.layoutManager.primaryIndex;
        return (entries ?? []).filter((entry) => {
            if (!entry) return false;
            const mon = Number.isInteger(entry.mon) ? entry.mon : primary;
            return mon === this._monitorIndex;
        });
    }

    // --- Casas ---

    _cellPosition(col, row) {
        const m = this._metrics;
        // Com a origem no canto superior DIREITO a coluna 0 é a mais à
        // direita: só o desenho espelha, os índices guardados continuam
        // contados a partir da origem (é o que a persistência promete).
        const index =
            this._gridOrigin === GridOrigin.TOP_RIGHT ? m.cols - 1 - col : col;
        return {
            x: m.originX + index * m.cellWidth,
            y: m.originY + row * m.cellHeight,
        };
    }

    /**
     * Qual CASA está sob um ponto local da superfície, ou null se o ponto
     * está FORA da grade.
     *
     * Piso e não arredondamento: o que se procura não é a fronteira entre
     * duas células, é a célula inteira — o alvo do arraste é a casa, e ela
     * ocupa a largura toda da coluna.
     *
     * `null` é uma resposta de verdade e significa RECUSA. Numa grade livre
     * não existe "a casa mais próxima": as margens, a faixa reservada para
     * a dock e o resto da tela não são posições, e clampear para dentro
     * faria o item pular para um canto que o usuário não mirou.
     */
    _cellAt(x, y) {
        const m = this._metrics;
        if (!m) return null;
        const localX = x - m.originX;
        const localY = y - m.originY;
        if (localX < 0 || localY < 0) return null;
        let col = Math.floor(localX / m.cellWidth);
        const row = Math.floor(localY / m.cellHeight);
        if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) return null;
        if (this._gridOrigin === GridOrigin.TOP_RIGHT) col = m.cols - 1 - col;
        return { col, row };
    }

    _slotIndex(col, row) {
        const m = this._metrics;
        if (!m) return -1;
        if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return -1;
        return row * m.cols + col;
    }

    _slotIndexOfIcon(icon) {
        if (!icon) return -1;
        for (let index = 0; index < this._slots.length; index++) {
            if (this._slots[index]?.icon === icon) return index;
        }
        return -1;
    }

    _buildSlots() {
        // Os ícones são SOLTOS das casas antes, nunca destruídos com elas:
        // destruir uma casa leva os filhos junto, e num relayout os ícones
        // são justamente o que se está reaproveitando.
        this._detachIcons();
        this._destroySlots();
        const m = this._metrics;
        if (!m || !this._actor) return;
        const dark = this._theme === DeskTheme.DARK;
        for (let row = 0; row < m.rows; row++) {
            for (let col = 0; col < m.cols; col++) {
                const slot = new DeskSlot({
                    col,
                    row,
                    cellWidth: m.cellWidth,
                    cellHeight: m.cellHeight,
                    iconSize: m.artSize,
                    artTop: m.artTop,
                    dark,
                });
                const { x, y } = this._cellPosition(col, row);
                slot.set_position(x, y);
                this._actor.add_child(slot);
                this._slots[row * m.cols + col] = slot;
            }
        }
        this._paintedSlot = -1;
        this._paintedAs = SlotPaint.NONE;
        this._raiseWidgets();
    }

    /** Reconcilia somente os widgets deste monitor, sem remontar a grade. */
    refreshWidgets() {
        if (!this._actor || !this._built || !this._widgetStore) return;
        const ownRecords = this._widgetStore.list().filter((record) =>
            record.monitor === this._monitorIndex ||
            (record.monitor === null && this._primaryMonitor));
        const records = this._resolveWidgetCollisions(ownRecords);
        const seen = new Set();
        for (const record of records) {
            seen.add(record.id);
            const displayRecord = this._widgetDisplayRecord(record);
            const existing = this._widgets.get(record.id);
            if (existing) {
                existing.update(displayRecord, this._scaleFactor);
                continue;
            }
            try {
                const host = new WidgetHost({
                    record: displayRecord,
                    scale: this._scaleFactor,
                    onGeometry: (geometry) => {
                        if (geometry.mode === 'move') {
                            const destination = this._monitorAtStagePoint(
                                geometry.releasePoint?.x,
                                geometry.releasePoint?.y
                            );
                            if (destination !== null &&
                                destination !== this._monitorIndex) {
                                if (!this._onMoveWidget?.(
                                    record.id,
                                    destination,
                                    geometry.stageRect
                                )) {
                                    // A tela de destino recusou a pegada;
                                    // devolve o actor ao bloco persistido.
                                    this.refreshWidgets();
                                }
                                return;
                            }
                        }
                        const placement = this._widgetGridPlacement(geometry);
                        if (this._widgetPlacementCollides(placement, record.id)) {
                            // O host foi movido apenas visualmente durante o
                            // gesto. Reconstruir a geometria devolve-o ao
                            // último bloco válido sem tocar na persistência.
                            this.refreshWidgets();
                            return;
                        }
                        this._widgetStore?.updateGeometry(record.id, {
                            ...placement,
                            monitor: this._monitorIndex,
                        });
                        this.refreshWidgets();
                    },
                    onRemove: () => {
                        if (!this._widgetStore?.remove(record.id)) return;
                        // O item do menu ainda esta emitindo `activate`.
                        // Destruir o host (e o proprio menu) dentro dessa
                        // emissao interromperia o fechamento/modal do Shell.
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            if (this._actor) this.refreshWidgets();
                            return GLib.SOURCE_REMOVE;
                        });
                    },
                    onChangeImage: () => this._chooseWidgetImage(record.id),
                    beforeOpenMenu: (widget) => this._beforeWidgetMenu(widget),
                    onMenuStateChanged: (widget, isOpen) => {
                        if (isOpen) this._menuWidget = widget;
                        else if (this._menuWidget === widget) this._menuWidget = null;
                    },
                });
                this._widgets.set(record.id, host);
                this._actor.add_child(host.actor);
            } catch (e) {
                logError(e, `[ArcDesk] widget ${record.id} creation failed`);
            }
        }
        for (const [id, host] of this._widgets) {
            if (seen.has(id)) continue;
            try { host.destroy(); } catch (_) {}
            this._widgets.delete(id);
        }
        this._raiseWidgets();
    }

    /**
     * Reserva toda a pegada dos widgets junto com as casas que já contêm
     * ícones/pastas. Registros antigos que se sobrepõem são levados ao
     * primeiro bloco livre; se a grade estiver cheia, ficam persistidos mas
     * não são desenhados por cima de outro conteúdo.
     */
    _resolveWidgetCollisions(records) {
        const m = this._metrics;
        if (!m) return records;
        const occupied = new Set();
        for (let row = 0; row < m.rows; row++) {
            for (let col = 0; col < m.cols; col++) {
                if (this.slotAt(col, row)?.icon)
                    occupied.add(`${col}:${row}`);
            }
        }

        const resolved = [];
        const updates = [];
        for (const record of records) {
            const span = {
                colSpan: Math.max(1, Math.min(record.colSpan ?? 1, m.cols)),
                rowSpan: Math.max(1, Math.min(record.rowSpan ?? 1, m.rows)),
            };
            let placement = {
                col: Math.max(0, Math.min(record.col ?? 0, m.cols - span.colSpan)),
                row: Math.max(0, Math.min(record.row ?? 0, m.rows - span.rowSpan)),
                ...span,
            };
            if (this._widgetAreaOccupied(placement, occupied))
                placement = this._firstFreeWidgetArea(span, occupied);
            if (!placement) continue;

            this._occupyWidgetArea(placement, occupied);
            const next = {...record, ...placement};
            resolved.push(next);
            if (record.col !== placement.col || record.row !== placement.row ||
                record.colSpan !== placement.colSpan ||
                record.rowSpan !== placement.rowSpan) {
                updates.push({id: record.id, geometry: placement});
            }
        }
        this._widgetStore?.updateGeometries(updates);
        return resolved;
    }

    _widgetPlacementCollides(placement, movingId) {
        const m = this._metrics;
        if (!m || !placement) return true;
        const occupied = new Set();
        for (let row = 0; row < m.rows; row++) {
            for (let col = 0; col < m.cols; col++) {
                if (this.slotAt(col, row)?.icon)
                    occupied.add(`${col}:${row}`);
            }
        }
        for (const record of this._widgetStore?.list() ?? []) {
            if (record.id === movingId) continue;
            const onThisMonitor = record.monitor === this._monitorIndex ||
                (record.monitor === null && this._primaryMonitor);
            if (!onThisMonitor || record.col === null || record.row === null) continue;
            this._occupyWidgetArea(record, occupied);
        }
        return this._widgetAreaOccupied(placement, occupied);
    }

    /**
     * Recebe do gerente um widget solto nesta tela.
     *
     * O retângulo chega no espaço do stage. Ele é convertido para o espaço
     * lógico local antes do snap; a pegada persistida é mantida exatamente,
     * inclusive entre monitores com scale factors diferentes.
     *
     * @param {string} id
     * @param {{x: number, y: number, width: number, height: number}} stageRect
     * @returns {boolean} true somente quando a transferência foi persistida
     */
    moveWidgetHere(id, stageRect) {
        if (!this._actor || !this._metrics || !this._widgetStore ||
            !stageRect || !id)
            return false;
        const record = this._widgetStore.list().find((item) => item.id === id);
        if (!record) return false;
        const colSpan = Math.max(1, Math.round(record.colSpan ?? 1));
        const rowSpan = Math.max(1, Math.round(record.rowSpan ?? 1));
        if (colSpan > this._metrics.cols || rowSpan > this._metrics.rows)
            return false;

        const [surfaceStageX, surfaceStageY] =
            this._actor.get_transformed_position();
        const geometry = {
            x: (stageRect.x - surfaceStageX) / this._scaleFactor,
            y: (stageRect.y - surfaceStageY) / this._scaleFactor,
            width: stageRect.width / this._scaleFactor,
            height: stageRect.height / this._scaleFactor,
        };
        if (!Object.values(geometry).every(Number.isFinite)) return false;
        const placement = this._widgetGridPlacement(geometry, {colSpan, rowSpan});
        if (!placement || this._widgetPlacementCollides(placement, id))
            return false;
        return this._widgetStore.updateGeometry(id, {
            ...placement,
            monitor: this._monitorIndex,
        });
    }

    _firstFreeWidgetArea(span, occupied) {
        const m = this._metrics;
        for (let col = 0; col <= m.cols - span.colSpan; col++) {
            for (let row = 0; row <= m.rows - span.rowSpan; row++) {
                const placement = {col, row, ...span};
                if (!this._widgetAreaOccupied(placement, occupied))
                    return placement;
            }
        }
        return null;
    }

    _widgetAreaOccupied(placement, occupied) {
        for (let col = placement.col; col < placement.col + placement.colSpan; col++) {
            for (let row = placement.row; row < placement.row + placement.rowSpan; row++) {
                if (occupied.has(`${col}:${row}`)) return true;
            }
        }
        return false;
    }

    _occupyWidgetArea(placement, occupied) {
        for (let col = placement.col; col < placement.col + placement.colSpan; col++) {
            for (let row = placement.row; row < placement.row + placement.rowSpan; row++)
                occupied.add(`${col}:${row}`);
        }
    }

    _widgetDisplayRecord(record) {
        const m = this._metrics;
        if (!m) return record;
        const migrated = record.col === null || record.row === null
            ? this._widgetGridPlacement(record)
            : record;
        const col = Math.max(0, Math.min(m.cols - 1, migrated.col ?? 0));
        const row = Math.max(0, Math.min(m.rows - 1, migrated.row ?? 0));
        const colSpan = Math.max(1, Math.min(record.colSpan ?? 4, m.cols - col));
        const rowSpan = Math.max(1, Math.min(record.rowSpan ?? 4, m.rows - row));
        const position = this._cellPosition(col, row);
        const insetX = m.cellWidth * WIDGET_CELL_INSET_RATIO;
        const insetY = m.cellHeight * WIDGET_CELL_INSET_RATIO;
        // A origem à direita inverte o avanço das colunas. O actor continua
        // precisando da borda esquerda do retângulo que ocupa.
        const footprintX = this._gridOrigin === GridOrigin.TOP_RIGHT
            ? position.x - (colSpan - 1) * m.cellWidth
            : position.x;
        // A grade de ícones pode deixar a parte invisível das células das
        // bordas ultrapassar a work area. Recortamos somente essa extremidade
        // do widget. Deslocar a caixa inteira para dentro faria dois widgets
        // em spans vizinhos perderem o respiro de 2 * inset entre eles.
        const idealLeft = footprintX + insetX;
        const idealRight = footprintX + colSpan * m.cellWidth - insetX;
        const leftBound = m.workLeft + m.marginX + insetX;
        const rightBound = m.workRight - m.marginX - insetX;
        const widgetX = Math.max(leftBound, idealLeft);
        const widgetRight = Math.min(rightBound, idealRight);
        const width = Math.max(1, widgetRight - widgetX);

        const idealTop = position.y + insetY;
        const idealBottom = position.y + rowSpan * m.cellHeight - insetY;
        const topBound = m.workTop + m.marginY + insetY;
        const bottomBound = m.workBottom - m.bottomMargin - m.marginY - insetY;
        const widgetY = Math.max(topBound, idealTop);
        const widgetBottom = Math.min(bottomBound, idealBottom);
        const height = Math.max(1, widgetBottom - widgetY);
        return {
            ...record,
            x: widgetX / this._scaleFactor,
            y: widgetY / this._scaleFactor,
            width: width / this._scaleFactor,
            height: height / this._scaleFactor,
        };
    }

    /**
     * Encontra o bloco cuja caixa visível mais se aproxima da geometria.
     * Sem `fixedSpan`, também infere a pegada (resize local); com ele, muda
     * apenas coluna e linha (transferência entre monitores).
     */
    _widgetGridPlacement(geometry, fixedSpan = null) {
        const m = this._metrics;
        if (!m) return geometry;
        const px = (value) => value * this._scaleFactor;
        const insetX = m.cellWidth * WIDGET_CELL_INSET_RATIO;
        const insetY = m.cellHeight * WIDGET_CELL_INSET_RATIO;
        const x = px(geometry.x);
        const y = px(geometry.y);
        const right = x + px(geometry.width);
        const bottom = y + px(geometry.height);

        // Com células parcialmente fora da work area, a largura visível não
        // basta para deduzir o span. Comparamos as duas bordas contra todos os
        // retângulos válidos; isso também mantém o resize encaixado na grade.
        let bestCol = 0;
        let colSpan = 1;
        let bestHorizontalDistance = Infinity;
        const minColSpan = fixedSpan?.colSpan ?? 1;
        const maxColSpan = fixedSpan?.colSpan ?? m.cols;
        for (let span = minColSpan; span <= maxColSpan; span++) {
            for (let col = 0; col <= m.cols - span; col++) {
                const cell = this._cellPosition(col, 0);
                const footprint = this._gridOrigin === GridOrigin.TOP_RIGHT
                    ? cell.x - (span - 1) * m.cellWidth
                    : cell.x;
                const candidateLeft = Math.max(
                    m.workLeft + m.marginX + insetX,
                    footprint + insetX);
                const candidateRight = Math.min(
                    m.workRight - m.marginX - insetX,
                    footprint + span * m.cellWidth - insetX);
                const distance = Math.abs(candidateLeft - x) +
                    Math.abs(candidateRight - right);
                if (distance < bestHorizontalDistance) {
                    bestHorizontalDistance = distance;
                    bestCol = col;
                    colSpan = span;
                }
            }
        }

        let bestRow = 0;
        let rowSpan = 1;
        let bestVerticalDistance = Infinity;
        const minRowSpan = fixedSpan?.rowSpan ?? 1;
        const maxRowSpan = fixedSpan?.rowSpan ?? m.rows;
        for (let span = minRowSpan; span <= maxRowSpan; span++) {
            for (let row = 0; row <= m.rows - span; row++) {
                const top = Math.max(
                    m.workTop + m.marginY + insetY,
                    m.originY + row * m.cellHeight + insetY);
                const candidateBottom = Math.min(
                    m.workBottom - m.bottomMargin - m.marginY - insetY,
                    m.originY + (row + span) * m.cellHeight - insetY);
                const distance = Math.abs(top - y) +
                    Math.abs(candidateBottom - bottom);
                if (distance < bestVerticalDistance) {
                    bestVerticalDistance = distance;
                    bestRow = row;
                    rowSpan = span;
                }
            }
        }
        return {col: bestCol, row: bestRow, colSpan, rowSpan};
    }

    /** Retorna o índice do monitor vivo que contém o ponto de stage. */
    _monitorAtStagePoint(stageX, stageY) {
        if (!Number.isFinite(stageX) || !Number.isFinite(stageY)) return null;
        const monitors = Main.layoutManager.monitors ?? [];
        for (let index = 0; index < monitors.length; index++) {
            const monitor = monitors[index];
            if (stageX >= monitor.x && stageX < monitor.x + monitor.width &&
                stageY >= monitor.y && stageY < monitor.y + monitor.height)
                return index;
        }
        return null;
    }

    _raiseWidgets() {
        for (const host of this._widgets.values()) {
            try { this._actor?.set_child_above_sibling(host.actor, null); } catch (_) {}
        }
    }

    _chooseWidgetImage(id) {
        const bus = Gio.DBus.session;
        bus.call(
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.FileChooser',
            'OpenFile',
            new GLib.Variant('(ssa{sv})', [
                '',
                'Escolher uma imagem',
                {
                    multiple: new GLib.Variant('b', false),
                    directory: new GLib.Variant('b', false),
                },
            ]),
            new GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (_connection, result) => {
                let requestPath;
                try {
                    [requestPath] = bus.call_finish(result).deepUnpack();
                } catch (e) {
                    logError(e, '[ArcDesk] image chooser failed');
                    return;
                }
                let subscription = 0;
                subscription = bus.signal_subscribe(
                    'org.freedesktop.portal.Desktop',
                    'org.freedesktop.portal.Request',
                    'Response',
                    requestPath,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    (_bus, _sender, _path, _iface, _signal, value) => {
                        if (subscription) bus.signal_unsubscribe(subscription);
                        const [response, results] = value.deepUnpack();
                        if (response !== 0) return;
                        const uri = results.uris?.[0];
                        const path = uri ? Gio.File.new_for_uri(uri).get_path() : null;
                        if (!path || !this._widgetStore?.updateConfig(id, {
                            imagePath: path,
                        })) return;
                        this.refreshWidgets();
                    }
                );
            }
        );
    }

    _destroyWidgets() {
        for (const host of this._widgets.values()) {
            try { host.destroy(); } catch (e) {
                logError(e, '[ArcDesk] widget destroy failed');
            }
        }
        this._widgets.clear();
        this._menuWidget = null;
    }

    _detachIcons() {
        for (const slot of this._slots) {
            try {
                slot?.setIcon(null);
            } catch (e) {
                logError(e, '[ArcDesk] detaching an icon failed');
            }
        }
    }

    _destroySlots() {
        for (const slot of this._slots) {
            try {
                slot?.destroy();
            } catch (e) {
                logError(e, '[ArcDesk] slot destroy failed');
            }
        }
        this._slots = [];
        this._paintedSlot = -1;
        this._paintedAs = SlotPaint.NONE;
    }

    _destroyIcons() {
        this._selected = null;
        this._menuIcon = null;
        this._flySource = null;
        for (const icon of this._icons.values()) {
            try {
                icon?.destroy();
            } catch (e) {
                logError(e, '[ArcDesk] icon destroy failed');
            }
        }
        this._icons.clear();
    }

    /**
     * Repõe os ícones EXISTENTES nas casas novas.
     *
     * @returns {boolean} false quando o conjunto de itens deixou de bater
     *   com o de ícones vivos — aí não há reaproveitamento possível e quem
     *   chamou tem que remontar de verdade.
     */
    _replaceIcons() {
        const m = this._metrics;
        if (!m) return false;
        this._allEntries = this._entriesFromModel();
        this._entries = this._ownEntries(this._allEntries);
        const seen = new Set();
        for (const entry of this._entries) {
            if (!entry) continue;
            const icon = this._icons.get(entry.id);
            if (!icon) return false;
            const slot = this.slotAt(entry.col, entry.row);
            // Item clampeado para fora da grade nova (a área de trabalho
            // encolheu demais): _buildSlots() já soltou os ícones das casas
            // antigas, e deixá-lo sem casa o esqueceria sem pai nenhum. A
            // remontagem de verdade sabe simplesmente não desenhá-lo.
            if (!slot) return false;
            slot.setIcon(icon);
            seen.add(entry.id);
        }
        // Ícone vivo que o build() novo não devolveu (um app desinstalado
        // entre as duas contas): a remontagem é quem sabe destruí-lo.
        for (const id of this._icons.keys()) {
            if (!seen.has(id)) return false;
        }
        return true;
    }

    // --- Ícones ---

    _createIcon(entry) {
        try {
            return new DeskIcon({
                item: entry,
                // LÓGICO de propósito — ver _computeMetrics().
                iconSize: this._metrics.iconSize,
                labelWidth: this._metrics.labelWidth,
                labelPosition: this._labelPosition,
                // Aditivo ao contrato: sem ele a célula não sabe pintar a
                // gêmea `-dark`, e o claro é sempre a base.
                theme: this._theme,
                doubleClickToOpen: this._doubleClickToOpen,
                onOpen: (item, icon) =>
                    this._guard(() => this._activate(item, icon), 'activate')(),
                onSelect: (icon) =>
                    this._guard(() => this._onIconSelected(icon), 'select')(),
                dnd: this._iconDnd,
                menu: this._iconMenu,
            });
        } catch (e) {
            logError(e, '[ArcDesk] icon creation failed');
            return null;
        }
    }

    _onIconSelected(icon) {
        // Clicar num ícone também é "entrar" na área de trabalho: é o mesmo
        // gesto que o clique no fundo vazio, e o teclado passa a ser nosso.
        this._takeFocus();
        this._setSelected(icon);
    }

    _setSelected(icon) {
        if (this._selected === icon) return;
        try {
            this._selected?.setSelected(false);
        } catch (_) {}
        this._selected = icon ?? null;
        try {
            this._selected?.setSelected(true);
        } catch (_) {}
    }

    /** O que abrir um item faz: app lança, pasta abre o painel, path abre o gerenciador. */
    _activate(item, icon) {
        if (!item) return;
        if (item.type === ItemType.FOLDER) {
            const anchor = (icon ?? this.iconById(item.id))?.getArtRect?.() ?? null;
            this._onOpenFolder?.(item, anchor);
            return;
        }
        if (item.type === ItemType.PATH) {
            this._openPath(item.path);
            return;
        }
        try {
            notifyArcDockAppClick(item.app);
            item.app?.activate();
        } catch (e) {
            logError(e, '[ArcDesk] app activate failed');
        }
    }

    /**
     * Abre uma pasta do sistema de arquivos no gerenciador padrão.
     *
     * `_async` e nunca a versão síncrona: isto roda dentro do compositor, e
     * resolver o handler padrão de um caminho que mora num mount de rede
     * morto trava a sessão inteira (é a regra de I/O da casa, não uma
     * preferência).
     */
    _openPath(path) {
        if (!path) return;
        try {
            const uri = Gio.File.new_for_path(path).get_uri();
            const context = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri_async(uri, context, null, (_, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                } catch (e) {
                    logError(e, '[ArcDesk] opening a folder failed');
                }
            });
        } catch (e) {
            logError(e, '[ArcDesk] opening a folder failed');
        }
    }

    // --- Menu de contexto ---

    /**
     * Política do menu das células, um objeto só para a superfície inteira
     * (ela não tem estado por ícone — a célula chega como argumento).
     *
     * `createShortcut` / `isPinnedToDock` / `togglePinnedToDock` NÃO entram:
     * eles exigem a loja de itens da dock, e o ArcDesk nunca constrói uma —
     * uma segunda instância dela brigaria com a supressão de eco das
     * escritas do ArcDock. E eles só valem em PAR: um item que sabe ler o
     * estado mas não gravá-lo carrega um rótulo mentiroso.
     */
    _menuPolicy() {
        return {
            open: (item) => this._guard(() => this._activate(item, null), 'menu open')(),
            openFolder: (item) =>
                this._guard(() => this._activate(item, null), 'menu open folder')(),
            rename: (item) => this._guard(() => {
                if (item?.type === ItemType.FOLDER) {
                    this._activate(item, null);
                    return;
                }
                if (!item?.id) return;
                // O PopupMenu só devolve o modal DEPOIS do callback de
                // activate. Abre o diálogo no idle seguinte, já sem os dois
                // grabs disputando teclado e ponteiro.
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._guard(() => {
                        if (!this._actor || !this._layout)
                            return;
                        this._renameDialog ??= new RenameDialog();
                        this._renameDialog.present(item.name, (name) => {
                            if (this._layout?.renameItem(item.id, name))
                                this._scheduleRefresh();
                        });
                    }, 'rename dialog open')();
                    return GLib.SOURCE_REMOVE;
                });
            }, 'menu rename')(),
            changeIcon: (item) => this._guard(() => {
                if (!item?.id) return;
                this._chooseItemIcon(item.id);
            }, 'menu change icon')(),
            remove: (item) =>
                this._guard(() => {
                    if (!item?.id) return;
                    if (this._layout.removeItem(item.id)) this._scheduleRefresh();
                }, 'menu remove')(),
            stateChanged: (icon, isOpen) =>
                this._guard(() => {
                    if (isOpen) {
                        this._closeBackgroundMenu();
                        this._closeWidgetMenu();
                        this._menuIcon = icon;
                    }
                    else if (this._menuIcon === icon) this._menuIcon = null;
                }, 'menu state')(),
        };
    }

    _chooseItemIcon(id) {
        const bus = Gio.DBus.session;
        bus.call(
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.FileChooser',
            'OpenFile',
            new GLib.Variant('(ssa{sv})', ['', 'Escolher ícone', {
                multiple: new GLib.Variant('b', false),
                directory: new GLib.Variant('b', false),
            }]),
            new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, null,
            (_connection, result) => {
                let requestPath;
                try { [requestPath] = bus.call_finish(result).deepUnpack(); }
                catch (e) { logError(e, '[ArcDesk] icon chooser failed'); return; }
                let subscription = 0;
                subscription = bus.signal_subscribe(
                    'org.freedesktop.portal.Desktop',
                    'org.freedesktop.portal.Request', 'Response', requestPath, null,
                    Gio.DBusSignalFlags.NONE,
                    (_bus, _sender, _path, _iface, _signal, value) => {
                        if (subscription) bus.signal_unsubscribe(subscription);
                        const [response, results] = value.deepUnpack();
                        if (response !== 0) return;
                        const uri = results.uris?.[0];
                        const path = uri ? Gio.File.new_for_uri(uri).get_path() : null;
                        if (path && this._layout?.setItemIcon(id, path))
                            this._scheduleRefresh();
                    });
            });
    }

    /**
     * Existe ALGUM menu nosso aberto?
     *
     * Cobre o menu do fundo junto com o da célula: os dois seguram um modal
     * por cima do nosso grab, e sem isto a primeira tecla digitada com o
     * menu aberto seria tratada pelo handler de teclado da superfície.
     */
    _isMenuOpen() {
        if (this._bgMenu?.isOpen) return true;
        if (this._menuWidget?.isMenuOpen) return true;
        if (!this._menuIcon) return false;
        // Confere no ícone em vez de confiar no campo: uma célula destruída
        // sem emitir o fechamento deixaria o campo de pé para sempre, e o
        // teclado da superfície ficaria desviado junto com ele.
        if (this._menuIcon.isMenuOpen) return true;
        this._menuIcon = null;
        return false;
    }

    _closeIconMenu() {
        const icon = this._menuIcon;
        this._menuIcon = null;
        try {
            icon?.closeMenu();
        } catch (e) {
            logError(e, '[ArcDesk] menu close failed');
        }
    }

    _beforeWidgetMenu(widget) {
        this._closeIconMenu();
        this._closeBackgroundMenu();
        if (this._menuWidget && this._menuWidget !== widget)
            this._menuWidget.closeMenu();
    }

    _closeWidgetMenu() {
        const widget = this._menuWidget;
        this._menuWidget = null;
        try { widget?.closeMenu(); } catch (e) {
            logError(e, '[ArcDesk] widget menu close failed');
        }
    }

    // --- Foco de teclado ---

    /**
     * Foco normal basta para Escape/Enter/Menu. Um grab modal também
     * captura o ponteiro e fazia cliques em outras janelas voltarem para a
     * superfície enquanto uma seleção estivesse ativa.
     */
    _takeFocus() {
        if (!this._actor) return false;
        if (!this._actor.mapped || !this._actor.visible) return false;
        try {
            this._actor.grab_key_focus();
            return global.stage?.get_key_focus?.() === this._actor;
        } catch (e) {
            logError(e, '[ArcDesk] key focus failed');
            return false;
        }
    }

    /** Devolve apenas o foco normal, nunca um grab modal. */
    _releaseFocus() {
        try {
            if (global.stage?.get_key_focus?.() === this._actor)
                global.stage.set_key_focus(null);
        } catch (e) {
            logError(e, '[ArcDesk] key focus release failed');
        }
    }

    // --- Eventos ---

    /**
     * O pixel apontado por (stageX, stageY) é NOSSO?
     *
     * Precisa ser o pick, e não uma comparação com o retângulo da
     * superfície: com o grab de pé o Clutter entrega ao actor do grab TODO
     * evento que não caiu num descendente dele, então um clique numa janela
     * maximizada chega aqui com coordenadas dentro do nosso retângulo. Sem
     * o pick, esse clique seria lido como "clicou na área de trabalho", o
     * grab não voltaria nunca e as janelas ficariam sem clique.
     *
     * `PickMode.ALL` e não REACTIVE: actor de janela pode não ser reactive,
     * e um pick que o ignorasse devolveria a superfície por baixo dele —
     * que é justamente o erro que se quer evitar. Qualquer falha responde
     * "não é nosso": devolver o grab a mais custa um clique, deixá-lo de pé
     * custa a sessão.
     */
    _isOurPixel(stageX, stageY) {
        try {
            let target = global.stage.get_actor_at_pos(
                Clutter.PickMode.ALL,
                stageX,
                stageY
            );
            while (target) {
                if (target === this._actor) return true;
                target = target.get_parent();
            }
        } catch (e) {
            logError(e, '[ArcDesk] pick failed');
        }
        return false;
    }

    /**
     * O ponto pertence somente ao fundo/estrutura transparente da grade?
     *
     * `event.get_source()` nao e suficiente: o pick do Clutter pode usar
     * como origem uma DeskSlot (ou a plate invisivel dentro dela), embora
     * para o usuario aquela celula esteja vazia. Caminhamos do actor no
     * ponto ate a superficie e so recusamos o fundo quando encontramos um
     * conteudo interativo de verdade: um icone ou um widget.
     */
    _isEmptyPixel(stageX, stageY) {
        try {
            const contentActors = new Set([
                ...this._icons.values(),
                ...[...this._widgets.values()].map(host => host.actor),
            ]);
            let target = global.stage.get_actor_at_pos(
                Clutter.PickMode.ALL,
                stageX,
                stageY
            );
            while (target) {
                if (contentActors.has(target)) return false;
                if (target === this._actor) return true;
                target = target.get_parent();
            }
        } catch (e) {
            logError(e, '[ArcDesk] empty pixel pick failed');
        }
        return false;
    }

    _onButtonPress(actor, event) {
        const [x, y] = event.get_coords();
        if (!this._isOurPixel(x, y)) {
            this._releaseFocus();
            this._setSelected(null);
            return Clutter.EVENT_PROPAGATE;
        }
        this._takeFocus();
        // Consumimos o clique SO quando ele nasceu num pixel sem icone nem
        // widget. Uma casa transparente da grade tambem e fundo vazio.
        // Nascido num conteudo, tem que propagar: da GNOME 49 em
        // diante o clique da célula é reconhecido por um ClutterClickGesture,
        // e um EVENT_STOP vindo do ancestral cancela o gesture antes de ele
        // virar clique — foi assim que a dock inteira já ficou sem resposta
        // ao botão 1.
        if (!this._isEmptyPixel(x, y)) return Clutter.EVENT_PROPAGATE;
        this._setSelected(null);
        // Botão direito no fundo vazio: o menu do FUNDO.
        //
        // Ele existe porque nós tomamos esse pixel de quem o tinha. O menu
        // "Alterar plano de fundo…" do GNOME é pendurado pelo
        // backgroundMenu.js em cada Meta.BackgroundActor, e a superfície
        // fica ACIMA deles dentro do _backgroundGroup e é reactive — ou
        // seja, engole o botão 3 e o menu do Shell nunca dispara. No
        // monitor onde o ArcDesk não pinta o menu do GNOME continua
        // aparecendo, e era exatamente essa a assimetria que o usuário via.
        if (event.get_button?.() === Clutter.BUTTON_SECONDARY)
            this._openBackgroundMenu(x, y);
        return Clutter.EVENT_STOP;
    }

    // --- Menu do fundo ---

    /**
     * Abre o menu do fundo no ponto clicado.
     *
     * O menu é construído no PRIMEIRO botão direito desta superfície, nunca
     * antes: a maioria das sessões nunca o abre.
     *
     * O modal dele e o nosso grab convivem porque grab do Clutter é PILHA:
     * o PopupMenuManager empilha o dele por cima do nosso quando abre e o
     * devolve quando fecha, e o de baixo volta a valer sozinho. É a mesma
     * convivência que o menu de contexto das células já tem.
     */
    _openBackgroundMenu(x, y) {
        // Dois menus nossos abertos ao mesmo tempo seriam dois grabs
        // empilhados e duas listas competindo pelo mesmo clique.
        this._closeIconMenu();
        this._closeWidgetMenu();
        if (!this._bgMenu) {
            this._bgMenu = new DeskBackgroundMenu({
                sourceActor: this._actor,
                onOpenPrefs: () => this._onOpenPrefs?.(),
                widgets: availableWidgets(),
                onAddWidget: (type) => {
                    const definition = availableWidgets().find(
                        widget => widget.type === type);
                    if (definition?.configurable) {
                        this._onOpenPrefs?.();
                        return;
                    }
                    this._widgetStore?.add(type, {
                        monitor: this._monitorIndex,
                        colSpan: definition.defaultColSpan,
                        rowSpan: definition.defaultRowSpan,
                    });
                    this.refreshWidgets();
                },
                onArrangeIcons: () =>
                    this._guard(() => this._arrangeIcons(), 'arrange icons')(),
            });
        }
        this._bgMenu.open(x, y);
    }

    _closeBackgroundMenu() {
        try {
            this._bgMenu?.close();
        } catch (e) {
            logError(e, '[ArcDesk] background menu close failed');
        }
    }

    /**
     * "Organizar ícones": compacta os itens DESTE monitor nas primeiras
     * casas, varrendo em coluna (col 0 linhas 0..n, depois col 1, …) — a
     * mesma ordem em que o modelo procura casa livre.
     *
     * A ordem dos itens é a de `desk-items`: é a que o usuário vê na página
     * Items das preferências e a única estável entre duas organizações.
     *
     * A ocupação é simulada NUM MAPA LOCAL, e não relida do modelo a cada
     * passo: `itemAt()` responde contra o último `build()`, não contra o que
     * acabou de ser gravado, e usá-lo aqui faria a segunda troca decidir
     * sobre uma grade que já não existe.
     */
    _arrangeIcons() {
        const m = this._metrics;
        if (!m || !this._layout) return;

        const linear = (col, row) => col * m.rows + row;
        const ids = [];
        const at = new Map();
        const owner = new Map();
        for (const entry of this._entries) {
            if (!entry?.id) continue;
            ids.push(entry.id);
            const index = linear(entry.col, entry.row);
            at.set(entry.id, index);
            owner.set(index, entry.id);
        }

        const capacity = m.cols * m.rows;
        let changed = false;
        for (let target = 0; target < ids.length && target < capacity; target++) {
            const id = ids[target];
            const current = at.get(id);
            if (current === target) continue;
            const col = Math.floor(target / m.rows);
            const row = target % m.rows;
            const occupant = owner.get(target) ?? null;
            // Ocupada: TROCA. Um moveTo por cima de um ocupante deixaria a
            // decisão de para onde ele vai com o modelo, e uma grade livre
            // não empurra ninguém sem que o usuário tenha pedido.
            const ok = occupant
                ? this._layout.swap(id, occupant)
                : this._layout.moveTo(id, col, row, this._monitorIndex);
            if (!ok) continue;
            changed = true;
            owner.set(target, id);
            at.set(id, target);
            if (occupant) {
                owner.set(current, occupant);
                at.set(occupant, current);
            } else {
                owner.delete(current);
            }
        }

        if (!changed) return;
        // Todas as grades: um `moveTo` que não coube pode ter transbordado
        // para o primário, e aí o outro monitor mudou junto.
        if (this._onRefreshAll) this._onRefreshAll();
        else this._scheduleRefresh();
    }

    _onKeyPress(event) {
        // Menu de contexto aberto: as teclas são DELE. O actor do menu mora
        // no uiGroup e o Escape nem chega até aqui (o PopupMenuManager o
        // consome na fase de CAPTURA), mas as outras chegam.
        if (this._isMenuOpen()) return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        switch (symbol) {
        case Clutter.KEY_Escape:
            // Sai da área de trabalho: seleção apagada, painel fechado e —
            // o que importa — o teclado devolvido à sessão.
            this._setSelected(null);
            this._onCloseFolder?.();
            this._releaseFocus();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            if (!this._selected) return Clutter.EVENT_PROPAGATE;
            this._activate(this._selected.item, this._selected);
            return Clutter.EVENT_STOP;

        // Menu pelo teclado: a célula é `can_focus: false` (a "seleção" é um
        // realce nosso, não o foco), então ela nunca receberia a tecla
        // sozinha.
        case Clutter.KEY_Menu:
            this._selected?.toggleMenu();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_F10:
            if (!(event.get_state() & Clutter.ModifierType.SHIFT_MASK))
                return Clutter.EVENT_PROPAGATE;
            this._selected?.toggleMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // --- Arraste: retratos e política ---

    /**
     * O item da ORIGEM do arraste: do próprio ícone enquanto ele existe, do
     * retrato de _onIconDragBegin quando ele já não existe mais.
     *
     * O retrato só vale para o ícone que ABRIU este arraste. Um source
     * desconhecido (outro draggable do Shell subindo pela mesma árvore)
     * nunca pode herdar o item de um gesto que não é dele — seria um drop
     * aceito em nome do item errado.
     */
    _dragItemOf(source) {
        if (source?.item) return source.item;
        if (!this._drag || source !== this._drag.icon) return null;
        return this._drag.item ?? null;
    }

    /**
     * O id da origem do arraste.
     *
     * O `source.id` vem PRIMEIRO, e é isso que faz o arraste entre
     * monitores funcionar: um ícone da outra tela é um source vivo e
     * legítimo, e ler o id dele direto é exatamente o certo. O retrato só
     * entra quando o ícone é o desta superfície e já foi destruído.
     */
    _dragIdOf(source) {
        if (source?.id) return source.id;
        if (!this._drag || source !== this._drag.icon) return null;
        return this._drag.id ?? null;
    }

    /**
     * A pasta que contém este app, ou null.
     *
     * É o que transforma um drop na grade em "tira da pasta": o ícone
     * arrastado de dentro de um painel de pasta aberto não está em
     * `desk-items`, então `moveTo()` não teria o que mover.
     *
     * A varredura é sobre TODAS as entradas e não só as deste monitor: a
     * pasta aberta pode estar na outra tela, e o app arrastado de dentro
     * dela pode muito bem ser solto aqui.
     */
    _folderContaining(id) {
        if (!id) return null;
        for (const entry of this._allEntries) {
            if (entry?.type !== ItemType.FOLDER) continue;
            if ((entry.apps ?? []).some((app) => app?.id === id))
                return entry.folderId ?? entry.id;
        }
        return null;
    }

    /**
     * Este source pode soltar aqui?
     *
     * NÃO exige que o ícone seja um dos nossos. O dnd acha o alvo pelo
     * pixel sob o ponteiro e sobe a árvore de actors, então um arraste que
     * atravessa para a outra tela chega ao delegate DAQUELA superfície sem
     * nenhuma coordenação — e recusá-lo por ser "de fora" seria justamente
     * proibir o arraste entre monitores. Basta que o id resolva no modelo
     * compartilhado (ou numa pasta aberta).
     */
    _isDropSource(source) {
        if (!(source instanceof DeskIcon)) return false;
        const id = this._dragIdOf(source);
        if (!id) return false;
        if (!this._isForeignSource(source)) return true;
        return this._layout.has(id) || !!this._folderContaining(id);
    }

    /**
     * O arraste em curso NÃO nasceu nesta superfície.
     *
     * Só a superfície de origem tem `_drag` preenchido — o `onDragBegin` é
     * emitido na política de dnd do ícone, que é a da superfície que o
     * criou. Isso vale também para as células do painel de pasta, que são
     * criadas pela superfície que abriu a pasta.
     */
    _isForeignSource(source) {
        return !(this._drag && this._drag.icon === source);
    }

    /**
     * Anuncia ao gerente um drop vindo de OUTRA superfície.
     *
     * Chamado ANTES da mutação, e por isso é também uma porta: `false`
     * significa "o gerente recusou" e o drop é tratado como recusado. O
     * gerente é quem remonta todas as grades — a de origem também perdeu um
     * item —, e ele agenda essa remontagem para o próximo idle, portanto
     * depois da mutação que vem logo abaixo.
     */
    _claimForeignDrop(source, dragActor) {
        if (!this._isForeignSource(source)) return true;
        if (!this._onDropOnOther) return true;
        return this._onDropOnOther(source, dragActor) !== false;
    }

    _onIconDragBegin(icon) {
        // Retrato do que o DROP precisa saber, tirado enquanto o ícone está
        // vivo: o gesto termina no dnd, que pergunta ao `_delegate` da
        // origem qual é o item — e se alguma coisa remontar a grade no meio
        // do caminho, esse ícone já teve o `_item` zerado e o drop seria
        // recusado por todos os alvos. O modelo só é mexido NO drop, então o
        // retrato continua valendo: ele descreve o item, não o actor.
        // Um id que NÃO está em `desk-items` só pode ter vindo de dentro de
        // uma pasta — é a mesma pergunta que o drop refaz, e a resposta é
        // guardada aqui porque no fim do gesto o modelo já mudou e ela
        // deixaria de ser verdade.
        const fromFolderId =
            icon?.id && !this._layout.has(icon.id)
                ? this._folderContaining(icon.id)
                : null;
        this._drag = {
            icon,
            id: icon?.id ?? null,
            item: icon?.item ?? null,
            fromFolderId,
            gridCleared: false,
        };
        this._dragChanged = false;
        // Saindo de uma pasta, o painel tem que sair da frente. Não basta
        // desbotá-lo: `PickMode.ALL` continua achando uma célula invisível e
        // o drop cairia no painel em vez de cair na grade — só um actor
        // desmapeado está mesmo fora do pick, e é isso que setDragMode faz
        // no fim do fade.
        //
        // Desbotar e NÃO fechar: fechar destruiria a célula de ORIGEM no
        // meio do gesto, e é dela que o dnd precisa para desfazer um drop
        // recusado. Quem decide entre devolver e fechar de vez é o
        // _onIconDragEnd, olhando para _dragChanged.
        if (fromFolderId)
            this._guard(() => this._onFolderDragMode?.(true), 'popup drag mode')();
        // A casa de origem acende como BURACO: neste primeiro instante nada
        // se moveu, e é para ali que o item volta se o gesto acabar onde
        // começou. Do primeiro handleDragOver em diante a casa acesa é a que
        // está sob o ponteiro.
        this._originSlot = this._slotIndexOfIcon(icon);
        this._paintSlot(this._originSlot, SlotPaint.EMPTY);
    }

    _onIconDragEnd(icon) {
        // Painel desbotado por causa deste gesto: se o modelo mudou, a lista
        // que ele mostra já não existe e ele fecha de vez; se nada mudou, ele
        // volta — o usuário desistiu no meio e a pasta continua aberta, que é
        // exatamente onde ele estava.
        if (this._drag?.fromFolderId) {
            const changed = this._dragChanged;
            this._guard(() => {
                if (changed) this._onCloseFolder?.();
                else this._onFolderDragMode?.(false);
            }, 'popup drag mode')();
        }
        this._dragChanged = false;
        this._drag = null;
        // Com um voo em curso o ícone de origem VOLTA a se esconder: o
        // DeskIcon já se mostrou de novo (é o que ele faz no fim de todo
        // gesto), e deixá-lo aceso poria o mesmo item em dois lugares
        // enquanto o fantasma atravessa a tela. Quem o traz de volta é a
        // grade nova — ou _flushRefresh(), quando não há grade nova.
        //
        // hide() aqui é seguro e não viola a lei 2: ela vale DURANTE o
        // gesto, e este é o handler que marca o fim dele.
        //
        // Este handler roda TAMBÉM quando quem aceitou o drop foi a
        // superfície do outro monitor — o dnd emite 'drag-end' na origem
        // independentemente de quem aceitou. Nesse caso não há voo NOSSO (o
        // fantasma é da outra superfície), então cai no `else` e a casa
        // acesa se apaga, que é exatamente o que a origem tem a fazer. Ela
        // NÃO agenda remontagem nenhuma: quem remonta todo mundo é o
        // gerente, avisado pela superfície que aceitou.
        if ((this._flight?.flying ?? 0) > 0) {
            if (icon && this._slotIndexOfIcon(icon) !== -1) {
                this._flySource = icon;
                try {
                    icon.hide();
                } catch (_) {}
            }
        } else {
            this._clearTargetSlot();
        }
    }

    /**
     * O ponteiro parou sobre um ícone que aceita virar pasta.
     *
     * A casa acesa volta a ser a de ORIGEM, pintada como BURACO: a resposta
     * ao drop deixou de ser "vai para esta posição" e passou a ser "junta
     * com este ícone", e nenhuma casa vai ser ocupada por causa dele. Um
     * TARGET aceso ali continuaria prometendo um lugar que este drop não
     * usa. Quando o ponteiro sai do ícone, o handleDragOver da superfície
     * volta a correr e reacende a casa sob o ponteiro sozinho.
     */
    _onMergeHover(_icon, hovering) {
        if (!hovering) return;
        this._paintSlot(this._originSlot, SlotPaint.EMPTY);
    }

    _canMerge(sourceIcon, targetIcon) {
        const source = this._dragItemOf(sourceIcon);
        // O alvo é o ícone sob o ponteiro, vivo por definição: ele é quem
        // está sendo perguntado.
        const target = targetIcon?.item ?? null;
        if (!source || !target || source === target) return false;
        if (source.id === target.id) return false;
        // Só APP entra em pasta: pasta dentro de pasta não existe aqui (um
        // nível só mantém o gesto previsível), e uma pasta de caminhos do
        // sistema de arquivos seria outra coisa, com outras regras.
        if (source.type !== ItemType.APP) return false;
        if (target.type === ItemType.FOLDER)
            return !(target.apps ?? []).some((entry) => entry?.id === source.id);
        return target.type === ItemType.APP;
    }

    _merge(sourceIcon, targetIcon, dragActor) {
        const source = this._dragItemOf(sourceIcon);
        const target = targetIcon?.item ?? null;
        if (!source || !target) return false;
        // Item da outra tela caindo numa pasta desta: o gerente precisa
        // saber, porque a grade de ORIGEM também perdeu um item.
        if (!this._claimForeignDrop(sourceIcon, dragActor)) return false;
        const fromFolderId = this._layout.has(source.id)
            ? null
            : this._folderContaining(source.id);

        let changed = false;
        // O id da pasta RESULTANTE, guardado para o quique de chegada: ele
        // roda no ícone novo, depois da remontagem, e a essa altura o
        // targetIcon daqui já foi destruído.
        let folderId = null;
        if (target.type === ItemType.FOLDER) {
            changed = this._layout.addToFolder(target.folderId ?? target.id, source.id);
            if (changed) folderId = target.id;
        } else if (fromFolderId) {
            // Saiu de uma pasta e caiu em cima de um app solto: é uma pasta
            // nova, e o app tem que deixar a antiga antes. A pasta que ficar
            // com menos de dois membros se dissolve sozinha no próximo
            // build().
            // (-1, -1) é "sem posição": o app sai de uma pasta e entra
            // direto noutra, então ele nunca chega a ocupar uma casa. O
            // monitor vai junto mesmo assim — sem casa, ele é só o que o
            // modelo guardaria se a posição valesse.
            changed = this._layout.removeFromFolder(
                fromFolderId,
                source.id,
                -1,
                -1,
                this._monitorIndex
            );
            if (changed) {
                folderId = this._layout.createFolder(target.id, source.id);
                changed = folderId !== null;
            }
        } else {
            folderId = this._layout.createFolder(target.id, source.id);
            changed = folderId !== null;
        }
        if (!changed) return false;
        this._dragChanged = true;

        // Voo primeiro, agendamento depois: é o voo que incrementa o
        // contador que faz _scheduleRefresh() represar a remontagem.
        this._flight?.fly(dragActor, targetIcon.getArtRect(), {
            duration: ANIM.FLY_FOLDER_MS,
            scale: ANIM.FLY_FOLDER_SCALE,
            fade: true,
        });
        this._popId = folderId;
        this._scheduleRefresh();
        return true;
    }

    /**
     * Troca dois itens de casa.
     *
     * Existe como verbo da política porque a célula também pode reivindicar
     * o drop (a faixa da borda, ou o meio de um alvo que não aceita merge);
     * quando ela devolve CONTINUE em vez de reivindicar, o mesmo resultado
     * sai pelo acceptDrop da superfície. Os dois caminhos passam pelo mesmo
     * `layout.swap()`, então qual deles atendeu não muda nada.
     */
    _swap(sourceIcon, targetIcon, dragActor) {
        const sourceId = this._dragIdOf(sourceIcon);
        const targetId = targetIcon?.id ?? null;
        if (!sourceId || !targetId || sourceId === targetId) return false;
        // Um app que veio de dentro de uma pasta não ocupa casa nenhuma: não
        // há o que trocar, e inventar uma troca tiraria o ocupante do lugar
        // em nome de um item que não tem lugar.
        if (!this._layout.has(sourceId)) return false;
        // A troca leva as duas casas E os dois monitores: é assim que um
        // item da outra tela vem para cá e o ocupante daqui vai para lá.
        if (!this._claimForeignDrop(sourceIcon, dragActor)) return false;
        const index = this._slotIndexOfIcon(targetIcon);
        // Lido AGORA, com a grade ainda de pé: a casa é destruída pela
        // remontagem que este drop agenda, e o voo mira onde ela estava no
        // instante em que o usuário soltou.
        const rect = this._slots[index]?.artRect() ?? targetIcon.getArtRect?.() ?? null;
        const changed = this._layout.swap(sourceId, targetId);
        this._flight?.fly(dragActor, rect, { duration: ANIM.FLY_MS });
        if (changed) {
            // Marca o gesto como "mexeu no modelo": é o que decide, lá no
            // _onIconDragEnd, se o painel de pasta volta ou fecha de vez.
            this._dragChanged = true;
            this._scheduleRefresh();
        }
        // true mesmo quando o modelo recusou: o drop FOI tratado, e devolver
        // false faria a arte voar de volta à origem como se o gesto tivesse
        // falhado.
        return true;
    }

    // --- Arraste: o delegate da superfície ---

    _handleDragOver(source, x, y) {
        if (!this._isDropSource(source)) return DND.DragMotionResult.NO_DROP;
        // O ponteiro está NESTA tela com o arraste de OUTRA: a superfície de
        // origem parou de receber handleDragOver (não existe
        // `handleDragOut`) e ficaria com um ALVO aceso lá, apontando um
        // lugar que este drop não vai usar. Ela volta a mostrar só o buraco
        // da casa de origem, e a lei "uma casa acesa por vez" continua
        // valendo do ponto de vista do usuário, que enxerga as duas telas.
        if (this._isForeignSource(source))
            this._onDragOverHere?.();
        const cell = this._cellAt(x, y);
        if (!cell) {
            // Fora da grade o drop é recusado, e a casa acesa volta a ser a
            // de origem: é para lá que a arte vai voltar.
            this._paintSlot(this._originSlot, SlotPaint.EMPTY);
            return DND.DragMotionResult.NO_DROP;
        }
        const sourceId = this._dragIdOf(source);
        const occupantId = this._layout.itemAt(
            cell.col,
            cell.row,
            this._monitorIndex
        );
        const occupied = !!occupantId && occupantId !== sourceId;
        this._paintSlot(
            this._slotIndex(cell.col, cell.row),
            occupied ? SlotPaint.SWAP : SlotPaint.TARGET
        );
        return DND.DragMotionResult.MOVE_DROP;
    }

    /**
     * O drop na grade livre.
     *
     * | ponteiro sobre | resultado |
     * |---|---|
     * | casa vazia | MOVE |
     * | casa ocupada | SWAP (o merge, quando cabe, foi reivindicado pela própria célula antes de chegar aqui) |
     * | fora da grade | recusado, a arte volta voando |
     *
     * Nada é mexido na tela aqui dentro: o modelo muda, o fantasma parte e a
     * remontagem fica para o próximo idle (_scheduleRefresh). Este método
     * retorna para dentro do dnd, que ainda está segurando o actor de
     * arraste e a célula de origem — destruir a grade aqui puxaria o tapete
     * de baixo dele.
     */
    _acceptDrop(source, dragActor, x, y) {
        if (!this._isDropSource(source)) return false;
        const sourceId = this._dragIdOf(source);
        if (!sourceId) return false;
        const cell = this._cellAt(x, y);
        // Recusa de verdade: false faz o dnd devolver a arte à origem, que é
        // exatamente a leitura certa de "aqui não dá".
        if (!cell) return false;

        const index = this._slotIndex(cell.col, cell.row);
        const rect = this._slots[index]?.artRect() ?? null;
        const occupantId = this._layout.itemAt(
            cell.col,
            cell.row,
            this._monitorIndex
        );
        const occupied = !!occupantId && occupantId !== sourceId;
        const fromFolderId = this._layout.has(sourceId)
            ? null
            : this._folderContaining(sourceId);

        // Saindo de uma pasta só entra em casa LIVRE: o app ainda não ocupa
        // lugar nenhum, então não há par para trocar. Recusado ANTES de
        // avisar o gerente — anunciar um drop que não vai acontecer o faria
        // remontar as grades à toa.
        if (fromFolderId && occupied) return false;

        // Item de OUTRA superfície: o gerente é avisado antes de qualquer
        // escrita, e um "não" dele recusa o drop (a arte volta voando).
        if (!this._claimForeignDrop(source, dragActor)) return false;

        // Toda escrita carrega o NOSSO índice de monitor — é isto, e só
        // isto, que move o item de uma tela para a outra.
        let changed = false;
        if (fromFolderId) {
            changed = this._layout.removeFromFolder(
                fromFolderId,
                sourceId,
                cell.col,
                cell.row,
                this._monitorIndex
            );
        } else if (occupied) {
            changed = this._layout.swap(sourceId, occupantId);
        } else {
            changed = this._layout.moveTo(
                sourceId,
                cell.col,
                cell.row,
                this._monitorIndex
            );
        }

        this._flight?.fly(dragActor, rect, { duration: ANIM.FLY_MS });
        if (changed) {
            // Marca o gesto como "mexeu no modelo": é o que decide, lá no
            // _onIconDragEnd, se o painel de pasta volta ou fecha de vez.
            this._dragChanged = true;
            this._scheduleRefresh();
        }
        // true mesmo quando nada mudou: soltar na própria casa é um drop
        // TRATADO, e devolver false faria a arte voar de volta à origem como
        // se o gesto tivesse falhado.
        return true;
    }

    // --- A casa acesa ---

    /**
     * Acende uma casa e apaga a que estava acesa.
     *
     * Guarda o par (casa, pintura) porque a MESMA casa troca de pintura no
     * meio do gesto: a de origem nasce BURACO e vira ALVO no instante em que
     * o ponteiro volta para cima dela.
     */
    _paintSlot(index, paint) {
        if (index === this._paintedSlot && paint === this._paintedAs) return;
        if (index !== this._paintedSlot)
            this._slots[this._paintedSlot]?.setPaint(SlotPaint.NONE);
        this._paintedSlot = index;
        this._paintedAs = paint;
        this._slots[index]?.setPaint(paint);
    }

    /** Apaga a casa acesa: o gesto acabou. */
    _clearTargetSlot() {
        this._slots[this._paintedSlot]?.setPaint(SlotPaint.NONE);
        this._paintedSlot = -1;
        this._paintedAs = SlotPaint.NONE;
        this._originSlot = -1;
    }

    /**
     * Traz de volta o ícone que ficou escondido por causa de um voo que não
     * terminou em remontagem (o drop que não mudou nada).
     */
    _restoreFlySource() {
        const icon = this._flySource;
        this._flySource = null;
        try {
            icon?.show();
        } catch (_) {}
    }

    // --- A represa da remontagem ---

    /**
     * Marca "o layout mudou" e agenda a remontagem para o próximo idle.
     *
     * TUDO que reage a um drop passa por aqui. Quem chama é um acceptDrop, e
     * o dnd ainda está mexendo no actor de arraste e na célula de origem
     * quando ele retorna — remontar a grade ali dentro destrói justamente os
     * actors que ele tem na mão. Um idle depois, o gesto já acabou.
     */
    _scheduleRefresh() {
        // Com um ícone no ar a remontagem ESPERA: ela destrói a grade
        // inteira, e o fantasma que está voando mira uma casa dela. Quem
        // solta a represa é o fim do voo (_flushRefresh, chamado pelo
        // onIdle do GhostFlight) — ou o relógio dele, que é a testemunha
        // independente de que a represa sempre abre.
        if ((this._flight?.flying ?? 0) > 0) {
            this._refreshPending = true;
            return;
        }
        if (this._refreshId) return;
        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshId = 0;
            if (!this._actor) return GLib.SOURCE_REMOVE;
            // O painel da pasta fecha ANTES da remontagem: a âncora dele é
            // uma célula que a remontagem vai destruir, e um painel apontando
            // para um actor morto é um escudo reactive parado sobre a sessão.
            this._onCloseFolder?.();
            this._guard(() => this.refresh(), 'scheduled refresh')();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRefresh() {
        if (!this._refreshId) return;
        GLib.source_remove(this._refreshId);
        this._refreshId = 0;
    }

    /**
     * O último voo terminou: ou a remontagem represada acontece agora, ou
     * não há remontagem nenhuma e o cenário do arraste tem que sair na mão.
     *
     * O segundo caso é o drop que não mudou nada (soltar o item na própria
     * casa): ninguém vai remontar a grade, então é aqui que o fantasma
     * morre, a casa apaga e o ícone escondido volta.
     */
    _flushRefresh() {
        if ((this._flight?.flying ?? 0) > 0) return;
        if (this._refreshPending) {
            this._refreshPending = false;
            this._scheduleRefresh();
            return;
        }
        this._flight?.clear();
        this._clearTargetSlot();
        this._restoreFlySource();
    }

    // --- Guardas ---

    /**
     * Lei 1 do dnd: NADA nosso pode lançar de dentro do `emit` dele.
     *
     * `_Draggable` é um `Signals.EventEmitter` e o `emit()` dele percorre os
     * handlers num laço JS puro, SEM try/catch. `drag-begin` sai de dentro
     * de `_gestureRecognized()` e `drag-end` de dentro de
     * `_dragActorDropped()`. Uma exceção nossa sobe por esse emit e aborta o
     * resto do gesto — inclusive o `_dragComplete()`, que é quem devolve o
     * modal que o dnd empilhou no começo do arraste. O sintoma não é um
     * gesto perdido: é o dnd da sessão INTEIRA travado, com um grab de pé
     * que ninguém vai devolver.
     */
    _guard(fn, what) {
        return (...args) => {
            try {
                return fn(...args);
            } catch (e) {
                logError(e, `[ArcDesk] ${what} failed`);
                return undefined;
            }
        };
    }

    /**
     * Mesma ideia, para os verbos que TÊM valor de retorno significativo.
     *
     * O fallback é explícito porque `undefined` não é uma resposta válida
     * para o dnd: um `handleDragOver` que devolvesse undefined pararia a
     * subida pela árvore de actors como se tivesse tratado o evento.
     */
    _dndGuard(fn, what, fallback) {
        try {
            const result = fn();
            return result === undefined ? fallback : result;
        } catch (e) {
            logError(e, `[ArcDesk] ${what} failed`);
            return fallback;
        }
    }
}
