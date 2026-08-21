import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

/** Desktop Icons NG — a outra extensão que desenha ícones nesta mesma área. */
const DING_UUID = 'ding@rastersoft.com';
const SETTING = 'warn-about-ding';

/**
 * Avisa UMA vez, e só uma, que o DING está ativo desenhando por cima da
 * mesma área.
 *
 * Os dois pintam ícones sobre o wallpaper e nenhum dos dois sabe do
 * outro: o resultado é ícone em cima de ícone, e o sintoma que o usuário
 * relata é "os ícones do ArcDesk não clicam" — o DING põe o próprio actor
 * de tela cheia na frente e come o pick.
 *
 * O estado vem do `extensionManager` e não de uma checagem de arquivo:
 * `Extension.lookupByUUID(uuid) !== null` NÃO serve, porque o Shell não
 * consegue reimportar um módulo ESM e uma extensão desabilitada-mas-já-
 * habilitada-uma-vez guarda o `stateObj` para sempre. `state === ACTIVE`
 * é a única pergunta que responde "está desenhando agora".
 *
 * Escreve `warn-about-ding = false` logo depois: um aviso que reaparece a
 * cada login vira ruído, e a decisão de conviver com as duas extensões é
 * do usuário. A key volta a true só se ele mesmo a mudar nas preferências.
 *
 * Tudo dentro de um try/catch: isto roda dentro do `enable()` da extensão,
 * e uma exceção aqui derrubaria a habilitação inteira por causa de uma
 * notificação.
 *
 * @param {Gio.Settings|null} settings
 */
export function warnIfDingActive(settings) {
    try {
        if (!settings || !settings.get_boolean(SETTING)) return;
        const ding = Main.extensionManager?.lookup?.(DING_UUID) ?? null;
        if (!ding || ding.state !== ExtensionState.ACTIVE) return;

        Main.notify(
            'ArcDesk',
            'A extensão Desktop Icons (DING) está ativa e desenha ícones ' +
            'sobre a mesma área. Desative-a para evitar sobreposição.'
        );
        // Só depois de notificar: se o Main.notify lançar, o aviso continua
        // pendente para a próxima sessão em vez de se perder em silêncio.
        settings.set_boolean(SETTING, false);
    } catch (e) {
        logError(e, '[ArcDesk] ding check failed');
    }
}
