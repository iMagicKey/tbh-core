import { useCallback, useEffect, useState } from 'react'
import type { MemoryLiveDto, MemoryStatusDto } from '../../shared/memory-source'

const copy = {
  en: {
    title: 'Live run',
    game: 'Game',
    stage: 'Stage',
    timer: 'Timer',
    xp: 'XP',
    gold: 'Gold',
    dps: 'DPS',
    damage: 'Damage',
    mobs: 'Mobs',
    party: 'Party',
    detecting: 'Waiting for the memory reader…',
    unsupported: 'This Task Bar Hero build is not supported yet. Update TBH Core after a new profile ships.',
    unavailable: 'Memory telemetry unavailable in this build of TBH Core.',
    restart: 'Restart reader',
    never: 'never',
  },
  ru: {
    title: 'Текущий ран',
    game: 'Игра',
    stage: 'Стадия',
    timer: 'Таймер',
    xp: 'XP',
    gold: 'Золото',
    dps: 'DPS',
    damage: 'Урон',
    mobs: 'Мобы',
    party: 'Отряд',
    detecting: 'Ожидание модуля чтения памяти…',
    unsupported: 'Эта сборка Task Bar Hero пока не поддерживается. Обновите TBH Core после выхода нового профиля.',
    unavailable: 'Телеметрия памяти недоступна в этой сборке TBH Core.',
    restart: 'Перезапустить ридер',
    never: 'никогда',
  },
} as const

type Locale = keyof typeof copy

const DIFFICULTIES = ['Normal', 'Nightmare', 'Hell', 'Torment']

function fmt(n: number | null): string {
  if (n === null) return '—'
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return `${Math.round(n)}`
}

function fmtTimer(ms: number | null): string {
  if (ms === null) return '—'
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  const tenth = Math.floor((ms % 1000) / 100)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenth}`
}

export function MemoryLive({ locale }: { locale: Locale }) {
  const t = copy[locale]
  const [status, setStatus] = useState<MemoryStatusDto | null>(null)
  const [live, setLive] = useState<MemoryLiveDto | null>(null)

  const reload = useCallback(() => {
    void window.tbhCore?.getMemoryStatus().then(setStatus)
    void window.tbhCore?.getMemoryLive().then(setLive)
  }, [])

  useEffect(() => {
    reload()
    const timer = window.setInterval(reload, 1_000)
    return () => window.clearInterval(timer)
  }, [reload])

  const state = status?.state ?? 'disconnected'
  const unsupported = state === 'unsupported_game_version'
  const missing = status?.reasonCode === 'HELPER_MISSING'
  const showRun = state === 'healthy' || state === 'degraded'
  const stageLabel = live?.stageKey !== null && live?.stageKey !== undefined
    ? `${live.stageKey}${live.difficulty !== null && live.difficulty !== undefined ? ` ${DIFFICULTIES[live.difficulty] ?? ''}` : ''}`.trim()
    : '—'
  const run = live?.run

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{t.title}</h3>
        <span
          className={`text-sm font-medium ${
            state === 'healthy' ? 'text-emerald-400' : state === 'degraded' ? 'text-amber-400'
              : unsupported ? 'text-red-400' : 'text-zinc-400'
          }`}
        >
          {state}
        </span>
      </div>

      {unsupported && <p className="text-sm text-amber-300/80">{t.unsupported}</p>}
      {missing && <p className="text-sm text-zinc-500">{t.unavailable}</p>}
      {!unsupported && !missing && !showRun && <p className="text-sm text-zinc-500">{t.detecting}</p>}

      {showRun && (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{t.game}</dt>
            <dd className="mt-0.5 text-zinc-200">{live?.gameVersion ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{t.stage}</dt>
            <dd className="mt-0.5 text-zinc-200">{stageLabel}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{t.timer}</dt>
            <dd className="mt-0.5 font-mono text-zinc-200">{fmtTimer(run?.elapsedMs ?? null)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{t.mobs}</dt>
            <dd className="mt-0.5 text-zinc-200">
              {run?.mobsKilled ?? '—'} / {run?.mobsTotal ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{t.xp}</dt>
            <dd className="mt-0.5 text-emerald-300">+{fmt(run?.xpSoFar ?? null)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{t.gold}</dt>
            <dd className="mt-0.5 text-amber-300">+{fmt(run?.goldSoFar ?? null)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{t.dps}</dt>
            <dd className="mt-0.5 text-zinc-200">{fmt(run?.dps ?? null)}/s</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{t.damage}</dt>
            <dd className="mt-0.5 text-zinc-200">{fmt(run?.damage ?? null)}</dd>
          </div>
        </dl>
      )}

      {showRun && (live?.heroes?.length ?? 0) > 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          {t.party}:{' '}
          {live?.heroes
            .map((h) => `${h.heroKey}/L${h.level ?? '?'}${h.xpSoFar !== null ? ` +${fmt(h.xpSoFar)}` : ''}`)
            .join('  ·  ')}
        </p>
      )}

      <div className="mt-4">
        <button
          type="button"
          onClick={() => {
            void window.tbhCore?.restartMemorySource().then(() => reload())
          }}
          className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          {t.restart}
        </button>
      </div>
    </section>
  )
}
