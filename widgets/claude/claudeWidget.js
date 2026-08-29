import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import St from 'gi://St';

import { SignalTracker, TimeoutTracker } from '../../src/trackers.js';

const TIMING = Object.freeze({ REFRESH_MS: 60 * 1000, DEBOUNCE_MS: 250 });
const PAINT = Object.freeze({ STALE_TRACK_OPACITY: 90 });
const CACHE = Object.freeze({
    DIRECTORY: 'claude-code',
    SNAPSHOT: 'state.json',
    PATTERN: '*.json',
});
const OAUTH = Object.freeze({
    USAGE_ENDPOINT: 'https://api.anthropic.com/api/oauth/usage',
    BETA_HEADER: 'oauth-2025-04-20',
    HTTP_TIMEOUT_S: 10,
});

function _clampPercent(value) {
    return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

/** Cartão que acompanha as cotas de sessão e semanal do Claude Code. */
export class ClaudeWidget {
    constructor() {
        this._destroyed = false;
        this._refreshing = false;
        this._cancellables = new Set();
        this._signals = new SignalTracker();
        this._timeouts = new TimeoutTracker();
        this._monitor = null;
        this._refreshDebounceId = 0;
        this._state = null;
        this._sessionPercent = 0;
        this._weeklyPercent = 0;
        this._cacheRoot = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'arcdesk', CACHE.DIRECTORY,
        ]);
        this._credentialsPath = GLib.build_filenamev([
            GLib.get_home_dir(), '.claude', '.credentials.json',
        ]);
        this._httpSession = new Soup.Session({ timeout: OAUTH.HTTP_TIMEOUT_S });

        this._actor = new St.Widget({
            style_class: 'arcdesk-claude-widget',
            reactive: false,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });

        const body = new St.BoxLayout({
            style_class: 'arcdesk-claude-body',
            vertical: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const top = new St.BoxLayout({
            style_class: 'arcdesk-claude-top',
            vertical: false,
            x_expand: true,
        });
        const copy = new St.BoxLayout({
            style_class: 'arcdesk-claude-copy',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({
            text: 'Claude Code',
            style_class: 'arcdesk-claude-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._value = new St.Label({
            text: '—',
            style_class: 'arcdesk-claude-value',
            x_align: Clutter.ActorAlign.START,
        });
        copy.add_child(this._title);
        copy.add_child(this._value);

        const iconFile = Gio.File.new_for_uri(import.meta.url)
            .get_parent().get_child('claude-session.svg');
        this._icon = new St.Icon({
            style_class: 'arcdesk-claude-icon',
            gicon: new Gio.FileIcon({file: iconFile}),
            icon_size: 68,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(copy);
        top.add_child(this._icon);

        this._sessionLabel = new St.Label({
            text: 'Sessão indisponível',
            style_class: 'arcdesk-claude-limit',
            x_align: Clutter.ActorAlign.START,
        });
        [this._sessionTrack, this._sessionFill] = this._createProgress();
        this._weeklyLabel = new St.Label({
            text: 'Semanal indisponível',
            style_class: 'arcdesk-claude-limit arcdesk-claude-weekly',
            x_align: Clutter.ActorAlign.START,
        });
        [this._weeklyTrack, this._weeklyFill] = this._createProgress();

        body.add_child(top);
        body.add_child(this._sessionLabel);
        body.add_child(this._sessionTrack);
        body.add_child(this._weeklyLabel);
        body.add_child(this._weeklyTrack);
        this._actor.add_child(body);

        this._ensureMonitor();
        this._refresh();
        this._probeLimits();
        this._timeouts.add(TIMING.REFRESH_MS, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._render();
            this._refresh();
            this._probeLimits();
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
            style_class: 'arcdesk-claude-progress-track',
            x_expand: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        const fill = new St.Widget({
            style_class: 'arcdesk-claude-progress-fill',
        });
        fill.set_position(0, 0);
        track.add_child(fill);
        this._signals.connect(track, 'notify::width', () => this._updateProgress());
        return [track, fill];
    }

    _refresh() {
        if (this._refreshing || this._destroyed) return;
        this._refreshing = true;
        this._ensureMonitor();
        const snapshot = GLib.build_filenamev([this._cacheRoot, CACHE.SNAPSHOT]);
        this._loadState(snapshot, state => {
            this._refreshing = false;
            this._state = state;
            this._render();
        }, () => this._readLegacyCache());
    }

    _readLegacyCache() {
        this._run([
            'find', this._cacheRoot, '-maxdepth', '1', '-type', 'f',
            '-name', CACHE.PATTERN, '-printf', '%T@\t%p\n',
        ], (stdout) => {
            const paths = stdout.trim().split('\n').filter(Boolean)
                .map(line => {
                    const tab = line.indexOf('\t');
                    return tab < 0 ? null : {
                        time: Number(line.slice(0, tab)),
                        path: line.slice(tab + 1),
                    };
                })
                .filter(item => item?.path && Number.isFinite(item.time))
                .sort((a, b) => b.time - a.time)
                .map(item => item.path);
            if (paths.length === 0) {
                this._refreshing = false;
                if (!this._hasUsableState()) this._showUnavailable('Integração ainda sem dados');
                return;
            }
            this._readLegacyCandidates(paths);
        }, () => {
            this._refreshing = false;
            if (!this._hasUsableState()) this._showUnavailable('Ative a integração do Claude Code');
        });
    }

    /** A sondagem ao vivo do endpoint OAuth roda em paralelo com a leitura
     * do cache local — se o cache nao existir ou vier vazio, isso nao pode
     * apagar uma cota que a sondagem ja tenha trazido. */
    _hasUsableState() {
        const limits = this._state?.rate_limits;
        return !!(limits && (this._hasLimit(limits.five_hour) || this._hasLimit(limits.seven_day)));
    }

    _readLegacyCandidates(paths, index = 0, merged = null) {
        if (index >= paths.length) {
            this._refreshing = false;
            if (!merged) {
                if (!this._hasUsableState()) this._showUnavailable('Integração ainda sem dados');
                return;
            }
            this._state = merged;
            this._render();
            return;
        }
        this._loadState(paths[index], state => {
            this._readLegacyCandidates(
                paths, index + 1, this._mergeLegacyState(merged, state));
        }, () => this._readLegacyCandidates(paths, index + 1, merged));
    }

    _mergeLegacyState(merged, candidate) {
        const result = merged ?? {
            captured_at: candidate.captured_at,
            session_id: candidate.session_id,
            model: candidate.model,
            context_window: {},
            rate_limits: {},
        };
        const resultContext = result.context_window &&
            typeof result.context_window === 'object'
            ? result.context_window : {};
        const candidateContext = candidate.context_window ?? {};
        if (!Number.isFinite(resultContext.used_percentage) &&
            Number.isFinite(candidateContext.used_percentage))
            result.context_window = candidateContext;

        if (!result.rate_limits || typeof result.rate_limits !== 'object')
            result.rate_limits = {};
        for (const name of ['five_hour', 'seven_day']) {
            if (this._hasLimit(result.rate_limits[name])) continue;
            const limit = candidate.rate_limits?.[name];
            if (this._hasLimit(limit)) result.rate_limits[name] = limit;
        }
        return result;
    }

    _hasLimit(limit) {
        return !!limit && Number.isFinite(limit.used_percentage);
    }

    _loadState(path, onSuccess, onFailure) {
        const file = Gio.File.new_for_path(path);
        const cancellable = this._newCancellable();
        file.load_contents_async(cancellable, (source, result) => {
            this._releaseCancellable(cancellable);
            if (this._destroyed) return;
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok) throw new Error('cache read failed');
                const parsed = JSON.parse(new TextDecoder().decode(contents));
                if (!parsed || typeof parsed !== 'object')
                    throw new Error('invalid cache');
                onSuccess(parsed);
            } catch (e) {
                if (!cancellable.is_cancelled()) onFailure?.(e);
            }
        });
    }

    _ensureMonitor() {
        if (this._monitor || this._destroyed) return;
        try {
            const directory = Gio.File.new_for_path(this._cacheRoot);
            this._monitor = directory.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._signals.connect(this._monitor, 'changed', (_monitor, file) => {
                const name = file?.get_basename() ?? '';
                if (name === CACHE.SNAPSHOT || name.endsWith('.json'))
                    this._scheduleRefresh();
            });
        } catch (_) {
            this._monitor = null;
        }
    }

    _scheduleRefresh() {
        if (this._refreshDebounceId || this._destroyed) return;
        this._refreshDebounceId = this._timeouts.add(TIMING.DEBOUNCE_MS, () => {
            this._refreshDebounceId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
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
        const cancellable = this._newCancellable();
        process.communicate_utf8_async(null, cancellable, (source, result) => {
            this._releaseCancellable(cancellable);
            if (this._destroyed) return;
            try {
                const [, stdout] = source.communicate_utf8_finish(result);
                if (!source.get_successful()) throw new Error('subprocess failed');
                onSuccess?.(stdout ?? '');
            } catch (e) {
                if (!cancellable.is_cancelled()) onFailure?.(e);
            }
        });
    }

    _newCancellable() {
        const cancellable = new Gio.Cancellable();
        this._cancellables.add(cancellable);
        return cancellable;
    }

    _releaseCancellable(cancellable) {
        this._cancellables.delete(cancellable);
    }

    /**
     * O bridge do statusLine so escreve enquanto o Claude Code TUI esta
     * aberto e alguem configurou o hook (ver README). A sondagem direta no
     * endpoint OAuth da Anthropic e autoritativa e nao depende de nenhum dos
     * dois — por isso, quando responde, ela sobrescreve os percentuais que o
     * bridge tinha; o context_window continua vindo so do bridge, que e a
     * unica fonte que o tem.
     */
    _probeLimits() {
        if (this._destroyed) return;
        this._readOauthCredentials(oauth => {
            if (this._destroyed || !oauth?.accessToken) return;
            const expiresAt = Number(oauth.expiresAt);
            if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) return;
            this._fetchUsageLimits(oauth.accessToken, limits => {
                if (this._destroyed || !limits) return;
                this._applyProbedLimits(limits);
            });
        });
    }

    _readOauthCredentials(callback) {
        const file = Gio.File.new_for_path(this._credentialsPath);
        const cancellable = this._newCancellable();
        file.load_contents_async(cancellable, (source, result) => {
            this._releaseCancellable(cancellable);
            if (this._destroyed) return;
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok) throw new Error('credentials read failed');
                const parsed = JSON.parse(new TextDecoder().decode(contents));
                const oauth = parsed?.claudeAiOauth;
                callback(oauth && typeof oauth === 'object' ? oauth : null);
            } catch (_e) {
                callback(null);
            }
        });
    }

    _fetchUsageLimits(accessToken, callback) {
        const message = Soup.Message.new('GET', OAUTH.USAGE_ENDPOINT);
        message.request_headers.append('Authorization', `Bearer ${accessToken}`);
        message.request_headers.append('anthropic-beta', OAUTH.BETA_HEADER);
        message.request_headers.append('Accept', 'application/json');
        const cancellable = this._newCancellable();
        this._httpSession.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                this._releaseCancellable(cancellable);
                if (this._destroyed) return;
                try {
                    const bytes = source.send_and_read_finish(result);
                    if (message.get_status() !== 200)
                        throw new Error(`usage endpoint status ${message.get_status()}`);
                    const payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    callback(this._parseUsagePayload(payload));
                } catch (e) {
                    if (!cancellable.is_cancelled())
                        logError(e, '[ArcDesk] falha ao consultar limites do Claude Code');
                    callback(null);
                }
            });
    }

    /** Converte os buckets da API (fracao 0-1 ou percentual 0-100, a
     * depender da versao do payload) para o mesmo `used_percentage` 0-100
     * que `_limitState()` ja espera do bridge do statusLine. */
    _parseUsagePayload(payload) {
        if (!payload || typeof payload !== 'object') return null;
        const session = payload.five_hour;
        const weekly = payload.seven_day_oauth_apps ?? payload.seven_day;
        const rawValues = [session?.utilization, weekly?.utilization]
            .filter(v => v !== undefined && v !== null)
            .map(Number);
        const percentScale = rawValues.some(v => Number.isFinite(v) && v >= 1);
        const toPercent = (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) return null;
            return Math.max(0, Math.min(100, percentScale || n > 1 ? n : n * 100));
        };

        const result = {};
        const sessionPercent = toPercent(session?.utilization);
        if (sessionPercent !== null) {
            result.five_hour = {
                used_percentage: sessionPercent,
                resets_at: this._toEpochSeconds(session.resets_at),
                updated_at: Math.floor(Date.now() / 1000),
            };
        }
        const weeklyPercent = toPercent(weekly?.utilization);
        if (weeklyPercent !== null) {
            result.seven_day = {
                used_percentage: weeklyPercent,
                resets_at: this._toEpochSeconds(weekly.resets_at),
                updated_at: Math.floor(Date.now() / 1000),
            };
        }
        return Object.keys(result).length > 0 ? result : null;
    }

    _toEpochSeconds(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number')
            return Math.floor(value > 1e12 ? value / 1000 : value);
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }

    _applyProbedLimits(limits) {
        const base = this._state && typeof this._state === 'object' ? this._state : {
            captured_at: Math.floor(Date.now() / 1000),
            context_window: {},
            rate_limits: {},
        };
        this._state = {
            ...base,
            rate_limits: {
                ...(base.rate_limits ?? {}),
                ...limits,
            },
        };
        this._render();
    }

    _render() {
        if (!this._actor || !this._state) return;
        const capturedAt = Number.isFinite(this._state.captured_at)
            ? this._state.captured_at : null;
        const session = this._limitState(
            this._state.rate_limits?.five_hour, capturedAt);
        const weekly = this._limitState(
            this._state.rate_limits?.seven_day, capturedAt);
        const context = _clampPercent(this._state.context_window?.used_percentage);
        const hasContext = Number.isFinite(
            this._state.context_window?.used_percentage);

        this._title.text = 'Claude Code';
        this._value.text = session
            ? session.stale ? 'Sem leitura' : this._remainingTime(session.resetsAt)
            : 'Aguardando';
        const sessionReset = this._resetTime(session?.resetsAt);
        const weeklyReset = this._resetTime(weekly?.resetsAt, true);
        this._sessionLabel.text = session
            ? session.stale
                ? this._staleText('Sessão', session.readAt)
                : `Sessão ${session.percent}% usado${sessionReset ? ` · reseta ${sessionReset}` : ''}`
            : hasContext
                ? `Contexto ${Math.round(context)}% usado`
                : 'Abra o Claude Code para obter a primeira leitura';
        this._weeklyLabel.text = weekly
            ? weekly.stale
                ? this._staleText('Semanal', weekly.readAt)
                : `Semanal ${weekly.percent}% usado${weeklyReset ? ` · reseta ${weeklyReset}` : ''}`
            : 'Semanal aguardando leitura';
        this._sessionPercent = session ? (session.stale ? 0 : session.percent) : context;
        this._weeklyPercent = weekly && !weekly.stale ? weekly.percent : 0;
        this._setUnread(this._sessionTrack, !!session?.stale);
        this._setUnread(this._weeklyTrack, !!weekly?.stale);
        this._updateProgress();
    }

    _limitState(limit, capturedAt) {
        if (!limit || !Number.isFinite(limit.used_percentage)) return null;
        const resetsAt = Number.isFinite(limit.resets_at) ? limit.resets_at : null;
        const readAt = Number.isFinite(limit.updated_at) ? limit.updated_at : capturedAt;
        // A janela virou DEPOIS da ultima leitura: o numero guardado descreve uma
        // janela ja encerrada e ninguem mediu a nova. Zerar aqui seria afirmar
        // "0% usado" sobre um periodo que a ponte nunca chegou a observar — e a
        // ponte so roda no statusline do TUI, entao um dia inteiro de trabalho
        // por outro cliente cai exatamente neste buraco.
        const stale = Number.isFinite(resetsAt) && resetsAt * 1000 <= Date.now() &&
            (!Number.isFinite(readAt) || readAt < resetsAt);
        return {
            percent: Math.round(_clampPercent(limit.used_percentage)),
            resetsAt,
            readAt: Number.isFinite(readAt) ? readAt : null,
            stale,
        };
    }

    /** Um trilho sem leitura fica apagado: vazio ali nao quer dizer zero. */
    _setUnread(track, unread) {
        if (!track) return;
        track.opacity = unread ? PAINT.STALE_TRACK_OPACITY : 255;
    }

    _staleText(prefix, readAt) {
        const since = this._readTime(readAt);
        return since ? `${prefix} sem leitura desde ${since}`
            : `${prefix} sem leitura recente`;
    }

    _readTime(timestamp) {
        if (!Number.isFinite(timestamp)) return '';
        const date = new Date(timestamp * 1000);
        if (Number.isNaN(date.getTime())) return '';
        const time = date.toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit',
        });
        if (date.toDateString() === new Date().toDateString()) return time;
        const day = date.toLocaleDateString('pt-BR', {
            day: '2-digit', month: '2-digit',
        });
        return `${day} ${time}`;
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
        if (!Number.isFinite(timestamp)) return '—';
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
        this._title.text = 'Claude Code';
        this._value.text = 'Aguardando';
        this._sessionLabel.text = message;
        this._weeklyLabel.text = 'Semanal aguardando leitura';
        this._sessionPercent = 0;
        this._weeklyPercent = 0;
        this._setUnread(this._sessionTrack, false);
        this._setUnread(this._weeklyTrack, false);
        this._updateProgress();
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._timeouts.removeAll();
        this._refreshDebounceId = 0;
        for (const cancellable of this._cancellables) cancellable.cancel();
        this._cancellables.clear();
        this._signals.disconnectAll();
        try { this._monitor?.cancel(); } catch (_) {}
        this._monitor = null;
        try { this._actor?.destroy(); } catch (_) {}
        this._actor = null;
        this._state = null;
        this._httpSession = null;
    }
}

/** Fábrica exigida pelo loader de widgets (`src/widgetRegistry.js`). */
export function create(params = {}) {
    return new ClaudeWidget(params);
}
