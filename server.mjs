#!/usr/bin/env node
/**
 * modelscope-gen-image-mcp — 魔搭 AIGC 生图 + 发布到创意广场的 MCP 服务器（stdio）
 *
 * 零第三方依赖（Node >= 22）。
 *
 * 首次使用（每台机器一次）：
 *   npx -y github:ga-ven/modelscope-gen-image-mcp login
 *   然后在弹出的 Chrome 窗口里登录魔搭，Cookie 会存到 ~/.modelscope-aigc/cookies.json
 *
 * 认证优先级：
 *   1) MODELSCOPE_COOKIE 环境变量（CI / 临时覆盖）
 *   2) ~/.modelscope-aigc/cookies.json（由 login 生成，每次调用时重新读取）
 *
 * 工具：generate_image / publish_to_gallery / get_quota
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const BASE = process.env.MODELSCOPE_BASE || 'https://modelscope.cn';
const HOME_DIR = process.env.MMP_HOME || path.join(os.homedir(), '.modelscope-aigc');
const COOKIE_FILE = path.join(HOME_DIR, 'cookies.json');
const PROFILE_DIR = path.join(HOME_DIR, 'chrome-profile');

const MODELS = {
  'qwen-image-2.1-turbo': { id: 1138360, name: 'Qwen/Qwen-Image-2.1-Turbo', steps: 8 },
  'qwen-image-2.1': { id: 1079253, name: 'Qwen/Qwen-Image-2.1', steps: 40 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 认证
function readCookieFile() {
  try {
    const j = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    return j && j.cookie ? j.cookie : '';
  } catch { return ''; }
}

function currentCookie() {
  return process.env.MODELSCOPE_COOKIE || readCookieFile();
}

function authHint() {
  return `未找到魔搭登录态。先执行一次：\n  npx -y github:ga-ven/modelscope-gen-image-mcp login\n（或用环境变量 MODELSCOPE_COOKIE 覆盖）`;
}

function headers() {
  const h = {
    'Content-Type': 'application/json',
    Origin: BASE,
    Referer: `${BASE}/aigc/image-generation?tab=advanced`,
  };
  const ck = currentCookie();
  if (ck) h.Cookie = ck;
  return h;
}

async function api(pathname, { method = 'GET', body } = {}) {
  if (!currentCookie()) throw new Error(authHint());
  const res = await fetch(BASE + pathname, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 ${res.status}: ${text.slice(0, 160)}`); }
  if (res.status === 401 || res.status === 403) throw new Error(`登录态失效（${res.status}）。重新执行 login 刷新 Cookie。`);
  if (!res.ok || json.Success === false) {
    throw new Error(`接口失败 ${res.status} ${pathname}: ${json.Message || json?.Data?.message || text.slice(0, 160)}`);
  }
  const d = json.Data ?? json;
  // 两层信封：{Data:{code,data,message}}
  if (d && typeof d === 'object' && 'code' in d && 'data' in d) {
    if (d.success === false) throw new Error(`业务失败 ${pathname}: ${d.message || ''} (code=${d.code})`);
    return d.data;
  }
  if (d && d.success === false) throw new Error(`业务失败 ${pathname}: ${d.message || ''} (code=${d.code})`);
  return d;
}

// ---------------------------------------------------------------- 登录
function chromePath() {
  const cands = [
    process.env.CHROME,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

async function cdpAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function readCookiesViaCdp(port) {
  const v = await cdpAlive(port);
  if (!v) return '';
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws error')));
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });
  const list = await new Promise((res, rej) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result.cookies);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
    setTimeout(() => rej(new Error('cookie timeout')), 10000);
  }).catch(() => null);
  ws.close();
  if (!list) return '';
  const jar = list.filter((c) => /modelscope\.cn/.test(c.domain));
  return jar.length ? jar.map((c) => `${c.name}=${c.value}`).join('; ') : '';
}

async function verifyCookie(ck) {
  try {
    const res = await fetch(`${BASE}/api/v1/users/login/info`, {
      headers: { Cookie: ck, Referer: `${BASE}/aigc/image-generation`, Origin: BASE },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    if (!j || j.Success === false) return null;
    return j.Data?.Name || j.Data?.name || 'ok';
  } catch { return null; }
}

async function login() {
  const exe = chromePath();
  if (!exe) {
    console.error('找不到 Chrome，可用 CHROME 环境变量指定路径');
    process.exit(1);
  }
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const port = Number(process.env.MMP_LOGIN_PORT || 9411);
  console.error(`启动 Chrome（专用配置：${PROFILE_DIR}）…`);
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    `${BASE}/aigc/image-generation?tab=advanced`,
  ], { stdio: 'ignore' });

  console.error('请在打开的窗口里登录魔搭（扫码/短信都行），成功后会自动保存…');
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const ck = await readCookiesViaCdp(port);
    if (!ck) continue;
    const who = await verifyCookie(ck);
    if (who) {
      fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie: ck, savedAt: new Date().toISOString(), user: who }, null, 1));
      console.error(`\n✅ 登录成功（${who}），已保存到 ${COOKIE_FILE}`);
      await sleep(500);
      try { child.kill(); } catch {}
      process.exit(0);
    }
  }
  console.error('超时：6 分钟内没检测到登录态。窗口保持打开，登录后重跑一次 login 即可（复用同一配置）。');
  process.exit(1);
}

// ---------------------------------------------------------------- 业务
function resolveModel(key) {
  const k = String(key || 'qwen-image-2.1-turbo').toLowerCase();
  const m = MODELS[k];
  if (!m) throw new Error(`未知模型 ${key}，可选：${Object.keys(MODELS).join(', ')}`);
  return m;
}

function parseSize(size) {
  const mt = String(size || '1472*1104').match(/^(\d{3,5})\s*[*x×]\s*(\d{3,5})$/);
  if (!mt) throw new Error('尺寸格式应为 1472*1104');
  return { width: +mt[1], height: +mt[2] };
}

async function generateImage({ prompt, negative_prompt = '', model = 'qwen-image-2.1-turbo', size = '1472*1104', seed = -1, timeout_ms = 300000 }) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt 不能为空');
  const m = resolveModel(model);
  const { width, height } = parseSize(size);

  const sub = await api('/api/v1/muse/predict/task/submit', {
    method: 'POST',
    body: {
      modelArgs: { checkpointModelVersionId: m.id, loraArgs: [], checkpointShowInfo: m.name },
      promptArgs: { prompt: String(prompt), negativePrompt: String(negative_prompt) },
      basicDiffusionArgs: {
        sampler: 'Euler', seed: Number(seed), numImagesPerPrompt: 1,
        numInferenceSteps: m.steps, width, height, advanced: false,
      },
      adetailerArgsMap: {}, hiresFixFrontArgs: null,
      addWaterMark: false, advanced: false,
      predictType: 'TXT_2_IMG', controlNetFullArgs: [],
    },
  });
  const taskId = String(sub.taskId || sub.recordId);
  if (!taskId || taskId === 'undefined') throw new Error('提交成功但没拿到 taskId');

  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeout_ms) {
    await sleep(4000);
    const st = await api(`/api/v1/muse/predict/task/status?taskId=${encodeURIComponent(taskId)}`);
    const s = String(st.status || '');
    last = st.progress?.detail || s;
    if (s === 'SUCCEED') {
      const imgs = st.predictResult?.images || [];
      if (!imgs.length) throw new Error('任务成功但没有图片');
      return {
        taskId,
        images: imgs.map((i) => ({ url: i.imageUrl, width: i.width, height: i.height, imageId: i.imageId })),
      };
    }
    if (s && s !== 'PROCESSING' && s !== 'PENDING') throw new Error(`任务失败 ${s}: ${st.errorMsg || ''}`);
  }
  throw new Error(`等待超时（最后状态：${last}）`);
}

async function publishToGallery({ image_url, title, labels = [] }) {
  if (!image_url) throw new Error('image_url 不能为空');
  const upd = await api('/api/v1/muse/image/updateImageGenerateInfo', {
    method: 'POST',
    body: [{ imageId: 0, imageUrl: image_url }],
  });
  let imageId = Array.isArray(upd) ? upd[0] : (upd?.imageId ?? upd?.data?.[0]);
  if (!imageId) {
    const his = await api('/api/v1/muse/predict/queryHistoryList', {
      method: 'POST', body: { pageNumber: 1, pageSize: 20, predictMode: 'PROFESSIONAL' },
    });
    const rec = (his.records || []).find((r) => (r.image?.imageUrl || '') === image_url);
    imageId = rec?.image?.imageId;
  }
  if (!imageId) throw new Error('无法确定 imageId');

  const pic = await api('/api/v1/aigc/picture/upload', {
    method: 'POST',
    body: {
      Title: String(title || '未命名作品').slice(0, 40),
      MuseImages: [{ MuseImageID: Number(imageId), IsCoverImage: 1 }],
      Labels: Array.isArray(labels) ? labels : [],
    },
  });
  const id = pic.id || pic.pictureId;
  return { pictureId: id, shareUrl: `${BASE}/aigc/gallery/share/${id}`, title: pic.title || title, cover: pic.display_url };
}

async function getQuota() {
  const info = await api('/api/v1/users/login/info');
  const est = await api('/api/v1/muse/predict/getEstimateConsumeComputeQuota', {
    method: 'POST',
    body: {
      type: 'IMAGE',
      predictTaskRequest: {
        paintingParams: { predictType: 'TXT_2_IMG' },
        modelArgs: { checkpointModelVersionId: MODELS['qwen-image-2.1-turbo'].id, loraArgs: [], checkpointShowInfo: MODELS['qwen-image-2.1-turbo'].name },
        promptArgs: { prompt: '', negativePrompt: '' },
        basicDiffusionArgs: { sampler: 'Euler', seed: -1, numImagesPerPrompt: 1, numInferenceSteps: 8, width: 1472, height: 1104, advanced: false },
        adetailerArgsMap: {}, hiresFixFrontArgs: null, advanced: false,
      },
    },
  });
  return { user: info?.Name || info?.name || '', turboCostPerImage: est, models: Object.keys(MODELS) };
}

// ---------------------------------------------------------------- MCP
const TOOLS = [
  {
    name: 'generate_image',
    description: '在魔搭 AIGC 专业生图（Qwen-Image）上按提示词生成图片，自动轮询到出图，返回图片直链。默认 Turbo 模型，约 25 秒，消耗 1 魔粒。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '正向提示词' },
        negative_prompt: { type: 'string', description: '负向提示词（可选）' },
        model: { type: 'string', enum: Object.keys(MODELS), description: '模型，默认 qwen-image-2.1-turbo' },
        size: { type: 'string', description: '宽*高，默认 1472*1104（横向）；竖版 1104*1472' },
        seed: { type: 'number', description: '随机种子，-1 为随机' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'publish_to_gallery',
    description: '把已生成的图片发布到魔搭创意广场，返回作品 ID 与分享链接。',
    inputSchema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'generate_image 返回的图片直链' },
        title: { type: 'string', description: '作品名称（40 字以内）' },
        labels: { type: 'array', items: { type: 'string' }, description: '标签，如 ["三视图","模特"]' },
      },
      required: ['image_url', 'title'],
    },
  },
  {
    name: 'get_quota',
    description: '查询当前登录用户、Turbo 单次生图消耗与可用模型。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  if (name === 'generate_image') return await generateImage(args || {});
  if (name === 'publish_to_gallery') return await publishToGallery(args || {});
  if (name === 'get_quota') return await getQuota();
  throw new Error('未知工具 ' + name);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function serve() {
  if (!currentCookie()) console.error('[modelscope-gen-image-mcp] ' + authHint());
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    const { id, method, params } = msg;
    if (id === undefined || id === null) return;
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'modelscope-aigc', version: '0.2.0' },
          },
        });
        return;
      }
      if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
      if (method === 'tools/call') {
        const out = await callTool(params?.name, params?.arguments || {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] } });
        return;
      }
      if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } });
    }
  });
}

const cmd = process.argv[2];
if (cmd === 'login') login();
else if (cmd === 'whoami') {
  const ck = currentCookie();
  if (!ck) { console.log('未登录：' + COOKIE_FILE); process.exit(1); }
  verifyCookie(ck).then((u) => { console.log(u ? `已登录：${u}` : 'Cookie 已失效，请重新 login'); process.exit(u ? 0 : 1); });
} else serve();
