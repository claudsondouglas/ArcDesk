import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { fillAppActionsSection } from './appActionsMenu.js';
import { ItemType } from './config.js';

/**
 * Lado da seta, e portanto onde o menu nasce em relação à célula.
 *
 * TOP = seta em cima = caixa ABAIXO do ícone, que é onde um menu de
 * contexto é esperado. Não é preciso um caso especial para a última linha
 * da grade: o BoxPointer vira sozinho para BOTTOM quando a caixa não cabe
 * abaixo da fonte e cabe acima (`_calculateArrowSide`), então a escolha
 * aqui é só a PREFERÊNCIA.
 */
const ARROW_SIDE = St.Side.TOP;

/**
 * Menu de contexto de uma célula da área de trabalho.
 *
 * Criado SOB DEMANDA pelo DeskIcon (só no primeiro botão direito daquela
 * célula), nunca no construtor da célula: um `refresh()` cria uma célula
 * por item e joga todas fora, e um PopupMenu + PopupMenuManager por célula
 * seria pagar milhares de actors para mostrar no máximo um.
 *
 * O actor do menu mora no `uiGroup` e NÃO na superfície da área de
 * trabalho. Dois motivos independentes, e cada um sozinho já bastaria: a
 * superfície vive dentro do `_backgroundGroup`, abaixo de todas as janelas
 * — um menu desenhado ali ficaria escondido atrás da primeira janela
 * aberta; e o `uiGroup` é onde o PopupMenuManager espera empurrar o modal
 * dele. O preço é que ninguém destrói este actor junto com a célula, então
 * `destroy()` aqui é obrigatório.
 */
export class DeskIconMenu {
    /**
     * @param {object} params
     * @param {Clutter.Actor} params.sourceActor célula a que o menu se ancora
     * @param {object} params.item entry de `DeskLayout.build()`
     * @param {object} params.policy callbacks da superfície:
     *   - `open(item)` / `openFolder(item)` / `rename(item)` / `changeIcon(item)` / `remove(item)`
     *   - `isPinnedToDock(app)` e `togglePinnedToDock(app)` — OPCIONAIS, e
     *     opcionais JUNTOS: sem os dois o item de fixar não é criado, porque
     *     um menu que lê o estado mas não escreve (ou o contrário) carrega
     *     um rótulo mentiroso.
     *   - `createShortcut(app)` — opcional; sem ele o item não existe.
     *   - `stateChanged(isOpen)`
     */
    constructor(params = {}) {
        this._item = params.item ?? null;
        this._policy = params.policy ?? {};

        this._menuManager = new PopupMenu.PopupMenuManager(params.sourceActor);
        this._menu = new PopupMenu.PopupMenu(params.sourceActor, 0.5, ARROW_SIDE);
        this._menu.actor.hide();
        this._menuManager.addMenu(this._menu);
        Main.uiGroup.add_child(this._menu.actor);

        this._actionsSection = null;
        this._pinItem = null;

        this._buildStableHalf();

        this._menu.connect('open-state-changed', (_menu, isOpen) =>
            this._guard(() => this._policy.stateChanged?.(isOpen), 'menu state'));
    }

    get isOpen() {
        return !!this._menu?.isOpen;
    }

    /**
     * Abre (ou fecha, se já estava aberto) o menu, com a metade volátil
     * refeita na hora.
     *
     * `toggle()` e não `open()`: o segundo botão direito na mesma célula
     * fecha o que o primeiro abriu.
     */
    toggle() {
        if (!this._menu) return;
        this._populate();
        this._menu.toggle();
    }

    close() {
        if (!this._menu?.isOpen) return;
        this._menu.close(BoxPointer.PopupAnimation.NONE);
    }

    destroy() {
        // Zerado ANTES do destroy: o `destroy()` do PopupMenu fecha o menu,
        // e o 'open-state-changed' desse fechamento reentraria aqui.
        const menu = this._menu;
        this._menu = null;
        this._actionsSection = null;
        this._pinItem = null;
        this._item = null;
        if (menu) {
            try {
                // destroy() do PopupMenu já fecha, esvazia, destrói o actor
                // (o que o tira do uiGroup) e emite 'destroy' — que é o que
                // faz o PopupMenuManager devolver o modal caso este menu
                // ainda fosse o ativo.
                menu.destroy();
            } catch (e) {
                logError(e, '[ArcDesk] desk icon menu destroy failed');
            }
        }
        this._menuManager = null;
        // Só DEPOIS do destroy: o fechamento que ele dispara ainda precisa
        // chegar à superfície pelo `stateChanged`, senão ela fica achando
        // que existe um menu aberto para sempre e desvia o teclado dela.
        this._policy = {};
    }

    // --- Metade estável: montada uma vez, na criação ---

    _buildStableHalf() {
        const type = this._item?.type ?? null;

        if (type === ItemType.APP) {
            // Ações do app. Repopulada a cada abertura — ver
            // fillAppActionsSection. O separador que fecha a seção é dela:
            // com um app sem ação nenhuma ele simplesmente não existe, e o
            // menu começa direto no "Abrir".
            this._actionsSection = new PopupMenu.PopupMenuSection();
            this._menu.addMenuItem(this._actionsSection);
        }

        // "Abrir" existe para os três tipos; só o rótulo e o destino mudam.
        const openLabel = type === ItemType.PATH ? 'Abrir pasta' : 'Abrir';
        this._addItem(openLabel, () => {
            if (type === ItemType.FOLDER) this._policy.openFolder?.(this._item);
            else this._policy.open?.(this._item);
        }, 'open item');

        if (type === ItemType.FOLDER) {
            this._addItem('Renomear',
                () => this._policy.rename?.(this._item), 'rename folder');
        }

        if (type === ItemType.APP || type === ItemType.PATH) {
            this._addItem('Renomear',
                () => this._policy.rename?.(this._item), 'rename shortcut');
            this._addItem('Mudar ícone',
                () => this._policy.changeIcon?.(this._item), 'change shortcut icon');
        }

        if (type === ItemType.APP) {
            const { isPinnedToDock, togglePinnedToDock, createShortcut } = this._policy;
            if (typeof isPinnedToDock === 'function' &&
                typeof togglePinnedToDock === 'function') {
                // Rótulo vazio na construção: quem decide entre "Fixar" e
                // "Desafixar" é o estado do store NO INSTANTE da abertura.
                // A dock pode ter sido mexida pelo prefs.js, em OUTRO
                // processo, entre um botão direito e o seguinte.
                this._pinItem = this._addItem('',
                    () => togglePinnedToDock(this._app()), 'toggle pinned');
            }
            if (typeof createShortcut === 'function') {
                // Criar um .desktop de verdade na pasta Área de Trabalho é
                // outra coisa que pôr um item na grade virtual da ArcDesk —
                // este atalho é o que outros gerenciadores de arquivos (e a
                // DING) enxergam. Sem o callback, o item não existe.
                this._addItem('Criar atalho na área de trabalho',
                    () => createShortcut(this._app()), 'create shortcut');
            }
        }

        this._addItem('Remover da área de trabalho',
            () => this._policy.remove?.(this._item), 'remove item');
    }

    _addItem(label, action, what) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => this._guard(action, what));
        this._menu.addMenuItem(item);
        return item;
    }

    _app() {
        return this._item?.type === ItemType.APP ? this._item.app ?? null : null;
    }

    // --- Metade volátil: refeita a CADA abertura ---

    _populate() {
        if (this._actionsSection) {
            // As ações precisam de uma consulta viva ao app:
            // `can_open_new_window()` de vários apps só passa a valer depois
            // que eles estão rodando.
            this._guard(() => {
                fillAppActionsSection(this._actionsSection, this._app(), {
                    // A área de trabalho não sai de cena quando algo é
                    // lançado (ela É o fundo), então não há nada a fechar
                    // aqui — mas o menu segura um modal, e é ele que o
                    // Shell devolve na continuação AFTER do 'activate'.
                    // Nada a fazer antes do lançamento.
                });
            }, 'menu actions');
        }

        if (!this._pinItem) return;
        let pinned = false;
        this._guard(() => {
            pinned = this._policy.isPinnedToDock?.(this._app()) === true;
        }, 'menu pin state');
        this._pinItem.label.text = pinned ? 'Desafixar da dock' : 'Fixar na dock';
    }

    /**
     * Nada nosso pode escapar daqui.
     *
     * `_populate()` roda dentro do reconhecimento do gesto de botão direito,
     * e os handlers de item rodam dentro do `emit('activate')` do
     * PopupBaseMenuItem — que o Shell conecta com `ConnectFlags.AFTER` para
     * fechar o menu logo depois. Uma exceção nossa aborta essa continuação e
     * deixa o menu aberto segurando o modal: é a mesma classe de estrago da
     * lei 1 do dnd, só que a sessão trava no teclado em vez de no arraste.
     */
    _guard(fn, what = 'menu') {
        try {
            fn();
        } catch (e) {
            logError(e, `[ArcDesk] desk menu ${what} failed`);
        }
    }
}
