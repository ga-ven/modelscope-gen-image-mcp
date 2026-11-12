// 批量换装三视图：读 prompts.json，逐套「生成 → 下载 → 发布」
//
// 用法（先执行过一次 login）：
//   node examples/batch-three-view.mjs --config prompts.json
//   node examples/batch-three-view.mjs --config prompts.json --only 1,3
//   node examples/batch-three-view.mjs --config prompts.json --no-publish
//
// 依赖：Node >= 22。认证走 ~/.modelscope-aigc/cookies.json（或 MODELSCOPE_COOKIE）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'server.mjs');

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

const cfgPath = opt('config', 'prompts.json');
if (!fs.existsSync(cfgPath)) {
  console.error('找不到配置 ' + cfgPath + '，可参考 examples/prompts.example.json');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const only = (opt('only', '') || '').split(',').filter(Boolean).map(Number);
const outDir = cfg.outDir || './out';
const publish = !flag('no-publish') && cfg.publish !== false;

// --- 起服务 ---
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
let buf = ''; const waiters = new Map(); let seq = 0;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); const f = waiters.get(m.id); if (f) { waiters.delete(m.id); f(m); } } catch {}
  }
});
const call = (method, params) => new Promise((res, rej) => {
  const id = ++seq; waiters.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => waiters.has(id) && (waiters.delete(id), rej(new Error('timeout ' + method))), 320000);
});
const tool = async (name, args) => {
  const r = await call('tools/call', { name, arguments: args });
  const txt = r.result?.content?.[0]?.text || '';
  if (r.result?.isError) throw new Error(txt);
  try { return JSON.parse(txt); } catch { return txt; }
};

const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
if (!init.result) { console.error('服务没起来'); process.exit(1); }

const quota = await tool('get_quota', {});
console.log(`账号：${quota.user}｜Turbo 单张 ${quota.turboCostPerImage} 魔粒\n`);

// --- 逐套跑 ---
const picked = cfg.variants.filter((v) => !only.length || only.includes(v.id));
const results = [];
fs.mkdirSync(outDir, { recursive: true });

for (const v of picked) {
  const prompt = cfg.base.replace('{OUTFIT}', v.outfit || '');
  console.log(`▶ ${v.name || v.id}`);
  try {
    const g = await tool('generate_image', {
      prompt,
      negative_prompt: cfg.negative || '',
      model: cfg.model || 'qwen-image-2.1-turbo',
      size: cfg.size || '1472*1104',
    });
    const img = g.images[0];
    const file = path.join(outDir, `${v.title || v.name || v.id}.jpg`);
    const bin = await (await fetch(img.url)).arrayBuffer();
    fs.writeFileSync(file, Buffer.from(bin));
    console.log(`  生成 OK  ${img.width}x${img.height}  ${file}`);

    let pub = null;
    if (publish) {
      pub = await tool('publish_to_gallery', { image_url: img.url, title: v.title || v.name, labels: cfg.tags || [] });
      console.log(`  发布 OK  ${pub.shareUrl}`);
    }
    results.push({ id: v.id, name: v.name, url: img.url, file, shareUrl: pub?.shareUrl || null });
  } catch (e) {
    console.log('  失败：' + String(e.message || e).slice(0, 200));
    results.push({ id: v.id, name: v.name, error: String(e.message || e).slice(0, 200) });
  }
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log('\n汇总：');
for (const r of results) console.log(r.error ? `  ✗ ${r.name}: ${r.error}` : `  ✓ ${r.name} ${r.shareUrl || r.url}`);
console.log(`\n报告：${path.join(outDir, 'report.json')}`);

child.kill();
process.exit(0);
