# 隐藏物品寻物游戏

当前试玩版提供五个展示关卡和“一句话即时委托”。固定案件围绕“失踪制图师与星图”展开；即时委托会经过 `LevelIntent → Scene/Object Resolver → Seeded Placement → Level Validator → Phaser Runtime` 后直接进入可玩关卡。

## 运行

```bash
pnpm install
pnpm dev
```

默认同时启动 Web 与 API：Web 由 Vite 输出本地访问地址，API 为 `http://127.0.0.1:3001`。复制 `.env.example` 为 `.env` 后可设置 `GENERATOR_MODE=mock|openai`；未配置 OpenAI 时会自动回退到 mock。

## 当前范围

- 固定 `LevelSchema` 与 Zod 契约测试；
- 五张 1536×1024 的高密度场景图；
- 每关 8 个目标 Sprite、目标缩略图和命中区；场景内物件与背景自然融合；
- React HUD + Phaser Runtime；
- Fastify 生成 API、seed 可重复的关卡引擎、持久化生成记录与埋点接收；
- 不含账号、支付、体力、Inspector 或生产部署。

运行时先加载场景背景，再加载目标 Sprite；命中、Hint 与找到反馈均绑定 Sprite，而不是绑定背景中的透明矩形。固定关卡会在加载时经过 Zod 和业务规则校验；配置不合法时显示可理解的错误页。

## V0.1 回归

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Web 回归测试会验证五个展示关卡均有完整背景与 Sprite 资源、每关恰有 8 个目标、以及所有带 padding 的命中区不重叠。

## 版本能力

- V0.2：统一视觉 Token、首页/选关、五个展示关卡、加载/错误/结算状态、找到动画、Hint、误点反馈、声音与音乐开关、前端事件上报。
- V0.3：一句话输入、mock/OpenAI 双模式解释器、场景/物品解析、seed 控制、规则校验、失败回退、`POST /api/generate-level`、`GET /api/levels/:id`、生成记录与事件 API。
