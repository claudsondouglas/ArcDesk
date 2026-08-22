import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Cursor from './cursor.js';
import { SignalTracker } from './trackers.js';
import { widgetDefinition } from './widgetRegistry.js';
import { WidgetMenu } from './widgetMenu.js';

const MODE = Object.freeze({ MOVE: 'move', RESIZE: 'resize' });
const LONG_PRESS_MS = 500;
const DRAG_THRESHOLD = 6;
const RESIZE_EDGE_PX = 14;

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
        this._editSignals = new SignalTracker();
        this._gesture = null;
        this._pendingPress = null;
        this._longPressId = 0;
        this._editing = false;
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
        this._resizable = definition.resizable !== false;
        this._applyGeometry(this._record);

        this._signals.connect(this._actor, 'button-press-event', (_actor, event) => {
            if (event.get_button?.() === Clutter.BUTTON_SECONDARY) {
                this.toggleMenu();
                return Clutter.EVENT_STOP;
            }
            return this._press(event);
        });
        this._signals.connect(this._actor, 'motion-event', (_actor, event) => {
            // Durante um gesto, o cursor pertence a _begin(): grabbing para
            // movimento ou direcional para resize. O hover não pode
            // sobrescrevê-lo a cada motion do próprio actor.
            if (this._editing && !this._gesture)
                Cursor.setResize(this._resizeEdges(...event.get_coords()) ?? {});
            return Clutter.EVENT_PROPAGATE;
        });
        this._signals.connect(this._actor, 'leave-event', () => {
            if (this._editing && !this._gesture) Cursor.setDefault();
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

    _press(event) {
        if (event.get_button?.() !== Clutter.BUTTON_PRIMARY || this._record.locked)
            return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        if (!this._resizable) return this._begin(event, MODE.MOVE);
        if (this._editing) {
            const edges = this._resizeEdges(stageX, stageY);
            if (edges) return this._begin(event, MODE.RESIZE, edges);
            return this._begin(event, MODE.MOVE);
        }

        this._pendingPress = {stageX, stageY, activatedEditing: false};
        this._gestureSignals.disconnectAll();
        this._gestureSignals.connect(global.stage, 'motion-event', (_stage, motion) =>
            this._pendingMotion(motion));
        this._gestureSignals.connect(global.stage, 'button-release-event', () =>
            this._pendingRelease());
        this._cancelLongPress();
        this._longPressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
            this._longPressId = 0;
            if (!this._pendingPress || !this._actor) return GLib.SOURCE_REMOVE;
            this._pendingPress.activatedEditing = true;
            this._setEditing(true);
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }

    _pendingMotion(event) {
        if (!this._pendingPress) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (Math.abs(x - this._pendingPress.stageX) <= DRAG_THRESHOLD &&
            Math.abs(y - this._pendingPress.stageY) <= DRAG_THRESHOLD)
            return Clutter.EVENT_STOP;

        const press = this._pendingPress;
        this._pendingPress = null;
        this._cancelLongPress();
        this._gesture = this._gestureFromPress(MODE.MOVE, press.stageX, press.stageY);
        Cursor.setGrabbing();
        return this._motion(event);
    }

    _pendingRelease() {
        if (!this._pendingPress) return this._end();
        const {activatedEditing} = this._pendingPress;
        const wasEditing = this._editing;
        this._pendingPress = null;
        this._cancelLongPress();
        this._gestureSignals.disconnectAll();
        if (!activatedEditing) {
            if (wasEditing) this._setEditing(false);
            this._content?.activate?.();
        }
        return Clutter.EVENT_STOP;
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

    _setEditing(editing) {
        this._editing = editing;
        this._editSignals.disconnectAll();
        if (editing) {
            this._actor.add_style_class_name('arcdesk-widget-editing');
            this._editSignals.connect(global.stage, 'captured-event', (_stage, event) => {
                if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                    return Clutter.EVENT_PROPAGATE;
                const [stageX, stageY] = event.get_coords();
                const [actorX, actorY] = this._actor.get_transformed_position();
                const [width, height] = this._actor.get_transformed_size();
                if (stageX >= actorX && stageX <= actorX + width &&
                    stageY >= actorY && stageY <= actorY + height)
                    return Clutter.EVENT_PROPAGATE;
                this._setEditing(false);
                return Clutter.EVENT_PROPAGATE;
            });
        } else {
            this._actor.remove_style_class_name('arcdesk-widget-editing');
            Cursor.setDefault();
        }
    }

    _gestureFromPress(mode, stageX, stageY, edges = null) {
        return {
            mode, edges, stageX, stageY,
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
        this._gestureSignals.connect(global.stage, 'button-release-event', () =>
            this._end());
        return Clutter.EVENT_STOP;
    }

    _motion(event) {
        if (!this._gesture || !this._actor) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const dx = x - this._gesture.stageX;
        const dy = y - this._gesture.stageY;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)
            this._gesture.moved = true;
        if (this._gesture.mode === MODE.MOVE) {
            this._actor.set_position(
                Math.max(0, this._gesture.x + dx),
                Math.max(0, this._gesture.y + dy));
        } else {
            const min = 80 * this._scale;
            const edges = this._gesture.edges;
            let left = this._gesture.x;
            let top = this._gesture.y;
            let right = left + this._gesture.width;
            let bottom = top + this._gesture.height;
            if (edges.left) left = Math.min(right - min, left + dx);
            if (edges.right) right = Math.max(left + min, right + dx);
            if (edges.top) top = Math.min(bottom - min, top + dy);
            if (edges.bottom) bottom = Math.max(top + min, bottom + dy);
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

    _end() {
        if (!this._gesture || !this._actor) return Clutter.EVENT_PROPAGATE;
        const mode = this._gesture.mode;
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
        if (mode === MODE.MOVE) Cursor.setDefault();
        return Clutter.EVENT_STOP;
    }

    _cleanup() {
        if (this._editing || this._gesture)
            Cursor.setDefault();
        this._cancelLongPress();
        this._signals.disconnectAll();
        this._gestureSignals.disconnectAll();
        this._editSignals.disconnectAll();
        this._gesture = null;
        this._pendingPress = null;
        this._menu?.destroy();
        this._menu = null;
    }

    _cancelLongPress() {
        if (!this._longPressId) return;
        GLib.source_remove(this._longPressId);
        this._longPressId = 0;
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
