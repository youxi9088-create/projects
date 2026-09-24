function compact(value, limit = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Darwin Phase 0.5: create editable test-prompt drafts from the current
 * Skill. They are deliberately not a score, a judgement, or a review result.
 * The operator must confirm them before an independent judge may use them.
 */
export function buildDarwinReviewPlan(skill) {
  const name = String(skill.name ?? '未命名 Skill');
  const purpose = compact(skill.description || skill.content?.match(/^description:\s*(.+)$/mi)?.[1] || '完成该 Skill 声明的核心任务');
  return {
    schema: 'darwin-skill-review-plan/v1',
    kind: 'test_prompt_design',
    skillId: skill.id,
    skillName: name,
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt: skill.updated_at ?? null,
    status: 'draft',
    prompts: [
      {
        id: 'happy-path',
        label: '典型场景',
        prompt: `请使用「${name}」完成一个最典型的任务。Skill 声明的能力是：${purpose}。请给出可直接被下游使用的完整结果。`,
        expected: '完整覆盖 Skill 的核心目标；输出结构与交付物可被下游直接使用。'
      },
      {
        id: 'ambiguous-input',
        label: '信息不完整场景',
        prompt: `请使用「${name}」处理以下任务，但关键输入不完整或存在歧义：${purpose}。请明确说明需要补充什么、能否降级处理，以及在何处停止等待确认。`,
        expected: '识别缺失信息；不编造关键事实；给出明确的补充、降级或停止路径。'
      },
      {
        id: 'handoff',
        label: '协作交接场景',
        prompt: `请使用「${name}」完成任务并交给下游协作者。任务目标：${purpose}。请输出下游可验证的交接内容、输入输出边界和验收条件。`,
        expected: '明确输入、输出、边界、责任和验收；不存在无法消费的模糊交接。'
      }
    ]
  };
}

export function confirmDarwinReviewPlan(plan, prompts) {
  const nextPrompts = Array.isArray(prompts) ? prompts.map((prompt, index) => ({
    id: String(prompt.id ?? `prompt-${index + 1}`),
    label: compact(prompt.label || `测试场景 ${index + 1}`, 60),
    prompt: String(prompt.prompt ?? '').trim(),
    expected: String(prompt.expected ?? '').trim()
  })) : [];
  if (nextPrompts.length < 2 || nextPrompts.some((prompt) => !prompt.prompt || !prompt.expected)) {
    throw new Error('每个 Skill 至少确认 2 个测试 Prompt，且必须填写 Prompt 与预期结果。');
  }
  return { ...plan, status: 'confirmed', prompts: nextPrompts, confirmedAt: new Date().toISOString() };
}
