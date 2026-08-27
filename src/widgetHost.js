import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Cursor from './cursor.js';
import { SignalTracker } from './trackers.js';
import { widgetDefinition } from './widgetRegistry.js';
import { WidgetMenu } from './widgetMenu.js';

const MODE = Object.freeze({ MOVE: 'move', RESIZE: 'resize' });
const DRAG_THRESHOLD = 6;
const RESIZE_EDGE_PX = 14;

/**
 * Geometria entregue ao fim de um gesto.
 *
 * As quatro primeiras medidas continuam em coordenadas lógicas locais da
 * superfície de origem. `releasePoint` e `stageRect` são físicos e vivem no
 * stage, para que outra superfície possa receber um movimento sem depender
 * da origem ou do scale factor dela.
 *
 * @typedef {object} WidgetGeometryChange
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {'move'|'resize'} mode
 * @property {{x: number, y: number}} releasePoint
 * @property {{x: number, y: number, width: number, height: number}} stageRect
 */

export class WidgetHost {
    /**
     * @param {object} params
     * @param {object} params.record
     * @param {number} [params.scale]
     * @param {(geometry: WidgetGeometryChange) => void} [params.onGeometry]
     */
    constructor(params = {}) {
        this._record = params.record;
        this._scale = Math.max(1, params.scale ?? 1);
        this._onGeometry = params.onGeometry ?? null;
        this._onRemove = params.onRemove ?? null;
        this._onChooseFile = params.onChooseFile ?? null;
        this._beforeOpenMenu = params.beforeOpenMenu ?? null;
        this._onMenuStateChanged = params.onMenuStateChanged ?? null;
        this._signals = new SignalTracker();
        this._gestureSignals = new SignalTracker();
        this._gesture = null;
        this._menu = null;

        const definition = widgetDefinition(this._record?.type);
        if (!definition) throw new Error(`Unknown widget type: ${this._record?.type}`);
        this._definition = definition;
        this._content = definition.create({config: this._record.config});
        // A classe extra vem do manifest do pacote. O host NÃO conhece — nem
        // pode conhecer — o nome de nenhum widget: era exatamente esse teste
        // por `type` que obrigava a editar o ArcDesk para criar um.
        this._actor = new St.Widget({
            style_class: definition.styleClass
                ? `arcdesk-widget-host ${definition.styleClass}`
                : 'arcdesk-widget-host',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._actor.add_child(this._content.actor);
        this._resizable = definition.resizable !== false;
        // Piso do redimensionamento, em px LÓGICOS: quem declara é o pacote,
        // que é o único que sabe a partir de que tamanho o seu desenho para
        // de fazer sentido.
        this._minWidth = definition.minWidth;
        this._minHeight = definition.minHeight;
        this._applyGeometry(this._record);

        this._signals.connect(this._actor, 'button-press-event', (_actor, event) => {
            if (event.get_button?.() === Clutter.BUTTON_SECONDARY) {
                this.toggleMenu();
                return Clutter.EVENT_STOP;
            }
            return this._press(event);
        });
        this._signals.connect(this._actor, 'motion-event', (_actor, event) => {
            // Fora de um gesto, as bordas já revelam que também podem ser
            // redimensionadas. Não há um modo de edição intermediário.
            if (!this._gesture)
                Cursor.setResize(this._resizeEdges(...event.get_coords()) ?? {});
            return Clutter.EVENT_PROPAGATE;
        });
        this._signals.connect(this._actor, 'leave-event', () => {
            if (!this._gesture) Cursor.setDefault();
            return Clutter.EVENT_PROPAGATE;
        });
        this._signals.connect(this._actor, 'destroy', () => this._cleanup());
    }

    get actor() { return this._actor; }

    get isMenuOpen() { return !!this._menu?.isOpen; }

    toggleMenu() {
        this._beforeOpenMenu?.(this);
        if (!this._menu) {
            this._menu = new WidgetMenu({
                sourceActor: this._actor,
                configItems: this._configItems(),
                onRemove: () => this._onRemove?.(),
                onStateChanged: (isOpen) => this._onMenuStateChanged?.(this, isOpen),
            });
        }
        this._menu.toggle();
    }

    closeMenu() {
        this._menu?.close();
    }

    /**
     * Itens de configuração do menu, derivados dos ajustes `file` do
     * manifest. Um pacote que declara `{"type": "file", "label": "Imagem"}`
     * ganha "Mudar imagem…" sem que nada aqui saiba o que é uma imagem.
     *
     * @returns {{label: string, action: function}[]}
     */
    _configItems() {
        return (this._definition?.fileSettings ?? []).map(({key, label}) => ({
            label: `Mudar ${label.toLowerCase()}…`,
            action: () => this._onChooseFile?.(key, label),
        }));
    }

    update(record, scale = this._scale) {
        this._record = record;
        this._scale = Math.max(1, scale);
        this._content?.updateConfig(record.config);
        this._applyGeometry(record);
    }

    _applyGeometry(record) {
        const px = (value) => Math.round(value * this._scale);
        this._actor.set_position(px(record.x), px(record.y));
        this._actor.set_size(px(record.width), px(record.height));
        this._content?.setSize(px(record.width), px(record.height));
    }

    _press(event) {
        if (event.get_button?.() !== Clutter.BUTTON_PRIMARY || this._record.locked)
            return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        const edges = this._resizeEdges(stageX, stageY);
        return this._begin(event, edges ? MODE.RESIZE : MODE.MOVE, edges);
    }

    _resizeEdges(stageX, stageY) {
        if (!this._resizable) return null;
        const [actorX, actorY] = this._actor.get_transformed_position();
        const [width, height] = this._actor.get_transformed_size();
        const edge = RESIZE_EDGE_PX * this._scale;
        const localX = stageX - actorX;
        const localY = stageY - actorY;
        const edges = {
            left: localX <= edge,
            right: localX >= width - edge,
            top: localY <= edge,
            bottom: localY >= height - edge,
        };
        return Object.values(edges).some(Boolean) ? edges : null;
    }

    _gestureFromPress(mode, stageX, stageY, edges = null) {
        return {
            mode, edges, stageX, stageY,
            pointerX: stageX, pointerY: stageY,
            x: this._actor.x, y: this._actor.y,
            width: this._actor.width, height: this._actor.height,
            moved: false,
        };
    }

    _begin(event, mode, edges = null) {
        if (event.get_button?.() !== Clutter.BUTTON_PRIMARY || this._record.locked)
            return Clutter.EVENT_PROPAGATE;
        const [stageX, stageY] = event.get_coords();
        this._gesture = this._gestureFromPress(mode, stageX, stageY, edges);
        if (mode === MODE.MOVE) Cursor.setGrabbing();
        else Cursor.setResize(edges ?? {});
        this._gestureSignals.disconnectAll();
        this._gestureSignals.connect(global.stage, 'motion-event', (_stage, motion) =>
            this._motion(motion));
        this._gestureSignals.connect(global.stage, 'button-release-event', (_stage, release) =>
            this._end(release));
        return Clutter.EVENT_STOP;
    }

    _motion(event) {
        if (!this._gesture || !this._actor) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._gesture.pointerX = x;
        this._gesture.pointerY = y;
        const dx = x - this._gesture.stageX;
        const dy = y - this._gesture.stageY;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)
            this._gesture.moved = true;
        if (this._gesture.mode === MODE.MOVE) {
            this._actor.set_position(
                this._gesture.x + dx,
                this._gesture.y + dy);
        } else {
            const minWidth = this._minWidth * this._scale;
            const minHeight = this._minHeight * this._scale;
            const edges = this._gesture.edges;
            let left = this._gesture.x;
            let top = this._gesture.y;
            let right = left + this._gesture.width;
            let bottom = top + this._gesture.height;
            if (edges.left) left = Math.min(right - minWidth, left + dx);
            if (edges.right) right = Math.max(left + minWidth, right + dx);
            if (edges.top) top = Math.min(bottom - minHeight, top + dy);
            if (edges.bottom) bottom = Math.max(top + minHeight, bottom + dy);
            const geometry = {
                x: left / this._scale,
                y: top / this._scale,
                width: (right - left) / this._scale,
                height: (bottom - top) / this._scale,
            };
            left = Math.round(geometry.x * this._scale);
            top = Math.round(geometry.y * this._scale);
            this._actor.set_position(left, top);
            this._actor.set_size(
                Math.round(geometry.width * this._scale),
                Math.round(geometry.height * this._scale));
            this._content?.setSize(this._actor.width, this._actor.height);
        }
        return Clutter.EVENT_STOP;
    }

    _end(event = null) {
        if (!this._gesture || !this._actor) return Clutter.EVENT_PROPAGATE;
        const gesture = this._gesture;
        const mode = gesture.mode;
        const activate = mode === MODE.MOVE && !gesture.moved;
        let releaseX = gesture.pointerX;
        let releaseY = gesture.pointerY;
        try {
            [releaseX, releaseY] = event?.get_coords?.() ?? [releaseX, releaseY];
        } catch (_) {}
        const [stageX, stageY] = this._actor.get_transformed_position();
        const [stageWidth, stageHeight] = this._actor.get_transformed_size();
        this._gestureSignals.disconnectAll();
        this._gesture = null;
        if (activate) this._content?.activate?.();
        this._onGeometry?.({
            x: Math.round(this._actor.x / this._scale),
            y: Math.round(this._actor.y / this._scale),
            width: Math.round(this._actor.width / this._scale),
            height: Math.round(this._actor.height / this._scale),
            mode,
            releasePoint: {x: releaseX, y: releaseY},
            stageRect: {
                x: stageX,
                y: stageY,
                width: stageWidth,
                height: stageHeight,
            },
        });
        if (mode === MODE.MOVE) Cursor.setDefault();
        return Clutter.EVENT_STOP;
    }

    _cleanup() {
        if (this._gesture)
            Cursor.setDefault();
        this._signals.disconnectAll();
        this._gestureSignals.disconnectAll();
        this._gesture = null;
        try { this._content?.destroy?.(); } catch (e) {
            logError(e, '[ArcDesk] widget content destroy failed');
        }
        this._content = null;
        this._menu?.destroy();
        this._menu = null;
    }

    destroy() {
        this._cleanup();
        try { this._content?.destroy(); } catch (_) {}
        try { this._actor?.destroy(); } catch (_) {}
        this._content = null;
        this._actor = null;
        this._onGeometry = null;
        this._onRemove = null;
        this._onChooseFile = null;
        this._definition = null;
        this._beforeOpenMenu = null;
        this._onMenuStateChanged = null;
    }
}
