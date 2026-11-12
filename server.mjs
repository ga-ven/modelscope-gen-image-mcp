#!/usr/bin/env node
/**
 * modelscope-aigc-mcp — 魔搭 AIGC 生图 + 发布到创意广场的 MCP 服务器（stdio）
 *
 * 零第三方依赖（Node >= 22）。认证二选一：
 *   MODELSCOPE_API_TOKEN=<个人访问令牌>   ← 推荐，可上云部署
 *   MODELSCOPE_COOKIE=<原始 cookie 串>    ← 本地临时用
 *
 * 工具：
 *   generate_image      提示词 → 出图（自动轮询），返回图片 URL
 *   publish_to_gallery  图片 URL → 发布到创意广场，返回作品 ID 与分享链接
 *   get_quota           查询魔粒余额与单次消耗
 */
import readline from 'node:readline';

const BASE = process.env.MODELSCOPE_BASE || 'https://modelscope.cn';
const TOKEN = process.env.MODELSCOPE_API_TOKEN || '';
const COOKIE = process.env.MODELSCOPE_COOKIE || '';

const MODELS = {
  'qwen-image-2.1-turbo': { id: 1138360, name: 'Qwen/Qwen-Image-2.1-Turbo', steps: 8 },
  'qwen-image-2.1': { id: 1079253, name: 'Qwen/Qwen-Image-2.1', steps: 40 },
};

function headers() {
  const h = { 'Content-Type': 'application/json', Origin: BASE, Referer: `${BASE}/aigc/image-generation?tab=advanced` };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  else if (COOKIE) h.Cookie = COOKIE;
  return h;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok || json.Success === false) {
    throw new Error(`接口失败 ${res.status} ${path}: ${json.Message || json?.Data?.message || text.slice(0, 200)}`);
  }
  const d = json.Data ?? json;
  // 魔搭多数接口有两层信封：{Data:{code,data,message}} —— 拆掉内层
  if (d && typeof d === 'object' && 'code' in d && 'data' in d) {
    if (d.success === false) throw new Error(`业务失败 ${path}: ${d.message || ''} (code=${d.code})`);
    return d.data;
  }
  if (d && d.success === false) throw new Error(`业务失败 ${path}: ${d.message || ''} (code=${d.code})`);
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 业务
function resolveModel(key) {
  const k = String(key || 'qwen-image-2.1-turbo').toLowerCase();
  const m = MODELS[k];
  if (!m) throw new Error(`未知模型 ${key}，可选：${Object.keys(MODELS).join(', ')}`);
  return m;
}

function parseSize(size) {
  const s = String(size || '1472*1104');
  const mt = s.match(/^(\d{3,5})\s*[*x×]\s*(\d{3,5})$/);
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
  if (!taskId) throw new Error('提交成功但没拿到 taskId: ' + JSON.stringify(sub).slice(0, 200));

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
        images: imgs.map((i) => ({
          url: i.imageUrl, width: i.width, height: i.height,
          imageId: i.imageId, seed: i.seed ?? i.generationMetadata?.parameters?.seed,
        })),
      };
    }
    if (s && s !== 'PROCESSING' && s !== 'PENDING') {
      throw new Error(`任务失败 ${s}: ${st.errorMsg || ''}`);
    }
  }
  throw new Error(`等待超时（最后状态：${last}）`);
}

async function publishToGallery({ image_url, title, labels = [] }) {
  if (!image_url) throw new Error('image_url 不能为空');
  // 1) 登记图片（拿到 imageId）
  const upd = await api('/api/v1/muse/image/updateImageGenerateInfo', {
    method: 'POST',
    body: [{ imageId: 0, imageUrl: image_url }],
  });
  let imageId = Array.isArray(upd) ? upd[0] : (upd?.imageId ?? upd?.data?.[0]);
  // 若登记接口不返回 id，退回从生图历史里按 URL 找
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
  // 只回必要字段，避免把邮箱等个人信息带进模型上下文
  return { user: info?.Name || info?.name || '', turboCostPerImage: est, models: Object.keys(MODELS) };
}

// ---------------------------------------------------------------- MCP 协议
const TOOLS = [
  {
    name: 'generate_image',
    description: '在魔搭 AIGC 专业生图（Qwen-Image）上按提示词生成图片，自动轮询直到出图，返回图片直链。默认使用 Turbo 模型（约 25 秒）。',
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
    description: '把已经生成的图片发布到魔搭创意广场，返回作品 ID 与分享链接。',
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
    description: '查询当前登录用户信息、魔粒余额与 Turbo 单次生图消耗。',
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

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  const { id, method, params } = msg;

  // 通知类不回复
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'modelscope-aigc', version: '0.1.0' },
        },
      });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const out = await callTool(name, params?.arguments || {});
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] },
      });
      return;
    }
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    send({
      jsonrpc: '2.0', id,
      result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] },
    });
  }
});

if (!TOKEN && !COOKIE) {
  console.error('[modelscope-aigc-mcp] 警告：未设置 MODELSCOPE_API_TOKEN 或 MODELSCOPE_COOKIE，接口会 401');
}
