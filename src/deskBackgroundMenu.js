import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/**
 * Os painéis do Configurações são abertos pelo .desktop, via
 * `addSettingsAction()`, e NÃO por linha de comando.
 *
 * É literalmente o que o `backgroundMenu.js` do Shell faz, e o caminho traz
 * de graça três coisas que um `Gio.Subprocess` não traria: o item some
 * sozinho quando a sessão não permite configurações
 * (`Main.sessionMode.allowSettings`, checado dentro do addSettingsAction);
 * o app é ATIVADO pelo Shell, então uma janela do Configurações já aberta
 * vem para a frente em vez de abrir uma segunda; e o lançamento entra no
 * rastreamento de apps do Shell como qualquer outro.
 */
const PANEL_BACKGROUND = 'gnome-background-panel.desktop';
const PANEL_DISPLAY = 'gnome-display-panel.desktop';
const PANEL_SETTINGS = 'org.gnome.Settings.desktop';

/**
 * Menu do FUNDO da área de trabalho — o botão direito no pixel vazio.
 *
 * ---------------------------------------------------------------------
 * POR QUE ESTA CLASSE EXISTE
 * ---------------------------------------------------------------------
 *
 * O menu de "Alterar plano de fundo…" do GNOME é pendurado pelo
 * `addBackgroundMenu(actor, layoutManager)` de
 * `resource:///org/gnome/shell/ui/backgroundMenu.js` em CADA
 * `Meta.BackgroundActor`. A superfície do ArcDesk fica ACIMA desses actors
 * dentro do `_backgroundGroup` e é `reactive: true` — ou seja, ela engole
 * o botão 3 e o menu do GNOME nunca dispara. Tomamos o pixel do usuário e
 * não devolvemos nada em troca; esta classe é a devolução.
 *
 * ---------------------------------------------------------------------
 * AS MESMAS REGRAS DO DeskIconMenu, PELOS MESMOS MOTIVOS
 * ---------------------------------------------------------------------
 *
 * - O actor do menu mora no `uiGroup` (é lá que o PopupMenuManager empurra
 *   o modal dele, e a superfície fica abaixo de todas as janelas), então
 *   NINGUÉM o destrói junto com a superfície: `destroy()` aqui é
 *   obrigatório.
 * - Construído no PRIMEIRO botão direito, nunca no construtor. A maioria
 *   das sessões nunca abre este menu, e um PopupMenu + manager parados no
 *   uiGroup não são de graça.
 * - Todo handler de item passa por `_guard()`: eles rodam dentro do
 *   `emit('activate')` do PopupBaseMenuItem, cuja continuação AFTER é
 *   justamente o que fecha o menu e devolve o modal. Uma exceção ali
 *   deixa o menu de pé segurando um grab que ninguém vai devolver.
 *
 * A âncora é o `dummyCursor` do LayoutManager, que é o caminho suportado
 * para prender um menu a um PONTO em vez de a um actor — e é o mesmo que o
 * `backgroundMenu.js` usa.
 */
export class DeskBackgroundMenu {
    /**
     * @param {object} params
     * @param {Clutter.Actor} params.sourceActor actor dono do
     *   PopupMenuManager (a superfície); só o manager o usa, a POSIÇÃO vem
     *   do dummyCursor.
     * @param {() => void} params.onOpenPrefs abre as preferências da
     *   extensão (semântica de `Extension.openPreferences()`).
     * @param {() => void} params.onArrangeIcons compacta os ícones DESTE
     *   monitor nas primeiras casas livres.
     * @param {(() => {type: string, name: string}[])|{type: string,
     *   name: string}[]} [params.widgets] tipos de widget que podem ser
     *   adicionados, ou uma função que os devolve na hora de montar o menu.
     * @param {(type: string) => void} [params.onAddWidget]
     * @param {(isOpen: boolean) => void} [params.onStateChanged]
     */
    constructor(params = {}) {
        this._sourceActor = params.sourceActor ?? null;
        this._policy = {
            onOpenPrefs: params.onOpenPrefs ?? null,
            onArrangeIcons: params.onArrangeIcons ?? null,
            // Aceita um array OU uma função. A função é o caminho vivo: o
            // catálogo de widgets é carregado de forma assíncrona e pode
            // estar vazio no instante em que esta classe é construída.
            widgets: typeof params.widgets === 'function'
                ? params.widgets
                : () => (Array.isArray(params.widgets) ? params.widgets : []),
            onAddWidget: params.onAddWidget ?? null,
            onStateChanged: params.onStateChanged ?? null,
        };
        this._menu = null;
        this._menuManager = null;
    }

    get isOpen() {
        return !!this._menu?.isOpen;
    }

    /**
     * Abre o menu no ponto (x, y) em coordenadas de STAGE.
     *
     * @param {number} x
     * @param {number} y
     */
    open(x, y) {
        // NaN não chega ao dummyCursor: `setDummyCursorGeometry` vira um
        // `set_position` num actor de verdade, e set_position(NaN) faz o
        // clutter_actor_allocate abortar por asserção.
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        this._ensureMenu();
        if (!this._menu) return;
        this._guard(() => {
            Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
            this._menu.open(BoxPointer.PopupAnimation.FULL);
        }, 'open');
    }

    close() {
        if (!this._menu?.isOpen) return;
        this._guard(
            () => this._menu.close(BoxPointer.PopupAnimation.NONE),
            'close'
        );
    }

    destroy() {
        // Zerado ANTES do destroy: o `destroy()` do PopupMenu fecha o menu,
        // e o 'open-state-changed' desse fechamento reentraria aqui.
        const menu = this._menu;
        this._menu = null;
        if (menu) {
            try {
                // destroy() do PopupMenu fecha, esvazia, destrói o actor (o
                // que o tira do uiGroup) e emite 'destroy' — que é o que faz
                // o PopupMenuManager devolver o modal, caso este menu ainda
                // fosse o ativo.
                menu.destroy();
            } catch (e) {
                logError(e, '[ArcDesk] background menu destroy failed');
            }
        }
        this._menuManager = null;
        this._sourceActor = null;
        // Só DEPOIS do destroy: o fechamento que ele dispara ainda precisa
        // chegar à superfície pelo `onStateChanged`, senão ela fica achando
        // que existe um menu aberto para sempre e desvia o teclado dela.
        this._policy = {};
    }

    // --- Construção sob demanda ---

    _ensureMenu() {
        if (this._menu) return;
        try {
            this._menuManager = new PopupMenu.PopupMenuManager(
                this._sourceActor ?? Main.layoutManager.dummyCursor
            );
            // Alinhamento 0 e seta em cima: a caixa nasce ABAIXO e à DIREITA
            // do ponto clicado, que é onde um menu de fundo é esperado. O
            // BoxPointer vira sozinho quando não couber.
            this._menu = new PopupMenu.PopupMenu(
                Main.layoutManager.dummyCursor,
                0,
                St.Side.TOP
            );
            // Classe do próprio Shell: é a que o menu de fundo do GNOME usa,
            // e é o que faz o nosso ficar visualmente idêntico ao que o
            // usuário via antes de a superfície tomar o pixel.
            this._menu.actor.add_style_class_name('background-menu');
            Main.layoutManager.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this._menuManager.addMenu(this._menu);

            this._buildItems();

            this._menu.connect('open-state-changed', (_menu, isOpen) =>
                this._guard(
                    () => this._policy.onStateChanged?.(isOpen),
                    'state changed'
                ));
        } catch (e) {
            logError(e, '[ArcDesk] background menu creation failed');
            this._menu = null;
            this._menuManager = null;
        }
    }

    _buildItems() {
        this._menu.addSettingsAction('Alterar plano de fundo…', PANEL_BACKGROUND);
        this._menu.addSettingsAction('Configurações de exibição', PANEL_DISPLAY);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addWidgetsSubmenu();
        this._addItem('Organizar ícones',
            () => this._policy.onArrangeIcons?.(), 'arrange icons');
        this._addItem('Preferências do ArcDesk',
            () => this._policy.onOpenPrefs?.(), 'open prefs');

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._menu.addSettingsAction('Configurações', PANEL_SETTINGS);
    }

    _addWidgetsSubmenu() {
        let widgets = [];
        try {
            widgets = this._policy.widgets?.() ?? [];
        } catch (e) {
            logError(e, '[ArcDesk] widget catalogue read failed');
        }
        if (!widgets.length) return;

        const submenu = new PopupMenu.PopupSubMenuMenuItem('Adicionar widget');
        for (const widget of widgets) {
            const item = new PopupMenu.PopupMenuItem(widget.name);
            item.connect('activate', () => this._guard(
                () => this._policy.onAddWidget?.(widget.type),
                `add ${widget.type} widget`
            ));
            submenu.menu.addMenuItem(item);
        }
        this._menu.addMenuItem(submenu);
    }

    _addItem(label, action, what) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => this._guard(action, what));
        this._menu.addMenuItem(item);
        return item;
    }

    /**
     * Nada nosso pode escapar daqui.
     *
     * Os handlers de item rodam dentro do `emit('activate')` do
     * PopupBaseMenuItem, que o Shell conecta com `ConnectFlags.AFTER` para
     * fechar o menu logo depois. Uma exceção nossa aborta essa continuação
     * e deixa o menu aberto segurando o modal — mesma classe de estrago da
     * lei 1 do dnd, só que a sessão trava no teclado em vez de no arraste.
     */
    _guard(fn, what = 'menu') {
        try {
            fn();
        } catch (e) {
            logError(e, `[ArcDesk] background menu ${what} failed`);
        }
    }
}
