import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/** Menu de contexto de um widget da area de trabalho. */
export class WidgetMenu {
    constructor(params = {}) {
        this._onRemove = params.onRemove ?? null;
        this._onStateChanged = params.onStateChanged ?? null;

        const sourceActor = params.sourceActor ?? null;
        this._manager = new PopupMenu.PopupMenuManager(sourceActor);
        this._menu = new PopupMenu.PopupMenu(sourceActor, 0.5, St.Side.TOP);
        this._menu.actor.hide();
        this._manager.addMenu(this._menu);
        Main.layoutManager.uiGroup.add_child(this._menu.actor);

        if (params.widgetType === 'image' && params.onChangeImage) {
            const changeItem = new PopupMenu.PopupMenuItem('Mudar imagem…');
            changeItem.connect('activate', () =>
                this._guard(() => params.onChangeImage()));
            this._menu.addMenuItem(changeItem);
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const removeItem = new PopupMenu.PopupMenuItem('Remover widget');
        removeItem.connect('activate', () => this._guard(() => this._onRemove?.()));
        this._menu.addMenuItem(removeItem);
        this._menu.connect('open-state-changed', (_menu, isOpen) =>
            this._guard(() => this._onStateChanged?.(isOpen)));
    }

    get isOpen() {
        return !!this._menu?.isOpen;
    }

    toggle() {
        this._menu?.toggle();
    }

    close() {
        if (this._menu?.isOpen)
            this._menu.close(BoxPointer.PopupAnimation.NONE);
    }

    destroy() {
        const menu = this._menu;
        this._menu = null;
        if (menu) {
            try { menu.destroy(); } catch (e) {
                logError(e, '[ArcDesk] widget menu destroy failed');
            }
        }
        this._manager = null;
        this._onRemove = null;
        this._onStateChanged = null;
    }

    _guard(action) {
        try { action(); } catch (e) {
            logError(e, '[ArcDesk] widget menu action failed');
        }
    }
}
