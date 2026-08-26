import GLib from 'gi://GLib';

import { DEFAULT_FOLDER_NAME, ItemType } from './config.js';
import { SignalTracker } from './trackers.js';

const KEY_ITEMS = 'desk-items';
const KEY_PLACEMENTS = 'desk-placements';
const KEY_FOLDERS = 'desk-folders';
const KEY_NAMES = 'desk-item-names';
const KEY_ICONS = 'desk-item-icons';

const ID_SEPARATOR = ':';

/**
 * Re-exportado a partir do config para dar a este arquivo a mesma silhueta
 * de launcherLayout.js na ArcDock (LauncherItemType/makeLauncherId/...): quem
 * já leu um dos dois modelos reconhece o outro sem procurar onde o enum mora.
 */
export const DeskItemType = ItemType;

const KNOWN_TYPES = new Set(Object.values(DeskItemType));

// Separador usado só para COMPARAR duas listas de ids como uma string só.
// U+001F (unit separator) porque não pode aparecer nem num appId nem num
// caminho de arquivo — um separador imprimível (',', ':') daria falso
// positivo de "nada mudou" para ids que o contivessem.
const LIST_SEPARATOR = '\u001f';

// Separador entre o monitor e o par col,row dentro da chave de slot. A chave
// precisa carregar o monitor porque a ocupação passou a ser POR MONITOR: dois
// itens podem legitimamente ocupar {col:0,row:0} desde que em telas
// diferentes, e uma chave só com 'col,row' os declararia em conflito.
const MONITOR_SEPARATOR = '@';

/** makeDeskId('app', 'firefox.desktop') -> 'app:firefox.desktop' */
export function makeDeskId(type, value) {
    return `${type}${ID_SEPARATOR}${value}`;
}

/**
 * parseDeskId('path:/home/u/My:Stuff') -> { type: 'path', value: '/home/u/My:Stuff' }
 *
 * Retorna null para id malformado OU de tipo desconhecido — os dois casos
 * significam a mesma coisa para quem chama: "isto não é meu, não mexa".
 * É o que permite a regra de preservação de ids de versões futuras.
 */
export function parseDeskId(id) {
    if (typeof id !== 'string')
        return null;
    // Split no PRIMEIRO ':' apenas: o value é um appId ou um CAMINHO, e um
    // caminho pode conter ':' à vontade. Um split ingênuo transformaria
    // 'path:/home/u/a:b' em algo que nunca mais abre.
    const sep = id.indexOf(ID_SEPARATOR);
    if (sep <= 0)
        return null;
    const type = id.slice(0, sep);
    const value = id.slice(sep + 1);
    if (!value || !KNOWN_TYPES.has(type))
        return null;
    return { type, value };
}

/**
 * Modelo + persistência do arranjo da área de trabalho. Não desenha nada e
 * não conhece o compositor: importa GLib (uuid, basename) e mais nada de
 * gi://, porque o prefs.js roda em OUTRO PROCESSO e reaproveita este arquivo
 * inteiro. É por isso que os Shell.App chegam INJETADOS em build().
 *
 * Três keys, e não uma:
 *   - `desk-items` (`as`) é a lista ordenada de ids tipados `type:value`. É
 *     CONTRATO PÚBLICO: a ArcDock anexa ids nela. A ordem aqui não é ordem de
 *     desenho — ela só decide em que sequência os ids sem posição recebem o
 *     primeiro slot livre;
 *   - `desk-placements` (`s`) é um JSON id -> {col,row,mon}. A grade é ESPARSA
 *     e LIVRE: cada item guarda a própria coordenada, então não existe aqui a
 *     dualidade "índice visível x índice persistido" do launcher da ArcDock;
 *   - `desk-folders` (`s`) é um JSON com o conteúdo das pastas virtuais.
 *
 * JSON dentro de um `s` porque a{sa{sv}} aninhado é doloroso de manipular dos
 * dois lados (shell e prefs), e aqui o valor é um registro dentro de um mapa.
 * As chaves DENTRO de `desk-folders` são os uuids CRUS, sem o prefixo
 * `folder:`: o prefixo só existe onde um id precisa conviver com ids de outro
 * tipo — repeti-lo no mapa seria gravá-lo em todo registro para nunca
 * desambiguar nada, e ainda daria duas grafias para a mesma pasta.
 *
 * UMA GRADE POR MONITOR. `mon` é o ÍNDICE do monitor, porque no GNOME 50 não
 * existe nome de conector do lado do shell (`Main.layoutManager.monitors[i]`
 * só carrega index/x/y/width/height/geometry_scale). Índice reembaralha quando
 * uma tela é desplugada, e a resposta a isso é a MESMA que este arquivo já
 * dava para col/row fora da grade: o valor gravado é autoritativo e NUNCA é
 * reescrito porque o hardware de agora não consegue honrá-lo. O item aparece
 * no monitor primário, no primeiro slot livre de lá, e a gravação fica
 * intacta — replugar a tela devolve o arranjo exatamente como estava. A
 * consequência é que a posição EXIBIDA e a GRAVADA podem divergir nos TRÊS
 * campos, e não só em col/row.
 *
 * `mon` é OPCIONAL na leitura: um registro sem ele veio da v1 e significa
 * "monitor primário". O primeiro build() que tiver um índice primário
 * utilizável reescreve o registro com `mon` explícito — a migração acontece
 * uma vez, em silêncio, e daí em diante o valor é estável.
 *
 * Toda validação de forma acontece numa ÚNICA porta de entrada (os _read*).
 * Depois dela, build() e todos os mutadores tratam `name` como string,
 * `apps` como array de strings, `col`/`row` como inteiros >= 0 e `mon` como
 * inteiro >= 0 AUSENTE OU VÁLIDO, sem checar de novo.
 */
export class DeskLayout {
    /** @param {Gio.Settings|null} settings */
    constructor(settings) {
        this._settings = settings ?? null;
        /** @type {string[]} ordem persistida, inclusive ids não renderizáveis. */
        this._items = [];
        /**
         * Posição GRAVADA. `mon` pode estar ausente (registro da v1).
         * @type {Object<string, {col: number, row: number, mon?: number}>}
         */
        this._placements = {};
        /** @type {Object<string, {name: string, apps: string[]}>} por uuid CRU. */
        this._folders = {};
        /** @type {Object<string, string>} nomes personalizados por id completo. */
        this._names = {};
        /**
         * Posições EXIBIDAS pelo último build(), já no monitor certo, já
         * clampeadas na grade dele e já com colisões resolvidas. Vivem
         * separadas de `_placements` porque a posição gravada é autoritativa e
         * a exibida é descartável: é essa separação que faz desplugar um
         * monitor não destruir o arranjo.
         * @type {Map<string, {col: number, row: number, mon: number}>}
         */
        this._displayById = new Map();
        /** @type {Map<string, string>} 'mon@col,row' -> id, do último build(). */
        this._displayBySlot = new Map();
        /**
         * Último índice primário visto por build(). Serve de resposta para
         * quem precisa de um monitor concreto FORA de build() — troca, herança
         * de slot, ocupação — sem ter a lista de monitores em mãos.
         */
        this._primaryIndex = 0;

        this._signals = new SignalTracker();
        this._watching = false;
        this._watchers = new Set();
        // Snapshot por key do que NÓS acabamos de gravar, para engolir o eco.
        this._pendingSelfWrite = {
            [KEY_ITEMS]: null,
            [KEY_PLACEMENTS]: null,
            [KEY_FOLDERS]: null,
            [KEY_NAMES]: null,
            [KEY_ICONS]: null,
        };

        this.reload();
    }

    /** Relê as três keys para a memória, descartando registros malformados. */
    reload() {
        this._items = this._readItems();
        this._placements = this._readPlacements();
        this._folders = this._readFolders();
        this._names = this._readNames();
        this._icons = this._readIcons();
    }

    /**
     * Normaliza o arranjo contra os apps realmente instalados e devolve as
     * entradas a desenhar, já posicionadas e já com o monitor em que devem ser
     * desenhadas. Persiste se algo mudou de fato.
     *
     * @param {Shell.App[]} installedApps resolvidos por quem chama, para que
     *     este arquivo continue sem Shell
     * @param {Map<number, {cols: number, rows: number}>} grids uma entrada por
     *     índice de monitor VIVO. Vazio significa "ainda não há grade" — work
     *     area em zero no meio de um monitors-changed, ou o prefs.js, que não
     *     tem monitores nenhum: nada é atribuído nem migrado nesse caso.
     * @param {number} primaryIndex onde é exibido quem não tem `mon` válido
     * @returns {Array<Object>} entradas de app, pasta e caminho, com col/row/mon
     */
    build(installedApps, grids, primaryIndex) {
        const byId = new Map();
        for (const app of Array.isArray(installedApps) ? installedApps : []) {
            const appId = app?.get_id?.();
            if (appId && !byId.has(appId))
                byId.set(appId, app);
        }

        const gridMap = _normalizeGrids(grids);
        // O primário para EXIBIÇÃO é sempre um índice que existe em `grids`:
        // degradar para um monitor que também não está na lista seria não
        // degradar para lugar nenhum. O declarado tem preferência; na falta
        // dele, o menor índice vivo.
        const home = _pickHome(gridMap, primaryIndex);
        if (home !== null)
            this._primaryIndex = home;

        const items = [...this._items];
        const folders = this._cloneFolders();
        const placements = this._clonePlacements();

        // 1. Registros órfãos (uuid sem entrada em desk-items) são descartados
        // ANTES de qualquer outra coisa: enquanto o registro existir, seus
        // apps contam como "dentro de uma pasta" e ficariam invisíveis para
        // sempre, numa pasta que não está em lugar nenhum.
        const referenced = new Set();
        for (const id of items) {
            const parsed = parseDeskId(id);
            if (parsed?.type === DeskItemType.FOLDER)
                referenced.add(parsed.value);
        }
        for (const uuid of Object.keys(folders)) {
            if (!referenced.has(uuid))
                delete folders[uuid];
        }

        // 2. Conjunto de membros calculado antes da varredura: um app que está
        // dentro de uma pasta nunca aparece também no primeiro nível, e a
        // decisão precisa valer para pastas que ainda nem foram lidas.
        const members = new Set();
        for (const record of Object.values(folders)) {
            for (const appId of record.apps)
                members.add(appId);
        }

        const entries = [];
        const nextItems = [];
        const nextPlacements = {};
        const emitted = new Set();

        // Mantém o id na lista e leva junto a posição gravada INTEIRA — col,
        // row e mon. `slotFrom` é o id de ONDE a posição vem, que só difere do
        // próprio id quando uma pasta dissolve e o app que sobrou herda o slot
        // dela, inclusive o monitor dela.
        const keep = (id, slotFrom = id) => {
            nextItems.push(id);
            const at = placements[slotFrom];
            if (at && !nextPlacements[id])
                nextPlacements[id] = _copyPlacement(at);
        };

        for (const id of items) {
            const parsed = parseDeskId(id);

            // Tipo desconhecido (ou id malformado): não sabemos desenhar, mas
            // é de uma versão mais nova. Preservado VERBATIM — com a posição
            // dele — exatamente como dockItemsStore faz. O contrário faz a
            // versão antiga apagar em silêncio os itens da nova.
            if (!parsed) {
                if (emitted.has(id))
                    continue;
                emitted.add(id);
                keep(id);
                continue;
            }

            if (emitted.has(id))
                continue;

            if (parsed.type === DeskItemType.APP) {
                const appId = parsed.value;
                // Duplicata ou app que agora vive numa pasta: o id sai da
                // lista. Aqui não há nada a preservar — a informação continua
                // inteira no outro lugar onde ele aparece.
                if (members.has(appId))
                    continue;
                emitted.add(id);
                keep(id);

                const app = byId.get(appId);
                // Não instalado: some da tela mas FICA na lista E no slot.
                // Durante uma atualização o .desktop pode desaparecer por
                // alguns segundos, e descartar o id ali destruiria em silêncio
                // o arranjo que o usuário montou à mão.
                if (!app)
                    continue;
                entries.push(this._appEntry(app, appId));
                continue;
            }

            if (parsed.type === DeskItemType.PATH) {
                // Um caminho não é validado além de "string não vazia", e
                // ninguém dá stat nele aqui: I/O síncrono dentro do compositor
                // congela a sessão num mount NFS morto, e I/O assíncrono não
                // cabe num modelo puro. Um caminho que sumiu continua desenhado
                // e falha na hora de abrir, que é onde o usuário pode fazer
                // alguma coisa a respeito.
                emitted.add(id);
                keep(id);
                entries.push(this._pathEntry(parsed.value, id));
                continue;
            }

            // DeskItemType.FOLDER
            const record = folders[parsed.value];
            // Registro sumiu: o id vai junto, senão sobra uma pasta que não
            // abre. (O caminho inverso, registro sem id, já foi limpo no 1.)
            if (!record)
                continue;

            const apps = [];
            for (const memberId of record.apps) {
                const app = byId.get(memberId);
                // Membro não instalado: pulado na entrada, mantido no
                // registro. Mesmo raciocínio do app de primeiro nível.
                if (app)
                    apps.push(this._appEntry(app, memberId));
            }

            if (apps.length === 0) {
                // Pasta sem nada resolvível: some inteira, e o slot dela some
                // junto.
                delete folders[parsed.value];
                continue;
            }

            if (apps.length === 1) {
                // "Uma pasta com um app não é pasta": dissolve NO SLOT DELA
                // MESMA, virando o app que sobrou. A regra é checada em todo
                // build e não só ao arrastar para fora, porque a pasta também
                // encolhe quando um app é desinstalado.
                const soloId = apps[0].id;
                delete folders[parsed.value];
                if (emitted.has(soloId))
                    continue;
                emitted.add(soloId);
                keep(soloId, id);
                entries.push(apps[0]);
                continue;
            }

            emitted.add(id);
            keep(id);
            entries.push({
                type: DeskItemType.FOLDER,
                id,
                folderId: id,
                name: record.name,
                apps,
            });
        }

        // 3. Migração v1 -> v2, uma vez só: registro sem `mon` significa
        // "primário". Só migra quando quem chamou realmente DECLAROU um
        // primário e existe pelo menos uma grade viva — o prefs.js pode chamar
        // build() sem monitor nenhum, e migrar ali gravaria um `mon` adivinhado
        // por cima do arranjo inteiro. Depois desta passada o registro tem
        // `mon` explícito e nunca mais é tocado por aqui: é o que faz a
        // migração ser silenciosa E acontecer só uma vez.
        const declaredPrimary = _monIndex(primaryIndex);
        if (declaredPrimary !== null && gridMap.size > 0) {
            for (const at of Object.values(nextPlacements)) {
                if (_monOf(at) === null)
                    at.mon = declaredPrimary;
            }
        }

        // 4. Id sem posição ganha o primeiro slot livre DO MONITOR PRIMÁRIO,
        // varrendo em COLUNA-MAJOR a partir da origem. É isso que faz o
        // contrato "só anexe o id" da ArcDock funcionar — a ArcDock não sabe o
        // que é um monitor — e por isso a atribuição é GRAVADA aqui, não
        // recalculada a cada build (senão o item passearia pela tela toda vez
        // que um vizinho fosse removido).
        //
        // A ocupação conta TODAS as posições gravadas, inclusive as de ids que
        // não estão sendo desenhados (app desinstalado, id de versão futura):
        // entregar o slot de um item preservado seria devolvê-lo em cima de
        // outro quando o pacote terminasse de atualizar. E conta POR MONITOR,
        // porque {0,0} na tela 0 e {0,0} na tela 1 são dois lugares distintos.
        if (home !== null) {
            const occupied = new Set();
            for (const at of Object.values(nextPlacements))
                occupied.add(_slotKey(at.col, at.row, _resolveMon(at, home)));
            for (const entry of entries) {
                if (nextPlacements[entry.id])
                    continue;
                const free = _scanAcross(occupied, gridMap, home, 0);
                // Todas as grades cheias: fica sem posição gravada de propósito
                // e tenta de novo no próximo build (a tela pode crescer). A
                // exibição abaixo ainda dá um lugar a ele.
                if (!free)
                    break;
                nextPlacements[entry.id] = free;
                occupied.add(_slotKey(free.col, free.row, free.mon));
            }
        }

        // 5. Posições de exibição: por monitor, clampeadas e sem colisão, e
        // NADA disso é gravado (ver _layoutForDisplay).
        this._layoutForDisplay(entries, nextPlacements, gridMap, home);

        // 6. Só grava o que de fato mudou: build() roda a cada refresh, e
        // reescrever as mesmas três keys sempre seria dconf sujo de graça —
        // além de fazer o eco bater no onExternalChange sem motivo.
        const itemsChanged = !_sameList(nextItems, this._items);
        this._items = nextItems;
        if (itemsChanged)
            this._writeItems();

        const placementsChanged =
            _serializePlacements(nextPlacements) !== _serializePlacements(this._placements);
        this._placements = nextPlacements;
        if (placementsChanged)
            this._writePlacements();

        const foldersChanged =
            _serializeFolders(folders) !== _serializeFolders(this._folders);
        this._folders = folders;
        if (foldersChanged)
            this._writeFolders();

        return entries;
    }

    /** Cópia de desk-items (inclui ids invisíveis e desconhecidos). */
    get order() {
        return [...this._items];
    }

    /**
     * Posição GRAVADA do id, sem clampear e sem resolver o monitor: `mon` vem
     * ausente se o registro ainda é da v1, e vem tal e qual mesmo quando aponta
     * para uma tela que não existe mais. É a autoritativa — quem quiser a que
     * está no vidro usa `col`/`row`/`mon` da entrada devolvida por build().
     * @returns {{col: number, row: number, mon?: number}|null}
     */
    placementOf(id) {
        const at = this._placements[id];
        return at ? _copyPlacement(at) : null;
    }

    /** Id desenhado nesse slot desse monitor no último build(), ou null. */
    itemAt(col, row, mon) {
        return this._displayBySlot.get(_slotKey(col, row, mon)) ?? null;
    }

    /**
     * @param {string} id
     * @param {{col: number, row: number, mon: number}|null} at posição, ou
     *     null para deixar o próximo build() dar o primeiro slot livre DO
     *     PRIMÁRIO — que é exatamente o caminho que a ArcDock usa ao só anexar
     *     o id na key, e ela não sabe o que é um monitor. Este método não
     *     recebe as grades e portanto não tem como calcular o slot sozinho. Um
     *     `at` sem `mon` válido é gravado sem `mon`, e a migração do próximo
     *     build o resolve para o primário — o mesmo caminho da v1.
     * @returns {boolean} houve mudança
     */
    addItem(id, at = null) {
        if (!parseDeskId(id) || this._items.includes(id))
            return false;

        this._items.push(id);
        const slot = _sanitizePlacement(at);
        if (slot)
            this._placements[id] = slot;

        this._writeItems();
        if (slot)
            this._writePlacements();
        return true;
    }

    /** @returns {boolean} houve mudança */
    removeItem(id) {
        const at = this._items.indexOf(id);
        if (at === -1)
            return false;

        this._items.splice(at, 1);
        const hadPlacement = this._placements[id] !== undefined;
        delete this._placements[id];
        const hadName = this._names[id] !== undefined;
        delete this._names[id];
        const hadIcon = this._icons[id] !== undefined;
        delete this._icons[id];

        // Tirar uma pasta virtual da área de trabalho apaga o REGISTRO dela:
        // ela não existe em lugar nenhum além daqui (os apps continuam
        // instalados). Deixar o registro faria um órfão que o próximo build
        // varreria de qualquer jeito, só que uma escrita depois.
        const parsed = parseDeskId(id);
        const uuid = parsed?.type === DeskItemType.FOLDER ? parsed.value : null;
        const hadRecord = uuid !== null && this._folders[uuid] !== undefined;
        if (hadRecord)
            delete this._folders[uuid];

        this._writeItems();
        if (hadPlacement)
            this._writePlacements();
        if (hadRecord)
            this._writeFolders();
        if (hadName)
            this._writeNames();
        if (hadIcon)
            this._writeIcons();
        return true;
    }

    has(id) {
        return this._items.includes(id);
    }

    /**
     * Move para um slot de um monitor. `mon` é OBRIGATÓRIO: quem move sabe em
     * que superfície o usuário soltou o ícone, e é justamente essa informação
     * que faz o item mudar de tela. Deixá-lo opcional aqui reabriria a
     * ambiguidade que a migração existe para fechar.
     * @returns {boolean} houve mudança
     */
    moveTo(id, col, row, mon) {
        if (!this._items.includes(id))
            return false;
        const slot = _sanitizePlacement({ col, row, mon });
        if (!slot || _monOf(slot) === null)
            return false;

        const current = this._placements[id];
        if (current && current.col === slot.col && current.row === slot.row &&
            _monOf(current) === slot.mon)
            return false;

        this._placements[id] = slot;
        this._writePlacements();
        return true;
    }

    /**
     * Troca de lugar dois itens — a resposta da grade livre a soltar um ícone
     * na borda de uma célula ocupada. Não existe reflow aqui: mover um item
     * para um slot ocupado ou empurra o vizinho (não fazemos) ou troca com
     * ele, e trocar é a única das duas que não move ninguém que o usuário não
     * apontou. A troca leva o MONITOR junto: sem isso, arrastar um ícone da
     * tela A para cima de um da tela B trocaria só as coordenadas e deixaria
     * os dois na tela errada.
     * @returns {boolean} houve mudança
     */
    swap(idA, idB) {
        if (!idA || !idB || idA === idB)
            return false;
        if (!this._items.includes(idA) || !this._items.includes(idB))
            return false;

        const a = this._slotFor(idA);
        const b = this._slotFor(idB);
        if (!a || !b)
            return false;
        // A comparação é do TRIO: dois itens em {0,0} de telas diferentes não
        // estão no mesmo lugar, e trocá-los muda alguma coisa de verdade.
        if (a.col === b.col && a.row === b.row && a.mon === b.mon)
            return false;

        this._placements[idA] = b;
        this._placements[idB] = a;
        this._writePlacements();
        return true;
    }

    /**
     * Cria uma pasta virtual com dois apps, NO SLOT DO ALVO — o ícone sobre o
     * qual o usuário soltou: foi ali que ele apontou onde a pasta deve ficar,
     * inclusive em que tela. Membros na ordem [alvo, origem], pelo mesmo
     * motivo.
     * @returns {string|null} o id PREFIXADO da pasta, ou null se recusado
     */
    createFolder(targetId, sourceId) {
        const target = parseDeskId(targetId);
        const source = parseDeskId(sourceId);
        if (target?.type !== DeskItemType.APP || source?.type !== DeskItemType.APP)
            return null;
        if (target.value === source.value)
            return null;

        const at = this._items.indexOf(targetId);
        if (at === -1 || !this._items.includes(sourceId))
            return null;

        const uuid = GLib.uuid_string_random();
        const folderId = makeDeskId(DeskItemType.FOLDER, uuid);
        this._folders[uuid] = {
            name: DEFAULT_FOLDER_NAME,
            apps: [target.value, source.value],
        };

        // O slot é lido ANTES de apagar as posições dos dois apps.
        const slot = this._slotFor(targetId);

        this._items[at] = folderId;
        const sourceAt = this._items.indexOf(sourceId);
        if (sourceAt !== -1)
            this._items.splice(sourceAt, 1);

        delete this._placements[targetId];
        delete this._placements[sourceId];
        if (slot)
            this._placements[folderId] = slot;

        this._writeItems();
        this._writePlacements();
        this._writeFolders();
        return folderId;
    }

    /** @returns {boolean} houve mudança */
    addToFolder(folderId, appId) {
        const folder = parseDeskId(folderId);
        const app = parseDeskId(appId);
        if (folder?.type !== DeskItemType.FOLDER || app?.type !== DeskItemType.APP)
            return false;

        const record = this._folders[folder.value];
        if (!record || record.apps.includes(app.value))
            return false;

        // O app pode estar vindo de OUTRA pasta. Tirar dali é obrigatório (um
        // app em duas pastas apareceria duas vezes); a pasta de origem ficando
        // com um membro só se resolve sozinha no próximo build, que é onde a
        // regra de dissolução vive.
        for (const [uuid, other] of Object.entries(this._folders)) {
            if (uuid === folder.value)
                continue;
            const memberAt = other.apps.indexOf(app.value);
            if (memberAt !== -1)
                other.apps.splice(memberAt, 1);
        }

        record.apps.push(app.value);

        const at = this._items.indexOf(appId);
        if (at !== -1)
            this._items.splice(at, 1);
        const hadPlacement = this._placements[appId] !== undefined;
        delete this._placements[appId];

        if (at !== -1)
            this._writeItems();
        if (hadPlacement)
            this._writePlacements();
        this._writeFolders();
        return true;
    }

    /**
     * Tira um app da pasta e o devolve à área de trabalho no slot (col,row) do
     * monitor `mon`. Slot explícito, e não índice: a grade é livre, e o lugar
     * onde o usuário largou o ícone — em qual tela, e onde dentro dela — é a
     * única informação que existe sobre onde ele o quer. Se sobrarem menos de
     * dois membros, a pasta dissolve no slot dela.
     * @returns {boolean} houve mudança
     */
    removeFromFolder(folderId, appId, col, row, mon) {
        const folder = parseDeskId(folderId);
        const app = parseDeskId(appId);
        if (folder?.type !== DeskItemType.FOLDER || app?.type !== DeskItemType.APP)
            return false;

        const record = this._folders[folder.value];
        if (!record)
            return false;
        const memberAt = record.apps.indexOf(app.value);
        if (memberAt === -1)
            return false;
        record.apps.splice(memberAt, 1);

        // Lido ANTES de qualquer delete: a dissolução abaixo apaga a posição
        // da pasta, e é ela que o membro que sobrar herda.
        const folderSlot = this._slotFor(folderId);

        const outId = makeDeskId(DeskItemType.APP, app.value);
        if (!this._items.includes(outId))
            this._items.push(outId);
        const slot = _sanitizePlacement({ col, row, mon });
        // Slot inválido não é motivo para recusar a saída: sem posição, o
        // próximo build() dá o primeiro slot livre — melhor do que devolver o
        // app para dentro de uma pasta que o usuário acabou de esvaziar.
        if (slot)
            this._placements[outId] = slot;

        if (record.apps.length < 2) {
            delete this._folders[folder.value];
            delete this._placements[folderId];
            // indexOf de novo: o push acima pode ter mexido no array.
            const folderAt = this._items.indexOf(folderId);
            if (folderAt !== -1) {
                if (record.apps.length === 1) {
                    const soloId = makeDeskId(DeskItemType.APP, record.apps[0]);
                    this._items[folderAt] = soloId;
                    if (folderSlot && !this._placements[soloId])
                        this._placements[soloId] = folderSlot;
                } else {
                    this._items.splice(folderAt, 1);
                }
            }
        }

        this._writeItems();
        this._writePlacements();
        this._writeFolders();
        return true;
    }

    /**
     * Renomeia a pasta. Nome só de espaços é recusado: uma pasta sem rótulo
     * nenhum vira um ícone que o usuário não consegue mais nomear.
     * @returns {boolean} houve mudança
     */
    renameFolder(folderId, name) {
        const folder = parseDeskId(folderId);
        if (folder?.type !== DeskItemType.FOLDER)
            return false;
        const record = this._folders[folder.value];
        if (!record)
            return false;

        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed || trimmed === record.name)
            return false;

        record.name = trimmed;
        this._writeFolders();
        return true;
    }

    /** Renomeia somente o rótulo de um atalho de app ou diretório. */
    renameItem(id, name) {
        const parsed = parseDeskId(id);
        if (!this._items.includes(id) ||
            (parsed?.type !== DeskItemType.APP && parsed?.type !== DeskItemType.PATH))
            return false;

        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed || trimmed === this._names[id])
            return false;
        this._names[id] = trimmed;
        this._writeNames();
        return true;
    }

    /** Define a imagem usada pelo ArcDesk e pelo ArcDock para este atalho. */
    setItemIcon(id, path) {
        const parsed = parseDeskId(id);
        if (!this._items.includes(id) ||
            (parsed?.type !== DeskItemType.APP && parsed?.type !== DeskItemType.PATH))
            return false;
        const value = typeof path === 'string' ? path.trim() : '';
        if (!value || value === this._icons[id])
            return false;
        this._icons[id] = value;
        this._writeIcons();
        return true;
    }

    /**
     * Primeiro slot livre do monitor `mon`, varrendo em COLUNA-MAJOR a partir
     * da origem (coluna 0, linhas 0..rows-1; depois coluna 1; ...).
     * Coluna-major e não linha-major porque é assim que a área de trabalho do
     * macOS enfileira: a área útil é larga e baixa, e crescer para o lado
     * deixaria uma fileira solitária atravessando a tela inteira.
     *
     * Se o monitor pedido estiver CHEIO, cai para os outros em ordem de
     * índice — devolver null com uma tela vazia ao lado seria recusar um item
     * por falta de um espaço que existe. O `mon` devolvido diz onde coube.
     *
     * A ocupação é a união das posições GRAVADAS com as EXIBIDAS no último
     * build(), sempre por monitor: um item cuja posição gravada está fora da
     * grade aparece deslocado para algum slot de dentro, e entregar esse slot
     * a um item novo poria dois ícones no mesmo lugar.
     *
     * @param {Map<number, {cols: number, rows: number}>} grids
     * @param {number} mon monitor preferido
     * @returns {{col: number, row: number, mon: number}|null} null se não há
     *     grade nenhuma ou se todas estão cheias
     */
    firstFreeSlot(grids, mon) {
        const gridMap = _normalizeGrids(grids);
        if (gridMap.size === 0)
            return null;
        const preferred = _monIndex(mon);
        const start = preferred !== null && gridMap.has(preferred)
            ? preferred
            : _pickHome(gridMap, this._primaryIndex);
        return _scanAcross(this._occupiedSlots(), gridMap, start, 0);
    }

    /**
     * Assina mudanças EXTERNAS nas três keys — as nossas próprias escritas são
     * engolidas. Existe como método justamente por causa disso: um `changed::`
     * cru devolveria toda escrita de build() como notificação, e ela
     * dispararia o rebuild que a originou.
     *
     * Escutamos apesar de sermos o único escritor DENTRO deste processo porque
     * a ArcDock escreve `desk-items` e o prefs.js escreve de outro processo.
     *
     * @param {function(string): void} callback recebe a key que mudou
     * @returns {function(): void} unsubscribe, idempotente
     */
    onExternalChange(callback) {
        if (typeof callback !== 'function' || !this._settings)
            return () => {};

        this._watchers.add(callback);
        this._ensureWatch();

        let unsubscribed = false;
        return () => {
            if (unsubscribed)
                return;
            unsubscribed = true;
            this._watchers.delete(callback);
            if (this._watchers.size === 0)
                this._stopWatch();
        };
    }

    destroy() {
        this._signals.disconnectAll();
        this._watching = false;
        this._watchers.clear();
        this._settings = null;
        this._items = [];
        this._placements = {};
        this._folders = {};
        this._names = {};
        this._displayById.clear();
        this._displayBySlot.clear();
        for (const key of Object.keys(this._pendingSelfWrite))
            this._pendingSelfWrite[key] = null;
    }

    // --- interno ---

    _appEntry(app, appId) {
        const id = makeDeskId(DeskItemType.APP, appId);
        return {
            type: DeskItemType.APP,
            id,
            appId,
            app,
            name: this._names[id] ?? app.get_name() ?? '',
            customIcon: this._icons[id] ?? null,
        };
    }

    _pathEntry(path, id) {
        return {
            type: DeskItemType.PATH,
            id,
            path,
            // Basename é aritmética de string em GLib, não I/O — nada aqui
            // toca o disco. O fallback para o caminho inteiro cobre '/'.
            name: this._names[id] ?? (GLib.path_get_basename(path) || path),
            customIcon: this._icons[id] ?? null,
        };
    }

    /**
     * Preenche `col`/`row`/`mon` de cada entrada. As posições GRAVADAS não são
     * tocadas: um item fora da grade atual — ou num monitor que não existe
     * mais — é recolocado só para EXIBIÇÃO, e é isso que faz replugar a tela
     * devolver o arranjo intacto.
     *
     * Ocupação, clamp e empurrão de colisão são POR MONITOR: cada tela tem a
     * própria grade e as próprias dimensões, e um item da tela 1 nunca disputa
     * slot com um da tela 0.
     */
    _layoutForDisplay(entries, placements, gridMap, home) {
        this._displayById.clear();
        this._displayBySlot.clear();

        if (home === null) {
            // Nenhuma grade utilizável (work area ainda em zero no meio de um
            // monitors-changed, ou o prefs.js): devolve a posição gravada crua.
            // Clampear contra zero coluna empilharia a área de trabalho inteira
            // em (0,0), e quem veria isso é o usuário, por causa de um frame de
            // transição.
            for (const entry of entries) {
                const at = placements[entry.id];
                this._setDisplay(entry, at?.col ?? 0, at?.row ?? 0,
                    _resolveMon(at, this._primaryIndex));
            }
            return;
        }

        const deferred = [];

        // Passada 1: quem já cabe na grade do PRÓPRIO monitor fica exatamente
        // onde está. Um item recolocado nunca pode expulsar um que cabe — senão
        // desplugar uma tela reorganizaria também os ícones que não tinham
        // problema nenhum. Por isso ela roda inteira, para todos os monitores,
        // antes de qualquer decisão da passada 2.
        for (const entry of entries) {
            const at = placements[entry.id];
            const stored = _monOf(at);
            const live = stored !== null && gridMap.has(stored);

            if (!live) {
                // Sem posição, ou gravado num monitor que não existe agora: vai
                // para o primário, no PRIMEIRO slot livre de lá (start 0). Não
                // tenta o col/row gravado de propósito — ele veio de uma grade
                // de outro tamanho e não significa nada aqui. A GRAVAÇÃO
                // continua intocada; replugar a tela devolve tudo.
                deferred.push({ entry, mon: home, start: 0 });
                continue;
            }

            const grid = gridMap.get(stored);
            if (at.col >= grid.cols || at.row >= grid.rows) {
                deferred.push({ entry, mon: stored, start: _scanIndex(at.col, at.row, grid) });
                continue;
            }
            const key = _slotKey(at.col, at.row, stored);
            // Duas gravações no mesmo slot do mesmo monitor (dois processos
            // escrevendo ao mesmo tempo, dconf editado à mão): o segundo é
            // tratado como deslocado.
            if (this._displayBySlot.has(key)) {
                deferred.push({ entry, mon: stored, start: _scanIndex(at.col, at.row, grid) });
                continue;
            }
            this._setDisplay(entry, at.col, at.row, stored);
        }

        // Passada 2: clampeia e resolve a colisão empurrando para o próximo
        // slot livre a partir dali, DENTRO DO MESMO MONITOR. Sem isso, encolher
        // a grade colapsaria uma coluna inteira em cima da última — vários
        // ícones no mesmo pixel, e todos menos um impossíveis de clicar. Só
        // quando a grade do próprio monitor está cheia é que o item transborda
        // para o primário, e depois para qualquer outra tela.
        for (const { entry, mon, start } of deferred) {
            const at = placements[entry.id];
            const grid = gridMap.get(mon);
            const col = Math.min(at?.col ?? 0, grid.cols - 1);
            const row = Math.min(at?.row ?? 0, grid.rows - 1);

            let free = _scanFree(this._displayBySlot, grid, mon, start);
            if (!free && mon !== home)
                free = _scanFree(this._displayBySlot, gridMap.get(home), home, 0);
            if (!free)
                free = _scanAcross(this._displayBySlot, gridMap, home, 0);

            // Tudo cheio: sobrepõe em vez de sumir. Um ícone atrás de outro
            // ainda pode ser resgatado arrastando o de cima; um ícone que não
            // foi desenhado some da vista do usuário sem explicação.
            const slot = free ?? { col, row, mon };
            this._setDisplay(entry, slot.col, slot.row, slot.mon);
        }
    }

    _setDisplay(entry, col, row, mon) {
        entry.col = col;
        entry.row = row;
        entry.mon = mon;
        this._displayById.set(entry.id, { col, row, mon });
        this._displayBySlot.set(_slotKey(col, row, mon), entry.id);
    }

    /**
     * Posição de um id para efeito de troca/herança, sempre com um `mon`
     * concreto: a GRAVADA, e na falta dela a EXIBIDA. A exibida é a única
     * resposta honesta para um item que a ArcDock acabou de anexar e que o
     * usuário já está vendo na tela — build() grava a atribuição, mas só
     * quando havia grade para calcular.
     *
     * A exceção é o item DEGRADADO: gravado numa tela que não existe agora, ele
     * está sendo desenhado em outro lugar. Trocar usando a gravação mandaria o
     * parceiro — que está bem — para um monitor morto, e ele sumiria da vista.
     * Nesse caso a verdade para uma troca é o que o usuário vê.
     */
    _slotFor(id) {
        const stored = this._placements[id];
        const shown = this._displayById.get(id) ?? null;
        if (!stored)
            return shown ? { ...shown } : null;

        const mon = _monOf(stored);
        if (shown && mon !== null && mon !== shown.mon)
            return { ...shown };
        return {
            col: stored.col,
            row: stored.row,
            mon: mon ?? shown?.mon ?? this._primaryIndex,
        };
    }

    /** Slots ocupados hoje: gravados (mesmo os de itens invisíveis) + exibidos. */
    _occupiedSlots() {
        const occupied = new Set();
        const known = new Set(this._items);
        for (const [id, at] of Object.entries(this._placements)) {
            if (known.has(id))
                occupied.add(_slotKey(at.col, at.row, _resolveMon(at, this._primaryIndex)));
        }
        for (const key of this._displayBySlot.keys())
            occupied.add(key);
        return occupied;
    }

    _cloneFolders() {
        const copy = {};
        for (const [uuid, record] of Object.entries(this._folders))
            copy[uuid] = { name: record.name, apps: [...record.apps] };
        return copy;
    }

    _clonePlacements() {
        const copy = {};
        for (const [id, at] of Object.entries(this._placements))
            copy[id] = _copyPlacement(at);
        return copy;
    }

    _readItems() {
        if (!this._settings)
            return [];
        // Array bruto, sem filtro por tipo: ids desconhecidos precisam
        // sobreviver ao round-trip leitura -> escrita.
        return this._settings.get_strv(KEY_ITEMS).filter(id => id);
    }

    _readPlacements() {
        const parsed = this._readJson(KEY_PLACEMENTS);
        if (!parsed)
            return {};

        const placements = {};
        for (const [id, at] of Object.entries(parsed)) {
            const slot = _sanitizePlacement(at);
            // Posição inválida (negativa, fracionária, não numérica) é
            // DESCARTADA e não corrigida: sem posição o item ganha o primeiro
            // slot livre no próximo build, enquanto uma correção arbitrária o
            // largaria num canto qualquer sem que nada explique por quê.
            // Um `mon` inválido, ao contrário, é só APAGADO: col/row continuam
            // boas, e um registro SEM `mon` já tem significado definido
            // ("primário") por causa da v1 — é o mesmo caminho, sem caso novo.
            if (id && slot)
                placements[id] = slot;
        }
        return placements;
    }

    _readFolders() {
        const parsed = this._readJson(KEY_FOLDERS);
        if (!parsed)
            return {};

        const folders = {};
        for (const [uuid, record] of Object.entries(parsed)) {
            if (!uuid || !record || typeof record !== 'object' || Array.isArray(record))
                continue;
            // Registro validado campo a campo AQUI e nunca de novo: build() e
            // os mutadores tratam `name` como string e `apps` como array de
            // strings sem checar, e é esta porta de entrada que garante isso.
            const apps = Array.isArray(record.apps)
                ? record.apps.filter(appId => typeof appId === 'string' && appId)
                : [];
            folders[uuid] = {
                name: typeof record.name === 'string' && record.name
                    ? record.name
                    : DEFAULT_FOLDER_NAME,
                apps,
            };
        }
        return folders;
    }

    _readNames() {
        const parsed = this._readJson(KEY_NAMES);
        if (!parsed)
            return {};
        const names = {};
        for (const [id, name] of Object.entries(parsed)) {
            const item = parseDeskId(id);
            if ((item?.type === DeskItemType.APP || item?.type === DeskItemType.PATH) &&
                typeof name === 'string' && name.trim())
                names[id] = name.trim();
        }
        return names;
    }

    _readIcons() {
        const parsed = this._readJson(KEY_ICONS);
        if (!parsed)
            return {};
        const icons = {};
        for (const [id, path] of Object.entries(parsed)) {
            const item = parseDeskId(id);
            if ((item?.type === DeskItemType.APP || item?.type === DeskItemType.PATH) &&
                typeof path === 'string' && path.trim())
                icons[id] = path.trim();
        }
        return icons;
    }

    _readJson(key) {
        if (!this._settings)
            return null;
        let parsed = null;
        try {
            parsed = JSON.parse(this._settings.get_string(key));
        } catch (error) {
            // JSON corrompido não pode derrubar a área de trabalho — começa
            // vazio. console.warn e não console.log: log é filtrado abaixo de
            // notice em algumas versões, e perder justamente o aviso de "seu
            // arranjo foi descartado" é o pior caso.
            console.warn(`[ArcDesk] ${key} inválido, ignorando: ${error}`);
            return null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        return parsed;
    }

    _writeItems() {
        if (!this._settings)
            return;
        this._pendingSelfWrite[KEY_ITEMS] = _serializeItems(this._items);
        this._settings.set_strv(KEY_ITEMS, this._items);
    }

    _writePlacements() {
        if (!this._settings)
            return;
        const json = _serializePlacements(this._placements);
        this._pendingSelfWrite[KEY_PLACEMENTS] = json;
        this._settings.set_string(KEY_PLACEMENTS, json);
    }

    _writeFolders() {
        if (!this._settings)
            return;
        const json = _serializeFolders(this._folders);
        this._pendingSelfWrite[KEY_FOLDERS] = json;
        this._settings.set_string(KEY_FOLDERS, json);
    }

    _writeNames() {
        if (!this._settings)
            return;
        const json = _serializeNames(this._names);
        this._pendingSelfWrite[KEY_NAMES] = json;
        this._settings.set_string(KEY_NAMES, json);
    }

    _writeIcons() {
        if (!this._settings)
            return;
        const json = _serializeNames(this._icons);
        this._pendingSelfWrite[KEY_ICONS] = json;
        this._settings.set_string(KEY_ICONS, json);
    }

    _ensureWatch() {
        if (this._watching || !this._settings)
            return;
        this._watching = true;
        // Snapshots zerados ao (re)começar a escutar: um snapshot deixado por
        // uma escrita feita enquanto ninguém ouvia engoliria a PRIMEIRA
        // mudança externa depois da assinatura.
        for (const key of Object.keys(this._pendingSelfWrite))
            this._pendingSelfWrite[key] = null;
        for (const key of [KEY_ITEMS, KEY_PLACEMENTS, KEY_FOLDERS, KEY_NAMES, KEY_ICONS]) {
            this._signals.connect(this._settings, `changed::${key}`,
                () => this._onKeyChanged(key));
        }
    }

    _stopWatch() {
        this._signals.disconnectAll();
        this._watching = false;
    }

    /**
     * O GSettings notifica também as escritas feitas por nós mesmos. Refazer o
     * layout por causa do próprio eco é, na melhor das hipóteses, trabalho
     * perdido; no pior — durante um drop — recalcularia o arranjo no meio do
     * arrasto. Engolimos exatamente UMA notificação idêntica ao que acabamos
     * de escrever e zeramos o snapshot em seguida, para que uma mudança
     * externa posterior (mesmo que volte ao mesmo valor) volte a ser
     * processada normalmente.
     */
    _onKeyChanged(key) {
        const pending = this._pendingSelfWrite[key];
        if (pending !== null) {
            this._pendingSelfWrite[key] = null;
            if (pending === this._currentSerialized(key))
                return;
        }

        // Relê ANTES de avisar: quem recebe o callback vai chamar build(), e
        // build() em cima da memória velha reescreveria a key desfazendo a
        // mudança externa que acabou de chegar.
        this.reload();

        for (const callback of [...this._watchers]) {
            try {
                callback(key);
            } catch (error) {
                // Um assinante que explode não pode impedir os outros de
                // saber: este handler roda dentro do dispatch do GSettings.
                logError(error, `[ArcDesk] onExternalChange(${key})`);
            }
        }
    }

    _currentSerialized(key) {
        if (!this._settings)
            return null;
        if (key === KEY_ITEMS)
            return _serializeItems(this._settings.get_strv(KEY_ITEMS).filter(id => id));
        // As duas keys JSON são comparadas com a string CRUA da key: o que
        // gravamos foi exatamente a saída de _serialize*, então o eco bate
        // byte a byte e uma reescrita de terceiros (mesmo conteúdo, outra
        // grafia) não é confundida com ele.
        return this._settings.get_string(key);
    }
}

// --- helpers de módulo ---

/**
 * Chave de ocupação. Carrega o monitor porque a grade é uma por tela: sem ele,
 * o ícone em {0,0} da tela 1 bloquearia o {0,0} da tela 0, e o usuário veria
 * metade do arranjo se recusar a existir só porque a outra metade existe.
 */
function _slotKey(col, row, mon) {
    return `${mon}${MONITOR_SEPARATOR}${col},${row}`;
}

/** Lado da grade como inteiro >= 0; qualquer lixo vira 0 ("sem grade"). */
function _gridSide(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Índice de monitor utilizável, ou null. Fracionário e negativo são lixo — e a
 * amenda é explícita: um `mon` assim é tratado como AUSENTE, ou seja, cai na
 * mesma regra do registro da v1.
 */
function _monIndex(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
}

/** `mon` de um registro de posição, ou null se ausente/inválido (= v1). */
function _monOf(at) {
    if (!at || typeof at !== 'object')
        return null;
    return _monIndex(at.mon);
}

/** `mon` do registro, ou o primário — a regra de leitura da v1. */
function _resolveMon(at, fallback) {
    return _monOf(at) ?? (_monIndex(fallback) ?? 0);
}

/** Cópia rasa do registro que PRESERVA a ausência de `mon`. */
function _copyPlacement(at) {
    const copy = { col: at.col, row: at.row };
    const mon = _monOf(at);
    if (mon !== null)
        copy.mon = mon;
    return copy;
}

/**
 * {col,row} normalizado com `mon` opcional, ou null se não for um par de
 * índices utilizável. Fracionário é recusado em vez de arredondado: um 2.5
 * gravado significa que alguém escreveu na key sem saber o que estava fazendo,
 * e adivinhar para que lado ele cai só espalharia o erro. `mon` inválido é
 * OMITIDO e não recusa o registro: um registro sem `mon` é exatamente o que a
 * v1 gravava, e já tem significado definido.
 */
function _sanitizePlacement(at) {
    if (!at || typeof at !== 'object' || Array.isArray(at))
        return null;
    const { col, row } = at;
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0)
        return null;
    const slot = { col, row };
    const mon = _monOf(at);
    if (mon !== null)
        slot.mon = mon;
    return slot;
}

/**
 * Mapa de grades normalizado a partir do que quer que tenha chegado (Map,
 * objeto simples ou array de pares — quem chama de outro processo não tem por
 * que saber qual). Entradas sem lado utilizável são descartadas: uma grade 0x0
 * não é uma grade, é um monitor que ainda não foi medido, e tratá-la como viva
 * faria itens caírem numa tela onde nenhum slot existe.
 * @returns {Map<number, {cols: number, rows: number}>}
 */
function _normalizeGrids(grids) {
    const map = new Map();
    if (!grids || typeof grids !== 'object')
        return map;

    let pairs = null;
    if (typeof grids.entries === 'function' && !Array.isArray(grids))
        pairs = grids.entries();
    else if (Array.isArray(grids))
        pairs = grids;
    else
        pairs = Object.entries(grids);

    for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length < 2)
            continue;
        // A chave pode chegar como string quando o mapa veio de um objeto
        // simples (JSON, prefs): Object.entries sempre devolve string.
        const index = _monIndex(typeof pair[0] === 'string' ? Number(pair[0]) : pair[0]);
        if (index === null)
            continue;
        const cols = _gridSide(pair[1]?.cols);
        const rows = _gridSide(pair[1]?.rows);
        if (cols > 0 && rows > 0)
            map.set(index, { cols, rows });
    }
    return map;
}

/**
 * O monitor onde é EXIBIDO quem não tem `mon` válido. É sempre um índice que
 * existe no mapa: o declarado quando ele está lá, senão o menor vivo —
 * degradar para uma tela que também não existe não resolveria nada.
 * @returns {number|null} null quando não há grade nenhuma
 */
function _pickHome(gridMap, primaryIndex) {
    if (gridMap.size === 0)
        return null;
    const declared = _monIndex(primaryIndex);
    if (declared !== null && gridMap.has(declared))
        return declared;
    let lowest = null;
    for (const index of gridMap.keys()) {
        if (lowest === null || index < lowest)
            lowest = index;
    }
    return lowest;
}

/** Índice linear coluna-major de (col,row) dentro da grade, já clampeado. */
function _scanIndex(col, row, grid) {
    const c = Math.min(Math.max(col, 0), grid.cols - 1);
    const r = Math.min(Math.max(row, 0), grid.rows - 1);
    return c * grid.rows + r;
}

/**
 * Primeiro slot livre de UM monitor a partir de `startIndex`, em coluna-major,
 * dando a volta na grade. `taken` é qualquer coisa com .has(key) — um Set de
 * chaves ou o próprio Map de slots exibidos.
 * @returns {{col: number, row: number, mon: number}|null}
 */
function _scanFree(taken, grid, mon, startIndex) {
    if (!grid)
        return null;
    const { cols, rows } = grid;
    const total = cols * rows;
    if (total <= 0)
        return null;
    const start = Number.isFinite(startIndex) ? Math.max(0, Math.floor(startIndex)) : 0;
    for (let step = 0; step < total; step++) {
        const index = (start + step) % total;
        const col = Math.floor(index / rows);
        const row = index % rows;
        if (!taken.has(_slotKey(col, row, mon)))
            return { col, row, mon };
    }
    return null;
}

/**
 * Primeiro slot livre começando pelo monitor `first` e, se ele estiver cheio,
 * seguindo pelos outros em ORDEM DE ÍNDICE. Ordem de índice, e não ordem de
 * inserção do Map, porque o resultado precisa ser o mesmo em duas sessões que
 * enumeraram os monitores em ordens diferentes.
 * @returns {{col: number, row: number, mon: number}|null}
 */
function _scanAcross(taken, gridMap, first, startIndex) {
    if (gridMap.size === 0)
        return null;
    const order = [...gridMap.keys()].sort((a, b) => a - b);
    if (first !== null && gridMap.has(first)) {
        const at = order.indexOf(first);
        if (at > 0) {
            order.splice(at, 1);
            order.unshift(first);
        }
    }
    for (const mon of order) {
        const free = _scanFree(taken, gridMap.get(mon), mon,
            mon === first ? startIndex : 0);
        if (free)
            return free;
    }
    return null;
}

function _sameList(a, b) {
    return a.length === b.length && a.every((id, index) => id === b[index]);
}

function _serializeItems(ids) {
    return ids.join(LIST_SEPARATOR);
}

/**
 * JSON com as chaves em ordem estável e os campos em ordem FIXA — os
 * _serialize* existem para COMPARAR o valor novo com o gravado, e nem a ordem
 * de iteração de um objeto nem a ordem em que os campos foram atribuídos são
 * garantia suficiente para isso. Com as duas fixadas, "mudou alguma coisa?"
 * vira uma comparação de strings. `mon` só é emitido quando existe: gravá-lo
 * como null faria todo registro da v1 parecer alterado a cada build, e a
 * migração deixaria de ser uma escrita só.
 */
function _serializePlacements(placements) {
    const sorted = {};
    for (const id of Object.keys(placements).sort()) {
        const at = placements[id];
        const record = { col: at.col, row: at.row };
        const mon = _monOf(at);
        if (mon !== null)
            record.mon = mon;
        sorted[id] = record;
    }
    return JSON.stringify(sorted);
}

function _serializeFolders(folders) {
    const sorted = {};
    for (const uuid of Object.keys(folders).sort())
        sorted[uuid] = { name: folders[uuid].name, apps: folders[uuid].apps };
    return JSON.stringify(sorted);
}

function _serializeNames(names) {
    const sorted = {};
    for (const id of Object.keys(names).sort())
        sorted[id] = names[id];
    return JSON.stringify(sorted);
}
