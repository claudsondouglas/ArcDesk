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

/**
 * Persistência das instâncias de widget.
 *
 * ---------------------------------------------------------------------
 * O STORE NÃO CONHECE NENHUM TIPO DE WIDGET
 * ---------------------------------------------------------------------
 *
 * Ele recebe um `constraints(type)` e é só isso que sabe: quantas células
 * um tipo ocupa por padrão, qual o mínimo, se pode ser redimensionado e com
 * que config uma instância nova nasce. Quem responde isso é o manifest do
 * pacote — pela `widgetConstraints` do registry dentro da shell, e pela
 * `constraintsFrom(loadManifestsSync())` no processo de preferências.
 *
 * Antes desta separação o store testava `type === 'calendar'` e
 * `type === 'codex' || 'claude'` para fixar spans, o que significava editar
 * a persistência para criar um widget. Não é mais assim, e não deve voltar
 * a ser: um tipo escrito aqui é um pacote que deixou de ser um pacote.
 *
 * ---------------------------------------------------------------------
 * UM TIPO DESCONHECIDO É PRESERVADO, NUNCA APAGADO
 * ---------------------------------------------------------------------
 *
 * `constraints()` devolve null quando o pacote não está instalado — porque
 * ainda não carregou, porque o usuário removeu o diretório, ou porque o
 * registro veio de uma versão mais nova. Nos três casos o registro é mantido
 * exatamente como está e apenas não é desenhado. É a mesma regra que já vale
 * para um id desconhecido em `desk-items`: um laço que "limpa o que não
 * reconhece" é como uma versão antiga apaga o trabalho de uma versão nova.
 */
function _validate(raw, constraints) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.type !== 'string' || !raw.type) return null;

    const limits = constraints?.(raw.type) ?? null;
    const stored = raw.config && typeof raw.config === 'object' &&
        !Array.isArray(raw.config) ? {...raw.config} : {};
    // Os defaults do manifest entram POR BAIXO do que o usuário gravou.
    const config = {...(limits?.defaultConfig ?? {}), ...stored};

    let colSpan;
    let rowSpan;
    if (limits && limits.resizable === false) {
        // A pegada de um widget não redimensionável é a do manifest, ponto —
        // é isso que faz o calendário 2x2 e os medidores 3x2 continuarem
        // 2x2 e 3x2 sem que este arquivo saiba os nomes deles.
        colSpan = limits.defaultColSpan;
        rowSpan = limits.defaultRowSpan;
    } else {
        colSpan = _number(raw.colSpan,
            limits?.defaultColSpan ?? WIDGET_GEOMETRY.DEFAULT_SPAN,
            limits?.minColSpan ?? 1, WIDGET_GEOMETRY.MAX_SPAN);
        rowSpan = _number(raw.rowSpan,
            limits?.defaultRowSpan ?? WIDGET_GEOMETRY.DEFAULT_SPAN,
            limits?.minRowSpan ?? 1, WIDGET_GEOMETRY.MAX_SPAN);
    }

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
        colSpan,
        rowSpan,
        locked: raw.locked === true,
        config,
    };
}

export class WidgetStore {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [params]
     * @param {(type: string) => object|null} [params.constraints] limites
     *   declarados pelo manifest do tipo. Sem ele o store apenas normaliza
     *   números e nunca fixa uma pegada.
     */
    constructor(settings, params = {}) {
        this._settings = settings ?? null;
        this._constraints = typeof params.constraints === 'function'
            ? params.constraints : () => null;
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
            const record = _validate(raw, this._constraints);
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

    /**
     * Cria uma instância. A pegada e a config inicial vêm do manifest; quem
     * chama só sobrepõe o que realmente escolheu.
     *
     * @param {string} type
     * @param {object} [options]
     * @param {number} [options.monitor]
     * @param {number} [options.colSpan]
     * @param {number} [options.rowSpan]
     * @param {object} [options.config]
     * @returns {string|null} o id da instância
     */
    add(type, options = {}) {
        if (typeof type !== 'string' || !type) return null;
        const limits = this._constraints(type);
        const id = GLib.uuid_string_random();
        const record = _validate({
            type,
            monitor: Number.isInteger(options.monitor) ? options.monitor : null,
            x: 40, y: 40,
            width: WIDGET_GEOMETRY.DEFAULT_SIZE,
            height: WIDGET_GEOMETRY.DEFAULT_SIZE,
            col: 0, row: 0,
            colSpan: options.colSpan ?? limits?.defaultColSpan ??
                WIDGET_GEOMETRY.DEFAULT_SPAN,
            rowSpan: options.rowSpan ?? limits?.defaultRowSpan ??
                WIDGET_GEOMETRY.DEFAULT_SPAN,
            locked: false,
            config: {...(options.config ?? {})},
        }, this._constraints);
        if (!record) return null;
        this._records[id] = record;
        this._write();
        return id;
    }

    updateGeometry(id, geometry) {
        return this.updateGeometries([{id, geometry}]);
    }

    /** Aplica uma reconciliação inteira com uma única escrita no GSettings. */
    updateGeometries(updates) {
        let changed = false;
        for (const {id, geometry} of updates ?? []) {
            const current = this._records[id];
            if (!current) continue;
            const next = _validate({...current, ...geometry}, this._constraints);
            if (!next || JSON.stringify(current) === JSON.stringify(next)) continue;
            this._records[id] = next;
            changed = true;
        }
        if (changed) this._write();
        return changed;
    }

    updateConfig(id, config) {
        const current = this._records[id];
        if (!current || !config || typeof config !== 'object') return false;
        const next = _validate(
            {...current, config: {...current.config, ...config}},
            this._constraints);
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
