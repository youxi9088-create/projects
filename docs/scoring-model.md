# Agent 与 Skill 评分模型 v1

## 结论与边界

目前没有跨平台、跨领域、被普遍接受的单一「Agent Skill 分数」标准。因此本平台不把某个模型、某段提示词或一次任务结果直接换算为能力排名；评分必须同时保留任务质量、生产运行和发布治理证据。

该模型参考三个公开权威方向：

1. [OpenAI Graders](https://platform.openai.com/docs/api-reference/graders?api-mode=chat)：将确定性检查、文本相似度等 grader 作为任务级评测组件，而不是通用模型人格分。
2. [AgentBench, ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/e9df36b21ff4ee211a8b71ee8b7e9f57-Abstract-Conference.html)：在多个交互环境评测 Agent 的推理、决策和指令遵循，而不是只使用一个任务成功率。
3. [NIST AI RMF Measure](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)：要求在部署前和运行中持续、可复现、可记录地测试、评估、验证与确认（TEVV），并保留不确定性与适用边界。

## Agent 健康度

Agent 的综合评分只使用当前观察窗口（默认 24 小时）的证据。无证据的维度不按 100 分处理，而是降低「可信度」。

| 维度 | 权重 | 公式/证据 | 当前可采集来源 |
| --- | ---: | --- | --- |
| 任务成功率 | 40% | `completed / (completed + failed)`；取消不计为失败 | Task Run 状态与错误 |
| 运行时效 | 20% | 有活动 Task 时，是否发生心跳超时 | `last_heartbeat_at`、Task 状态 |
| 负责生产单推进 | 25% | 直接负责的生产单中，非停滞/阻塞的比例 | Issue 指派、状态、最后推进时间 |
| 绑定 Skill 发布就绪 | 15% | 已发布绑定 Skill / 全部绑定 Skill | Agent 绑定、Skill 发布快照 |

运行事件仍具有优先级：即便综合分较高，当前窗口发生关键失败、超时或阻塞时，健康状态仍为红色。

## Skill 运行健康评分

| 维度 | 权重 | 含义 |
| --- | ---: | --- |
| 发布就绪 | 15% | 是否已有已发布版本，可被生产运行时加载 |
| 绑定覆盖 | 5% | 是否至少已绑定至一个 Agent；这不是调用量 |
| 运行可靠性 | 40% | 由可观测调用中的成功率计算；至少 5 次调用才达到该维度满可信度 |
| 回归质量 | 40% | 固定评测集的通过率；若有关键失败，分数上限为 50 |

综合分只在「有证据的维度」之间加权。另显示 0–100 的证据可信度：发布/绑定信息提供 20%，最多 5 次可观测调用提供 40%，固定回归评测提供 40%。可信度低于 40% 时，评级固定显示为「证据不足」，不允许将配置评分误读为 Skill 质量。

## 接入固定回归评测

将已审阅的任务化评测结果写入 `config/skill-evals.json`（该文件默认不纳入版本控制，避免混入未审阅结果）。格式见 `config/skill-evals.example.json`：

```json
[
  {
    "skillId": "Multica Skill UUID",
    "suite": "asset-contract-regression-v1",
    "executedAt": "2026-08-10T08:00:00Z",
    "passed": 18,
    "total": 20,
    "criticalFailures": 0,
    "graderAgreement": 0.95,
    "evidenceUrl": "file:///.../evaluation-result.json"
  }
]
```

评测集应覆盖真实生产高风险路径：触发正确性、输入/输出契约、失败回退、外部工具调用、关键产物验证和回归案例。每次 Skill 发布前后对同一评测集执行，才能比较版本变化。

## 不应做的事

- 不因 Skill 被绑定就认定其可用或被调用。
- 不因日志没有出现 Skill 名称就认定未调用。
- 不用单次任务成功或 LLM 自评代替固定回归评测。
- 不将低样本分数用于 Agent/Skill 排名、自动淘汰或自动改写配置。
