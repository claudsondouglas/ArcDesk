import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { SignalTracker } from '../../src/trackers.js';
import { fetchCodexLimits } from './codexRpcClient.js';

const REFRESH_SECONDS = 15;
const RPC_REFRESH_SECONDS = 60;
const TAIL_LINES = 240;

function _clampPercent(value) {
    return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

/** Cartão que acompanha as cotas de sessão e semanal do Codex local. */
export class CodexWidget {
    constructor() {
        this._destroyed = false;
        this._refreshing = false;
        this._timerId = 0;
        this._rpcTimerId = 0;
        this._cancellable = new Gio.Cancellable();
        this._rpcCancellables = new Set();
        this._signals = new SignalTracker();
        this._sessionPath = null;
        this._state = null;
        this._sessionPercent = 0;
        this._weeklyPercent = 0;

        this._actor = new St.Widget({
            style_class: 'arcdesk-codex-widget',
            reactive: false,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });

        const body = new St.BoxLayout({
            style_class: 'arcdesk-codex-body',
            vertical: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const top = new St.BoxLayout({
            style_class: 'arcdesk-codex-top',
            vertical: false,
            x_expand: true,
        });
        const text = new St.BoxLayout({
            style_class: 'arcdesk-codex-copy',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({
            text: 'Codex',
            style_class: 'arcdesk-codex-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._value = new St.Label({
            text: '—',
            style_class: 'arcdesk-codex-value',
            x_align: Clutter.ActorAlign.START,
        });
        this._sessionLabel = new St.Label({
            text: 'Sessão indisponível',
            style_class: 'arcdesk-codex-limit',
            x_align: Clutter.ActorAlign.START,
        });
        [this._sessionTrack, this._sessionFill] = this._createProgress();
        this._weeklyLabel = new St.Label({
            text: 'Semanal indisponível',
            style_class: 'arcdesk-codex-limit arcdesk-codex-weekly',
            x_align: Clutter.ActorAlign.START,
        });
        [this._weeklyTrack, this._weeklyFill] = this._createProgress();
        text.add_child(this._title);
        text.add_child(this._value);

        const iconFile = Gio.File.new_for_uri(import.meta.url)
            .get_parent().get_child('codex-dark.svg');
        this._icon = new St.Icon({
            style_class: 'arcdesk-codex-icon',
            gicon: new Gio.FileIcon({file: iconFile}),
            icon_size: 64,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(text);
        top.add_child(this._icon);
        body.add_child(top);
        body.add_child(this._sessionLabel);
        body.add_child(this._sessionTrack);
        body.add_child(this._weeklyLabel);
        body.add_child(this._weeklyTrack);
        this._actor.add_child(body);

        this._refresh();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });

        this._probeRpcLimits();
        this._rpcTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, RPC_REFRESH_SECONDS, () => {
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                this._probeRpcLimits();
                return GLib.SOURCE_CONTINUE;
            });
    }

    get actor() { return this._actor; }

    updateConfig() {}

    setSize(width, height) {
        if (!this._actor) return;
        this._actor.set_size(Math.max(1, width), Math.max(1, height));
        this._icon.icon_size = Math.max(52, Math.min(76, Math.round(height * 0.36)));
    }

    _createProgress() {
        const track = new St.Widget({
            style_class: 'arcdesk-codex-progress-track',
            x_expand: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        const fill = new St.Widget({
            style_class: 'arcdesk-codex-progress-fill',
        });
        fill.set_position(0, 0);
        track.add_child(fill);
        this._signals.connect(track, 'notify::width', () => this._updateProgress());
        return [track, fill];
    }

    _refresh() {
        if (this._refreshing || this._destroyed) return;
        this._refreshing = true;
        const root = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'sessions']);
        this._run([
            'find', root, '-type', 'f', '-name', 'rollout-*.jsonl',
            '-printf', '%T@\t%p\n',
        ], (stdout) => {
            const latest = stdout.trim().split('\n').filter(Boolean)
                .map(line => {
                    const tab = line.indexOf('\t');
                    return tab < 0 ? null : {
                        time: Number(line.slice(0, tab)),
                        path: line.slice(tab + 1),
                    };
                })
                .filter(item => item?.path && Number.isFinite(item.time))
                .sort((a, b) => b.time - a.time)[0];
            if (!latest) {
                this._refreshing = false;
                if (!this._hasUsableState()) this._showUnavailable('Nenhuma sessão encontrada');
                return;
            }
            this._sessionPath = latest.path;
            this._readSession(latest.path);
        }, () => {
            this._refreshing = false;
            if (!this._hasUsableState()) this._showUnavailable('Codex ainda não foi utilizado');
        });
    }

    _readSession(path) {
        this._run(['tail', '-n', String(TAIL_LINES), path], (stdout) => {
            this._refreshing = false;
            const lines = stdout.trim().split('\n').reverse();
            let event = null;
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed?.type === 'event_msg' &&
                        parsed.payload?.type === 'token_count' &&
                        parsed.payload?.info) {
                        event = parsed.payload;
                        break;
                    }
                } catch (_) {}
            }
            if (!event) {
                if (!this._hasUsableState()) this._showUnavailable('Aguardando dados de uso');
                return;
            }
            this._state = event;
            this._render();
        }, () => {
            this._refreshing = false;
            if (!this._hasUsableState()) this._showUnavailable('Não foi possível ler a sessão');
        });
    }

    /** A leitura local pode terminar depois da sondagem RPC e nao achar
     * nada — isso nao pode apagar uma cota ao vivo que o RPC ja trouxe. */
    _hasUsableState() {
        const limits = this._state?.rate_limits;
        return !!(limits && (limits.primary || limits.secondary));
    }

    /**
     * Leitura das sessoes locais so reflete a cota vista na ultima chamada do
     * Codex. O `account/rateLimits/read` do `codex app-server` e uma leitura
     * ao vivo, autoritativa mesmo sem uso recente, e por isso sobrescreve o
     * que a leitura local tiver — mas so quando o RPC responde; do contrario
     * a leitura local continua sendo o unico dado que temos.
     */
    _probeRpcLimits() {
        if (this._destroyed) return;
        const cancellable = new Gio.Cancellable();
        this._rpcCancellables.add(cancellable);
        fetchCodexLimits(cancellable).then(result => {
            this._rpcCancellables.delete(cancellable);
            if (this._destroyed || !result) return;
            this._applyRpcLimits(result);
        }).catch(e => {
            this._rpcCancellables.delete(cancellable);
            if (!this._destroyed) logError(e, '[ArcDesk] falha ao consultar limites do Codex via RPC');
        });
    }

    _applyRpcLimits({rateLimits}) {
        const toLocalWindow = (window) => {
            if (!window || !Number.isFinite(window.usedPercent)) return null;
            return {
                used_percent: window.usedPercent,
                window_minutes: Number.isFinite(window.windowDurationMins)
                    ? window.windowDurationMins : null,
                resets_at: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
            };
        };
        const primary = toLocalWindow(rateLimits?.primary);
        const secondary = toLocalWindow(rateLimits?.secondary);
        if (!primary && !secondary) return;

        this._state = {
            ...(this._state ?? {}),
            rate_limits: {
                ...(this._state?.rate_limits ?? {}),
                ...(primary ? {primary} : {}),
                ...(secondary ? {secondary} : {}),
            },
        };
        this._render();
    }

    _run(argv, onSuccess, onFailure) {
        let process;
        try {
            process = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            onFailure?.(e);
            return;
        }
        process.communicate_utf8_async(null, this._cancellable, (source, result) => {
            if (this._destroyed) return;
            try {
                const [, stdout] = source.communicate_utf8_finish(result);
                if (!source.get_successful()) throw new Error('subprocess failed');
                onSuccess?.(stdout ?? '');
            } catch (e) {
                if (!this._cancellable.is_cancelled()) onFailure?.(e);
            }
        });
    }

    _render() {
        if (!this._actor || !this._state) return;
        const {session, weekly} = this._rateLimits();
        this._title.text = 'Codex';
        this._value.text = session
            ? session.expired ? 'Livre' : this._remainingTime(session.resetsAt)
            : 'Aguardando';
        const sessionReset = this._resetTime(session?.resetsAt);
        const weeklyReset = this._resetTime(weekly?.resetsAt, true);
        this._sessionLabel.text = session
            ? session.expired
                ? 'Sessão livre · 0% usado'
                : `Sessão ${session.percent}% usado${sessionReset ? ` · reseta ${sessionReset}` : ''}`
            : 'Sessão aguardando leitura';
        this._weeklyLabel.text = weekly
            ? weekly.expired
                ? 'Semanal livre · 0% usado'
                : `Semanal ${weekly.percent}% usado${weeklyReset ? ` · reseta ${weeklyReset}` : ''}`
            : 'Semanal aguardando leitura';
        this._sessionPercent = session?.percent ?? 0;
        this._weeklyPercent = weekly?.percent ?? 0;
        this._updateProgress();
    }

    _rateLimits() {
        const windows = [
            this._state.rate_limits?.primary,
            this._state.rate_limits?.secondary,
        ].filter(limit => limit && Number.isFinite(limit.used_percent));
        const byShortestWindow = (a, b) =>
            (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity);
        const session = windows
            .filter(limit => Number.isFinite(limit.window_minutes) &&
                limit.window_minutes < 10080)
            .sort(byShortestWindow)[0] ?? null;
        const weekly = windows
            .filter(limit => Number.isFinite(limit.window_minutes) &&
                limit.window_minutes >= 10080)
            .sort((a, b) => (b.window_minutes ?? 0) - (a.window_minutes ?? 0))[0] ?? null;
        return {
            session: this._limitState(session),
            weekly: this._limitState(weekly),
        };
    }

    _limitState(limit) {
        if (!limit || !Number.isFinite(limit.used_percent)) return null;
        const resetsAt = Number.isFinite(limit.resets_at) ? limit.resets_at : null;
        const expired = Number.isFinite(resetsAt) && resetsAt * 1000 <= Date.now();
        return {
            percent: expired ? 0 : Math.round(_clampPercent(limit.used_percent)),
            resetsAt,
            expired,
        };
    }

    _updateProgress() {
        this._setProgress(this._sessionTrack, this._sessionFill, this._sessionPercent);
        this._setProgress(this._weeklyTrack, this._weeklyFill, this._weeklyPercent);
    }

    _setProgress(track, fill, percent) {
        if (!track || !fill) return;
        fill.set_position(0, 0);
        fill.height = Math.max(1, track.height || 8);
        fill.width = Math.max(2, Math.round(
            track.width * _clampPercent(percent) / 100));
    }

    _remainingTime(timestamp) {
        if (!Number.isFinite(timestamp)) return null;
        const remainingMinutes = Math.max(0,
            Math.ceil((timestamp * 1000 - Date.now()) / 60000));
        const hours = Math.floor(remainingMinutes / 60);
        const minutes = remainingMinutes % 60;
        if (hours === 0) return `${minutes}m`;
        return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    }

    _resetTime(timestamp, withWeekday = false) {
        if (!Number.isFinite(timestamp)) return '';
        const date = new Date(timestamp * 1000);
        if (Number.isNaN(date.getTime())) return '';
        const time = date.toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit',
        });
        if (!withWeekday) return time;
        const weekday = date.toLocaleDateString('pt-BR', {weekday: 'short'})
            .replace(/[.,]/g, '');
        return `${weekday} ${time}`;
    }

    _showUnavailable(message) {
        if (!this._actor) return;
        this._value.text = 'Aguardando';
        this._title.text = 'Codex';
        this._sessionLabel.text = message;
        this._weeklyLabel.text = 'Semanal aguardando leitura';
        this._sessionPercent = 0;
        this._weeklyPercent = 0;
        this._updateProgress();
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = 0;
        if (this._rpcTimerId) GLib.source_remove(this._rpcTimerId);
        this._rpcTimerId = 0;
        for (const cancellable of this._rpcCancellables) cancellable.cancel();
        this._rpcCancellables.clear();
        this._cancellable.cancel();
        this._signals.disconnectAll();
        try { this._actor?.destroy(); } catch (_) {}
        this._actor = null;
        this._state = null;
    }
}

/** Fábrica exigida pelo loader de widgets (`src/widgetRegistry.js`). */
export function create(params = {}) {
    return new CodexWidget(params);
}
