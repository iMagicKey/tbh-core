import { useEffect, useMemo, useState } from 'react'

type Page = 'Live' | 'Farm' | 'Runs' | 'Compare'

const pages: Page[] = ['Live', 'Farm', 'Runs', 'Compare']

const copy = {
  en: {
    subtitle: 'Telemetry & farming analytics',
    waiting: 'Waiting for Task Bar Hero data sources',
    sourceHint: 'Save, memory and Player.log integrations will be added in the next phases.',
    settings: 'Settings',
  },
  ru: {
    subtitle: 'Телеметрия и аналитика фарма',
    waiting: 'Ожидание источников данных Task Bar Hero',
    sourceHint: 'Save, memory и Player.log будут подключены на следующих этапах.',
    settings: 'Настройки',
  },
} as const

export function App() {
  const [page, setPage] = useState<Page>('Live')
  const [locale, setLocale] = useState<'en' | 'ru'>('en')
  const [version, setVersion] = useState('dev')
  const t = useMemo(() => copy[locale], [locale])

  useEffect(() => {
    void window.tbhCore?.getVersion().then(setVersion)
  }, [])

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950/95 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6">
          <div>
            <div className="flex items-baseline gap-3">
              <h1 className="text-xl font-semibold tracking-tight">TBH Core</h1>
              <span className="text-xs text-zinc-500">v{version}</span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">{t.subtitle}</p>
          </div>

          <nav className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
            {pages.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setPage(item)}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  page === item ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
                }`}
              >
                {item}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLocale(locale === 'en' ? 'ru' : 'en')}
              className="rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
            >
              {locale.toUpperCase()}
            </button>
            <button type="button" className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">
              {t.settings}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">{page}</h2>
          <div className="flex gap-3 text-xs">
            <span className="rounded-full border border-zinc-800 px-3 py-1 text-zinc-500">Memory: offline</span>
            <span className="rounded-full border border-zinc-800 px-3 py-1 text-zinc-500">Save: offline</span>
            <span className="rounded-full border border-zinc-800 px-3 py-1 text-zinc-500">Log: offline</span>
          </div>
        </div>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8">
          <div className="max-w-xl">
            <p className="text-lg font-medium">{t.waiting}</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500">{t.sourceHint}</p>
          </div>
        </section>
      </main>
    </div>
  )
}
