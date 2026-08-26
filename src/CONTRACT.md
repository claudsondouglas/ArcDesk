# ArcDesk — module contract

This file is the **interface every module must implement exactly**. Modules are written in
parallel by different authors; the only thing that keeps them fitting together is this document.
If an implementation needs to diverge, the divergence must be written back here first.

Nothing below is a suggestion. Signatures, names, return shapes and constant names are binding.

---

## House rules (inherited from ArcDock — non-negotiable)

- **One class = one file = one responsibility.**
- **Anything that needs cleanup never lives loose outside a tracker.** Use `SignalTracker` /
  `TimeoutTracker` from `./trackers.js`, never bare `_xxxId` fields.
- Every class that connects a signal, registers a timeout or allocates an actor **must have
  `destroy()`** that undoes everything it created. `destroy()` is idempotent.
- **Filesystem I/O is never synchronous.** This runs inside the compositor: a sync `query_info()`
  on a dead NFS mount freezes the session. `*_async` + one `Gio.Cancellable` per job, cancelled in
  `destroy()`, and every callback re-checks validity before touching an actor.
- Imports: external (`gi://`, `resource:///`) first, blank line, then relative with an explicit
  `.js` extension.
- Private members carry a `_` prefix. Top-level constants are UPPER_SNAKE inside a frozen object.
- Magic strings for state never live loose — always a frozen enum, compared against the constant.
- Comments in **pt-BR**, user-facing strings in **pt-BR**, gschema/prefs UI strings in **English**.
  This matches ArcDock exactly.
- 4-space indent, single quotes, semicolons.
- Logging: `console.warn('[ArcDesk] …')` and `logError(e, '[ArcDesk] …')`. Never `console.log` for
  anything that must always appear.

### The three drag-and-drop laws

These come from ArcDock's hard-won experience and every one of them corresponds to a bug that cost
a logout to diagnose. They are restated here because ArcDesk reimplements the same machinery.

1. **Nothing of ours may throw inside the dnd's `emit`.** `_Draggable` is a `Signals.EventEmitter`;
   its `emit()` walks handlers in a plain JS loop **with no try/catch**. `drag-begin` comes from
   inside `_gestureRecognized()` and `drag-end` from inside `_dragActorDropped()`. An exception of
   ours rides that emit up and aborts the rest of the gesture — including `_dragComplete()`, which
   is what pops the modal grab pushed at the start of the drag. The symptom is not a lost gesture,
   it is **the whole session's dnd wedged**. Every callback handed to the Shell goes through a
   `_guard(fn, what)` wrapper that try/catches and `logError`s.
2. **A dragged cell goes out of the pick but is NEVER `hide()`n.**
   `Shell.util_set_hidden_from_pick(actor, true)` plus `opacity = 0`. It must stay *measurable*:
   the `drag-begin` handler runs inside `_gestureRecognized()`, and a few lines below it the dnd
   measures `getDragActorSource()` to decide where the airborne art is born and where it snaps back
   to on a refused drop. A hidden actor there is invalid geometry, and one NaN spreads —
   `set_position(NaN)` makes `clutter_actor_allocate` bail on an assertion, the actor never gets an
   allocation, and a flight that was supposed to release the grid may never land.
3. **A full-screen layer must be out of the pick, not merely non-reactive.** The dnd finds its drop
   target with `get_actor_at_pos(Clutter.PickMode.ALL, …)`, and `PickMode.ALL` sees non-reactive
   actors — that is exactly what lets an empty slot accept a drop. A screen-sized layer without
   `Shell.util_set_hidden_from_pick` is a **wall**: the pick stops on it, its parent has no
   `_delegate`, and the whole surface goes inert. The wall only goes up on the FIRST flight, which
   gives the bug its "the first reorder works, the second does nothing" face.

---

## Layer facts every module must respect

- The surface is an `St.Widget` inside **`Main.layoutManager._backgroundGroup`**, sized by
  `Layout.MonitorConstraint({primary: true, workArea: true})` from
  `resource:///org/gnome/shell/ui/layout.js`.
- **Never** add a plain `St.Widget` as a direct child of `global.window_group`: mutter's
  `sync_actor_stacking()` only lowers window actors and background actors on a restack and leaves
  everything else in place, so it ends up **above** every window.
- **Never** anchor to `bgManager.backgroundActor` — it is destroyed on every wallpaper change.
  Anchor to the group.
- Overview hiding and lock-screen hiding are **automatic** (`global.window_group.visible` is driven
  by `Main.sessionMode.hasWindows && !inOverview`). Do not write code for them.
- The surface will **not** appear in the overview or in the workspace-switch animation — both
  render their own separate `Meta.BackgroundGroup`. That is expected, not a bug.
- Folder popups and context menus must **not** live on this layer; see `folderPopup.js` and
  `deskIconMenu.js` below.
- `Clutter.ClickAction`, `Clutter.TapAction` and `Clutter.Event.get_click_count()` **were removed**
  in GNOME 49/50. Use `Clutter.ClickGesture` / `Clutter.LongPressGesture`.

---

## Persistence model

GSettings keys, schema `org.gnome.shell.extensions.arcdesk` (already written and compiled):

| key | type | shape |
|---|---|---|
| `desk-items` | `as` | ordered `["app:firefox.desktop", "folder:<uuid>", "path:/home/u/Downloads"]` — the **public contract** ArcDock appends to |
| `desk-placements` | `s` (JSON) | `{"app:firefox.desktop": {"col": 0, "row": 2}}` |
| `desk-folders` | `s` (JSON) | `{"<bare-uuid>": {"name": "Games", "apps": ["steam.desktop"]}}` — keyed by the **bare** uuid, no `folder:` prefix |
| `desk-item-names` | `s` (JSON) | custom display names keyed by the complete app/path item id |
| `desk-widgets` | `s` (JSON) | widget instances keyed by UUID, with `type`, monitor, logical geometry and type-specific `config` |

Rules that the model enforces and nobody else may reimplement:

- `parseDeskId` splits on the **first** `:` only — the value is a path or an appId and may contain
  more.
- An id whose type this version cannot render is **skipped for display and preserved verbatim on
  write**. Anything else makes an older version silently delete a newer version's items.
- An `app:` whose `.desktop` is not installed **keeps its slot and its placement** but is not drawn.
  A package upgrade removing the file for a few seconds must not destroy the arrangement.
- A folder with **fewer than two** resolvable members is not a folder: 1 member dissolves back into
  that app **in the folder's own slot**, 0 members disappears. Checked on **every** build, not only
  on drag-out, because uninstalling also shrinks a folder.
- An id present in `desk-items` with no placement gets the **first free slot** (scan order is
  column-major from the origin: `col` 0 rows 0..n, then `col` 1, …). This is what makes ArcDock's
  "just append the id" contract work.
- A placement whose id is not in `desk-items` is dropped.
- **Positions are authoritative and are never rewritten when the grid shrinks.** An item outside the
  current `cols`×`rows` is clamped **for display only**. Unplugging a monitor must not destroy the
  arrangement.
- **Write only on real change.** `build()` runs often; unconditional writes are dirty dconf for
  free. Compare the serialised form (folders serialised with sorted keys so the comparison is a
  plain string compare).

Widgets use an independent free-positioned layer within each `DeskSurface`; they never become
`DeskSlot`s and never add a monitor-sized actor that could block icon DnD picking. `WidgetStore`
owns `desk-widgets`, `WidgetHost` owns move/resize interaction, and `widgetRegistry.js` is the only
place allowed to map persisted type names to executable classes. Unknown widget records are
preserved in the JSON even when this version cannot render them. Grid widgets persist `col`, `row`,
`colSpan` and `rowSpan`; the image widget defaults to 4×4 cells and paints with `cover`.

Moving a widget may cross monitor boundaries. `WidgetHost` keeps reporting pointer motion through
`global.stage` after the pointer leaves its source surface and includes the release point plus the
actor's stage-space rectangle in its geometry callback. The source `DeskSurface` selects the live
monitor under that release point; for a foreign monitor, `DeskManager` routes the move to the
destination surface. The destination converts the stage rectangle into its own local coordinates,
snaps it against its own grid while preserving `colSpan`/`rowSpan`, checks icon and widget
occupancy there, then persists the destination monitor index. A refused foreign move snaps back to
the source. The manager reconciles all widget hosts from an idle callback: never destroy the source
host synchronously inside its own `button-release-event` handler.

---

## Modules

### `src/config.js` — owner: **agent 1**

Frozen constant objects only. No imports except `GObject`-free pure JS.

```js
export const SIZE      // ICON:64, ICON_MIN:32, ICON_MAX:128, CELL_PAD_X:24, CELL_PAD_Y:12,
                       // LABEL_GAP:8, LABEL_LINE_HEIGHT:16, LABEL_LINES:1, LABEL_MAX_WIDTH:104,
                       // GRID_MARGIN_X:12, GRID_MARGIN_Y:12, GRID_BOTTOM_MARGIN:0,
                       // GRID_BOTTOM_MARGIN_MAX:256, SLOT_PAD:8, DOCK_RESERVE:96
export const ItemType  // { APP:'app', FOLDER:'folder', PATH:'path' }
export const DeskTheme // { LIGHT:'light', DARK:'dark' }
export const LabelPosition // { BELOW:'below', HIDDEN:'hidden' }
export const GridOrigin    // { TOP_LEFT:'top-left', TOP_RIGHT:'top-right' }
export const ANIM      // HOVER_MS:160, HOVER_ICON_SCALE:1.12, SELECT_MS:120, REFLOW_MS:170,
                       // FLY_MS:200, FLY_FOLDER_MS:240, FLY_FOLDER_SCALE:0.42,
                       // FLY_WATCHDOG_SLACK_MS:400, APPEAR_POP_MS:260, SLOT_MS:120,
                       // MERGE_MS:140, MERGE_ICON_SCALE:0.72, POPUP_OPEN_MS:200,
                       // POPUP_CLOSE_MS:160, POPUP_MIN_OPEN_SCALE:0.25, DRAG_FADE_MS:120
export const TIMING    // DRAG_HOLD_MS:200, MERGE_DWELL_MS:250, DRAG_CLICK_GUARD_US:250000,
                       // DOUBLE_CLICK_FALLBACK_MS:400
export const MERGE     // EDGE_RATIO:0.28, HALO_PAD:8
export const State     // { IDLE:'idle', DRAGGING:'dragging', FLYING:'flying' }
export const DEFAULT_FOLDER_NAME  // 'Pasta'
```

Any constant mirrored in the gschema **must carry a comment saying so**, and values read from
GSettings are re-clamped in JS — a tampered key must not be able to ask for a 10x icon.

### `src/trackers.js`, `src/cursor.js`, `src/glassEffect.js` — owner: **agent 1**

Copied **verbatim** from `../../ArcDock@claudson/src/`, with `[ArcDock]` log prefixes changed to
`[ArcDesk]`. Do not redesign them.

### `src/deskLayout.js` — owner: **agent 1**

Pure model. **Imports only `GLib` and `Gio`** — no `St`, no `Shell`, no `Main`, because `prefs.js`
runs in a separate process and reuses this file. (`Shell.App` resolution is injected, see `build`.)

```js
export const DeskItemType          // re-export of config's ItemType, for symmetry with ArcDock
export function makeDeskId(type, value) -> string
export function parseDeskId(id) -> {type, value} | null   // splits on FIRST ':'

export class DeskLayout {
    constructor(settings /* Gio.Settings | null */)

    reload()                       // re-read all three keys into memory

    /**
     * @param {Shell.App[]} installedApps — resolved by the caller, so this file stays St-free
     * @param {{cols:number, rows:number}} grid — for first-free-slot assignment and clamping
     * @returns {Entry[]} display entries, already clamped into the grid
     */
    build(installedApps, grid) -> Entry[]

    get order()                    // string[] copy of desk-items, INCLUDING invisible/unknown ids
    placementOf(id)                // {col,row} | null — the STORED position, unclamped
    itemAt(col, row)               // id | null, against the last build()'s clamped positions

    addItem(id, at = null)         // at = {col,row} or null for first free slot -> boolean
    removeItem(id)                 // also drops its placement -> boolean
    has(id) -> boolean
    moveTo(id, col, row) -> boolean
    swap(idA, idB) -> boolean

    createFolder(targetId, sourceId) -> string | null   // returns the PREFIXED folder id
    addToFolder(folderId, appId) -> boolean
    removeFromFolder(folderId, appId, col, row) -> boolean
    renameFolder(folderId, name) -> boolean
    renameItem(id, name) -> boolean

    firstFreeSlot(grid) -> {col,row} | null

    /** Subscribe to EXTERNAL writes only — our own writes are suppressed. Returns unsubscribe. */
    onExternalChange(callback) -> () => void

    destroy()
}
```

**Entry shapes** returned by `build()` — these are what `DeskIcon` receives as `item`:

```js
{ type:'app',    id:'app:firefox.desktop', appId:'firefox.desktop', app:<Shell.App>,
  name:'Firefox', col:0, row:0 }
{ type:'folder', id:'folder:<uuid>', folderId:'folder:<uuid>', name:'Games',
  apps:[<app entries>], col:1, row:0 }
{ type:'path',   id:'path:/home/u/Downloads', path:'/home/u/Downloads',
  name:'Downloads', col:0, row:1 }
```

`folderId === id` for folders — both fields exist because the icon keys off `id` and the merge path
keys off `folderId`, exactly as ArcDock's launcher does.

**Echo suppression** — mandatory, and it is the whole reason `onExternalChange` exists rather than
a raw `changed::` connect. `DeskLayout` is the only writer inside this process, but ArcDock writes
`desk-items` too and `prefs.js` writes from another process, so we must listen. Snapshot every
value we write and swallow exactly ONE identical notification, then zero the snapshot so a later
external change (even back to the same value) is processed normally. Copy the shape of
`Dock._onItemsChanged()` / `Dock._persistOrder()` in ArcDock.

### `src/appList.js` — owner: **agent 1**

```js
export function getInstalledApps() -> Shell.App[]   // should_show(), collated by get_name()
export function lookupApp(appId) -> Shell.App | null
```

Trimmed from ArcDock's version: **no fuzzy search, no `filterApps`** — ArcDesk has no search field.

### `src/arcdockBridge.js`

```js
export function notifyArcDockAppClick(app) -> boolean
```

Notifies ArcDock's public API when ArcDesk activates a `Shell.App`. The bridge must check
`Main.extensionManager.lookup('ArcDock@claudson')?.state === ExtensionState.ACTIVE` and repeat
`Extension.lookupByUUID()` on every call — never retain the foreign extension object, because a
disable/enable can leave stale ESM references in the process. Only primitive values (`appId`, name
and the `arcdesk` source) cross into `recordExternalAppClick()`; ArcDock remains the sole owner of
the queue and SQLite. An absent/inactive ArcDock is a no-op returning `false`, and every exception
is caught and logged with the `[ArcDesk]` prefix.

`DeskSurface._activate()` calls the bridge immediately before `Shell.App.activate()`. A double-click
activation, Enter, or the menu's “Abrir” therefore counts once; the first selection-only click does
not count.

### `src/deskSlot.js` — owner: **agent 2**

```js
export const SlotPaint = Object.freeze({
    NONE:'none', EMPTY:'empty', TARGET:'target', SWAP:'swap',
});

export const DeskSlot = GObject.registerClass(class DeskSlot extends St.Widget {
    _init({ col, row, cellWidth, cellHeight, iconSize, artTop })
    get col() / get row()
    get icon()                       // the DeskIcon living here, or null
    setIcon(icon)                    // add as child; null to clear WITHOUT destroying
    artRect() -> {x, y, width, height}   // ART rect in STAGE coords, from get_transformed_*
    setPaint(paint, animate = true)
});
```

Lifted from ArcDock's `gridSlot.js`. Keep its two load-bearing decisions:

- **The plate lives on the slot, not on the icon.** The dragged icon hides itself, so a plate
  hanging off it would vanish exactly when it needs to appear — and an empty slot has no icon to
  hang off at all.
- **`artRect()` is measured from the CELL, not from the plate** (the plate is `SLOT_PAD` bigger on
  every side, so aiming at it lands the flying icon oversized), and it uses `get_transformed_*`.

`SlotPaint.SWAP` is new to ArcDesk: it marks the *occupied* slot whose occupant will trade places
with the dragged item. Paint it differently from `TARGET` — two identical highlights would
announce two free places and one of them would be a lie.

Cleanup is via the `'destroy'` **signal**, not a JS method: the surface destroys whole rows and
Clutter takes the slots down internally. The slot **never destroys its icon** — the surface created
it and destroys it explicitly first, because `DeskIcon.destroy()` restores the cursor and releases
the global drag monitor.

### `src/deskSurface.js` — owner: **agent 2**

The actor, the metrics, the slots and the drop delegate. This is the largest module.

```js
export class DeskSurface {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {number}  params.iconSize
     * @param {string}  params.theme          — DeskTheme value
     * @param {string}  params.labelPosition  — LabelPosition value
     * @param {string}  params.gridOrigin     — GridOrigin value
     * @param {boolean} params.doubleClickToOpen
     * @param {function} params.onOpenFolder  — (folderEntry, anchorRect) => void
     * @param {function} params.onCloseFolder — () => void
     */
    constructor(params)

    get actor()                       // the St.Widget in _backgroundGroup
    get metrics()                     // {cols, rows, cellWidth, cellHeight, iconSize, artTop,
                                      //  originX, originY, labelWidth, bounds:{x,y,width,height}}
    get layout()                      // the DeskLayout instance

    refresh()                         // rebuild from the model, preserving nothing but selection
    relayout()                        // recompute metrics + reposition, without rebuilding icons
    setVisible(visible)
    iconById(id) -> DeskIcon | null
    slotAt(col, row) -> DeskSlot | null
    destroy()
}
```

Responsibilities:

- Create the `St.Widget`, add the `MonitorConstraint`, add it to `_backgroundGroup`, and raise it
  above the wallpaper actors (`set_child_above_sibling(surface, null)`), re-asserting on
  `monitors-changed`.
- **Build after startup.** `global.window_group.set_clip(...)` is live during the startup animation.
  If `Main.layoutManager._startingUp`, defer to `'startup-complete'`.
- Metrics: `cellWidth = iconSize + 2*CELL_PAD_X`, `cellHeight = iconSize + LABEL_BAND + 2*CELL_PAD_Y`
  where `LABEL_BAND = LABEL_GAP + LABEL_LINES*LABEL_LINE_HEIGHT` (0 when labels are hidden);
  The last column/row is included whenever the visible icon art fits; invisible cell padding may
  cross the edge. Do not reserve a full-width bottom strip for ArcDock, which covers only the center.
- Own **one** `DeskLayout`; nobody else constructs one (a second instance would fight the echo
  suppression — this is ArcDock's `DockItemsStore` rule and it applies verbatim).
- Own the slots grid and the `Map<id, DeskIcon>`.
- Carry the **reorder drop delegate on the surface actor itself** (`actor._delegate = {…}`), the way
  ArcDock's launcher puts it on the page actor: the dnd walks up from the picked pixel, so an empty
  slot or the gap between two reaches it for free.
- Own the **ghost flight** (delegating to `GhostFlight`) and the **refresh dam**: `acceptDrop`
  returns into dnd code that is still holding the drag actor and the source cell, so **every layout
  mutation rebuilds through a scheduled idle, never inline**. A flight in progress dams the rebuild;
  a watchdog opens the dam if a transition never completes. Copy this subsystem's shape from
  ArcDock's launcher — it is context-free.
- Own the **selection** (`_selected: DeskIcon|null`) and the click-on-empty-background handler that
  clears it.
- Own normal keyboard focus: `actor.grab_key_focus()` when the user clicks into the surface, and
  release it on Escape, overview, hiding and destroy. Selection must never use `Main.pushModal`:
  a modal also captures the pointer and can make the rest of the session unclickable.

**Drop semantics for the free grid** — this is ArcDesk's own design and differs from the launcher:

| pointer is over | result |
|---|---|
| an empty slot | **move**: `layout.moveTo(sourceId, col, row)` |
| the middle of an occupied slot (outside the `MERGE.EDGE_RATIO` band on each side) | **merge**: create/extend a folder — but only if `canMerge` |
| the edge band of an occupied slot, or the middle of one that cannot merge | **swap**: `layout.swap(sourceId, occupantId)` |
| outside the grid | refused; the art flies home |

There is **no reflow** — that is the whole point of a free grid. Exactly one slot is lit at a time:
the origin slot is painted `EMPTY` at `drag-begin` (nothing has moved yet, and that is where the
icon returns if the gesture ends where it started), and from the first `handleDragOver` on it is the
slot under the pointer, painted `TARGET` or `SWAP`. `acceptDrop` returns **true even when nothing
changed** — a drop in the same slot was handled, and returning false would fly the art back to its
origin as if the gesture had failed.

### `src/deskIcon.js` — owner: **agent 3**

One cell's icon: art, label, hover, selection, click, context menu, and the four dnd verbs.

```js
export const DeskIcon = GObject.registerClass(class DeskIcon extends St.Widget {
    /**
     * @param {object} params
     * @param {object}   params.item          — a build() entry
     * @param {number}   params.iconSize
     * @param {number}   params.labelWidth
     * @param {string}   params.labelPosition — LabelPosition value
     * @param {boolean}  params.doubleClickToOpen
     * @param {function} params.onOpen        — (item, icon) => void
     * @param {function} params.onSelect      — (icon) => void
     * @param {object|null} params.dnd        — policy, see below; null disables dragging
     * @param {object|null} params.menu       — policy, see below; null disables the menu
     */
    _init(params)

    id                                   // public field, = item.id
    get item() / get app() / get isFolder() / get isPath()
    getArtRect() -> {x,y,width,height}   // stage coords, RESTING size
    setLabelText(text)
    setSelected(selected)
    clearHover()
    playAppearPop()
    get isMenuOpen() / toggleMenu() / closeMenu()

    // dnd verbs — the exact set dnd.js looks for
    getDragActor()
    getDragActorSource()
    handleDragOver(source, actor, x, y)
    acceptDrop(source, actor, x, y)

    destroy()
});
```

`dnd` policy the surface hands in (one shared object for every icon — no per-icon state, the icon
arrives as an argument):

```js
{
    canMerge(sourceIcon, targetIcon) -> boolean,
    merge(sourceIcon, targetIcon, dragActor) -> boolean,
    swap(sourceIcon, targetIcon, dragActor) -> boolean,
    onDragBegin(icon),
    onDragEnd(icon),
    onMergeHover(icon, hovering),
}
```

`menu` policy:

```js
{
    open(item), openFolder(item), rename(item), remove(item),
    createShortcut(app), isPinnedToDock(app), togglePinnedToDock(app),  // optional pair
    stateChanged(icon, isOpen),
}
```

Requirements:

- **Extends `St.Widget`, not `St.Button`.** ArcDesk needs multi-click semantics and `St.Button`'s
  `clicked` fires on the first press of a double click.
- **`this._delegate = this`** — that is what the dnd reads to identify the source on drag and to
  find the target on drop.
- `DND.makeDraggable(this, {timeoutThreshold: TIMING.DRAG_HOLD_MS, restoreOnSuccess: false})`.
  Gestures and `makeDraggable` coexist on the same actor; the framework arbitrates.
- `drag-begin`: `Shell.util_set_hidden_from_pick(this, true)` + `opacity = 0`. **Never `hide()`** —
  law 2 above. `drag-end`/`drag-cancelled` restore both and `show()`, and early-return if the actor
  was destroyed mid-gesture (dnd keeps emitting into dead actors).
- Every callback handed to the Shell goes through `_guard(fn, what)` / `_notifyDnd(name, …)` —
  law 1 above.
- **`_swallowClick()`**: from GNOME 49 on, the click is recognised by a gesture that runs *outside*
  dnd's event propagation and can arrive **after** `drag-end`, with `_dragging` already false.
  Guard with a monotonic window: `GLib.get_monotonic_time() - this._dragEndedAt <
  TIMING.DRAG_CLICK_GUARD_US`. A monotonic clock dies with the object; a timeout would be one more
  resource to cancel.
- `handleDragOver` returns `DND.DragMotionResult.CONTINUE` (never `NO_DROP`) when this icon does not
  claim the drop, so the event keeps bubbling to the surface's delegate. `NO_DROP` here would make
  the whole grid inert.
- `_setMergeHover(true)` installs a `DND.addDragMonitor` — that is the **only** way to learn the
  pointer left, because `handleDragOver` runs only while we are the target and **there is no
  `handleDragOut`**. Remove the monitor in `destroy()`; leaving it makes the Shell call back into a
  dead actor on the next drag.
- `_onDestroyed()` is wired to **both** the `'destroy'` signal and the JS `destroy()` override —
  when the surface destroys a whole row, Clutter takes cells down internally and only the signal
  reaches both paths.
- Style classes come from `common.css`: `arc-cell`, `arc-cell-selected`, `arc-grid-label`,
  `arc-grid-label-hover`, `arc-merge-halo`, `arc-folder-tile`, plus the `-dark` twins.

### `src/doubleClick.js` — owner: **agent 3**

Isolates the one thing the research could not verify live.

```js
/**
 * @param {Clutter.Actor} actor
 * @param {object} params
 * @param {function} params.onSingle  — () => void
 * @param {function} params.onDouble  — () => void
 * @param {function} params.shouldIgnore — () => boolean, consulted before every recognise
 * @returns {function} detach — removes the gesture and clears state
 */
export function attachClickOpen(actor, params)
```

Primary path: one `Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY})`, branching on
`gesture.get_n_presses()` — `>= 2` is a double click, `1` is a single. This gives immediate
selection on click 1 and open on click 2, with no timer, and respects the user's
`double-click-time` / `double-click-distance` automatically.

**Safety net, and it must be written:** `get_n_presses()` exists on `Clutter.PressGesture` in
Clutter-18 by introspection but was **not verified in a live compositor**. So probe once at attach
time (`typeof gesture.get_n_presses === 'function'`), and when it is missing — or when it returns a
value that never exceeds 1 across a real double click — fall back to manual timing against
`Clutter.Settings.get_default().double_click_time` (defaulting to
`TIMING.DOUBLE_CLICK_FALLBACK_MS` if that read throws). Log which path was taken once, at
`console.warn`, so the journal answers the question on the first run.

**Never use `event.get_click_count()`** — it does not exist in Clutter-18 and will throw.

Also attach, here or in `deskIcon.js`: a secondary `Clutter.ClickGesture({required_button:
Clutter.BUTTON_SECONDARY, recognize_on_press: true})` for the context menu, and a
`Clutter.LongPressGesture` for touch.

### `src/deskIconMenu.js` — owner: **agent 3**

```js
export class DeskIconMenu {
    constructor({ sourceActor, item, policy })
    get isOpen()
    toggle()
    close()
    destroy()
}
```

- `PopupMenu.PopupMenu(sourceActor, 0.5, St.Side.TOP)` + a `PopupMenuManager`, actor added to
  `Main.layoutManager.uiGroup`. **`St.Side.TOP` is a preference, not a decision** — `BoxPointer`
  flips on its own when the box does not fit.
- **Built on the FIRST right-click of that cell, never in the constructor.** A refresh creates every
  cell and throws them away; a `PopupMenu` + manager per cell would be thousands of actors to show
  at most one.
- **The volatile half is rebuilt on every open** — `can_open_new_window()` of many apps only becomes
  true once the app is running, and the dock-pin label must be read from the store at that instant
  because ArcDock may have been changed from `prefs.js`, in another process, between two clicks.
- **The menu actor lives in `uiGroup`, so this class must destroy it by hand.** Null `_menu` *before*
  calling `destroy()` on it (so the close it triggers cannot re-enter) and null the policy *after*
  (so that close still reaches the surface).
- Items, in order: for an app — the app's own actions via a local copy of ArcDock's
  `fillAppActionsSection()`, then "Abrir", then "Fixar na dock"/"Desafixar da dock" (only when both
  policy callbacks exist — a menu that can read the state but not write it would carry a lying
  label), then "Remover da área de trabalho". For a folder — "Abrir", "Renomear", "Remover da área
  de trabalho". For a path — "Abrir pasta", "Remover da área de trabalho".
- Every item handler and the populate step go through a `_guard`: `_populate()` runs inside a
  button-press and the handlers run inside `emit('activate')`, whose AFTER continuation is what
  closes the menu and pops its modal. An exception there leaves the menu standing on a grab nobody
  will return.

### `src/folderPreview.js` — owner: **agent 3**

```js
export const FOLDER_PREVIEW_SUBICON_FRACTION
export const FOLDER_PREVIEW_MAX_APPS   // 9
export function createFolderPreview(apps /* Shell.App[] */, size /* px */) -> St.Widget
```

Copied verbatim from ArcDock's `appsLauncher/folderPreview.js`; only the CSS class changes to
`arc-folder-tile`. It is **pure** — no signals, no timeouts, no state, no `destroy()`; destroying
the returned actor is the entire cleanup. Keep `Clutter.GridLayout` with
`row_homogeneous`/`column_homogeneous` and all nine cells attached even when empty: without them an
all-empty row collapses and an app's position on the cover would change with folder size. All
paddings are **fractions of `size`**, never px, so one function draws the cover at any icon size.

### `src/folderPopup.js` — owner: **agent 4**

```js
export class FolderPopup {
    constructor({ createIcon, cellWidth, cellHeight, columns, theme, onRename, onClosed })
    get isOpen()          // SHOWING || SHOWN
    get isEditingName()   // the surface consults this before handling keys
    get folderId()
    open(folderEntry, anchor /* stage rect of the folder icon */, bounds /* usable stage rect */)
    close(animate = true)
    setDragMode(active)
    destroy()
}
```

Adapted from ArcDock's `appsLauncher/folderPopup.js`. **Two changes and only two:**

1. **It is chrome, not a desktop-layer actor.** On the desktop layer it would render underneath
   every window. Add its root via
   `Main.layoutManager.addChrome(root, {affectsStruts: false, trackFullscreen: true})` and give it
   `Layout.MonitorConstraint({primary: true})`. `affectsStruts` must stay false — a monitor-sized
   strut would zero the work area on every workspace.
2. **It needs its own glass.** ArcDock's version deliberately skips `applyGlass()` because the
   fullscreen launcher already has a blur behind it; here there is none, so call
   `applyGlass(panel, {radius: 32, brightness: 1.0})` and paint its own `arc-shade` dim behind it.

Everything else transfers unchanged: the anchor/arrow placement math, the corner-pivot zoom
(`pivot_point(0,0)` — the pair "translation = corner delta, scale = anchor.width/panelWidth" only
maps the panel onto the icon if the scale grows from the same corner the translation aligned), the
two separate eases (`ease()` applies one mode to all properties in a call), and the name editing
with its `_finishing` re-entrancy guard.

**`setDragMode(active)` must `hide()` at the end of the fade, not merely fade.** `PickMode.ALL`
still finds an invisible cell, and the drop would land on the panel instead of the grid. Only an
unmapped actor is certainly out of the pick. It is **faded, not closed**: closing would destroy the
drag's source cell mid-gesture, and dnd needs it to undo a refused drop. The surface decides between
`setDragMode(false)` and a real close at `drag-end`, based on whether anything actually changed.

Keyboard: take a grab with `GrabHelper` from `resource:///org/gnome/shell/ui/grabHelper.js` (it
maintains a stack, which matters when a context menu opens on top of the popup). Escape while
editing the name returns `EVENT_STOP` — otherwise it would bubble and dismiss the whole popup on
what was meant to be an edit cancel.

### `src/ghostFlight.js` — owner: **agent 4**

```js
export class GhostFlight {
    constructor({ onIdle })            // onIdle fires when the last ghost lands
    get flying()                       // number in the air
    fly(dragActor, rect, opts = {})    // opts: {duration, scale, fade}
    clear()                            // kill every ghost AND zero the counter
    destroy()
}
```

Lifted from ArcDock's launcher (`_flyGhost` / `_ensureGhostLayer` / `_ghostLayerOrigin` /
`_armFlyWatchdog` / `_clearGhosts`). Four things that are not optional:

- **Adopting the drag actor is literal.** dnd destroys that actor at the end of the drop only if it
  is still a child of `Main.uiGroup`, so reparenting it into our layer is what buys the animation.
  Without it the icon simply stops existing on the drop frame.
- **The reparent preserves the visible CENTRE, not the corner.** The actor may arrive scaled with an
  arbitrary pivot, and only the centre of the transformed rect is the same point in both spaces.
- **Every number is checked with `Number.isFinite` before touching an actor.**
  `get_transformed_*` returns NaN over an actor without a valid allocation; `set_position(NaN)`
  makes `clutter_actor_allocate` bail on an assertion, the actor never gets an allocation, and the
  ease that should decrement the counter may never run — which dams the surface **forever** and
  kills dragging for the rest of the session. A skipped flight is ugly; a NaN flight is fatal.
- **The ghost layer is `Shell.util_set_hidden_from_pick(layer, true)`** — law 3 above — is
  `reactive: false`, is explicitly positioned and sized to the stage, and is
  `set_child_above_sibling(layer, null)`-ed on **every** flight.
- **A removed transition is not a finished transition**: its `'stopped'` arrives with
  `finished=false` and `onComplete` never runs. So `clear()` zeroes the counter by hand, and an
  independent watchdog (`duration + ANIM.FLY_WATCHDOG_SLACK_MS`) force-lands anything still counted,
  with a line in the journal.

### `src/fullscreenWatcher.js` — owner: **agent 2**

Copied from ArcDock, prefix changed. Watches
`global.display.get_monitor_in_fullscreen(Main.layoutManager.primaryIndex)` via
`'in-fullscreen-changed'`, and calls back so the surface can stop painting. Read from the display,
not by scanning windows — it is the same value `LayoutManager` uses for `trackFullscreen`, already
resolved per monitor and already accounting for stacking.

### `src/dingWatcher.js` — owner: **agent 2**

```js
export function warnIfDingActive(settings)   // one-shot, guarded by the `warn-about-ding` key
```

`Main.extensionManager.lookup('ding@rastersoft.com')?.state === ExtensionState.ACTIVE` →
`Main.notify('ArcDesk', 'A extensão Desktop Icons (DING) está ativa e desenha ícones sobre a mesma
área. Desative-a para evitar sobreposição.')`, then set `warn-about-ding` to false so it never
repeats. `ExtensionState` comes from `resource:///org/gnome/shell/misc/extensionUtils.js`.

### `extension.js` — owner: **agent 6**

```js
export default class ArcDeskExtension extends Extension { enable() / disable() }
```

Thin, in ArcDock's shape: read every key with `?? default` fallbacks, build the surface, connect one
`changed::` per *appearance* key that rebuilds the surface wholesale (`icon-size`, `desk-theme`,
`label-position`, `grid-origin`, `double-click-to-open`, `hide-in-fullscreen`), and let the surface
itself observe the three *data* keys. Guard the whole of `disable()` in try/catch, cancel everything,
null everything.

`session-modes` is `["user"]` only — unlike ArcDock, ArcDesk has nothing to do on the lock screen,
and `window_group.visible` already hides it there.

### `prefs.js` — owner: **agent 6**

`Adw` preferences in ArcDock's house style: page "Appearance" (icon-size slider via a
`_makeSliderRow` helper, theme combo, label-position combo, grid-origin combo), page "Behavior"
(double-click switch, hide-in-fullscreen switch), page "Items" (a list of what is on the desktop,
each row with a remove button, rebuilt from `DeskLayout` and refreshed via `onExternalChange`).

**Every write is guarded by a read-compare** (`if (settings.get_X(k) !== v) settings.set_X(k, v)`)
to avoid write loops. `prefs.js` may import `deskLayout.js` — which is exactly why that file must
stay free of `St`/`Shell`/`Main`.

---

## ArcDock integration — owner: **agent 5**, touches ArcDock only

New file `ArcDock@claudson/src/arcdeskBridge.js`:

```js
export function isArcDeskActive() -> boolean
export function isOnArcDesk(id) -> boolean
export function addToArcDesk(id) -> boolean      // id is already `app:…` or `path:…`
export function removeFromArcDesk(id) -> boolean
```

- Presence check is `Main.extensionManager.lookup('ArcDesk@claudson')?.state === ExtensionState.ACTIVE`.
  **`Extension.lookupByUUID(uuid) !== null` is NOT good enough**: the Shell cannot re-import an ESM
  module, so a disabled-but-once-enabled extension keeps its `stateObj` forever.
- **Never cache** the `stateObj` or the foreign `Gio.Settings`. `_callExtensionDisableWithRebase()`
  tears down and rebuilds every extension ordered after the one being toggled, invisibly. Re-look-up
  at every call.
- **Never call into ArcDesk from ArcDock's `enable()`** — load order is by session-mode count, and
  ArcDock's `["user","unlock-dialog"]` sorts it *ahead* of ArcDesk's `["user"]`. Only from user
  actions.
- Read-modify-write in a single synchronous turn (no `await` in the middle), idempotent, whole thing
  in try/catch returning `false`.

Menu items to add, all labelled "Adicionar à área de trabalho" / "Remover da área de trabalho" and
all with `.visible = isArcDeskActive()` refreshed on **every** open:

| file | where | id to write |
|---|---|---|
| `src/dockIcon.js` | `_createMenu()` after `_pinItem`; visibility in `_populateMenu()` | `app:<desktop-id>` |
| `src/folderIcon.js` | `_createMenu()` next to "Remover da dock" | `path:<path>` |
| `src/appsLauncher/appGridMenu.js` | after `_shortcutItem`; label refreshed in the volatile half | `app:<desktop-id>` |

`appGridMenu.js` receives it through the policy object built in `launcher.js:_menuPolicy()` — add
`addToDesk` / `isOnDesk` there, plumbed from `Dock` the same way `isAppPinned`/`onTogglePinned`
already are. Folders in the launcher get **no** such item: `AppGridIcon.toggleMenu()` already
returns early on `!this.app` and everything the menu offers is about an installed app.

This is additive only. Do not restructure anything in ArcDock.

---

## Shared CSS — owner: **agent 7**

Design system lives at `/home/desktopo/.local/share/arcsuite/common.css`, with
`/home/desktopo/.local/share/arcsuite/sync.sh` regenerating each extension's `stylesheet.css` as
**`common.css` ++ `local.css`**.

**Concatenation, never `@import`.** `St`'s `parse_stylesheet()` sets `app_data = FALSE`, so imported
rules land at cascade origin 0 (UA) instead of 6 (extension) and lose to a user theme's
`!important` — which would silently break ArcBar's whole glass-menu block. Concatenated rules keep
the full origin-6 boost and beat even a hostile theme with no `!important` at all.

**Fatal to St CSS on GNOME 50** — any one of these discards the *entire* stylesheet (errcode 15) and
the Shell force-disables the extension. `sync.sh` must grep for them and refuse to write:

- `--anything: value;` (custom properties)
- CSS nesting, `.a { .b { … } }`
- `_foo: value;` (leading underscore in a property name)

**Silently ignored** (parse fine, do nothing): `var()`, `calc()`, `hsl()`, `#RRGGBBAA`, `@media`,
`@supports`, `@keyframes`, `:root`, `::before`/`::after`, `:not()`, `:nth-child()`, `+` and `~`
combinators, `[attr]` selectors, a second `box-shadow` after a comma, `opacity`, `transform`.

**Available instead of variables:** `-st-accent-color`, `-st-accent-fg-color`, `st-mix()`,
`st-lighten()`, `st-darken()`, `st-transparentize()`. Anything genuinely dynamic goes through
`actor.set_style()` from JS.

Namespace is `arc-`, verified collision-free against the shipped GNOME 50 theme. Dark is **additive**
— `class="arc-glass arc-glass-dark"`, never a swap — and light is always the base.

**Scope discipline:** ArcDock, ArcBar and ArcTab get `common.css` prepended and their existing
stylesheet moved verbatim to `local.css`. Their rules are untouched and their rendering must be
byte-identical; the only change is that the shared `arc-*` vocabulary becomes available to them for
a later, incremental migration. **ArcDesk is the only extension that consumes `arc-*` classes now.**

---

# AMENDMENT 1 — one grid per monitor

Supersedes every "primary monitor" statement above. The v1 surface bound itself to the primary
monitor with `MonitorConstraint({primary: true})`; on a two-monitor desk that put the whole desktop
on whichever screen GNOME calls primary, and the user saw an empty wallpaper on the other one.

**ArcDesk now paints a grid on EVERY monitor.** Each monitor has its own independent slots, and an
item remembers which monitor it lives on. An icon can be dragged from one screen to the other.

## Monitor identity is the INDEX, and it degrades instead of destroying

There is no connector-name API on the shell side in GNOME 50 — `Main.layoutManager.monitors[i]`
carries only `index`, `x`, `y`, `width`, `height`, `geometry_scale`, and `Meta.Display` exposes no
`get_monitor_connector`. So a placement stores the **monitor index**.

Indices reshuffle when a screen is unplugged. The rule is the same one that already governs
`col`/`row`, and it is not negotiable: **the stored value is authoritative and is never rewritten
because the current hardware cannot honour it.** An item whose `mon` is out of range is *displayed*
on the primary monitor, in the first free slot there, and its stored placement is left alone. Plug
the screen back in and the arrangement returns exactly as it was.

## Persistence — `desk-placements` gains one field

```json
{"app:firefox.desktop": {"col": 0, "row": 2, "mon": 1}}
```

`mon` is optional **on read**: a record without it was written by v1 and means "the primary
monitor". On the first build that resolves it, the record is rewritten with an explicit `mon`, so
the migration happens once and silently. A record with a non-integer or negative `mon` is treated as
missing.

`desk-items` and `desk-folders` are **unchanged**. In particular `desk-items` remains the public
contract ArcDock appends to, and ArcDock still knows nothing about monitors: an appended id lands on
the **primary** monitor's first free slot.

## `src/deskLayout.js` — changed signatures

There is still **exactly one `DeskLayout` in the process**. It is now owned by `DeskManager`, not by
a surface, precisely because there are several surfaces and a second instance would fight the echo
suppression.

```js
/**
 * @param {Shell.App[]} installedApps
 * @param {Map<number, {cols:number, rows:number}>} grids — one entry per live monitor index
 * @param {number} primaryIndex — where an item with no/!valid `mon` is displayed
 * @returns {Entry[]} every entry, each carrying the `mon` it must be drawn on
 */
build(installedApps, grids, primaryIndex) -> Entry[]

placementOf(id)                  // {col, row, mon} | null — STORED, unclamped, `mon` may be absent
itemAt(col, row, mon)            // id | null, against the last build()'s clamped positions
addItem(id, at = null)           // at = {col, row, mon} or null → primary monitor's first free slot
moveTo(id, col, row, mon)        // mon is REQUIRED; a move always states a monitor
swap(idA, idB)                   // unchanged — swaps both slots AND both monitors
removeFromFolder(folderId, appId, col, row, mon)
firstFreeSlot(grids, mon)        // {col, row, mon} | null; falls back across monitors only if `mon` is full
```

Entries returned by `build()` gain `mon`:

```js
{ type:'app', id:'app:firefox.desktop', appId:'firefox.desktop', app:<Shell.App>,
  name:'Firefox', col:0, row:2, mon:1 }
```

Occupancy, clamping and collision-pushing are all **per monitor**: two items may share `{col,row}`
as long as their `mon` differs, and the collision push scans only within its own monitor's grid
before spilling to the primary.

## `src/deskSurface.js` — changed constructor, no longer owns the model

```js
new DeskSurface({
    settings, layout,        // ← the SHARED DeskLayout, injected. Never construct one here.
    monitorIndex,            // ← which monitor this surface paints
    iconSize, theme, labelPosition, gridOrigin, doubleClickToOpen,
    onOpenFolder, onCloseFolder,
    onDropOnOther,           // ← (sourceIcon, dragActor) => boolean, see below
})
```

- The constraint becomes `new Layout.MonitorConstraint({index: this._monitorIndex, workArea: false})`.
  The actor covers the whole monitor; grid origins are offset into the monitor's work area.
  `primary` and `index` are mutually exclusive — setting one clears the other.
- The surface renders **only** the entries whose `mon === monitorIndex`, and its `itemAt` /
  `firstFreeSlot` / `moveTo` calls all pass its own index.
- `refresh()` still rebuilds from the shared model; the manager calls it on every surface.
- **The surface must not subscribe to `layout.onExternalChange()`** — with N surfaces that would be
  N subscriptions to one model and N rebuilds per change. The **manager** subscribes once and calls
  `refresh()` on each surface.

### Dragging between monitors

The dnd finds its target by picking the pixel under the pointer and walking up, so a drag that
crosses onto another screen reaches **that** surface's delegate with no coordination needed. What
each side must do:

- A surface accepts a drop from a **foreign** source. `_isDropSource()` must therefore not require
  the source to be one of *its* icons — it is enough that `source.id` resolves in the shared model.
  `_dragIdOf()` already falls back to its own drag snapshot only when `source === this._drag.icon`;
  for a foreign source it reads `source.id` directly, which is exactly right.
- The accepting surface writes the move with **its own** `monitorIndex`, which is what actually
  moves the item between screens.
- The **origin** surface must clear its lit slot and un-dam itself even though its own `acceptDrop`
  never ran. Its `onDragEnd` already runs (dnd emits `drag-end` on the source regardless of who
  accepted), so `_clearTargetSlot()` there covers it. The origin surface must NOT schedule a
  refresh of its own — the manager refreshes everyone.
- `onDropOnOther` exists so the accepting surface can tell the manager "someone else's item landed
  here"; the manager refreshes all surfaces once. Returning `false` means the manager declined and
  the caller should treat the drop as refused.

### Selection uses normal keyboard focus

Surfaces call `grab_key_focus()` so Escape/Enter/Menu keep working, but never call `Main.pushModal`
for selection. Normal focus transfers when the user clicks another surface or window and does not
capture the pointer.

## `src/deskManager.js` — NEW, owns everything

```js
export class DeskManager {
    constructor(params)   // same appearance params as DeskSurface, minus monitorIndex
    refreshAll()
    relayoutAll()
    surfaceFor(monitorIndex) -> DeskSurface | null
    destroy()
}
```

Owns: the single `DeskLayout`, one `DeskSurface` per entry in `Main.layoutManager.monitors`, the
single `FolderPopup`, the `FullscreenWatcher`, and the grab arbitration.

- Rebuilds the whole set of surfaces on `Main.layoutManager::monitors-changed` — monitor **count**
  can change, so a `relayout()` is not enough; destroy every surface and build them again from the
  current `monitors` array.
- Subscribes **once** to `layout.onExternalChange()` and calls `refreshAll()`.
- Owns the `FolderPopup` and routes `onOpenFolder(entry, anchorRect)` from whichever surface raised
  it, handing that surface's `createFolderIcon` to the popup as `createIcon` and that surface's
  monitor bounds as the popup's `bounds`. This replaces the `setFolderPopup()` / `createFolderIcon()`
  hooks that `extension.js` previously improvised.
- The **folder popup stays a single instance** — it is chrome and only one folder is open at a time.
  It is constructed on the first open, never in the constructor.

## `extension.js` — thinner

Reads the keys, constructs one `DeskManager`, connects the appearance keys to a full rebuild of the
manager, calls `warnIfDingActive()`, and destroys the manager in `disable()`. It no longer knows
about surfaces, popups or monitors.

## `prefs.js` — one addition

The Items page shows which monitor each item is on, read from `desk-placements`. Display-only.
