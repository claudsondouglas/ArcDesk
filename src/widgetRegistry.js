import { ImageWidget } from '../widgets/image/imageWidget.js';
import { CalendarWidget } from '../widgets/calendar/calendarWidget.js';
import { CodexWidget } from '../widgets/codex/codexWidget.js';
import { ClaudeWidget } from '../widgets/claude/claudeWidget.js';

const REGISTRY = Object.freeze({
    calendar: Object.freeze({
        name: 'Calendário',
        create: () => new CalendarWidget(),
        defaultColSpan: 2,
        defaultRowSpan: 2,
        minWidth: 120,
        minHeight: 120,
        resizable: false,
        configurable: false,
    }),
    codex: Object.freeze({
        name: 'Uso do Codex',
        create: () => new CodexWidget(),
        defaultColSpan: 3,
        defaultRowSpan: 2,
        minWidth: 210,
        minHeight: 120,
        resizable: false,
        configurable: false,
    }),
    claude: Object.freeze({
        name: 'Uso do Claude Code',
        create: () => new ClaudeWidget(),
        defaultColSpan: 3,
        defaultRowSpan: 2,
        minWidth: 210,
        minHeight: 120,
        resizable: false,
        configurable: false,
    }),
    image: Object.freeze({
        name: 'Imagem',
        create: (params) => new ImageWidget(params),
        minWidth: 80,
        minHeight: 80,
        configurable: true,
    }),
});

export function widgetDefinition(type) {
    return REGISTRY[type] ?? null;
}

/** Tipos que podem ser apresentados nas interfaces de adicao. */
export function availableWidgets() {
    return Object.entries(REGISTRY).map(([type, definition]) => ({
        type,
        name: definition.name ?? type,
        configurable: definition.configurable === true,
        defaultColSpan: definition.defaultColSpan ?? 4,
        defaultRowSpan: definition.defaultRowSpan ?? 4,
    }));
}
