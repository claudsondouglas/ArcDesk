import { loadManifests, constraintsFrom } from './widgetManifest.js';

/**
 * O catálogo de widgets em memória.
 *
 * ---------------------------------------------------------------------
 * POR QUE O CARREGAMENTO É ASSÍNCRONO
 * ---------------------------------------------------------------------
 *
 * Porque as duas metades dele são. A varredura dos manifests é I/O, e I/O
 * síncrono dentro da shell trava a sessão inteira num diretório lento — a
 * mesma regra que já vale para os ícones de pasta. E o `import()` dinâmico
 * de um módulo ESM devolve uma Promise por definição da linguagem; não há
 * versão síncrona dele em GJS.
 *
 * A consequência é visível e é aceitável: os widgets aparecem alguns frames
 * depois dos ícones. Quem fecha esse ciclo é o `DeskManager`, que chama
 * `loadWidgets()` no construtor e reconcilia as superfícies quando a Promise
 * resolve. Enquanto ela não resolve, `widgetDefinition()` devolve null e as
 * superfícies simplesmente não desenham widget nenhum — sem erro, sem
 * registro perdido.
 *
 * ---------------------------------------------------------------------
 * O CATÁLOGO SOBREVIVE AO disable()
 * ---------------------------------------------------------------------
 *
 * De propósito, e `DeskManager.destroy()` NÃO o esvazia. Toda mudança de
 * aparência destrói e reconstrói o gerente; esvaziar aqui faria os widgets
 * piscarem a cada arrastada de slider. E não há vazamento a evitar: o GJS
 * mantém para sempre todo módulo já importado, então o catálogo não segura
 * nada que o cache de módulos já não segurasse. Quem precisa reler o disco
 * pede `loadWidgets({force: true})` — o que enxerga um PACOTE novo, mas não
 * uma EDIÇÃO num pacote já carregado. Para essa, continua valendo o de
 * sempre: sair da sessão e entrar de novo.
 *
 * ---------------------------------------------------------------------
 * O CONTRATO DO MÓDULO DE UM WIDGET
 * ---------------------------------------------------------------------
 *
 *     export function create({config}) -> {
 *         actor,                  // St.Widget, criado no construtor
 *         setSize(width, height), // px FÍSICOS, já com o scale factor
 *         updateConfig(config),   // o blob do usuário mudou
 *         activate(),             // clique sem arrasto; opcional
 *         destroy(),
 *     }
 *
 * Uma classe exportada como `default` é aceita como atalho — o loader a
 * instancia. O que o widget NUNCA faz é escolher onde fica, quanto ocupa da
 * grade ou em que monitor está: isso é do ArcDesk, e chega pronto em
 * `setSize()`.
 */

/** @type {Map<string, object>} descritores dos manifests, por id */
let _descriptors = new Map();
/** @type {Map<string, object>} definições completas (manifest + módulo) */
let _definitions = new Map();
/** @type {Promise<Map<string, object>>|null} */
let _loading = null;

function _factoryFrom(module, id) {
    if (typeof module?.create === 'function')
        return (params) => module.create(params);
    if (typeof module?.default === 'function')
        return (params) => new module.default(params);
    console.warn(`[ArcDesk] widget "${id}" exports neither create() nor a ` +
        'default class');
    return null;
}

async function _define(descriptor) {
    let module = null;
    try {
        module = await import(descriptor.entryUri);
    } catch (e) {
        logError(e, `[ArcDesk] widget "${descriptor.id}" failed to import`);
        return null;
    }
    const create = _factoryFrom(module, descriptor.id);
    if (!create) return null;
    return Object.freeze({...descriptor, create});
}

/**
 * Varre os manifests e importa os módulos. Idempotente: uma segunda chamada
 * devolve a mesma Promise.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] relê o disco mesmo já tendo carregado
 * @param {Gio.Cancellable} [options.cancellable]
 * @returns {Promise<Map<string, object>>}
 */
export function loadWidgets(options = {}) {
    if (_loading && options.force !== true) return _loading;
    _loading = (async () => {
        const descriptors = await loadManifests(options.cancellable ?? null);
        const definitions = new Map();
        for (const descriptor of descriptors.values()) {
            const definition = await _define(descriptor);
            if (definition) definitions.set(definition.id, definition);
        }
        _descriptors = descriptors;
        _definitions = definitions;
        log(`[ArcDesk] ${definitions.size} widget(s) loaded: ` +
            `${[...definitions.keys()].join(', ') || 'none'}`);
        return definitions;
    })();
    return _loading;
}

/** @returns {object|null} null enquanto não carregou, e para tipo desconhecido. */
export function widgetDefinition(type) {
    return _definitions.get(type) ?? null;
}

/** Tipos que podem ser apresentados nas interfaces de adição. */
export function availableWidgets() {
    return [...(_definitions.values())].map(definition => ({
        type: definition.id,
        name: definition.name,
        configurable: definition.configurable,
        defaultColSpan: definition.defaultColSpan,
        defaultRowSpan: definition.defaultRowSpan,
    }));
}

/**
 * Resolvedor de restrições para o `WidgetStore`, ligado ao catálogo VIVO: o
 * store é construído antes de `loadWidgets()` resolver, então uma cópia do
 * mapa tirada agora estaria sempre vazia.
 */
export const widgetConstraints = constraintsFrom(() => _descriptors);
