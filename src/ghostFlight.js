import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ANIM } from './config.js';
import { TimeoutTracker } from './trackers.js';

/**
 * O ícone solto voa da mão do usuário até a casa onde vai morar.
 *
 * O arraste termina com o ícone NO AR: o dnd larga o actor no ponto do
 * ponteiro e, sem esta animação, ele simplesmente sumiria dali para
 * reaparecer noutro lugar no quadro seguinte. O voo é o que amarra o gesto
 * ao resultado — o mesmo papel que a animação de minimizar faz entre a
 * janela e o ícone da dock.
 *
 * A superfície REPRESA a remontagem enquanto há alguém no ar: o ícone de
 * verdade nasce no quadro em que o fantasma acaba de pousar, e é essa
 * emenda que faz os dois parecerem o mesmo objeto. Por isso o `onIdle`
 * deste objeto é, do lado da superfície, "pode remontar agora".
 *
 * Extraído do launcher da ArcDock (`_flyGhost` / `_ensureGhostLayer` /
 * `_ghostLayerOrigin` / `_armFlyWatchdog` / `_clearGhosts`) — é um
 * subsistema sem contexto nenhum do dono, então vira classe.
 */
export class GhostFlight {
    /**
     * @param {object} [params]
     * @param {() => void} [params.onIdle] chamado quando o ÚLTIMO fantasma
     *   pousa (ou quando o relógio de segurança o pousa à força). Não é
     *   chamado por `clear()`: lá os fantasmas são mortos, não pousados, e
     *   quem chama `clear()` ou já está remontando por conta própria ou
     *   está desmontando tudo.
     */
    constructor(params = {}) {
        this._onIdle = params.onIdle ?? null;
        this._layer = null;
        this._ghosts = [];
        this._flying = 0;
        this._timeouts = new TimeoutTracker();
        this._watchdogId = 0;
    }

    /** Quantos fantasmas estão no ar neste instante. */
    get flying() {
        return this._flying;
    }

    /**
     * Adota o actor que o dnd carregava e o faz voar até `rect`.
     *
     * Adotar é LITERAL: o dnd destrói o actor de arraste no fim do drop
     * **se ele ainda for filho do uiGroup** (dnd.js), então reparentá-lo
     * para a nossa camada é o que compra a animação. Sem isso não há voo
     * possível — o ícone simplesmente deixa de existir no quadro do drop.
     *
     * A reparentagem preserva o CENTRO visível, e não o canto: o actor
     * pode chegar com a escala que o dnd lhe deu e com pivô em qualquer
     * lugar, e só o centro do retângulo transformado é o mesmo ponto nos
     * dois espaços.
     *
     * @param {Clutter.Actor|null} dragActor actor que o dnd entregou ao
     *   `acceptDrop`
     * @param {{x:number,y:number,width:number,height:number}|null} rect
     *   destino, em coordenadas de stage
     * @param {object} [opts] `duration` (ms), `scale` (fração do tamanho do
     *   destino, para o voo que CAI dentro de outro ícone) e `fade` (some
     *   ao chegar, pelo mesmo motivo)
     * @returns {boolean} houve voo de verdade. Falso significa que nada
     *   está no ar por causa desta chamada — quem chamou não deve esperar
     *   `onIdle` nenhum, e o `flying` continua o que era.
     */
    fly(dragActor, rect, opts = {}) {
        if (!dragActor || !rect) return false;
        const layer = this._ensureLayer();
        if (!layer) return false;

        const scale = dragActor.scale_x || 1;
        const [visualWidth, visualHeight] = dragActor.get_transformed_size();
        const [visualX, visualY] = dragActor.get_transformed_position();
        const width = visualWidth / scale;
        const height = visualHeight / scale;
        const centerX = visualX + visualWidth / 2;
        const centerY = visualY + visualHeight / 2;
        const [layerX, layerY] = this._layerOrigin(layer);

        // Nada de NaN daqui para baixo. `get_transformed_*` devolve NaN
        // sobre um actor sem alocação válida, e um único NaN nesta conta se
        // espalha por tudo: set_position(NaN) faz clutter_actor_allocate
        // abortar por asserção, o actor nunca recebe alocação, e a ease que
        // deveria decrementar o contador no fim pode nunca chegar lá — o
        // que represa a superfície PARA SEMPRE e mata o arraste do resto da
        // sessão. Sem voo é feio; com NaN é fatal.
        const geometry = [
            scale, width, height, centerX, centerY, layerX, layerY,
            rect.x, rect.y, rect.width, rect.height,
        ];
        if (!geometry.every(Number.isFinite) || !(width > 0) || !(height > 0)) {
            console.warn('[ArcDesk] flight geometry not finite; skipping');
            return false;
        }

        try {
            dragActor.get_parent()?.remove_child(dragActor);
            layer.add_child(dragActor);
        } catch (e) {
            logError(e, '[ArcDesk] drag actor adoption failed');
            return false;
        }
        dragActor.set_pivot_point(0.5, 0.5);
        dragActor.set_scale(scale, scale);
        dragActor.set_position(
            Math.round(centerX - layerX - width / 2),
            Math.round(centerY - layerY - height / 2)
        );

        const duration = opts.duration ?? ANIM.FLY_MS;
        const target = (rect.width * (opts.scale ?? 1)) / Math.max(1, width);
        const ghost = { actor: dragActor, done: false };
        this._ghosts.push(ghost);
        this._flying++;
        this._armWatchdog(duration);
        dragActor.remove_all_transitions();
        dragActor.ease({
            x: Math.round(rect.x - layerX + (rect.width - width) / 2),
            y: Math.round(rect.y - layerY + (rect.height - height) / 2),
            scale_x: target,
            scale_y: target,
            opacity: opts.fade ? 0 : 255,
            duration,
            // EASE_OUT_QUAD como toda entrada da extensão: rápido ao sair
            // da mão e assentando na casa, que é o contrário de um ícone
            // que parece ter sido cuspido para o lugar.
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._land(ghost),
        });
        return true;
    }

    /**
     * Mata todo fantasma e ZERA o contador à mão.
     *
     * O zero é aqui, e não só no onComplete de cada voo, porque uma
     * transição REMOVIDA não é uma transição terminada: o 'stopped' dela
     * chega com finished=false e o onComplete nunca roda. Sem este zero a
     * superfície ficaria represada para sempre — a grade nunca mais
     * remontaria, o ícone de origem ficaria escondido e todo drop seguinte
     * seria um gesto sem efeito nenhum ("só funciona da primeira vez").
     *
     * NÃO dispara `onIdle`: nada pousou.
     */
    clear() {
        this._flying = 0;
        this._cancelWatchdog();
        const ghosts = this._ghosts;
        this._ghosts = [];
        for (const ghost of ghosts) this._destroyGhost(ghost);
    }

    destroy() {
        this.clear();
        this._timeouts.removeAll();
        this._watchdogId = 0;
        if (this._layer) {
            try {
                this._layer.destroy();
            } catch (e) {
                logError(e, '[ArcDesk] ghost layer destroy failed');
            }
        }
        this._layer = null;
        this._onIdle = null;
    }

    // --- Interno ---

    /** O fantasma pousou: some com ele e, se foi o último, abre a represa. */
    _land(ghost) {
        if (ghost.done) return;
        ghost.done = true;
        this._flying = Math.max(0, this._flying - 1);
        if (this._flying === 0) this._cancelWatchdog();
        this._ghosts = this._ghosts.filter((other) => other !== ghost);
        this._destroyGhost(ghost);
        // onIdle DEPOIS de o fantasma sumir e só no último: é ele que faz a
        // superfície remontar, e o ícone de verdade nascendo na casa por
        // baixo de um fantasma ainda de pé seria o mesmo ícone duas vezes.
        if (this._flying === 0) this._notifyIdle();
    }

    _destroyGhost(ghost) {
        try {
            ghost.actor?.remove_all_transitions();
            ghost.actor?.destroy();
        } catch (e) {
            logError(e, '[ArcDesk] ghost cleanup failed');
        }
        ghost.actor = null;
    }

    _notifyIdle() {
        const onIdle = this._onIdle;
        if (!onIdle) return;
        try {
            onIdle();
        } catch (e) {
            // O callback é da superfície e roda dentro do onComplete de uma
            // transição do Clutter: uma exceção aqui derrubaria o resto do
            // ciclo de animação do quadro, não só o nosso pedaço.
            logError(e, '[ArcDesk] flight idle callback failed');
        }
    }

    /**
     * Rede de segurança da represa: o voo TEM que acabar.
     *
     * O contador só volta a zero no `onComplete` da ease, e uma transição
     * que nunca completa (actor sem alocação, transição removida por um
     * caminho que não passa por `clear()`, o que for) deixaria a superfície
     * represada para sempre: a grade nunca mais remonta, o ícone de origem
     * fica escondido e todo drop seguinte vira um gesto sem efeito. O
     * sintoma é o arraste "funcionar só na primeira vez".
     *
     * O relógio é a única testemunha independente disso. Ele não é o
     * caminho normal — quando dispara, alguma coisa saiu do trilho e o
     * journal precisa dizer isso —, mas transforma uma quebra permanente
     * num soluço de meio segundo.
     */
    _armWatchdog(duration) {
        this._cancelWatchdog();
        const wait =
            Math.max(0, Math.round(duration)) + ANIM.FLY_WATCHDOG_SLACK_MS;
        this._watchdogId = this._timeouts.add(wait, () => {
            this._watchdogId = 0;
            if (this._flying === 0) return GLib.SOURCE_REMOVE;
            console.warn(
                '[ArcDesk] flight never landed; releasing the surface'
            );
            // Pousa à força quem ficou contado: cada _land() tira um do
            // contador, e o último dispara o onIdle que abre a represa.
            for (const ghost of [...this._ghosts]) this._land(ghost);
            // Cinto e suspensório: um fantasma contado que já não está mais
            // na lista (morto por um caminho torto) não seria pousado pelo
            // laço acima, e o contador tem que zerar de qualquer jeito.
            if (this._flying > 0) {
                this._flying = 0;
                this._notifyIdle();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelWatchdog() {
        if (!this._watchdogId) return;
        this._timeouts.remove(this._watchdogId);
        this._watchdogId = 0;
    }

    /**
     * Camada onde os fantasmas voam: filha do uiGroup, do tamanho da tela
     * inteira, SEMPRE no topo e SEMPRE fora do pick.
     *
     * No uiGroup, e não na superfície: a superfície mora no
     * `_backgroundGroup`, ou seja, DEBAIXO de todas as janelas — um
     * fantasma voando lá seria um ícone invisível atrás do navegador. O
     * actor de arraste também vem do uiGroup, então esta é a camada em que
     * ele já estava.
     *
     * `reactive: false` NÃO basta para tirá-la do caminho. O dnd não acha o
     * alvo de drop por evento: ele chama `get_actor_at_pos(PickMode.ALL, …)`
     * e sobe a árvore procurando um `_delegate`. PickMode.ALL enxerga actor
     * não-reactive — é justamente o que faz uma casa vazia poder receber um
     * drop. Uma camada do tamanho da tela no topo do uiGroup é, para esse
     * pick, uma PAREDE: o pick para nela, o pai dela é o uiGroup (que não
     * tem `_delegate` nenhum), e a superfície inteira fica inerte — nem
     * `handleDragOver`, nem `acceptDrop`.
     *
     * E a parede só sobe no PRIMEIRO voo, que é o que dá a esse bug a cara
     * de "o primeiro drop funciona, o segundo não faz nada": a camada nasce
     * DEPOIS do pick do primeiro drop, e a partir dali come todos os
     * outros.
     */
    _ensureLayer() {
        try {
            if (!this._layer) {
                this._layer = new St.Widget({ reactive: false });
                Shell.util_set_hidden_from_pick(this._layer, true);
                Main.layoutManager.uiGroup.add_child(this._layer);
            }
            // Posição e tamanho explícitos: o uiGroup é de layout fixo, e
            // uma camada sem geometria própria teria a alocação decidida
            // pelos filhos — justamente o que a conta de coordenadas do voo
            // não pode ter se mexendo por baixo dela.
            this._layer.set_position(0, 0);
            this._layer.set_size(
                global.screen_width || global.stage.width,
                global.screen_height || global.stage.height
            );
            // A cada voo, e não só na criação: chrome (a dock, o painel de
            // pasta) se joga para cima o tempo todo, e um fantasma por
            // baixo atravessaria a tela por TRÁS dela — justo no fim do
            // percurso, que é onde ele precisa ser visto.
            this._layer.get_parent()?.set_child_above_sibling(this._layer, null);
            return this._layer;
        } catch (e) {
            logError(e, '[ArcDesk] ghost layer failed');
            return null;
        }
    }

    /**
     * Canto superior esquerdo da camada, em coordenadas de stage.
     *
     * Pelo PAI quando a leitura direta não serve: a camada é criada e usada
     * no mesmo instante (o primeiro voo da sessão), e um actor que ainda
     * não passou por um ciclo de alocação não tem transformação válida —
     * `get_transformed_position()` ali devolve NaN. O uiGroup está alocado
     * desde que a sessão subiu, e a camada mora em (0, 0) dentro dele,
     * então a soma é exata e não depende de alocação nenhuma.
     */
    _layerOrigin(layer) {
        const [x, y] = layer.get_transformed_position();
        if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
        const parent = layer.get_parent();
        if (!parent) return [0, 0];
        const [parentX, parentY] = parent.get_transformed_position();
        if (!Number.isFinite(parentX) || !Number.isFinite(parentY))
            return [0, 0];
        return [parentX + layer.x, parentY + layer.y];
    }
}
