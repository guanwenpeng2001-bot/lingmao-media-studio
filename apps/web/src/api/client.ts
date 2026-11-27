import type {
  ApiError,
  Asset,
  AssetImpact,
  AssetPage,
  AssetPatch,
  Batch,
  BatchQuote,
  BatchQuoteInput,
  BillingState,
  CancelJob,
  Canvas,
  CanvasCreate,
  CanvasPage,
  CanvasSave,
  Checkout,
  CheckoutRequest,
  CloneCanvas,
  CreditPack,
  ExportLicense,
  GenerationInput,
  Grant,
  Invite,
  InviteAccept,
  InviteCreate,
  Job,
  JobCreate,
  JobPage,
  LedgerKind,
  LedgerPage,
  Login,
  MediaKind,
  Member,
  Model,
  OtpChallenge,
  OtpSent,
  Plan,
  Portrait,
  PortraitConsent,
  PortraitConsentCreate,
  Preset,
  Project,
  ProjectCreate,
  ProjectGrant,
  ProjectPage,
  ProjectPatch,
  Quote,
  ResumeCanvas,
  Run,
  RunQuote,
  RunQuoteInput,
  Session,
  Storyboard,
  StoryboardRequest,
  Subject,
  SubjectCreate,
  SubjectUpdate,
  Template,
  TemplateCreate,
  Workspace,
  WorkspaceCreate,
  WorkspaceSwitch,
} from './types';

export const API_BASE = '/api/v1';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'ApiClientError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.details = params.details;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export function isApiClientError(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError;
}

// Intent-scoped Idempotency-Key registry so retrying the exact same intent reuses the same key.
const intentKeyCache = new Map<string, string>();

export function generateIdempotencyKey(prefix = 'lm'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}

export function getOrCreateIntentKey(intentId: string, prefix = 'lm'): string {
  const existing = intentKeyCache.get(intentId);
  if (existing) return existing;
  const created = generateIdempotencyKey(prefix);
  intentKeyCache.set(intentId, created);
  return created;
}

export function clearIntentKey(intentId: string): void {
  intentKeyCache.delete(intentId);
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      sp.set(k, String(v));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

async function parseError(res: Response): Promise<ApiClientError> {
  const retryHeader = res.headers.get('Retry-After');
  const retryAfterSeconds = retryHeader ? Number.parseInt(retryHeader, 10) : undefined;
  try {
    const data = (await res.json()) as Partial<ApiError>;
    if (data?.error && typeof data.error.code === 'string') {
      return new ApiClientError({
        status: res.status,
        code: data.error.code,
        message: data.error.message || res.statusText || '请求失败',
        requestId: data.error.requestId || 'unknown',
        details: data.error.details,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      });
    }
  } catch {
    // non-JSON error body
  }
  return new ApiClientError({
    status: res.status,
    code: res.status === 401 ? 'UNAUTHENTICATED' : `HTTP_${res.status}`,
    message: res.statusText || '网络或服务端错误',
    requestId: res.headers.get('X-Request-Id') || 'unknown',
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  });
}

async function requestJson<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method || 'GET',
    headers,
    body,
    credentials: 'include',
    signal: options.signal,
  });

  if (!res.ok) {
    throw await parseError(res);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export const api = {
  // === Auth & Session ===
  requestOtp(body: OtpChallenge): Promise<OtpSent> {
    return requestJson('/auth/otp', { method: 'POST', body });
  },
  startSession(body: Login): Promise<Session> {
    return requestJson('/auth/session', { method: 'POST', body });
  },
  getSession(signal?: AbortSignal): Promise<Session> {
    return requestJson('/auth/session', { signal });
  },
  endSession(): Promise<void> {
    return requestJson('/auth/session', { method: 'DELETE' });
  },

  // === Projects ===
  listProjects(params: {
    q?: string;
    industry?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<ProjectPage> {
    return requestJson(`/projects${buildQuery(params)}`);
  },
  createProject(body: ProjectCreate): Promise<Project> {
    return requestJson('/projects', { method: 'POST', body });
  },
  updateProject(projectId: string, body: ProjectPatch): Promise<Project> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body });
  },

  // === Canvases ===
  listCanvases(params: {
    projectId?: string;
    scope?: 'personal' | 'team' | 'all';
    q?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  } = {}, signal?: AbortSignal): Promise<CanvasPage> {
    return requestJson(`/canvases${buildQuery(params)}`, { signal });
  },
  createCanvas(projectId: string, body: CanvasCreate): Promise<Canvas> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/canvases`, {
      method: 'POST',
      body,
    });
  },
  readCanvas(canvasId: string, signal?: AbortSignal): Promise<Canvas> {
    return requestJson(`/canvases/${encodeURIComponent(canvasId)}`, { signal });
  },
  saveCanvas(canvasId: string, body: CanvasSave): Promise<Canvas> {
    return requestJson(`/canvases/${encodeURIComponent(canvasId)}`, {
      method: 'PUT',
      body,
    });
  },
  cloneCanvas(canvasId: string, body: CloneCanvas): Promise<Canvas> {
    return requestJson(`/canvases/${encodeURIComponent(canvasId)}/clone`, {
      method: 'POST',
      body,
    });
  },
  getRecentCanvas(): Promise<ResumeCanvas> {
    return requestJson('/canvases/recent');
  },
  saveTemplate(canvasId: string, body: TemplateCreate): Promise<Template> {
    return requestJson(`/canvases/${encodeURIComponent(canvasId)}/templates`, {
      method: 'POST',
      body,
    });
  },

  // === Catalog: Templates, Models, Presets, Portraits ===
  listTemplates(params: { industry?: string; q?: string } = {}): Promise<Template[]> {
    return requestJson(`/templates${buildQuery(params)}`);
  },
  listModels(): Promise<Model[]> {
    return requestJson('/models');
  },
  getPlatformPresets(): Promise<Preset[]> {
    return requestJson('/ecommerce/presets');
  },
  getPortraitCatalog(): Promise<Portrait[]> {
    return requestJson('/ecommerce/portraits');
  },
  recordPortraitConsent(
    projectId: string,
    body: PortraitConsentCreate
  ): Promise<PortraitConsent> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/portrait-consents`, {
      method: 'POST',
      body,
    });
  },

  // === Subjects & Assets ===
  listSubjects(projectId: string): Promise<Subject[]> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/subjects`);
  },
  createSubject(projectId: string, body: SubjectCreate): Promise<Subject> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/subjects`, {
      method: 'POST',
      body,
    });
  },
  updateSubject(subjectId: string, body: SubjectUpdate): Promise<Subject> {
    return requestJson(`/subjects/${encodeURIComponent(subjectId)}`, {
      method: 'PATCH',
      body,
    });
  },
  listAssets(params: {
    projectId?: string;
    kind?: MediaKind;
    status?: string;
    cursor?: string;
    limit?: number;
    tag?: string;
  } = {}): Promise<AssetPage> {
    return requestJson(`/assets${buildQuery(params)}`);
  },
  uploadAsset(
    projectId: string,
    file: File | Blob,
    options: {
      fileName?: string;
      assetRole?: 'reference' | 'mask' | 'product' | 'other';
      idempotencyKey?: string;
    } = {}
  ): Promise<Asset> {
    const form = new FormData();
    if (file instanceof File) {
      form.append('file', file);
    } else {
      form.append('file', file, options.fileName || 'mask.png');
    }
    if (options.assetRole) {
      form.append('assetRole', options.assetRole);
    }
    return requestJson(`/projects/${encodeURIComponent(projectId)}/assets`, {
      method: 'POST',
      body: form,
      idempotencyKey: options.idempotencyKey || generateIdempotencyKey('asset'),
    });
  },
  getAsset(assetId: string): Promise<Asset> {
    return requestJson(`/assets/${encodeURIComponent(assetId)}`);
  },
  patchAsset(assetId: string, body: AssetPatch): Promise<Asset> {
    return requestJson(`/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      body,
    });
  },
  getAssetImpact(assetId: string): Promise<AssetImpact> {
    return requestJson(`/assets/${encodeURIComponent(assetId)}/impact`);
  },
  getAssetLicense(assetId: string): Promise<ExportLicense> {
    return requestJson(`/assets/${encodeURIComponent(assetId)}/license`);
  },
  getAssetContentUrl(assetId: string, disposition: 'preview' | 'download' = 'preview'): string {
    return `${API_BASE}/assets/${encodeURIComponent(assetId)}/content?disposition=${disposition}`;
  },

  // === Generation, Jobs, Batches, Graph Runs, Storyboards ===
  quoteGeneration(projectId: string, body: GenerationInput): Promise<Quote> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/quotes`, {
      method: 'POST',
      body,
    });
  },
  submitJob(projectId: string, body: JobCreate, idempotencyKey?: string): Promise<Job> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/jobs`, {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey || getOrCreateIntentKey(`job:${body.quoteId}`, 'job'),
    });
  },
  listJobs(params: {
    projectId?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<JobPage> {
    return requestJson(`/jobs${buildQuery(params)}`);
  },
  getJob(jobId: string): Promise<Job> {
    return requestJson(`/jobs/${encodeURIComponent(jobId)}`);
  },
  cancelJob(jobId: string, body: CancelJob, idempotencyKey?: string): Promise<Job> {
    return requestJson(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      body,
      idempotencyKey:
        idempotencyKey ||
        getOrCreateIntentKey(`cancel:${jobId}:${body.confirmRunning ? 'force' : 'soft'}`, 'cancel'),
    });
  },
  retryJob(jobId: string, body: JobCreate, idempotencyKey?: string): Promise<Job> {
    return requestJson(`/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: 'POST',
      body,
      idempotencyKey:
        idempotencyKey || getOrCreateIntentKey(`retry:${jobId}:${body.quoteId}`, 'retry'),
    });
  },
  quoteBatch(projectId: string, body: BatchQuoteInput): Promise<BatchQuote> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/batch-quotes`, {
      method: 'POST',
      body,
    });
  },
  submitBatch(projectId: string, body: JobCreate, idempotencyKey?: string): Promise<Batch> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/batches`, {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey || getOrCreateIntentKey(`batch:${body.quoteId}`, 'batch'),
    });
  },
  getBatch(batchId: string): Promise<Batch> {
    return requestJson(`/batches/${encodeURIComponent(batchId)}`);
  },
  getBatchDownloadUrl(batchId: string): string {
    return `${API_BASE}/batches/${encodeURIComponent(batchId)}/download`;
  },
  quoteGraphRun(canvasId: string, body: RunQuoteInput): Promise<RunQuote> {
    return requestJson(`/canvases/${encodeURIComponent(canvasId)}/run-quotes`, {
      method: 'POST',
      body,
    });
  },
  submitGraphRun(canvasId: string, body: JobCreate, idempotencyKey?: string): Promise<Run> {
    return requestJson(`/canvases/${encodeURIComponent(canvasId)}/runs`, {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey || getOrCreateIntentKey(`run:${body.quoteId}`, 'run'),
    });
  },
  getGraphRun(runId: string): Promise<Run> {
    return requestJson(`/runs/${encodeURIComponent(runId)}`);
  },
  draftStoryboard(projectId: string, body: StoryboardRequest): Promise<Storyboard> {
    return requestJson(`/projects/${encodeURIComponent(projectId)}/storyboards`, {
      method: 'POST',
      body,
    });
  },

  // === Billing & Subscriptions ===
  listPlans(): Promise<Plan[]> {
    return requestJson('/billing/plans');
  },
  listCreditPacks(): Promise<CreditPack[]> {
    return requestJson('/billing/credit-packs');
  },
  getBillingState(): Promise<BillingState> {
    return requestJson('/billing/state');
  },
  getLedger(params: {
    cursor?: string;
    limit?: number;
    from?: string;
    until?: string;
    projectId?: string;
    kind?: LedgerKind;
  } = {}): Promise<LedgerPage> {
    return requestJson(`/billing/ledger${buildQuery(params)}`);
  },
  beginCheckout(body: CheckoutRequest, idempotencyKey?: string): Promise<Checkout> {
    return requestJson('/billing/checkout-sessions', {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey || generateIdempotencyKey('checkout'),
    });
  },
  getCheckout(checkoutId: string): Promise<Checkout> {
    return requestJson(`/billing/checkout-sessions/${encodeURIComponent(checkoutId)}`);
  },
  getCheckoutSession(checkoutId: string): Promise<Checkout> {
    return requestJson(`/billing/checkout-sessions/${encodeURIComponent(checkoutId)}`);
  },
  sandboxConfirmCheckout(checkoutId: string): Promise<Checkout> {
    return requestJson(
      `/billing/checkout-sessions/${encodeURIComponent(checkoutId)}/sandbox-confirm`,
      { method: 'POST' }
    );
  },
  stopRenewal(idempotencyKey?: string): Promise<BillingState> {
    return requestJson('/billing/subscription/stop-renewal', {
      method: 'POST',
      idempotencyKey: idempotencyKey || generateIdempotencyKey('stop-renewal'),
    });
  },

  // === Workspaces (P1 org_collaboration) ===
  listWorkspaces(): Promise<Workspace[]> {
    return requestJson('/workspaces');
  },
  createTeam(body: WorkspaceCreate): Promise<Workspace> {
    return requestJson('/workspaces', { method: 'POST', body });
  },
  switchWorkspace(body: WorkspaceSwitch): Promise<Session> {
    return requestJson('/auth/workspace', { method: 'PUT', body });
  },
  listMembers(workspaceId: string): Promise<Member[]> {
    return requestJson(`/workspaces/${encodeURIComponent(workspaceId)}/members`);
  },
  inviteMember(workspaceId: string, body: InviteCreate): Promise<Invite> {
    return requestJson(`/workspaces/${encodeURIComponent(workspaceId)}/invitations`, {
      method: 'POST',
      body,
    });
  },
  acceptInvitation(body: InviteAccept, idempotencyKey?: string): Promise<Workspace> {
    return requestJson('/invitations/accept', {
      method: 'POST',
      body,
      idempotencyKey: idempotencyKey || getOrCreateIntentKey(`invite:${body.token}`, 'invite'),
    });
  },
  changeMemberRole(workspaceId: string, userId: string, body: Grant): Promise<Member> {
    return requestJson(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body }
    );
  },
  revokeMember(workspaceId: string, userId: string): Promise<void> {
    return requestJson(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );
  },
  setProjectGrant(projectId: string, userId: string, body: ProjectGrant): Promise<ProjectGrant> {
    return requestJson(
      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PUT', body }
    );
  },
};
