// usage-lens 回归测试（零依赖，node test.mjs 即可）
// 全部断言基于**合成夹具**，不含任何真实用量帧或本机路径（#309/#311/#313）。
import { execFileSync } from 'node:child_process';

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  得到 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`}`);
  if (!ok) failures += 1;
};
// CLI 在"无 verified 来源"时退出码为 1，但 stdout 仍是合法 JSON → 一律取 stdout。
const run = (args) => {
  let out;
  try { out = execFileSync('node', ['usage-lens.mjs', ...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = e.stdout; }
  return JSON.parse(out);
};

// 1) XXH64 回归自检（官方向量 7/7，不参与读账）
let selftestOk = true;
try { selftestOk = execFileSync('node', ['usage-lens.mjs', '--selftest'], { encoding: 'utf8' }).includes('7/7'); }
catch { selftestOk = false; }
check('XXH64 自检 7/7', selftestOk, true);

// 2) 正向夹具（全部合成帧）
const fx = run(['--root', 'fixtures']);
const codex = fx.sources.find((s) => s.source === 'codex');
const dsh = fx.sources.find((s) => s.source === 'dsh');
check('codex 扣除/隔离 = 1/2', [codex.deductedExact, codex.carriedFiles], [1, 2]);
check('codex metrics', codex.metrics, { input: 6820, output: 257, cache_write: 0, cache_read: 519 });
check('dsh 帧数 = 3（防静默 0 帧回归）', dsh.frames, 3);
check('dsh 坏行 = 1', dsh.badLines, 1);
check('dsh 记录 = 3', dsh.records, 3);
check('dsh metrics', dsh.metrics, { input: 310, output: 32, cache_write: 1, cache_read: 12 });
check('lowerBound = true', fx.totals.lowerBound, true);
check('warnings 三个 code', fx.warnings.map((w) => w.code).sort(), ['input_semantics_differ', 'sessions_quarantined', 'unparsable_lines']);
// 状态位：availability（ok/unknown/not_installed，映射自 status）+ available（数据目录是否存在）
check('claude-code availability = ok', fx.sources.find((s) => s.source === 'claude-code').availability, 'ok');
check('codex availability = ok', codex.availability, 'ok');
check('dsh availability = ok', dsh.availability, 'ok');
check('cursor availability = not_installed', fx.sources.find((s) => s.source === 'cursor').availability, 'not_installed');
check('gemini availability = not_installed', fx.sources.find((s) => s.source === 'gemini').availability, 'not_installed');
check('cursor available = true（空目录=装了但无日志）', fx.sources.find((s) => s.source === 'cursor').available, true);
// 时间窗：today / week 各有 start/end（ISO）+ metrics；verified 来源为对象、未核实/累计型为 null
check('window.today.start 是 ISO', typeof fx.window.today.start, 'string');
check('window.today.end 是 ISO', typeof fx.window.today.end, 'string');
check('window.week.start 是 ISO', typeof fx.window.week.start, 'string');
check('window.week.start <= today.start', fx.window.week.start <= fx.window.today.start, true);
check('claude window.today.metrics 是对象', typeof fx.sources.find((s) => s.source === 'claude-code').window.today.metrics, 'object');
check('cursor window.today.metrics = null', fx.sources.find((s) => s.source === 'cursor').window.today.metrics, null);
check('codex window.today.metrics = null（累计型待接）', codex.window.today.metrics, null);
// 类型契约：计数字段要么 null（不适用）、要么 number——UI 的 jq `cnt` 靠 type=="number" 判断，别让类型漂
check('计数类型 null|number', fx.sources.every((s) => ['carriedFiles', 'badLines', 'badFrames'].every((f) => s[f] === null || typeof s[f] === 'number')), true);

// 3) 负向夹具（合成帧：一个坏帧[checksum 标志置位+错误校验和] + 一个好帧）
const ng = run(['--root', 'fixtures-negative']);
const ngDsh = ng.sources.find((s) => s.source === 'dsh');
check('负向：badFrames = 1', ngDsh.badFrames, 1);
check('负向：好帧记录 = 1（坏帧未计入）', ngDsh.records, 1);
check('负向：lowerBound = true', ng.totals?.lowerBound, true);
check('负向：frame_decode_failed 出现', ng.warnings.some((w) => w.code === 'frame_decode_failed'), true);
check('负向：dsh available = true', ngDsh.available, true);

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
