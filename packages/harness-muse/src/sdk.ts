import {
  MuseClient,
  type ApprovalDecisionInput,
  type ApprovalHandler,
  type FoldedItem,
  type Turn,
  type TurnOutcome,
} from '@muse-code/sdk';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReportTurnOptions } from '@qa/evidence-pipeline';
import { MuseHarnessError } from './errors.js';

type ApprovalRequest = Parameters<ApprovalHandler>[0];

export const MUSE_SDK_VERSION = '0.1.1' as const;
export const MUSE_HOST_ARGUMENTS = ['serve'] as const;
/**
 * Least-authority approval posture: every tool request routes to Sentry's
 * explicit decider instead of letting the host pre-resolve matches. The
 * sandbox boundary is orthogonal and stays enforced by the host in every
 * mode; this mode grants nothing silently. Verified against the live 1.1.1
 * host (see the live regression), where unmatched pipeline stages still
 * arrive as decidable requests.
 */
export const MUSE_APPROVAL_MODE = 'onRequest' as const;
export type MuseFoldedItem = FoldedItem;
export type MuseTurnOutcome = TurnOutcome;

export interface MuseTurnView {
  readonly items: () => AsyncIterableIterator<FoldedItem>;
  readonly completed: Promise<TurnOutcome>;
}

export interface MuseApprovalDecision {
  readonly approvalId: string;
  readonly toolName: string;
  readonly choiceId: string;
  readonly approved: boolean;
  readonly reason: string;
}

export interface MuseFatalApproval {
  readonly approvalId: string;
  readonly toolName: string;
  readonly reason: string;
}

export interface MuseSessionView {
  /** Phase-scoped send: tools stay enabled for planning/investigation;
   *  reporting turns run under the adapter-side tool firewall. */
  sendText(text: string, options?: ReportTurnOptions): Promise<MuseTurnView>;
  /** Approval decisions made by the workspace-scoped auto-decider. */
  drainApprovalDecisions(): readonly MuseApprovalDecision[];
  /**
   * Registers a hook invoked when an approval round trip fails fatally
   * (fail-closed refusal with no safe choice, or submit failure). The
   * adapter uses this to tear down the owned session promptly instead of
   * parking the turn until the watchdog. Optional for test fakes.
   */
  onFatalApproval?(handler: (fatal: MuseFatalApproval) => void): void;
}

/**
 * Host compatibility facts from the MSP handshake (no credentials, no model
 * identity claims beyond what the host reports). Unknown protocol states
 * warn or fail closed downstream instead of being silently assumed.
 */
export interface MuseHostCompatibility {
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly schemaFingerprint?: string;
  readonly schemaVersion?: number;
  readonly grantedCapabilities?: readonly string[];
  readonly platformFamily?: string;
  readonly platformOs?: string;
}

export interface MuseClientView {
  readonly serverVersion?: string;
  readonly compatibility?: MuseHostCompatibility;
  startSession(input: {
    readonly workspaceRoot: string;
    readonly modelId: string;
  }): Promise<MuseSessionView>;
  close(): Promise<void>;
}

export type MuseClientFactory = (input: {
  readonly executable: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onStderr: (chunk: string) => void;
  readonly shutdownTimeoutMs: number;
}) => Promise<MuseClientView>;

/**
 * Non-interactive approval policy for the isolated QA worker. FAIL-CLOSED.
 *
 * The host parks tool calls it cannot auto-resolve as `human_pending` and
 * waits forever without a decision (observed live: a `vitest run | head`
 * pipeline parked the whole session). Sentry answers every request itself.
 *
 * Allowlist, all required simultaneously for approval:
 * - known subject kind: shell | fileAccess | process | tool (unknown kinds
 *   are denied; the MSP subject union is open and future kinds are never
 *   inferred safe);
 * - safe network only: kind is not network and no host/port/protocol
 *   endpoint, UNLESS the endpoint is loopback (the agent's own servers,
 *   localhost QA) or a versioned package-registry host (dependency QA);
 *   every other network destination is denied — network access is
 *   attributable QA capability, not a general egress grant;
 * - no protectedWrite, no judgeEscalated;
 * - POSITIVE containment proof: the subject workspace root canonicalizes
 *   inside the Sentry workspace (missing workspaceRoot denies unless another
 *   authoritative subject field proves containment); fileAccess additionally
 *   requires its target path to resolve inside the workspace;
 * - a server-offered one-action approval (decision approved, scope once).
 *   Session-persistent or policy-amending approvals are never chosen:
 *   Sentry must not mutate the user's persistent Muse policy as a QA side
 *   effect.
 *
 * Denial selects a server-offered abort (or once-scoped denial); choice IDs
 * are never invented. If no safe choice exists in either direction the
 * decider throws so the failure is loud (the turn watchdog stays the last
 * safety net, never the normal path).
 *
 * This selects an approval policy; it never disables sandboxing. The host
 * enforces its sandbox on every approved command.
 */
// 'network' is listed so attributable QA endpoints (loopback, versioned
// registries) can be approved below; every other network destination is
// denied by the endpoint check, never by kind membership alone.
const APPROVABLE_SUBJECT_KINDS = new Set(['shell', 'fileAccess', 'process', 'tool', 'network']);

export function canonicalizeApprovalPath(value: string): string {
  const slashed = value.replace(/\\/g, '/');
  const parts = slashed.split('/');
  const absolute = slashed.startsWith('/');
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? '') ? (parts.shift() as string) : undefined;
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop();
      else if (!absolute && drive === undefined) stack.push('..');
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join('/');
  const rooted = (absolute ? '/' : '') + (drive === undefined ? '' : drive + '/') + joined;
  const normalized = rooted === '' ? '.' : rooted;
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function realpathOfExisting(value: string): string | undefined {
  try {
    return canonicalizeApprovalPath(realpathSync.native(value));
  } catch {
    return undefined;
  }
}

function parentOf(canonicalSlashPath: string): string | undefined {
  if (canonicalSlashPath === '/' || canonicalSlashPath === '.') return undefined;
  const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(canonicalSlashPath);
  if (driveMatch !== null) {
    const rest = driveMatch[2] ?? '';
    if (rest === '' || rest === '/') return undefined;
    const slash = rest.lastIndexOf('/');
    if (slash <= 0) return driveMatch[1] + '/';
    return driveMatch[1] + rest.slice(0, slash);
  }
  const trimmed = canonicalSlashPath.replace(/\/$/, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return trimmed.startsWith('/') ? '/' : undefined;
  return trimmed.slice(0, slash);
}

export function isPathInsideApprovalRoot(candidate: string, root: string): boolean {
  // Compare host-absolute spellings. On Windows, a root-qualified path such
  // as `/tmp/workspace` resolves onto the current drive; keeping it as `/tmp`
  // while realpath returns `c:/tmp` creates a false symlink-escape verdict.
  const base = canonicalizeApprovalPath(resolve(root));
  const lexical = canonicalizeApprovalPath(resolve(candidate));
  // Identical canonical strings denote the same path: the session workspace
  // is Sentry-created, so no traversal is expressible.
  if (lexical === base) return true;
  // Lexical gate first: traversal and sibling-prefix escapes fail here even
  // when nothing exists on disk.
  const lexicallyInside = lexical.startsWith(base.endsWith('/') ? base : base + '/');
  if (!lexicallyInside) return false;
  // Trusted root resolves first: the workspace itself might be symlinked.
  const liveRoot = realpathOfExisting(root) ?? base;
  const insideLiveRoot = (resolved: string): boolean =>
    resolved === liveRoot ||
    resolved.startsWith(liveRoot.endsWith('/') ? liveRoot : liveRoot + '/');
  // Walk upward to the nearest existing ancestor (the candidate itself when
  // it exists) and resolve THAT. Components below it do not exist, so no
  // symlink among them can redirect.
  let cursor: string | undefined = lexical;
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const resolved = realpathOfExisting(cursor);
    if (resolved !== undefined) {
      if (insideLiveRoot(resolved)) return true;
      // Resolved outside: deny ONLY on proven redirection (the resolved
      // form differs from the lexical ancestor, so a symlink diverted the
      // path). A plain missing subtree under a real outside directory
      // (e.g. unit fixtures) has no redirection: creating it is safe and
      // the lexical verdict above already passed.
      const canonicalAncestor = canonicalizeApprovalPath(cursor);
      return resolved !== canonicalAncestor ? false : true;
    }
    cursor = parentOf(cursor);
  }
  // Nothing on disk up to the filesystem root: nothing contradicts the
  // lexical verdict.
  return true;
}

/** Loopback hosts: the agent's own environment (local servers, DBs,
 *  localhost QA). Safe regardless of port/protocol — loopback cannot
 *  leave the machine, and the host sandbox still constrains the command. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return quad !== null && quad[1] === '127';
}

/** Versioned package-registry hosts: dependency QA (npm install, pip
 *  install, go mod download). Exact-host match only — host identity is
 *  the control; ports/protocols are not separately constrained. */
const QA_REGISTRY_HOSTS: ReadonlySet<string> = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'crates.io',
  'static.crates.io',
  'rubygems.org',
]);

/** Safe QA network endpoint: loopback (own servers) or a versioned
 *  registry host. Everything else — including bare 'network' kinds
 *  without an attributable host — is denied. */
function isSafeQaNetworkEndpoint(subject: ApprovalSubjectView): boolean {
  if (typeof subject.host !== 'string' || subject.host.length === 0) return false;
  const host = subject.host.toLowerCase();
  return isLoopbackHost(host) || QA_REGISTRY_HOSTS.has(host);
}

interface ApprovalSubjectView {
  readonly kind?: unknown;
  readonly workspaceRoot?: unknown;
  readonly path?: unknown;
  readonly target?: unknown;
  readonly host?: unknown;
  readonly port?: unknown;
  readonly protocol?: unknown;
}

export function decideMuseApproval(
  request: ApprovalRequest,
  workspaceRoot: string,
): ApprovalDecisionInput & { readonly approved: boolean; readonly reason: string } {
  const choices = request.availableChoices ?? [];
  const failClosed = (reason: string): never => {
    // Thrown inside the SDK notification pump: surfaces via onApprovalError
    // (recorded as a denied decision), never as an invented choice. Reuses
    // MUSE_INVALID_RESULT because the request cannot be satisfied within
    // Sentry's safety contract; the turn watchdog stays the last backstop.
    throw new MuseHarnessError(
      'MUSE_INVALID_RESULT',
      'Refusing Muse approval without a safe server-offered choice (' + reason + ').',
    );
  };
  const deny = (reason: string) => {
    const abort = choices.find((choice) => choice.decision === 'abort');
    const onceDenial = choices.find(
      (choice) => choice.decision === 'denied' && choice.scope === 'once',
    );
    const selected = abort ?? onceDenial;
    if (selected === undefined) failClosed(reason);
    return {
      choiceId: (selected as { choiceId: string }).choiceId,
      feedback: null,
      approved: false as const,
      reason,
    };
  };
  const subject = (request.subject ?? {}) as ApprovalSubjectView;
  if (typeof subject.kind !== 'string' || !APPROVABLE_SUBJECT_KINDS.has(subject.kind))
    return deny('unknown subject kind is never auto-approved');
  if (request.protectedWrite === true)
    return deny('protected-write subjects are never auto-approved');
  if (request.judgeEscalated === true)
    return deny('judge-escalated subjects are never auto-approved');
  // QA network attribution (§22-23): loopback (own servers) and versioned
  // registry hosts are normal investigative capability; every other
  // destination — including endpoint-less network kinds — stays denied.
  // Safe network subjects carry their own containment (the destination
  // is loopback or a versioned registry), so they resolve here without a
  // workspace-root proof that network subjects never carry.
  if (subject.kind === 'network') {
    if (!isSafeQaNetworkEndpoint(subject))
      return deny('non-QA network subjects are never auto-approved');
    const once = choices.find(
      (choice) => choice.decision === 'approved' && choice.scope === 'once',
    );
    if (once === undefined)
      return deny('no server-offered one-action approval; persistent approvals are never chosen');
    return {
      choiceId: once.choiceId,
      feedback: null,
      approved: true as const,
      reason: 'safe QA network endpoint auto-approved for one action',
    };
  } else if (
    subject.host !== undefined ||
    subject.port !== undefined ||
    subject.protocol !== undefined
  ) {
    if (!isSafeQaNetworkEndpoint(subject))
      return deny('subjects with non-QA network endpoints are never auto-approved');
  }
  if (subject.kind === 'fileAccess') {
    const target =
      typeof subject.path === 'string'
        ? subject.path
        : typeof subject.target === 'string'
          ? subject.target
          : undefined;
    if (target === undefined) return deny('file access without a target is never auto-approved');
    const absolute =
      target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
        ? target
        : workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/' + target;
    if (!isPathInsideApprovalRoot(absolute, workspaceRoot))
      return deny('file target outside the isolated Sentry workspace is never auto-approved');
  } else {
    if (typeof subject.workspaceRoot !== 'string' || subject.workspaceRoot.length === 0)
      return deny('missing subject workspace proof is never auto-approved');
    if (!isPathInsideApprovalRoot(subject.workspaceRoot, workspaceRoot))
      return deny('subject workspace outside the isolated Sentry workspace is never auto-approved');
  }
  const once = choices.find((choice) => choice.decision === 'approved' && choice.scope === 'once');
  if (once === undefined)
    return deny('no server-offered one-action approval; persistent approvals are never chosen');
  return {
    choiceId: once.choiceId,
    feedback: null,
    approved: true as const,
    reason: 'workspace-contained subject auto-approved for one action',
  };
}

class ProductionSession implements MuseSessionView {
  private readonly decisions: MuseApprovalDecision[] = [];
  private fatalHandler?: (fatal: MuseFatalApproval) => void;

  constructor(
    private readonly session: Awaited<ReturnType<MuseClient['startSession']>>,
    private readonly workspaceRoot: string,
  ) {
    const inner = this.session as unknown as {
      onApproval?: (handler: ApprovalHandler) => void;
      onApprovalError?: (handler: (failure: unknown) => void) => void;
    };
    inner.onApproval?.((request: ApprovalRequest) => {
      const verdict = decideMuseApproval(request, this.workspaceRoot);
      this.decisions.push({
        approvalId: request.approvalId,
        toolName: request.toolName,
        choiceId: verdict.choiceId,
        approved: verdict.approved,
        reason: verdict.reason,
      });
      return { choiceId: verdict.choiceId, feedback: verdict.feedback ?? null };
    });
    inner.onApprovalError?.((failure) => {
      const reason = 'approval round trip failed: ' + String(failure).slice(0, 300);
      this.decisions.push({
        approvalId: 'unknown',
        toolName: 'unknown',
        choiceId: 'error',
        approved: false,
        reason,
      });
      // Fail fast: an unanswered approval parks the turn indefinitely.
      // The adapter tears down the owned session; the watchdog stays only
      // as defense-in-depth.
      try {
        this.fatalHandler?.({ approvalId: 'unknown', toolName: 'unknown', reason });
      } catch {
        // never let observer errors mask the recorded decision
      }
    });
  }

  onFatalApproval(handler: (fatal: MuseFatalApproval) => void): void {
    this.fatalHandler = handler;
  }

  async sendText(text: string, options?: ReportTurnOptions): Promise<Turn> {
    // The Muse SDK has no native empty-tools turn: tool denial during
    // reporting is enforced by the adapter-side item firewall, not here.
    // Options are accepted for the uniform phase-scoped API.
    void options;
    return this.session.sendUserTurn({ input: [{ type: 'text', text }] });
  }

  drainApprovalDecisions(): readonly MuseApprovalDecision[] {
    return this.decisions.splice(0);
  }
}

export const createProductionMuseClient: MuseClientFactory = async (input) => {
  const client = await MuseClient.spawn({
    museBin: input.executable,
    args: [...MUSE_HOST_ARGUMENTS],
    cwd: input.cwd,
    env: input.environment,
    clientInfo: { name: 'sentry', version: '0.3.0' },
    onStderr: input.onStderr,
    shutdownTimeoutMs: input.shutdownTimeoutMs,
  });
  const handshake = client.initializeResult as unknown as {
    serverInfo?: { name?: unknown; version?: unknown };
    schema?: { fingerprint?: unknown; version?: unknown };
    grantedCapabilities?: unknown;
    platformFamily?: unknown;
    platformOs?: unknown;
  };
  const textOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  const compatibility: MuseHostCompatibility = {
    ...(textOf(handshake.serverInfo?.name) === undefined
      ? {}
      : { serverName: textOf(handshake.serverInfo?.name) as string }),
    ...(textOf(handshake.serverInfo?.version) === undefined
      ? {}
      : { serverVersion: textOf(handshake.serverInfo?.version) as string }),
    ...(textOf(handshake.schema?.fingerprint) === undefined
      ? {}
      : { schemaFingerprint: textOf(handshake.schema?.fingerprint) as string }),
    ...(typeof handshake.schema?.version === 'number'
      ? { schemaVersion: handshake.schema.version }
      : {}),
    ...(Array.isArray(handshake.grantedCapabilities)
      ? {
          grantedCapabilities: (handshake.grantedCapabilities as unknown[])
            .filter((entry): entry is string => typeof entry === 'string')
            .slice(0, 50),
        }
      : {}),
    ...(textOf(handshake.platformFamily) === undefined
      ? {}
      : { platformFamily: textOf(handshake.platformFamily) as string }),
    ...(textOf(handshake.platformOs) === undefined
      ? {}
      : { platformOs: textOf(handshake.platformOs) as string }),
  };
  return {
    serverVersion: client.initializeResult.serverInfo.version,
    compatibility,
    startSession: async ({ workspaceRoot, modelId }) =>
      new ProductionSession(
        await client.startSession({
          workspaceRoot,
          modelId,
          providerId: 'meta',
          // Non-interactive approval selection; Muse sandboxing remains enabled by default.
          approvalMode: MUSE_APPROVAL_MODE,
        }),
        workspaceRoot,
      ),
    close: () => client.close(),
  };
};
