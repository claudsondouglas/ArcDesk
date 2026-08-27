import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Leitura e validação dos `manifest.json` dos pacotes de widget.
 *
 * ---------------------------------------------------------------------
 * POR QUE ESTE ARQUIVO SÓ IMPORTA GLib E Gio
 * ---------------------------------------------------------------------
 *
 * Pela mesma razão do `deskLayout.js`: o `prefs.js` roda em OUTRO processo,
 * sem `St`, sem `Shell` e sem `Main`, e também precisa saber quais widgets
 * existem — para listar, para validar spans e para descobrir quais deles têm
 * uma configuração de arquivo. Um registry que vive só dentro da shell não é
 * visível para as preferências; um manifest em disco é visível para os dois.
 *
 * É por isso que o manifest é a FONTE DA VERDADE e o módulo JS é apenas o
 * desenho. Tudo que o ArcDesk precisa saber para posicionar, dimensionar e
 * oferecer um widget está no JSON; o `.js` só é carregado quando o widget
 * realmente vai ser pintado.
 *
 * ---------------------------------------------------------------------
 * ONDE OS PACOTES SÃO PROCURADOS
 * ---------------------------------------------------------------------
 *
 * 1. `<extensão>/widgets/<id>/`            — os que vêm na caixa
 * 2. `~/.local/share/arcdesk/widgets/<id>/` — os do usuário
 *
 * O segundo SOBREPÕE o primeiro quando os dois trazem o mesmo `id`. É de
 * propósito: é assim que se desenvolve um widget (ou se substitui um dos
 * nossos) sem editar a extensão instalada. A sobreposição é avisada no
 * journal, porque um override esquecido explica sozinho um "minha correção
 * não fez nada".
 *
 * A raiz da extensão vem do `import.meta.url` deste próprio arquivo
 * (`<raiz>/src/widgetManifest.js`), e não de um parâmetro: o `prefs.js`
 * conhece o seu `this.path`, mas o `DeskManager` não conhece nenhum, e
 * plumbing de caminho por três camadas para chegar aqui seria puro ruído.
 */

const MANIFEST_FILE = 'manifest.json';
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const READ_ATTRIBUTES = 'standard::name,standard::type';
const BATCH = 32;

export const MANIFEST_LIMITS = Object.freeze({
    SPAN_MIN: 1,
    SPAN_MAX: 64,
    PIXEL_MIN: 16,
    PIXEL_MAX: 4096,
    SPAN_FALLBACK: 4,
    PIXEL_FALLBACK: 80,
});

/** Subdiretório do usuário, relativo a `XDG_DATA_HOME`. */
export const USER_WIDGETS_SUBPATH = Object.freeze(['arcdesk', 'widgets']);

function _clamp(value, fallback, min, max) {
    const number = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
}

/** Raiz da extensão, deduzida deste módulo: `<raiz>/src/widgetManifest.js`. */
function _extensionRoot() {
    try {
        const [path] = GLib.filename_from_uri(import.meta.url);
        return GLib.path_get_dirname(GLib.path_get_dirname(path));
    } catch (e) {
        logError(e, '[ArcDesk] could not resolve the extension root');
        return null;
    }
}

/**
 * Raízes de busca, na ordem em que são varridas. A ÚLTIMA vence um empate
 * de `id`.
 *
 * @returns {string[]}
 */
export function widgetSearchPaths() {
    const roots = [];
    const root = _extensionRoot();
    if (root) roots.push(GLib.build_filenamev([root, 'widgets']));
    roots.push(GLib.build_filenamev(
        [GLib.get_user_data_dir(), ...USER_WIDGETS_SUBPATH]));
    return roots;
}

function _gridSize(raw, fallbackColumns, fallbackRows) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        columns: _clamp(source.columns, fallbackColumns,
            MANIFEST_LIMITS.SPAN_MIN, MANIFEST_LIMITS.SPAN_MAX),
        rows: _clamp(source.rows, fallbackRows,
            MANIFEST_LIMITS.SPAN_MIN, MANIFEST_LIMITS.SPAN_MAX),
    };
}

/**
 * Configuração inicial de uma instância: os `default` declarados em
 * `settings`, com o bloco `defaultConfig` por cima.
 *
 * Os dois são MESCLADOS POR BAIXO do que o usuário já gravou — um default de
 * manifest descreve o começo de uma instância, não uma verdade que reescreve
 * a escolha de quem usa.
 */
function _defaultConfig(raw) {
    const config = {};
    const settings = raw.settings && typeof raw.settings === 'object' &&
        !Array.isArray(raw.settings) ? raw.settings : {};
    for (const [key, setting] of Object.entries(settings)) {
        if (setting && typeof setting === 'object' && 'default' in setting)
            config[key] = setting.default;
    }
    if (raw.defaultConfig && typeof raw.defaultConfig === 'object' &&
        !Array.isArray(raw.defaultConfig))
        Object.assign(config, raw.defaultConfig);
    return config;
}

/** Ajustes do tipo `file`: é o que vira item "Mudar …" no menu do widget. */
function _fileSettings(raw) {
    const settings = raw.settings && typeof raw.settings === 'object' &&
        !Array.isArray(raw.settings) ? raw.settings : {};
    const items = [];
    for (const [key, setting] of Object.entries(settings)) {
        if (setting?.type !== 'file') continue;
        items.push(Object.freeze({
            key,
            label: typeof setting.label === 'string' && setting.label
                ? setting.label : key,
        }));
    }
    return Object.freeze(items);
}

/**
 * Valida um manifest já parseado.
 *
 * @param {object} raw o JSON cru
 * @param {string} dirPath diretório do pacote
 * @param {string} dirName nome desse diretório
 * @returns {object|null} descritor congelado, ou null se o manifest é inválido
 */
export function parseManifest(raw, dirPath, dirName) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!ID_PATTERN.test(id)) {
        console.warn(`[ArcDesk] widget manifest with an invalid id in ${dirPath}`);
        return null;
    }
    // O DIRETÓRIO é a identidade. Sem isso dois pacotes poderiam declarar o
    // mesmo id e o vencedor dependeria da ordem de leitura do filesystem.
    if (id !== dirName) {
        console.warn(`[ArcDesk] widget "${id}" lives in ${dirName}/ — ` +
            'the id and the directory name must match');
        return null;
    }

    const entry = typeof raw.entry === 'string' ? raw.entry : '';
    // O entry é resolvido contra o diretório do pacote e nunca sai dele: um
    // manifest é um arquivo de dados, e um arquivo de dados não escolhe qual
    // módulo do sistema a shell vai importar.
    if (!entry.endsWith('.js') || entry.includes('/') || entry.includes('\\') ||
        entry.startsWith('.')) {
        console.warn(`[ArcDesk] widget "${id}" has an invalid entry: ${entry}`);
        return null;
    }

    const defaultGrid = _gridSize(raw.defaultGridSize,
        MANIFEST_LIMITS.SPAN_FALLBACK, MANIFEST_LIMITS.SPAN_FALLBACK);
    const minGrid = _gridSize(raw.minGridSize, 1, 1);
    const minSize = raw.minSize && typeof raw.minSize === 'object'
        ? raw.minSize : {};
    const entryPath = GLib.build_filenamev([dirPath, entry]);
    const fileSettings = _fileSettings(raw);

    return Object.freeze({
        id,
        name: typeof raw.name === 'string' && raw.name ? raw.name : id,
        version: _clamp(raw.version, 1, 0, Number.MAX_SAFE_INTEGER),
        dir: dirPath,
        entryPath,
        entryUri: Gio.File.new_for_path(entryPath).get_uri(),
        defaultColSpan: defaultGrid.columns,
        defaultRowSpan: defaultGrid.rows,
        // Um mínimo maior que o padrão seria uma instância nova já inválida.
        minColSpan: Math.min(minGrid.columns, defaultGrid.columns),
        minRowSpan: Math.min(minGrid.rows, defaultGrid.rows),
        minWidth: _clamp(minSize.width, MANIFEST_LIMITS.PIXEL_FALLBACK,
            MANIFEST_LIMITS.PIXEL_MIN, MANIFEST_LIMITS.PIXEL_MAX),
        minHeight: _clamp(minSize.height, MANIFEST_LIMITS.PIXEL_FALLBACK,
            MANIFEST_LIMITS.PIXEL_MIN, MANIFEST_LIMITS.PIXEL_MAX),
        resizable: raw.resizable !== false,
        // "Configurável" significa que a instância NÃO pode nascer pronta a
        // partir do menu do fundo: falta um dado obrigatório que só as
        // preferências sabem pedir.
        configurable: typeof raw.configurable === 'boolean'
            ? raw.configurable
            : Object.values(raw.settings ?? {}).some(
                setting => setting?.required === true),
        styleClass: typeof raw.styleClass === 'string' && raw.styleClass
            ? raw.styleClass : null,
        defaultConfig: Object.freeze(_defaultConfig(raw)),
        fileSettings,
        settings: Object.freeze({...(raw.settings ?? {})}),
    });
}

function _acceptInto(map, descriptor) {
    if (!descriptor) return;
    const previous = map.get(descriptor.id);
    if (previous) {
        console.warn(`[ArcDesk] widget "${descriptor.id}" in ${descriptor.dir} ` +
            `overrides the one in ${previous.dir}`);
    }
    map.set(descriptor.id, descriptor);
}

function _parseText(text, dirPath, dirName) {
    let raw = null;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        console.warn(`[ArcDesk] ${dirName}/${MANIFEST_FILE} is not valid JSON: ${e}`);
        return null;
    }
    return parseManifest(raw, dirPath, dirName);
}

// --- varredura assíncrona (shell) -----------------------------------------

function _subdirectories(rootPath, cancellable) {
    return new Promise((resolve) => {
        Gio.File.new_for_path(rootPath).enumerate_children_async(
            READ_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable,
            (source, result) => {
                let enumerator = null;
                try {
                    enumerator = source.enumerate_children_finish(result);
                } catch (_) {
                    // Uma raiz que não existe é o caso NORMAL: a maioria das
                    // sessões nunca cria o diretório do usuário.
                    resolve([]);
                    return;
                }
                _drain(enumerator, [], cancellable, resolve);
            });
    });
}

function _drain(enumerator, names, cancellable, resolve) {
    enumerator.next_files_async(BATCH, GLib.PRIORITY_DEFAULT, cancellable,
        (source, result) => {
            let infos = [];
            try {
                infos = source.next_files_finish(result);
            } catch (_) {
                resolve(names);
                return;
            }
            if (!infos.length) {
                resolve(names);
                return;
            }
            for (const info of infos) {
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    names.push(info.get_name());
            }
            _drain(enumerator, names, cancellable, resolve);
        });
}

function _readText(path, cancellable) {
    return new Promise((resolve) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable,
            (source, result) => {
                try {
                    const [ok, bytes] = source.load_contents_finish(result);
                    resolve(ok ? new TextDecoder().decode(bytes) : null);
                } catch (_) {
                    resolve(null);
                }
            });
    });
}

/**
 * Varre as raízes e devolve os manifests válidos.
 *
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<Map<string, object>>}
 */
export async function loadManifests(cancellable = null) {
    const found = new Map();
    for (const root of widgetSearchPaths()) {
        for (const dirName of await _subdirectories(root, cancellable)) {
            const dirPath = GLib.build_filenamev([root, dirName]);
            const text = await _readText(
                GLib.build_filenamev([dirPath, MANIFEST_FILE]), cancellable);
            if (text === null) continue;
            _acceptInto(found, _parseText(text, dirPath, dirName));
        }
    }
    return found;
}

// --- varredura síncrona (prefs) -------------------------------------------

/**
 * A mesma varredura, síncrona.
 *
 * Só pode ser chamada do `prefs.js`: é outro processo, e uma janela de
 * preferências travada num diretório lento não é um compositor travado. É a
 * mesma licença que o `prefs.js` já usa para o `query_info()` das pastas.
 *
 * @returns {Map<string, object>}
 */
export function loadManifestsSync() {
    const found = new Map();
    for (const root of widgetSearchPaths()) {
        let enumerator = null;
        try {
            enumerator = Gio.File.new_for_path(root).enumerate_children(
                READ_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            continue;
        }
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
            const dirName = info.get_name();
            const dirPath = GLib.build_filenamev([root, dirName]);
            try {
                const [ok, bytes] = Gio.File.new_for_path(
                    GLib.build_filenamev([dirPath, MANIFEST_FILE]))
                    .load_contents(null);
                if (!ok) continue;
                _acceptInto(found, _parseText(
                    new TextDecoder().decode(bytes), dirPath, dirName));
            } catch (_) {}
        }
        enumerator.close(null);
    }
    return found;
}

/**
 * Restrições que o `WidgetStore` aplica a um registro. É a ÚNICA coisa que o
 * store sabe sobre um tipo — ele nunca conhece nomes de widget.
 *
 * @param {Map<string, object>|(() => Map<string, object>)} source
 * @returns {(type: string) => object|null}
 */
export function constraintsFrom(source) {
    const resolve = typeof source === 'function' ? source : () => source;
    return (type) => {
        const descriptor = resolve()?.get?.(type) ?? null;
        if (!descriptor) return null;
        return {
            defaultColSpan: descriptor.defaultColSpan,
            defaultRowSpan: descriptor.defaultRowSpan,
            minColSpan: descriptor.minColSpan,
            minRowSpan: descriptor.minRowSpan,
            resizable: descriptor.resizable,
            defaultConfig: descriptor.defaultConfig,
        };
    };
}
