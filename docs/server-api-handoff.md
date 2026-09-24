# 寻物故事馆：服务端 API 交接包

本文用于将现有游戏 API 交给公司服务端仓库和部署团队。目标是先稳定承接**文本大模型、关卡、草稿、事件**；素材生产属于独立的异步 Provider 能力，必须在前置依赖齐备后再启用。

## 1. 交接结论与边界

| 能力 | 当前实现 | 公司服务器上线前置 | 验收口径 |
| --- | --- | --- | --- |
| 固定五关与普通关卡读取 | 前端静态资源 + API 健康检查 | Node 服务、反向代理 | 游戏可从首页进入并完成一关 |
| 即时关卡 | `POST /api/generate-level`，支持 mock/OpenAI | AI 网关可达时可用真实模式 | 返回 `meta.provider=openai` 且 `fallbackUsed=false` |
| 一句话创作文本节点 | `POST /api/commission/stage`，真实调用 AI 网关 | 服务端密钥、出网白名单 | 六个文本节点均返回模型 JSON |
| 草稿与任务记录 | 本地 JSON 文件 | 单实例 + 持久卷 | 重启后草稿和任务仍可读取 |
| 图片/视频资产生产 | AIHub 异步任务、下载、落盘 | 见第 8 节，不能只部署 Node | 任务号、输出文件、预览 URL 与运行时读取均成立 |

当前没有账号、租户隔离、数据库、支付或限流。将其直接暴露给公网前，必须由公司网关增加鉴权、限流和审计；否则任何访客都能创建草稿、调用模型和读取草稿列表。

## 2. 代码交接范围

请将以下内容作为一个 pnpm workspace 一起提交；`apps/api` 不能脱离两个 workspace 包单独构建。

```text
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
apps/api/
packages/contracts/
packages/level-engine/
```

如需一并部署前端，再加 `apps/web/`。不要提交 `node_modules/`、`.env`、`apps/api/data/`、`dist/` 或任何真实 Token。

运行时工作目录必须是 `apps/api`，因为数据、资源脚本和默认相对路径均以此为基准。

## 3. 运行与持久化

推荐 Node.js 22 LTS、pnpm 10；服务启动命令：

```bash
pnpm install --frozen-lockfile
pnpm --filter @hog/api build
cd apps/api
node dist/server.js
```

API 默认监听 `127.0.0.1:3001`。由公司 Nginx、Ingress 或 API Gateway 对外代理 `/api/*` 和 `/health`，而不是直接暴露 3001。

服务当前使用 JSON 持久化，配置 `API_DATA_DIR` 到持久卷后会维护：

```text
generated-levels.json       # 即时关卡记录
commission-drafts.json      # 创作草稿
aihub-asset-tasks.json      # 素材异步任务及结果
```

这套 JSON 读写仅适合**单 API 实例**。若公司环境需要多副本、滚动扩容或容灾，服务端同学应先迁移到共享数据库/对象存储，并为写入加事务或乐观锁；不能直接扩为多副本。

## 4. 环境变量与密钥边界

服务端模板见 [apps/api/.env.server.example](../apps/api/.env.server.example)。真实变量应存于公司密钥管理、Kubernetes Secret 或 systemd `EnvironmentFile`，权限建议为仅运行账户可读。

最小文本大模型配置：

```ini
AI_GATEWAY_BASE_URL=https://ai-gateway.aiae.ndhy.com/v1
AI_GATEWAY_API_KEY=<仅服务端保存>
AI_GATEWAY_MODEL=gpt-5.5-2026-04-24
```

公司服务器须有到 AI 网关的 HTTPS 出网权限。此前腾讯 Lighthouse 从 `122.51.235.201` 调用该网关时被 WAF 拦截；这说明密钥、模型和请求格式不等于网络已获准。部署前请按公司服务器的实际 NAT/EIP 向网关安全侧申请放行：

```text
目标：ai-gateway.aiae.ndhy.com:443
方法：POST /v1/chat/completions
模型：gpt-5.5-2026-04-24
来源：公司服务器实际出网 IP 或已批准的网段
```

生产必须填写 `CORS_ORIGINS=https://实际前端域名`；未填写时，现有开发兼容行为会允许任意 Origin。`WEB_ORIGIN` 用于部署记录，`CORS_ORIGINS` 才是 API 的浏览器访问边界。

## 5. API 总览

所有接口均返回 JSON，输入由 Zod 校验；格式不合法返回 400。以下路径省略统一域名与 `/api` 前缀。

| 方法 | 路径 | 用途 | Provider/持久化 |
| --- | --- | --- |
| GET | `/health` | 进程存活与已生成关卡数 | 无 |
| GET | `/generations` | 即时关卡记录列表 | `generated-levels.json` |
| POST | `/generate-level` | 由一句话生成可玩关卡 | mock 或 AI 网关 |
| GET | `/levels/:id` | 按 ID 读取即时关卡 | `generated-levels.json` |
| GET | `/commission/drafts` | 创作草稿列表 | `commission-drafts.json` |
| PUT | `/commission/drafts/:id` | 新建或覆盖一个草稿 | `commission-drafts.json` |
| DELETE | `/commission/drafts/:id` | 删除草稿 | `commission-drafts.json` |
| POST | `/commission/stage` | 执行一个文本创作节点 | AI 网关 |
| POST | `/commission/assets/scene` | 提交单场景图片任务（历史兼容） | AIHub |
| POST | `/commission/assets/scenes` | 提交多场景图片任务（历史兼容） | AIHub |
| POST | `/commission/assets/batch` | 提交图片/视频资产任务 | AIHub 或视频网关 |
| GET | `/commission/assets/tasks` | 查询、刷新资产任务；支持 `commissionId`、`latest=true` | AIHub/视频网关 + JSON |
| GET | `/commission/assets/:runId` | 查询单个 Provider 任务 | AIHub 或视频网关 |
| POST | `/events` | 接收埋点批次 | 当前仅进程内保存 |

### 5.1 `POST /api/generate-level`

```json
{
  "prompt": "雾港的海盗船长舱，寻找航海线索",
  "seed": "optional-repeatable-seed",
  "mode": "openai"
}
```

`prompt` 长度为 1–500，`seed` 最长 80，`mode` 为 `mock` 或 `openai`。未传 `mode` 时由 `GENERATOR_MODE` 决定。响应内 `meta.provider` 与 `meta.fallbackUsed` 必须被前端或服务端日志保留：请求 `openai` 但模型调用失败时，当前兼容逻辑会回退到 mock，并以 `fallbackUsed=true` 明示；这不能作为“真实模型生成成功”的验收证据。

### 5.2 `POST /api/commission/stage`：核心文本大模型接口

`stage` 只允许：`understanding`、`outline`、`gameplay`、`narrative`、`resources`、`code`。

```json
{
  "stage": "understanding",
  "draft": {
    "templateId": "fairy-adventure",
    "templateProfile": {
      "id": "fairy-adventure",
      "name": "童话冒险",
      "playerRole": "小小探险家",
      "narrativeEngine": "寻找失落的魔法碎片",
      "storyGoal": "让森林恢复光亮",
      "objectSemantics": "魔法物件与自然线索",
      "gameplayHook": "每件物品开启下一段旅程",
      "hintTone": "温暖童话口吻",
      "endingPattern": "带着伙伴回到森林"
    },
    "theme": "童话冒险",
    "prompt": "在月光森林寻找迷路小鹿留下的星光铃铛",
    "length": 1,
    "objectCount": 6,
    "difficulty": "标准",
    "style": "柔和绘本",
    "uploads": []
  },
  "priorOutputs": {}
}
```

`length` 只允许 1、3、5；`objectCount` 只允许 6、8、10、12；`difficulty` 为 `轻松`、`标准`、`隐蔽`。后续节点通过 `priorOutputs` 传入前序原始输出。成功响应包含 `stage`、`model`、`output` 和 `rawText`。

模型错误约定：未配置返回 503；令牌无效返回 401；超时返回 504；网关 WAF 拦截返回 503 并提示申请出网放行；其他 Provider 失败返回 502。不要将 502 重试为 mock 后对用户声称已生成。

### 5.3 草稿、资产和事件

- 草稿 `PUT` 的 path `:id` 必须等于 body 的 UUID `id`；完整 payload 必须符合前端 `CreatorFlow` 的保存结构。
- 资产批量任务最多 80 个，任务及 `commissionId` 均为 UUID；同一 `commissionId + assetKey + provider` 会复用进行中或成功任务，最多一次自动重试。
- `POST /events` 一次最多 100 条，事件名为 `level_start`、`item_found`、`wrong_click`、`hint_used`、`level_complete`。它目前没有持久化，若要用于分析，请在公司侧接入消息队列、日志或埋点平台。

## 6. 静态资产与反向代理

已完成的 AIHub 资产由 API 写入 `GENERATED_ASSET_DIR`，并将 URL 返回为：

```text
${GENERATED_ASSET_PUBLIC_BASE}/{commissionId}/{assetFile}
```

例如配置为 `/srv/hidden-object-api/generated-assets` 和 `/content/commissions` 时，Nginx 可使用：

```nginx
location /content/commissions/ {
    alias /srv/hidden-object-api/generated-assets/;
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /api/ {
    proxy_pass http://127.0.0.1:3001;
}
```

若公司已有对象存储/CDN，建议在服务端同学完成存储适配后让 `GENERATED_ASSET_PUBLIC_BASE` 指向 CDN 前缀；不要把运行时写入落到前端构建目录后假定 Vite 会自动发布。

## 7. 部署前检查与验收

### 服务端功能验收

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
curl -fsS http://127.0.0.1:3001/health
```

文本模型必须额外进行一次真实调用：从公司服务器或同一出网网段调用 `POST /api/commission/stage`，确认 HTTP 200、响应 `model` 为预期模型、`rawText` 非空、`output` 可解析。仅 `/health` 为 200、仅构建通过或仅本地电脑模型能调通，均不能证明公司服务器的大模型已经部署成功。

### 前后端路径验收

1. 用目标前端域名加载游戏首页；
2. 进入“新建冒险”，提交一句话；
3. 依次走过至少 `understanding → outline → gameplay → narrative`；
4. 刷新页面，确认草稿仍存在；
5. 生成资产时确认任务号、下载后的 URL 和静态代理 URL 都可访问；
6. 将生成内容应用进游戏后，实际游玩一条从进入到完成的路径。

## 8. 素材生产的独立前置

文本大模型不依赖 AIHub。若本轮只上线“一句话生成剧情/规则/资源清单”，不要启用资产提交接口即可。

若要启用图片/视频生产，当前实现还需要：

1. `AIHUB_AGENT_TOKEN`；
2. 可访问 `https://bv.new.ndhy.com/api/agent/aihub` 的出网权限；
3. PowerShell 7（`pwsh`）；
4. `AIHUB_ASSET_SKILL_DIR` 指向包含 AIHub appId 注册表与启动脚本依赖的受控目录；
5. `GENERATED_ASSET_DIR` 的写权限，以及第 6 节中配置的静态资源映射。

因此，素材生产当前状态应报告为“已实现待公司环境验证”，不能因文本节点已调通就报告为完整生成流水线已上线。

## 9. 交接给服务端同学的任务清单

1. 将第 2 节 workspace 提交到服务端 Git；
2. 将 `.env.server.example` 映射为公司 Secret/环境变量，不提交真实密钥；
3. 配置单实例、`API_DATA_DIR` 持久卷、`GENERATED_ASSET_DIR` 持久卷和反向代理；
4. 将公司服务器实际出网 IP/网段加入 AI 网关白名单；
5. 在网关层加鉴权、限流、请求体大小限制和审计；
6. 用第 7 节完成真实模型、草稿恢复、静态资产和玩家路径验收；
7. 多副本前迁移 JSON 持久化和本地资产到共享服务。
