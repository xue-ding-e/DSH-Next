/** Process-local, explicit directory approvals. Session replay is never authority. */
import { randomUUID } from 'node:crypto'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PeerScope, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { requestedRootsSchema, type RequestedRootsState } from './session-roots.ts'
import type { RootApprovalPreview, RootApprovalReceipt, SessionDirectoryState, SessionRootRequest } from './types.ts'

const PREVIEW_LIFETIME_MS = 60_000

/** A refused confirmation, safe for the owner-facing controller to explain. */
export class RootApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RootApprovalError'
  }
}

interface Selection {
  readonly state: RequestedRootsState
  readonly policy: SandboxExecutionPolicy
}
interface Providers {
  readonly fs: FileSystem
  readonly sandbox: SandboxProvider
}
interface Grant extends Providers {
  readonly agent: Agent
  readonly rootsRevision: number
  readonly modeRevision: number
  readonly policyKey: string
  readonly roots: readonly string[]
  readonly selection: readonly SessionRootRequest[]
}
interface Ticket extends Providers {
  readonly agent: Agent
  readonly session: Session
  readonly preview: RootApprovalPreview
  readonly policyKey: string
  readonly priorGrant: Grant | undefined
  readonly assertQuiescent: () => void
}

/** Owns at most one outstanding preview per Peer and grants per exact Session. */
export class RootApprovalOwner {
  private readonly tickets = new WeakMap<PeerScope, Ticket>()
  private readonly grants = new WeakMap<Session, Grant>()

  constructor(private readonly policyOwner: object, private readonly selection: (session: Session) => Selection) {}

  /** Read current permissions in the exact Agent execution scope. */
  state(ctx: Context, agent: Agent): SessionDirectoryState {
    this.ownerInvocation(ctx, agent)
    const current = this.selection(agent.session)
    const providers = this.providers(agent)
    return {
      sessionId: agent.id, primaryPath: current.policy.workspaceRoot,
      roots: current.state.roots, rootsRevision: current.state.roots === null ? null : current.state.rootsRevision,
      mode: current.policy.mode,
      deploymentWritableRoots: current.policy.additionalWritableRoots ?? [],
      confirmedRoots: this.confirmedFor(ctx, agent.session),
      activeWritableRoots: this.rootsFor(ctx, agent.session),
      writeSupported: providers.sandbox.supportsAdditionalWritableRoots(current.policy.mode),
      lifetime: 'live-agent',
    }
  }

  /** Save a pending selection from true idle; never carry forward an old grant. */
  async replace(
    ctx: Context, agent: Agent, roots: readonly SessionRootRequest[], expectedRevision: number | null,
    assertQuiescent: () => void,
  ): Promise<SessionDirectoryState> {
    const invocation = this.ownerInvocation(ctx, agent)
    const detached = requestedRootsSchema.parse(roots)
    const initial = this.selection(agent.session)
    const currentRevision = initial.state.roots === null ? null : initial.state.rootsRevision
    if (expectedRevision !== currentRevision) throw new RootApprovalError('Directory selection changed; reload before saving')
    const providers = this.providers(agent)
    const priorGrant = this.grants.get(agent.session)
    this.tickets.delete(invocation.peer)
    return agent.runMaintenance(async (maintenanceSignal) => {
      const signal = AbortSignal.any([invocation.signal, invocation.peer.signal, maintenanceSignal])
      const normalized = await this.normalize({ ...initial, state: { ...initial.state, roots: detached } }, providers, signal, false)
      signal.throwIfAborted()
      this.assertLive(ctx, agent, invocation)
      this.assertSelection(agent, initial.state, keyOf(initial.policy), providers, priorGrant, false)
      assertQuiescent()
      signal.throwIfAborted()
      this.assertLive(ctx, agent, invocation)
      this.assertSelection(agent, initial.state, keyOf(initial.policy), providers, priorGrant, false)
      agent.session.append('sandbox/roots-requested', { roots: normalized })
      this.grants.delete(agent.session)
      return this.state(ctx, agent)
    })
  }

  /** Prepare a Peer-bound snapshot; the Host supplies its synchronous resource fence. */
  async prepare(ctx: Context, agent: Agent, assertQuiescent: () => void): Promise<RootApprovalPreview> {
    const invocation = this.ownerInvocation(ctx, agent)
    this.tickets.delete(invocation.peer)
    const selection = this.selection(agent.session)
    const providers = this.providers(agent)
    const priorGrant = this.grants.get(agent.session)
    const signal = AbortSignal.any([invocation.signal, invocation.peer.signal])
    const roots = await this.normalize(selection, providers, signal)
    this.assertLive(ctx, agent, invocation)
    this.assertSelection(agent, selection.state, keyOf(selection.policy), providers, priorGrant)
    const preview: RootApprovalPreview = Object.freeze({
      sessionId: agent.id,
      nonce: randomUUID(),
      expiresAt: Date.now() + PREVIEW_LIFETIME_MS,
      roots,
      mode: selection.policy.mode,
      workspaceRoot: selection.policy.workspaceRoot,
      deploymentWritableRoots: Object.freeze([...(selection.policy.additionalWritableRoots ?? [])]),
      rootsRevision: selection.state.rootsRevision,
      modeRevision: selection.state.modeRevision,
      lifetime: 'live-agent',
    })
    this.tickets.set(invocation.peer, { ...providers, agent, session: agent.session, preview,
      policyKey: keyOf(selection.policy), priorGrant, assertQuiescent })
    return preview
  }

  /** Consume before any await, then authorize only from true idle under the live Peer. */
  async confirm(ctx: Context, agent: Agent, nonce: string): Promise<RootApprovalReceipt> {
    const invocation = this.ownerInvocation(ctx, agent)
    const ticket = this.tickets.get(invocation.peer)
    this.tickets.delete(invocation.peer)
    if (ticket === undefined || ticket.preview.nonce !== nonce || ticket.agent !== agent || ticket.session !== agent.session) {
      throw new RootApprovalError('Directory confirmation is missing or stale; preview again')
    }
    return agent.runMaintenance(async (maintenanceSignal) => {
      const signal = AbortSignal.any([invocation.signal, invocation.peer.signal, maintenanceSignal])
      this.assertTicket(ctx, ticket, invocation, signal)
      const roots = await this.normalize(this.selection(agent.session), ticket, signal)
      if (JSON.stringify(roots) !== JSON.stringify(ticket.preview.roots)) {
        throw new RootApprovalError('Directory identities changed; preview again')
      }
      this.assertTicket(ctx, ticket, invocation, signal)
      ticket.assertQuiescent()
      // No await or dispatch from this final validation through the private grant write.
      this.assertTicket(ctx, ticket, invocation, signal)
      const writable = Object.freeze(roots.filter(root => root.access === 'write').map(root => root.path))
      this.grants.set(agent.session, { agent, fs: ticket.fs, sandbox: ticket.sandbox,
        rootsRevision: ticket.preview.rootsRevision, modeRevision: ticket.preview.modeRevision,
        policyKey: ticket.policyKey, roots: writable, selection: roots })
      return { sessionId: agent.id, additionalWritableRoots: writable, lifetime: 'live-agent' }
    })
  }

  /** Withdraw this Peer's matching preview without affecting any active grant. */
  cancel(ctx: Context, agent: Agent, nonce: string): void {
    const invocation = this.ownerInvocation(ctx, agent)
    const ticket = this.tickets.get(invocation.peer)
    if (ticket?.agent === agent && ticket.session === agent.session && ticket.preview.nonce === nonce) {
      this.tickets.delete(invocation.peer)
    }
  }

  /** Return only an exact live Agent's still-current grant; never inherit by id or Context. */
  rootsFor(ctx: Context, session: Session): readonly string[] {
    return this.confirmedFor(ctx, session).filter(root => root.access === 'write').map(root => root.path)
  }

  /** Confirmed discovery/context roots, still not a read-sandbox allowlist. */
  confirmedFor(ctx: Context, session: Session): readonly SessionRootRequest[] {
    const grant = this.grants.get(session)
    if (grant === undefined || ctx.get('agents')?.get(session.id) !== grant.agent || grant.agent.session !== session
      || identity(grant.agent.ctx.get('sandboxPolicy')) !== identity(this.policyOwner)) return []
    const current = this.selection(session)
    if (current.state.rootsRevision !== grant.rootsRevision
      || current.state.modeRevision !== grant.modeRevision || keyOf(current.policy) !== grant.policyKey
      || identity(grant.agent.ctx.get('fs')) !== identity(grant.fs) || identity(grant.agent.ctx.get('sandbox')) !== identity(grant.sandbox)) return []
    if (grant.roots.length > 0 && !grant.sandbox.supportsAdditionalWritableRoots(current.policy.mode)) return []
    return grant.selection
  }

  private ownerInvocation(ctx: Context, agent: Agent): RemoteInvocation {
    const invocation = ctx.invocation
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- remote drivers extend PrincipalMap with non-owner identities.
    if (invocation === undefined || invocation.peer.principal.kind !== 'owner') {
      throw new RootApprovalError('Directory permissions require an authenticated owner Remote call')
    }
    this.assertLive(ctx, agent, invocation)
    return invocation
  }

  private assertLive(ctx: Context, agent: Agent, invocation: RemoteInvocation): void {
    invocation.signal.throwIfAborted()
    invocation.peer.signal.throwIfAborted()
    if (ctx.get('agents')?.get(agent.id) !== agent || agent.session.id !== agent.id
      || identity(agent.ctx.get('sandboxPolicy')) !== identity(this.policyOwner)) {
      throw new RootApprovalError('The selected Agent is no longer live')
    }
  }

  private providers(agent: Agent): Providers {
    const fs = agent.ctx.get('fs')
    const sandbox = agent.ctx.get('sandbox')
    if (fs === undefined || sandbox === undefined) throw new RootApprovalError('Directory permission providers are unavailable')
    return { fs, sandbox }
  }

  private assertSelection(
    agent: Agent, state: Pick<RequestedRootsState, 'rootsRevision' | 'modeRevision'>,
    policyKey: string, providers: Providers, priorGrant: Grant | undefined, requireSupport = true,
  ): void {
    const current = this.selection(agent.session)
    if (requireSupport) this.assertSupported(current, providers)
    if (current.state.rootsRevision !== state.rootsRevision || current.state.modeRevision !== state.modeRevision
      || keyOf(current.policy) !== policyKey || identity(agent.ctx.get('fs')) !== identity(providers.fs)
      || identity(agent.ctx.get('sandbox')) !== identity(providers.sandbox) || this.grants.get(agent.session) !== priorGrant) {
      throw new RootApprovalError('The directory selection or execution policy changed; preview again')
    }
  }

  private assertTicket(ctx: Context, ticket: Ticket, invocation: RemoteInvocation, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.assertLive(ctx, ticket.agent, invocation)
    if (ticket.agent.session !== ticket.session || Date.now() >= ticket.preview.expiresAt) {
      throw new RootApprovalError('Directory confirmation expired; preview again')
    }
    this.assertSelection(ticket.agent, ticket.preview, ticket.policyKey, ticket, ticket.priorGrant)
  }

  private assertSupported(selection: Selection, providers: Providers): void {
    if (selection.state.roots?.some(root => root.access === 'write')
      && !providers.sandbox.supportsAdditionalWritableRoots(selection.policy.mode)) {
      throw new RootApprovalError('The current execution backend or mode does not support additional writable directories')
    }
  }

  private async normalize(
    selection: Selection, providers: Providers, signal: AbortSignal, requireSupport = true,
  ): Promise<readonly SessionRootRequest[]> {
    const { fs } = providers
    const requests = selection.state.roots
    if (requests === null) throw new RootApprovalError('This Session has no directory selection to confirm')
    if (requireSupport) this.assertSupported(selection, providers)
    const resolveDirectory = async (path: string): Promise<FsTarget> => {
      const target = await fs.resolve(path, { cwd: selection.policy.workspaceRoot, signal })
      const info = await fs.stat(target, signal)
      if (info?.type !== 'directory') throw new RootApprovalError(`Directory is missing or unavailable: ${path}`)
      signal.throwIfAborted()
      return target
    }
    const writable = await Promise.all([selection.policy.workspaceRoot, ...(selection.policy.additionalWritableRoots ?? [])]
      .map(resolveDirectory))
    const selected: Array<{ root: SessionRootRequest; target: FsTarget }> = []
    for (const request of requests) {
      const target = await resolveDirectory(request.path)
      const path = fs.processPath(target)
      const duplicate = selected.find(entry => entry.root.path === path)
      if (duplicate !== undefined) {
        if (duplicate.root.access !== request.access) throw new RootApprovalError('Directory usage selections conflict')
        continue
      }
      selected.push({ root: Object.freeze({ path, access: request.access }), target })
      if (request.access === 'write') writable.push(target)
    }
    for (const entry of selected) {
      if (entry.root.access === 'reference' && writable.some(target => fs.contains(target, entry.target) || fs.contains(entry.target, target))) {
        throw new RootApprovalError('A reference directory overlaps an effective writable directory')
      }
    }
    return Object.freeze(selected.map(entry => entry.root))
  }
}

function keyOf(policy: SandboxExecutionPolicy): string {
  return JSON.stringify([policy.mode, policy.workspaceRoot, policy.additionalWritableRoots ?? []])
}

/** Cordis creates fresh contextual views; compare the underlying provider generation. */
function identity<T extends object>(service: T | undefined): T | undefined {
  return service === undefined ? undefined : (service as T & { [symbols.original]?: T })[symbols.original] ?? service
}
