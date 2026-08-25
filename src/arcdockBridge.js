import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const ARCDOCK_UUID = 'ArcDock@claudson';

/**
 * Avisa o ArcDock de que um app foi ativado pela área de trabalho.
 *
 * Nada é cacheado: o gerenciador pode destruir e recriar uma extensão
 * durante um rebase, deixando o objeto antigo vivo no cache ESM mas inativo.
 * O contrato cruza a fronteira só com strings; a ArcDesk não conhece nem
 * disputa a fila assíncrona ou o SQLite que pertencem ao ArcDock.
 *
 * @param {Shell.App|null} app
 * @returns {boolean} true quando o ArcDock aceitou o evento
 */
export function notifyArcDockAppClick(app) {
    try {
        if (Main.extensionManager?.lookup(ARCDOCK_UUID)?.state !==
            ExtensionState.ACTIVE)
            return false;

        const appId = app?.get_id?.() ?? '';
        if (!appId)
            return false;

        const arcDock = Extension.lookupByUUID(ARCDOCK_UUID);
        if (typeof arcDock?.recordExternalAppClick !== 'function')
            return false;

        return arcDock.recordExternalAppClick(
            appId,
            app.get_name?.() ?? '',
            'arcdesk'
        ) === true;
    } catch (e) {
        logError(e, '[ArcDesk] notificação de clique ao ArcDock falhou');
        return false;
    }
}
