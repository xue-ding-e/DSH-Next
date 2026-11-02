/** Test transport boundary: no Host or Client Context declarations cross it. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox/types'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

export interface DirectoryHostBridge {
  readonly sessionId: SessionId
  readonly source: string
  readonly reference: string
  readonly primary: string
  invoke(method: string, request: unknown, signal?: AbortSignal): Promise<RemoteResult<unknown>>
  invokeOther(method: string, request: unknown): Promise<RemoteResult<unknown>>
  lifecycle(listener: (sessionId: SessionId) => void): () => void
  probe(directory: 'source' | 'reference'): Promise<void>
  mode(mode: SandboxMode): void
  writeSupport(supported: boolean): void
  replaceSession(): Promise<void>
  removeSourceDirectory(): Promise<void>
  initializeWorkspace(): Promise<WorkspaceView>
  invokeWorkspace(request: unknown): Promise<RemoteResult<WorkspaceView>>
  changed(listener: (sessionId: SessionId) => void): () => void
  dispose(): Promise<void>
}
export type DirectoryHostFactory = () => Promise<DirectoryHostBridge>
