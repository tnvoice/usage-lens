#!/usr/bin/env node
/**
 * usage-lens v0.2 —— 从本地日志读 AI 客户端的 token 用量。
 *
 * 硬原则（写在代码里）：
 *   1. 只读本地文件：不联网、不读 API key、不写任何东西。
 *   2. 读不懂就不折算：形状未核实的来源只报告"发现了什么"，metrics = null。
 *   3. 0 是数据，空是不知道：未核实来源的指标是 null，不是 0。
 *   4. 跨厂商语义不同 → 除原始字段外另给归一化字段，并在 warnings 里说明。
 *
 * 语义（已核实）：
 *   Claude Code  message.usage：input_tokens 不含 cache；四项相加才是输入侧总量。
 *   Codex        payload.info.total_token_usage 是会话累计（单调不减，实测 18/18 成立），
 *                last_token_usage 是每轮增量；取每会话最后一条 total，不求和。
 *                OpenAI 口径：cached_input_tokens ⊂ input_tokens，total = input + output。
 *
 * 用法：
 *   node usage-lens.mjs [--json] [--root <dir>]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
// ── XXH64（seed=0）：官方向量 7/7 通过（"" / a / abc / 7B / 15B / 47B / 1024B），用作 zstd 帧尾内容校验
const XP1 = 11400714785074694791n, XP2 = 14029467366897019727n, XP3 = 1609587929392839161n;
const XP4 = 9650029242287828579n, XP5 = 2870177450012600261n;
const XMASK = 0xffffffffffffffffn;
const xrotl = (x, r) => ((x << r) | (x >> (64n - r))) & XMASK;
const xround = (acc, input) => { let a = (acc + input * XP2) & XMASK; a = xrotl(a, 31n); return (a * XP1) & XMASK; };
const xmerge = (acc, val) => { let a = (acc ^ xround(0n, val)) & XMASK; return (a * XP1 + XP4) & XMASK; };
function xxh64(input, seed = 0n) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const len = b.length;
  let h; let i = 0;
  if (len >= 32) {
    let v1 = (seed + XP1 + XP2) & XMASK, v2 = (seed + XP2) & XMASK, v3 = seed & XMASK, v4 = (seed - XP1) & XMASK;
    const limit = len - 32;
    do {
      v1 = xround(v1, b.readBigUInt64LE(i)); i += 8;
      v2 = xround(v2, b.readBigUInt64LE(i)); i += 8;
      v3 = xround(v3, b.readBigUInt64LE(i)); i += 8;
      v4 = xround(v4, b.readBigUInt64LE(i)); i += 8;
    } while (i <= limit);
    h = (xrotl(v1, 1n) + xrotl(v2, 7n) + xrotl(v3, 12n) + xrotl(v4, 18n)) & XMASK;
    h = xmerge(h, v1); h = xmerge(h, v2); h = xmerge(h, v3); h = xmerge(h, v4);
  } else h = (seed + XP5) & XMASK;
  h = (h + BigInt(len)) & XMASK;
  while (i + 8 <= len) { h = (h ^ xround(0n, b.readBigUInt64LE(i))) & XMASK; h = (xrotl(h, 27n) * XP1 + XP4) & XMASK; i += 8; }
  if (i + 4 <= len) { h = (h ^ ((BigInt(b.readUInt32LE(i)) * XP1) & XMASK)) & XMASK; h = (xrotl(h, 23n) * XP2 + XP3) & XMASK; i += 4; }
  while (i < len) { h = (h ^ ((BigInt(b[i]) * XP5) & XMASK)) & XMASK; h = (xrotl(h, 11n) * XP1) & XMASK; i += 1; }
  h = (h ^ (h >> 33n)) & XMASK; h = (h * XP2) & XMASK; h = (h ^ (h >> 29n)) & XMASK;
  h = (h * XP3) & XMASK; return (h ^ (h >> 32n)) & XMASK;
}
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const SCHEMA = '1'; // 已发布即冻结；破坏性改动升版本（WorkBuddy #128 的消费契约）
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : undefined;
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const only = onlyArg ? new Set(onlyArg.split(',').map((x) => x.trim())) : null;

if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'usage-lens —— 只读本地 AI 客户端日志，汇总 token 用量（不联网、不读 API key、不写文件）',
    '',
    '用法：node usage-lens.mjs [选项]',
    '',
    '  --json          机器可读输出（schema "1"，契约见 README）',
    '  --only <ids>    只跑指定来源，逗号分隔：claude-code,codex,dsh,cursor,gemini',
    '  --root <dir>    扫隔离目录（测试夹具用；默认扫各客户端的真实位置）',
    '  --selftest      运行 XXH64 回归自检（7 个官方向量）',
    '  --help, -h      显示本帮助',
    '',
    '输出的每个来源都带状态：verified / found-unverified / not-found / not-implemented。',
    '只有 verified 参与合计；未核实的来源 metrics 为 null（不是 0）。',
  ].join('\n'));
  process.exit(0);
}

if (args.includes('--selftest')) {
  // xxh64 不参与正常流水线（zstd 解压器自身已校验帧内容），此处仅作回归自检：
  // 将来若遇到解压器处理不了的帧格式，这个已验证的实现可直接取用。
  const seq = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i));
  const cases = [
    [Buffer.from(''), 'ef46db3751d8e999'], [Buffer.from('a'), 'd24ec4f1a98c6e5b'],
    [Buffer.from('abc'), '44bc2cf5ad770999'], [seq(7), '14cc643f630c72d2'],
    [seq(15), 'a948f5f0f6abac2d'], [seq(47), '0d9883a03e7bfbb8'],
    [Buffer.concat([seq(256), seq(256), seq(256), seq(256)]), '6f3914f18fe4df57'],
  ];
  let bad = 0;
  for (const [buf, want] of cases) {
    const got = xxh64(buf).toString(16).padStart(16, '0');
    if (got !== want) { console.log(`FAIL  期望 ${want} 得到 ${got}`); bad += 1; }
  }
  console.log(bad ? `XXH64 自检：${cases.length - bad}/${cases.length} 通过（有失败）` : `XXH64 自检：${cases.length}/${cases.length} 通过`);
  process.exit(bad ? 1 : 0);
}
const HOME = homedir();
const under = (name, real) => (rootArg ? resolve(rootArg, name) : real);

const mk = () => ({ files: 0, records: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, first: null, last: null });
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const touch = (a, ts) => {
  if (typeof ts !== 'string') return;
  if (!a.first || ts < a.first) a.first = ts;
  if (!a.last || ts > a.last) a.last = ts;
};

// ── 时间窗（today / week，本地时区）：菜单栏"环"的分子；分母=预算，属 UI 设置，不进引擎。
const nowArg = args.includes('--now') ? args[args.indexOf('--now') + 1] : undefined;
const NOW = nowArg ? new Date(nowArg) : new Date();
const windowOf = (kind) => {
  const end = new Date(NOW);
  const start = new Date(NOW);
  if (kind === 'week') { const sinceMon = (start.getDay() + 6) % 7; start.setDate(start.getDate() - sinceMon); }
  start.setHours(0, 0, 0, 0);
  return { startMs: start.getTime(), endMs: end.getTime(), start: start.toISOString(), end: end.toISOString() };
};
const WIN_TODAY = windowOf('today');
const WIN_WEEK = windowOf('week');
const mkWin = () => ({ today: mk(), week: mk() });
const addWin = (win, tsMs, input, cacheWrite, cacheRead, output) => {
  if (!win || !Number.isFinite(tsMs)) return;
  if (tsMs >= WIN_TODAY.startMs && tsMs <= WIN_TODAY.endMs) { const t = win.today; t.input += input; t.cacheWrite += cacheWrite; t.cacheRead += cacheRead; t.output += output; t.records += 1; }
  if (tsMs >= WIN_WEEK.startMs && tsMs <= WIN_WEEK.endMs) { const w = win.week; w.input += input; w.cacheWrite += cacheWrite; w.cacheRead += cacheRead; w.output += output; w.records += 1; }
};
// 窗口 metrics 统一形状：input_side（归一输入侧）+ total（= input_side + output），供"环/总数"直接取用。
const winMetrics = (w, excl) => (w ? (() => {
  const input_side = excl ? w.input + w.cacheWrite + w.cacheRead : w.input;
  return { input: w.input, output: w.output, cache_write: w.cacheWrite, cache_read: w.cacheRead, input_side, total: input_side + w.output };
})() : null);

function* walkJsonl(root, cap = 5000) {
  const stack = [root];
  let n = 0;
  while (stack.length) {
    let entries;
    try { entries = readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(e.parentPath ?? '', e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jsonl')) { yield p; if (++n >= cap) return; }
    }
  }
}
function readJsonl(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 真实日志会被截断，跳过坏行 */ }
  }
  return out;
}

// ── Claude Code：message.usage，按 message.id + requestId 去重（子 agent/续接会复制旧消息）
function parseClaudeCode(roots) {
  const acc = mk();
  const win = mkWin();
  const seen = new Set();
  const keys = new Set();
  for (const root of roots) {
    for (const file of walkJsonl(root)) {
      let recs;
      try { recs = readJsonl(file); } catch { continue; }
      let used = false;
      for (const r of recs) {
        const u = r?.message?.usage;
        if (!u || typeof u !== 'object') continue;
        const key = `${r?.message?.id ?? r?.uuid ?? ''}:${r?.requestId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const k of Object.keys(u)) keys.add(k);
        const input = num(u.input_tokens);
        const cacheWrite = num(u.cache_creation_input_tokens);
        const cacheRead = num(u.cache_read_input_tokens);
        const output = num(u.output_tokens);
        acc.input += input; acc.cacheWrite += cacheWrite; acc.cacheRead += cacheRead; acc.output += output;
        acc.records += 1;
        used = true;
        touch(acc, r?.timestamp);
        addWin(win, Date.parse(r?.timestamp ?? ''), input, cacheWrite, cacheRead, output);
      }
      if (used) acc.files += 1;
    }
  }
  return { ...acc, status: acc.records ? 'verified' : 'not-found', keysSeen: [...keys].sort(), win };
}

// ── Codex：每会话取最后一条 total_token_usage（累计），绝不求和
function parseCodex(root) {
  const acc = mk();
  const keys = new Set();
  let boundaryFiles = 0;
  let carriedFiles = 0;      // 隔离：带前置累计且无法精确扣除
  let deductedExact = 0;     // 带前置累计，但基线对得上 → 扣基线后精确计入
  const boundaryKinds = { reset: 0, jump: 0, gap: 0, anomaly: 0, duplicateEvents: 0 };

  // pass 1：读全部文件，并建「total → 该状态下的字段值」全局索引（基线扣除需要它）
  const files = [];
  const totalsMap = new Map();
  for (const file of walkJsonl(root, 2000)) {
    let recs;
    try { recs = readJsonl(file); } catch { continue; }
    const seq = [];
    let cwd = null;
    for (const r of recs) {
      if (!cwd) cwd = r?.payload?.cwd ?? r?.cwd ?? r?.payload?.session_meta?.cwd ?? null;
      const info = r?.payload?.info;
      if (r?.payload?.type !== 'token_count' || !info?.total_token_usage) continue;
      const t = {
        ...info.total_token_usage,
        last_token_tokens: info.last_token_usage?.total_tokens,
        ts: r?.timestamp ?? r?.ts ?? null,
      };
      seq.push(t);
      for (const k of Object.keys(info.total_token_usage)) keys.add(k);
      totalsMap.set(num(t.total_tokens), {
        input: num(t.input_tokens), cacheRead: num(t.cached_input_tokens), output: num(t.output_tokens), cwd,
      });
    }
    if (seq.length) files.push({ file, seq, cwd });
  }

  for (const { seq, cwd } of files) {
    const first = seq[0];
    const carried = Number.isFinite(first.last_token_tokens) && first.last_token_tokens !== num(first.total_tokens);
    if (carried) {
      // 续接会话：带着上一段会话的累计开场。能不能救回来，取决于两个可核实条件：
      //   (a) 事件时间戳不止一个值 —— 否则无法排除"回放"，不折算；
      //   (b) 基线能在全局索引里找到 —— 否则无法按字段拆分，不折算。
      const base = num(first.total_tokens) - num(first.last_token_tokens);
      const uniqTs = new Set(seq.map((x) => x.ts).filter(Boolean)).size;
      const baseFields = totalsMap.get(base);
      const cwdMatches = Boolean(baseFields?.cwd && cwd && baseFields.cwd === cwd);
      if (uniqTs > 1 && baseFields && cwdMatches) {
        const maxEv = seq.reduce((a, b) => (num(b.total_tokens) >= num(a.total_tokens) ? b : a));
        acc.input += Math.max(0, num(maxEv.input_tokens) - baseFields.input);
        acc.cacheRead += Math.max(0, num(maxEv.cached_input_tokens) - baseFields.cacheRead);
        acc.output += Math.max(0, num(maxEv.output_tokens) - baseFields.output);
        acc.files += 1;
        acc.records += 1;
        deductedExact += 1;
      } else {
        carriedFiles += 1;
      }
      continue;
    }

    // 非续接文件：按"无法被继续累加解释"切段（细则见下）
    const runs = [];
    let run = null;
    let prev = null;
    for (const t of seq) {
      const tot = num(t.total_tokens);
      if (prev) {
        const delta = tot - num(prev.total_tokens);
        const last = num(t.last_token_tokens ?? NaN);
        if (delta === 0) { boundaryKinds.duplicateEvents += 1; continue; }
        if (delta < 0) { boundaryKinds.reset += 1; if (run) { runs.push(run); run = null; } }
        else if (!Number.isNaN(last) && last > 0 && delta !== last && tot === last) {
          boundaryKinds.jump += 1; if (run) { runs.push(run); run = null; }
        } else if (!Number.isNaN(last) && last > 0 && delta !== last && delta < last) {
          boundaryKinds.anomaly += 1;
        } else if (!Number.isNaN(last) && last > 0 && delta !== last) {
          boundaryKinds.gap += 1;
        }
      }
      if (!run || tot >= num(run.total_tokens)) run = t;
      prev = t;
    }
    if (run) runs.push(run);
    if (runs.length > 1) boundaryFiles += 1;
    acc.files += 1;
    acc.records += 1;
    for (const t of runs) {
      acc.input += num(t.input_tokens);
      acc.output += num(t.output_tokens);
      acc.cacheRead += num(t.cached_input_tokens);
    }
  }

  return {
    ...acc,
    status: acc.records ? 'verified' : 'not-found',
    keysSeen: [...keys].sort(),
    boundaryFiles,
    boundaryKinds,
    carriedFiles,
    deductedExact,
  };
}

// ── 形状未核实：只报告"发现了什么"
const TOKEN_KEY = /^(input|output|cached_input|cache_read|cache_creation|total)_tokens$/;
function findShapes(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach((v) => findShapes(v, found)); return found; }
  const tk = Object.keys(node).filter((k) => TOKEN_KEY.test(k));
  if (tk.length) { found.push(tk); return found; }
  for (const k of Object.keys(node)) findShapes(node[k], found);
  return found;
}
function probe(root) {
  const keyCounts = new Map();
  let files = 0;
  let hits = 0;
  for (const file of walkJsonl(root, 400)) {
    let recs;
    try { recs = readJsonl(file); } catch { continue; }
    let hit = false;
    for (const r of recs) {
      for (const keys of findShapes(r)) {
        hits += 1;
        hit = true;
        for (const k of keys) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
      }
    }
    if (hit) files += 1;
  }
  return { files, records: hits, status: hits ? 'found-unverified' : 'not-found', keysSeen: [...keyCounts.keys()].sort() };
}

/** 按 RFC8878 结构走一帧：帧头（描述符→窗口/字典/内容大小）→ 逐 block 到 Last_Block → 可选 checksum。返回精确帧尾，失败返回 null。 */
function walkZstdFrame(buf, start) {
  let p = start;
  if (p + 4 > buf.length || buf.readUInt32LE(p) !== 0xfd2fb528) return null;
  p += 4;
  const fhd = buf[p]; p += 1;
  const fcsFlag = (fhd >> 6) & 3;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!single) p += 1;                                  // Window_Descriptor
  p += [0, 1, 2, 4][dictFlag];                          // Dictionary_ID
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]; // Frame_Content_Size
  let sawLast = false;
  for (let guard = 0; guard < 1000000; guard += 1) {
    if (p + 3 > buf.length) return null;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >> 3;
    if (type === 3) return null;                        // Reserved：不可信
    p += type === 1 ? 1 : size;                         // RLE 载荷固定 1 字节
    if (p > buf.length) return null;
    if (last) { sawLast = true; break; }
  }
  if (!sawLast) return null;
  if (checksum) p += 4;
  return p <= buf.length ? p : null;
}

/**
 * 解出全部 zstd 帧的明文。
 * 主路径是**结构走位**（不靠搜索魔数，因此不会被压缩数据里碰巧出现的 4 字节骗到）；
 * 只有当走位失败、或走位结果处不是下一个魔数时，才退回"找下一个魔数"的切法并计数。
 */
function decodeZstdFrames(buf) {
  const isMagic = (i) => i + 4 <= buf.length && buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd;
  const parts = [];
  let frames = 0;
  let badFrames = 0;
  let walkFallbacks = 0;
  let p = 0;
  while (p + 4 <= buf.length && isMagic(p)) {
    let end = walkZstdFrame(buf, p);
    if (end === null || end <= p || (end < buf.length && !isMagic(end))) {
      walkFallbacks += 1;
      let q = p + 4;
      while (q < buf.length && !isMagic(q)) q += 1;
      end = q;
    }
    try {
      const plain = zstdDecompressSync(buf.subarray(p, end));
      parts.push(plain);
      frames += 1;
    } catch { badFrames += 1; }
    p = end;
  }
  if (!frames) return { text: null, frames: 0, badFrames, walkFallbacks };
  return { text: Buffer.concat(parts).toString('utf8'), frames, badFrames, walkFallbacks };
}

/** 递归收集指定后缀的文件（DSH 的会话是 .jsonl.zstd）。 */
function* walkFiles(root, suffix, cap = 5000) {
  const stack = [root];
  let n = 0;
  while (stack.length) {
    let entries;
    try { entries = readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(e.parentPath ?? '', e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(suffix)) { yield p; if (++n >= cap) return; }
    }
  }
}

/** 一条记录只取一个 usage 对象：同一条里可能嵌套两份，重复计数会翻倍。 */
function firstUsage(node) {
  let found = null;
  (function w(o, d = 0) {
    if (found || !o || typeof o !== 'object' || d > 8) return;
    if (o.usage && typeof o.usage === 'object' && ('inputTokens' in o.usage || 'input_tokens' in o.usage)) { found = o.usage; return; }
    for (const k of Object.keys(o)) w(o[k], d + 1);
  })(node);
  return found;
}

// ── DeepSeek Harness：多帧 zstd 会话日志；用量是"逐请求"（实测不单调），故求和；同会话内 seq 唯一，用作去重键
function parseDsh(root) {
  const acc = mk();
  let frames = 0;
  let badFrames = 0;
  let walkFallbacks = 0;
  let badLines = 0; // 解不开的 JSONL 行：帧被误切时产生的正是这种垃圾行
  const seen = new Set();
  const keys = new Set();
  const win = mkWin();
  for (const file of walkFiles(root, '.jsonl.zstd')) {
    let buf;
    try { buf = readFileSync(file); } catch { continue; }
    const dec = decodeZstdFrames(buf);
    // 先累加帧级计数再判空：文件所有帧都解压失败时 text 为 null，但 badFrames 必须计入，否则坏帧被静默丢弃。
    frames += dec.frames;
    badFrames += dec.badFrames;
    walkFallbacks += dec.walkFallbacks;
    if (!dec.text) continue;
    let used = false;
    for (const line of dec.text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let r;
      try { r = JSON.parse(t); } catch { badLines += 1; continue; }
      const u = firstUsage(r);
      if (!u) continue;
      const key = `${file}:${r?.seq ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const k of Object.keys(u)) keys.add(k);
      const input = num(u.inputTokens ?? u.input_tokens);
      const output = num(u.outputTokens ?? u.output_tokens);
      const cacheRead = num(u.cacheReadTokens ?? u.cache_read_input_tokens);
      const cacheWrite = num(u.cacheWriteTokens ?? u.cache_creation_input_tokens);
      acc.input += input; acc.output += output; acc.cacheRead += cacheRead; acc.cacheWrite += cacheWrite;
      acc.records += 1;
      used = true;
      touch(acc, typeof r?.time === 'number' ? new Date(r.time).toISOString() : undefined);
      addWin(win, typeof r?.time === 'number' ? r.time : NaN, input, cacheWrite, cacheRead, output);
    }
    if (used) acc.files += 1;
  }
  return { ...acc, status: acc.records ? 'verified' : 'not-found', keysSeen: [...keys].sort(), frames, badFrames, walkFallbacks, badLines, win };
}

const SOURCES = [
  {
    id: 'claude-code', label: 'Claude Code', kind: 'claude',
    roots: [
      under('claude', join(HOME, '.claude', 'projects')),
      under('claude-config', join(HOME, '.config', 'claude', 'projects')),
    ],
    semantics: { inputExcludesCache: true, note: 'input 不含 cache；输入侧 = input + cache_write + cache_read' },
  },
  {
    id: 'codex', label: 'Codex', kind: 'codex',
    root: under('codex', join(HOME, '.codex')),
    semantics: { inputExcludesCache: false, note: 'cached ⊂ input；每会话取最后一条累计值，不求和' },
  },
  {
    id: 'dsh', label: 'DeepSeek Harness', kind: 'dsh',
    root: under('dsh', join(HOME, '.dsh', 'sessions')),
    semantics: { inputExcludesCache: true, note: 'input 不含 cache；多帧 zstd 逐帧解压；按 seq 去重；用量为逐请求，故求和' },
  },
  { id: 'cursor', label: 'Cursor', kind: 'probe', root: under('cursor', join(HOME, '.cursor')) },
  { id: 'gemini', label: 'Gemini', kind: 'probe', root: under('gemini', join(HOME, '.gemini')) },
];

const activeSources = only ? SOURCES.filter((s) => only.has(s.id)) : SOURCES;
if (only && !activeSources.length) throw new Error(`--only 没有匹配到任何来源：${onlyArg}`);

const sources = [];
for (const s of activeSources) {
  let r;
  if (s.kind === 'claude') r = parseClaudeCode(s.roots);
  else if (s.kind === 'codex') r = parseCodex(s.root);
  else if (s.kind === 'dsh') r = parseDsh(s.root);
  else if (s.kind === 'probe') r = probe(s.root);
  else r = { files: 0, records: 0, status: 'not-implemented', keysSeen: [] };

  const verified = r.status === 'verified';
  // "取到没有"：该 provider 的数据目录在这台机器上是否存在。区分"没装/读不到"（false）与"装了但用量为 0"（true 且 metrics 全 0）。
  const rootPaths = s.roots ?? (s.root ? [s.root] : []);
  const available = rootPaths.some((p) => existsSync(p));
  const availability = verified ? 'ok' : r.status === 'found-unverified' ? 'unknown' : 'not_installed';
  sources.push({
    source: s.id,
    label: s.label,
    status: r.status,
    available,
    availability,
    window: {
      today: { start: WIN_TODAY.start, end: WIN_TODAY.end, metrics: verified && r.win ? winMetrics(r.win.today, s.semantics?.inputExcludesCache !== false) : null },
      week: { start: WIN_WEEK.start, end: WIN_WEEK.end, metrics: verified && r.win ? winMetrics(r.win.week, s.semantics?.inputExcludesCache !== false) : null },
    },
    // 0 是数据，空是不知道 —— 未核实一律 null
    metrics: verified ? { input: r.input, output: r.output, cache_write: r.cacheWrite, cache_read: r.cacheRead } : null,
    // 跨厂商可比的归一化：输入侧总量
    normalized: verified
      ? { input_side: s.semantics.inputExcludesCache ? r.input + r.cacheWrite + r.cacheRead : r.input, output: r.output }
      : null,
    files: r.files,
    records: r.records,
    first: r.first ?? null,
    last: r.last ?? null,
    keysSeen: r.keysSeen,
    boundaryFiles: r.boundaryFiles ?? null,
    carriedFiles: r.carriedFiles ?? null,
    frames: r.frames ?? null,
    badFrames: r.badFrames ?? null,
    walkFallbacks: r.walkFallbacks ?? null,
    badLines: r.badLines ?? null,
    deductedExact: r.deductedExact ?? null,
    boundaryKinds: r.boundaryKinds ?? null,
    semantics: s.semantics ?? null,
    note: s.note ?? null,
  });
}

const verified = sources.filter((s) => s.status === 'verified');
const sum = (f) => verified.reduce((a, s) => a + f(s), 0);
const totals = verified.length
  ? {
      verifiedOnly: true,
      providers: verified.map((s) => s.source),
      metrics: {
        input: sum((s) => s.metrics.input),
        output: sum((s) => s.metrics.output),
        cache_write: sum((s) => s.metrics.cache_write),
        cache_read: sum((s) => s.metrics.cache_read),
      },
      normalized: { input_side: sum((s) => s.normalized.input_side), output: sum((s) => s.normalized.output) },
      records: sum((s) => s.records),
      // 有会话被隔离时，合计只是下限
      // 任何"少了一部分"的来源都要把合计标成下限：隔离会话、以及被跳过的坏行
      lowerBound: sources.some((s) => s.carriedFiles || s.badLines || s.badFrames),
    }
  : null;

// 时间窗合计（只加有窗口 metrics 的来源）：菜单栏"环"的分子；分母=预算，属 UI 设置。
const windowTotals = (kind) => {
  const srcs = sources.filter((s) => s.window?.[kind]?.metrics);
  if (!srcs.length) return null;
  const sumf = (f) => srcs.reduce((a, s) => a + f(s.window[kind].metrics, s), 0);
  return {
    input: sumf((m) => m.input),
    output: sumf((m) => m.output),
    cache_write: sumf((m) => m.cache_write),
    cache_read: sumf((m) => m.cache_read),
    input_side: sumf((m) => m.input_side),
    total: sumf((m) => m.total),
  };
};
const window = {
  today: { start: WIN_TODAY.start, end: WIN_TODAY.end, metrics: windowTotals('today') },
  week: { start: WIN_WEEK.start, end: WIN_WEEK.end, metrics: windowTotals('week') },
};

// 结构化：UI 只按 code 分流、message 原样展示；未知 code 不得崩溃（WorkBuddy #139/#144）。
const warnings = [];
for (const s of sources) {
  if (s.carriedFiles) warnings.push({
    code: 'sessions_quarantined',
    message: `${s.label}: ${s.carriedFiles} 个会话文件带前置累计（续接会话），已整份隔离不计入合计——否则会把上一段会话的用量重复计算。因此合计是下限（≥ X），不是精确值。`,
  });
}
for (const s of sources) {
  if (s.badFrames) warnings.push({
    code: 'frame_decode_failed',
    message: `${s.label}: ${s.badFrames} 帧未能解压——这些帧的内容未计入，共计数因此是下限。`,
  });
  if (s.badLines) warnings.push({
    code: 'unparsable_lines',
    message: `${s.label}: 有 ${s.badLines} 行解不开的 JSONL——通常意味着帧切分或解压出了问题，读数可能不完整。`,
  });
}
warnings.push({
  code: 'input_semantics_differ',
  message: '原始 metrics 的 input 列在不同厂商含义不同（Claude Code 不含 cache，OpenAI 含 cached）：跨厂商求和请用 normalized.input_side。',
});

if (asJson) {
  console.log(JSON.stringify({ schema: SCHEMA, as_of: new Date().toISOString(), window, sources, totals, warnings }, null, 2));
} else {
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const dash = (d) => d.padStart(10);
  console.log(`usage-lens v0.2 ｜ schema ${SCHEMA} ｜ 只读本地日志，不联网、不读 API key、不写文件\n`);
  console.log('来源'.padEnd(20) + '状态'.padEnd(20) + '文件'.padStart(6) + '记录'.padStart(8) + 'input'.padStart(10) + 'cache写'.padStart(10) + 'cache读'.padStart(10) + 'output'.padStart(10));
  console.log('─'.repeat(94));
  for (const s of sources) {
    const m = s.metrics;
    console.log(
      s.label.padEnd(20) + s.status.padEnd(20) + String(s.files).padStart(6) + String(s.records).padStart(8) +
      (m ? k(m.input).padStart(10) + k(m.cache_write).padStart(10) + k(m.cache_read).padStart(10) + k(m.output).padStart(10)
         : [dash('—'), dash('—'), dash('—'), dash('—')].join('')),
    );
    if (!m && s.keysSeen?.length) console.log(`  └ 发现 token 类字段（未核实，故不折算）：${s.keysSeen.join('、')}`);
    if (s.note) console.log(`  └ ${s.note}`);
  }
  console.log('─'.repeat(94));
  if (totals) {
    console.log(`合计（仅 verified：${verified.map((s) => s.label).join('、')}）${totals.lowerBound ? '  ← 下限 ≥，有会话未计入' : ''}`);
    console.log(`  原始：input ${k(totals.metrics.input)} ｜ cache写 ${k(totals.metrics.cache_write)} ｜ cache读 ${k(totals.metrics.cache_read)} ｜ output ${k(totals.metrics.output)}`);
    console.log(`  归一：输入侧 ${k(totals.normalized.input_side)} ｜ output ${k(totals.normalized.output)}   ← 跨厂商可比`);
  } else console.log('合计：无（没有 verified 来源）');
  console.log('');
  for (const w of warnings) console.log(`⚠ [${w.code}] ${w.message}`);
}

// 退出码：至少一个来源 verified → 0；否则 1（便于脚本/CI 判断）
process.exitCode = sources.some((x) => x.status === 'verified') ? 0 : 1;
