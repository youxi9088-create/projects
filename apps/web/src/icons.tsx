/** 线性图标集：24px 视窗、currentColor 描边，随文字色与字号缩放 */

const base = {
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
} as const

/** 取景框 Logo：四边露出不同形状的小物件，暗示"发现隐藏物"。viewBox 32×32 */

export function ObserveIcon() {
  return (
    <svg {...base} viewBox="0 0 32 32" strokeWidth={2}>
      <rect x="7.5" y="7.5" width="17" height="17" rx="4.5" fill="none" />
      <circle cx="26.5" cy="9.5" r="3.5" fill="#ffb454" stroke="none" />
      <rect x="2" y="20" width="6" height="6" rx="1.5" fill="#7ed957" stroke="none" />
      <path d="M5 14 L8.5 7 L12 14 Z" fill="#ff7f6b" stroke="none" />
      <path d="M29 21.5 l2.5-2.2 2.5 2.2 -2.5 2.5 z" fill="#45c9c0" stroke="none" />
    </svg>
  )
}

export function CompassIcon() {
  return <svg {...base} strokeWidth={1.6}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1z" />
  </svg>
}

export function CheckIcon() {
  return <svg {...base} strokeWidth={2.4}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>
}

export function ArrowRightIcon() {
  return <svg {...base} strokeWidth={1.8}>
    <path d="M4 12h15" /><path d="m13 6 6 6-6 6" />
  </svg>
}

export function ArrowLeftIcon() {
  return <svg {...base} strokeWidth={1.8}>
    <path d="M20 12H5" /><path d="m11 6-6 6 6 6" />
  </svg>
}

export function BulbIcon() {
  return <svg {...base} strokeWidth={1.6}>
    <path d="M9.5 18h5" /><path d="M10.5 21h3" />
    <path d="M12 3a6 6 0 0 0-3.4 10.9c.3.2.4.5.4.9v1.2h6v-1.2c0-.4.1-.7.4-.9A6 6 0 0 0 12 3Z" />
  </svg>
}

export function CloseIcon() {
  return <svg {...base} strokeWidth={1.8}>
    <path d="M6 6l12 12" /><path d="M18 6 6 18" />
  </svg>
}

export function ClockIcon() {
  return <svg {...base} strokeWidth={1.6}>
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.4 2" />
  </svg>
}

export function LockIcon() {
  return <svg {...base} strokeWidth={1.6}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
  </svg>
}

export function PlayIcon() {
  return <svg {...base} strokeWidth={1.6}>
    <path d="M8 5.5 18.5 12 8 18.5z" />
  </svg>
}

export function AlertIcon() {
  return <svg {...base} strokeWidth={1.8}>
    <path d="M12 5v8" /><path d="M12 17.2v.6" />
  </svg>
}

export function DraftIcon() {
  return <svg {...base} strokeWidth={1.4}>
    <path d="M6 3.5h7.5L18.5 8.5V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" />
    <path d="M13.5 3.5V9h5.5" /><path d="M8.8 13h6.4" /><path d="M8.8 16.4h4.2" />
  </svg>
}

export function StoryIcon() {
  return <svg {...base} strokeWidth={1.4}>
    <path d="M4.5 5.5h15v14h-15z" /><path d="M4.5 9.5h15" /><path d="M8 5.5v-2" /><path d="M16 5.5v-2" />
    <path d="M8 13h8" /><path d="M8 16.4h5" />
  </svg>
}
