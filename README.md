# RPG2 生产线健康度检测台

当前线上地址：<https://f.new.ndhy.com/a/rpg2-health-monitor/>。`public/` 是前端，`api/` 是 FN 云端接口，`src/` 包含采集、指标规则和本机服务端；`scripts/`、`test/`、`config/` 分别提供构建迁移脚本、测试和配置示例。

线上数据保存在 FN 云端，采集流程由 `/api/collect` 分段推进。历史证据和趋势记录按近 7 天清理，当前页面投影和实时采集所需数据保留。生产环境凭据通过 FN 环境变量配置；仓库不包含 `.env.production`、数据库、采集原始记录或浏览器缓存。

## 云端工程

在已安装并登录 FN CLI、已配置 Multica 生产环境变量的环境中：

```powershell
npm ci
npm test
npm run build
fn deploy
```

服务端接口位于 `api/`，前端构建脚本会把 `public/` 复制到 `dist/`。运行时还需要 `MULTICA_SERVER_URL`、`MULTICA_WORKSPACE_ID`、`MULTICA_TOKEN`。这些值只配置在部署环境，不提交到 GitHub。云端运行环境还需提供兼容的 Linux Multica CLI：可在部署前放入 `vendor/multica`，或用 `MULTICA_CLI_PATH` 指向已安装的可执行文件；该外部二进制不纳入源码仓库。

## 本机模式（旧版）

面向 Multica `RPG教育游戏2` 工作区的本机只读健康看板。它采集工作区配置、Issue、Task Run 和部分运行消息，计算生产线、Agent、Skill 和基础服务健康度，并保留可下钻的原始证据。

## 当前能力

- 只读调用 `multica` CLI；不会修改 Agent、Skill、Issue、Squad 或生产任务。
- 定时采集工作区、Agent、Skill、Issue 和近期 Task Run。
- 区分生产阻塞、执行异常、推进偏慢、审核中队列、未发布 Skill 和 Multica CLI 可用性。
- 对每条 `blocked` 生产单优先采集最近 Agent Run 与运行消息；详情展示状态、执行链、日志摘录和恢复建议，而不是只展示报错。
- Agent 健康度附带简短异常说明、评分维度和可下钻的原因证据。
- Skill 调用量采用“日志可观测口径”：只统计能在 Run 摘要/结果/运行消息中识别到的调用，页面会显示此限制。
- SQLite 保存历史快照和采集原始引用，前端可直接下钻到 Issue 与 Task。

## 启动

前提：本机已安装并登录 `multica` CLI，且终端可执行 `multica workspace get --output json`。

```powershell
cd <工程目录>
npm test
npm start
```

打开 <http://127.0.0.1:8787>。

默认每 60 秒采集一次。可在页面点击“立即采集”，或单独运行：

```powershell
npm run collect
```

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `8787` | 本机监听端口 |
| `COLLECTION_INTERVAL_SECONDS` | `60` | 采集间隔 |
| `ACTIVE_ISSUE_LIMIT` | `40` | 每轮读取 Run 的非阻塞近期/活跃 Issue 基础上限；所有 `blocked` Issue 会优先纳入 |
| `RUN_MESSAGE_LIMIT` | `12` | 近期 Run 的消息采集上限；每个 `blocked` Issue 的最近 Run 会额外优先采集 |
| `STALL_WARNING_HOURS` | `24` | 无有效推进黄灯阈值；阶段 SLA 定标前采用保守默认值 |
| `STALL_CRITICAL_HOURS` | `72` | 无有效推进红灯阈值；阶段 SLA 定标前采用保守默认值 |
| `INCIDENT_LOOKBACK_HOURS` | `24` | 失败/重试作为当前事件保留的观察窗口 |

## 数据与判定边界

- 运行消息、外部供应商回执和 Stage 日志并不保证全量可得，因此“未观测到 Skill 调用”不代表 Skill 未被使用。
- 只有 `blocked` 进入“重要风险”；`in_review` 进入独立审核队列，不会因停留时间被判定为阻塞或无推进。
- `blocked` 是生产状态，不自动等同于技术故障；事件详情会保留对应 Agent 的最近 Task 状态、心跳、运行消息摘录和恢复建议。
- 基础服务首版只主动验证本机 `multica` CLI 的实际只读请求是否成功。外部模型、AI Gateway、存储等服务需在后续版本登记健康探针后才会显示真实状态。

评分口径、固定回归评测接入方式及参考依据见 [评分模型](docs/scoring-model.md)。

## 目录

```text
src/       后端、采集器、SQLite 和规则引擎
public/    前端静态看板
test/      规则单元测试
data/      本机 SQLite 数据库（运行时生成，不纳入版本控制）
```
