#!/usr/bin/env node
// collect-traces.js  —  Node 18+ (globales fetch)
//
// Forward-Streaming-Sammler fuer SLM-Trainingsdaten.
// Alle POLL_MS pruefen, ob ein neuer Block da ist. Fuer jeden neuen Block:
//   1) eth_getBlockByNumber(n, true)
//   2) pro Tx: codehash der to-Adresse (gecacht) + selector -> bucket = codehash_selector
//   3) Bucket voll (>= CAP)  -> ignorieren;  sonst -> tracen
//      Adaptives Tracing: 1 selektierte Tx -> debug_traceTransaction,
//                         >=2               -> debug_traceBlockByNumber (Block nur EINMAL ausfuehren)
//   4) Ergebnis ablegen unter  OUT/<codehash>_<selector>/<txhash>.json
//
// Restart-sicher (State-Datei + Bucket-Counts aus dem FS rekonstruiert) und
// Fenster-bewusst (traced nur innerhalb der ~128 Bloecke, die der Full-Node haelt).
//
// Aufruf:  RPC=http://127.0.0.1:8545 OUT=./traces CAP=5 node collect-traces.js

const fs   = require('node:fs');
const path = require('node:path');

// --------------------------- Konfiguration ---------------------------------
const RPC              = process.env.RPC || 'http://127.0.0.1:8545';
const OUT              = process.env.OUT || './traces';
const CAP              = parseInt(process.env.CAP || '5', 10);      // max Traces pro Bucket
const POLL_MS          = parseInt(process.env.POLL_MS || '12000', 10);
const MAX_LAG          = parseInt(process.env.MAX_LAG || '100', 10); // < 128 (Full-Node-Fenster)
const TRACE_TIMEOUT    = process.env.TRACE_TIMEOUT || '60s';         // gilt PRO Tx
const INCLUDE_RECEIPTS = (process.env.INCLUDE_RECEIPTS || 'true') !== 'false';
const PROM_FILE        = process.env.PROM_FILE || '';  // e.g. /metrics/trace_collector.prom ('' = disabled)
const CHAIN            = process.env.CHAIN || 'mainnet';  // metric label to tell multiple chains apart
const STATE            = path.join(OUT, '.state.json');
const EMPTY_CODE_HASH  = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';

// --------------------------- Custom-Tracer ---------------------------------
// (identisch zu trace-block.js: KECCAK256-Preimage/-Hash, SLOAD/SSTORE mit addr)
const TRACER = `{
  keccak: [], sload: [], sstore: [], pending: null,
  b2h: function(b){ return b < 0x10 ? '0'+b.toString(16) : b.toString(16); },
  a2h: function(arr){ var s=''; for (var i=0;i<arr.length;i++) s+=this.b2h(arr[i]); return s; },
  w:   function(x){ return ('0000000000000000000000000000000000000000000000000000000000000000'+x).slice(-64); },
  mem: function(log, off, len){
    if (len === 0) return '';
    var avail = log.memory.length(), s = '';
    if (off < avail){ var end=(off+len)<=avail?(off+len):avail; s=this.a2h(log.memory.slice(off,end)); }
    while (s.length/2 < len) s += '00';
    return s;
  },
  step: function(log, db){
    if (this.pending !== null){
      var top = '0x' + this.w(log.stack.peek(0).toString(16));
      if (this.pending.k === 1) this.keccak[this.pending.i].hash = top;
      else                      this.sload[this.pending.i].value = top;
      this.pending = null;
    }
    var op = log.op.toNumber();
    if (op === 0x20){
      var off=log.stack.peek(0).valueOf(), len=log.stack.peek(1).valueOf();
      this.keccak.push({ addr:'0x'+this.a2h(log.contract.getAddress()), input:'0x'+this.mem(log,off,len), hash:null });
      this.pending = { k:1, i:this.keccak.length-1 };
    } else if (op === 0x54){
      this.sload.push({ addr:'0x'+this.a2h(log.contract.getAddress()), slot:'0x'+this.w(log.stack.peek(0).toString(16)), value:null });
      this.pending = { k:2, i:this.sload.length-1 };
    } else if (op === 0x55){
      this.sstore.push({ addr:'0x'+this.a2h(log.contract.getAddress()), slot:'0x'+this.w(log.stack.peek(0).toString(16)), value:'0x'+this.w(log.stack.peek(1).toString(16)) });
    }
  },
  fault: function(log, db){ this.pending = null; },
  result: function(ctx, db){ return { keccak:this.keccak, sload:this.sload, sstore:this.sstore }; }
}`;

// ------------------------------ JSON-RPC -----------------------------------
let rpcId = 0;
async function rpc(method, params){
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// --------------------------- Codehash-Cache --------------------------------
// eth_getProof liefert codeHash direkt (kanonisch, ohne lokales Keccak).
const codeHashCache = new Map();
async function getCodeHash(addr, blockHex){
  const key = addr.toLowerCase();
  if (codeHashCache.has(key)) return codeHashCache.get(key);
  try {
    const proof = await rpc('eth_getProof', [addr, [], blockHex]);
    const ch = proof && proof.codeHash ? proof.codeHash.toLowerCase() : null;
    if (ch) codeHashCache.set(key, ch);   // Fehler nicht cachen (transient)
    return ch;
  } catch { return null; }
}

// ------------------------------ Persistenz ---------------------------------
function writeAtomic(file, obj){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);             // atomar: nie halbe Dateien
}
function loadState(){ try { return JSON.parse(fs.readFileSync(STATE, 'utf8')).lastProcessed; } catch { return null; } }
function saveState(n){ writeAtomic(STATE, { lastProcessed: n }); }

// Bucket-Counts aus dem FS rekonstruieren -> CAP bleibt ueber Restarts korrekt.
function rebuildCounts(){
  const counts = new Map();
  if (!fs.existsSync(OUT)) return counts;
  for (const name of fs.readdirSync(OUT)){
    const dir = path.join(OUT, name);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
    counts.set(name, n);
  }
  return counts;
}

// --------------------------- Prometheus-Metriken ---------------------------
// Written for node_exporter's textfile_collector: the file must be complete
// valid exposition format, so we write to a .tmp file and rename atomically.
// node_exporter only picks up *.prom files, the .tmp is ignored.
let tracedTotal = 0;   // traces saved since process start (counter, resets on restart)

function totalOutputFiles(){
  let sum = 0;
  for (const v of counts.values()) sum += v;
  return sum;
}

// Escape a label value per Prometheus exposition format (backslash, quote, newline).
function escapeLabel(v){
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
const LABELS = `{chain="${escapeLabel(CHAIN)}"}`;

function writeMetrics(lastBlock){
  if (!PROM_FILE) return;
  const lines = [
    '# HELP trace_collector_traced_transactions_total Transactions traced and saved since process start.',
    '# TYPE trace_collector_traced_transactions_total counter',
    `trace_collector_traced_transactions_total${LABELS} ${tracedTotal}`,
    '# HELP trace_collector_output_files Total trace files (<bucket>/<txhash>.json) in the OUT directory.',
    '# TYPE trace_collector_output_files gauge',
    `trace_collector_output_files${LABELS} ${totalOutputFiles()}`,
    '# HELP trace_collector_last_processed_block Last block number processed by the collector.',
    '# TYPE trace_collector_last_processed_block gauge',
    `trace_collector_last_processed_block${LABELS} ${lastBlock == null ? 0 : lastBlock}`,
    ''  // exposition format requires a trailing newline
  ];
  try {
    const tmp = PROM_FILE + '.tmp';   // same directory => rename stays atomic
    fs.writeFileSync(tmp, lines.join('\n'));
    fs.renameSync(tmp, PROM_FILE);
  } catch (e){
    console.error('metrics-error:', e.message);   // non-fatal, collector keeps running
  }
}

// ------------------------------- Kernlogik ---------------------------------
let counts;    // bucketId -> Anzahl gesammelter Traces

function bucketId(codehash, selector){
  const sel = selector === '0x' ? 'fallback' : selector.slice(2);
  return `${codehash.slice(2)}_${sel}`;
}

async function processBlock(n){
  const hex = '0x' + n.toString(16);
  const block = await rpc('eth_getBlockByNumber', [hex, true]);
  if (!block || !block.transactions) return;
  const txs = block.transactions;

  // ---- Phase 1: Selektion (ohne Tracing) ----
  const selected = [];
  for (let i = 0; i < txs.length; i++){
    const tx = txs[i];
    if (!tx.to) continue;                                    // Contract-Creation -> skip
    const codehash = await getCodeHash(tx.to, hex);
    if (!codehash || codehash === EMPTY_CODE_HASH) continue; // EOA / kein Code -> skip
    const input = tx.input || '0x';
    const selector = input.length >= 10 ? input.slice(0, 10) : '0x';
    const bucket = bucketId(codehash, selector);
    const file = path.join(OUT, bucket, `${tx.hash}.json`);
    if (fs.existsSync(file)) continue;                       // schon gesammelt -> idempotent
    const cur = counts.get(bucket) || 0;
    if (cur >= CAP) continue;                                // Bucket voll
    counts.set(bucket, cur + 1);                             // Slot reservieren
    selected.push({ tx, idx: i, bucket, file, selector, codehash });
  }

  if (selected.length === 0){
    console.log(`block ${n}: ${txs.length} tx, 0 selektiert (cache=${codeHashCache.size})`);
    return;
  }

  // ---- Phase 2: Tracing (adaptiv) ----
  const traceByHash = new Map();
  try {
    if (selected.length === 1){
      const r = await rpc('debug_traceTransaction', [selected[0].tx.hash, { tracer: TRACER, timeout: TRACE_TIMEOUT }]);
      traceByHash.set(selected[0].tx.hash, r);
    } else {
      const arr = await rpc('debug_traceBlockByNumber', [hex, { tracer: TRACER, timeout: TRACE_TIMEOUT }]);
      for (let i = 0; i < arr.length; i++){
        const e = arr[i];
        const h = (e && e.txHash) || (txs[i] && txs[i].hash);   // fallback: Positions-Mapping
        if (h && e && e.result) traceByHash.set(h, e.result);
      }
    }
  } catch (e){
    for (const s of selected) counts.set(s.bucket, (counts.get(s.bucket) || 1) - 1); // Reservierungen freigeben
    console.error(`block ${n}: trace-error: ${e.message}`);
    return;
  }

  // ---- Phase 3: Persistieren ----
  let saved = 0;
  for (const s of selected){
    const trace = traceByHash.get(s.tx.hash);
    if (!trace){ counts.set(s.bucket, (counts.get(s.bucket) || 1) - 1); continue; } // Reservierung zurueck
    let receipt = null;
    if (INCLUDE_RECEIPTS){
      try {
        const r = await rpc('eth_getTransactionReceipt', [s.tx.hash]);
        if (r) receipt = { status: r.status, gasUsed: r.gasUsed, logs: r.logs };
      } catch {}
    }
    writeAtomic(s.file, {
      meta: {
        block: n, blockHash: block.hash, timestamp: block.timestamp,
        txIndex: s.idx, txHash: s.tx.hash,
        from: s.tx.from, to: s.tx.to, value: s.tx.value, input: s.tx.input,
        codehash: s.codehash, selector: s.selector
      },
      receipt,
      trace
    });
    saved++;
  }
  tracedTotal += saved;
  console.log(`block ${n}: ${txs.length} tx, ${selected.length} selektiert, ${saved} gespeichert (buckets=${counts.size})`);
}

// -------------------------------- Loop -------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main(){
  fs.mkdirSync(OUT, { recursive: true });
  counts = rebuildCounts();

  let lastProcessed = loadState();
  const head0 = parseInt(await rpc('eth_blockNumber'), 16);
  if (lastProcessed == null) lastProcessed = head0 - 1;   // ab Head starten, keine (untraceable) Historie
  console.log(`start: head=${head0} lastProcessed=${lastProcessed} buckets=${counts.size} CAP=${CAP} OUT=${OUT}`);
  writeMetrics(lastProcessed);   // publish reconstructed state right away

  let shuttingDown = false;
  process.on('SIGINT', () => { shuttingDown = true; saveState(lastProcessed); console.log('\ngestoppt.'); process.exit(0); });

  for (;;){
    try {
      const head = parseInt(await rpc('eth_blockNumber'), 16);
      let start = lastProcessed + 1;
      if (head >= start){
        if (head - start > MAX_LAG){
          console.warn(`WARN: ${head - start} Bloecke im Rueckstand (> ${MAX_LAG}); ueberspringe – aeltere States sind nicht mehr traceable.`);
          start = head - MAX_LAG;
        }
        for (let n = start; n <= head && !shuttingDown; n++){
          await processBlock(n);
          lastProcessed = n;
          saveState(n);
          writeMetrics(n);
        }
      }
    } catch (e){
      console.error('loop-error:', e.message);   // transient -> weiterlaufen
    }
    // Refresh even without new blocks: keeps the file mtime current, so
    // node_textfile_mtime_seconds can be used for staleness alerting.
    writeMetrics(lastProcessed);
    await sleep(POLL_MS);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
