import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { TIMING } from './config.js';

/**
 * O ÚNICO ponto da ArcDesk que depende de uma API que a pesquisa não
 * conseguiu verificar num compositor vivo.
 *
 * O que foi verificado por introspecção (gjs contra Clutter-18 do
 * mutter-18, nesta máquina):
 *
 *   - `Clutter.ClickAction` e `Clutter.TapAction`  -> `undefined`. Foram
 *     REMOVIDOS no GNOME 49. Usá-los é um TypeError na hora.
 *   - `Clutter.Event.prototype.get_click_count`    -> `undefined`. Não
 *     existe no Clutter-18; chamar isso lança.
 *   - `Clutter.PressGesture.prototype`             -> contém
 *     `get_n_presses`, herdado por `ClickGesture`.
 *   - `ClutterGesture` emite `should-handle-sequence`, `may-recognize`,
 *     `recognize`, `end` e `cancel`. `ClickGesture` e `PressGesture` NÃO
 *     acrescentam sinal nenhum, então o caminho é `connect('recognize')`.
 *   - O Shell 50 usa `ClickGesture`/`LongPressGesture` exatamente assim em
 *     ui/backgroundMenu.js e no AppIcon de ui/appDisplay.js, e em NENHUM
 *     lugar do JS dele `get_n_presses()` é chamado.
 *
 * Esse último ponto é o problema inteiro: a função existe na tipagem, mas
 * ninguém no Shell a exercita, então não há prova de que ela devolva 2 num
 * duplo clique real em vez de ficar presa em 1. Daí este arquivo separado
 * e a rede de segurança abaixo — e daí o `console.warn` de uma linha só,
 * que responde a pergunta no journal já na primeira sessão.
 */

/** Qual caminho de detecção está valendo. Nunca uma string solta. */
const ClickPath = Object.freeze({
    N_PRESSES: 'n-presses',
    MANUAL: 'manual',
});

/**
 * Tolerância de deslocamento entre os dois cliques de um par, quando o
 * Clutter não sabe informar a dele. É o mesmo default histórico do
 * `double-click-distance` do GTK/Clutter.
 */
const DEFAULT_DOUBLE_CLICK_DISTANCE = 5;

// Uma linha por sessão, e não uma por ícone: a área de trabalho constrói
// uma célula por item e as reconstrói a cada refresh — logar no attach sem
// esta trava encheria o journal com dezenas de cópias da mesma frase, que
// é o oposto de "o journal responde a pergunta".
let _pathLogged = false;
let _demotionLogged = false;
let _settingsWarned = false;

function _logPathOnce(path, why) {
    if (_pathLogged) return;
    _pathLogged = true;
    console.warn(`[ArcDesk] duplo clique: caminho "${path}" (${why})`);
}

function _logDemotionOnce(why) {
    if (_demotionLogged) return;
    _demotionLogged = true;
    console.warn(
        `[ArcDesk] duplo clique: get_n_presses() não serve neste runtime ` +
        `(${why}); caindo para o caminho "${ClickPath.MANUAL}"`);
}

/**
 * Janela do duplo clique, lida das preferências do usuário.
 *
 * Lida a cada uso e não uma vez no attach: o usuário pode mexer em
 * `double-click-time` no Acessibilidade com a sessão de pé, e um valor
 * congelado no nascimento das células só voltaria a valer no próximo
 * rebuild da grade.
 *
 * O try/catch é obrigatório pelo contrato: `Clutter.Settings.get_default()`
 * é um singleton do contexto do Clutter e a leitura das propriedades passa
 * pela introspecção — se qualquer uma das duas sumir numa versão futura, o
 * que se perde é a preferência do usuário, não o duplo clique.
 */
function _doubleClickWindow() {
    let timeMs = TIMING.DOUBLE_CLICK_FALLBACK_MS;
    let distancePx = DEFAULT_DOUBLE_CLICK_DISTANCE;
    try {
        const settings = Clutter.Settings.get_default();
        const t = settings?.double_click_time;
        if (Number.isFinite(t) && t > 0) timeMs = t;
        const d = settings?.double_click_distance;
        if (Number.isFinite(d) && d > 0) distancePx = d;
    } catch (e) {
        if (!_settingsWarned) {
            _settingsWarned = true;
            logError(e, '[ArcDesk] Clutter.Settings indisponível; usando ' +
                `TIMING.DOUBLE_CLICK_FALLBACK_MS=${TIMING.DOUBLE_CLICK_FALLBACK_MS}`);
        }
    }
    return { timeUs: timeMs * 1000, distancePx };
}

/**
 * Onde o clique caiu, em coordenadas absolutas.
 *
 * A ordem das tentativas foi escolhida a partir do comportamento REAL do
 * Clutter-18, verificado por introspecção nesta máquina, e não do que a
 * assinatura promete:
 *
 *   `gesture.get_coords_abs()` **não lança** quando o gesto não tem ponto
 *   ativo. Ele emite um `clutter_event_get_position: assertion 'event !=
 *   NULL' failed` no journal e devolve o ponto zerado — (0, 0), que é um
 *   número perfeitamente FINITO. Confiar nele às cegas seria o pior dos
 *   mundos: dois cliques em cantos opostos da tela leriam a MESMA
 *   coordenada, fechariam par por distância, e isso não erraria só o duplo
 *   clique — dispararia o rebaixamento de `get_n_presses()` logo abaixo com
 *   um falso positivo, jogando fora o caminho bom por causa de uma leitura
 *   inventada.
 *
 * Por isso o ponto só é lido depois de `get_n_points()` confirmar que existe
 * um, e o `recognize` de um ClickGesture pode muito bem chegar com o dedo já
 * levantado — daí o segundo caminho, o ponteiro do próprio Shell, que é
 * sempre válido e, entre os dois cliques de um duplo, praticamente não se
 * moveu.
 *
 * NaN é a última resposta de propósito: toda comparação de distância contra
 * NaN é falsa, então um clique sem coordenada legível simplesmente não fecha
 * par — vira dois cliques simples, que é a degradação certa.
 */
function _coordsOf(gesture) {
    try {
        if (gesture.get_n_points?.() >= 1) {
            const point = gesture.get_coords_abs?.();
            if (Number.isFinite(point?.x) && Number.isFinite(point?.y))
                return { x: point.x, y: point.y };
        }
    } catch (_) {}
    try {
        const [x, y] = global.get_pointer();
        if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    } catch (_) {}
    return { x: NaN, y: NaN };
}

/**
 * Liga clique simples / duplo / contexto num actor qualquer.
 *
 * @param {Clutter.Actor} actor
 * @param {object} params
 * @param {function} [params.onSingle]     — () => void, clique 1
 * @param {function} [params.onDouble]     — () => void, clique 2
 * @param {function} [params.onSecondary]  — () => void, botão direito ou
 *   toque longo. DIVERGÊNCIA ADITIVA do contrato: ele manda anexar o
 *   `ClickGesture` secundário e o `LongPressGesture` "aqui ou em
 *   deskIcon.js", e anexá-los aqui exige um callback para onde mandá-los.
 *   Omitir o campo simplesmente não cria os dois gestos.
 * @param {function} [params.shouldIgnore] — () => boolean, consultado
 *   ANTES de todo reconhecimento. É por onde o rabo de um arraste é
 *   engolido; um `true` também QUEBRA o par em curso, senão o clique que
 *   sobrou de um arraste emparelharia com o próximo clique de verdade.
 * @returns {function} detach — tira os gestos do actor e zera o estado
 */
export function attachClickOpen(actor, params = {}) {
    const onSingle = params.onSingle ?? null;
    const onDouble = params.onDouble ?? null;
    const onSecondary = params.onSecondary ?? null;
    const shouldIgnore = params.shouldIgnore ?? null;

    const gestures = [];
    let path = ClickPath.N_PRESSES;
    // Último clique que ainda pode virar a primeira metade de um par.
    let lastTimeUs = 0;
    let lastX = NaN;
    let lastY = NaN;

    const breakPair = () => {
        lastTimeUs = 0;
        lastX = NaN;
        lastY = NaN;
    };

    /**
     * Nada nosso escapa para dentro do reconhecimento de um gesto.
     *
     * O `recognize` do ClutterGesture é emitido de dentro do
     * `clutter_gesture_set_state()`, no meio do processamento do evento e
     * com o gesto em transição de estado. Uma exceção nossa subindo por ali
     * é a mesma classe de estrago das leis do dnd: quem fica pelo caminho é
     * a máquina de estados do gesto, e é o compositor inteiro que passa a
     * não reconhecer mais cliques.
     */
    const guard = (fn, what) => {
        try {
            return fn();
        } catch (e) {
            logError(e, `[ArcDesk] ${what} failed`);
            return undefined;
        }
    };

    const ignore = () =>
        guard(() => shouldIgnore?.() === true, 'shouldIgnore') === true;

    const primary = new Clutter.ClickGesture({
        required_button: Clutter.BUTTON_PRIMARY,
    });

    // Sonda de attach: a pergunta barata, respondida antes do primeiro
    // clique. Se o método nem existe, não há o que testar em tempo de
    // execução — já se nasce no caminho manual.
    if (typeof primary.get_n_presses !== 'function') {
        path = ClickPath.MANUAL;
        _logPathOnce(path, 'ClickGesture.get_n_presses não existe neste Clutter');
    } else {
        _logPathOnce(path,
            'ClickGesture.get_n_presses presente; será rebaixado se ficar em 1 num duplo real');
    }

    primary.connect('recognize', () => guard(() => {
        if (ignore()) {
            breakPair();
            return;
        }

        const now = GLib.get_monotonic_time();
        const { x, y } = _coordsOf(primary);
        const win = _doubleClickWindow();
        // O par MANUAL usa os mesmos dois critérios que o Clutter usa
        // internamente (tempo e distância, das preferências do usuário), e
        // não só o tempo: é essa simetria que faz a detecção de rebaixamento
        // logo abaixo não acusar falso positivo em dois cliques deliberados
        // que por acaso caíram perto um do outro no tempo — nesse caso o
        // Clutter TAMBÉM os teria contado como par.
        const pairedByTiming =
            lastTimeUs > 0 &&
            now - lastTimeUs <= win.timeUs &&
            Math.abs(x - lastX) <= win.distancePx &&
            Math.abs(y - lastY) <= win.distancePx;

        let presses = 1;
        if (path === ClickPath.N_PRESSES) {
            try {
                presses = primary.get_n_presses();
            } catch (e) {
                path = ClickPath.MANUAL;
                _logDemotionOnce(`get_n_presses() lançou: ${e.message}`);
                presses = 1;
            }
        }
        // Introspecção pode devolver undefined em vez de lançar quando a
        // assinatura não bate; um NaN aqui viraria "nunca é duplo".
        if (!Number.isFinite(presses)) presses = 1;

        let double = path === ClickPath.N_PRESSES
            ? presses >= 2
            : pairedByTiming;

        // A rede de segurança em execução: o duplo clique REAL aconteceu
        // (o relógio e a distância concordam) mas o contador do gesto ficou
        // em 1. Isso é a prova de que `get_n_presses()` não conta neste
        // runtime — e ela só pode ser colhida no instante em que o defeito
        // aparece, porque a sonda de attach não tem clique nenhum para
        // examinar. A partir daqui a instância inteira vira manual, e este
        // clique já é honrado como duplo: rebaixar e ainda assim perder o
        // duplo que revelou o problema seria pedir ao usuário para clicar
        // duas vezes de novo.
        if (path === ClickPath.N_PRESSES && presses <= 1 && pairedByTiming) {
            path = ClickPath.MANUAL;
            _logDemotionOnce('ficou em 1 num duplo clique real');
            double = true;
        }

        lastX = x;
        lastY = y;
        // Um duplo CONSOME o par: sem isto o terceiro clique de um triplo
        // clique emparelharia com o segundo e abriria o item outra vez.
        lastTimeUs = double ? 0 : now;

        if (double) onDouble?.();
        else onSingle?.();
    }, 'click gesture'));
    actor.add_action(primary);
    gestures.push(primary);

    if (onSecondary) {
        // `recognize_on_press: true` é a convenção do próprio Shell para
        // menu de contexto (ui/backgroundMenu.js e o AppIcon de
        // ui/appDisplay.js fazem exatamente isto): o menu abre no APERTAR,
        // não no soltar, que é o que o usuário espera de um botão direito.
        const secondary = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        secondary.connect('recognize', () => guard(() => {
            if (ignore()) return;
            // Um botão direito no meio de um par quebra o par: o gesto do
            // usuário mudou de assunto, e deixar o relógio de pé faria o
            // próximo clique esquerdo abrir o item sem querer.
            breakPair();
            onSecondary();
        }, 'secondary click gesture'));
        actor.add_action(secondary);
        gestures.push(secondary);

        // Toque longo = botão direito, para quem está num touchscreen. Ele
        // convive com o St.DndStartGesture do makeDraggable porque os dois
        // pedem coisas diferentes do mesmo dedo: o DndStartGesture só
        // reconhece quando há MOVIMENTO depois do limiar de tempo, e o
        // LongPressGesture reconhece pela PARADA. O AppIcon do Shell é
        // arrastável e tem os dois, pelo mesmo motivo.
        const longPress = new Clutter.LongPressGesture({
            required_button: Clutter.BUTTON_PRIMARY,
        });
        longPress.connect('recognize', () => guard(() => {
            if (ignore()) return;
            breakPair();
            onSecondary();
        }, 'long press gesture'));
        actor.add_action(longPress);
        gestures.push(longPress);
    }

    return () => {
        for (const gesture of gestures) {
            // O actor pode já estar destruído (a superfície derruba linhas
            // inteiras e o Clutter desmonta as células por dentro), e
            // remove_action() sobre um actor finalizado lança. O detach é
            // chamado do caminho de limpeza — deixá-lo lançar aí abortaria
            // o resto da limpeza da célula.
            try {
                actor.remove_action(gesture);
            } catch (_) {}
        }
        gestures.length = 0;
        breakPair();
    };
}
