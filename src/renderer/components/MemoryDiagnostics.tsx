import { useCallback, useEffect, useState } from 'react'
import type { MemoryStatusDto } from '../../shared/memory-source'

const copy = {
  en: {
    title: 'Memory source',
    state: 'State',
    reason: 'Reason',
    gameVersion: 'Game version',
    fingerprint: 'Fingerprint',
    profile: 'Profile',
    reader: 'Reader version',
    epoch: 'Health epoch',
    lastRejected: 'Last rejected run',
    never: '—',
    none: '—',
  },
  ru: {
    title: 'Источник памяти',
    state: 'Состояние',
    reason: 'Причина',
    gameVersion: 'Версия игры',
    fingerprint: 'Отпечаток',
    profile: 'Профиль',
    reader: 'Версия ридера',
    epoch: 'Эпоха здоровья',
    lastRejected: 'Последний отклонённый ран',
    never: '—',
    none: '—',
  },
} as const

type Locale = keyof typeof copy

function shortFingerprint(fp: string | null): string {
  if (!fp) return '—'
  if (fp.length <= 24) return fp
  return `${fp.slice(0, 12)}…${fp.slice(-8)}`
}

function shortEpoch(epoch: string | null): string {
  if (!epoch) return '—'
  return epoch.length > 40 ? `${epoch.slice(0, 36)}…` : epoch
}

export function MemoryDiagnostics({ locale }: { locale: Locale }) {
  const t = copy[locale]
  const [status, setStatus] = useState<MemoryStatusDto | null>(null)

  const reload = useCallback(() => {
    void window.tbhCore?.getMemoryStatus().then(setStatus)
  }, [])

  useEffect(() => {
    reload()
    const timer = window.setInterval(reload, 2_000)
    return () => window.clearInterval(timer)
  }, [reload])

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{t.title}</h3>
        <span
          className={`text-sm font-medium ${
            status?.state === 'healthy'
              ? 'text-emerald-400'
              : status?.state === 'degraded'
                ? 'text-amber-400'
                : status?.state === 'unsupported_game_version' || status?.state === 'calibration_failed'
                  ? 'text-red-400'
                  : 'text-zinc-400'
          }`}
        >
          {status?.state ?? 'disconnected'}
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.reason}</dt>
          <dd className="font-mono text-xs text-zinc-300">{status?.reasonCode ?? t.none}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.gameVersion}</dt>
          <dd className="text-zinc-300">{status?.gameVersion ?? t.none}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.fingerprint}</dt>
          <dd className="font-mono text-xs text-zinc-300" title={status?.gameFingerprint ?? undefined}>
            {shortFingerprint(status?.gameFingerprint ?? null)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.profile}</dt>
          <dd className="font-mono text-xs text-zinc-300">{status?.profileId ?? t.none}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.reader}</dt>
          <dd className="font-mono text-xs text-zinc-300">{status?.readerVersion ?? t.none}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.epoch}</dt>
          <dd className="truncate font-mono text-xs text-zinc-300" title={status?.healthEpoch ?? undefined}>
            {shortEpoch(status?.healthEpoch ?? null)}
          </dd>
        </div>
        <div className="flex justify-between gap-4 sm:col-span-2">
          <dt className="text-zinc-500">{t.lastRejected}</dt>
          <dd className="truncate font-mono text-xs text-zinc-500">
            {status?.lastRejectedRunReason
              ? `${status.lastRejectedRunReason.code}${
                  status.lastRejectedRunReason.detail ? ` (${status.lastRejectedRunReason.detail})` : ''
                }`
              : t.none}
          </dd>
        </div>
      </dl>
    </section>
  )
}
