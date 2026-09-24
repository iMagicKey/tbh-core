import { useCallback, useEffect, useState } from 'react'
import type { SaveSummaryDto } from '../../shared/save-source'
import type { DatabaseStatsDto, DatabaseStatusDto } from '../../shared/database'

const copy = {
  en: {
    title: 'Save source',
    savePath: 'Save path',
    lastCheckpoint: 'Last checkpoint',
    saveVersion: 'Save version',
    currentStage: 'Current stage',
    wallet: 'Wallet gold',
    combatGold: 'Cumulative combat gold',
    playTime: 'Play time',
    heroes: 'Heroes on save',
    passwordSource: 'Password source',
    refresh: 'Refresh',
    selectSave: 'Select save file…',
    selectGameDir: 'Select game directory…',
    technicalDetail: 'Technical detail',
    never: 'never',
    notAvailable: '—',
    minutes: 'min',
    database: 'Database',
    schema: 'Schema',
    checkpoints: 'Checkpoints',
    runs: 'Runs',
    sessions: 'Sessions',
    lastPersisted: 'Last persisted',
  },
  ru: {
    title: 'Источник Save',
    savePath: 'Путь к сейву',
    lastCheckpoint: 'Последний чекпоинт',
    saveVersion: 'Версия сейва',
    currentStage: 'Текущая стадия',
    wallet: 'Золото (кошелёк)',
    combatGold: 'Накопленное боевое золото',
    playTime: 'Время игры',
    heroes: 'Героев в сейве',
    passwordSource: 'Источник пароля',
    refresh: 'Обновить',
    selectSave: 'Выбрать файл сейва…',
    selectGameDir: 'Указать папку игры…',
    technicalDetail: 'Техническая деталь',
    never: 'никогда',
    notAvailable: '—',
    minutes: 'мин',
    database: 'База данных',
    schema: 'Схема',
    checkpoints: 'Чекпоинты',
    runs: 'Раны',
    sessions: 'Сессии',
    lastPersisted: 'Последняя запись',
  },
} as const

type Locale = keyof typeof copy

function formatTime(ms: number | null, locale: Locale, never: string): string {
  if (ms === null) return never
  return new Date(ms).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US')
}

function formatGold(value: number | null): string {
  if (value === null) return '—'
  return Math.round(value).toLocaleString('en-US')
}

function formatPlayTime(seconds: number | null, minutesLabel: string): string {
  if (seconds === null) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return hours > 0 ? `${hours} h ${minutes} ${minutesLabel}` : `${minutes} ${minutesLabel}`
}

const passwordSourceLabels: Record<string, { en: string; ru: string }> = {
  manual: { en: 'Manual', ru: 'Вручную' },
  game_asset: { en: 'Game asset', ru: 'Из файлов игры' },
  none: { en: 'Unavailable', ru: 'Недоступен' },
}

export function SaveDiagnostics({ locale }: { locale: Locale }) {
  const t = copy[locale]
  const [summary, setSummary] = useState<SaveSummaryDto | null>(null)
  const [dbStatus, setDbStatus] = useState<DatabaseStatusDto | null>(null)
  const [dbStats, setDbStats] = useState<DatabaseStatsDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [showDetail, setShowDetail] = useState(false)

  const reload = useCallback(() => {
    void window.tbhCore?.getSaveSummary().then(setSummary)
    void window.tbhCore?.getDatabaseStatus().then(setDbStatus)
    void window.tbhCore?.getDatabaseStats().then(setDbStats)
  }, [])

  useEffect(() => {
    reload()
    const timer = window.setInterval(reload, 5_000)
    return () => window.clearInterval(timer)
  }, [reload])

  const act = useCallback(async (action: 'refreshSaveSource' | 'selectSaveFile' | 'selectGameDir') => {
    setBusy(true)
    try {
      await window.tbhCore?.[action]()
    } finally {
      setBusy(false)
      reload()
    }
  }, [reload])

  const state = summary?.state ?? 'discovering'
  const stateTone =
    state === 'healthy'
      ? 'text-emerald-400'
      : state === 'stale' || state === 'degraded'
        ? 'text-amber-400'
        : state === 'error'
          ? 'text-red-400'
          : 'text-zinc-400'
  const password = passwordSourceLabels[summary?.passwordProvenance ?? 'none'] ?? passwordSourceLabels.none

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{t.title}</h3>
        <span className={`text-sm font-medium ${stateTone}`}>{state}</span>
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.savePath}</dt>
          <dd className="truncate font-mono text-xs text-zinc-300" title={summary?.savePath ?? undefined}>
            {summary?.savePath ?? t.notAvailable}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.lastCheckpoint}</dt>
          <dd className="text-zinc-300">
            {formatTime(summary?.lastCheckpointAt ?? null, locale, t.never)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.saveVersion}</dt>
          <dd className="text-zinc-300">{summary?.saveVersion ?? t.notAvailable}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.currentStage}</dt>
          <dd className="text-zinc-300">{summary?.currentStageKey ?? t.notAvailable}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.wallet}</dt>
          <dd className="text-zinc-300">{formatGold(summary?.walletGold ?? null)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.combatGold}</dt>
          <dd className="text-zinc-300">{formatGold(summary?.combatGoldEarned ?? null)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.playTime}</dt>
          <dd className="text-zinc-300">{formatPlayTime(summary?.playTimeSeconds ?? null, t.minutes)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.heroes}</dt>
          <dd className="text-zinc-300">{summary?.heroCount ?? t.notAvailable}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-500">{t.passwordSource}</dt>
          <dd className="text-zinc-300">{password[locale]}</dd>
        </div>
      </dl>

      {summary?.detail && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowDetail((value) => !value)}
            className="text-xs text-zinc-500 underline hover:text-zinc-300"
          >
            {t.technicalDetail}
          </button>
          {showDetail && (
            <p className="mt-1 break-all font-mono text-xs text-zinc-500">{summary.detail}</p>
          )}
        </div>
      )}

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{t.database}</h3>
          <span
            className={`text-sm font-medium ${
              dbStatus?.state === 'healthy'
                ? 'text-emerald-400'
                : dbStatus?.state === 'degraded'
                  ? 'text-amber-400'
                  : dbStatus?.state === 'error'
                    ? 'text-red-400'
                    : 'text-zinc-400'
            }`}
          >
            {dbStatus?.state ?? 'uninitialized'}
          </span>
        </div>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">{t.schema}</dt>
            <dd className="text-zinc-300">
              {dbStatus?.schemaVersion !== null && dbStatus?.schemaVersion !== undefined
                ? `v${dbStatus.schemaVersion}`
                : t.notAvailable}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">{t.lastPersisted}</dt>
            <dd className="text-zinc-300">
              {formatTime(dbStatus?.lastWriteAt ?? null, locale, t.never)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">{t.checkpoints}</dt>
            <dd className="text-zinc-300">{dbStats?.checkpointCount ?? t.notAvailable}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">{t.runs}</dt>
            <dd className="text-zinc-300">{dbStats?.runCount ?? t.notAvailable}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">{t.sessions}</dt>
            <dd className="text-zinc-300">{dbStats?.sessionCount ?? t.notAvailable}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('refreshSaveSource')}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {t.refresh}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('selectSaveFile')}
          className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
        >
          {t.selectSave}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('selectGameDir')}
          className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
        >
          {t.selectGameDir}
        </button>
      </div>
    </section>
  )
}
