import { afterEach, describe, expect, it } from 'vitest'
import { buildCommissionStageContext, createServer, type CommissionDraft, type CommissionStage } from './server'

describe('generation API', () => {
  const servers: Awaited<ReturnType<typeof createServer>>[] = []
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())) })

  it('generates a playable level in mock mode', async () => {
    const app = await createServer()
    servers.push(app)
    const response = await app.inject({ method: 'POST', url: '/api/generate-level', payload: { prompt: '雾港的海盗船长舱，找航海线索', seed: 'test-seed', mode: 'mock' } })
    expect(response.statusCode).toBe(200)
    expect(response.json().level.mission.targetIds).toHaveLength(8)
  })

  it('rejects an unsupported asset workflow before submitting to AIHub', async () => {
    const app = await createServer()
    servers.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/commission/assets/batch',
      payload: {
        commissionId: 'fc6580e1-a562-47f6-b293-1b4c3dedd708',
        tasks: [{
          taskId: '3b2357d1-3772-4edc-8f2b-586a43876c76',
          assetKey: 'story-ending-video',
          assetKind: 'ending-video',
          alias: 'unknown-video-provider',
          chapterIndex: 2,
          chapterTitle: '故事结局',
          label: 'invalid-provider-probe',
          prompt: '这是一个只验证请求结构、不会提交到外部平台的安全测试素材提示文本。',
        }],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('素材子任务请求无效')
  })

  it('keeps narrative template, user brief, visual style and scale in their intended stages', () => {
    const draft: CommissionDraft = {
      templateId: 'space-expedition',
      templateProfile: {
        id: 'space-expedition', name: '星际科考', playerRole: '深空科考队员', narrativeEngine: '恢复系统并完成探索任务',
        storyGoal: '带回新的发现', objectSemantics: '工具、模块、样本和数据芯片', gameplayHook: '前置系统为下一章提供条件',
        hintTone: '准确的任务日志口吻', endingPattern: '系统重启并返航',
      },
      theme: '星际科考', prompt: '寻找维修机器人弄丢的能源钥匙', length: 3, objectCount: 6, difficulty: '标准',
      style: '黏土微缩定格', visualDirection: '手工黏土模型与温暖柔光', uploads: [{ name: 'robot.png', purpose: '指定物件' }],
    }
    const priorOutputs = { understanding: '理解结果', outline: '故事大纲', gameplay: '玩法规则', narrative: '章节剧情', resources: '资源清单' }
    const nonVisualStages: CommissionStage[] = ['understanding', 'outline', 'gameplay', 'narrative', 'code']
    for (const stage of nonVisualStages) {
      const context = JSON.stringify(buildCommissionStageContext(stage, draft, priorOutputs))
      expect(context).toContain('星际科考')
      expect(context).toContain('能源钥匙')
      expect(context).not.toContain('黏土微缩定格')
      expect(context).not.toContain('手工黏土模型')
    }
    const resourceContext = JSON.stringify(buildCommissionStageContext('resources', draft, priorOutputs))
    expect(resourceContext).toContain('黏土微缩定格')
    expect(resourceContext).toContain('手工黏土模型')
    expect(resourceContext).toContain('robot.png')
  })
})
