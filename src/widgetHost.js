import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { SignalTracker } from './trackers.js';
import { widgetDefinition } from './widgetRegistry.js';
import { WidgetMenu } from './widgetMenu.js';

const MODE = Object.freeze({ MOVE: 'move', RESIZE: 'resize' });

export class WidgetHost {
    constructor(params = {}) {
        this._record = params.record;
        this._scale = Math.max(1, params.scale ?? 1);
        this._onGeometry = params.onGeometry ?? null;
        this._onRemove = params.onRemove ?? null;
        this._onChangeImage = params.onChangeImage ?? null;
        this._beforeOpenMenu = params.beforeOpenMenu ?? null;
        this._onMenuStateChanged = params.onMenuStateChanged ?? null;
        this._signals = new SignalTracker();
        this._gestureSignals = new SignalTracker();
        this._gesture = null;
        this._menu = null;

        const definition = widgetDefinition(this._record?.type);
        if (!definition) throw new Error(`Unknown widget type: ${this._record?.type}`);
        this._content = definition.create({config: this._record.config});
        this._actor = new St.Widget({
            style_class: 'arcdesk-widget-host',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._actor.add_child(this._content.actor);
        this._handle = new St.Icon({
            icon_name: 'view-more-symbolic',
            style_class: 'arcdesk-widget-resize-handle',
            reactive: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        this._actor.add_child(this._handle);
        this._applyGeometry(this._record);

        this._signals.connect(this._actor, 'button-press-event', (_actor, event) => {
            if (event.get_button?.() === Clutter.BUTTON_SECONDARY) {
                this.toggleMenu();
                return Clutter.EVENT_STOP;
            }
            return this._begin(event, MODE.MOVE);
        });
        this._signals.connect(this._handle, 'button-press-event', (_actor, event) =>
            this._begin(event, MODE.RESIZE));
        this._signals.connect(this._actor, 'destroy', () => this._cleanup());
    }

    get actor() { return this._actor; }

    get isMenuOpen() { return !!this._menu?.isOpen; }

    toggleMenu() {
        this._beforeOpenMenu?.(this);
        if (!this._menu) {
            this._menu = new WidgetMenu({
                sourceActor: this._actor,
                widgetType: this._record?.type,
                onChangeImage: () => this._onChangeImage?.(),
                onRemove: () => this._onRemove?.(),
                onStateChanged: (isOpen) => this._onMenuStateChanged?.(this, isOpen),
            });
        }
        this._menu.toggle();
    }

    closeMenu() {
        this._menu?.close();
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

    _begin(event, mode) {
        if (event.get_button?.() !== Clutter.BUTTON_PRIMARY || this._record.locked)
            return Clutter.EVENT_PROPAGATE;
        const [stageX, stageY] = event.get_coords();
        this._gesture = {
            mode, stageX, stageY,
            x: this._actor.x, y: this._actor.y,
            width: this._actor.width, height: this._actor.height,
            moved: false,
        };
        this._gestureSignals.disconnectAll();
        this._gestureSignals.connect(global.stage, 'motion-event', (_stage, motion) =>
            this._motion(motion));
        this._gestureSignals.connect(global.stage, 'button-release-event', () =>
            this._end());
        return Clutter.EVENT_STOP;
    }

    _motion(event) {
        if (!this._gesture || !this._actor) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const dx = x - this._gesture.stageX;
        const dy = y - this._gesture.stageY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this._gesture.moved = true;
        if (this._gesture.mode === MODE.MOVE) {
            this._actor.set_position(
                Math.max(0, this._gesture.x + dx),
                Math.max(0, this._gesture.y + dy));
        } else {
            const min = 80 * this._scale;
            this._actor.set_size(
                Math.max(min, this._gesture.width + dx),
                Math.max(min, this._gesture.height + dy));
            this._content?.setSize(this._actor.width, this._actor.height);
        }
        return Clutter.EVENT_STOP;
    }

    _end() {
        if (!this._gesture || !this._actor) return Clutter.EVENT_PROPAGATE;
        const activate = this._gesture.mode === MODE.MOVE && !this._gesture.moved;
        this._gestureSignals.disconnectAll();
        this._gesture = null;
        if (activate) this._content?.activate?.();
        this._onGeometry?.({
            x: Math.round(this._actor.x / this._scale),
            y: Math.round(this._actor.y / this._scale),
            width: Math.round(this._actor.width / this._scale),
            height: Math.round(this._actor.height / this._scale),
        });
        return Clutter.EVENT_STOP;
    }

    _cleanup() {
        this._signals.disconnectAll();
        this._gestureSignals.disconnectAll();
        this._gesture = null;
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
        this._onChangeImage = null;
        this._beforeOpenMenu = null;
        this._onMenuStateChanged = null;
    }
}
