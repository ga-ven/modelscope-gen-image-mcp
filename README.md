# modelscope-gen-image-mcp

魔搭（ModelScope）**生图 + 发布到创意广场** 的 MCP 服务器。

直接调 ModelScope 的 Web 接口，**不需要浏览器自动化**（登录只用一次交互，之后读本地 Cookie 文件）。
天然跨工具：TRAE / Cursor / Claude Desktop / Cherry Studio / WorkBuddy 都能挂。

零第三方依赖，Node >= 22。

## 三步上手（每台机器一次）

```bash
# 1) 登录（会弹一个 Chrome 窗口，扫码/短信登录，成功后自动保存 Cookie）
npx -y github:ga-ven/modelscope-gen-image-mcp login

# 2) 确认
npx -y github:ga-ven/modelscope-gen-image-mcp whoami
# → 已登录：你的用户名

# 3) 在客户端里配 mcpServers（见下）
```

Cookie 存在 `~/.modelscope-aigc/cookies.json`，换机器重新 `login` 一次即可。

## 客户端配置

**TRAE / Cursor / Claude Desktop / Cherry Studio**（JSON 形式都一样）：

```json
{
  "mcpServers": {
    "modelscope-aigc": {
      "command": "npx",
      "args": ["-y", "github:ga-ven/modelscope-gen-image-mcp"]
    }
  }
}
```

**WorkBuddy** 写 `~/.workbuddy/mcp.json`，然后在连接器管理页右上角「自定义连接器」里点一次「信任」。

想固定用某个本地 token 覆盖（CI 场景）：加 `"env": { "MODELSCOPE_COOKIE": "..." }`。

## 工具

| 工具 | 作用 | 关键入参 |
| --- | --- | --- |
| `generate_image` | 按提示词出图，自动轮询到出图，返回图片直链 | `prompt` / `negative_prompt` / `model` / `size` / `seed` |
| `publish_to_gallery` | 把图片发布到创意广场，返回作品 ID 与分享链接 | `image_url` / `title` / `labels` |
| `get_quota` | 查询用户、单次消耗、可用模型 | — |

模型：

| 键 | 版本 ID | 步数 | 消耗 | 出图时间 |
| --- | --- | --- | --- | --- |
| `qwen-image-2.1-turbo` | 1138360 | 8 | 1 魔粒 | 约 25 秒 |
| `qwen-image-2.1` | 1079253 | 40 | 2 魔粒 | 要排队，数分钟 |

尺寸：`1472*1104`（横向三视图）、`1104*1472`（纵向）、`1024*1024` 等任意合法宽高。

## 批量换装（示例脚本）

`examples/batch-three-view.mjs` 是「同一人物锚定提示词 + 只换服饰」的批处理，
适合一次出多套穿搭并逐套发布：

```bash
cp examples/prompts.example.json prompts.json     # 改 base / negative / variants
node examples/batch-three-view.mjs --config prompts.json --only 1,2
node examples/batch-three-view.mjs --config prompts.json --no-publish   # 只出图不发布
```

每条变体只需填 `outfit`（服饰）和 `title`（作品名），`base` 里用 `{OUTFIT}` 占位。
跑完在 `./out/` 拿到图片，并生成 `report.json` 记录每套的图片地址与分享链接。

提示词经验：

- 负向里**不要**放「真实毛孔 / 自然肤质 / 轻微胶片颗粒」，会和正向的"真实皮肤纹理"打架
- 三视图写死「同一人物、五官/发型/妆容/身材比例完全统一、光影统一」，
  负向加「服装串套、配饰缺失、细节特写窗口、局部放大框、左侧半身特写」
- 换装只改 `{OUTFIT}`，人物锚定段落一字不动，多套之间人物一致性才稳

## 认证说明（重要）

魔搭有两种凭据，**用途不同**：

| 凭据 | 能用在哪 | 能不能干这活 |
| --- | --- | --- |
| 访问令牌 `ms-...` | openapi / api-inference / 模型下载 | ❌ 网页内部接口（`/api/v1/muse/**`）返回 **401** |
| 浏览器登录态（Cookie） | 网页内部接口 | ✅ 生图、发布都靠它 |

所以本服务用 Cookie（通过 `login` 一次性获取并本地保存）。
访问令牌**不要**往这里配，配了也是 401。

## 接口链

```
POST /api/v1/muse/predict/task/submit                      → {taskId}
GET  /api/v1/muse/predict/task/status?taskId=xxx            → predictResult.images[]（imageUrl / imageId）
POST /api/v1/muse/image/updateImageGenerateInfo             → 登记 imageId
POST /api/v1/aigc/picture/upload                            → {id}，分享页 /aigc/gallery/share/<id>
     body: {"Title":"...","MuseImages":[{"MuseImageID":28224647,"IsCoverImage":1}],"Labels":[]}
```

辅助接口：

- `POST /api/v1/muse/predict/getEstimateConsumeComputeQuota` 预估消耗
- `POST /api/v1/muse/predict/queryHistoryList` 生图历史
- `POST /api/v1/muse/image/getTags?imageUrl=...` 自动标签
- `PUT  /api/v1/dolphin/aigcPictures` 广场列表查询

两个坑：

- 响应是**两层信封** `{Code, Data:{code, data, message}}`，真实内容在 `Data.data`（已统一拆解）。
- 页面把 `window.fetch` 打了补丁（页内调试会 `Failed to fetch`），浏览器里请用 `XMLHttpRequest`；Node 侧不受影响。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `MODELSCOPE_COOKIE` | 直接给 Cookie 串，优先于本地文件 |
| `MODELSCOPE_BASE` | 默认 `https://modelscope.cn`，国际站填 `https://modelscope.ai` |
| `MMP_HOME` | Cookie 与 Chrome 配置目录，默认 `~/.modelscope-aigc` |
| `MMP_LOGIN_PORT` | login 时的调试端口，默认 9411 |
| `CHROME` / `CHROME_PATH` | 指定 Chrome 可执行文件 |

## 排错

- `未找到魔搭登录态` → 跑一次 `login`
- `登录态失效（401）` → Cookie 过期，重跑 `login`
- `login` 弹窗后 6 分钟没检测到 → 在窗口里登录完，再跑一次 `login`（复用同一 Chrome 配置目录）
- 生图报 `图片生成失败` → 检查网页上「图片编辑 / 图生图」开关是否被打开（会顶掉文生图）

## License

MIT
