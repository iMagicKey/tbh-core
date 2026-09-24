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
    }
  }
}
