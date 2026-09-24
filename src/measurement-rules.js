export const REWORK_POLICY = Object.freeze({
  version: '2.1.0',
  threshold: 3,
  lookbackDays: 7,
  eligibleObjectPatterns: ['web_s*', 'img_*', 'vid_*', 'S##.#', 'records[n]'],
  excludedRunRoles: ['项目经理路由/验收', '协调派单/收口', '等待或 no-action', '纯下游消费'],
  evidenceSources: ['Issue', 'Run', 'Run 消息']
});

export const MEASUREMENT_RULES = Object.freeze({
  version: '2026.09.07-r17',
  title: '教育互动游戏生产线健康度检测台 · 度量规则',
  source: 'Multica 只读采集快照；范围限定为目标小队 ID=00c28d20-adae-4905-aede-d492c89a474d 直接指派的 Issue。',
  sections: [
    { id: 'scope', title: '数据范围与刷新', rules: [
      { name: '统计范围', definition: '只读取 assignee_id=00c28d20-adae-4905-aede-d492c89a474d 的直接指派 Issue；Agent 仅限目标小队当前成员与已记录的历史小队成员（用于保持成员轮换前后的历史 Run 连续性）；Skill 仅限这些 Agent 的显式 Skill 工具调用。小队名称仅供展示，不参与筛选。', source: 'Issue.assignee_id、Squad member 历史快照、Run、Run 消息', caveat: '未观测调用不等于未调用；历史成员白名单不包含工作区其他 Agent。' },
      { name: '刷新机制', definition: '服务启动时采集一次，随后按固定采集间隔刷新；前端在同一浏览会话复用最新快照，切换页面不触发采集。', source: '本地快照', caveat: '页面数据以最近一次成功采集为准。' }
    ] },
    { id: 'risk', title: '风险与健康指数', rules: [
      { name: '重要风险', definition: '仅 Issue 状态为 blocked 的生产单计为重要风险。审核中（in_review）独立展示，不计风险。', source: 'Issue.status', caveat: '失败 Run 本身不等于生产线 blocked。' },
      { name: '推进风险', definition: '非 blocked、非 in_review 的活跃 Issue，最近有效更新超过 24 小时触发。', source: 'Issue 更新时间与 Run 心跳', caveat: '等待人工决策需结合证据复核。' },
      { name: '执行风险', definition: '仅近 24 小时的 Run 触发：状态为 failed/error 的 Run；运行中 Run 的最后心跳超过 2 小时；或同一 Issue、同一 Agent、同一错误指纹在该窗口失败至少 3 次。', source: 'Run.status、error、heartbeat、Issue', caveat: '失败或超时只是执行信号；除非 Issue.status=blocked，否则不升级为生产阻塞。相同 Issue 的较低优先级执行信号会并入其更高优先级风险事件。' },
      { name: 'Skill 治理与对标', definition: '当前风险队列只在有显式调用证据的 Skill 同时存在草稿且没有已发布版本时产生“未发布 Skill”非阻塞事件；基础服务探针非 healthy 也进入该分类。Darwin 对标分、Runtime Gate 与架构评审仅展示在 Skill 页面，不直接生成风险事件。', source: '显式 Skill tool_use、Skill 发布状态、服务探针、Skill 正文审计、固定回归与独立架构评审', caveat: '没有显式调用证据的 Skill 不进入本看板；缺少架构评审或运行样本只标“待评审/证据不足”，不自动当作失败或风险。' },
      { name: '健康指数', definition: 'max(0, 100 − min(70, 重要风险数×8) − min(20, 非阻塞风险数×2))。', source: '当轮风险事件', caveat: '审核中与返工分析不直接扣健康分。' }
    ] },
    { id: 'line', title: '生产线跑通表现', rules: [
      { name: '生产 Issue 状态分布', definition: '仅统计直接指派给小队 ID=00c28d20-adae-4905-aede-d492c89a474d 的 Issue，按当前 Issue.status 分组展示；在本检测台中，这就是生产 Issue 范围。', source: 'Issue.assignee_type、Issue.assignee_id、Issue.status', caveat: '不读取工作区其他小队或个人 Issue；小队名称变更不影响范围。如未来将治理/复盘子任务直接指派给该小队，需新增可审计的子任务排除规则。blocked 数与概览页“生产阻塞”使用同一批 Issue。' },
      { name: '分母', definition: '全部 done Issue 与 cancelled Issue。原始 Run 已被清理时，如 Issue 有可审计的起止时间且存在目标小队成员执行记录，可用 Issue 生命周期补齐该生产线；其中服务取消后明确继续/恢复的记录补为一次生产中断。', source: 'Issue.status、Run、Issue.first_executed_at、Issue.updated_at、Issue usage、Issue 评论', caveat: '外部治理或复盘 Agent 的附加 Run 不会使直接指派给目标小队的生产线失去统计资格；仅“服务取消 + 明确恢复执行”的精确组合会从生命周期评论补为中断，不以泛化复盘文本或短间隔猜测失败。' },
      { name: '一次性跑通率', definition: '分母为全部 done Issue；分子必须同时满足：存在至少一条 completed 生产 Run，且生产节点从未出现 failed/cancelled/timeout、服务取消后继续或恢复执行、显式 blocked/门禁、明确升级给具名人工成员的决策或复验等待，也没有运行节点超过 4 小时无推进。', source: 'Issue.status、Run 直接回传、Run 消息', caveat: '仅生产节点计入。完成后的日志复盘、项目经理收口、路由、派单与 no-action 控制面动作不计为生产重试或阻断；done 但没有成功完成生产 Run 的 Issue 留在分母，不进入分子。' },
      { name: '被阻断生产线', definition: '终态生产线中至少发生一次中断的 Issue 数；中断包括 failed/cancelled/timeout、服务取消后恢复、显式 blocked/门禁、明确人工决策等待或节点超过 4 小时无推进。', source: 'Issue.status、Run 直接回传、Run 消息', caveat: '只读取生产节点；已取消 Issue 即使没有 Run 也保守计为一条被阻断生产线。' },
      { name: '平均生产线阻断次数', definition: '全部终态生产线中，生产节点 failed/cancelled/timeout、服务取消后恢复、显式 blocked/门禁、明确升级给具名人工成员的决策或复验等待、运行节点超过 4 小时无推进的总次数，除以全部终态生产线数。', source: 'Issue.status、Run 直接回传、Run 消息', caveat: '同一节点同时满足多种信号只计一次；完成后的复盘、项目经理收口、协调路由派单不计入。取消仍不参与平均生产时长。' },
      { name: '成功生产平均时长', definition: '仅统计 done Issue：每条取最后一条 completed 生产 Run 自身的 started_at 至 completed_at，再求平均。', source: 'Issue.status、Run 时间戳', caveat: '此前 failed/cancelled/timeout/retry 的耗时保留在阻断与一次性跑通判定中，不累加进最终成功 Run 的时长；取消、仍在运行或缺少最终成功 Run 完整起止时间的 Issue 不进入时长样本。完成后的复盘、项目经理收口和其他控制面 Run 不参与。' }
    ] },
    { id: 'rework', title: '返工分析', rules: [
      { name: '返工范围', definition: '在工作区中筛选近 7×24 小时内更新为 done 或 cancelled、标题包含“颗粒生产”的 Issue。', source: 'Issue.title、Issue.status、Issue.updated_at', caveat: '终态时间以 Issue.updated_at 作为可读取的完成/取消代理；该返工范围独立于概览、Agent、Skill 的目标小队范围。' },
      { name: '返工节点身份与门槛', definition: '同一入选 Issue 内，同一节点被激活或执行至少 3 次后，认定为多次返工。优先使用“生产阶段 + 具体产出标识”（如 Stage 08 · web_s032）；任务未提供产出标识时以阶段级节点识别。', source: 'Run 的任务委托、回传、状态与时间', caveat: '不同 Agent 在同一节点上的执行会合并；Agent 仅作为执行证据展示。' },
      { name: '排除规则', definition: '项目经理路由/验收、协调派单/收口、等待/no-action、纯下游消费 Run 不纳入返工。', source: 'Agent 角色与任务语义', caveat: '无法分类的 Run 保留在完整执行链，不进入返工指标。' },
      { name: '返工原因', definition: '直接 Task error 为“已确认”；门禁/质量校验、明确的审核退回或人工评审结论、交付物缺失、服务故障、版本修正为“运行线索”；无触发证据则标“证据不足”。', source: '当前 Run 的 error、任务回传与本 Run 文本消息', caveat: '不把读取历史 Issue 评论的工具输出、也不把孤立的 feedback 字样当作当前节点的返工原因；完整原文证据可在节点详情展开。' }
    ] },
    { id: 'capability', title: 'Agent 与 Skill', rules: [
      { name: 'Agent 健康度', definition: '按已观测维度加权平均；置信度为已有证据权重占比。置信度低于 40% 显示证据不足。', source: 'Run、Issue、风险事件', caveat: '评分与证据置信度分开。' },
      { name: 'Skill 目录与调用量', definition: 'Skill 目录纳入小队生产 Run 中的显式 Skill 工具调用，以及任务委托、回传或运行消息中可精确匹配已登记 Skill 名称的隐性生产链路证据。调用量只统计显式工具调用。', source: 'Run 消息 tool_use、生产 Run 任务委托/回传/运行消息', caveat: '隐性证据只补全目录，不计为调用次数、不计算调用成功率；普通模糊提及不纳入。' },
      { name: 'Skill 评分', definition: '全部生产线关联 Skill 都进入 Darwin 与生产实测评估。实测范围为小队直接指派、近 7 天、标题包含【颗粒生产】的 Issue；计入小队 Agent 的显式 Skill 工具调用，终态与非终态 Run 均作为实测覆盖。整体架构维度仅在存在按 Skill ID 匹配的独立架构评审文档时计入。', source: 'Skill 正文、发布快照、显式调用 Run、E:\\Multica\\skill-architecture-reviews-2026-08-12', caveat: '未观测到本轮显式调用不代表未使用，也不按 0 分或失败处理；非终态 Run 不按成功或失败推断，结果成功率只以终态 Run 计算。缺少匹配文档则整体架构待独立评审。' }
    ] },
    { id: 'trend', title: '趋势与证据', rules: [
      { name: '健康趋势', definition: '每轮采集将健康指数、生产阻塞、非阻塞风险、重要风险和活跃 Issue 单独写入轻量趋势指标表。趋势只提供近 24 小时与近 7 天；页面读取趋势指标，不读取或解析全量健康快照。', source: 'health_trend_points 轻量趋势指标表', caveat: '趋势反映采集时点，不回填过去未采集数据；完整快照只保留最新一份供当前页面读取。' },
      { name: '证据优先级', definition: '结论优先引用 Issue、Run、Run 消息；正则信号只是线索，不能替代原始证据。', source: '原始采集记录', caveat: '缺少证据时必须明确说明，而不是推断根因。' }
    ] }
  ]
});

export function measurementRulesPayload() {
  return MEASUREMENT_RULES;
}
