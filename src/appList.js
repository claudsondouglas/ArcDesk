import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

/**
 * Todos os apps instalados que devem aparecer para o usuário, ordenados
 * A–Z pela locale corrente.
 *
 * A ordem NÃO é a da área de trabalho: o arranjo do usuário vive em
 * `desk-placements` e quem o resolve é DeskLayout.build(). Esta lista é só
 * a fonte de Shell.App que build() recebe injetada — é ela que mantém
 * deskLayout.js livre de Shell e, portanto, utilizável pelo prefs.js.
 *
 * @returns {Shell.App[]}
 */
export function getInstalledApps() {
    const appSystem = Shell.AppSystem.get_default();
    const apps = [];

    for (const appInfo of appSystem.get_installed()) {
        // should_show() cobre NoDisplay, Hidden e OnlyShowIn/NotShowIn de uma
        // vez — é o mesmo critério que o overview do Shell usa.
        if (!appInfo.should_show())
            continue;
        const id = appInfo.get_id();
        if (!id)
            continue;
        // Um .desktop malformado aparece em get_installed() mas não vira
        // Shell.App; sem isso a grade receberia null na lista.
        const app = appSystem.lookup_app(id);
        if (app)
            apps.push(app);
    }

    // Colação de locale, nunca `<`/`>` de string crua: em pt-BR a comparação
    // por code point manda "Álbum" para depois de "Zoom".
    apps.sort((a, b) => GLib.utf8_collate(_name(a), _name(b)));
    return apps;
}

/**
 * Resolve um id de .desktop para o Shell.App correspondente.
 *
 * Devolve null (e não undefined) quando o app não está instalado: é um
 * estado NORMAL e não um erro — uma atualização de pacote faz o .desktop
 * sumir por alguns segundos, e quem chama tem que tratar isso mantendo o
 * item no lugar em vez de apagá-lo.
 *
 * @param {string} appId
 * @returns {Shell.App|null}
 */
export function lookupApp(appId) {
    if (typeof appId !== 'string' || !appId)
        return null;
    return Shell.AppSystem.get_default().lookup_app(appId) ?? null;
}

/** Nome do app como string, nunca null (get_name() pode falhar no .desktop). */
function _name(app) {
    const name = app?.get_name();
    return typeof name === 'string' ? name : '';
}
