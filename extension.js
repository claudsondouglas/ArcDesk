import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SIZE, DeskTheme, LabelPosition, GridOrigin } from './src/config.js';
import { DeskManager } from './src/deskManager.js';
import { warnIfDingActive } from './src/dingWatcher.js';

// Keys de APARÊNCIA: cada uma reconstrói o conjunto inteiro de superfícies, do
// jeito que a ArcDock reinicia a dock. São baratas de aplicar assim (o usuário
// mexeu num slider, não é caminho quente) e reconstruir evita ter de propagar
// cada mudança por dentro de métricas, slots e ícones — vezes o número de
// monitores, que é justamente onde a propagação incremental erraria.
//
// As três keys de DADOS (`desk-items`, `desk-placements`, `desk-folders`)
// NÃO estão aqui de propósito: quem as observa é o DeskLayout único, através
// do `onExternalChange()` que o DeskManager assina uma vez só, com supressão
// de eco. Um segundo listener neste arquivo brigaria com essa supressão —
// veríamos o eco da nossa própria escrita e reconstruiríamos a grade no meio
// de um arrasto.
const APPEARANCE_KEYS = Object.freeze([
    'icon-size',
    'desk-theme',
    'label-position',
    'grid-origin',
    'grid-bottom-margin',
    'double-click-to-open',
    'hide-in-fullscreen',
    'debug-outline',
]);

export default class ArcDeskExtension extends Extension {
    enable() {
        log('[ArcDesk] enable() entry');
        try {
            this._enabled = true;
            this._signalConnections = [];
            this._manager = null;
            this._settings = this.getSettings();
            this._disableOverview();

            this._createManager();

            for (const key of APPEARANCE_KEYS) {
                this._connectSignal(this._settings, `changed::${key}`, () => {
                    log(`[ArcDesk] ${key} changed`);
                    this._restartManager(`${key}-changed`);
                });
            }

            // `monitors-changed` NÃO é tratado aqui: a contagem de monitores
            // pode mudar, e cada monitor tem a sua própria superfície, então
            // não basta um relayout — é preciso destruir e reconstruir o
            // conjunto todo a partir de `Main.layoutManager.monitors`. Quem
            // sabe disso é o DeskManager, que é dono das superfícies.

            // Um aviso, uma vez só, e a própria dingWatcher desliga a key
            // depois. Em try próprio porque uma notificação que falha não pode
            // derrubar a extensão.
            try {
                warnIfDingActive(this._settings);
            } catch (e) {
                logError(e, '[ArcDesk] warnIfDingActive failed');
            }
        } catch (e) {
            logError(e, '[ArcDesk] enable() failed');
            throw e;
        }
        log('[ArcDesk] enable() exit');
    }

    disable() {
        // `session-modes` é apenas ["user"]: nada a fazer na tela de bloqueio.
        // `global.window_group.visible` é dirigido por
        // `Main.sessionMode.hasWindows && !inOverview`, e toda superfície mora
        // dentro dele — somem sozinhas no lock e no overview. Por isso não há
        // watcher de sessão nem de wake aqui, ao contrário da ArcDock.
        log('[ArcDesk] disable() entry');
        try {
            this._enabled = false;
            this._disconnectSignals();
            this._restoreOverview();
            this._destroyManager();
            this._settings = null;
        } catch (e) {
            logError(e, '[ArcDesk] disable() failed');
        }
        log('[ArcDesk] disable() exit');
    }

    // --- sinais -----------------------------------------------------------

    _connectSignal(obj, signal, handler) {
        if (!obj)
            return;

        try {
            const id = obj.connect(signal, handler);
            this._signalConnections.push({ obj, id });
        } catch (e) {
            logError(e, `[ArcDesk] failed to connect signal ${signal}`);
        }
    }

    _disconnectSignals() {
        for (const { obj, id } of this._signalConnections ?? []) {
            try { obj.disconnect(id); } catch (_) {}
        }
        this._signalConnections = [];
    }

    // --- Visão Geral -----------------------------------------------------

    /**
     * ArcDesk oferece uma área de trabalho permanente, então não deixa o
     * Shell trocar para a Visão Geral. Salva os métodos originais para que
     * desligar a extensão devolva ao GNOME exatamente o seu comportamento
     * padrão. `hide()` não é substituído: Escape e o próprio Shell ainda
     * podem fechar uma transição que já estivesse em andamento.
     */
    _disableOverview() {
        try {
            Main.overview.hide();

            this._overviewMethods = {
                show: Main.overview.show,
                toggle: Main.overview.toggle,
            };
            Main.overview.show = () => {};
            Main.overview.toggle = () => {};
            log('[ArcDesk] overview disabled');
        } catch (e) {
            this._overviewMethods = null;
            logError(e, '[ArcDesk] failed to disable overview');
        }
    }

    _restoreOverview() {
        if (!this._overviewMethods)
            return;

        try {
            Main.overview.show = this._overviewMethods.show;
            Main.overview.toggle = this._overviewMethods.toggle;
            log('[ArcDesk] overview restored');
        } catch (e) {
            logError(e, '[ArcDesk] failed to restore overview');
        }
        this._overviewMethods = null;
    }

    // --- leitura das keys -------------------------------------------------

    /**
     * O `<range>` do gschema já recusa valores absurdos vindos da UI, mas
     * dconf é editável à mão e uma key adulterada não pode pedir um ícone de
     * 10x: a métrica da grade é derivada daqui e um valor gigante zeraria
     * `cols`/`rows` — em todos os monitores de uma vez. Reclampa em JS contra
     * os mesmos limites do config.js.
     */
    _iconSize() {
        const raw = this._settings?.get_int('icon-size') ?? SIZE.ICON;
        const value = Number.isFinite(raw) ? Math.round(raw) : SIZE.ICON;
        return Math.max(SIZE.ICON_MIN, Math.min(SIZE.ICON_MAX, value));
    }

    _theme() {
        return this._settings?.get_string('desk-theme') ?? DeskTheme.DARK;
    }

    _labelPosition() {
        return this._settings?.get_string('label-position') ?? LabelPosition.BELOW;
    }

    _gridOrigin() {
        return this._settings?.get_string('grid-origin') ?? GridOrigin.TOP_LEFT;
    }

    _gridBottomMargin() {
        const raw = this._settings?.get_int('grid-bottom-margin') ??
            SIZE.GRID_BOTTOM_MARGIN;
        const value = Number.isFinite(raw)
            ? Math.round(raw)
            : SIZE.GRID_BOTTOM_MARGIN;
        return Math.max(0, Math.min(SIZE.GRID_BOTTOM_MARGIN_MAX, value));
    }

    _doubleClickToOpen() {
        return this._settings?.get_boolean('double-click-to-open') ?? true;
    }

    _debugOutline() {
        return this._settings?.get_boolean('debug-outline') ?? false;
    }

    // --- gerente ----------------------------------------------------------

    /**
     * Exatamente UM DeskManager no processo. Ele é dono do único DeskLayout
     * (uma segunda instância brigaria com a supressão de eco), de uma
     * DeskSurface por monitor, do FolderPopup único e da arbitragem do grab de
     * teclado. Este arquivo não conhece superfícies, popups nem monitores.
     */
    _createManager() {
        if (!this._enabled || this._manager)
            return;

        this._manager = new DeskManager({
            settings: this._settings,
            iconSize: this._iconSize(),
            theme: this._theme(),
            labelPosition: this._labelPosition(),
            gridOrigin: this._gridOrigin(),
            gridBottomMargin: this._gridBottomMargin(),
            doubleClickToOpen: this._doubleClickToOpen(),
            debugOutline: this._debugOutline(),
        });
        // A construção pós-startup (`Main.layoutManager._startingUp` →
        // 'startup-complete') é responsabilidade das superfícies; não duplicar
        // aqui, senão as grades seriam montadas duas vezes.
        log('[ArcDesk] manager created');
    }

    _destroyManager() {
        try {
            this._manager?.destroy();
        } catch (e) {
            logError(e, '[ArcDesk] manager destroy failed');
        }
        this._manager = null;
    }

    _restartManager(reason) {
        if (!this._enabled)
            return;

        this._destroyManager();
        this._createManager();
        log(`[ArcDesk] manager restarted after ${reason}`);
    }
}
