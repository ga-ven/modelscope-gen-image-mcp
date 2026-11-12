// 最小 MCP 客户端：握手 → 列工具 → 查额度 →（可选）真实生一张图
// 用法：
//   MODELSCOPE_API_TOKEN=xxx node examples/test-client.mjs
//   MODELSCOPE_API_TOKEN=xxx node examples/test-client.mjs --gen
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'server.mjs');

const child = spawn(process.execPath, [server], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); w(m); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});

const call = (id, method, params) => new Promise((res, rej) => {
  waiters.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => waiters.has(id) && (waiters.delete(id), rej(new Error('timeout ' + method))), 320000);
});

const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
console.log('initialize:', JSON.stringify(init.result.serverInfo));

const tl = await call(2, 'tools/list', {});
console.log('tools:', tl.result.tools.map((t) => t.name).join(', '));

const q = await call(3, 'tools/call', { name: 'get_quota', arguments: {} });
console.log('quota:', q.result.content[0].text);

if (process.argv.includes('--gen')) {
  const g = await call(4, 'tools/call', {
    name: 'generate_image',
    arguments: { prompt: '一只橘色小猫趴在机械键盘上，柔和窗光，真实摄影', model: 'qwen-image-2.1-turbo', size: '1024*1024' },
  });
  console.log('generate:', g.result.content[0].text);
}

child.kill();
process.exit(0);
