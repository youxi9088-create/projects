import { validateLevel, type Level } from '@hog/contracts'
import { detectiveOfficeLevel } from './detective-office.level'

export interface StoryLevel {
  chapter: number
  difficulty: string
  investigationTip: string
  storyBeat: string
  caseFile: string
  objective: string
  completionText: string
  hintSet: Partial<Record<string, readonly string[]>>
  outro: {
    videoUrl: string
    title: string
    narration: string
  }
  level: Level
}

export const mainStoryFinale = {
  videoUrl: '/content/outros/mystery-finale.mp4',
  title: '沿着星图，找回制图师',
  narration: '沈砚留下的星图终于显影。走私航线被完整记录，案件正式归档。',
} as const

const oldCityArchiveLevel = {
  version: '1.0',
  id: 'old-city-archive-02',
  title: '旧城档案馆：被撕去的航线',
  seed: 'old-city-archive-02',
  source: 'preset',
  scene: { backgroundUrl: '/content/scenes/old-city-archive-layered.jpg', width: 1536, height: 1024 },
  mission: { type: 'find', targetIds: ['oil-lamp', 'typewriter', 'sealed-letter', 'pocket-watch', 'camera', 'travel-chest', 'armillary', 'ship-model'] },
  objects: [
    { id: 'oil-lamp', name: '油灯', spriteUrl: '/content/objects/archive-1.png', thumbnailUrl: '/content/objects/archive-1.png', hint: '一盏旧火，在案桌边替无人值守。', target: true, x: 0.303, y: 0.484, width: 105, height: 160, hitPadding: 8 },
    { id: 'typewriter', name: '打字机', spriteUrl: '/content/objects/archive-2.png', thumbnailUrl: '/content/objects/archive-2.png', hint: '密档的声音，藏在纸页与金属字键之间。', target: true, x: 0.561, y: 0.441, width: 155, height: 110, hitPadding: 8 },
    { id: 'sealed-letter', name: '封蜡信件', spriteUrl: '/content/objects/archive-3.png', thumbnailUrl: '/content/objects/archive-3.png', hint: '红色封印压住了制图师留下的姓名。', target: true, x: 0.406, y: 0.498, width: 145, height: 100, hitPadding: 8 },
    { id: 'pocket-watch', name: '怀表', spriteUrl: '/content/objects/archive-4.png', thumbnailUrl: '/content/objects/archive-4.png', hint: '滴答声落在桌沿前，像一次被改写的约定。', target: true, x: 0.44, y: 0.67, width: 68, height: 68, hitPadding: 6 },
    { id: 'camera', name: '相机', spriteUrl: '/content/objects/archive-5.png', thumbnailUrl: '/content/objects/archive-5.png', hint: '桌角的黑色见证者，拍下了不该遗失的一页。', target: true, x: 0.14, y: 0.762, width: 125, height: 145, hitPadding: 8 },
    { id: 'travel-chest', name: '旅行箱', spriteUrl: '/content/objects/archive-6.png', thumbnailUrl: '/content/objects/archive-6.png', hint: '尘封的行李，尚未等到真正的主人。', target: true, x: 0.744, y: 0.41, width: 185, height: 120, hitPadding: 8 },
    { id: 'armillary', name: '浑仪', spriteUrl: '/content/objects/archive-7.png', thumbnailUrl: '/content/objects/archive-7.png', hint: '黄铜星轨绕着旧世界，指向一片雾港。', target: true, x: 0.87, y: 0.276, width: 130, height: 155, hitPadding: 8 },
    { id: 'ship-model', name: '帆船模型', spriteUrl: '/content/objects/archive-8.png', thumbnailUrl: '/content/objects/archive-8.png', hint: '高处停泊的小船，替下一站报出了航向。', target: true, x: 0.898, y: 0.09, width: 135, height: 105, hitPadding: 8 },
  ],
} as const

const fogHarborCabinLevel = {
  version: '1.0',
  id: 'fog-harbor-cabin-03',
  title: '雾港船长舱：逆潮的航程',
  seed: 'fog-harbor-cabin-03',
  source: 'preset',
  scene: { backgroundUrl: '/content/scenes/fog-harbor-cabin-layered.jpg', width: 1536, height: 1024 },
  mission: { type: 'find', targetIds: ['telescope', 'lantern', 'star-chart', 'sextant', 'pocket-watch', 'brass-key', 'camera', 'sealed-letter'] },
  objects: [
    { id: 'telescope', name: '望远镜', spriteUrl: '/content/objects/cabin-1.png', thumbnailUrl: '/content/objects/cabin-1.png', hint: '穿过雨雾的长眼，仍望着未归的船影。', target: true, x: 0.602, y: 0.208, width: 245, height: 95, hitPadding: 8 },
    { id: 'lantern', name: '航海灯', spriteUrl: '/content/objects/cabin-2.png', thumbnailUrl: '/content/objects/cabin-2.png', hint: '舱窗旁的暖光，替夜航者留下一道门。', target: true, x: 0.467, y: 0.248, width: 90, height: 135, hitPadding: 8 },
    { id: 'star-chart', name: '星图', spriteUrl: '/content/objects/cabin-3.png', thumbnailUrl: '/content/objects/cabin-3.png', hint: '航线的答案铺在桌心，星辰替它标了记号。', target: true, x: 0.5, y: 0.47, width: 260, height: 100, hitPadding: 6 },
    { id: 'sextant', name: '六分仪', spriteUrl: '/content/objects/cabin-4.png', thumbnailUrl: '/content/objects/cabin-4.png', hint: '测量天海夹角的黄铜弧线，伏在地图下缘。', target: true, x: 0.353, y: 0.605, width: 150, height: 125, hitPadding: 8 },
    { id: 'pocket-watch', name: '怀表', spriteUrl: '/content/objects/cabin-5.png', thumbnailUrl: '/content/objects/cabin-5.png', hint: '码头钟声未响，时间先在航图右侧停住。', target: true, x: 0.581, y: 0.576, width: 52, height: 52, hitPadding: 4 },
    { id: 'brass-key', name: '黄铜钥匙', spriteUrl: '/content/objects/cabin-6.png', thumbnailUrl: '/content/objects/cabin-6.png', hint: '开锁的金属答案，紧挨着那段停摆时刻。', target: true, x: 0.623, y: 0.566, width: 43, height: 43, hitPadding: 4 },
    { id: 'camera', name: '相机', spriteUrl: '/content/objects/cabin-7.png', thumbnailUrl: '/content/objects/cabin-7.png', hint: '靠近船舷的镜头，保留了港口最后一帧。', target: true, x: 0.868, y: 0.804, width: 130, height: 145, hitPadding: 8 },
    { id: 'sealed-letter', name: '封蜡信件', spriteUrl: '/content/objects/cabin-8.png', thumbnailUrl: '/content/objects/cabin-8.png', hint: '火漆落在船长桌上，终于把谜底封成一句话。', target: true, x: 0.718, y: 0.89, width: 185, height: 88, hitPadding: 8 },
  ],
} as const

const tideClocktowerVaultLevel = {
  version: '1.0',
  id: 'tide-clocktower-vault-04',
  title: '潮汐钟塔地库：沉没证词',
  seed: 'tide-clocktower-vault-04',
  source: 'preset',
  scene: { backgroundUrl: '/content/scenes/tide-clocktower-vault.png', width: 1536, height: 1024 },
  mission: { type: 'find', targetIds: ['tide-watch', 'blue-handkerchief', 'glass-negative', 'sealed-packet', 'brass-compass', 'clocktower-key', 'document-stamp', 'harbor-lantern'] },
  objects: [
    { id: 'tide-watch', name: '潮汐怀表', spriteUrl: '/content/objects/office-1.png', thumbnailUrl: '/content/objects/office-1.png', hint: '抽屉与账簿的阴影交界，时间仍在等一个证人。', target: true, x: 0.287, y: 0.706, width: 78, height: 72, hitPadding: 9 },
    { id: 'blue-handkerchief', name: '蓝色手帕', spriteUrl: '/content/objects/office-4.png', thumbnailUrl: '/content/objects/office-4.png', hint: '湿冷的纸张之间，有一抹不属于木头的蓝。', target: true, x: 0.258, y: 0.822, width: 140, height: 90, hitPadding: 10 },
    { id: 'glass-negative', name: '玻璃底片', spriteUrl: '/content/objects/office-6.png', thumbnailUrl: '/content/objects/office-6.png', hint: '地图右下方，黑色玻璃映不出灯火。', target: true, x: 0.713, y: 0.888, width: 130, height: 92, hitPadding: 9 },
    { id: 'sealed-packet', name: '封蜡证物袋', spriteUrl: '/content/objects/office-2.png', thumbnailUrl: '/content/objects/office-2.png', hint: '红蜡没有封住信，只压住了一个名字。', target: true, x: 0.872, y: 0.854, width: 138, height: 92, hitPadding: 10 },
    { id: 'brass-compass', name: '黄铜罗盘', spriteUrl: '/content/objects/cabin-4.png', thumbnailUrl: '/content/objects/cabin-4.png', hint: '蓝布边缘的圆盘，指针没有指向北方。', target: true, x: 0.36, y: 0.91, width: 84, height: 84, hitPadding: 8 },
    { id: 'clocktower-key', name: '钟塔钥匙', spriteUrl: '/content/objects/office-3.png', thumbnailUrl: '/content/objects/office-3.png', hint: '右侧绞盘前的杂物旁，金属只露出短短一截。', target: true, x: 0.918, y: 0.64, width: 55, height: 46, hitPadding: 10 },
    { id: 'document-stamp', name: '档案铜印', spriteUrl: '/content/objects/office-4.png', thumbnailUrl: '/content/objects/office-4.png', hint: '航图的右边缘，压纸的黑色重物没有写字。', target: true, x: 0.76, y: 0.753, width: 62, height: 76, hitPadding: 9 },
    { id: 'harbor-lantern', name: '港口提灯', spriteUrl: '/content/objects/cabin-2.png', thumbnailUrl: '/content/objects/cabin-2.png', hint: '右侧箱子上，暖光没有照亮秘密。', target: true, x: 0.844, y: 0.686, width: 76, height: 132, hitPadding: 9 },
  ],
} as const

const mapmakerSecretWorkshopLevel = {
  version: '1.0',
  id: 'mapmaker-secret-workshop-05',
  title: '制图师密室：星图终章',
  seed: 'mapmaker-secret-workshop-05',
  source: 'preset',
  scene: { backgroundUrl: '/content/scenes/mapmaker-secret-workshop.png', width: 1536, height: 1024 },
  mission: { type: 'find', targetIds: ['workshop-watch', 'final-letter', 'ruler-key', 'fountain-pen', 'photo-plate', 'seal-stamp', 'lens-ring', 'star-chart-fragment'] },
  objects: [
    { id: 'workshop-watch', name: '制图师怀表', spriteUrl: '/content/objects/office-1.png', thumbnailUrl: '/content/objects/office-1.png', hint: '卷起的航图压住了最后一次停表的时刻。', target: true, x: 0.425, y: 0.728, width: 82, height: 70, hitPadding: 9 },
    { id: 'final-letter', name: '未寄出的密信', spriteUrl: '/content/objects/office-2.png', thumbnailUrl: '/content/objects/office-2.png', hint: '桌子左下，红蜡的边缘藏在散纸里。', target: true, x: 0.228, y: 0.786, width: 148, height: 88, hitPadding: 10 },
    { id: 'ruler-key', name: '刻度钥匙', spriteUrl: '/content/objects/office-3.png', thumbnailUrl: '/content/objects/office-3.png', hint: '长尺投下的影子旁，有一段短促的金属光。', target: true, x: 0.33, y: 0.64, width: 54, height: 46, hitPadding: 10 },
    { id: 'fountain-pen', name: '制图钢笔', spriteUrl: '/content/objects/office-7.png', thumbnailUrl: '/content/objects/office-7.png', hint: '星图右侧的纸边，一支笔没有沾上雨水。', target: true, x: 0.474, y: 0.559, width: 166, height: 58, hitPadding: 9 },
    { id: 'photo-plate', name: '暗室底片', spriteUrl: '/content/objects/office-6.png', thumbnailUrl: '/content/objects/office-6.png', hint: '桌沿下方的黑片，映着一段颠倒的天际线。', target: true, x: 0.497, y: 0.875, width: 124, height: 88, hitPadding: 9 },
    { id: 'seal-stamp', name: '制图铜印', spriteUrl: '/content/objects/office-4.png', thumbnailUrl: '/content/objects/office-4.png', hint: '字模与纸屑之间，沉重的圆柄没有离开工位。', target: true, x: 0.147, y: 0.646, width: 64, height: 78, hitPadding: 9 },
    { id: 'lens-ring', name: '观星镜环', spriteUrl: '/content/objects/office-5.png', thumbnailUrl: '/content/objects/office-5.png', hint: '右下角的工具箱里，有一只圆环套住了黑暗。', target: true, x: 0.888, y: 0.751, width: 118, height: 104, hitPadding: 9 },
    { id: 'star-chart-fragment', name: '星图残页', spriteUrl: '/content/objects/cabin-3.png', thumbnailUrl: '/content/objects/cabin-3.png', hint: '大星图边缘的折角，比其他纸页多了一道针孔。', target: true, x: 0.355, y: 0.471, width: 112, height: 84, hitPadding: 9 },
  ],
} as const

const rawStoryLevels = [
  {
    chapter: 1,
    difficulty: '入门 · 认识证物与书桌布局',
    investigationTip: '点击下方物品图标可逐步获得三段文字提示；图标提示不会显示场景高光。',
    hintSet: {
      'pocket-watch': ['烛光附近，有一段仍未走完的时间。', '先看书桌中央偏上的暖光区域。', '它靠近烛台下方的桌面。'],
      'sealed-letter': ['红蜡封住的不是秘密，而是一封来不及寄出的信。', '它躺在左侧散开的信纸之间。', '查看书桌左半部、摊开纸页的上方。'],
      'brass-key': ['金属的答案，没有离开停摆的时刻。', '它就在怀表附近的一小片桌面上。', '沿着烛台右侧向墨水瓶方向找。'],
      'case-file': ['沉重的卷宗，压住了未完的真相。', '右侧的大张航图旁有一叠厚实的纸。', '查看画面右下区域、地图边缘。'],
      'magnifying-glass': ['圆眼能放大迷雾，却不在书本中央。', '它在右上方的茶具与烟灰缸一带。', '查看茶杯下方、航图上缘附近。'],
      'evidence-photo': ['褪色街景还记得雨夜的脚步。', '它靠近画面下方左侧的零散文书。', '查看书桌下缘、书堆右侧。'],
      'fountain-pen': ['黑金笔尖，还停在制图师最后读过的纸页旁。', '它在右侧摊开的书本附近。', '查看中央书本右侧的纸边。'],
      camera: ['双眼见证者，被桌角阴影吞没了一半。', '它位于左下方的书堆与桌沿之间。', '查看画面左下、深色书本旁。'],
    },
    storyBeat: '失踪七日的制图师沈砚，只留下一封未寄出的信和一枚停在潮汐时刻的怀表。',
    caseFile: '沈砚曾受匿名委托绘制一张从未公开的潮汐星图。委托人失联后，只有他的书桌仍保持离开时的样子。',
    objective: '找齐桌上的私人物证，确认他最后一次赴约的地点。',
    completionText: '信封夹层里的门牌号被还原：沈砚离开书房后，去的是旧城档案馆的密档室。',
    outro: { videoUrl: '/content/outros/chapter-01-outro.mp4', title: '线索指向旧城', narration: '雨夜里的门牌号，指向旧城档案馆。' },
    level: detectiveOfficeLevel,
  },
  {
    chapter: 2,
    difficulty: '观察 · 在密集馆藏中辨认证物',
    investigationTip: '先用第一段提示确定区域，再用后两段缩小到书架、桌面或高处陈列。',
    hintSet: {
      'oil-lamp': ['旧火没有熄灭，它替无人值守的档案桌留了一盏灯。', '寻找房间中央的主桌与金色光源。', '它在大桌上偏左、靠近纸堆的位置。'],
      typewriter: ['密档的声音藏在金属字键之间。', '留意房间中部靠后的工作桌。', '它在主桌后侧、靠近柜架的一带。'],
      'sealed-letter': ['一枚红色封印压住了制图师的名字。', '先查看主桌左半部的纸本和小物。', '它在桌面左侧、靠近翻开的记录。'],
      'pocket-watch': ['滴答声没有走远，只是混进了木桌的暖色里。', '它位于房间中央桌面附近。', '查看主桌前缘偏左的阴影。'],
      camera: ['黑色镜头比书脊更沉默。', '它藏在画面左下角的工作台上。', '查看左下前景、靠近器材盒的位置。'],
      'travel-chest': ['尘封的行李还在等真正的主人。', '它没有上书架，而是落在屋内较低的地方。', '查看中央桌后方、地毯上缘一带。'],
      armillary: ['黄铜星轨绕着旧世界，替雾港标了方位。', '先看左侧书架附近的圆形陈列。', '它在左侧中下部、靠近壁柜。'],
      'ship-model': ['小船停泊在不该靠岸的书架上。', '将目光抬到左上方的高处。', '查看左上书架、靠近窗边的位置。'],
    },
    storyBeat: '密档中被撕走的航线，指向一艘从未登记靠港的雾港货船。',
    caseFile: '馆员否认见过沈砚，但书架深处留有他借阅的潮汐表和被挖掉的一页船籍记录。',
    objective: '找出被伪装成普通馆藏的航海证物，拼回被撕去的航线。',
    completionText: '船籍记录证明“夜鸦号”没有离港；它停在雾港，船长舱里还留着沈砚的最后一段笔记。',
    outro: { videoUrl: '/content/outros/chapter-02-outro.mp4', title: '夜鸦号仍在港内', narration: '被撕去的航线，在雾港重新显影。' },
    level: oldCityArchiveLevel,
  },
  {
    chapter: 3,
    difficulty: '细查 · 用位置关系复原逆潮航线',
    investigationTip: '本关小型金属证物更多，优先观察窗边、桌沿与箱子附近的轮廓。',
    hintSet: {
      telescope: ['一只长眼仍望着雨雾里的船影。', '先看圆形舷窗附近的高处。', '它横放在画面上方中央、舷窗右侧。'],
      lantern: ['舱窗旁的暖光，为夜航者留下了一道门。', '留意中上部唯一稳定的橙色光源。', '它就在圆形舷窗右下方的台面上。'],
      'star-chart': ['航线的答案铺在桌心，却被木纹和雨夜压低了光。', '查看房间中央的大桌面。', '它位于主桌中央偏上、书本附近。'],
      sextant: ['黄铜弧线测量天与海之间的夹角。', '它贴近桌面左下方的器械堆。', '查看主桌左下、靠近卷图的位置。'],
      'pocket-watch': ['码头钟声未响，时间先在航图右侧停住。', '它在中央桌面偏右的细小物件中。', '查看书堆右侧、桌面中下方。'],
      'brass-key': ['开锁的金属答案，紧挨着那段停摆时刻。', '先找到怀表，再看它旁边的金属反光。', '查看中央桌面、怀表右侧。'],
      camera: ['靠近船舷的镜头，保存了港口最后一帧。', '它不在主桌，而在右下方的船舱边缘。', '查看右下角、箱子前方的暗处。'],
      'sealed-letter': ['火漆把谜底封在船长留下的最后一句话里。', '它靠近画面右下的航海杂物。', '查看右下桌沿、绳索与器具附近。'],
    },
    storyBeat: '夜鸦号的航程被人为倒写；船长舱里的星图记录着一条逆着潮水进入钟塔的暗道。',
    caseFile: '船长日志缺少最后一页，桌上的仪器却都停在同一刻。沈砚没有被带出港口，而是被送往更近的地方。',
    objective: '复原船长留下的逆潮路线，找出通往钟塔地库的钥匙。',
    completionText: '密信与六分仪刻度共同指向钟塔下方。沈砚被困的说法不成立：他曾主动留下进入地库的路线。',
    outro: { videoUrl: '/content/outros/chapter-03-outro.mp4', title: '钟塔下的暗道', narration: '逆潮而行的路线，通往港口钟塔。' },
    level: fogHarborCabinLevel,
  },
  {
    chapter: 4,
    difficulty: '取证 · 在潮湿杂物中辨认低对比证据',
    investigationTip: '证物会和地图、金属与积水混在一起；逐段提示会先给材质，再给方位。',
    hintSet: {
      'tide-watch': ['停摆的时间被雨水和木头的阴影包住了。', '先看前景左侧的抽屉与账簿交界。', '查看左下偏中的桌面、靠近抽屉边。'],
      'blue-handkerchief': ['潮湿纸张间，有一抹不属于木头的蓝。', '它在前景左下的散页与箱子之间。', '查看画面左下、紧贴桌沿的蓝色折布。'],
      'glass-negative': ['黑色玻璃不映灯火，只留下被倒置的天际线。', '它位于前景右下的地图边缘。', '查看右下方、相片与罗盘附近。'],
      'sealed-packet': ['红蜡没有封住信，只压住了一个名字。', '它混在右下区域的纸袋和航图里。', '查看右下角、深色封印附近。'],
      'brass-compass': ['圆盘没有指向北方，而是指向潮汐留下的路线。', '它在前景偏左的桌面边缘。', '查看左下偏中、蓝布右侧的圆形金属件。'],
      'clocktower-key': ['短促的金属光，藏在绞盘与杂物的缝隙里。', '先找右侧的大型卷扬机械。', '查看画面右中、绞盘前方的木箱附近。'],
      'document-stamp': ['压纸的重物没有写字，却留下了最重要的印记。', '它在右侧前景的航图边缘。', '查看右下偏中、纸张与工具交叠处。'],
      'harbor-lantern': ['暖光没有照亮秘密，只照亮了潮湿的木箱。', '它在右侧中部、靠近破窗的阴影里。', '查看画面右中、箱子上方的灯位。'],
    },
    storyBeat: '钟塔地库保存着被水淹没的港务证词，也保存着沈砚主动藏下的影像。',
    caseFile: '钟表匠的旧档案证明，地库曾是走私者交换航线的中转站。地面上的潮湿足迹在这里忽然消失。',
    objective: '从浸水的账簿、底片和证物袋中找出沈砚留下的证词。',
    completionText: '底片揭开真相：沈砚并非被绑架，他带着星图躲进自己的秘密工坊，准备印出能指证走私网络的最后一版。',
    outro: { videoUrl: '/content/outros/chapter-04-outro.mp4', title: '底片里的工坊', narration: '沉没的证词，映出了制图师的藏身之处。' },
    level: tideClocktowerVaultLevel,
  },
  {
    chapter: 5,
    difficulty: '终局 · 在制图工坊中完成最后校图',
    investigationTip: '终局证物分散在前景工作台与后方印刷机之间；先判断它属于“绘图”还是“印制”。',
    hintSet: {
      'workshop-watch': ['最后一次停表的时刻，被卷起的航图压住。', '它位于前景工作台的中下方。', '查看卷图下缘、靠近桌沿的位置。'],
      'final-letter': ['未寄出的密信仍带着红蜡的边缘。', '先看前景左下的纸本与工具堆。', '查看画面左下、信封状纸页之间。'],
      'ruler-key': ['长尺投下的影子旁，有一段短促的金属光。', '它靠近前景中央的制图工具。', '查看工作台中下方、直尺附近。'],
      'fountain-pen': ['一支钢笔没有沾上雨水，仍在等最后一笔。', '它躺在星图右侧的一摞纸边。', '查看前景右中、地图与图纸交界。'],
      'photo-plate': ['黑色底片映着倒置的天际线。', '它被压在工作台下方的暗色纸堆里。', '查看前景中下、桌沿附近的黑色方片。'],
      'seal-stamp': ['沉重的圆柄没有离开印制工位。', '它在左侧的卷图与瓶罐附近。', '查看画面左中、工具架下方。'],
      'lens-ring': ['圆环套住了黑暗，静置在右下工具箱里。', '先看右下角凌乱的器具盒。', '查看右下前景、圆形金属部件附近。'],
      'star-chart-fragment': ['残页的折角比其他纸张多一道针孔。', '它属于前景中央的大星图。', '查看星图边缘、靠近折叠图纸的位置。'],
    },
    storyBeat: '秘密工坊里，整张潮汐星图已接近完成；它的终点并不是宝藏，而是一条走私船队的真实路线。',
    caseFile: '沈砚用自己的失踪换取印制时间。只要找到他预留的八件校图工具，就能让星图显出足以定罪的坐标。',
    objective: '找齐最终校图工具，复原潮汐星图，完成对港口走私网络的取证。',
    completionText: '星图在雨夜里完成显影。沈砚留下的坐标交给港务局后，夜鸦号的航线与整条走私网络一并被封存，案件正式归档。',
    outro: { videoUrl: '/content/outros/chapter-05-outro.mp4', title: '潮汐星图终章', narration: '晨光抵达工坊，真相终于能够被看见。' },
    level: mapmakerSecretWorkshopLevel,
  },
]

export type StoryLevelLoadResult =
  | { levels: StoryLevel[]; error?: never }
  | { levels: []; error: string }

export function loadStoryLevels(): StoryLevelLoadResult {
  const levels: StoryLevel[] = []
  for (const story of rawStoryLevels) {
    const result = validateLevel(story.level)
    if (!result.ok) return { levels: [], error: `第 ${story.chapter} 关无法加载。${result.message}` }
    levels.push({ ...story, level: result.level })
  }
  return { levels }
}
