import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import { ANIM, DeskTheme, ItemType, LabelPosition, MERGE, SIZE, State, TIMING }
    from './config.js';
import * as Cursor from './cursor.js';
import { DeskIconMenu } from './deskIconMenu.js';
import { attachClickOpen } from './doubleClick.js';
import { createFolderPreview } from './folderPreview.js';
import { TimeoutTracker } from './trackers.js';

// Nomes das transições que cada efeito controla. Escopo por PROPRIEDADE, e
// nunca remove_all_transitions(): o hover anima a escala do stage e o
// quique de chegada anima a escala do iconBin — derrubar tudo de uma vez
// congelaria um no meio do outro.
const SCALE_X = 'scale-x';
const SCALE_Y = 'scale-y';
const OPACITY = 'opacity';
const TRANSLATION_Y = 'translation-y';

// Quanto o rótulo desce enquanto o ícone está crescido no hover. É
// translation e não margin porque translation NÃO re-aloca: o rótulo
// continua ocupando a mesma faixa e nenhuma outra célula da grade se mexe.
const HOVER_LABEL_SHIFT = 4;

// Raio do halo de merge, em FRAÇÃO do lado do ícone. Fração e não px: o
// tamanho do ícone é uma chave do gschema que vai de 32 a 128, e um raio
// fixo que arredonda bem um ícone de 128 vira um círculo num de 32. Vai
// inline por set_style() porque é geometria genuinamente dinâmica — o CSS
// do St não tem calc() nem variáveis (ver a seção de CSS do CONTRACT).
const HALO_RADIUS_FRACTION = 0.25;

/**
 * Uma célula da área de trabalho: arte grande + nome embaixo.
 *
 * Serve para um APP, uma PASTA virtual e um CAMINHO do disco — a diferença
 * é só o actor que vai dentro da caixa da arte e o que "abrir" significa.
 * Uma classe só, e não três irmãs, porque tudo o que é caro aqui (hover,
 * seleção, arrastar, ser alvo de drop, menu de contexto) é idêntico nos
 * três casos.
 *
 * Estende **St.Widget e não St.Button**, ao contrário do AppGridIcon da
 * ArcDock de quem quase todo o resto foi levantado. O motivo é o gesto: a
 * ArcDesk abre no DUPLO clique, e o 'clicked' do St.Button nasce do
 * ClickGesture interno dele — que dispara já no PRIMEIRO aperto de um
 * duplo clique. Herdar do St.Button obrigaria a lutar contra o gesto dele
 * para não abrir o item no clique que deveria apenas selecioná-lo. O que
 * se perde do St.Button (button_mask, 'clicked', estilo :active) não é
 * usado aqui: o clique inteiro vem de doubleClick.js, e hover e
 * track_hover são do St.Widget, não do botão.
 */
export const DeskIcon = GObject.registerClass(
class DeskIcon extends St.Widget {
    /**
     * @param {object} params
     * @param {object}   params.item          — entry de `DeskLayout.build()`
     * @param {number}   params.iconSize
     * @param {number}   params.labelWidth
     * @param {string}   params.labelPosition — valor de LabelPosition
     * @param {boolean}  params.doubleClickToOpen
     * @param {string}   [params.theme]       — valor de DeskTheme.
     *   DIVERGÊNCIA ADITIVA: o contrato não lista `theme` nos parâmetros do
     *   `_init`, mas manda usar "as classes de estilo mais os gêmeos
     *   `-dark`" — e o tema é uma chave da superfície, não do ícone. O
     *   campo é opcional; sem ele a célula fica no tema claro, que é a base
     *   do design system (o escuro é ADITIVO, nunca uma troca).
     * @param {function} params.onOpen        — (item, icon) => void
     * @param {function} params.onSelect      — (icon) => void
     * @param {object|null} params.dnd        — política de arraste; null desliga
     * @param {object|null} params.menu       — política do menu; null desliga
     */
    _init(params = {}) {
        super._init({
            style_class: 'arc-cell',
            reactive: true,
            track_hover: true,
            // O foco de teclado NUNCA vem para a célula: quem segura o grab
            // e trata as setas é a superfície, e a "seleção" da ArcDesk é
            // uma style class nossa (setSelected), não o foco do St. Uma
            // célula focável roubaria o grab da superfície no primeiro Tab.
            can_focus: false,
            // BinLayout com alinhamento central: a célula é do tamanho que o
            // DeskSlot lhe der, e a coluna de arte+rótulo fica no meio dela.
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        this._item = params.item ?? null;
        /** Mesmo id do modelo (`app:…` / `folder:…` / `path:…`). */
        this.id = this._item?.id ?? null;
        this._iconSize = params.iconSize ?? SIZE.ICON;
        this._dark = params.theme === DeskTheme.DARK;
        this._labelPosition = params.labelPosition ?? LabelPosition.BELOW;
        this._doubleClickToOpen = params.doubleClickToOpen !== false;
        this._onOpen = params.onOpen ?? null;
        this._onSelect = params.onSelect ?? null;
        this._dnd = params.dnd ?? null;
        // Só a POLÍTICA fica guardada: o menu em si nasce no primeiro botão
        // direito desta célula. Ver DeskIconMenu.
        this._menuPolicy = params.menu ?? null;
        this._menu = null;
        this._state = State.IDLE;
        // Instante (monotônico) em que o último arraste acabou. Ver
        // _swallowClick(): é o que separa "clique" de "rabo de arraste".
        this._dragEndedAt = 0;
        this._selected = false;
        this._hoverPainted = false;
        this._mergeHover = false;
        this._mergePainted = false;
        this._dragMonitor = null;
        this._detachClick = null;
        this._mergeTimeoutId = 0;
        // Marca de "esta célula já morreu". Lida pelo fim de gesto do dnd,
        // que continua emitindo sobre um draggable cujo actor já se foi.
        this._animDestroyed = false;
        // Único recurso solto desta célula: o dwell do realce de merge.
        // Vai num tracker por regra da casa — nada que precisa de limpeza
        // mora num `_xxxId` avulso.
        this._timeouts = new TimeoutTracker();

        if (this._dark) this.add_style_class_name('arc-cell-dark');

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Caixa de layout FIXO do tamanho do ícone: ela existe para poder
        // pendurar o halo de merge em coordenadas negativas, transbordando
        // a caixa sem participar da alocação — um halo que alocasse faria a
        // célula inteira crescer no instante em que o realce acende, e a
        // grade toda daria um pulo no meio de um arraste.
        const stage = new St.Widget({
            width: this._iconSize,
            height: this._iconSize,
            reactive: false,
            // CENTER e não o FILL padrão: a coluna tem a largura do RÓTULO
            // (maior que o ícone), e com FILL uma caixa de largura explícita
            // fica encostada na borda esquerda dessa coluna — o ícone
            // apareceria deslocado à esquerda do próprio nome.
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Realce de "soltar aqui cria uma pasta". Entra ANTES da arte para
        // ficar atrás dela, e é IRMÃO da arte (não pai) porque quem encolhe
        // no merge é só a arte: se o halo fosse o pai, encolheria junto e
        // sumiria no mesmo instante em que precisa aparecer.
        const haloPad = MERGE.HALO_PAD;
        this._halo = new St.Widget({
            style_class: 'arc-merge-halo',
            reactive: false,
            opacity: 0,
            width: this._iconSize + 2 * haloPad,
            height: this._iconSize + 2 * haloPad,
        });
        this._halo.set_position(-haloPad, -haloPad);
        if (this._dark) this._halo.add_style_class_name('arc-merge-halo-dark');
        this._halo.set_style('border-radius: ' +
            `${Math.round(this._iconSize * HALO_RADIUS_FRACTION) + haloPad}px;`);
        stage.add_child(this._halo);

        // Bin de tamanho fixo em volta da textura: o tema pode devolver um
        // ícone menor que o pedido (fallback de tamanho), e sem a caixa fixa
        // a célula encolheria junto, quebrando o alinhamento da grade.
        const iconBin = new St.Bin({
            width: this._iconSize,
            height: this._iconSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        iconBin.set_position(0, 0);
        // Pivô no CENTRO: o encolhimento do merge é para DENTRO da caixa da
        // arte, ao contrário do hover, que cresce a partir da base.
        iconBin.set_pivot_point(0.5, 0.5);
        iconBin.set_child(this._createIconActor(this._iconSize));
        stage.add_child(iconBin);
        this._iconBin = iconBin;
        this._stage = stage;
        // Pivô na BASE. Crescer a partir do meio parece simétrico no papel,
        // mas manda metade do aumento para BAIXO, em cima do rótulo.
        // Ancorado na base, todo o crescimento vai para cima, onde há folga.
        stage.set_pivot_point(0.5, 1.0);
        box.add_child(stage);

        this._label = null;
        if (this._labelPosition === LabelPosition.BELOW)
            this._label = this._createLabel(params.labelWidth ?? SIZE.LABEL_MAX_WIDTH, box);

        this.add_child(box);

        this.connect('notify::hover', () => {
            if (this.hover) {
                Cursor.setPointer();
                this._setHoverPainted(true);
            } else {
                Cursor.setDefault();
                this._setHoverPainted(false);
            }
        });
        // Segundo caminho de limpeza, de propósito: quando a superfície
        // destrói uma linha inteira de slots, o Clutter destrói as células
        // por dentro sem passar pelo destroy() em JS — só o SINAL chega aos
        // dois caminhos.
        this.connect('destroy', () => this._onDestroyed());

        this._setupClick();
        if (this._dnd) this._setupDnd();
    }

    // --- Leitura ---

    get item() {
        return this._item;
    }

    /** App da célula, ou null quando ela é pasta ou caminho. */
    get app() {
        return this._item?.type === ItemType.APP ? this._item.app ?? null : null;
    }

    get isFolder() {
        return this._item?.type === ItemType.FOLDER;
    }

    get isPath() {
        return this._item?.type === ItemType.PATH;
    }

    /**
     * Retângulo da ARTE em coordenadas de stage, no tamanho de REPOUSO.
     *
     * É a arte e não a célula inteira porque a célula inclui a faixa do
     * rótulo: mirar nela faria o painel de pasta (e o ícone fantasma que
     * está voando para cá) nascer deslocado para baixo da arte que o
     * usuário viu.
     *
     * Centro MEDIDO, tamanho em REPOUSO: a caixa da arte pode estar
     * encolhida pelo realce de merge ou crescida pelo hover no instante em
     * que alguém pergunta, e devolver esse tamanho faria o voo mirar uma
     * caixa que já está voltando ao normal. O centro não se mexe — os dois
     * pivôs preservam ou o meio ou a base.
     */
    getArtRect() {
        const actor = this._iconBin ?? this;
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        return {
            x: x + (width - this._iconSize) / 2,
            y: y + (height - this._iconSize) / 2,
            width: this._iconSize,
            height: this._iconSize,
        };
    }

    /**
     * Troca só o texto do rótulo.
     *
     * Existe para renomear uma pasta não custar uma remontagem da grade
     * inteira: o nome é a única coisa que muda, e remontar destruiria a
     * célula que o painel aberto está usando como âncora.
     */
    setLabelText(text) {
        this._label?.set_text(text ?? '');
        if (this._item) this._item.name = text ?? '';
    }

    /** Realce da célula selecionada. A superfície é dona da seleção. */
    setSelected(selected) {
        const on = selected === true;
        if (this._selected === on) return;
        this._selected = on;
        if (on) {
            this.add_style_class_name('arc-cell-selected');
            if (this._dark) this.add_style_class_name('arc-cell-selected-dark');
        } else {
            this.remove_style_class_name('arc-cell-selected');
            if (this._dark) this.remove_style_class_name('arc-cell-selected-dark');
        }
    }

    /**
     * Apaga o realce de hover sem depender de um leave-event.
     *
     * A superfície chama isto quando o ponteiro aparece sobre o pixel vazio
     * dela: o St nem sempre entrega o leave da célula nesse caminho, e sem
     * esta rede o hover ficaria aceso num ícone que o cursor já deixou. Sai
     * cedo quando não há nada aceso — o motion-event é quente.
     */
    clearHover() {
        if (!this._hoverPainted) return;
        this._setHoverPainted(false);
    }

    /**
     * Quique de "cheguei": a arte nasce encolhida e assenta no tamanho
     * normal.
     *
     * É o fecho da animação de juntar em pasta. Roda no ícone NOVO, depois
     * da remontagem da grade, e não no alvo do drop antes dela: a remontagem
     * destrói o ícone alvo, e um quique começado ali seria cortado no meio
     * pelo rebuild que o próprio drop agendou.
     *
     * EASE_OUT_BACK, o único ultrapasse da área de trabalho: a pasta acabou
     * de engolir um app, e é o exagero no fim que conta essa história.
     */
    playAppearPop() {
        if (!this._iconBin) return;
        this._iconBin.remove_transition(SCALE_X);
        this._iconBin.remove_transition(SCALE_Y);
        this._iconBin.set_scale(ANIM.MERGE_ICON_SCALE, ANIM.MERGE_ICON_SCALE);
        this._iconBin.ease({
            scale_x: 1,
            scale_y: 1,
            duration: ANIM.APPEAR_POP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    // --- Clique ---

    _setupClick() {
        this._detachClick = attachClickOpen(this, {
            onSingle: () => this._guard(() => {
                this._select();
                // Com o duplo clique DESLIGADO o clique simples já abre.
                // A seleção continua acontecendo antes (e não some, apesar
                // do "sem etapa de seleção" da descrição da chave): quem
                // guarda `_selected` é a superfície, e deixá-la desatualizada
                // faria o teclado continuar navegando a partir do item
                // anterior.
                if (!this._doubleClickToOpen) this._open();
            }, 'single click'),
            onDouble: () => this._guard(() => {
                // Com o duplo clique desligado, o primeiro clique JÁ abriu.
                // Abrir de novo aqui lançaria o app duas vezes.
                if (!this._doubleClickToOpen) return;
                this._open();
            }, 'double click'),
            // Sem política de menu não há para onde mandar o botão direito,
            // e aí nem o ClickGesture secundário nem o LongPress são criados.
            onSecondary: this._menuPolicy
                ? () => this._guard(() => this.toggleMenu(), 'context click')
                : null,
            shouldIgnore: () => this._swallowClick(),
        });
    }

    _select() {
        this._guard(() => this._onSelect?.(this), 'onSelect');
    }

    _open() {
        this._guard(() => this._onOpen?.(this._item, this), 'onOpen');
    }

    /**
     * Este clique é o rabo de um arraste, e não um clique de verdade?
     *
     * Não basta olhar o estado: do GNOME 49 em diante o clique é reconhecido
     * por um ClutterClickGesture que corre POR FORA da propagação de evento
     * do dnd e não sabe nada dele. O reconhecimento nasce do mesmo
     * button-release que ENCERRA o arraste e pode chegar DEPOIS do
     * 'drag-end' — com o estado já de volta em IDLE. Daí a janela de tempo:
     * ela cobre esse atraso sem depender da ordem entre os dois caminhos.
     *
     * É tempo e não um flag limpo por timeout de propósito: um timeout seria
     * mais um recurso para cancelar no destroy, e um relógio monotônico
     * morre junto com o objeto sem precisar de nada.
     */
    _swallowClick() {
        if (this._state === State.DRAGGING) return true;
        if (!this._dragEndedAt) return false;
        return GLib.get_monotonic_time() - this._dragEndedAt <
            TIMING.DRAG_CLICK_GUARD_US;
    }

    // --- Menu de contexto ---

    get isMenuOpen() {
        return !!this._menu?.isOpen;
    }

    /**
     * Abre (ou fecha) o menu de contexto desta célula.
     *
     * Público porque o teclado também chega aqui: a célula é
     * `can_focus: false`, então a tecla Menu / Shift+F10 é tratada pela
     * superfície e encaminhada para a célula selecionada.
     */
    toggleMenu() {
        // Sem política, ou com um arraste em curso: nenhum menu. Um menu
        // aberto no meio de um gesto empurraria um modal por cima do modal
        // do dnd e o drop terminaria em cima do menu.
        if (!this._menuPolicy || this._state === State.DRAGGING) return;
        if (!this._menu) {
            this._guard(() => {
                this._menu = new DeskIconMenu({
                    sourceActor: this,
                    item: this._item,
                    policy: {
                        ...this._menuPolicy,
                        // A superfície precisa saber QUAL célula abriu, e o
                        // DeskIconMenu não conhece a célula — ela é só o
                        // actor de ancoragem para ele.
                        stateChanged: isOpen =>
                            this._menuPolicy?.stateChanged?.(this, isOpen),
                    },
                });
            }, 'menu creation');
        }
        this._menu?.toggle();
    }

    closeMenu() {
        this._menu?.close();
    }

    // --- Hover ---

    _setHoverPainted(painted) {
        if (this._hoverPainted === painted) return;
        this._hoverPainted = painted;
        // EASE_OUT_QUAD nos dois sentidos: a ida acompanha o ponteiro que
        // chega e a volta sai rápido e assenta, que é o que impede o realce
        // de parecer que está sendo arrastado atrás do cursor.
        if (this._stage) {
            const scale = painted ? ANIM.HOVER_ICON_SCALE : 1;
            this._stage.remove_transition(SCALE_X);
            this._stage.remove_transition(SCALE_Y);
            this._stage.ease({
                scale_x: scale,
                scale_y: scale,
                duration: ANIM.HOVER_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        if (!this._label) return;
        this._label.remove_transition(TRANSLATION_Y);
        this._label.ease({
            translation_y: painted ? HOVER_LABEL_SHIFT : 0,
            duration: ANIM.HOVER_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        // O peso do rótulo troca de uma vez, sem transição: ele vem do
        // font-weight/font-size da classe de hover, e nenhum dos dois é
        // interpolável no St. Um scale_* do Clutter animaria, mas descolaria
        // a text-shadow dos glifos e o nome sairia em dobro.
        if (painted) {
            this._label.add_style_class_name('arc-grid-label-hover');
            if (this._dark)
                this._label.add_style_class_name('arc-grid-label-hover-dark');
        } else {
            this._label.remove_style_class_name('arc-grid-label-hover');
            if (this._dark)
                this._label.remove_style_class_name('arc-grid-label-hover-dark');
        }
    }

    // --- Arrastar (origem) ---

    _setupDnd() {
        // _delegate é o que o dnd lê dos DOIS lados: no arraste ele
        // identifica a ORIGEM (`this.actor._delegate`), e no drop é por ele
        // que o alvo é encontrado — o dnd pega o actor sob o pixel e SOBE a
        // árvore procurando um `_delegate` que responda.
        this._delegate = this;
        this._draggable = DND.makeDraggable(this, {
            // Não-zero de propósito: com limiar zero qualquer clique com um
            // pixel de tremor viraria arraste, e o clique — que é a ação
            // principal aqui — seria roubado pelo gesto. O St.DndStartGesture
            // e os ClickGesture de doubleClick.js convivem no mesmo actor; é
            // o framework de gestos que arbitra entre eles.
            timeoutThreshold: TIMING.DRAG_HOLD_MS,
            restoreOnSuccess: false,
        });
        this._draggable.connect('drag-begin', () => {
            this._state = State.DRAGGING;
            // LEI 2: invisível e fora do pick, mas NUNCA hide(). A célula
            // precisa continuar ocupando o slot e, mais importante,
            // continuar MENSURÁVEL.
            //
            // Este handler roda dentro do _gestureRecognized() do dnd, e
            // poucas linhas abaixo dele o dnd mede o nosso
            // getDragActorSource() para decidir onde a arte no ar nasce e
            // para onde ela volta num drop recusado. Um actor escondido ali
            // é geometria inválida — e um NaN nessa conta contamina a
            // posição do fantasma, a alocação dele e, no fim, o voo que
            // devolveria a grade ao normal.
            //
            // Sair do pick era a outra metade do hide(), e é o que
            // util_set_hidden_from_pick faz sozinho (é o mesmo que o dnd usa
            // no próprio actor de arraste): sem isso o ícone seria o alvo de
            // drop do seu próprio arraste.
            this._guard(() => {
                Shell.util_set_hidden_from_pick(this, true);
                this.opacity = 0;
                // O hover fica aceso se a célula sair de baixo do cursor sem
                // um leave, e um ícone "crescido" invisível ainda mede
                // grande em getArtRect().
                this._setHoverPainted(false);
            }, 'drag begin');
            this._notifyDnd('onDragBegin');
        });
        const restore = () => {
            this._state = State.IDLE;
            // Carimbado ANTES de qualquer saída: é o que segura o clique
            // atrasado deste mesmo gesto (ver _swallowClick).
            this._dragEndedAt = GLib.get_monotonic_time();
            // Célula já destruída: o dnd continua emitindo 'drag-cancelled' e
            // 'drag-end' sobre o draggable, e cada toque em actor morto aqui
            // vira exceção DENTRO do handler do Shell — que aborta o resto do
            // fim de gesto e enche o journal de "already disposed". Sair cedo
            // é a única resposta: quem já morreu não tem opacidade, nem hover
            // de merge, nem grade para avisar.
            if (this._animDestroyed) return;
            this._guard(() => {
                this._setMergeHover(false);
                Shell.util_set_hidden_from_pick(this, false);
                this.opacity = 255;
                // show() de qualquer forma: a superfície esconde a célula de
                // verdade enquanto o fantasma dela atravessa a tela, e é
                // deste caminho (ou da grade nova) que ela volta.
                this.show();
            }, 'drag end');
            this._notifyDnd('onDragEnd');
        };
        this._draggable.connect('drag-end', restore);
        this._draggable.connect('drag-cancelled', restore);
    }

    /**
     * LEI 1: nada nosso pode escapar para dentro do dnd do Shell.
     *
     * O `_Draggable` é um `Signals.EventEmitter`: o `emit()` dele percorre os
     * handlers num laço JS **sem try/catch**, e 'drag-begin' sai de dentro
     * de `_gestureRecognized()` enquanto 'drag-end' sai de dentro de
     * `_dragActorDropped()`. Uma exceção nossa sobe por esse emit e aborta o
     * resto do fim de gesto — inclusive o `_dragComplete()`, que é quem
     * devolve o `Main.pushModal` empurrado no início do arraste.
     *
     * O sintoma disso não é um gesto perdido, é o dnd da SESSÃO inteira
     * travado: o grab fica de pé para sempre, nenhum arraste novo começa e o
     * Escape passa a cair no `_cancelDrag` de um arraste que já acabou. Ou
     * seja: "só funciona na primeira vez".
     */
    _guard(fn, what = 'drag handler') {
        try {
            fn();
        } catch (e) {
            logError(e, `[ArcDesk] desk icon ${what} failed`);
        }
    }

    /** Idem, para um callback da política de arraste (que é da superfície). */
    _notifyDnd(name, ...args) {
        this._guard(() => this._dnd?.[name]?.(this, ...args), `dnd ${name}`);
    }

    /**
     * Actor que o ponteiro carrega. Uma cópia NOVA da arte, sem rótulo e sem
     * célula: é assim que o Launchpad arrasta, e é o que evita reparentar a
     * própria célula para fora do slot — o que desmontaria a grade durante o
     * gesto.
     */
    getDragActor() {
        // Blindado pelo mesmo motivo do _guard: os dois getters são chamados
        // por _gestureRecognized() DEPOIS do pushModal, e uma exceção aqui
        // deixaria o grab de pé sem nunca chegar a um fim de gesto que o
        // devolvesse. Um ícone genérico é uma saída ruim; a sessão sem
        // ponteiro não é saída nenhuma.
        let actor = null;
        this._guard(() => {
            actor = this._createIconActor(this._iconSize);
        }, 'drag actor creation');
        return actor ?? new St.Icon({
            icon_name: 'application-x-executable',
            icon_size: this._iconSize,
        });
    }

    /** Para onde a arte volta quando o drop é recusado. */
    getDragActorSource() {
        return this._iconBin ?? this._stage ?? this;
    }

    // --- Alvo de drop ---

    /**
     * O que este ícone diz enquanto algo passa por cima dele.
     *
     * Nunca `NO_DROP`. O dnd SOBE a árvore de actors chamando cada
     * `handleDragOver` e só para no primeiro que responda algo diferente de
     * CONTINUE — então um NO_DROP aqui mataria o delegate da superfície e a
     * grade inteira ficaria inerte para mover e para trocar de lugar.
     *
     * `MOVE_DROP` sai daqui só no caso do MERGE, e ele é exclusivo de
     * propósito: enquanto formos o alvo, o `handleDragOver` da superfície
     * deixa de rodar, e é por isso que `onMergeHover` existe — é o único
     * jeito de ela saber que precisa apagar o slot aceso. Duas respostas
     * acesas ao mesmo tempo diriam coisas contraditórias sobre o mesmo drop.
     */
    handleDragOver(source, _actor, x, _y) {
        // O próprio ícone arrastado está fora do pick, então este caso é
        // quase inalcançável — mas se chegar, CONTINUE deixa a superfície
        // tratá-lo como "soltou onde estava", que é um drop legítimo e
        // aceito sem mudar nada.
        if (source === this) return DND.DragMotionResult.CONTINUE;
        if (!this._canMergeWith(source)) {
            this._setMergeHover(false);
            return DND.DragMotionResult.CONTINUE;
        }
        if (this._withinEdges(x)) {
            // Faixa da borda: a resposta é TROCAR de lugar, e quem pinta o
            // slot de SWAP é a superfície — então o evento tem que seguir
            // subindo.
            this._setMergeHover(false);
            return DND.DragMotionResult.CONTINUE;
        }
        this._setMergeHover(true);
        return DND.DragMotionResult.MOVE_DROP;
    }

    /**
     * O drop caiu em cima desta célula.
     *
     * O `dragActor` é repassado às duas políticas porque é ele que a
     * superfície ADOTA para fazer voar: o dnd só o destrói se ele ainda for
     * filho do `Main.uiGroup` no fim do drop, então entregá-lo aqui é o que
     * compra a animação. Sem isso a arte simplesmente deixa de existir no
     * frame do drop.
     */
    acceptDrop(source, actor, x, _y) {
        this._setMergeHover(false);
        if (source === this) return false;

        const mergeable = this._canMergeWith(source) && !this._withinEdges(x);
        if (mergeable) return this._dnd?.merge?.(source, this, actor) === true;

        // Não é merge: é TROCA. A troca é feita aqui, e não deixada para a
        // superfície, porque o contrato põe `swap` na política DESTA célula
        // — somos nós que sabemos que o pixel caiu num slot ocupado, e por
        // qual ocupante. Se a política não trouxer `swap`, o `false` faz o
        // dnd continuar subindo a árvore (ele varre os pais até alguém
        // aceitar), e o delegate da superfície resolve.
        if (typeof this._dnd?.swap === 'function') {
            let swapped = false;
            this._guard(() => {
                swapped = this._dnd.swap(source, this, actor) === true;
            }, 'dnd swap');
            if (swapped) return true;
        }
        return false;
    }

    /** A coordenada local caiu na faixa "entre ícones" de uma das bordas? */
    _withinEdges(x) {
        // Fração e não pixels: a célula encolhe com o tamanho do ícone, e uma
        // margem fixa engoliria a zona de merge inteira num ícone de 32px.
        const width = this.width || this._iconSize;
        const edge = width * MERGE.EDGE_RATIO;
        return x < edge || x > width - edge;
    }

    _canMergeWith(source) {
        if (!this._dnd?.canMerge) return false;
        if (!(source instanceof DeskIcon)) return false;
        // Mesma blindagem do _guard, com resposta: uma pergunta que explode
        // vira "não dá para juntar", e o drop cai no caminho de troca.
        let can = false;
        this._guard(() => {
            can = this._dnd.canMerge(source, this) === true;
        }, 'dnd canMerge');
        return can;
    }

    /**
     * Liga/desliga o estado "o ponteiro está parado em cima de mim com algo
     * na mão".
     *
     * O monitor de arraste é a ÚNICA forma de saber que o ponteiro SAIU:
     * `handleDragOver` só é chamado enquanto somos o alvo, e **não existe um
     * handleDragOut**. É o mesmo padrão do AppViewItem do Shell. O monitor é
     * global — deixá-lo para trás faz o Shell chamar de volta para dentro de
     * um actor morto no próximo arraste, e por isso ele também é removido no
     * `_onDestroyed()`.
     */
    _setMergeHover(hovering) {
        if (this._mergeHover === hovering) return;
        this._mergeHover = hovering;
        // A superfície precisa saber: enquanto este ícone for o alvo de
        // "vira pasta", o slot de destino tem que estar apagado. Ela não tem
        // como descobrir isso sozinha — enquanto somos o alvo, o
        // handleDragOver dela não é mais chamado.
        this._notifyDnd('onMergeHover', hovering);

        if (hovering) {
            this._dragMonitor = {
                dragMotion: dragEvent => {
                    if (!this.contains(dragEvent.targetActor))
                        this._setMergeHover(false);
                    return DND.DragMotionResult.CONTINUE;
                },
            };
            DND.addDragMonitor(this._dragMonitor);
            // O drop em si não espera nada (é só geometria) — a pausa existe
            // para o ícone não piscar enquanto o ponteiro apenas atravessa a
            // grade a caminho de outro lugar.
            this._mergeTimeoutId = this._timeouts.add(TIMING.MERGE_DWELL_MS, () => {
                this._mergeTimeoutId = 0;
                this._setMergePainted(true);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._clearMergeTimeout();
        this._setMergePainted(false);
    }

    _setMergePainted(painted) {
        if (this._mergePainted === painted) return;
        this._mergePainted = painted;
        if (this._halo) {
            this._halo.remove_transition(OPACITY);
            this._halo.ease({
                opacity: painted ? 255 : 0,
                duration: ANIM.MERGE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        if (!this._iconBin) return;
        const scale = painted ? ANIM.MERGE_ICON_SCALE : 1;
        this._iconBin.remove_transition(SCALE_X);
        this._iconBin.remove_transition(SCALE_Y);
        this._iconBin.ease({
            scale_x: scale,
            scale_y: scale,
            duration: ANIM.MERGE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _clearMergeTimeout() {
        if (!this._mergeTimeoutId) return;
        this._timeouts.remove(this._mergeTimeoutId);
        this._mergeTimeoutId = 0;
    }

    // --- Construção da arte e do rótulo ---

    _createLabel(labelWidth, box) {
        const label = new St.Label({
            text: this._item?.name ?? '',
            style_class: 'arc-grid-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        if (this._dark) label.add_style_class_name('arc-grid-label-dark');
        // Largura EXPLÍCITA (e não um max-width no CSS, que o St não honra de
        // forma confiável): é ela que garante que toda célula tenha a mesma
        // largura, e é sobre ela que o Pango decide onde cortar.
        label.set_width(labelWidth);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        // Uma linha mantém o slot quadrado; o excedente termina em reticências.
        label.clutter_text.set_single_line_mode(true);
        label.clutter_text.set_line_wrap(false);
        label.margin_top = SIZE.LABEL_GAP;
        // Altura EXPLÍCITA, pelo mesmo motivo da largura: é ela que deixa o
        // hover trocar o peso da fonte sem re-alocar nada, e é exatamente a
        // faixa que a superfície reservou ao calcular cellHeight
        // (LABEL_GAP + LABEL_LINES * LABEL_LINE_HEIGHT). Fixá-la aqui torna
        // aquela conta exata em vez de uma estimativa.
        label.set_height(SIZE.LABEL_LINES * SIZE.LABEL_LINE_HEIGHT);
        box.add_child(label);
        return label;
    }

    /**
     * A arte da célula: capa 3x3 para uma pasta, textura do tema para um app
     * ou um caminho. Chamada duas vezes por célula no máximo (uma na
     * construção, outra por arraste), então não vale cache.
     */
    _createIconActor(size) {
        if (this._item?.type === ItemType.FOLDER) {
            const apps = (this._item.apps ?? [])
                .map(entry => entry?.app)
                .filter(app => app);
            const tile = createFolderPreview(apps, size);
            // O tema escuro é ADITIVO e a capa é pura (não recebe tema); a
            // variante é pendurada aqui, que é onde o tema é conhecido.
            if (this._dark) tile.add_style_class_name('arc-folder-tile-dark');
            return tile;
        }
        if (this._item?.type === ItemType.PATH) {
            // Um caminho não tem Shell.App: é uma pasta do disco, e o ícone
            // dela é o do tema. `folder` é o nome padrão do freedesktop e
            // existe em qualquer tema instalável.
            return new St.Icon({ icon_name: 'folder', icon_size: size });
        }
        // create_icon_texture() resolve o tema de ícones corretamente
        // (inclusive o fallback por wm_class); só devolve null quando o
        // .desktop não tem ícone algum, e aí a célula ainda precisa de alguma
        // coisa do tamanho certo para não desalinhar a grade.
        const texture = this._item?.app?.create_icon_texture?.(size) ?? null;
        if (texture) return texture;
        return new St.Icon({
            icon_name: 'application-x-executable',
            icon_size: size,
        });
    }

    // --- Fim de vida ---

    /**
     * Ligado aos DOIS caminhos: ao sinal 'destroy' e ao override de
     * `destroy()` em JS. Quando a superfície derruba uma linha inteira de
     * slots, o Clutter destrói as células por dentro e só o SINAL chega —
     * mas quando ela destrói uma célula nominalmente, é o método. Idempotente
     * por construção: tudo aqui checa antes de tocar.
     */
    _onDestroyed() {
        // Rede de segurança: o actor ainda está vivo durante o sinal, então
        // dá para parar as transições em vez de deixá-las disparar
        // onComplete sobre um actor já finalizado.
        this._animDestroyed = true;
        try {
            this._stage?.remove_all_transitions();
            this._iconBin?.remove_all_transitions();
        } catch (_) {}

        // Os gestos de clique são `Clutter.Action`s pendurados neste actor:
        // morreriam com ele de qualquer forma, mas o detach também zera o
        // relógio do par de cliques e é o ponto único de limpeza deles.
        if (this._detachClick) {
            const detach = this._detachClick;
            this._detachClick = null;
            try {
                detach();
            } catch (e) {
                logError(e, '[ArcDesk] desk icon click detach failed');
            }
        }

        // Monitor de arraste e dwell do merge são os dois únicos recursos
        // GLOBAIS que esta célula toma emprestado. O monitor deixado para
        // trás faz o Shell chamar um callback sobre um actor morto no
        // próximo arraste da sessão.
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._clearMergeTimeout();
        this._timeouts?.removeAll();
        this._timeouts = null;

        // O menu é filho do uiGroup, não desta célula: ninguém o destruiria
        // junto, e a superfície recria todas as células a cada refresh — um
        // menu esquecido aqui vaza a CADA rebuild. Zerado ANTES de destruir
        // para que o 'open-state-changed' do fechamento (que avisa a
        // superfície) não reentre neste caminho.
        const menu = this._menu;
        this._menu = null;
        if (menu) {
            try {
                menu.destroy();
            } catch (e) {
                logError(e, '[ArcDesk] desk icon menu cleanup failed');
            }
        }
        // Só DEPOIS do destroy: o fechamento que ele dispara ainda passa por
        // este callback para avisar a superfície de que não há mais menu
        // aberto. Zerar antes emudeceria justamente esse aviso.
        this._menuPolicy = null;

        // O ponteiro fica com a mãozinha se a célula sumir sob o cursor
        // (refresh, troca de tamanho de ícone, desativação da extensão).
        if (this.hover) Cursor.setDefault();

        this._halo = null;
        this._stage = null;
        this._iconBin = null;
        this._label = null;
        this._onOpen = null;
        this._onSelect = null;
        this._dnd = null;
        this._draggable = null;
        this._item = null;
    }

    destroy() {
        this._onDestroyed();
        super.destroy();
    }
});
