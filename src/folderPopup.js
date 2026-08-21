import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ANIM, DeskTheme } from './config.js';
import { applyGlass } from './glassEffect.js';
import { SignalTracker } from './trackers.js';
import * as Cursor from './cursor.js';

/**
 * Respiro entre o ÍCONE da pasta e a borda do painel.
 *
 * Tem que ser maior que a ponta da seta (ARROW_DIAGONAL / 2 ≈ 11px), senão
 * a seta encostaria no ícone e o conjunto viraria uma mancha só. Doze
 * deixa a ponta a um fio de distância do rótulo da célula — o suficiente
 * para o olho ligar o painel àquele ícone, que é a única função da seta.
 */
const ANCHOR_GAP = 12;

/**
 * Folga mínima entre o painel e a borda da área utilizável.
 *
 * `bounds` chega da superfície já descontando o que não é área livre (a
 * faixa reservada para a dock, por exemplo), então isto é respiro puro: um
 * painel colado no limite de `bounds` encostaria visualmente justamente na
 * coisa que a área utilizável foi calculada para evitar.
 */
const EDGE_MARGIN = 16;

/**
 * Lado do quadradinho que, girado 45°, vira a seta.
 *
 * O que aparece é só metade dele (ver ARROW_OVERLAP), ou seja um triângulo
 * de ~11px de altura por ~22px de base — a mesma proporção achatada que o
 * BoxPointer do Shell usa. Um quadrado maior daria uma seta pontuda demais
 * para um painel de canto arredondado.
 */
const ARROW_SIZE = 16;

/** Largura/altura do quadrado DEPOIS do giro de 45°: a diagonal. */
const ARROW_DIAGONAL = ARROW_SIZE * Math.SQRT2;

/**
 * O quanto a seta entra por baixo do painel.
 *
 * Metade do lado do quadrado, o que coloca o CENTRO dele exatamente sobre
 * a aresta do painel: para dentro fica a metade escondida, para fora sobra
 * o triângulo. Qualquer valor menor deixaria aparecer os dois vértices
 * laterais do losango e a seta pareceria um diamante solto.
 */
const ARROW_OVERLAP = ARROW_SIZE / 2;

/**
 * Distância mínima entre o centro da seta e o canto do painel.
 *
 * Precisa ser >= ao `border-radius` de `.arc-folder-panel` mais metade da
 * diagonal da seta: dentro do arco do canto não há aresta reta onde a base
 * do triângulo possa se apoiar, e a seta apareceria "flutuando" fora do
 * painel. Mudar o raio no common.css pede revisar este número.
 */
const ARROW_EDGE_INSET = 28 + ARROW_DIAGONAL / 2;

/**
 * Respiro entre o nome da pasta e a primeira linha de ícones.
 *
 * Aplicado como `margin_bottom` da faixa do nome, e não como padding no
 * CSS: a faixa troca de widget (rótulo <-> campo de texto) e a margem
 * pertence ao ESPAÇO entre as duas seções, não a nenhum dos dois widgets.
 * O CSS não deve acrescentar margem vertical própria ali, sob pena de o
 * respiro dobrar.
 */
const TITLE_GAP = 14;

/**
 * Raio e brilho do vidro do painel.
 *
 * ArcDesk NÃO tem um overlay borrado por trás (o launcher da ArcDock tem,
 * e é por isso que a versão de lá não chama applyGlass): aqui o painel se
 * apoia direto no papel de parede e nas janelas, então o vidro é dele.
 * Brilho 1.0 porque quem escurece é a sombra (`arc-shade`) — o blur só
 * embaralha o fundo, e abaixar o brilho aqui somaria dois escurecimentos.
 */
const GLASS_RADIUS = 32;
const GLASS_BRIGHTNESS = 1.0;

/** Nomes das transições animadas — nunca como string solta no meio do código. */
const TRANSLATION_X = 'translation-x';
const TRANSLATION_Y = 'translation-y';
const SCALE_X = 'scale-x';
const SCALE_Y = 'scale-y';
const OPACITY = 'opacity';

/**
 * Estado de VISIBILIDADE do painel.
 *
 * Enum próprio, e não o `State` do config.js: aquele é o estado do gesto
 * de arraste da superfície (IDLE/DRAGGING/FLYING) e não tem nada a ver com
 * "o painel está entrando na tela". A regra da casa é que estado nunca
 * anda como string solta, então ele existe aqui, congelado, mesmo sendo
 * privado deste arquivo.
 */
const PopupState = Object.freeze({
    HIDDEN: 'hidden',
    SHOWING: 'showing',
    SHOWN: 'shown',
    HIDING: 'hiding',
});

function clamp(value, min, max) {
    // Faixa invertida (o painel é mais largo que o espaço em que a seta
    // poderia andar): devolve o meio, que é o único ponto que não fica
    // pior que os dois extremos.
    if (max < min) return (min + max) / 2;
    return Math.max(min, Math.min(max, value));
}

/**
 * Pendura o conteúdo no St.ScrollView.
 *
 * A API MUDOU dentro da faixa suportada — mesma classe de problema do
 * probe sigma/radius em glassEffect.js. Até o GNOME 46 a rolagem recebia o
 * filho por `add_actor()`; do 47 em diante ela virou um StBin comum, com a
 * propriedade `child`, e `add_actor()` deixou de existir. Testamos o
 * método novo primeiro porque é o que sobrevive.
 */
function setScrollChild(scroll, child) {
    if (typeof scroll.set_child === 'function') scroll.set_child(child);
    else scroll.add_actor(child);
}

/**
 * Painel dos apps de uma pasta da área de trabalho, no espírito das pastas
 * do Launchpad: uma cartela que sai do ícone da pasta, com o nome editável
 * em cima e a grade de apps embaixo.
 *
 * O actor raiz é CHROME (`Main.layoutManager.addChrome`), e não um filho
 * do `_backgroundGroup` onde mora a superfície: naquela camada o painel
 * seria desenhado por baixo de todas as janelas, e uma pasta que abre
 * atrás do navegador não abre. `affectsStruts` fica FALSE — a raiz tem o
 * tamanho do monitor, e um strut desse tamanho zeraria a área de trabalho
 * de todos os workspaces.
 *
 * Como consequência do `MonitorConstraint`, a raiz mora no canto do
 * monitor primário e NÃO na origem do stage. `anchor` e `bounds` chegam em
 * coordenadas de stage, então tudo que é posicionado aqui dentro passa
 * antes por `_rootOrigin()` (ver lá).
 */
export class FolderPopup {
    /**
     * @param {object} params
     * @param {(appEntry: object) => St.Widget} params.createIcon fábrica de
     *   célula, fornecida pela superfície (é ela que sabe o tamanho de
     *   ícone, a largura de rótulo e o que fazer no clique)
     * @param {number} params.cellWidth
     * @param {number} params.cellHeight
     * @param {number} params.columns máximo de colunas dentro do painel
     * @param {string} params.theme DeskTheme.LIGHT | DeskTheme.DARK
     * @param {(folderId: string, name: string) => void} params.onRename
     * @param {() => void} params.onClosed chamado sempre que o painel
     *   termina de fechar
     */
    constructor(params = {}) {
        this._createIcon = params.createIcon ?? null;
        this._cellWidth = Math.max(1, Math.round(params.cellWidth ?? 1));
        this._cellHeight = Math.max(1, Math.round(params.cellHeight ?? 1));
        this._columns = Math.max(1, Math.round(params.columns ?? 1));
        // Qualquer valor desconhecido cai no claro, como na dock e no
        // launcher: um tema não reconhecido não pode deixar o painel sem
        // estilo nenhum.
        this._theme =
            params.theme === DeskTheme.DARK ? DeskTheme.DARK : DeskTheme.LIGHT;
        this._onRename = params.onRename ?? null;
        this._onClosed = params.onClosed ?? null;

        this._signals = new SignalTracker();
        // SHOWING/SHOWN enquanto o painel está de pé, HIDING durante o
        // fecho, HIDDEN só quando ele já saiu da tela (a troca acontece no
        // onComplete, nunca na chamada do ease).
        this._state = PopupState.HIDDEN;
        this._folderId = null;
        // Nome vigente do lado do modelo. É o valor para o qual o Escape
        // volta, e é contra ele que o commit decide se vale a pena chamar
        // onRename.
        this._folderName = '';
        this._editing = false;
        // Painel apagado e desmapeado porque um app dele está sendo
        // arrastado — ver setDragMode().
        this._dragMode = false;
        // Guarda contra reentrância: devolver o foco ao fim da edição
        // dispara 'key-focus-out' no campo, que é um dos caminhos de commit.
        this._finishing = false;
        this._focusBeforeEdit = null;
        // Ícones e linhas da grade são refeitos a cada open(): quem os cria
        // é a fábrica da superfície, e a pasta aberta muda.
        this._appIcons = [];
        this._rows = [];
        // Geometria da abertura corrente, guardada porque o fecho é o
        // espelho exato dela — sem isto o painel encolheria para o canto
        // superior esquerdo em vez de voltar para o ícone.
        this._openFrom = null;
        this._grabHelper = null;

        this._buildActor();
    }

    get isOpen() {
        return (
            this._state === PopupState.SHOWING ||
            this._state === PopupState.SHOWN
        );
    }

    /**
     * O campo de nome está com o foco de teclado?
     *
     * A superfície consulta isto antes de tratar tecla: com o grab dela de
     * pé, digitar o nome da pasta acabaria virando atalho na grade.
     */
    get isEditingName() {
        return this._editing;
    }

    get folderId() {
        return this._folderId;
    }

    /**
     * @param {object} folderEntry `{ type:'folder', id, folderId, name, apps }`
     * @param {{x,y,width,height}} anchor retângulo do ÍCONE da pasta, em
     *   coordenadas de stage
     * @param {{x,y,width,height}} bounds área utilizável da tela, em
     *   coordenadas de stage
     */
    open(folderEntry, anchor, bounds) {
        if (!this._root || !folderEntry || !anchor || !bounds) return;

        // Trocar de pasta com o painel aberto é fecho + abertura, não uma
        // mutação no lugar: o zoom de entrada parte de um ícone específico,
        // e reaproveitar o painel deixaria a animação saindo do ícone
        // errado. Sem animação, porque o que o usuário pediu foi a pasta
        // NOVA — e o onClosed sai de dentro do close(), como em qualquer
        // outro fecho, para que a superfície não fique achando que a pasta
        // anterior continua aberta.
        if (this._state !== PopupState.HIDDEN) this.close(false);

        this._folderId = folderEntry.folderId ?? folderEntry.id ?? null;
        this._folderName = folderEntry.name ?? '';
        this._titleLabel.set_text(this._folderName);

        const apps = Array.isArray(folderEntry.apps) ? folderEntry.apps : [];
        // ensure_style() antes de qualquer medida: sem o CSS resolvido o
        // padding do painel vem zero e a cartela sairia apertada em volta
        // da grade.
        this._panel.ensure_style();
        const [padX, padY] = this._panelPadding();

        // Largura disponível para a GRADE: a área utilizável menos as
        // folgas das duas bordas e menos o padding do próprio painel.
        const maxGridWidth = Math.max(
            this._cellWidth,
            bounds.width - 2 * EDGE_MARGIN - padX
        );
        const columns = Math.max(
            1,
            Math.min(
                this._columns,
                Math.max(1, apps.length),
                Math.floor(maxGridWidth / this._cellWidth)
            )
        );
        const rows = Math.ceil(apps.length / columns);
        const gridWidth = columns * this._cellWidth;
        const gridHeight = rows * this._cellHeight;

        this._buildGrid(apps, columns, rows, gridWidth, gridHeight);

        const titleBand = this._measureTitleBand(gridWidth);
        // Altura que sobra para a grade depois de descontar tudo o que não
        // é grade. A grade que não couber vira rolagem (ver _buildActor):
        // recortar em silêncio esconderia apps, e paginar dentro do painel
        // é complexidade que só a pasta gigante justificaria.
        const maxGridHeight = Math.max(
            this._cellHeight,
            bounds.height - 2 * EDGE_MARGIN - padY - titleBand - TITLE_GAP
        );
        const scrollHeight = Math.min(gridHeight, maxGridHeight);
        this._scroll.set_size(gridWidth, scrollHeight);
        this._scroll.visible = apps.length > 0;

        const panelWidth = gridWidth + padX;
        const panelHeight =
            titleBand + (apps.length > 0 ? TITLE_GAP + scrollHeight : 0) + padY;
        this._panel.set_size(panelWidth, panelHeight);
        this._entry.set_width(gridWidth);

        this._layout(anchor, bounds, panelWidth, panelHeight);

        // Topo da chrome a cada abertura, e não só na construção: a chrome
        // da dock (ArcDock) se joga para cima a cada 'restacked', e o painel
        // ficaria por baixo dela. Subir e voltar para DEBAIXO do
        // top_window_group é exatamente o que o addChrome faz — nossa
        // camada é chrome, não é overlay de sistema.
        this._raiseWithinChrome();
        // Um arraste interrompido pode ter deixado o painel apagado (ver
        // setDragMode): a abertura seguinte tem que começar opaca.
        this._dragMode = false;
        this._root.remove_transition(OPACITY);
        this._root.opacity = 255;
        if (this._shade) this._shade.reactive = true;
        // Estado ANTES do show(): o guarda de 'notify::visible' derruba
        // qualquer show de um painel que se diz HIDDEN (ver _buildActor).
        this._state = PopupState.SHOWING;
        this._root.show();

        this._pushGrab();
        this._zoomAndFadeIn();
    }

    /**
     * Fecha o painel. Idempotente; dispara onClosed quando a animação acaba.
     */
    close(animate = true) {
        if (!this._root) return;
        if (this._state === PopupState.HIDDEN || this._state === PopupState.HIDING)
            return;

        // O campo de nome não pode sobreviver ao painel segurando o foco de
        // teclado: para a superfície, isEditingName true com o painel
        // fechado significaria um teclado que nunca mais volta. Commit, e
        // não descarte — o usuário digitou o nome e fechou, que é o gesto
        // universal de "confirma".
        this._finishEditing(true);
        // O grab sai no COMEÇO do fecho: durante os POPUP_CLOSE_MS o painel
        // ainda está na tela, e um Escape ali dentro tem que chegar em quem
        // fica (a superfície), não num painel que já está de saída.
        this._popGrab();
        this._state = PopupState.HIDING;
        // O ponteiro pode estar sobre uma célula na hora do fecho; o
        // 'destroy' de cada ícone devolve o cursor, mas as células só
        // morrem no fim da animação.
        Cursor.setDefault();

        if (!animate) {
            this._settleClosed();
            return;
        }
        this._zoomAndFadeOut();
    }

    /**
     * Tira o painel da FRENTE (sem fechá-lo) enquanto um app de dentro
     * dele está sendo arrastado.
     *
     * A sombra cobre a área útil inteira, e o dnd acha o alvo de drop pelo
     * pixel sob o ponteiro: com ela reactive no caminho, um app arrastado
     * para fora da pasta nunca alcançaria a grade — o drop cairia sempre
     * no painel.
     *
     * Apagar, e não fechar: fechar destruiria a célula de ORIGEM no meio
     * do gesto, e é ela que o dnd usa para desfazer um drop recusado. Quem
     * decide entre voltar (setDragMode(false)) e fechar de verdade é a
     * superfície, no fim do arraste, olhando se algo mudou.
     */
    setDragMode(active) {
        const next = !!active;
        if (!this._root || this._dragMode === next) return;
        this._dragMode = next;
        if (this._shade) this._shade.reactive = !next;
        if (next) {
            // Edição encerrada e grab devolvido ANTES de sumir: um actor
            // desmapeado segurando grab modal é teclado preso em quem
            // ninguém vê — e o dnd empilha o grab dele por cima do nosso
            // logo em seguida.
            this._finishEditing(true);
            this._popGrab();
        }
        this._root.remove_transition(OPACITY);
        if (!next) this._root.show();
        this._root.ease({
            opacity: next ? 0 : 255,
            duration: ANIM.DRAG_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // ESCONDIDO no fim, e não só apagado: o dnd procura o alvo
                // de drop com PickMode.ALL, que enxerga actor não-reactive
                // e actor de opacidade zero. Uma célula invisível do painel
                // continuaria sendo alvo válido bem no meio da grade — o
                // drop cairia no painel em vez de cair na casa. Só um actor
                // DESMAPEADO sai do pick com certeza.
                if (this._root && this._dragMode) this._root.hide();
            },
        });
        // O grab volta junto com o painel, e só quando ele volta: retomá-lo
        // antes seria disputar teclado com o gesto de arraste ainda em
        // curso.
        if (!next && this.isOpen) this._pushGrab();
    }

    destroy() {
        // Sem animação e sem callback: quem destrói já está desmontando a
        // superfície inteira, e um onClosed disparado aqui reentraria num
        // objeto que está no meio do próprio destroy.
        this._onClosed = null;
        const safe = (fn) => {
            try {
                fn();
            } catch (e) {
                logError(e, '[ArcDesk] folder popup destroy step failed');
            }
        };
        // O grab sai ANTES do actor morrer, e incondicionalmente: um grab
        // vazado congela a sessão inteira, e o popModal() de um actor já
        // destruído lança ('incorrect pop').
        safe(() => this._popGrab(this._entry));
        safe(() => this._popGrab());
        this._grabHelper = null;
        safe(() => this._signals.disconnectAll());
        safe(() => Cursor.setDefault());
        safe(() => this._clearGrid());
        safe(() => {
            // Transições vivas seguram onComplete apontando para actors que
            // estão prestes a morrer.
            this._panelGroup?.remove_all_transitions();
            this._shade?.remove_all_transitions();
            this._root?.remove_all_transitions();
        });
        // removeChrome ANTES do destroy: o LayoutManager guarda o actor
        // numa lista própria para região de input e para struts, e um
        // actor destruído dentro dela é um cadáver que ele continua
        // medindo.
        safe(() => {
            if (this._root) Main.layoutManager.removeChrome(this._root);
        });
        // Destruir a RAIZ derruba a sombra junto — e a sombra é reativa e do
        // tamanho da área utilizável: esquecida de pé, vira uma parede
        // invisível por cima da sessão.
        safe(() => this._root?.destroy());
        this._root = null;
        this._shade = null;
        this._panelGroup = null;
        this._panel = null;
        this._arrow = null;
        this._titleButton = null;
        this._titleLabel = null;
        this._entry = null;
        this._scroll = null;
        this._gridBox = null;
        this._createIcon = null;
        this._onRename = null;
        this._focusBeforeEdit = null;
        this._openFrom = null;
        this._folderId = null;
        this._editing = false;
        this._state = PopupState.HIDDEN;
    }

    // --- Construção ---

    _buildActor() {
        // Raiz de layout FIXO (St.Widget sem layout manager): sombra e
        // painel são posicionados à mão. Não é reativa — o pick do Clutter
        // desce nos filhos de um actor não reativo do mesmo jeito, então a
        // sombra continua pegando clique sem que a raiz roube o resto da
        // tela.
        this._root = new St.Widget({
            reactive: false,
            visible: false,
        });
        // O constraint dá à raiz exatamente o monitor primário. É ele que
        // faz o painel acompanhar troca de resolução e de monitor sem uma
        // linha de código nossa — e é ele, também, que faz as coordenadas
        // daqui de dentro NÃO serem as do stage (ver _rootOrigin).
        this._root.add_constraint(
            new Layout.MonitorConstraint({ primary: true })
        );

        // Sombra: existe para focar a atenção no painel E para pegar o
        // clique de fora. Cobre `bounds`, não o monitor inteiro: fora da
        // área utilizável está a faixa da dock, que continua clicável.
        this._shade = new St.Widget({
            style_class: 'arc-shade',
            reactive: true,
            opacity: 0,
            visible: false,
        });
        if (this._theme === DeskTheme.DARK)
            this._shade.add_style_class_name('arc-shade-dark');
        this._root.add_child(this._shade);

        // Grupo de layout fixo com painel + seta dentro: é ELE que a
        // animação move e escala, para que a seta acompanhe o painel como
        // uma peça só. Escalar o painel e a seta em separado abriria uma
        // fresta entre os dois no meio do caminho.
        this._panelGroup = new St.Widget({ reactive: false });
        this._root.add_child(this._panelGroup);

        // Quadrado girado 45°: o que sobra para fora da aresta do painel é
        // um triângulo apontando para o ícone da pasta. Pivô no centro,
        // senão o giro sai do canto superior esquerdo e o losango aparece
        // deslocado meia diagonal para o lado.
        this._arrow = new St.Widget({
            style_class: 'arc-folder-arrow',
            reactive: false,
            width: ARROW_SIZE,
            height: ARROW_SIZE,
        });
        if (this._theme === DeskTheme.DARK)
            this._arrow.add_style_class_name('arc-folder-arrow-dark');
        this._arrow.set_pivot_point(0.5, 0.5);
        this._arrow.rotation_angle_z = 45;
        this._panelGroup.add_child(this._arrow);

        this._panel = new St.BoxLayout({
            style_class: 'arc-glass arc-folder-panel',
            vertical: true,
            reactive: true,
        });
        if (this._theme === DeskTheme.DARK) {
            this._panel.add_style_class_name('arc-glass-dark');
            this._panel.add_style_class_name('arc-folder-panel-dark');
        }
        // Painel ACIMA da seta na ordem de empilhamento: a metade do
        // quadrado que entra sob a cartela tem que ficar coberta por ela.
        // Com a seta por cima, a sobreposição de duas superfícies
        // translúcidas desenharia um quadrado mais escuro dentro do painel.
        this._panelGroup.add_child(this._panel);
        this._panelGroup.set_child_below_sibling(this._arrow, this._panel);

        // Vidro PRÓPRIO, ao contrário da versão da ArcDock. Lá o launcher
        // já tem um Shell.BlurEffect de raio 48 cobrindo o monitor, e um
        // segundo blur por cima só escureceria; aqui não há nada atrás do
        // painel além do papel de parede e das janelas, então sem isto a
        // cartela seria um retângulo chapado no meio da tela.
        try {
            applyGlass(this._panel, {
                radius: GLASS_RADIUS,
                brightness: GLASS_BRIGHTNESS,
            });
        } catch (e) {
            // Sem blur a cartela ainda é uma cartela (o CSS já pinta fundo
            // e borda); uma pasta que não abre porque o efeito falhou, não.
            logError(e, '[ArcDesk] folder popup glass failed');
        }

        // Faixa do nome: rótulo e campo de texto trocam de lugar por
        // `visible` — um filho invisível não ocupa espaço no BoxLayout, e a
        // altura fixada em _measureTitleBand() garante que a troca não
        // mude o tamanho do painel no meio do gesto.
        //
        // O clique-para-editar vem de um St.Button embrulhando o rótulo, e
        // não de um Clutter.ClickGesture: o St.Button funciona igual nas
        // duas gerações (no 49+ ele próprio roteia o clique por
        // ClutterClickGesture, por dentro). A armadilha conhecida desse
        // caminho é um ancestral devolvendo EVENT_STOP no button-press, que
        // cancela o gesture antes de virar 'clicked'. Aqui não há esse
        // risco: os ancestrais do botão são o painel, o grupo e a raiz,
        // todos nossos e nenhum deles consome button-press.
        this._titleLabel = new St.Label({
            style_class: 'arc-folder-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        if (this._theme === DeskTheme.DARK)
            this._titleLabel.add_style_class_name('arc-folder-title-dark');
        this._titleButton = new St.Button({
            style_class: 'arc-folder-title-button',
            can_focus: false,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            child: this._titleLabel,
        });
        this._titleButton.margin_bottom = TITLE_GAP;
        this._panel.add_child(this._titleButton);

        this._entry = new St.Entry({
            style_class: 'arc-folder-entry',
            can_focus: true,
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            // Sem o CENTER vertical o BoxLayout esticaria o campo (o padrão
            // é FILL) até a altura reservada para a faixa.
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (this._theme === DeskTheme.DARK)
            this._entry.add_style_class_name('arc-folder-entry-dark');
        this._entry.margin_bottom = TITLE_GAP;
        this._panel.add_child(this._entry);

        // Rolagem para a pasta que não cabe na altura disponível. A grade em
        // si tem tamanho explícito, então o que a rolagem faz é só recortar
        // e deslizar.
        this._scroll = new St.ScrollView({ reactive: true });
        // Propriedades atribuídas DEPOIS da construção, e não no objeto de
        // init: passar uma propriedade inexistente ao construtor lança, e a
        // superfície do StScrollView mudou entre 46 e 50. Atribuição solta,
        // no pior caso, só cria um campo JS que ninguém lê.
        try {
            this._scroll.hscrollbar_policy = St.PolicyType.NEVER;
            this._scroll.vscrollbar_policy = St.PolicyType.AUTOMATIC;
            // Barra por cima do conteúdo: com a barra ocupando largura, o
            // painel mudaria de tamanho ao passar de uma linha a mais.
            this._scroll.overlay_scrollbars = true;
        } catch (e) {
            logError(e, '[ArcDesk] folder popup scroll policy failed');
        }
        this._gridBox = new St.BoxLayout({ vertical: true, reactive: false });
        setScrollChild(this._scroll, this._gridBox);
        this._panel.add_child(this._scroll);

        // --- Sinais de vida longa (os actors acima vivem enquanto o popup
        // viver). As células da grade não entram aqui: nascem e morrem a
        // cada open(), e um tracker cresceria sem limite ao longo da sessão.

        // Clique na sombra fecha. O press é consumido para que nada abaixo
        // dela reaja, e é no RELEASE que o fecho acontece.
        this._signals.connect(this._shade, 'button-press-event', () =>
            Clutter.EVENT_STOP);
        this._signals.connect(this._shade, 'button-release-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._signals.connect(this._shade, 'scroll-event', () =>
            Clutter.EVENT_STOP);
        this._signals.connect(this._shade, 'motion-event', () => {
            // A sombra é área morta: se o ponteiro saiu de uma célula para
            // cá, o cursor de mãozinha tem que voltar ao normal.
            Cursor.setDefault();
            return Clutter.EVENT_PROPAGATE;
        });

        // Clique DENTRO do painel (no vazio entre ícones) não pode fechar:
        // é o contrato explícito de "clique fora fecha, clique dentro não".
        this._signals.connect(this._panel, 'button-press-event', () =>
            Clutter.EVENT_PROPAGATE);

        // Escape é DISPUTADO, e este handler é o primeiro da fila.
        //
        // O GrabHelper trata Escape num 'captured-event' que ele conecta na
        // raiz no primeiro grab — fase de CAPTURA, ou seja, antes de
        // qualquer handler do campo de texto. Um EVENT_STOP lá dentro do
        // ClutterText, portanto, chegaria tarde demais: o Escape que devia
        // cancelar a EDIÇÃO já teria desfeito o grab e fechado a pasta.
        //
        // A saída é conectar o nosso 'captured-event' na MESMA raiz aqui na
        // construção: handlers de um sinal são chamados na ordem de
        // conexão, e o do GrabHelper só nasce quando o primeiro grab é
        // tomado — depois deste. Com a edição em curso devolvemos
        // EVENT_STOP e o Escape morre aqui; sem edição, deixamos passar e o
        // GrabHelper faz o que sabe fazer (desempilhar o grab, o que fecha
        // o painel pelo onUngrab).
        this._signals.connect(this._root, 'captured-event', (actor, event) =>
            this._onCapturedEvent(event));

        // trackFullscreen faz o LayoutManager reescrever `visible` do actor
        // a cada _updateVisibility() — e isso acontece ao entrar e ao sair
        // da visão geral, na troca de sessão e em monitors-changed. Sem
        // este guarda, um painel fechado (ou apagado por causa de um
        // arraste) reapareceria sozinho na volta da visão geral.
        this._signals.connect(this._root, 'notify::visible', () => {
            if (!this._root) return;
            if (this._root.visible) {
                if (this._state === PopupState.HIDDEN || this._dragMode)
                    this._root.hide();
                return;
            }
            // Apagou sem ser por nossa conta: o trackFullscreen escondeu a
            // chrome porque uma janela entrou em tela cheia. Um painel
            // "aberto" e desmapeado seguraria um grab modal num actor que
            // ninguém vê — teclado preso. Fecha de verdade, sem animação:
            // não há nada na tela para animar.
            if (this.isOpen && !this._dragMode) this.close(false);
        });

        this._signals.connect(this._titleButton, 'clicked', () =>
            this._beginEditing());
        this._signals.connect(this._titleButton, 'notify::hover', () => {
            if (this._titleButton?.hover) Cursor.setPointer();
            else Cursor.setDefault();
        });
        this._signals.connect(
            this._entry.clutter_text,
            'key-press-event',
            (actor, event) => this._onEntryKeyPress(event)
        );
        // Foco saindo do campo = commit. Cobre o clique fora, o fecho do
        // painel e qualquer outra coisa que roube o foco: em todos eles o
        // usuário deixou o nome como está, e o gesto lê como confirmação.
        this._signals.connect(this._entry.clutter_text, 'key-focus-out', () => {
            if (this._editing) this._finishEditing(true);
        });

        // CHROME, e não filho do _backgroundGroup: lá o painel ficaria
        // debaixo de todas as janelas. affectsStruts FALSE porque a raiz
        // tem o tamanho do monitor — um strut desse tamanho zeraria a área
        // de trabalho de todos os workspaces.
        Main.layoutManager.addChrome(this._root, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        // addChrome chama _updateActorVisibility(), que ACENDE o actor
        // (não há fullscreen no ar). O painel nasce fechado.
        this._root.hide();

        // Um GrabHelper por popup, dono = a raiz. POPUP como actionMode,
        // igual ao AppFolderDialog do Shell: é o modo que mantém vivos os
        // atalhos que fazem sentido com uma cartela aberta.
        this._grabHelper = new GrabHelper.GrabHelper(this._root, {
            actionMode: Shell.ActionMode.POPUP,
        });
    }

    // --- Grab de teclado ---

    /**
     * Empilha o grab do painel.
     *
     * Idempotente: `isActorGrabbed` é a pergunta que evita empilhar dois
     * grabs para o mesmo actor (o GrabHelper devolveria true e não
     * empilharia, mas então teríamos um pop a mais do que pushes).
     */
    _pushGrab() {
        if (!this._grabHelper || !this._root) return;
        if (this._grabHelper.isActorGrabbed(this._root)) return;
        try {
            this._grabHelper.grab({
                actor: this._root,
                onUngrab: (isUser) => {
                    // isUser = o próprio usuário desfez (Escape ou clique
                    // fora do actor sob grab). Um pop nosso chega com
                    // false e não pode reentrar no close() que o pediu.
                    if (isUser) this.close();
                },
            });
        } catch (e) {
            logError(e, '[ArcDesk] folder popup grab failed');
        }
    }

    /**
     * Desempilha um grab nosso. TODO push tem que ter o seu pop, inclusive
     * no destroy(): um grab vazado congela a sessão.
     */
    _popGrab(actor = null) {
        const target = actor ?? this._root;
        if (!this._grabHelper || !target) return;
        if (!this._grabHelper.isActorGrabbed(target)) return;
        try {
            this._grabHelper.ungrab({ actor: target });
        } catch (e) {
            logError(e, '[ArcDesk] folder popup ungrab failed');
        }
    }

    /**
     * Fase de captura na raiz: só existe por causa do Escape (ver a
     * conexão em _buildActor).
     */
    _onCapturedEvent(event) {
        try {
            if (event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            if (!this._editing) return Clutter.EVENT_PROPAGATE;
            // Escape aqui é "desisti do nome", NÃO "fecha o painel".
            this._finishEditing(false);
            return Clutter.EVENT_STOP;
        } catch (e) {
            // Nada que roda dentro da entrega de evento do Shell pode
            // escapar: uma exceção aqui aborta o resto da propagação.
            logError(e, '[ArcDesk] folder popup captured event failed');
            return Clutter.EVENT_PROPAGATE;
        }
    }

    // --- Geometria ---

    /**
     * Canto superior esquerdo da RAIZ em coordenadas de stage.
     *
     * A raiz é presa ao monitor primário por um MonitorConstraint, então
     * ela NÃO mora em (0, 0) do stage num arranjo de vários monitores —
     * mas `anchor` e `bounds` chegam em coordenadas de stage. Tudo que é
     * posicionado dentro da raiz desconta esta origem.
     *
     * A geometria do monitor vem primeiro, e a leitura do actor é só a
     * reserva: o constraint pode ainda não ter passado por um ciclo de
     * alocação na primeira abertura, e `get_transformed_position()` ali
     * devolve NaN — que é justamente o veneno que não pode entrar numa
     * conta de posição (set_position(NaN) faz clutter_actor_allocate
     * abortar por asserção e o actor nunca mais recebe alocação).
     */
    _rootOrigin() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor && Number.isFinite(monitor.x) && Number.isFinite(monitor.y))
            return [monitor.x, monitor.y];
        const [x, y] = this._root.get_transformed_position();
        if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
        return [0, 0];
    }

    /**
     * Sobe o painel dentro da chrome, sem passar por cima do
     * top_window_group.
     *
     * A mesma regra do addChrome(): topo do uiGroup, e logo abaixo do
     * top_window_group se ele estiver lá. Subir sem esse segundo passo
     * colocaria a cartela por cima de menus e tooltips de aplicativos,
     * que é a camada de override-redirect e não é nossa.
     */
    _raiseWithinChrome() {
        const parent = this._root?.get_parent();
        if (!parent) return;
        parent.set_child_above_sibling(this._root, null);
        const top = global.top_window_group;
        if (top && parent.contains(top))
            parent.set_child_below_sibling(this._root, top);
    }

    /** Padding horizontal e vertical do painel, direto do tema resolvido. */
    _panelPadding() {
        try {
            const node = this._panel.get_theme_node();
            return [node.get_horizontal_padding(), node.get_vertical_padding()];
        } catch (e) {
            // get_theme_node() lança quando o actor ainda não tem estilo
            // resolvido. Cartela sem respiro é feia; cartela que não abre é
            // um bug — então segue com zero.
            logError(e, '[ArcDesk] folder popup theme node failed');
            return [0, 0];
        }
    }

    /**
     * Altura da faixa do nome, igual para o rótulo e para o campo.
     *
     * Medir os dois e ficar com o maior é o que impede o painel de mudar de
     * tamanho no instante em que o usuário clica no nome: a faixa já nasce
     * do tamanho do widget mais alto dos dois.
     */
    _measureTitleBand(contentWidth) {
        // Altura de volta ao natural ANTES de medir: a abertura anterior
        // fixou uma altura nos dois widgets, e get_preferred_height() de um
        // actor com tamanho fixo devolve o tamanho fixo — a faixa ficaria
        // presa para sempre no valor da primeira pasta aberta.
        this._titleButton.set_height(-1);
        this._entry.set_height(-1);
        this._titleButton.ensure_style();
        this._entry.ensure_style();
        // Largura passada na medida porque o campo tem largura explícita e
        // o rótulo pode quebrar: a altura de um texto depende da largura
        // disponível.
        const [, labelHeight] = this._titleButton.get_preferred_height(
            contentWidth
        );
        const [, entryHeight] = this._entry.get_preferred_height(contentWidth);
        const band = Math.max(labelHeight, entryHeight);
        this._titleButton.set_height(band);
        this._entry.set_height(band);
        return band;
    }

    /**
     * Posiciona sombra, painel e seta.
     *
     * O painel fica centrado no ícone quando dá, grudado na borda de
     * `bounds` quando não dá, ABAIXO do ícone por padrão e acima quando não
     * há altura embaixo. A seta persegue o centro do ícone dentro do que a
     * aresta reta do painel permite.
     *
     * A conta inteira é feita em coordenadas de STAGE (que é o sistema em
     * que `anchor` e `bounds` chegam) e só o `set_position` final desconta
     * a origem da raiz.
     */
    _layout(anchor, bounds, panelWidth, panelHeight) {
        const [originX, originY] = this._rootOrigin();

        this._shade.set_position(bounds.x - originX, bounds.y - originY);
        this._shade.set_size(bounds.width, bounds.height);

        const anchorCenterX = anchor.x + anchor.width / 2;
        const minX = bounds.x + EDGE_MARGIN;
        const maxX = bounds.x + bounds.width - EDGE_MARGIN - panelWidth;
        const panelX = Math.round(
            clamp(anchorCenterX - panelWidth / 2, minX, maxX)
        );

        const below = anchor.y + anchor.height + ANCHOR_GAP;
        const fitsBelow =
            below + panelHeight <= bounds.y + bounds.height - EDGE_MARGIN;
        const above = anchor.y - ANCHOR_GAP - panelHeight;
        const minY = bounds.y + EDGE_MARGIN;
        const maxY = bounds.y + bounds.height - EDGE_MARGIN - panelHeight;
        const panelY = Math.round(clamp(fitsBelow ? below : above, minY, maxY));

        this._panelGroup.set_position(panelX - originX, panelY - originY);
        this._panelGroup.set_size(panelWidth, panelHeight);
        this._panel.set_position(0, 0);

        // Centro da seta em coordenadas do GRUPO — um delta, portanto imune
        // à origem da raiz. Preso à aresta reta: perto demais do canto e a
        // base do triângulo cairia sobre o arco.
        const arrowCenterX = clamp(
            anchorCenterX - panelX,
            ARROW_EDGE_INSET,
            panelWidth - ARROW_EDGE_INSET
        );
        // A aresta apontada é a de CIMA quando o painel está abaixo do
        // ícone, e a de baixo no caso contrário.
        const arrowCenterY = fitsBelow ? 0 : panelHeight;
        this._arrow.set_position(
            Math.round(arrowCenterX - ARROW_SIZE / 2),
            Math.round(arrowCenterY - ARROW_OVERLAP)
        );

        // Guardado para o fecho: é o mesmo delta, ao contrário. Também
        // imune à origem da raiz, pelo mesmo motivo.
        this._openFrom = {
            translationX: anchor.x - panelX,
            translationY: anchor.y - panelY,
            scale: Math.max(
                ANIM.POPUP_MIN_OPEN_SCALE,
                Math.min(1, anchor.width / Math.max(1, panelWidth))
            ),
        };
    }

    // --- Grade ---

    _buildGrid(apps, columns, rows, gridWidth, gridHeight) {
        this._clearGrid();
        this._gridBox.set_size(gridWidth, gridHeight);
        if (!this._createIcon || apps.length === 0) return;

        for (let row = 0; row < rows; row++) {
            const rowActor = new St.BoxLayout({
                vertical: false,
                reactive: false,
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (let column = 0; column < columns; column++) {
                const index = row * columns + column;
                const entry = apps[index];
                if (!entry) break;
                // Bin de tamanho fixo em volta da célula, como na grade da
                // superfície: é ele que mantém as colunas alinhadas mesmo
                // com rótulos de larguras diferentes.
                const cell = new St.Bin({
                    reactive: false,
                    width: this._cellWidth,
                    height: this._cellHeight,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                let icon = null;
                try {
                    icon = this._createIcon(entry);
                } catch (e) {
                    // Uma célula que não nasceu não pode derrubar a pasta
                    // inteira: o resto dos apps continua utilizável.
                    logError(e, '[ArcDesk] folder popup cell failed');
                    icon = null;
                }
                if (icon) {
                    cell.set_child(icon);
                    this._appIcons.push(icon);
                }
                rowActor.add_child(cell);
            }
            this._gridBox.add_child(rowActor);
            this._rows.push(rowActor);
        }
    }

    _clearGrid() {
        // Ícones primeiro e explicitamente: eles têm destroy() próprio (o do
        // DeskIcon devolve o cursor e solta o monitor de arraste), e
        // destruir só a linha os levaria embora pelo caminho do Clutter,
        // sem passar por ele.
        for (const icon of this._appIcons) {
            try {
                icon?.destroy();
            } catch (e) {
                logError(e, '[ArcDesk] folder popup icon destroy failed');
            }
        }
        this._appIcons = [];
        for (const row of this._rows) row.destroy();
        this._rows = [];
    }

    // --- Animação ---

    /**
     * Entrada: o painel nasce em cima do ícone da pasta, no tamanho dele, e
     * cresce até o próprio lugar — o mesmo gesto do
     * AppFolderDialog._zoomAndFadeIn do Shell.
     *
     * O pivô é o canto SUPERIOR ESQUERDO (0, 0), e não o centro: o par
     * "translation = delta entre os cantos + scale = anchor.width /
     * panelWidth" só mapeia o painel sobre o ícone se a escala crescer a
     * partir do mesmo canto que a translação alinhou. Com o pivô no centro
     * o painel escalado sairia meio tamanho para cima e para a esquerda.
     */
    _zoomAndFadeIn() {
        const from = this._openFrom;
        if (!from) return;

        this._panelGroup.remove_all_transitions();
        this._shade.remove_all_transitions();

        this._panelGroup.set_pivot_point(0, 0);
        this._panelGroup.translation_x = from.translationX;
        this._panelGroup.translation_y = from.translationY;
        this._panelGroup.set_scale(from.scale, from.scale);
        this._panelGroup.opacity = 0;
        this._shade.opacity = 0;
        this._shade.show();

        // Dois eases no mesmo actor porque as curvas são diferentes e o
        // ease() do Clutter aplica UM modo a todas as propriedades da
        // chamada: a geometria sai forte e assenta (EASE_OUT_EXPO, que é o
        // que dá a sensação de "salto"), a opacidade sobe linear-ish
        // (EASE_OUT_QUAD) para o painel não aparecer de uma vez no primeiro
        // quadro.
        this._panelGroup.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            duration: ANIM.POPUP_OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onComplete: () => {
                if (!this._panelGroup) return;
                // Só aqui o estado lógico vira SHOWN: é o instante em que o
                // painel de fato parou no lugar.
                if (this._state === PopupState.SHOWING)
                    this._state = PopupState.SHOWN;
            },
        });
        this._panelGroup.ease({
            opacity: 255,
            duration: ANIM.POPUP_OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._shade.ease({
            opacity: 255,
            duration: ANIM.POPUP_OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Saída: o espelho da entrada, com EASE_IN_QUAD (rápido no começo). */
    _zoomAndFadeOut() {
        const from = this._openFrom;
        // Sem geometria guardada (fecho antes de qualquer abertura completa)
        // só resta o fade — melhor que um salto para o canto (0, 0).
        const translationX = from?.translationX ?? 0;
        const translationY = from?.translationY ?? 0;
        const scale = from?.scale ?? ANIM.POPUP_MIN_OPEN_SCALE;

        this._panelGroup.remove_transition(TRANSLATION_X);
        this._panelGroup.remove_transition(TRANSLATION_Y);
        this._panelGroup.remove_transition(SCALE_X);
        this._panelGroup.remove_transition(SCALE_Y);
        this._panelGroup.remove_transition(OPACITY);
        this._shade.remove_transition(OPACITY);

        this._panelGroup.ease({
            translation_x: translationX,
            translation_y: translationY,
            scale_x: scale,
            scale_y: scale,
            duration: ANIM.POPUP_CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._panelGroup) return;
                // Estado lógico e onClosed só no fim da animação: o painel
                // ainda está na tela durante os POPUP_CLOSE_MS, e quem
                // espera o onClosed (a superfície, para soltar o estado da
                // pasta aberta) não pode ser avisado antes disso.
                this._settleClosed();
            },
        });
        this._panelGroup.ease({
            opacity: 0,
            duration: ANIM.POPUP_CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        this._shade.ease({
            opacity: 0,
            duration: ANIM.POPUP_CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    /** Estado final do fecho, comum ao caminho animado e ao instantâneo. */
    _settleClosed() {
        if (!this._root) return;
        this._panelGroup.remove_all_transitions();
        this._shade.remove_all_transitions();
        this._shade.hide();
        // HIDDEN antes do hide(): é o estado que o guarda de
        // 'notify::visible' consulta para não deixar o LayoutManager
        // reacender um painel fechado.
        this._state = PopupState.HIDDEN;
        this._root.hide();
        this._root.remove_transition(OPACITY);
        this._root.opacity = 255;
        this._dragMode = false;
        // Geometria de volta à identidade: a próxima abertura mede e
        // posiciona tudo de novo, mas uma escala residual apareceria no
        // primeiro quadro antes disso.
        this._panelGroup.set_scale(1, 1);
        this._panelGroup.translation_x = 0;
        this._panelGroup.translation_y = 0;
        this._panelGroup.opacity = 255;
        this._folderId = null;
        this._openFrom = null;
        // Dezenas de texturas de ícone não precisam ficar de pé enquanto
        // ninguém olha; open() remonta a grade de qualquer forma.
        this._clearGrid();
        this._onClosed?.();
    }

    // --- Nome editável ---

    _beginEditing() {
        if (this._editing || !this._entry) return;
        this._editing = true;
        // O foco anterior é devolvido no fim da edição.
        this._focusBeforeEdit = global.stage?.get_key_focus?.() ?? null;

        this._entry.set_text(this._folderName);
        this._titleButton.hide();
        this._entry.show();
        // Grab ANINHADO no campo, por cima do grab do painel. É o que a
        // pilha do GrabHelper existe para fazer: um clique fora do campo
        // (mas dentro do painel) desempilha SÓ este grab — o painel
        // continua de pé — e chega aqui como isUser=true, que é o gesto
        // "digitei e cliquei fora", ou seja, confirma. O Escape não passa
        // por aqui: ele é interceptado antes, em _onCapturedEvent.
        if (this._grabHelper && this._root) {
            try {
                this._grabHelper.grab({
                    actor: this._entry,
                    focus: this._entry,
                    onUngrab: (isUser) => {
                        if (isUser) this._finishEditing(true);
                    },
                });
            } catch (e) {
                logError(e, '[ArcDesk] folder popup entry grab failed');
            }
        }
        this._entry.grab_key_focus();
        // Texto todo selecionado: renomear é quase sempre substituir o nome
        // inteiro, e é o que o Finder e o Launchpad fazem.
        this._entry.clutter_text.set_selection(0, -1);
    }

    /**
     * Encerra a edição.
     *
     * @param {boolean} commit true = grava o que está no campo; false =
     *   descarta e mantém o nome anterior (Escape).
     */
    _finishEditing(commit) {
        if (!this._editing || this._finishing) return;
        // Marcado ANTES de qualquer coisa que mexa no foco ou no grab:
        // devolver o foco dispara 'key-focus-out' no campo e desempilhar o
        // grab dispara o onUngrab — os dois são caminhos que chamam de
        // volta este método.
        this._editing = false;
        this._finishing = true;
        try {
            // Grab do campo primeiro, ainda com ele mapeado e com o foco:
            // o GrabHelper devolve o foco que estava salvo, e um ungrab
            // depois do hide() estaria devolvendo foco a partir de um actor
            // desmapeado.
            this._popGrab(this._entry);
            const text = (this._entry?.get_text() ?? '').trim();
            // Nome vazio (ou só espaço) é recusado, não gravado: uma pasta
            // sem nome fica impossível de identificar na grade, e o gesto
            // "apagou tudo e saiu" quase nunca quer dizer isso.
            if (commit && text && text !== this._folderName) {
                this._folderName = text;
                // Rótulo atualizado na hora, sem esperar o modelo voltar: a
                // superfície pode remontar a grade em seguida, e até lá o
                // painel tem que mostrar o que o usuário acabou de digitar.
                this._titleLabel?.set_text(text);
                try {
                    this._onRename?.(this._folderId, text);
                } catch (e) {
                    logError(e, '[ArcDesk] folder popup rename failed');
                }
            }
            this._entry?.hide();
            this._titleButton?.show();
            this._restoreFocus();
        } finally {
            this._finishing = false;
        }
    }

    _restoreFocus() {
        const target = this._focusBeforeEdit;
        this._focusBeforeEdit = null;
        if (!target) return;
        try {
            // Um actor destruído ou desmontado no meio da edição não é alvo
            // válido de foco: grab_key_focus() ali deixaria o teclado no
            // limbo.
            if (target.mapped) target.grab_key_focus();
        } catch (e) {
            logError(e, '[ArcDesk] folder popup focus restore failed');
        }
    }

    _onEntryKeyPress(event) {
        const symbol = event.get_key_symbol();
        switch (symbol) {
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._finishEditing(true);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Escape:
            // Rede de segurança: no caminho normal o Escape nem chega aqui
            // (ver _onCapturedEvent). Se chegar — grab não tomado, ou uma
            // versão do Shell que trate Escape de outro jeito —, o
            // EVENT_STOP é o que impede a tecla de subir e fechar o painel
            // inteiro no que era para ser um cancelamento de edição.
            this._finishEditing(false);
            return Clutter.EVENT_STOP;
        }
        // Todo o resto pertence ao ClutterText: digitação, seleção,
        // movimento de cursor. Ele consome o que sabe tratar, então nada
        // disso chega à rede de teclado da superfície.
        return Clutter.EVENT_PROPAGATE;
    }
}
