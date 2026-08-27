import Gio from 'gi://Gio';
import St from 'gi://St';

export class ImageWidget {
    constructor(params = {}) {
        this._actor = new St.Widget({
            style_class: 'arcdesk-image-widget-content',
            reactive: false,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        this.updateConfig(params.config ?? {});
    }

    get actor() {
        return this._actor;
    }

    updateConfig(config) {
        if (!this._actor) return;
        const path = typeof config?.imagePath === 'string' ? config.imagePath : '';
        const uri = path ? Gio.File.new_for_path(path).get_uri() : '';
        this._actor.set_style(uri
            ? `background-image: url("${uri}"); background-size: cover; ` +
                'background-position: center;'
            : 'background-color: rgba(255, 255, 255, 0.12);');
    }

    setSize(width, height) {
        this._actor?.set_size(Math.max(1, width), Math.max(1, height));
    }

    destroy() {
        try { this._actor?.destroy(); } catch (_) {}
        this._actor = null;
    }
}

/** Fábrica exigida pelo loader de widgets (`src/widgetRegistry.js`). */
export function create(params = {}) {
    return new ImageWidget(params);
}
