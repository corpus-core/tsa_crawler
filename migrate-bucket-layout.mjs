#!/usr/bin/env node
// One-shot migrate to OUT/<hh>/<codehash[2:]>/<selector>/
// Accepts leftover layouts:
//   OUT/<codehash>_<selector>/
//   OUT/<codehash>/<selector>/
// Same filesystem rename (no copy). Stop the collector first.
//
//   IN=/srv/trace-data DRY_RUN=1 node migrate-bucket-layout.mjs
//   IN=/srv/trace-data node migrate-bucket-layout.mjs

import fs from 'node:fs';
import path from 'node:path';
import {
    LEGACY_BUCKET_RE,
    CODEHASH_DIR_RE,
    SELECTOR_DIR_RE,
    shardedHashParts,
} from './bucket_paths.mjs';

const IN = process.env.IN || process.env.OUT || './test_data';
const DRY_RUN = process.env.DRY_RUN === '1';
const PROGRESS_EVERY = parseInt(process.env.PROGRESS_EVERY || '1000', 10);

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function destFor(hash, sel) {
    const { prefix, rest } = shardedHashParts(hash);
    return path.join(IN, prefix, rest, sel);
}

function moveDir(src, dest) {
    if (path.resolve(src) === path.resolve(dest)) return 'same';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
        fs.renameSync(src, dest);
        return 'rename';
    }
    let moved = 0;
    for (const name of fs.readdirSync(src)) {
        const from = path.join(src, name);
        const to = path.join(dest, name);
        if (fs.existsSync(to)) continue;
        fs.renameSync(from, to);
        moved++;
    }
    const leftover = fs.readdirSync(src);
    if (!leftover.length) fs.rmdirSync(src);
    return `merge:${moved}`;
}

function rmdirIfEmpty(dir) {
    try {
        if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch { /* not empty / missing */ }
}

const jobs = [];
const names = fs.existsSync(IN) ? fs.readdirSync(IN) : [];
for (const name of names) {
    const src = path.join(IN, name);
    if (!isDir(src)) continue;
    const legacy = name.match(LEGACY_BUCKET_RE);
    if (legacy) {
        jobs.push({ src, dest: destFor(legacy[1], legacy[2]), label: name });
        continue;
    }
    if (!CODEHASH_DIR_RE.test(name)) continue;
    for (const sel of fs.readdirSync(src)) {
        if (!SELECTOR_DIR_RE.test(sel)) continue;
        const selDir = path.join(src, sel);
        if (!isDir(selDir)) continue;
        jobs.push({ src: selDir, dest: destFor(name, sel), label: `${name}/${sel}`, emptyParent: src });
    }
}

console.log(`migrate-bucket-layout: ${jobs.length} buckets in ${IN} dryRun=${DRY_RUN}`);

let ok = 0, err = 0, done = 0;
for (const job of jobs) {
    try {
        if (DRY_RUN) {
            if (done < 5) console.log(`dry-run ${job.src} -> ${job.dest}`);
        } else {
            moveDir(job.src, job.dest);
            if (job.emptyParent) rmdirIfEmpty(job.emptyParent);
        }
        ok++;
    } catch (e) {
        err++;
        console.error('migrate', job.label, e.message);
    }
    done++;
    if (done % PROGRESS_EVERY === 0) {
        console.log(`migrate: ${done}/${jobs.length} ok=${ok} err=${err}`);
    }
}
console.log(`migrate: ${done}/${jobs.length} ok=${ok} err=${err}${DRY_RUN ? ' (dry-run, no changes)' : ''}`);
