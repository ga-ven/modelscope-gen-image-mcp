# modelscope-gen-image-mcp

魔搭（ModelScope）**生图 + 发布到创意广场** 的 MCP 服务器。

直接调 ModelScope 的 Web API，**不需要浏览器、不需要 Selenium/Playwright**，
所以既能挂进任何 MCP 客户端，也能部署到魔搭的 [MCP 部署服务](https://modelscope.cn/my/mcpDeploy) 上长期使用。

零第三方依赖，Node >= 22。

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

## 认证（二选一）

- `MODELSCOPE_API_TOKEN` —— 个人访问令牌，**云端部署用这个**。
  获取：`https://modelscope.cn` → 头像 → 账号设置 → 访问令牌 → 新建。
- `MODELSCOPE_COOKIE` —— 浏览器 cookie 原始串，仅适合本机临时调试（会过期）。

可选 `MODELSCOPE_BASE`，默认 `https://modelscope.cn`。

## 本地挂载

```json
{
  "mcpServers": {
    "modelscope-aigc": {
      "command": "npx",
      "args": ["-y", "github:ga-ven/modelscope-gen-image-mcp"],
      "env": { "MODELSCOPE_API_TOKEN": "<你的令牌>" }
    }
  }
}
```

WorkBuddy 写到 `~/.workbuddy/mcp.json`，然后在连接器管理页右上角「自定义连接器」里
对新服务器点一次「信任」才会生效（MCP 不会热加载）。

## 部署到魔搭 MCP 部署服务

1. 打开 <https://modelscope.cn/my/mcpDeploy?page=1> → 新建部署
2. 步骤 1 选 **自定义MCP**，安装命令选 `npx`，服务配置粘贴：

```json
{
  "mcpServers": {
    "modelscope-aigc": {
      "command": "npx",
      "args": ["-y", "github:ga-ven/modelscope-gen-image-mcp"],
      "env": { "MODELSCOPE_API_TOKEN": "<你的令牌>" }
    }
  }
}
```

3. 下一步 → 配置部署资源（有「免费部署资源」与「个人账号授权资源」两类）→ 提交

⚠️ 首次部署需要确认两点：

- 云端容器能否出网访问 `modelscope.cn` 的 `/api/v1/muse/**`（本地已验证可用）；
- 这些 Web 接口是否接受 `Authorization: Bearer` 令牌。它们历史上靠 Cookie：
  若只认 Cookie，优先试「个人账号授权资源」，否则用 `MODELSCOPE_COOKIE` 兜底（会过期）。

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

- 响应是**两层信封** `{Code, Data:{code, data, message}}`，真实内容在 `Data.data`（`server.mjs` 已统一拆解）。
- 页面把 `window.fetch` 打了补丁（页内调试会 `Failed to fetch`），浏览器里请用 `XMLHttpRequest`；Node 侧不受影响。

## 本地自测

```bash
MODELSCOPE_API_TOKEN=xxx node server.mjs
# 然后按 MCP 协议喂 JSON-RPC（换行分隔），例如：
# {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}
# {"jsonrpc":"2.0","id":2,"method":"tools/list"}
# {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_quota","arguments":{}}}
```

## License

MIT
