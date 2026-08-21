import GLib from 'gi://GLib';

import { SignalTracker } from './trackers.js';

const KEY_WIDGETS = 'desk-widgets';

export const WIDGET_GEOMETRY = Object.freeze({
    DEFAULT_SIZE: 240,
    MIN_SIZE: 80,
    MAX_SIZE: 2048,
    DEFAULT_SPAN: 4,
    MAX_SPAN: 64,
});

function _number(value, fallback, min, max) {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function _validate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.type !== 'string' || !raw.type) return null;
    const config = raw.config && typeof raw.config === 'object' &&
        !Array.isArray(raw.config) ? {...raw.config} : {};
    // Migra uma vez os calendarios criados antes do tamanho padrao 3x2.
    // O marcador preserva qualquer redimensionamento posterior do usuario.
    const legacyCalendar = raw.type === 'calendar' && config.layoutVersion !== 3;
    if (legacyCalendar) config.layoutVersion = 3;
    return {
        ...raw,
        type: raw.type,
        // `null` é uma instância recém-criada pelo processo de preferências,
        // que não enxerga Main.layoutManager: a shell a mostra no primário e
        // grava o índice concreto na primeira movimentação/redimensão.
        monitor: Number.isInteger(raw.monitor) && raw.monitor >= 0
            ? Math.min(raw.monitor, 64)
            : null,
        x: _number(raw.x, 40, 0, 32768),
        y: _number(raw.y, 40, 0, 32768),
        width: _number(raw.width, WIDGET_GEOMETRY.DEFAULT_SIZE,
            WIDGET_GEOMETRY.MIN_SIZE, WIDGET_GEOMETRY.MAX_SIZE),
        height: _number(raw.height, WIDGET_GEOMETRY.DEFAULT_SIZE,
            WIDGET_GEOMETRY.MIN_SIZE, WIDGET_GEOMETRY.MAX_SIZE),
        col: Number.isFinite(raw.col) ? _number(raw.col, 0, 0, 32768) : null,
        row: Number.isFinite(raw.row) ? _number(raw.row, 0, 0, 32768) : null,
        colSpan: legacyCalendar ? 3 : _number(raw.colSpan, WIDGET_GEOMETRY.DEFAULT_SPAN,
            1, WIDGET_GEOMETRY.MAX_SPAN),
        rowSpan: legacyCalendar ? 2 : _number(raw.rowSpan, WIDGET_GEOMETRY.DEFAULT_SPAN,
            1, WIDGET_GEOMETRY.MAX_SPAN),
        locked: raw.locked === true,
        config,
    };
}

export class WidgetStore {
    constructor(settings) {
        this._settings = settings ?? null;
        this._signals = new SignalTracker();
        this._watchers = new Set();
        this._pendingWrite = null;
        this._records = {};
        this.reload();
        if (this._settings) {
            this._signals.connect(this._settings, `changed::${KEY_WIDGETS}`, () => {
                const current = this._settings.get_string(KEY_WIDGETS);
                if (this._pendingWrite === current) {
                    this._pendingWrite = null;
                    return;
                }
                this.reload();
                for (const callback of this._watchers) callback();
            });
        }
    }

    reload() {
        let parsed = {};
        try {
            parsed = JSON.parse(this._settings?.get_string(KEY_WIDGETS) ?? '{}');
        } catch (_) {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
        const records = {};
        for (const [id, raw] of Object.entries(parsed)) {
            const record = _validate(raw);
            if (record) records[id] = record;
        }
        this._records = records;
    }

    list() {
        return Object.entries(this._records).map(([id, record]) => ({
            id,
            ...record,
            config: {...record.config},
        }));
    }

    addImage(imagePath) {
        if (typeof imagePath !== 'string' || !imagePath) return null;
        const id = GLib.uuid_string_random();
        this._records[id] = {
            type: 'image', monitor: null, x: 40, y: 40,
            width: 240, height: 240,
            col: 0, row: 0, colSpan: 4, rowSpan: 4, locked: false,
            config: {imagePath, fit: 'cover'},
        };
        this._write();
        return id;
    }

    add(type, options = {}) {
        if (typeof type !== 'string' || !type) return null;
        const id = GLib.uuid_string_random();
        this._records[id] = {
            type,
            monitor: Number.isInteger(options.monitor) ? options.monitor : null,
            x: 40, y: 40, width: 160, height: 160,
            col: 0, row: 0,
            colSpan: options.colSpan ?? WIDGET_GEOMETRY.DEFAULT_SPAN,
            rowSpan: options.rowSpan ?? WIDGET_GEOMETRY.DEFAULT_SPAN,
            locked: false,
            config: type === 'calendar' ? {layoutVersion: 3} : {},
        };
        this._write();
        return id;
    }

    updateGeometry(id, geometry) {
        const current = this._records[id];
        if (!current) return false;
        const next = _validate({...current, ...geometry});
        if (!next) return false;
        const before = JSON.stringify(current);
        this._records[id] = next;
        if (before === JSON.stringify(next)) return false;
        this._write();
        return true;
    }

    updateConfig(id, config) {
        const current = this._records[id];
        if (!current || !config || typeof config !== 'object') return false;
        const next = _validate({...current, config: {...current.config, ...config}});
        if (!next) return false;
        if (JSON.stringify(current) === JSON.stringify(next)) return false;
        this._records[id] = next;
        this._write();
        return true;
    }

    remove(id) {
        if (!this._records[id]) return false;
        delete this._records[id];
        this._write();
        return true;
    }

    onExternalChange(callback) {
        this._watchers.add(callback);
        return () => this._watchers.delete(callback);
    }

    _write() {
        if (!this._settings) return;
        const value = JSON.stringify(this._records);
        if (this._settings.get_string(KEY_WIDGETS) === value) return;
        this._pendingWrite = value;
        this._settings.set_string(KEY_WIDGETS, value);
    }

    destroy() {
        this._signals.disconnectAll();
        this._watchers.clear();
        this._settings = null;
        this._records = {};
    }
}
