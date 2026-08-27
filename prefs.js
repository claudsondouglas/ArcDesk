import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { DeskLayout, DeskItemType, parseDeskId } from './src/deskLayout.js';
import { WidgetStore } from './src/widgetStore.js';
import { loadManifestsSync, constraintsFrom } from './src/widgetManifest.js';

// Limites idênticos ao <range> da key "icon-size" no gschema (e a
// SIZE.ICON_MIN/ICON_MAX em src/config.js): um Gtk.Adjustment fora do range
// escreveria um valor que o GSettings recusa.
const ICON_SIZE = Object.freeze({
    MIN: 32,
    DEFAULT: 64,
    MAX: 128,
    STEP: 1,
    PAGE: 8,
});

// Espelha `grid-bottom-margin` no gschema e SIZE em config.js.
const GRID_BOTTOM_MARGIN = Object.freeze({
    MIN: 0,
    DEFAULT: 0,
    MAX: 256,
    STEP: 4,
    PAGE: 16,
});

const ICON = Object.freeze({
    APPEARANCE_PAGE: 'preferences-desktop-appearance-symbolic',
    BEHAVIOR_PAGE: 'preferences-system-symbolic',
    ITEMS_PAGE: 'view-grid-symbolic',
    WIDGETS_PAGE: 'image-x-generic-symbolic',
    APP: 'application-x-executable-symbolic',
    FOLDER: 'folder-symbolic',
    UNKNOWN: 'dialog-question-symbolic',
    REMOVE: 'user-trash-symbolic',
});

const TOAST = Object.freeze({
    TIMEOUT_S: 3,
});

// Rótulos da coluna de monitor da página "Items". São só leitura: mover um
// item entre telas é um arrasto na área de trabalho, não um controle aqui —
// e um combo que escrevesse `mon` teria de saber quantos monitores existem,
// coisa que este processo não enxerga (não há Main.layoutManager fora da
// shell).
const MONITOR_LABEL = Object.freeze({
    // Registro gravado pela v1, sem o campo `mon`: significa monitor primário.
    // Mostrar "unknown" seria mentira — a v1 só sabia desenhar no primário.
    PRIMARY: 'Primary monitor',
    // Id em `desk-items` sem registro em `desk-placements`: ainda não tem
    // posição nenhuma, e ganha o primeiro slot livre do primário no próximo
    // build da shell (é assim que o "só faça append" da ArcDock funciona).
    UNPLACED: 'Not placed yet',
});

// Ordem desta lista = ordem do Adw.ComboRow; o índice selecionado indexa os
// `value`, que precisam bater com os choices do gschema.
const DESK_THEMES = Object.freeze([
    Object.freeze({
        value: 'light',
        title: 'Light',
        subtitle: 'Ink tuned for a light wallpaper: lighter label plates and folder covers.',
    }),
    Object.freeze({
        value: 'dark',
        title: 'Dark',
        subtitle: 'Ink tuned for a dark wallpaper: denser plates behind every label.',
    }),
]);

// Ordem desta lista = ordem do Adw.ComboRow; ver DESK_THEMES.
const LABEL_POSITIONS = Object.freeze([
    Object.freeze({
        value: 'below',
        title: 'Below the icon',
        subtitle: 'Draw the item name under its art, on up to two lines.',
    }),
    Object.freeze({
        value: 'hidden',
        title: 'Hidden',
        subtitle: 'Draw no label at all. Cells get shorter, so more rows fit on screen.',
    }),
]);

// Ordem desta lista = ordem do Adw.ComboRow; ver DESK_THEMES.
const GRID_ORIGINS = Object.freeze([
    Object.freeze({
        value: 'top-left',
        title: 'Top left',
        subtitle: 'Column zero sits on the left edge of the work area.',
    }),
    Object.freeze({
        value: 'top-right',
        title: 'Top right',
        subtitle: 'Column zero sits on the right edge, the way macOS stacks the desktop.',
    }),
]);

export default class ArcDeskPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._buildAppearancePage(window, settings);
        this._buildBehaviorPage(window, settings);
        this._buildItemsPage(window, settings);
        this._buildWidgetsPage(window, settings);
    }

    /**
     * Página "Widgets".
     *
     * Os MANIFESTS são a fonte da verdade aqui também. Este processo não
     * enxerga a shell, logo não há registry para consultar — e é justamente
     * por isso que o catálogo mora em arquivos de dados no disco em vez de
     * numa tabela dentro do `gnome-shell`. A varredura é síncrona porque
     * aqui isso é permitido: uma janela de preferências parada não é um
     * compositor parado (a mesma licença do `query_info()` das pastas).
     *
     * Só aparecem aqui os pacotes que declaram um ajuste do tipo `file`.
     * São exatamente os que NÃO conseguem nascer prontos do menu do fundo,
     * porque falta um caminho que só um seletor de arquivos sabe pedir.
     * Todos os outros se adicionam com o botão direito na área de trabalho.
     */
    _buildWidgetsPage(window, settings) {
        const manifests = loadManifestsSync();
        const store = new WidgetStore(settings, {
            constraints: constraintsFrom(manifests),
        });
        const page = new Adw.PreferencesPage({
            title: 'Widgets',
            icon_name: ICON.WIDGETS_PAGE,
        });
        window.add(page);

        const packages = [...manifests.values()]
            .filter(descriptor => descriptor.fileSettings.length > 0)
            .sort((a, b) => a.name.localeCompare(b.name));

        const rebuilders = [];
        if (packages.length) {
            for (const descriptor of packages) {
                rebuilders.push(
                    this._buildWidgetGroup(window, page, store, descriptor));
            }
        } else {
            page.add(new Adw.PreferencesGroup({
                title: 'Widgets',
                description: 'No installed widget package needs a file to be ' +
                    'created. Right-click the desktop to add widgets.',
            }));
        }

        // Declarado ANTES de `rebuildAll` porque a função o lê: um `let`
        // depois da primeira chamada seria uma TDZ, não um `undefined`.
        let disposed = false;
        const rebuildAll = () => {
            // A janela pode ter sido fechada entre a escrita externa e este
            // callback; mexer nas linhas depois disso é tocar em widgets GTK
            // já destruídos.
            if (disposed) return;
            for (const rebuild of rebuilders) rebuild();
        };
        rebuildAll();

        const unsubscribe = store.onExternalChange(rebuildAll);
        const cleanup = () => {
            if (disposed) return;
            disposed = true;
            try { unsubscribe?.(); } catch (_) {}
            try { store.destroy(); } catch (_) {}
        };
        window.connect('close-request', () => { cleanup(); return false; });
        window.connect('destroy', cleanup);
    }

    /**
     * Um grupo por pacote: o botão de criar e a lista de instâncias.
     *
     * @param {Adw.PreferencesWindow} window
     * @param {Adw.PreferencesPage} page
     * @param {WidgetStore} store
     * @param {object} descriptor o manifest já validado
     * @returns {() => void} refaz as linhas deste grupo
     */
    _buildWidgetGroup(window, page, store, descriptor) {
        // O PRIMEIRO ajuste de arquivo é o que identifica a instância na
        // lista. Um pacote com dois arquivos continua funcionando; só o
        // primeiro vira título de linha, e os outros se trocam pelo menu do
        // widget na área de trabalho.
        const setting = descriptor.fileSettings[0];
        const grid = `${descriptor.defaultColSpan} × ${descriptor.defaultRowSpan}`;
        const group = new Adw.PreferencesGroup({
            title: descriptor.name,
            description: `Starts at ${grid} grid cells. Moving and resizing ` +
                'always snaps back to the desktop grid.',
        });
        page.add(group);

        const addRow = new Adw.ActionRow({
            title: `Add ${descriptor.name.toLowerCase()}`,
            subtitle: `Choose the file for "${setting.label}".`,
        });
        const addButton = new Gtk.Button({
            label: 'Choose file…',
            valign: Gtk.Align.CENTER,
        });
        addRow.add_suffix(addButton);
        addRow.activatable_widget = addButton;
        group.add(addRow);

        let rows = [];
        const rebuild = () => {
            for (const row of rows) group.remove(row);
            rows = [];
            store.reload();
            for (const widget of store.list()) {
                if (widget.type !== descriptor.id) continue;
                const path = widget.config?.[setting.key] ?? '';
                const row = new Adw.ActionRow({
                    title: GLib.path_get_basename(path) || descriptor.name,
                    subtitle: path,
                    subtitle_lines: 1,
                });
                row.add_prefix(new Gtk.Image({
                    gicon: path
                        ? new Gio.FileIcon({file: Gio.File.new_for_path(path)})
                        : null,
                    pixel_size: 40,
                }));
                const remove = new Gtk.Button({
                    icon_name: ICON.REMOVE,
                    tooltip_text: 'Remove widget',
                    valign: Gtk.Align.CENTER,
                });
                remove.add_css_class('flat');
                remove.connect('clicked', () => {
                    store.remove(widget.id);
                    rebuild();
                    this._toast(window, 'Widget removed.');
                });
                row.add_suffix(remove);
                rows.push(row);
                group.add(row);
            }
        };

        addButton.connect('clicked', () => {
            const chooser = new Gtk.FileChooserNative({
                title: `Choose a file for "${setting.label}"`,
                transient_for: window,
                action: Gtk.FileChooserAction.OPEN,
                accept_label: 'Add',
                cancel_label: 'Cancel',
            });
            for (const filter of this._fileFilters(descriptor, setting))
                chooser.add_filter(filter);
            chooser.connect('response', (_dialog, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const path = chooser.get_file()?.get_path();
                    // A pegada e o resto da config vêm do manifest; aqui só
                    // entra o caminho, que é a única coisa que o seletor sabe.
                    if (path && store.add(descriptor.id, {
                        config: {[setting.key]: path},
                    })) {
                        rebuild();
                        this._toast(window, `${descriptor.name} added.`);
                    }
                }
                chooser.destroy();
            });
            chooser.show();
        });

        return rebuild;
    }

    /**
     * Filtros do seletor, declarados pelo manifest em `mimeTypes`. Sem
     * declaração o seletor não filtra nada — um pacote que aceita qualquer
     * arquivo não deve ter os seus escondidos por um palpite nosso.
     *
     * @param {object} descriptor o manifest já validado
     * @param {{key: string, label: string}} setting
     * @returns {Gtk.FileFilter[]}
     */
    _fileFilters(descriptor, setting) {
        const declared = descriptor.settings?.[setting.key]?.mimeTypes;
        const mimeTypes = Array.isArray(declared) ? declared : [];
        if (!mimeTypes.length) return [];
        const filter = new Gtk.FileFilter();
        filter.set_name(setting.label);
        for (const mimeType of mimeTypes) filter.add_mime_type(mimeType);
        return [filter];
    }

    /** Página "Appearance": tamanho do ícone, tema, rótulo e origem da grade. */
    _buildAppearancePage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: ICON.APPEARANCE_PAGE,
        });
        window.add(page);

        const iconsGroup = new Adw.PreferencesGroup({
            title: 'Icons',
            description:
                'The cell around each icon grows with it, so a larger size means fewer slots fit on screen.',
        });
        page.add(iconsGroup);

        iconsGroup.add(this._makeSliderRow({
            title: 'Icon size',
            subtitle: 'Size in pixels of each desktop icon.',
            lower: ICON_SIZE.MIN,
            upper: ICON_SIZE.MAX,
            step: ICON_SIZE.STEP,
            page: ICON_SIZE.PAGE,
            digits: 0,
            marks: [ICON_SIZE.MIN, ICON_SIZE.DEFAULT, ICON_SIZE.MAX],
            value: settings.get_int('icon-size'),
            format: (value) => `${Math.round(value)} px`,
            // Toda escrita passa por um read-compare, senão o `value-changed`
            // do Gtk.Adjustment gravaria a cada pixel arrastado e o
            // `changed::` de volta reconstruiria a superfície no meio do
            // gesto. `icon-size` é `i`, então o compare é exato — uma key `d`
            // precisaria de epsilon, porque o passo de um Adjustment carrega
            // lixo binário e um `!==` seria sempre verdadeiro.
            onChanged: (value) => {
                const rounded = Math.round(value);
                if (settings.get_int('icon-size') !== rounded)
                    settings.set_int('icon-size', rounded);
            },
        }));

        const styleGroup = new Adw.PreferencesGroup({ title: 'Desktop style' });
        page.add(styleGroup);

        styleGroup.add(this._makeComboRow({
            settings,
            key: 'desk-theme',
            title: 'Theme',
            options: DESK_THEMES,
        }));
        styleGroup.add(this._makeComboRow({
            settings,
            key: 'label-position',
            title: 'Labels',
            options: LABEL_POSITIONS,
        }));

        const gridGroup = new Adw.PreferencesGroup({
            title: 'Grid',
            description:
                'Stored item positions are column/row indices counted from the origin, so changing the origin mirrors the whole desktop.',
        });
        page.add(gridGroup);

        gridGroup.add(this._makeComboRow({
            settings,
            key: 'grid-origin',
            title: 'Origin corner',
            options: GRID_ORIGINS,
        }));

        gridGroup.add(this._makeSliderRow({
            title: 'Bottom margin',
            subtitle: 'Space kept free below the last row, useful for an overlay dock.',
            lower: GRID_BOTTOM_MARGIN.MIN,
            upper: GRID_BOTTOM_MARGIN.MAX,
            step: GRID_BOTTOM_MARGIN.STEP,
            page: GRID_BOTTOM_MARGIN.PAGE,
            digits: 0,
            marks: [0, 64, 96, 128, 192, 256],
            value: settings.get_int('grid-bottom-margin'),
            format: (value) => `${Math.round(value)} px`,
            onChanged: (value) => {
                const rounded = Math.round(value);
                if (settings.get_int('grid-bottom-margin') !== rounded)
                    settings.set_int('grid-bottom-margin', rounded);
            },
        }));

        const debugRow = new Adw.ActionRow({
            title: 'Show monitor boundaries',
            subtitle:
                'Draw a diagnostic border around each desktop surface and write its geometry to the journal.',
        });
        gridGroup.add(debugRow);

        const debugSwitch = new Gtk.Switch({
            active: settings.get_boolean('debug-outline'),
            valign: Gtk.Align.CENTER,
        });
        debugSwitch.connect('notify::active', () => {
            if (settings.get_boolean('debug-outline') !== debugSwitch.active)
                settings.set_boolean('debug-outline', debugSwitch.active);
        });
        debugRow.add_suffix(debugSwitch);
        debugRow.activatable_widget = debugSwitch;
    }

    /** Página "Behavior": os três interruptores. */
    _buildBehaviorPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Behavior',
            icon_name: ICON.BEHAVIOR_PAGE,
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({ title: 'Interaction' });
        page.add(group);

        // Sem helper de switch, de propósito: cada row tem título, subtítulo e
        // key próprios, e o helper acabaria só empacotando cinco linhas de
        // boilerplate atrás de um objeto de parâmetros do mesmo tamanho.
        const doubleClickRow = new Adw.ActionRow({
            title: 'Double click to open',
            subtitle:
                'A single click selects an item and a double click opens it. When off, a single click opens it right away and there is no selection step.',
        });
        group.add(doubleClickRow);

        const doubleClickSwitch = new Gtk.Switch({
            active: settings.get_boolean('double-click-to-open'),
            valign: Gtk.Align.CENTER,
        });
        doubleClickSwitch.connect('notify::active', () => {
            if (settings.get_boolean('double-click-to-open') !== doubleClickSwitch.active)
                settings.set_boolean('double-click-to-open', doubleClickSwitch.active);
        });
        doubleClickRow.add_suffix(doubleClickSwitch);
        doubleClickRow.activatable_widget = doubleClickSwitch;

        const fullscreenRow = new Adw.ActionRow({
            title: 'Hide while a window is fullscreen',
            subtitle:
                'Stop painting the desktop entirely under a fullscreen window. The surface already sits below every window, so this is a rendering saving rather than a visibility fix.',
        });
        group.add(fullscreenRow);

        const fullscreenSwitch = new Gtk.Switch({
            active: settings.get_boolean('hide-in-fullscreen'),
            valign: Gtk.Align.CENTER,
        });
        fullscreenSwitch.connect('notify::active', () => {
            if (settings.get_boolean('hide-in-fullscreen') !== fullscreenSwitch.active)
                settings.set_boolean('hide-in-fullscreen', fullscreenSwitch.active);
        });
        fullscreenRow.add_suffix(fullscreenSwitch);
        fullscreenRow.activatable_widget = fullscreenSwitch;

        const compatGroup = new Adw.PreferencesGroup({
            title: 'Compatibility',
            description:
                'ArcDesk draws its own virtual desktop. It is not backed by ~/Desktop, and it does not read or write files there.',
        });
        page.add(compatGroup);

        const dingRow = new Adw.ActionRow({
            title: 'Warn when Desktop Icons NG is enabled',
            subtitle:
                'DING draws icons over the same pixels. Show a one-time notification the next time both are active. ArcDesk turns this back off once it has told you.',
        });
        compatGroup.add(dingRow);

        const dingSwitch = new Gtk.Switch({
            active: settings.get_boolean('warn-about-ding'),
            valign: Gtk.Align.CENTER,
        });
        dingSwitch.connect('notify::active', () => {
            if (settings.get_boolean('warn-about-ding') !== dingSwitch.active)
                settings.set_boolean('warn-about-ding', dingSwitch.active);
        });
        dingRow.add_suffix(dingSwitch);
        dingRow.activatable_widget = dingSwitch;
    }

    /**
     * Página "Items": o que está na área de trabalho, na ordem de `desk-items`.
     *
     * prefs.js roda em outro processo, então escrever nas keys já basta: o
     * DeskLayout de dentro da shell escuta e a superfície se reconstrói
     * sozinha. `deskLayout.js` só importa GLib e Gio justamente para poder ser
     * reusado daqui — se este arquivo algum dia precisar de St ou Shell, o
     * caminho está errado.
     *
     * `DeskLayout.build()` pede `Shell.App[]`, que não existe neste processo;
     * por isso a lista é montada de `layout.order` + `parseDeskId`, e os nomes
     * e ícones vêm de `Gio.DesktopAppInfo`, que é GIO e está disponível aqui.
     */
    _buildItemsPage(window, settings) {
        const layout = new DeskLayout(settings);

        const page = new Adw.PreferencesPage({
            title: 'Items',
            icon_name: ICON.ITEMS_PAGE,
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'On the desktop',
            description:
                'Items are added from the desktop itself or from ArcDock’s "Add to desktop" action. Here you can only take them off. Each row shows which monitor the item is stored on; drag the icon across screens to change it.',
        });
        page.add(group);

        // Rows recriadas do zero a cada mudança: a lista tem poucas dezenas de
        // itens e a mutação incremental erraria a ordem com facilidade.
        let rows = [];
        let disposed = false;

        const rebuild = () => {
            if (disposed)
                return;

            for (const row of rows)
                group.remove(row);
            rows = [];

            layout.reload();

            const folders = this._readFolders(settings);
            // Lido cru, e não por `layout.placementOf()`, pela mesma razão de
            // `_readFolders`: aqui só se EXIBE o que está gravado, sem passar
            // pelas regras de clamp e de migração do modelo — quem migra o
            // registro v1 é o primeiro build da shell, não a janela de
            // preferências.
            const placements = this._readPlacements(settings);
            const ids = layout.order ?? [];

            if (ids.length === 0) {
                rows.push(this._makeEmptyRow());
            } else {
                for (const id of ids) {
                    rows.push(this._makeItemRow({
                        id,
                        folders,
                        placement: placements[id] ?? null,
                        onRemove: () => {
                            layout.removeItem(id);
                            // A nossa própria escrita tem o eco suprimido, então
                            // onExternalChange NÃO dispara aqui: reconstruir na mão
                            // é o que mantém a lista igual ao que foi gravado.
                            rebuild();
                            this._toast(window, 'Removed from the desktop.');
                        },
                    }));
                }
            }

            for (const row of rows)
                group.add(row);
        };

        rebuild();

        // A área de trabalho pode ganhar ou perder itens com esta janela
        // aberta (menu de contexto do ícone, ArcDock); sem isto a lista
        // mostraria estado obsoleto.
        const unsubscribe = layout.onExternalChange(rebuild);

        // close-request (e não unmap, que dispara em qualquer ocultação da
        // janela) é o ponto certo do encerramento pela mão do usuário;
        // `destroy` cobre a janela derrubada por fora, ex: extensão
        // recarregada. O cleanup é idempotente, então os dois podem coexistir.
        const cleanup = () => {
            if (disposed)
                return;
            disposed = true;
            try { unsubscribe?.(); } catch (_) {}
            try { layout.destroy(); } catch (_) {}
        };
        window.connect('close-request', () => {
            cleanup();
            return false;
        });
        window.connect('destroy', cleanup);
    }

    _makeEmptyRow() {
        const row = new Adw.ActionRow({
            title: 'Nothing on the desktop yet',
            subtitle:
                'Use "Add to desktop" from an ArcDock icon, or drop an app onto the desktop surface.',
        });
        row.add_prefix(new Gtk.Image({ icon_name: ICON.FOLDER }));
        row.add_css_class('dim-label');
        return row;
    }

    /** Uma row por id de `desk-items`, na ordem em que a key os guarda. */
    _makeItemRow({ id, folders, placement, onRemove }) {
        const parsed = parseDeskId(id);
        const descriptor = this._describe(parsed, folders, id);

        const row = new Adw.ActionRow({
            title: descriptor.title,
            subtitle: descriptor.subtitle,
            // Caminhos longos não devem esticar a janela.
            subtitle_lines: 1,
        });

        const image = new Gtk.Image();
        if (descriptor.gicon)
            image.set_from_gicon(descriptor.gicon);
        else
            image.icon_name = descriptor.iconName;
        row.add_prefix(image);

        // Somente exibição: um Gtk.Label, não um controle. Fica ANTES do botão
        // de remover para que a posição do botão não dance de row para row.
        const monitorLabel = new Gtk.Label({
            label: this._describeMonitor(placement),
            valign: Gtk.Align.CENTER,
            tooltip_text:
                'Monitors are stored by index. If that screen is unplugged the item is shown on the primary one, and its stored position is kept untouched until the screen comes back.',
        });
        monitorLabel.add_css_class('dim-label');
        monitorLabel.add_css_class('caption');
        row.add_suffix(monitorLabel);

        const removeButton = new Gtk.Button({
            icon_name: ICON.REMOVE,
            tooltip_text: 'Remove from the desktop',
            valign: Gtk.Align.CENTER,
        });
        removeButton.add_css_class('flat');
        removeButton.connect('clicked', () => onRemove());
        row.add_suffix(removeButton);

        return row;
    }

    /**
     * Título, subtítulo e ícone de um id.
     *
     * Um tipo que esta versão não conhece NÃO some da lista: ele continua
     * gravado na key, e escondê-lo aqui daria ao usuário a impressão de que já
     * não existe. Aparece como "Unknown item", com o id cru como subtítulo.
     */
    _describe(parsed, folders, rawId) {
        if (!parsed) {
            return {
                title: 'Unknown item',
                subtitle: rawId,
                iconName: ICON.UNKNOWN,
                gicon: null,
            };
        }

        if (parsed.type === DeskItemType.APP) {
            const info = this._appInfo(parsed.value);
            return {
                title: info?.get_name() ?? parsed.value,
                subtitle: info ? parsed.value : `${parsed.value} — not installed`,
                iconName: ICON.APP,
                gicon: info?.get_icon() ?? null,
            };
        }

        if (parsed.type === DeskItemType.FOLDER) {
            // A key é guardada pelo uuid PELADO, sem o prefixo "folder:".
            const record = folders[parsed.value] ?? null;
            const count = record?.apps?.length ?? 0;
            return {
                title: record?.name ?? 'Folder',
                subtitle: count === 1 ? '1 app' : `${count} apps`,
                iconName: ICON.FOLDER,
                gicon: null,
            };
        }

        if (parsed.type === DeskItemType.PATH) {
            return {
                title: GLib.path_get_basename(parsed.value) || parsed.value,
                subtitle: this._displayPath(parsed.value),
                iconName: ICON.FOLDER,
                gicon: this._pathGicon(parsed.value),
            };
        }

        return {
            title: 'Unknown item',
            subtitle: rawId,
            iconName: ICON.UNKNOWN,
            gicon: null,
        };
    }

    /** `desk-folders` só para exibir nome e contagem; o modelo é do shell. */
    _readFolders(settings) {
        try {
            const parsed = JSON.parse(settings.get_string('desk-folders'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            // JSON corrompido não pode derrubar a janela de preferências: a
            // lista simplesmente mostra as pastas sem nome.
            return {};
        }
    }

    /**
     * `desk-placements` só para exibir em que monitor cada item está; quem
     * escreve essas posições é o modelo dentro da shell.
     */
    _readPlacements(settings) {
        try {
            const parsed = JSON.parse(settings.get_string('desk-placements'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            // JSON corrompido não pode derrubar a janela: sem posições, cada
            // row só deixa de mostrar o monitor.
            return {};
        }
    }

    /**
     * Rótulo do monitor de um registro de `desk-placements`.
     *
     * `mon` é OPCIONAL na leitura: um registro sem ele foi gravado pela v1,
     * que só desenhava no primário, então é isso que ele significa — e não
     * "desconhecido". Um `mon` não-inteiro ou negativo conta como ausente,
     * exatamente como no modelo. O índice é 0-based na key e 1-based aqui,
     * porque é assim que o painel Displays do GNOME numera as telas.
     */
    _describeMonitor(placement) {
        if (!placement || typeof placement !== 'object')
            return MONITOR_LABEL.UNPLACED;

        const mon = placement.mon;
        if (!Number.isInteger(mon) || mon < 0)
            return MONITOR_LABEL.PRIMARY;

        return `Monitor ${mon + 1}`;
    }

    /** Gio.DesktopAppInfo é GIO, disponível fora do processo da shell. */
    _appInfo(appId) {
        try {
            return Gio.DesktopAppInfo.new(appId);
        } catch (_) {
            return null;
        }
    }

    /** Ícone real da pasta (Downloads, Music...), null se indisponível. */
    _pathGicon(path) {
        try {
            const info = Gio.File.new_for_path(path).query_info(
                'standard::symbolic-icon',
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
            return info.get_symbolic_icon();
        } catch (_) {
            // Pasta removida, sem permissão ou montagem lenta: cai no fallback.
            return null;
        }
    }

    /** Caminho com `~` no lugar do home, como o usuário está acostumado a ler. */
    _displayPath(path) {
        const home = GLib.get_home_dir();
        if (!home)
            return path;
        if (path === home)
            return '~';
        if (path.startsWith(`${home}/`))
            return `~${path.slice(home.length)}`;
        return path;
    }

    /** Row com Gtk.Scale + rótulo do valor, no formato da row "Icon size". */
    _makeSliderRow(params) {
        const row = new Adw.ActionRow({
            title: params.title,
            subtitle: params.subtitle ?? '',
        });

        const valueLabel = new Gtk.Label({ width_chars: 6, xalign: 1 });

        const adjustment = new Gtk.Adjustment({
            lower: params.lower,
            upper: params.upper,
            step_increment: params.step,
            page_increment: params.page,
            value: params.value,
        });

        const scale = new Gtk.Scale({
            adjustment,
            digits: params.digits,
            draw_value: false,
            hexpand: true,
            width_request: 220,
            valign: Gtk.Align.CENTER,
        });
        for (const mark of params.marks ?? [])
            scale.add_mark(mark, Gtk.PositionType.BOTTOM, null);

        const updateLabel = () => {
            valueLabel.label = params.format(adjustment.value);
        };
        updateLabel();

        adjustment.connect('value-changed', () => {
            updateLabel();
            params.onChanged(adjustment.value);
        });

        const controls = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER });
        controls.append(scale);
        controls.append(valueLabel);
        row.add_suffix(controls);
        row.activatable_widget = scale;

        return row;
    }

    /**
     * Combo para uma key `s` com <choices>: a ordem do array É a ordem do
     * modelo, e o índice selecionado indexa os `value`.
     */
    _makeComboRow({ settings, key, title, options }) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(options.map((option) => option.title)),
        });

        const current = settings.get_string(key);
        const index = options.findIndex((option) => option.value === current);
        // -1 só acontece se a key trouxer um valor de uma versão futura; cair
        // no primeiro item é melhor do que deixar o combo em branco.
        row.selected = index === -1 ? 0 : index;
        row.subtitle = options[row.selected].subtitle;

        row.connect('notify::selected', () => {
            const option = options[row.selected];
            if (!option)
                return;
            row.subtitle = option.subtitle;
            if (settings.get_string(key) !== option.value)
                settings.set_string(key, option.value);
        });

        return row;
    }

    _toast(window, message) {
        if (typeof window?.add_toast !== 'function')
            return;
        window.add_toast(new Adw.Toast({ title: message, timeout: TOAST.TIMEOUT_S }));
    }
}
