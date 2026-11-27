// Strongly typed OpenAPI 3.1 contract definitions for Lingmao Media Studio (/api/v1)
// All dates are UTC RFC 3339 strings, credits are integers, currency amounts are minor units.

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

export interface ApiError {
  error: ApiErrorBody;
}

export interface FeatureFlags {
  virtual_tryon: boolean;
  org_collaboration: boolean;
  audio_studio: boolean;
}

export interface Session {
  userId: string;
  displayName: string;
  workspaceId: string;
  role: 'owner' | 'editor' | 'viewer';
  mode: 'live' | 'sandbox';
  features: FeatureFlags;
}

export type Industry = string;

export interface Project {
  id: string;
  name: string;
  industry: Industry;
  status: 'active' | 'archived';
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ProjectCreate {
  name: string;
  industry: Industry;
}

export interface ProjectPatch {
  name?: string;
  status?: 'active' | 'archived';
  baseRevision: number;
}

export interface ProjectPage {
  items: Project[];
  nextCursor: string | null;
}

export type CanvasStatus = 'active' | 'completed' | 'archived';

export interface CanvasSummary {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  nodeCount: number;
  coverAssetId: string | null;
  canEdit: boolean;
  updatedAt: string;
  status: CanvasStatus;
}

export interface CanvasPage {
  items: CanvasSummary[];
  nextCursor: string | null;
  total: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export type MediaKind = 'image' | 'video' | 'audio';

export type GenerationMode =
  | 'text_to_image'
  | 'image_to_image'
  | 'text_to_video'
  | 'image_to_video'
  | 'image_edit'
  | 'subject_cutout'
  | 'product_scene'
  | 'outpaint'
  | 'upscale'
  | 'remove_background'
  | 'try_on'
  | 'hand_held'
  | 'worn'
  | 'video_compose';

export type CanvasNodeType =
  | 'text'
  | 'asset'
  | 'subject'
  | 'generation'
  | 'frame'
  | 'placeholder';

export type PortExpectedKind = 'text' | 'image' | 'video' | 'audio' | 'subject' | 'clip';

export type EdgeRole =
  | 'prompt'
  | 'reference'
  | 'first_frame'
  | 'mask'
  | 'result'
  | 'last_frame'
  | 'clip';

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ProductContext {
  sku?: string;
  productName?: string;
  sellingPoints?: string[];
  preserveSubject?: boolean;
}

export interface GenerationParameters {
  aspectRatio: string;
  durationSeconds?: number;
  product?: ProductContext;
  resolution?: string;
  cameraMotion?: string;
  maskAssetId?: string;
  subjectId?: string;
  seed?: number;
  lastFrameAssetId?: string;
  nativeAudio?: boolean;
  platformPresetId?: string;
  width?: number;
  height?: number;
  placement?: { x: number; y: number; scale: number };
  expand?: { left: number; top: number; right: number; bottom: number };
  upscaleFactor?: number;
  editAction?: 'repaint' | 'erase';
  portrait?: Record<string, unknown>;
  cues?: Cue[];
  overlay?: {
    headline?: string;
    priceText?: string;
    sellingPoints?: string[];
  };
  outputKind?: 'white_background' | 'hero' | 'detail' | 'poster' | 'scene';
  endFrameCrop?: 'fit' | 'crop';
}

export interface GraphNode {
  id: string;
  type: CanvasNodeType;
  position: Position;
  text?: string;
  assetId?: string;
  mode?: GenerationMode;
  jobId?: string;
  parentId?: string;
  subjectId?: string;
  label?: string;
  size?: { width: number; height: number };
  config?: {
    modelId?: string;
    prompt?: string;
    parameters?: GenerationParameters;
    templateId?: string;
  };
  expectedKind?: PortExpectedKind;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  role: EdgeRole;
  ordinal?: number;
}

export interface GraphSequence {
  id: string;
  name: string;
  nodeIds: string[];
}

export interface Graph {
  schemaVersion: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport: Viewport;
  sequences?: GraphSequence[];
}

export interface Canvas {
  summary: CanvasSummary;
  graph: Graph;
}

export interface CanvasCreate {
  name: string;
  templateId?: string;
}

export interface CanvasSave {
  baseRevision: number;
  name?: string;
  graph: Graph;
  status?: CanvasStatus;
}

export interface CloneCanvas {
  targetProjectId: string;
  name?: string;
}

export interface ResumeCanvas {
  canvas: CanvasSummary | null;
}

export type AssetRole =
  | 'reference'
  | 'mask'
  | 'product'
  | 'scene'
  | 'poster'
  | 'clip'
  | 'other';

export interface Asset {
  id: string;
  projectId: string;
  kind: MediaKind;
  name: string;
  mimeType: string;
  origin: 'upload' | 'generated';
  status: 'ready' | 'archived';
  sourceJobId: string | null;
  inputAssetIds: string[];
  byteSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  createdAt: string;
  thumbnailUrl: string | null;
  assetRole: AssetRole;
  archivedAt: string | null;
  purgeAfter: string | null;
  metadata?: Record<string, unknown>;
  tags: string[];
  referenceCount?: number;
}

export interface AssetPage {
  items: Asset[];
  nextCursor: string | null;
}

export interface AssetPatch {
  status?: 'ready' | 'archived';
  name?: string;
  tags?: string[];
  acknowledgeReferences?: boolean;
}

export interface AssetImpact {
  referencingCanvasCount: number;
  activeJobs: number;
  purgeAfter: string | null;
}

export interface ExportLicense {
  label: string;
  termsVersion: string;
  issuedAt: string;
  assetIds: string[];
  downloadUrl: string;
  expiresAt: string;
}

export interface Subject {
  id: string;
  projectId: string;
  name: string;
  sku: string | null;
  primaryAssetId: string;
  referenceAssetIds: string[];
  maskAssetId: string | null;
  version: number;
}

export interface SubjectCreate {
  name: string;
  sku?: string;
  primaryAssetId: string;
  referenceAssetIds: string[];
  maskAssetId?: string;
}

export interface SubjectUpdate {
  name?: string;
  referenceAssetIds?: string[];
  maskAssetId?: string;
  baseVersion: number;
}

export interface GenerationInput {
  mode: GenerationMode;
  modelId: string;
  prompt: string;
  inputAssetIds: string[];
  parameters: GenerationParameters;
  canvasId?: string;
  nodeId?: string;
  templateId?: string;
}

export interface Model {
  id: string;
  label: string;
  modes: GenerationMode[];
  aspectRatios: string[];
  durationSeconds: number[];
  maxInputImages: number;
  availability: 'available' | 'unconfigured';
  execution: 'live' | 'demo';
  resolutions: string[];
  nativeAudio: boolean;
  supportsLastFrame: boolean;
  supportsLockedSubject: boolean;
  submissionRecovery: 'idempotent_key' | 'lookup' | 'none';
  maxInputClips?: number;
}

export interface Template {
  id: string;
  version: number;
  name: string;
  industry: Industry;
  prompt: string;
  suggestedModes: GenerationMode[];
  aspectRatio: string;
  tags?: string[];
  visibility: 'official' | 'personal' | 'team';
}

export interface TemplateCreate {
  name: string;
  industry: Industry;
  tags: string[];
  visibility: 'personal' | 'team';
  baseRevision: number;
}

export interface Quote {
  id: string;
  projectId: string;
  credits: number;
  pricingVersion: string;
  expiresAt: string;
  mode: GenerationMode;
  modelId: string;
  priceBreakdown?: { reason: string; credits: number }[];
}

export interface JobCreate {
  quoteId: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  projectId: string;
  canvasId: string | null;
  nodeId: string | null;
  status: JobStatus;
  input: GenerationInput;
  retryOfJobId: string | null;
  outputAssetIds: string[];
  progress: number | null;
  reservedCredits: number;
  chargedCredits: number;
  errorCode: string | null;
  retryable: boolean;
  createdAt: string;
  updatedAt: string;
  batchId: string | null;
  cancelRequested: boolean;
  revision: number;
  charging: 'held' | 'captured' | 'released';
  expectedCredits: number;
}

export interface JobPage {
  items: Job[];
  nextCursor: string | null;
}

export interface CancelJob {
  confirmRunning: boolean;
}

export interface JobEvent {
  eventId: string;
  jobId: string;
  revision: number;
  status: JobStatus;
  at: string;
}

export interface BatchVariantInput {
  aspectRatio: string;
  quantity: number;
  presetId?: string;
  outputKind?: 'white_background' | 'hero' | 'detail' | 'poster' | 'scene';
  overlay?: {
    headline?: string;
    priceText?: string;
    sellingPoints?: string[];
  };
}

export interface BatchQuoteInput {
  input: GenerationInput;
  variants: BatchVariantInput[];
}

export interface BatchQuote {
  id: string;
  items: { itemId: string; aspectRatio: string; credits: number }[];
  totalCredits: number;
  expiresAt: string;
}

export interface Batch {
  id: string;
  projectId: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  jobIds: string[];
  chargedCredits: number;
}

export interface RunQuoteInput {
  baseRevision: number;
  nodeIds: string[];
}

export interface RunQuoteStep {
  nodeId: string;
  dependsOn: string[];
  credits: number;
}

export interface RunQuote {
  id: string;
  canvasId: string;
  baseRevision: number;
  steps: RunQuoteStep[];
  totalCredits: number;
  expiresAt: string;
}

export interface RunStep {
  nodeId: string;
  state: 'waiting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  jobId: string | null;
  outputAssetIds: string[];
}

export interface Run {
  id: string;
  canvasId: string;
  baseRevision: number;
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  steps: RunStep[];
  chargedCredits: number;
}

export interface Plan {
  id: string;
  name: string;
  interval: 'month' | 'quarter' | 'year';
  priceMinor: number;
  currency: string;
  periodCredits: number;
  maxConcurrentJobs: number;
  modelIds: string[];
  watermark?: boolean;
  maxCanvasNodes?: number;
  maxStorageBytes?: number;
  maxResolution?: string;
  commercialTermsUrl?: string | null;
  offerVersion: string;
}

export interface Subscription {
  planId: string | null;
  state: 'none' | 'trialing' | 'active' | 'past_due' | 'expired' | 'pending';
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export type WalletLotSource = 'trial' | 'subscription' | 'pack';

export interface WalletLot {
  id: string;
  source: WalletLotSource;
  available: number;
  held: number;
  expiresAt: string | null;
}

export interface Entitlements {
  availableCredits: number;
  heldCredits: number;
  spentCredits: number;
  maxConcurrentJobs: number;
  activeJobs: number;
  allowedModelIds: string[];
  asOf: string;
  watermark: boolean;
  storageLimitBytes: number;
  usedStorageBytes: number;
  canvasNodeLimit: number;
  walletLots: WalletLot[];
  maxCanvasCount: number;
  maxSeats: number;
}

export interface BillingState {
  subscription: Subscription;
  entitlements: Entitlements;
  checkoutMode: 'live' | 'sandbox' | 'unavailable';
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceMinor: number;
  currency: string;
  expiresInDays: number | null;
}

export type LedgerKind = 'grant' | 'hold' | 'capture' | 'release' | 'expire';

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  jobId: string | null;
  orderId: string | null;
  availableDelta: number;
  heldDelta: number;
  spentDelta: number;
  at: string;
  expiredDelta: number;
}

export interface LedgerPage {
  items: LedgerEntry[];
  nextCursor: string | null;
}

export interface CheckoutRequest {
  itemType: 'subscription' | 'credit_pack';
  offerId: string;
}

export interface Checkout {
  id: string;
  status: 'pending' | 'paid' | 'cancelled' | 'expired';
  mode: 'live' | 'sandbox';
  redirectUrl: string | null;
  expiresAt: string;
  itemType: 'subscription' | 'credit_pack';
  offerId: string;
}

export interface OtpChallenge {
  phone: string;
}

export interface OtpSent {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
}

export interface Login {
  challengeId: string;
  code: string;
  agreementVersion: string;
}

export interface Preset {
  id: string;
  platform: string;
  name: string;
  aspectRatio: string;
  width: number;
  height: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
  version: number;
}

export interface Workspace {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  role: 'owner' | 'editor' | 'viewer';
  members: number;
}

export interface WorkspaceCreate {
  name: string;
}

export interface WorkspaceSwitch {
  workspaceId: string;
}

export interface Member {
  userId: string;
  displayName: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface Invite {
  id: string;
  workspaceId: string;
  role: 'editor' | 'viewer';
  expiresAt: string;
  inviteUrl: string;
}

export interface InviteCreate {
  role: 'editor' | 'viewer';
}

export interface InviteAccept {
  token: string;
}

export interface Grant {
  role: 'owner' | 'editor' | 'viewer';
}

export interface ProjectGrant {
  role: 'editor' | 'viewer';
  allowCopy: boolean;
  allowDownload: boolean;
}

export interface Portrait {
  id: string;
  label: string;
  previewUrl: string;
  licenseVersion: string;
  usage: ('try_on' | 'hand_held' | 'worn')[];
  options: {
    poses: string[];
    scenes: string[];
    skinTones: string[];
    ageGroups: string[];
    bodyTypes: string[];
    genders: string[];
  };
}

export interface PortraitConsentCreate {
  assetId: string;
  termsVersion: string;
  confirmed: true;
}

export interface PortraitConsent {
  id: string;
  assetId: string;
  termsVersion: string;
  recordedAt: string;
}

export interface Shot {
  caption: string;
  prompt: string;
  durationSeconds: number;
  cameraMotion: string;
}

export interface StoryboardRequest {
  sellingPoints: string[];
  inputAssetId: string;
  shotCount: number;
  aspectRatio: string;
}

export interface Storyboard {
  shots: Shot[];
  graph: Graph;
  cues: Cue[];
}

export interface InsufficientCreditsDetails {
  required: number;
  available: number;
  shortfall: number;
}
