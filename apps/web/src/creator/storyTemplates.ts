export type StoryTemplateId = 'detective-archive' | 'fairy-adventure' | 'oriental-folklore' | 'space-expedition' | 'cozy-life'

export interface StoryBeat {
  title: string
  summary: string
  objective: string
}

export interface StoryTemplate {
  id: StoryTemplateId
  title: string
  category: string
  description: string
  imageUrl: string
  recommendedStyle: string
  playerRole: string
  narrativeEngine: string
  storyGoal: string
  objectSemantics: string
  gameplayHook: string
  hintTone: string
  endingPattern: string
  inspirations: string[]
  single: StoryBeat
  chapters: StoryBeat[]
  ui: {
    mapIntro: string
    start: string
    enter: string
    complete: string
    replay: string
    notesTitle: string
  }
}

export const visualStyles = [
  { name: '水彩绘本', description: '纸张颗粒、柔和线条与明亮童话色彩', direction: '手绘水彩绘本，保留纸张颗粒与柔和墨线，色彩明亮、造型亲切、层次丰富。' },
  { name: '东方工笔重彩', description: '细线勾勒、矿物色与东方装饰构图', direction: '东方工笔重彩，以细线勾勒、矿物色、绢本肌理和含蓄留白表现，精致而克制。' },
  { name: '复古科幻概念绘', description: '几何舱体、丝网纹理与太空时代配色', direction: '复古科幻概念绘，清晰几何结构、丝网印刷颗粒、深空蓝与警示橙配色，空间层次明确。' },
  { name: '黏土微缩定格', description: '手工模型、柔软材质与温暖灯光', direction: '手工黏土微缩定格动画风，具有真实模型比例、毛毡与黏土触感、温暖柔光和可爱的微小瑕疵。' },
] as const

const detectiveArchiveTemplate: StoryTemplate = {
  id: 'detective-archive', title: '侦探档案', category: '推理解谜', description: '调查证物、还原时间线并揭开案件真相。', imageUrl: '/content/scenes/detective-office.jpg', recommendedStyle: '复古手绘',
  playerRole: '案件调查员', narrativeEngine: '通过证物、证词与时间线之间的矛盾逐步逼近真相', storyGoal: '确定事件经过与责任人', objectSemantics: '证物、口供、时间线线索与嫌疑人物留下的私人物品', gameplayHook: '比较证物并排除错误推断', hintTone: '冷静、克制，使用调查笔记式的方位与特征暗示', endingPattern: '证据链闭合，案件正式结案', inspirations: [],
  single: { title: '最后的线索', summary: '所有证据都指向同一个尚未解释的细节。', objective: '找齐关键证物，完成最后一次推理。' },
  chapters: [
    { title: '未署名的来信', summary: '一封来历不明的信开启调查。', objective: '确认来信与失踪者之间的关系。' },
    { title: '错误的时间', summary: '证物显示有人改动了事件发生的时间。', objective: '还原正确的行动顺序。' },
    { title: '沉默的证词', summary: '没有开口的人留下了最重要的线索。', objective: '找到能够印证证词的物品。' },
    { title: '被藏起的房间', summary: '调查进入此前未被记录的空间。', objective: '收集隐藏空间中的关键证据。' },
    { title: '真相归档', summary: '全部证据终于组成完整的案件经过。', objective: '补齐证据链并完成结案。' },
  ],
  ui: { mapIntro: '选择已解锁的章节继续调查。', start: '开始调查', enter: '进入现场', complete: '线索已收入调查笔记', replay: '重新调查', notesTitle: '这份委托留下的所有线索' },
}

export const customStoryTemplates: StoryTemplate[] = [
  {
    id: 'fairy-adventure', title: '童话冒险', category: '成长与修复', description: '帮助奇妙伙伴找回失物，让沉睡的魔法世界重新运转。', imageUrl: '/content/themes/fairy-adventure.webp', recommendedStyle: '水彩绘本',
    playerRole: '魔法世界的同行者', narrativeEngine: '认识伙伴、收集魔法信物、获得帮助并修复受损世界', storyGoal: '完成一次温暖的援助与成长旅程', objectSemantics: '魔法材料、伙伴失物、精灵信物与能够改变环境的小道具', gameplayHook: '每组物件对应一次环境恢复或伙伴能力', hintTone: '像精灵说谜语一样温柔，以颜色、声音和自然意象暗示', endingPattern: '伙伴重聚，环境复苏，并以庆典收束旅程',
    inspirations: ['帮怕黑的小龙找回会发光的鳞片', '寻找被风吹散的月亮乐谱', '替森林邮差找回没有送达的礼物'],
    single: { title: '月光礼物回家了', summary: '一件重要的魔法礼物散落在陌生角落，等待被重新找齐。', objective: '寻找散落的信物，让朋友与家园恢复原样。' },
    chapters: [
      { title: '会发芽的邀请', summary: '一封长出嫩芽的邀请把旅程带进魔法世界。', objective: '找齐启程需要的信物，认识等待帮助的伙伴。' },
      { title: '会唱歌的溪流', summary: '沉默的溪流需要遗失的音符才能重新流动。', objective: '找回藏在自然陈设中的声音碎片。' },
      { title: '倒着生长的城堡', summary: '世界规则发生变化，新的伙伴带来穿越障碍的办法。', objective: '收集能够修正方向的魔法小物。' },
      { title: '睡着的花园', summary: '最后的道路被一座沉睡花园遮住。', objective: '唤醒花园并打开通往终点的道路。' },
      { title: '月亮下的庆典', summary: '此前帮助过的伙伴带着信物重新聚在一起。', objective: '找齐庆典用品，完成世界修复。' },
    ],
    ui: { mapIntro: '选择已解锁的旅程，继续帮助这里的伙伴。', start: '开始冒险', enter: '走进故事', complete: '魔法信物已经归位', replay: '再次冒险', notesTitle: '旅途中认识的伙伴与信物' },
  },
  {
    id: 'oriental-folklore', title: '东方奇谭', category: '传说与和解', description: '循着节令、灯影和古老约定，修复人与灵之间的联系。', imageUrl: '/content/themes/oriental-folklore.webp', recommendedStyle: '东方工笔重彩',
    playerRole: '游历各地的掌灯人', narrativeEngine: '了解地方传说、寻找仪式信物、完成正确顺序并化解未尽执念', storyGoal: '恢复被遗忘的约定，让人与灵各自安心', objectSemantics: '节令器物、家族信物、灯具、香囊、乐器和带有方位意义的仪式道具', gameplayHook: '找到的物件按照传说、方位或节令组成仪式', hintTone: '含蓄而有诗意，使用灯影、风向、时辰与器物寓意暗示', endingPattern: '仪式完成，误解消散，传统与记忆得到传承',
    inspirations: ['在上元灯会替狐仙找回五盏旧灯', '寻找河神遗落在人间的节气信物', '帮纸鸢精灵完成一次没有送达的告别'],
    single: { title: '灯火照见归途', summary: '一个被遗忘的约定需要在今夜重新完成。', objective: '找齐仪式信物，让灯火指向正确的归途。' },
    chapters: [
      { title: '没有点亮的灯', summary: '灯市中有一盏灯始终没有亮起，它守着故事的开端。', objective: '寻找灯主留下的随身信物。' },
      { title: '风铃渡口', summary: '河风送来前往旧渡口的暗示。', objective: '按照水与风的线索补齐渡船仪式。' },
      { title: '纸鸢穿过长街', summary: '一只纸鸢把未说完的话带进人间街巷。', objective: '找出散落在店铺与屋檐间的记忆物件。' },
      { title: '被遗忘的旧祠', summary: '故事真正的约定藏在无人祭扫的旧祠中。', objective: '辨认器物寓意并恢复正确陈设。' },
      { title: '月桥重逢', summary: '人与灵终于能在月桥两端看见彼此。', objective: '完成最后的灯会仪式，让约定得以兑现。' },
    ],
    ui: { mapIntro: '循着灯火进入下一段传说。', start: '开始寻访', enter: '步入奇谭', complete: '仪式信物已经归位', replay: '再次寻访', notesTitle: '旅途中收录的传说与信物' },
  },
  {
    id: 'space-expedition', title: '星际科考', category: '任务与发现', description: '修复故障系统、回收实验样本，完成一次未知星域任务。', imageUrl: '/content/themes/space-expedition.webp', recommendedStyle: '复古科幻概念绘',
    playerRole: '深空科考队员', narrativeEngine: '接收任务、恢复系统、分析样本并在有限条件下完成探索目标', storyGoal: '让科考设施重新工作并带回新的发现', objectSemantics: '工具、能源模块、传感器、样本盒、数据芯片和具有系统功能的设备部件', gameplayHook: '物件具有功能依赖，前一章恢复的系统为下一章提供条件', hintTone: '像任务日志一样准确，使用舱段、读数、材质与设备功能暗示', endingPattern: '系统重新启动，发现被记录，航行进入下一坐标',
    inspirations: ['寻找机器人误放的空间站能源钥匙', '回收零重力温室里漂散的外星种子', '在冰封卫星基地找回失联队员的设备'],
    single: { title: '重新点亮信标', summary: '一座失联设施仍在发送微弱信号。', objective: '找回关键模块，恢复信标并上传科考记录。' },
    chapters: [
      { title: '来自静默轨道的信号', summary: '科考船收到一段不在任务表中的求救信号。', objective: '确认信号来源并准备登陆设备。' },
      { title: '零重力温室', summary: '温室系统停摆，实验样本正在舱内漂散。', objective: '回收样本并恢复环境控制。' },
      { title: '没有回应的实验舱', summary: '实验记录显示故障并非普通断电。', objective: '寻找诊断模块，重建最后一次实验过程。' },
      { title: '行星环观测台', summary: '观测台保存着改变任务判断的新数据。', objective: '校准设备并取回完整观测结果。' },
      { title: '重启星光引擎', summary: '全部发现必须在能源耗尽前送回科考船。', objective: '完成系统依赖链，启动引擎并返航。' },
    ],
    ui: { mapIntro: '选择可执行的任务舱段，继续科考。', start: '执行任务', enter: '进入舱段', complete: '科考样本已经归档', replay: '重新执行', notesTitle: '本次任务的科考记录' },
  },
  {
    id: 'cozy-life', title: '治愈日常', category: '陪伴与心愿', description: '从寻常小物中认识居民，为他们完成一件温暖的小事。', imageUrl: '/content/themes/cozy-life.webp', recommendedStyle: '黏土微缩定格',
    playerRole: '小镇里热心的新邻居', narrativeEngine: '接受居民心愿、寻找带有记忆的日常物品、准备礼物并促成一次温暖相聚', storyGoal: '解决生活中的小麻烦，让人物关系变得更亲近', objectSemantics: '食材、工具、旧照片、礼物材料、宠物玩具和承载个人记忆的生活用品', gameplayHook: '每组物件对应一个人物心愿或房间布置成果', hintTone: '像邻居聊天一样自然，使用习惯、用途和生活场景进行提示', endingPattern: '小愿望被完成，居民相聚，场景留下可见的布置成果',
    inspirations: ['替海边面包店准备一场秘密生日会', '帮搬家老人找回装满回忆的小物件', '寻找小猫为新邻居收集的欢迎礼物'],
    single: { title: '今天也亮着暖灯', summary: '一件普通的小事牵起了几个人的温暖回忆。', objective: '找齐准备惊喜需要的物品，完成今天的小心愿。' },
    chapters: [
      { title: '清晨的面包香', summary: '一张临时订单让安静的小店忙碌起来。', objective: '找齐开店与准备礼物需要的日常物品。' },
      { title: '推车上的包裹', summary: '几个没有写名字的包裹需要找到真正的主人。', objective: '根据生活习惯把物品与居民联系起来。' },
      { title: '阁楼缝纫间', summary: '一件准备多年的礼物还差最后几样材料。', objective: '在旧物中找出有用材料并补完礼物。' },
      { title: '雨中的海边车站', summary: '突来的雨打乱了相聚计划。', objective: '找齐雨具与布置用品，重新安排见面地点。' },
      { title: '暖灯下的聚会', summary: '此前帮助过的居民带着各自的故事来到店里。', objective: '完成最后布置，让所有小心愿得到回应。' },
    ],
    ui: { mapIntro: '选择下一件小事，继续认识这里的居民。', start: '开始帮忙', enter: '走进日常', complete: '心愿物品已经备齐', replay: '再找一次', notesTitle: '小镇居民留下的故事' },
  },
]

export const defaultStoryTemplate = customStoryTemplates[0]

export function storyTemplateFor(templateId?: string, legacyTheme?: string) {
  return customStoryTemplates.find((template) => template.id === templateId) ?? (templateId === 'detective-archive' || !templateId ? { ...detectiveArchiveTemplate, title: legacyTheme || detectiveArchiveTemplate.title } : defaultStoryTemplate)
}

export function storyBeatsForLength(template: StoryTemplate, length: 1 | 3 | 5) {
  if (length === 1) return [template.single]
  if (length === 3) return [template.chapters[0], template.chapters[2], template.chapters[4]]
  return template.chapters
}

export function storyTemplateModelProfile(template: StoryTemplate) {
  return {
    id: template.id,
    name: template.title,
    playerRole: template.playerRole,
    narrativeEngine: template.narrativeEngine,
    storyGoal: template.storyGoal,
    objectSemantics: template.objectSemantics,
    gameplayHook: template.gameplayHook,
    hintTone: template.hintTone,
    endingPattern: template.endingPattern,
  }
}

export function visualStyleDirection(style: string) {
  return visualStyles.find((item) => item.name === style)?.direction ?? style
}
