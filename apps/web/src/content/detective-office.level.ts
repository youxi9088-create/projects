export const detectiveOfficeLevel = {
  version: '1.0',
  id: 'detective-office-rainy-01',
  title: '雨夜书桌：未寄出的坐标',
  seed: 'detective-office-01',
  source: 'preset',
  scene: {
    backgroundUrl: '/content/scenes/detective-office-layered.jpg',
    width: 1536,
    height: 1024,
  },
  mission: {
    type: 'find',
    targetIds: ['pocket-watch', 'sealed-letter', 'brass-key', 'case-file', 'magnifying-glass', 'evidence-photo', 'fountain-pen', 'camera'],
  },
  objects: [
    { id: 'pocket-watch', name: '怀表', spriteUrl: '/content/objects/office-1.png', thumbnailUrl: '/content/objects/office-1.png', hint: '烛影里，时间正替侦探守候。', target: true, x: 0.443, y: 0.392, width: 76, height: 76, hitPadding: 8 },
    { id: 'sealed-letter', name: '封蜡信件', spriteUrl: '/content/objects/office-2.png', thumbnailUrl: '/content/objects/office-2.png', hint: '被火漆封存的秘密，静卧在纸页之间。', target: true, x: 0.273, y: 0.54, width: 205, height: 153, hitPadding: 12 },
    { id: 'brass-key', name: '黄铜钥匙', spriteUrl: '/content/objects/office-3.png', thumbnailUrl: '/content/objects/office-3.png', hint: '金属的答案，靠在时间的身旁。', target: true, x: 0.502, y: 0.418, width: 48, height: 50, hitPadding: 6 },
    { id: 'case-file', name: '案件档案', spriteUrl: '/content/objects/office-4.png', thumbnailUrl: '/content/objects/office-4.png', hint: '卷宗的分量，压住未完的真相。', target: true, x: 0.828, y: 0.664, width: 285, height: 240, hitPadding: 12 },
    { id: 'magnifying-glass', name: '放大镜', spriteUrl: '/content/objects/office-5.png', thumbnailUrl: '/content/objects/office-5.png', hint: '放大迷雾的圆眼，伏在地图边。', target: true, x: 0.76, y: 0.4, width: 138, height: 220, hitPadding: 12 },
    { id: 'evidence-photo', name: '证据照片', spriteUrl: '/content/objects/office-6.png', thumbnailUrl: '/content/objects/office-6.png', hint: '褪色的街景，记得昨天的脚步。', target: true, x: 0.371, y: 0.799, width: 210, height: 151, hitPadding: 12 },
    { id: 'fountain-pen', name: '钢笔', spriteUrl: '/content/objects/office-7.png', thumbnailUrl: '/content/objects/office-7.png', hint: '黑金笔尖，仍在案卷上停留。', target: true, x: 0.611, y: 0.493, width: 174, height: 112, hitPadding: 13 },
    { id: 'camera', name: '相机', spriteUrl: '/content/objects/office-8.png', thumbnailUrl: '/content/objects/office-8.png', hint: '双眼见证者，藏在桌角阴影中。', target: true, x: 0.19, y: 0.799, width: 166, height: 165, hitPadding: 12 },
  ],
} as const
