export {}

declare global {
  interface Window {
    tbhCore: {
      getVersion(): Promise<string>
      checkForUpdates(): Promise<
        | { status: 'disabled-in-dev' }
        | { status: 'up-to-date'; version: string }
        | { status: 'available'; version: string }
        | { status: 'error'; message: string }
      >
      getSaveStatus(): Promise<
        import('./save-source').SaveSourceStatus | null
      >
      getSaveSummary(): Promise<
        import('./save-source').SaveSummaryDto | null
      >
      refreshSaveSource(): Promise<
        import('./save-source').SaveSourceStatus | null
      >
      selectSaveFile(): Promise<
        import('./save-source').SaveSourceStatus | null
      >
      selectGameDir(): Promise<
        import('./save-source').SaveSourceStatus | null
      >
    }
  }
}
