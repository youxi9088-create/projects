import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { apiUrl } from './api'
import { loadStoryLevels, mainStoryFinale } from './content/story-levels'
import { CreatorFlow } from './creator/CreatorFlow'
import { customStoryTemplates } from './creator/storyTemplates'
import { PhaserGame } from './game/PhaserGame'
import { ArrowLeftIcon, ArrowRightIcon, BulbIcon, CheckIcon, ObserveIcon } from './icons'
import { ThreeLibraryExplore } from './explore/ThreeLibraryExplore'

function CasebookIcon() {
  return <svg aria-hidden="true" viewBox="0 0 64 64">
    <path className="casebook-cover" d="M14 6h31c5 0 9 4 9 9v38c0 3-2 5-5 5H18c-5 0-9-4-9-9V14c0-4 2-7 5-8Z" />
    <path className="casebook-pages" d="M20 12h25c2 0 3 1 3 3v34c0 2-1 3-3 3H20c-2 0-4-2-4-4V16c0-2 2-4 4-4Z" />
    <path className="casebook-spine" d="M9 15c0-5 4-9 9-9h4v52h-4c-5 0-9-4-9-9V15Z" />
    <path className="casebook-lines" d="M25 19h17v3H25zm0 7h17v3H25zm0 7h10v3H25z" />
    <path className="casebook-seal" d="m40 36 2.2 4.5 4.8.7-3.5 3.5.8 4.8-4.3-2.3-4.3 2.3.8-4.8-3.5-3.5 4.8-.7L40 36Z" />
  </svg>
}

function App() {
  const storyLoad = useMemo(() => loadStoryLevels(), [])
  const [screen, setScreen] = useState<'home' | 'cases' | 'chapters' | 'play' | 'creator' | 'explore3d'>('home')
  const [activeChapter, setActiveChapter] = useState(0)
  const [completedChapters, setCompletedChapters] = useState<number[]>(() => {
    try {
      const value = window.localStorage.getItem('hog-completed-chapters')
      const chapters = value ? JSON.parse(value) : []
      return Array.isArray(chapters) ? chapters.filter((chapter): chapter is number => Number.isInteger(chapter) && chapter >= 0) : []
    } catch { return [] }
  })
  const [foundIds, setFoundIds] = useState<string[]>([])
  const [wrongClicks, setWrongClicks] = useState(0)
  const [hintRequest, setHintRequest] = useState({ nonce: 0 })
  const [hintText, setHintText] = useState<string | null>(null)
  const [hintStages, setHintStages] = useState<Record<string, number>>({})
  const [ready, setReady] = useState(false)
  const [complete, setComplete] = useState(false)
  const [introOpen, setIntroOpen] = useState(false)
  const [outroOpen, setOutroOpen] = useState(false)
  const [finaleReplayOpen, setFinaleReplayOpen] = useState(false)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [musicEnabled, setMusicEnabled] = useState(false)
  const [creatorEntry, setCreatorEntry] = useState<'drafts' | 'gallery'>('drafts')
  const musicRef = useRef<{ context: AudioContext; oscillator: OscillatorNode; gain: GainNode } | null>(null)

  const storyLevels = storyLoad.levels
  const activeStory = storyLevels[activeChapter] ?? null
  const level = activeStory?.level
  const nextChapter = activeChapter + 1 < storyLevels.length ? activeChapter + 1 : null
  const completedChapterCount = storyLevels.filter((_story, index) => completedChapters.includes(index)).length
  const isMainCaseComplete = storyLevels.length > 0 && completedChapterCount === storyLevels.length
  const nextUncompletedChapter = storyLevels.findIndex((_story, index) => !completedChapters.includes(index))
  // 主线最终影片以第 5 关完成为入口。早期版本没有持久化通关记录，
  // 因此不能要求玩家在功能上线后重复完成此前已经通过的四关。
  const isCampaignFinale = activeChapter === storyLevels.length - 1
  const activeOutro = isCampaignFinale ? mainStoryFinale : activeStory?.outro
  const targets = useMemo(
    () => level?.objects.filter((object) => level.mission.targetIds.includes(object.id)) ?? [],
    [level],
  )
  const playSfx = useCallback((frequency: number) => {
    if (!soundEnabled) return
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(.045, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .14)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(); oscillator.stop(context.currentTime + .15)
  }, [soundEnabled])
  useEffect(() => {
    if (!musicEnabled) { musicRef.current?.oscillator.stop(); musicRef.current?.context.close(); musicRef.current = null; return }
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain()
    oscillator.type = 'sine'; oscillator.frequency.value = 110; gain.gain.value = .012
    oscillator.connect(gain).connect(context.destination); oscillator.start(); musicRef.current = { context, oscillator, gain }
    return () => { oscillator.stop(); void context.close(); musicRef.current = null }
  }, [musicEnabled])
  useEffect(() => {
    try { window.localStorage.setItem('hog-completed-chapters', JSON.stringify(completedChapters)) } catch { /* storage is optional */ }
  }, [completedChapters])

  const track = useCallback((name: string, props: Record<string, unknown> = {}) => {
    if (!level) return
    void fetch(apiUrl('/api/events'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'local-session', events: [{ name, levelId: level.id, ts: Date.now(), props }] }) }).catch(() => undefined)
  }, [level])
  const onFound = useCallback((id: string) => {
    setFoundIds((current) => (current.includes(id) ? current : [...current, id]))
    playSfx(660)
    track('item_found', { itemId: id })
  }, [playSfx, track])

  const onReady = useCallback(() => { setReady(true); track('level_start') }, [track])
  const onWrongClick = useCallback(() => { setWrongClicks((count) => count + 1); playSfx(170); track('wrong_click') }, [playSfx, track])
  const onComplete = useCallback(() => {
    setComplete(true)
    setOutroOpen(true)
    setCompletedChapters((current) => current.includes(activeChapter) ? current : [...current, activeChapter])
    track('level_complete', { foundCount: targets.length })
  }, [activeChapter, targets.length, track])
  const resetLevel = useCallback(() => {
    setFoundIds([])
    setWrongClicks(0)
    setHintText(null)
    setHintStages({})
    setComplete(false)
    setOutroOpen(false)
    setReady(false)
  }, [])
  const goHome = useCallback(() => {
    setComplete(false)
    setOutroOpen(false)
    setFinaleReplayOpen(false)
    setHintText(null)
    setHintStages({})
    setIntroOpen(false)
    setScreen('home')
  }, [])
  const goMainCases = useCallback(() => {
    setFinaleReplayOpen(false)
    setScreen('cases')
  }, [])
  const openMainCase = useCallback(() => {
    setFinaleReplayOpen(false)
    setScreen('chapters')
  }, [])
  const openCreator = useCallback((entry: 'drafts' | 'gallery' = 'drafts') => {
    setCreatorEntry(entry)
    setScreen('creator')
  }, [])
  const openExplore3d = useCallback(() => {
    setFinaleReplayOpen(false)
    setScreen('explore3d')
  }, [])
  const returnToCaseList = useCallback(() => {
    setComplete(false)
    setOutroOpen(false)
    setHintText(null)
    setIntroOpen(false)
    setScreen('chapters')
  }, [])
  const selectChapter = useCallback((chapter: number) => {
    setActiveChapter(chapter)
    setFoundIds([])
    setWrongClicks(0)
    setHintText(null)
    setHintStages({})
    setComplete(false)
    setOutroOpen(false)
    setReady(false)
    setIntroOpen(true)
    setScreen('play')
  }, [])
  const requestHint = useCallback((requestedId?: string, highlight = true) => {
    const targetId = requestedId ?? level?.mission.targetIds.find((id) => !foundIds.includes(id))
    const target = targets.find((item) => item.id === targetId)
    const hints = targetId ? activeStory?.hintSet[targetId] : undefined
    const currentStage = targetId ? (hintStages[targetId] ?? 0) : 0
    const hint = hints?.[Math.min(currentStage, hints.length - 1)] ?? target?.hint ?? '留意场景中最容易被忽略的角落。'
    const stageTotal = hints?.length ?? 1
    setHintText(`线索指引 ${Math.min(currentStage + 1, stageTotal)}/${stageTotal} · ${hint}`)
    if (targetId) setHintStages((current) => ({ ...current, [targetId]: Math.min(currentStage + 1, stageTotal - 1) }))
    if (highlight) setHintRequest((current) => ({ nonce: current.nonce + 1, targetId }))
    track('hint_used', { targetId, highlight, stage: Math.min(currentStage + 1, stageTotal) })
  }, [activeStory, foundIds, hintStages, level, targets, track])
  if (storyLoad.error) {
    return <main className="app-shell config-error-shell">
      <section className="config-error" role="alert">
        <p className="eyebrow">关卡无法加载</p>
        <h1>配置需要修正</h1>
        <p>{storyLoad.error ?? '没有可用的固定关卡。'}</p>
        <p>请检查关卡 JSON 后刷新页面重试。</p>
      </section>
    </main>
  }

  const appNav = <header className="app-nav">
    <button className="app-brand" type="button" onClick={goHome}>
      <ObserveIcon />
      <span className="app-brand-text"><strong>寻物故事馆</strong><small>寻找物件，打开每个世界的故事。</small></span>
    </button>
    <nav className="app-nav-links" aria-label="主导航">
      <button className={screen === 'home' ? 'is-active' : ''} type="button" onClick={goHome}>首页</button>
      <button className={screen === 'cases' || screen === 'chapters' || screen === 'play' ? 'is-active' : ''} type="button" onClick={goMainCases}>精选故事</button>
      <button className={screen === 'creator' && creatorEntry === 'gallery' ? 'is-active' : ''} type="button" onClick={() => openCreator('gallery')}>我创作的故事</button>
      <button className={screen === 'creator' && creatorEntry === 'drafts' ? 'is-active' : ''} type="button" onClick={() => openCreator('drafts')}>新建冒险</button>
      <button className={screen === 'explore3d' ? 'is-active' : ''} type="button" onClick={openExplore3d}>3D 探索</button>
    </nav>
    <button aria-label="我的故事" className="my-cases-button" title="我的故事" type="button" onClick={() => openCreator('gallery')}><CasebookIcon /></button>
  </header>

  const finaleReplay = isMainCaseComplete && finaleReplayOpen && <div className="outro-cutscene" role="dialog" aria-modal="true" aria-label={`${mainStoryFinale.title}结局影片`}>
    <video autoPlay className="outro-video" controls key={mainStoryFinale.videoUrl} muted={!soundEnabled} onEnded={() => setFinaleReplayOpen(false)} onError={() => setFinaleReplayOpen(false)} playsInline src={mainStoryFinale.videoUrl} />
    <div className="outro-copy">
      <p className="eyebrow">已完成</p>
      <h2>{mainStoryFinale.title}</h2>
      <p>{mainStoryFinale.narration}</p>
    </div>
    <button className="outro-skip" type="button" onClick={() => setFinaleReplayOpen(false)}>返回精选故事</button>
  </div>

  if (screen === 'creator') return <CreatorFlow initialPage={creatorEntry} key={creatorEntry} stories={storyLevels} onExit={goHome} appNav={appNav} />
  if (screen === 'explore3d') return <ThreeLibraryExplore onExit={goHome} />

  if (!activeStory || !level) {
    return <main className="app-shell config-error-shell"><section className="config-error" role="alert"><h1>没有可用的精选故事</h1></section></main>
  }

  if (screen === 'home') {
    return <><main className="app-shell home-shell">
      {appNav}
      <section className="home-hero">
        <span aria-hidden="true" className="home-hero-atmosphere" style={{ backgroundImage: `url(${customStoryTemplates[0].imageUrl})` }} />
        <div className="home-hero-copy">
          <p className="eyebrow">多世界寻物</p>
          <h1>找出藏起来的物件，打开故事的下一页</h1>
          <p>从侦探档案、童话冒险到东方奇谭与星际科考，每一次观察都会推动一段不同的故事。</p>
          <div className="home-hero-actions">
            <button className="home-primary-action" type="button" onClick={goMainCases}>探索精选故事<ArrowRightIcon /></button>
            <button className="home-secondary-action" type="button" onClick={() => openCreator('drafts')}>创作我的故事</button>
            <button className="home-secondary-action" type="button" onClick={openExplore3d}>试玩 3D 图书馆</button>
          </div>
          <ul className="home-world-types" aria-label="故事类型">
            <li>侦探档案</li>
            {customStoryTemplates.map((template) => <li key={template.id}>{template.title}</li>)}
          </ul>
        </div>
        <aside className="home-world-showcase" aria-label="可选择的故事世界">
          {customStoryTemplates.map((template) => <article key={template.id}>
            <span aria-hidden="true" style={{ backgroundImage: `url(${template.imageUrl})` }} />
            <div><small>{template.category}</small><strong>{template.title}</strong></div>
          </article>)}
        </aside>
      </section>
      <div className="home-section-heading home-continue-heading">
        <div><p className="eyebrow">继续探索</p><h2>正在展开的精选故事</h2></div>
        <span>当前收录 1 个完整故事</span>
      </div>
      <section className="home-case-summary" aria-labelledby="main-case-summary-title">
        <div className="home-case-summary-copy">
          <p className="home-story-kind">侦探档案 · 连续剧情</p>
          <h2 id="main-case-summary-title">沿着星图，找回制图师</h2>
          <p className="home-case-summary-description">循着遗留的证物、航海档案与潮汐星图，在 {storyLevels.length} 个场景中拼出制图师沈砚失踪的真相。</p>
          <span className="home-case-next">{isMainCaseComplete ? '故事已完成 · 结局影片已解锁' : `继续第 ${String((nextUncompletedChapter >= 0 ? nextUncompletedChapter : storyLevels.length - 1) + 1).padStart(2, '0')} 章`}</span>
          <div className="home-case-metrics" aria-label="精选故事进度">
            <span><b>{storyLevels.length}</b> 个章节</span>
            <span><b>{completedChapterCount}</b> 已完成</span>
            <span><b>{isMainCaseComplete ? '已解锁' : '待解锁'}</b> 故事结局</span>
          </div>
          <div className="home-story-actions">
            <button className="home-story-action" type="button" onClick={goMainCases}>{isMainCaseComplete ? '回看这个故事' : '继续这个故事'}<ArrowRightIcon /></button>
            {isMainCaseComplete && <button className="home-story-action" type="button" onClick={() => setFinaleReplayOpen(true)}>播放故事结局</button>}
          </div>
        </div>
        <div className="home-route-board">
          <div className="home-route-board-heading"><span>故事章节</span><small>{completedChapterCount} / {storyLevels.length} 已完成</small></div>
          <ol className="home-chapter-route" aria-label="章节完成进度">
            {storyLevels.map((story, index) => {
              const complete = completedChapters.includes(index)
              const next = index === nextUncompletedChapter
              return <li className={complete ? 'is-complete' : next ? 'is-next' : ''} key={story.level.id}>
                <span aria-hidden="true">{complete ? <CheckIcon /> : String(story.chapter).padStart(2, '0')}</span>
                <strong>章节 {String(story.chapter).padStart(2, '0')}</strong>
                <small>{complete ? '已完成' : next ? '可继续' : '未开启'}</small>
              </li>
            })}
          </ol>
        </div>
      </section>
      <section className="home-section home-commission-section" aria-labelledby="commission-title">
        <div><p className="eyebrow">由你来创作</p><h2 id="commission-title">一句话，生成你的寻物故事</h2><p>选择故事类型、章节数量和画面风格，让你的想法变成可以游玩的独立冒险。</p></div>
        <div className="home-commission-actions">
          <button className="creator-entry" type="button" onClick={() => openCreator('drafts')}>
            <span aria-hidden="true" className="entry-art" style={{ backgroundImage: `url(${customStoryTemplates[1].imageUrl})` }} />
            <span><b>创作新故事</b><small>选择模板，再用一句话描述你想进入的世界</small></span>
            <ArrowRightIcon />
          </button>
          <button className="gallery-entry" type="button" onClick={() => openCreator('gallery')}>
            <span aria-hidden="true" className="entry-art" style={{ backgroundImage: `url(${customStoryTemplates[3].imageUrl})` }} />
            <span><b>我创作的故事</b><small>继续草稿，或重新游玩已经完成的故事</small></span>
            <ArrowRightIcon />
          </button>
        </div>
      </section>
    </main>{finaleReplay}</>
  }

  if (screen === 'cases') {
    return <><main className="app-shell home-shell case-list-shell">
      {appNav}
      <nav className="page-breadcrumb" aria-label="当前位置"><button type="button" onClick={goHome}>首页</button><span aria-hidden="true">/</span><strong aria-current="page">精选故事</strong></nav>
      <section className={`case-list-heading ${isMainCaseComplete ? 'has-actions' : ''}`}>
        <div><h1>精选故事</h1><p>进入不同题材的寻物世界，在连续章节中寻找关键物件并推动剧情。</p></div>
        {isMainCaseComplete && <button className="home-story-action" type="button" onClick={() => setFinaleReplayOpen(true)}>播放故事结局</button>}
      </section>
      <button className={`main-case-card ${isMainCaseComplete ? 'is-complete' : ''}`} type="button" onClick={openMainCase}>
        <span aria-hidden="true" className="main-case-cover" style={{ backgroundImage: `url(${storyLevels[0]?.level.scene.backgroundUrl})` }} />
        <span className="main-case-content">
          <span className="case-collection">侦探档案 · {storyLevels.length} 章</span>
          <strong>沿着星图，找回制图师</strong>
          <small>循着遗留的物证、航海档案与星图，查明制图师沈砚失踪的真相。</small>
          <span className="case-progress">{isMainCaseComplete ? <><b aria-hidden="true"><CheckIcon /></b> 已结案</> : `章节进度 ${completedChapterCount} / ${storyLevels.length}`}</span>
        </span>
        <span className="case-open">查看章节<ArrowRightIcon /></span>
      </button>
    </main>{finaleReplay}</>
  }

  if (screen === 'chapters') {
    return <><main className="app-shell home-shell chapter-list-shell">
      {appNav}
      <nav className="page-breadcrumb" aria-label="当前位置"><button type="button" onClick={goHome}>首页</button><span aria-hidden="true">/</span><button type="button" onClick={goMainCases}>精选故事</button><span aria-hidden="true">/</span><strong aria-current="page">沿着星图，找回制图师</strong></nav>
      <section className="chapter-list-heading">
        <div><p className="eyebrow">共 {storyLevels.length} 章</p><h1>沿着星图，找回制图师</h1><p>沈砚失踪后，零散的证物指向一张潮汐星图，以及潜伏在港口的走私网络。</p></div>
        <div className="chapter-list-status">
          <span className={isMainCaseComplete ? 'case-status is-complete' : 'case-status'}>{isMainCaseComplete ? <><b aria-hidden="true"><CheckIcon /></b> 已结案</> : `完成 ${completedChapterCount} / ${storyLevels.length}`}</span>
          {isMainCaseComplete && <button className="home-story-action" type="button" onClick={() => setFinaleReplayOpen(true)}>播放故事结局</button>}
        </div>
      </section>
      <section className="level-select" aria-label="精选故事章节">
        {storyLevels.map((story, index) => {
          const complete = completedChapters.includes(index)
          const next = index === nextUncompletedChapter
          return <button className={`level-card ${complete ? 'is-complete' : ''} ${next ? 'is-next' : ''}`} key={story.level.id} onClick={() => selectChapter(index)} type="button">
            <span aria-hidden="true" className="level-cover" style={{ backgroundImage: `url(${story.level.scene.backgroundUrl})` }} />
            <span className="level-number">章节 {String(story.chapter).padStart(2, '0')}</span>
            {complete && <span className="chapter-complete" aria-label="已完成"><CheckIcon /></span>}
            <strong>{story.level.title}</strong>
            <small>{story.storyBeat}</small>
            <span className="level-start">{complete ? '再次调查' : '开始调查'}<ArrowRightIcon /></span>
          </button>
        })}
      </section>
    </main>{finaleReplay}</>
  }

  return (
    <main className="app-shell game-shell">
      {appNav}
      <header className="topbar">
        <div>
          <p className="eyebrow">第 {activeStory.chapter} 章</p>
          <h1>{level.title}</h1>
          <p className="story-beat">{activeStory.storyBeat}</p>
        </div>
        <div className="progress" aria-label={`已找到 ${foundIds.length} 个，共 ${targets.length} 个`}>
          <span>线索进度</span>
          <strong>{foundIds.length} / {targets.length}</strong>
        </div>
        <div className="audio-controls" aria-label="声音控制">
          <button aria-pressed={soundEnabled} onClick={() => setSoundEnabled((value) => !value)} type="button">音效 {soundEnabled ? '开' : '关'}</button>
          <button aria-pressed={musicEnabled} onClick={() => setMusicEnabled((value) => !value)} type="button">音乐 {musicEnabled ? '开' : '关'}</button>
        </div>
      </header>

      <nav className="case-breadcrumb" aria-label="当前位置">
        <button type="button" onClick={goHome}>首页</button><span aria-hidden="true">/</span>
        <button type="button" onClick={goMainCases}>精选故事</button><span aria-hidden="true">/</span>
        <button type="button" onClick={openMainCase}>沿着星图，找回制图师</button><span aria-hidden="true">/</span>
        <strong aria-current="page">案件 {String(activeStory.chapter).padStart(2, '0')}：{level.title}</strong>
        <button className="return-home" type="button" onClick={goHome}><ArrowLeftIcon />返回首页</button>
      </nav>

      <section className="play-area">
        {!ready && <div className="loading">正在布置侦探的书桌…</div>}
        <PhaserGame
          key={level.id}
          hintRequest={hintRequest}
          level={level}
          onReady={onReady}
          onFound={onFound}
          onWrongClick={onWrongClick}
          onComplete={onComplete}
        />
      </section>

      <section className="mission-panel" aria-label="待寻找线索">
        <button className="hint-button" type="button" onClick={() => requestHint()} disabled={complete}>
          <BulbIcon />
          提示
        </button>
        <div className="target-list">
          {targets.map((target) => {
            const found = foundIds.includes(target.id)
            return <button
              aria-label={`获取 ${target.name} 的下一段文字提示`}
              className={`target-card ${found ? 'is-found' : ''}`}
              disabled={found}
              key={target.id}
              onClick={() => requestHint(target.id, false)}
              type="button"
            >
              {found
                ? <CheckIcon />
                : <img alt="" className="target-thumbnail" src={target.thumbnailUrl} />}
            </button>
          })}
        </div>
        <p className="mistakes">误判 {wrongClicks} 次</p>
      </section>

      {hintText && <div className="hint-toast" role="status">{hintText}</div>}

      {introOpen && <div className="completion case-intro" role="dialog" aria-modal="true" aria-label="案件档案">
        <div className="completion-card case-intro-card">
          <p className="eyebrow">第 {activeStory.chapter} 章</p>
          <h2>{level.title}</h2>
          <p className="case-file">{activeStory.caseFile}</p>
          <div className="case-objective">
            <span>本关目标</span>
            <strong>{activeStory.objective}</strong>
          </div>
          <div className="case-difficulty">
            <span>调查难度</span>
            <strong>{activeStory.difficulty}</strong>
            <small>{activeStory.investigationTip}</small>
          </div>
          <div className="completion-actions">
            <button className="secondary-action" type="button" onClick={goHome}>返回首页</button>
            <button type="button" onClick={() => setIntroOpen(false)}>开始调查<ArrowRightIcon /></button>
          </div>
        </div>
      </div>}

      {complete && outroOpen && activeOutro && <div className="outro-cutscene" role="dialog" aria-modal="true" aria-label={`${activeOutro.title}剧情过场`}>
        <video
          autoPlay
          className="outro-video"
          key={activeOutro.videoUrl}
          muted={!soundEnabled}
          onEnded={() => setOutroOpen(false)}
          onError={() => setOutroOpen(false)}
          playsInline
          src={activeOutro.videoUrl}
        />
        <div className="outro-copy">
          <p className="eyebrow">{isCampaignFinale ? '主线结案' : '案件推进'}</p>
          <h2>{activeOutro.title}</h2>
          <p>{activeOutro.narration}</p>
        </div>
        <button className="outro-skip" type="button" onClick={() => setOutroOpen(false)}>{isCampaignFinale ? '跳过结案影片' : '跳过剧情'}</button>
      </div>}

      {complete && !outroOpen && <div className="completion" role="dialog" aria-modal="true" aria-label="关卡完成">
        <div className="completion-card">
          <p className="eyebrow">{isCampaignFinale ? '主线已结案' : '案件已归档'}</p>
          <h2>{isCampaignFinale ? '沿着星图，找回制图师' : '所有线索都已找到'}</h2>
          <p>{activeStory.completionText}</p>
          <div className="completion-actions">
            {nextChapter !== null
              ? <button type="button" onClick={() => selectChapter(nextChapter)}>前往下一关<ArrowRightIcon /></button>
              : <button type="button" onClick={returnToCaseList}>{isCampaignFinale ? '返回首页' : '返回案件列表'}</button>}
            {isCampaignFinale && <button className="secondary-action" type="button" onClick={() => setOutroOpen(true)}>播放结案影片</button>}
            <button className="secondary-action" type="button" onClick={resetLevel}>重新调查</button>
          </div>
        </div>
      </div>}
    </main>
  )
}

export default App
