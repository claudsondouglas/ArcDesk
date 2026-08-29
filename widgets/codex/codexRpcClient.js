import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const RPC = Object.freeze({
    TIMEOUT_MS: 6000,
    CLIENT_NAME: 'arcdesk-codex-widget',
    CLIENT_VERSION: '1',
});

function sendRequest(stdin, id, method, params) {
    stdin.write_all(JSON.stringify({id, method, params: params ?? {}}) + '\n', null);
}

/**
 * Le linhas ate achar uma resposta com o `id` pedido. `app-server` intercala
 * notificacoes sem `id` (ex.: remoteControl/status/changed) entre as
 * respostas, entao uma linha que nao bate precisa ser descartada, nunca
 * tratada como a resposta errada.
 */
function readMatchingLine(dataStream, id, cancellable, deadline, onDone) {
    dataStream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
        let line;
        try {
            [line] = source.read_line_finish_utf8(result);
        } catch (e) {
            onDone(null, e);
            return;
        }
        if (line === null) {
            onDone(null, new Error('codex app-server fechou o stdout'));
            return;
        }
        if (GLib.get_monotonic_time() > deadline) {
            onDone(null, new Error('codex app-server RPC expirou'));
            return;
        }
        let message;
        try {
            message = JSON.parse(line);
        } catch (_e) {
            readMatchingLine(dataStream, id, cancellable, deadline, onDone);
            return;
        }
        if (message && message.id === id) {
            onDone(message, null);
            return;
        }
        readMatchingLine(dataStream, id, cancellable, deadline, onDone);
    });
}

/**
 * Faz o handshake JSON-RPC com `codex app-server` (initialize, initialized,
 * account/read, account/rateLimits/read) e devolve `{account, rateLimits}`.
 * Resolve `null` se o binario `codex` nao existir, o RPC falhar ou expirar —
 * nunca rejeita, o chamador so precisa decidir entre usar o resultado ou
 * manter o que ja tinha.
 */
export function fetchCodexLimits(cancellable) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['codex', '-s', 'read-only', '-a', 'on-request', 'app-server'],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (_e) {
            resolve(null);
            return;
        }

        let settled = false;
        let cancelId = 0;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (cancelId) cancellable.disconnect(cancelId);
            try { proc.force_exit(); } catch (_e) {}
            resolve(value);
        };
        cancelId = cancellable.connect(() => finish(null));

        const stdin = proc.get_stdin_pipe();
        const dataStream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const deadline = GLib.get_monotonic_time() + RPC.TIMEOUT_MS * 1000;

        const step = (id, method, params, onResult) => {
            if (settled) return;
            try {
                sendRequest(stdin, id, method, params);
            } catch (_e) {
                finish(null);
                return;
            }
            readMatchingLine(dataStream, id, cancellable, deadline, (message, error) => {
                if (settled) return;
                if (error || !message) { finish(null); return; }
                onResult(message);
            });
        };

        step(1, 'initialize', {clientInfo: {name: RPC.CLIENT_NAME, version: RPC.CLIENT_VERSION}}, () => {
            if (settled) return;
            try {
                stdin.write_all(JSON.stringify({method: 'initialized', params: {}}) + '\n', null);
            } catch (_e) {
                finish(null);
                return;
            }
            step(2, 'account/read', {}, (accountMsg) => {
                step(3, 'account/rateLimits/read', {}, (limitsMsg) => {
                    const account = accountMsg.result?.account ?? {};
                    const rateLimits = limitsMsg.result?.rateLimits ?? {};
                    finish({account, rateLimits});
                });
            });
        });
    });
}
