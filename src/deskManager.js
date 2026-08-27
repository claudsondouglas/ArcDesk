import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DeskTheme, GridOrigin, LabelPosition, SIZE } from './config.js';
import { getInstalledApps } from './appList.js';
import { DeskLayout } from './deskLayout.js';
import { DeskSurface } from './deskSurface.js';
import { FolderPopup } from './folderPopup.js';
import { FullscreenWatcher } from './fullscreenWatcher.js';
import { SignalTracker } from './trackers.js';
import { WidgetStore } from './widgetStore.js';
import { loadWidgets, widgetConstraints } from './widgetRegistry.js';

/** UUID da própria extensão, usado só para abrir as preferências. */
const UUID = 'ArcDesk@claudson';

/**
 * Espelha a constante `SETTING` do fullscreenWatcher.js.
 *
 * O watcher é dono da key e das transições do monitor PRIMÁRIO; o gerente
 * precisa do valor cru para decidir, monitor a monitor, quem para de
 * pintar (ver _applyFullscreen).
 */
const KEY_HIDE_IN_FULLSCREEN = 'hide-in-fullscreen';

const FOLDER_POPUP = Object.freeze({
    // Teto de colunas do painel de pasta. O painel ainda reduz sozinho
    // quando a área útil não comporta essa largura.
    MAX_COLUMNS: 4,
});

/**
 * UMA grade por monitor, e um dono para todas elas.
 *
 * ---------------------------------------------------------------------
 * O QUE ESTA CLASSE POSSUI, E POR QUÊ CADA COISA É ÚNICA
 * ---------------------------------------------------------------------
 *
 * - **Um `DeskLayout` para o processo inteiro.** Ele suprime o eco das
 *   próprias escritas nas três keys; uma segunda instância veria a escrita
 *   da primeira como mudança EXTERNA e remontaria a grade no meio de um
 *   arraste. Por isso o modelo é injetado nas superfícies, e nenhuma delas
 *   constrói o seu.
 * - **Uma assinatura de `onExternalChange()`.** Com N superfícies, N
 *   assinaturas dariam N remontagens por mudança.
 * - **Um `FolderPopup`.** Ele é chrome e só uma pasta fica aberta por vez.
 *   Nasce na PRIMEIRA abertura, nunca no construtor: a maioria das sessões
 *   nunca abre uma pasta, e um painel do tamanho do monitor parado no
 *   uiGroup não é de graça.
 * - **Nenhum grab modal para seleção.** Cada superfície toma apenas foco de
 *   teclado normal; assim Escape/Enter/Menu funcionam sem capturar o
 *   ponteiro da sessão.
 * - **A lista de apps instalados e a construção do modelo.** `build()`
 *   precisa das grades de TODOS os monitores de uma vez (é assim que ele
 *   sabe clampear cada item dentro do monitor certo), então quem a chama
 *   tem que enxergar todas as superfícies — e isso é aqui.
 */
export class DeskManager {
    /**
     * @param {object} params os mesmos parâmetros de aparência da
     *   DeskSurface, MENOS `monitorIndex` (é o gerente que os distribui).
     * @param {Gio.Settings} params.settings
     * @param {number}  params.iconSize
     * @param {string}  params.theme          DeskTheme
     * @param {string}  params.labelPosition  LabelPosition
     * @param {string}  params.gridOrigin     GridOrigin
     * @param {boolean} params.doubleClickToOpen
     * @param {function} [params.onOpenPrefs] sobrepõe o caminho padrão de
     *   abrir as preferências (usado pelos testes).
     */
    constructor(params = {}) {
        this._settings = params.settings ?? null;
        // Reclampeado apesar de a extensão já clampear: uma key adulterada
        // não pode pedir um ícone de 10x e comer a tela inteira.
        this._iconSize = Math.max(
            SIZE.ICON_MIN,
            Math.min(SIZE.ICON_MAX, Math.round(params.iconSize ?? SIZE.ICON))
        );
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
        this._onOpenPrefs =
            typeof params.onOpenPrefs === 'function' ? params.onOpenPrefs : null;

        this._signals = new SignalTracker();
        this._layout = new DeskLayout(this._settings);
        this._destroyed = false;
        // As restrições vêm do CATÁLOGO VIVO, não de uma cópia: o store é
        // construído agora e `loadWidgets()` só resolve daqui a alguns
        // frames. Até lá `widgetConstraints` responde null para tudo, o que
        // faz o store apenas normalizar números e preservar cada registro
        // exatamente como está.
        this._widgetStore = new WidgetStore(this._settings, {
            constraints: widgetConstraints,
        });
        this._unsubscribeWidgets = this._widgetStore.onExternalChange(() =>
            this._safe(() => this.refreshWidgets(), 'external widget change'));
        this._unsubscribe = null;
        this._apps = getInstalledApps();

        /** @type {Map<number, DeskSurface>} */
        this._surfaces = new Map();
        // Transferências de widget são concluídas dentro de
        // button-release-event. A reconciliação global espera um idle para
        // não destruir o host de origem enquanto o Clutter ainda o usa.
        this._widgetRefreshId = 0;

        this._popup = null;
        // Superfície que abriu a pasta: é a fábrica de células do painel e o
        // dono das métricas com que ele foi montado.
        this._popupSurface = null;
        this._popupCell = null;
        // O `open()` do painel fecha o anterior antes de abrir o novo, e
        // esse fecho passa pelo `onClosed`. Sem este guarda, a superfície
        // dona seria zerada no meio da própria abertura que a definiu.
        this._openingFolder = false;

        this._fullscreen = null;

        this._createSurfaces();

        // O catálogo de widgets é lido do disco de forma assíncrona: varrer
        // os manifests é I/O — que dentro da shell nunca é síncrono — e o
        // `import()` de um módulo ESM devolve uma Promise por definição da
        // linguagem. Enquanto não resolve, as grades são montadas normalmente
        // e nenhum widget é desenhado; os registros ficam intactos.
        //
        // Quando resolve, o store revalida COM as restrições dos manifests
        // (é aí que uma pegada fixa volta a ser fixa) e todas as telas
        // reconciliam de uma vez — pela mesma razão de sempre: N superfícies
        // reagindo por conta própria seriam N reconstruções por evento.
        loadWidgets()
            .then(() => {
                if (this._destroyed) return;
                this._safe(() => {
                    this._widgetStore?.reload();
                    this.refreshWidgets();
                }, 'widget catalogue ready');
            })
            .catch(e => logError(e, '[ArcDesk] widget catalogue failed to load'));

        // A contagem de monitores pode mudar, então não basta um relayout:
        // o conjunto inteiro é destruído e reconstruído a partir do array
        // corrente.
        this._signals.connect(Main.layoutManager, 'monitors-changed', () =>
            this._safe(() => this._rebuildSurfaces(), 'monitors-changed'));

        // App instalado ou removido. A lista é do gerente porque é ele quem
        // chama `build()`; um `installed-changed` por superfície daria N
        // varreduras do AppSystem por evento.
        this._signals.connect(Shell.AppSystem.get_default(), 'installed-changed', () =>
            this._safe(() => {
                this._apps = getInstalledApps();
                this.refreshAll();
            }, 'installed-changed'));

        // Escritas EXTERNAS às três keys: o prefs.js roda noutro processo e
        // a ArcDock acrescenta ids em `desk-items` a partir de um menu dela.
        // As nossas próprias escritas são suprimidas dentro do DeskLayout —
        // sem isso o build() bateria de volta na remontagem que o produziu.
        this._unsubscribe = this._layout.onExternalChange(() =>
            this._safe(() => {
                this._layout.reload();
                this.refreshAll();
            }, 'external change'));

        if (this._settings) {
            // O watcher é o dono da key `hide-in-fullscreen` e das
            // transições do monitor PRIMÁRIO. Ele não sabe falar dos
            // outros monitores, e por isso o gerente escuta também o
            // 'in-fullscreen-changed' cru: o que decide quem para de pintar
            // é o fullscreen DAQUELE monitor, não o do primário. Os dois
            // gatilhos caem no mesmo _applyFullscreen(), que é idempotente.
            this._fullscreen = new FullscreenWatcher(this._settings, () =>
                this._safe(() => this._applyFullscreen(), 'fullscreen'));
            this._signals.connect(global.display, 'in-fullscreen-changed', () =>
                this._safe(() => this._applyFullscreen(), 'in-fullscreen-changed'));
            this._signals.connect(
                this._settings,
                `changed::${KEY_HIDE_IN_FULLSCREEN}`,
                () => this._safe(() => this._applyFullscreen(), 'hide-in-fullscreen')
            );
            this._applyFullscreen();
        }
    }

    // --- API pública ---

    get layout() {
        return this._layout;
    }

    /** @returns {DeskSurface|null} */
    surfaceFor(monitorIndex) {
        return this._surfaces.get(monitorIndex) ?? null;
    }

    /**
     * Remonta TODAS as grades a partir do modelo.
     *
     * Passa pelo `scheduleRefresh()` de cada superfície, e não pelo
     * `refresh()`: a remontagem inline destrói a grade — e, num drop, os
     * actors que o dnd ainda tem na mão. Cada superfície tem a sua própria
     * represa (um fantasma no ar segura a remontagem dela até pousar), e
     * agendar é o único jeito de respeitar as N represas de uma vez.
     */
    refreshAll() {
        for (const surface of this._surfaces.values())
            this._safe(() => surface.scheduleRefresh(), 'refresh surface');
    }

    relayoutAll() {
        for (const surface of this._surfaces.values())
            this._safe(() => surface.relayout(), 'relayout surface');
    }

    refreshWidgets() {
        for (const surface of this._surfaces.values())
            this._safe(() => surface.refreshWidgets(), 'refresh widgets');
    }

    destroy() {
        // A Promise de `loadWidgets()` pode estar em voo. Ela não é
        // cancelável de forma útil (o `import()` já foi emitido), então o que
        // se cancela é o EFEITO dela — a continuação checa esta bandeira
        // antes de tocar em store ou superfície.
        this._destroyed = true;
        // PRIMEIRA linha, antes de qualquer coisa que possa lançar: um grab
        // que sobrevive ao destroy deixa a sessão sem teclado e sem
        // ponteiro, e não há recuperação sem um TTY.
        this._safe(() => this._signals.disconnectAll(), 'disconnect');
        this._safe(() => this._unsubscribe?.(), 'unsubscribe');
        this._unsubscribe = null;
        this._safe(() => this._unsubscribeWidgets?.(), 'widget unsubscribe');
        this._unsubscribeWidgets = null;
        this._safe(() => this._fullscreen?.destroy(), 'fullscreen destroy');
        this._fullscreen = null;
        this._safe(() => this._cancelWidgetRefresh(), 'widget refresh cancel');
        // O painel antes das superfícies: as células dele foram criadas por
        // uma superfície, e destruí-las depois de a dona morrer seria mexer
        // em política de dnd já zerada.
        this._destroyPopup();
        this._destroySurfaces();
        this._safe(() => this._layout?.destroy(), 'layout destroy');
        this._layout = null;
        this._safe(() => this._widgetStore?.destroy(), 'widget store destroy');
        this._widgetStore = null;
        // O catálogo de widgets NÃO é esvaziado aqui, de propósito: toda
        // mudança de aparência destrói e reconstrói este gerente, e recarregar
        // faria os widgets piscarem a cada arrastada de slider. Ele também não
        // segura nada que o cache de módulos do GJS já não segurasse.
        this._apps = [];
        this._settings = null;
        // De novo, e de propósito: qualquer passo acima poderia, em teoria,
        // ter reentrado por um sinal e retomado o grab. Devolver duas vezes
        // não custa nada; deixar um de pé custa a sessão.
    }

    // --- Superfícies ---

    _createSurfaces() {
        const monitors = Main.layoutManager.monitors ?? [];
        for (let index = 0; index < monitors.length; index++) {
            // O índice do ARRAY é a identidade do monitor em todo o Shell:
            // é o que `MonitorConstraint({index})` e
            // `getWorkAreaForMonitor()` esperam, e é o que o modelo guarda
            // como `mon`.
            const surface = this._safe(
                () => this._createSurface(index),
                'surface creation'
            );
            if (surface) this._surfaces.set(index, surface);
        }
        log(`[ArcDesk] ${this._surfaces.size} surface(s) for ` +
            `${monitors.length} monitor(s), primary=` +
            `${Main.layoutManager.primaryIndex}`);
        // Uma passada de correção depois que TODAS existem, SEMPRE.
        //
        // Cada superfície monta a grade dela dentro do próprio construtor, e
        // nesse instante ela ainda não está neste mapa — nem ela, nem as
        // irmãs que vierem depois. Como `build()` só sabe respeitar o `mon`
        // dos monitores cuja grade enxerga (e com o mapa vazio não atribui
        // slot nenhum, de propósito), essa primeira montagem é sempre
        // provisória. Agendar uma remontagem aqui é o que a torna
        // definitiva, um idle depois.
        //
        // Durante o startup nada disso chega a acontecer: as montagens
        // esperam o 'startup-complete' e a essa altura o mapa já está
        // completo — mas a passada extra é inofensiva (build() só grava
        // quando algo mudou de fato).
        this.refreshAll();
    }

    _createSurface(monitorIndex) {
        return new DeskSurface({
            settings: this._settings,
            layout: this._layout,
            monitorIndex,
            iconSize: this._iconSize,
            theme: this._theme,
            labelPosition: this._labelPosition,
            gridOrigin: this._gridOrigin,
            doubleClickToOpen: this._doubleClickToOpen,
            debugOutline: this._debugOutline,
            gridBottomMargin: this._gridBottomMargin,
            buildEntries: () => this._buildEntries(),
            onOpenFolder: (entry, anchor) =>
                this._safe(() => this._openFolder(monitorIndex, entry, anchor),
                    'open folder'),
            onCloseFolder: () =>
                this._safe(() => this._popup?.close(), 'close folder'),
            onFolderDragMode: (active) =>
                this._safe(() => this._popup?.setDragMode(active), 'folder drag mode'),
            onDropOnOther: (source, dragActor) =>
                this._onDropOnOther(monitorIndex, source, dragActor),
            onDragOverHere: () =>
                this._safe(() => this._onDragOverHere(monitorIndex),
                    'drag over here'),
            onRefreshAll: () => this.refreshAll(),
            onMoveWidget: (id, destinationIndex, stageRect) =>
                this._moveWidgetToMonitor(id, destinationIndex, stageRect),
            onOpenPrefs: () => this._openPrefs(),
            widgetStore: this._widgetStore,
            primaryMonitor: monitorIndex === Main.layoutManager.primaryIndex,
        });
    }

    _destroySurfaces() {
        for (const surface of this._surfaces.values())
            this._safe(() => surface.destroy(), 'surface destroy');
        this._surfaces.clear();
    }

    _rebuildSurfaces() {
        // O grab morre com a geometria: o actor que o segurava está prestes
        // a ser destruído.
        // O painel é reconstruído na próxima abertura. Ele é ancorado numa
        // célula que vai deixar de existir, e as métricas de célula podem
        // mudar junto com o monitor.
        this._destroyPopup();
        this._destroySurfaces();
        this._createSurfaces();
        this._applyFullscreen();
    }

    /**
     * Constrói o modelo contra as grades de TODOS os monitores vivos.
     *
     * É por isso que a construção mora no gerente e não na superfície: um
     * `build()` que só enxergasse a própria grade trataria os itens dos
     * outros monitores como fora de alcance e os jogaria no primário.
     */
    _buildEntries() {
        if (!this._layout) return [];
        const grids = new Map();
        for (const [index, surface] of this._surfaces) {
            const grid = surface?.gridSize;
            if (grid) grids.set(index, grid);
        }
        return this._layout.build(
            this._apps,
            grids,
            Main.layoutManager.primaryIndex
        ) ?? [];
    }

    // --- Arraste entre monitores ---

    /**
     * Uma superfície aceitou o drop de um item que NÃO é dela.
     *
     * Chamado ANTES da mutação, e por isso serve de porta: `false` aqui
     * significa "o gerente recusou" e a superfície trata o drop como
     * recusado (a arte volta voando para a origem).
     *
     * O `refreshAll()` daqui não corre risco de chegar cedo demais: ele
     * AGENDA a remontagem de cada superfície para o próximo idle, e a
     * mutação que vem logo depois acontece de forma síncrona, dentro do
     * mesmo retorno do acceptDrop.
     *
     * @returns {boolean}
     */
    _onDropOnOther(monitorIndex, source, _dragActor) {
        try {
            if (!this._surfaces.has(monitorIndex)) return false;
            // A superfície de ORIGEM é quem decide, no drag-end dela, entre
            // devolver o painel de pasta e fechá-lo de vez — e ela não tem
            // como saber que o modelo mudou, porque quem mexeu nele foi a
            // superfície do outro monitor. Só a que tiver um arraste vivo
            // reage; nas outras isto é um no-op.
            for (const surface of this._surfaces.values())
                this._safe(() => surface.noteDragChanged(), 'note drag changed');
            this.refreshAll();
            return true;
        } catch (e) {
            logError(e, '[ArcDesk] cross-monitor drop failed');
            return false;
        }
    }

    /**
     * O ponteiro de um arraste atravessou para a superfície `monitorIndex`.
     *
     * Só a superfície de ORIGEM reage (é a única com arraste vivo), e o que
     * ela faz é voltar a acender apenas o buraco da casa de origem: ela
     * deixou de receber `handleDragOver` — não existe `handleDragOut` — e
     * ficaria com um ALVO aceso prometendo um lugar que o drop não vai
     * usar. Repetido a cada movimento do ponteiro, e barato: o
     * `_paintSlot()` da superfície ignora repetição.
     */
    _onDragOverHere(monitorIndex) {
        for (const [index, surface] of this._surfaces) {
            if (index === monitorIndex) continue;
            this._safe(() => surface.showOriginHole(), 'show origin hole');
        }
    }

    /**
     * Encaminha uma transferência de widget à superfície de destino.
     *
     * A superfície valida snap e ocupação e persiste o novo monitor. Só
     * depois disso a remontagem de todos os hosts é agendada para um idle,
     * fora do `button-release-event` do host de origem.
     *
     * @returns {boolean}
     */
    _moveWidgetToMonitor(id, monitorIndex, stageRect) {
        try {
            const destination = this._surfaces.get(monitorIndex);
            if (!destination?.moveWidgetHere(id, stageRect)) return false;
            this._scheduleWidgetRefresh();
            return true;
        } catch (e) {
            logError(e, '[ArcDesk] cross-monitor widget move failed');
            return false;
        }
    }

    /** Agenda uma única reconciliação de widgets para todas as telas. */
    _scheduleWidgetRefresh() {
        if (this._widgetRefreshId) return;
        this._widgetRefreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._widgetRefreshId = 0;
            if (!this._widgetStore) return GLib.SOURCE_REMOVE;
            this.refreshWidgets();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelWidgetRefresh() {
        if (!this._widgetRefreshId) return;
        GLib.source_remove(this._widgetRefreshId);
        this._widgetRefreshId = 0;
    }

    // --- Painel de pasta ---

    /**
     * Abre a pasta que a superfície `monitorIndex` pediu.
     *
     * ---------------------------------------------------------------------
     * O MonitorConstraint DO PAINEL NÃO É MEXIDO — de propósito.
     * ---------------------------------------------------------------------
     *
     * A raiz do FolderPopup tem `MonitorConstraint({primary: true})` e, à
     * primeira vista, ela deveria seguir o monitor de quem abriu. NÃO
     * deve, e mexer nela QUEBRARIA o painel:
     *
     * - Tudo que o painel posiciona passa por `_rootOrigin()`, que devolve
     *   a origem de `Main.layoutManager.primaryMonitor` — um valor fixo, e
     *   não a posição alocada do actor. `anchor` e `bounds` chegam em
     *   coordenadas de STAGE e são convertidos descontando essa origem.
     *   Apontar o constraint para outro monitor moveria a raiz sem mover a
     *   origem usada na conta: o painel inteiro sairia deslocado pela
     *   distância entre os dois monitores.
     * - O Clutter não recorta filhos na alocação do pai
     *   (`clip_to_allocation` é false por padrão), então um painel
     *   posicionado fora do retângulo da raiz é desenhado e é encontrado
     *   pelo pick normalmente. É exatamente por isso que o painel já
     *   funciona em qualquer monitor sem uma linha de código nova.
     * - No GNOME 50 o `_updateRegions()` do LayoutManager só calcula
     *   STRUTS (a região de input do stage sumiu com o X11), e o painel
     *   declara `affectsStruts: false`. Não há nada dependendo da alocação
     *   da raiz.
     *
     * O único efeito residual é o `trackFullscreen: true` do addChrome, que
     * resolve o monitor do painel pela alocação da raiz: o painel some
     * quando o PRIMÁRIO entra em tela cheia, mesmo que a pasta esteja no
     * outro monitor. É um detalhe cosmético num caso raro, e o preço de
     * consertá-lo seria mexer no folderPopup.js.
     */
    _openFolder(monitorIndex, entry, anchor) {
        const surface = this._surfaces.get(monitorIndex);
        if (!surface || !entry || !anchor) return;
        const metrics = surface.metrics;
        if (!metrics) return;

        const popup = this._ensurePopup(metrics);
        if (!popup) return;

        // Definida ANTES do open(): a fábrica de células (`createIcon`) é
        // chamada de dentro dele, e ela precisa saber de quem são as
        // políticas de dnd e de menu que as células vão receber.
        this._popupSurface = surface;
        this._openingFolder = true;
        try {
            popup.open(entry, anchor, metrics.bounds);
        } finally {
            this._openingFolder = false;
        }
    }

    _ensurePopup(metrics) {
        // Métrica de célula diferente da que montou o painel (outro monitor
        // com outro scale factor): ele não tem como ser reconfigurado no
        // lugar, e reaproveitá-lo daria células do tamanho errado.
        if (this._popup &&
            (this._popupCell?.width !== metrics.cellWidth ||
             this._popupCell?.height !== metrics.cellHeight))
            this._destroyPopup();
        if (this._popup) return this._popup;

        this._popup = this._safe(() => new FolderPopup({
            createIcon: (appEntry) =>
                this._popupSurface?.createFolderIcon(appEntry) ?? null,
            cellWidth: metrics.cellWidth,
            cellHeight: metrics.cellHeight,
            columns: Math.max(
                1,
                Math.min(FOLDER_POPUP.MAX_COLUMNS, metrics.cols)
            ),
            theme: this._theme,
            onRename: (folderId, name) =>
                this._safe(() => {
                    if (this._layout?.renameFolder(folderId, name))
                        this.refreshAll();
                }, 'folder rename'),
            onClosed: () =>
                this._safe(() => {
                    if (!this._openingFolder) this._popupSurface = null;
                }, 'folder closed'),
        }), 'folder popup creation') ?? null;
        this._popupCell = this._popup
            ? { width: metrics.cellWidth, height: metrics.cellHeight }
            : null;
        return this._popup;
    }

    _destroyPopup() {
        const popup = this._popup;
        this._popup = null;
        this._popupCell = null;
        this._popupSurface = null;
        if (!popup) return;
        this._safe(() => popup.destroy(), 'folder popup destroy');
    }

    // --- Tela cheia, monitor a monitor ---

    _applyFullscreen() {
        const hide =
            this._settings?.get_boolean(KEY_HIDE_IN_FULLSCREEN) === true;
        for (const [index, surface] of this._surfaces) {
            let full = false;
            if (hide) {
                try {
                    full = global.display.get_monitor_in_fullscreen(index);
                } catch (_) {
                    full = false;
                }
            }
            this._safe(() => surface.setVisible(!full), 'surface visibility');
        }
    }

    // --- Preferências ---

    /**
     * `Extension.lookupByUUID(...).openPreferences()` e não um
     * `gnome-extensions prefs` de linha de comando: é o mesmo caminho que o
     * botão de preferências do app Extensões usa, ele reaproveita uma
     * janela já aberta e não depende de nenhum binário estar no PATH.
     */
    _openPrefs() {
        if (this._onOpenPrefs) {
            this._safe(() => this._onOpenPrefs(), 'open prefs');
            return;
        }
        this._safe(() => {
            Extension.lookupByUUID(UUID)?.openPreferences();
        }, 'open prefs');
    }

    // --- Guarda ---

    /**
     * Nada nosso pode escapar para dentro de um `emit` do Shell.
     *
     * Vale a mesma lei 1 do dnd: os callbacks daqui são chamados de dentro
     * de handlers de sinal e de continuações do dnd, e uma exceção que suba
     * por lá aborta o resto do gesto — inclusive o `_dragComplete()`, que é
     * quem devolve o modal que o dnd empilhou.
     */
    _safe(fn, what) {
        try {
            return fn();
        } catch (e) {
            logError(e, `[ArcDesk] ${what} failed`);
            return undefined;
        }
    }
}
