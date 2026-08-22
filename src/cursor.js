import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

/* GNOME 49+ moved the cursor enum out of Meta and into Clutter
 * (Meta.Cursor -> Clutter.CursorType, POINTING_HAND -> POINTER) and
 * dropped global.display.set_cursor() in favour of Clutter's
 * set_cursor_type() on the stage. We probe at runtime and use whichever
 * exists, so the same code works across versions. */
function setCursor(clutterName, metaName) {
    const clutterCursor = Clutter.CursorType?.[clutterName];
    if (clutterCursor !== undefined && global.stage?.set_cursor_type) {
        global.stage.set_cursor_type(clutterCursor);
        return;
    }
    const metaCursor = Meta.Cursor?.[metaName];
    if (metaCursor !== undefined && global.display?.set_cursor)
        global.display.set_cursor(metaCursor);
}

export function setPointer() {
    setCursor('POINTER', 'POINTING_HAND');
}

export function setDefault() {
    setCursor('DEFAULT', 'DEFAULT');
}

export function setGrabbing() {
    setCursor('GRABBING', 'DND_IN_DRAG');
}

/** Usa o cursor direcional correspondente à borda/canto redimensionado. */
export function setResize(edges = {}) {
    let name;
    if (edges.top && edges.left) name = 'NW_RESIZE';
    else if (edges.top && edges.right) name = 'NE_RESIZE';
    else if (edges.bottom && edges.left) name = 'SW_RESIZE';
    else if (edges.bottom && edges.right) name = 'SE_RESIZE';
    else if (edges.left) name = 'W_RESIZE';
    else if (edges.right) name = 'E_RESIZE';
    else if (edges.top) name = 'N_RESIZE';
    else if (edges.bottom) name = 'S_RESIZE';
    else return setDefault();
    setCursor(name, name);
}
