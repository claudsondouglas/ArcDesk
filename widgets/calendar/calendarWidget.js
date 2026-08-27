import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const MONTHS = [
    'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
    'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO',
];

/** Calendario mensal local; ativar abre o aplicativo Calendario do GNOME. */
export class CalendarWidget {
    constructor() {
        this._timerId = 0;
        this._shownDate = new Date();
        this._actor = new St.BoxLayout({
            style_class: 'arcdesk-calendar-widget',
            vertical: true,
            reactive: false,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        this._render();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            if (!this._actor) return GLib.SOURCE_REMOVE;
            const now = new Date();
            if (now.getDate() !== this._shownDate.getDate() ||
                now.getMonth() !== this._shownDate.getMonth() ||
                now.getFullYear() !== this._shownDate.getFullYear()) {
                this._shownDate = now;
                this._render();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    get actor() { return this._actor; }

    updateConfig() {}

    setSize(width, height) {
        this._actor?.set_size(Math.max(1, width), Math.max(1, height));
    }

    activate() {
        const appSystem = Shell.AppSystem.get_default();
        const app = appSystem.lookup_app('org.gnome.Calendar.desktop') ??
            appSystem.lookup_app('gnome-calendar.desktop');
        app?.activate();
    }

    _render() {
        this._actor.destroy_all_children();
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        this._actor.add_child(new St.Label({
            text: MONTHS[month],
            style_class: 'arcdesk-calendar-month',
            x_align: Clutter.ActorAlign.START,
        }));
        this._actor.add_child(this._row(WEEKDAYS, 'arcdesk-calendar-weekday'));

        const firstWeekday = new Date(year, month, 1).getDay();
        const days = new Date(year, month + 1, 0).getDate();
        const previousMonthDays = new Date(year, month, 0).getDate();
        for (let week = 0; week < 6; week++) {
            const cells = [];
            for (let weekday = 0; weekday < 7; weekday++) {
                const monthDay = week * 7 + weekday - firstWeekday + 1;
                const adjacent = monthDay < 1 || monthDay > days;
                const shownDay = monthDay < 1
                    ? previousMonthDays + monthDay
                    : monthDay > days ? monthDay - days : monthDay;
                cells.push({
                    text: String(shownDay).padStart(2, '0'),
                    today: !adjacent && monthDay === now.getDate(),
                    past: adjacent || monthDay < now.getDate(),
                });
            }
            this._actor.add_child(this._dayRow(cells));
        }
    }

    _row(values, styleClass) {
        const row = new St.BoxLayout({x_expand: true});
        for (const value of values) {
            row.add_child(new St.Label({
                text: value,
                style_class: styleClass,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        return row;
    }

    _dayRow(cells) {
        const row = new St.BoxLayout({x_expand: true});
        for (const cell of cells) {
            const holder = new St.Widget({
                style_class: 'arcdesk-calendar-cell',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
            });
            const circle = new St.Widget({
                style_class: [
                    cell.text ? 'arcdesk-calendar-day' : '',
                    cell.past ? 'arcdesk-calendar-past' : '',
                    cell.today ? 'arcdesk-calendar-today' : '',
                ].filter(Boolean).join(' '),
                layout_manager: new Clutter.BinLayout(),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const label = new St.Label({
                text: cell.text,
                style_class: 'arcdesk-calendar-day-number',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            circle.add_child(label);
            holder.add_child(circle);
            row.add_child(holder);
        }
        return row;
    }

    destroy() {
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = 0;
        try { this._actor?.destroy(); } catch (_) {}
        this._actor = null;
    }
}

/** Fábrica exigida pelo loader de widgets (`src/widgetRegistry.js`). */
export function create(params = {}) {
    return new CalendarWidget(params);
}
