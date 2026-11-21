// HelperProcess — supervised child process carrying the JSONL protocol.
//
// Production spawns the bundled reader executable with shell:false and
// windowsHide:true; tests inject a fake transport. STDOUT is protocol only;
// STDERR is debug (ignored beyond capture). Clean stop on shutdown; unexpected
// exits surface to the supervisor (MemorySource applies bounded backoff).

import { spawn, type ChildProcess } from 'node:child_process'

export interface HelperTransport {
  pid: number | undefined
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  kill(signal?: NodeJS.Signals): void
}

export interface HelperProcessOptions {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  onStdoutChunk?: (chunk: string) => void
  onStderrChunk?: (chunk: string) => void
  onExit?: (code: number | null) => void
  onError?: (error: Error) => void
}

export class HelperProcess {
  private child: ChildProcess | null = null
  private exited = false

  constructor(private readonly options: HelperProcessOptions) {}

  /** Returns false when the executable could not be spawned (HELPER_MISSING). */
  start(): boolean {
    if (this.child) return true
    this.exited = false
    try {
      this.child = spawn(this.options.command, this.options.args ?? [], {
        shell: false, // NEVER a shell — the command is a controlled path
        windowsHide: true, // no console window for the packaged helper
        env: { ...process.env, ...this.options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      this.child = null
      return false
    }
    this.child.stdout?.setEncoding('utf8')
    this.child.stderr?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.options.onStdoutChunk?.(chunk))
    this.child.stderr?.on('data', (chunk: string) => this.options.onStderrChunk?.(chunk))
    this.child.on('error', (error) => {
      if (this.exited) return
      this.options.onError?.(error)
    })
    this.child.on('exit', (code) => {
      this.exited = true
      this.child = null
      this.options.onExit?.(code)
    })
    return true
  }

  isRunning(): boolean {
    return this.child !== null
  }

  stop(): void {
    if (!this.child) return
    const child = this.child
    this.child = null
    this.exited = true
    try {
      child.kill()
    } catch {
      // already dead
    }
  }
}
