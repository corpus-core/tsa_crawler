// Shared node_exporter textfile writer. Dedup, gen-responses, and
// validate-responses run in one build process and share PROM_FILE; each
// replaces only its own metric prefix so the others survive.

import fs from 'node:fs';

/**
 * Escape a Prometheus label value.
 *
 * @param {unknown} v
 * @return {string}
 */
export function escapeLabel(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Drop every HELP, TYPE, and sample line whose metric name starts with `prefix`.
 * Blank lines are dropped too; the caller rejoins the sections.
 *
 * @param {string} text
 * @param {string} prefix
 * @return {string} Body without a trailing newline, or `''`
 */
export function stripPromPrefix(text, prefix) {
    const help = `# HELP ${prefix}`;
    const type = `# TYPE ${prefix}`;
    const kept = [];
    for (const line of String(text ?? '').split('\n')) {
        if (!line) continue;
        if (line.startsWith(help) || line.startsWith(type) || line.startsWith(prefix)) continue;
        kept.push(line);
    }
    return kept.join('\n');
}

/**
 * Atomically merge `body` into `promFile`, replacing any previous metrics
 * whose names start with `prefix`. No-op when `promFile` is empty. A write
 * error is reported via `opts.onError` and does not throw: metrics must not
 * fail the run that produced them.
 *
 * @param {string} promFile
 * @param {string} body  Exposition text, including its trailing newline
 * @param {string} prefix  Metric-name prefix, e.g. `trace_gen_`
 * @param {{ onError?: (msg: string) => void }} [opts]
 */
export function writePromSection(promFile, body, prefix, opts = {}) {
    if (!promFile) return;
    try {
        let existing = '';
        try {
            existing = fs.readFileSync(promFile, 'utf8');
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        const kept = stripPromPrefix(existing, prefix);
        const section = String(body ?? '').replace(/^\n+/, '').replace(/\n+$/, '');
        const parts = [kept, section].filter(Boolean);
        const tmp = promFile + '.tmp';
        fs.writeFileSync(tmp, parts.join('\n') + '\n');
        fs.renameSync(tmp, promFile);
    } catch (e) {
        opts.onError?.(`metrics-error: ${e.message}`);
    }
}
