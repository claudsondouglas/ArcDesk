import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { ANIM, SIZE } from './config.js';

/**
 * Arredondamento do quadrado da casa.
 *
 * Mesma família de raio dos ladrilhos de pasta e do realce de merge do
 * common.css; a folga entra na conta porque o quadrado é SLOT_PAD maior
 * que a arte de cada lado, e um raio fixo o deixaria mais "quadrado" que
 * o ícone que ele emoldura. Vem do JS, e não do CSS, pelo mesmo motivo do
 * ArcDock: ele é DERIVADO da folga, e repeti-lo na folha de estilo criaria
 * uma segunda fonte de verdade para o mesmo número.
 */
const SLOT_CORNER = 22;

/**
 * O que a casa está dizendo neste instante.
 *
 * Enum congelado e nunca string solta: são quatro estados de PINTURA, e
 * comparar contra a constante é o que impede um quinto valor de aparecer
 * por engano.
 *
 * SÓ UMA casa fica acesa por vez durante um arraste (ver DeskSurface):
 * duas anunciariam dois destinos, e um deles seria mentira.
 */
export const SlotPaint = Object.freeze({
    // Repouso: a casa existe, ocupa o lugar e não pinta nada.
    NONE: 'none',
    // Buraco de onde o item saiu, e para onde ele volta se o gesto acabar
    // sem sair do lugar. Vale no primeiro instante do arraste (nada se
    // moveu ainda), enquanto o ponteiro estiver fora da grade e enquanto o
    // drop for "junta com este ícone".
    EMPTY: 'empty',
    // Casa VAZIA sob o ponteiro: soltar agora MOVE o item para cá.
    TARGET: 'target',
    // Casa OCUPADA sob o ponteiro: soltar agora TROCA os dois de lugar.
    // Pintura diferente de TARGET de propósito — dois realces iguais
    // anunciariam dois lugares livres, e este não está livre.
    SWAP: 'swap',
});

/**
 * Uma casa da grade da área de trabalho: a célula de tamanho fixo onde um
 * ícone mora, mais o quadrado que aparece durante um arraste.
 *
 * A casa é a peça PARADA do gesto. Numa grade LIVRE nada se reorganiza —
 * não há reflow, que é justamente o ponto —, então as casas nunca mudam
 * de lugar e são elas que definem onde o drop cai, onde o realce acende e
 * onde o fantasma pousa.
 *
 * Duas decisões vêm do gridSlot.js do ArcDock e são carregadas inteiras:
 *
 * 1. **O quadrado mora na CASA, não no ícone.** O ícone arrastado se
 *    apaga durante o próprio gesto, e um quadrado pendurado nele sumiria
 *    exatamente quando precisa aparecer. E uma casa VAZIA — que aqui é o
 *    destino mais comum de todos, porque a grade é livre e quase toda
 *    vazia — não tem ícone nenhum a que se pendurar.
 * 2. **artRect() é medido a partir da CÉLULA, nunca do quadrado.** O
 *    quadrado é SIZE.SLOT_PAD maior de cada lado; mirar nele faria o
 *    ícone em voo aterrissar maior do que vai ficar depois.
 */
export const DeskSlot = GObject.registerClass(
class DeskSlot extends St.Widget {
    /**
     * @param {object} params
     * @param {number} params.col coluna, contada a partir da origem da grade
     * @param {number} params.row linha
     * @param {number} params.cellWidth largura da célula em px FÍSICOS
     * @param {number} params.cellHeight altura da célula em px físicos
     * @param {number} params.iconSize tamanho da ARTE (sem o rótulo), em px
     *   físicos — é o número que artRect() devolve, e é ele que o voo mira
     * @param {number} params.artTop distância do topo da célula até o topo
     *   da arte, medida pela superfície (é ela que conhece a célula inteira)
     * @param {boolean} [params.dark] tema escuro: acrescenta a classe
     *   gêmea, nunca troca a base (o claro é sempre a base — regra do
     *   common.css)
     */
    _init(params = {}) {
        super._init({
            // NÃO reactive: a casa não recebe evento nenhum. Isso não a
            // tira do caminho do drop — o dnd acha o alvo com
            // get_actor_at_pos(PickMode.ALL, …), que ENXERGA actor
            // não-reactive, e é exatamente por isso que uma casa vazia
            // pode receber um drop.
            reactive: false,
            // BinLayout: são duas coisas empilhadas (o quadrado atrás, o
            // ícone na frente). O alinhamento de cada uma vem do próprio
            // filho.
            layout_manager: new Clutter.BinLayout(),
            width: Math.max(1, Math.round(params.cellWidth ?? 1)),
            height: Math.max(1, Math.round(params.cellHeight ?? 1)),
        });
        this._col = Math.max(0, Math.round(params.col ?? 0));
        this._row = Math.max(0, Math.round(params.row ?? 0));
        this._iconSize = Math.max(1, Math.round(params.iconSize ?? 1));
        this._artTop = Math.round(params.artTop ?? 0);
        this._paint = SlotPaint.NONE;
        this._icon = null;

        const pad = Math.max(0, Math.round(SIZE.SLOT_PAD));
        const size = this._iconSize + 2 * pad;
        // Apagado por OPACIDADE e não por visible: é a opacidade que dá o
        // fade, e um actor em opacity 0 não é pintado de qualquer forma.
        this._plate = new St.Widget({
            style_class: 'arc-slot',
            reactive: false,
            opacity: 0,
            width: size,
            height: size,
            x_align: Clutter.ActorAlign.CENTER,
            // START e não CENTER: a célula inclui a faixa do rótulo, e
            // centralizar na célula inteira deixaria o quadrado deslocado
            // para baixo da arte. A altura de verdade chega por
            // translation_y, que não re-aloca nada.
            y_align: Clutter.ActorAlign.START,
            translation_y: this._artTop - pad,
        });
        if (params.dark) this._plate.add_style_class_name('arc-slot-dark');
        this._plate.set_style(`border-radius: ${SLOT_CORNER + pad}px;`);
        this.add_child(this._plate);

        this.connect('destroy', () => this._onDestroyed());
    }

    get col() {
        return this._col;
    }

    get row() {
        return this._row;
    }

    /** O DeskIcon que mora nesta casa, ou null se ela está vazia. */
    get icon() {
        return this._icon ?? null;
    }

    /**
     * Põe (ou tira) o ícone desta casa.
     *
     * `null` SOLTA sem destruir, e um ícone diferente também: quem criou o
     * DeskIcon é a superfície, e é ela que o destrói explicitamente — o
     * destroy() dele devolve o cursor e solta o monitor global de arraste,
     * coisas que a casa não sabe fazer. Uma casa que destruísse o próprio
     * ícone mataria, num relayout, justamente o ícone que ele está sendo
     * mudado de lugar.
     */
    setIcon(icon) {
        const previous = this._icon;
        if (previous && previous !== icon) {
            try {
                if (previous.get_parent() === this) this.remove_child(previous);
            } catch (e) {
                logError(e, '[ArcDesk] slot detach failed');
            }
        }
        this._icon = icon ?? null;
        if (!icon) return;
        try {
            // O ícone pode estar vindo de OUTRA casa (relayout reaproveita
            // os ícones em vez de recriar centenas de texturas), e
            // add_child sobre um actor que ainda tem pai lança.
            const parent = icon.get_parent();
            if (parent === this) return;
            parent?.remove_child(icon);
            this.add_child(icon);
        } catch (e) {
            logError(e, '[ArcDesk] slot attach failed');
            this._icon = null;
        }
    }

    /**
     * Retângulo da ARTE em coordenadas de STAGE — de onde a animação de um
     * ícone que chega parte, e onde ela termina.
     *
     * Medido a partir da CÉLULA e não do quadrado: o quadrado é SLOT_PAD
     * maior de cada lado, e mirar nele faria o ícone aterrissar maior do
     * que vai ficar. Transformado (get_transformed_*) e não somado à mão
     * porque a superfície é posicionada por MonitorConstraint — a origem
     * dela não é (0,0) do stage, e num monitor secundário a aritmética
     * local daria o retângulo errado.
     */
    artRect() {
        const [x, y] = this.get_transformed_position();
        const [width] = this.get_transformed_size();
        return {
            x: x + (width - this._iconSize) / 2,
            y: y + this._artTop,
            width: this._iconSize,
            height: this._iconSize,
        };
    }

    setPaint(paint, animate = true) {
        const next = paint ?? SlotPaint.NONE;
        if (this._paint === next || !this._plate) return;
        this._paint = next;

        // As classes extras entram ANTES do fade: elas só trocam a borda, e
        // trocá-las no fim faria a casa piscar de um estado para o outro
        // com o quadrado já aceso.
        this._plate.remove_style_class_name('arc-slot-target');
        this._plate.remove_style_class_name('arc-slot-swap');
        if (next === SlotPaint.TARGET)
            this._plate.add_style_class_name('arc-slot-target');
        else if (next === SlotPaint.SWAP)
            this._plate.add_style_class_name('arc-slot-swap');

        const opacity = next === SlotPaint.NONE ? 0 : 255;
        this._plate.remove_transition('opacity');
        if (!animate) {
            this._plate.opacity = opacity;
            return;
        }
        this._plate.ease({
            opacity,
            duration: ANIM.SLOT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * Solta o que esta casa segurava.
     *
     * Pelo sinal 'destroy' e não por um destroy() em JS: quem apaga a
     * grade destrói as casas em bloco, e aí o Clutter as leva por dentro
     * sem passar por método nenhum daqui — só o sinal chega aos dois
     * caminhos. O ÍCONE não morre aqui de propósito (ver setIcon).
     */
    _onDestroyed() {
        try {
            this._plate?.remove_all_transitions();
        } catch (_) {}
        this._plate = null;
        this._icon = null;
    }
});
