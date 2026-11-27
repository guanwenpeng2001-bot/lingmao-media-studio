from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

MediaKind = Literal["image", "video", "audio"]
GenerationMode = Literal[
    "text_to_image",
    "image_to_image",
    "text_to_video",
    "image_to_video",
    "image_edit",
    "subject_cutout",
    "product_scene",
    "outpaint",
    "upscale",
    "remove_background",
    "try_on",
    "hand_held",
    "worn",
    "video_compose",
]
JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OmitNoneModel(StrictModel):
    @model_serializer(mode="wrap")
    def _serialize_omit_none(self, handler):
        data = handler(self)
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if v is not None}
        return data


class OtpChallenge(StrictModel):
    phone: str = Field(min_length=6, max_length=24)


class OtpSent(StrictModel):
    challengeId: str
    expiresAt: str
    retryAfterSeconds: int = Field(ge=0)


class Login(StrictModel):
    challengeId: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=4, max_length=12)
    agreementVersion: str = Field(min_length=1, max_length=64)


class FeaturesFlags(StrictModel):
    virtual_tryon: bool = False
    org_collaboration: bool = False
    audio_studio: bool = False


class SessionOut(StrictModel):
    userId: str
    displayName: str
    workspaceId: str
    role: Literal["owner", "editor", "viewer"]
    mode: Literal["live", "sandbox"]
    features: FeaturesFlags


class ProjectCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    industry: str = Field(min_length=1, max_length=64)


class ProjectPatch(StrictModel):
    baseRevision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    status: Literal["active", "archived"] | None = None

    @model_validator(mode="after")
    def check_min_props(self) -> ProjectPatch:
        if self.name is None and self.status is None:
            raise ValueError("At least one of name or status must be provided alongside baseRevision")
        return self


class ProjectOut(StrictModel):
    id: str
    name: str
    industry: str
    status: Literal["active", "archived"]
    workspaceId: str
    createdAt: str
    updatedAt: str
    revision: int = Field(ge=1)


class ProjectPage(StrictModel):
    items: list[ProjectOut]
    nextCursor: str | None = None


class Position(StrictModel):
    x: float
    y: float


class Viewport(StrictModel):
    x: float
    y: float
    zoom: float = Field(gt=0)


class NodeSize(StrictModel):
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class ProductContext(OmitNoneModel):
    sku: str | None = Field(default=None, min_length=1, max_length=128)
    productName: str | None = Field(default=None, min_length=1, max_length=128)
    sellingPoints: list[str] | None = Field(default=None, max_length=8)
    preserveSubject: bool | None = None


class PlacementParam(StrictModel):
    x: float
    y: float
    scale: float = Field(gt=0)


class ExpandParam(StrictModel):
    left: int = Field(ge=0)
    top: int = Field(ge=0)
    right: int = Field(ge=0)
    bottom: int = Field(ge=0)


class PortraitParam(OmitNoneModel):
    catalogId: str | None = Field(default=None, min_length=1, max_length=128)
    assetId: str | None = Field(default=None, min_length=1, max_length=128)
    consentId: str | None = Field(default=None, min_length=1, max_length=128)
    pose: str | None = Field(default=None, min_length=1, max_length=128)
    scene: str | None = Field(default=None, min_length=1, max_length=128)
    skinTone: str | None = Field(default=None, min_length=1, max_length=128)
    ageGroup: str | None = Field(default=None, min_length=1, max_length=128)
    bodyType: str | None = Field(default=None, min_length=1, max_length=128)
    gender: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_one_of(self) -> PortraitParam:
        has_catalog = self.catalogId is not None
        has_asset = self.assetId is not None
        has_consent = self.consentId is not None
        if has_catalog and not has_asset:
            return self
        if has_asset and has_consent and not has_catalog:
            return self
        raise ValueError("portrait requires either catalogId or both assetId and consentId")


class Cue(StrictModel):
    startMs: int = Field(ge=0)
    endMs: int = Field(ge=1)
    text: str = Field(min_length=1, max_length=400)


class OverlayParam(OmitNoneModel):
    headline: str | None = Field(default=None, min_length=1, max_length=256)
    priceText: str | None = Field(default=None, min_length=1, max_length=64)
    sellingPoints: list[str] | None = None


class Parameters(OmitNoneModel):
    aspectRatio: str = Field(min_length=1, max_length=16)
    durationSeconds: int | None = Field(default=None, ge=1)
    product: ProductContext | None = None
    resolution: str | None = Field(default=None, min_length=1, max_length=24)
    cameraMotion: str | None = Field(default=None, min_length=1, max_length=64)
    maskAssetId: str | None = Field(default=None, min_length=1, max_length=128)
    subjectId: str | None = Field(default=None, min_length=1, max_length=128)
    seed: int | None = Field(default=None, ge=0)
    lastFrameAssetId: str | None = Field(default=None, min_length=1, max_length=128)
    nativeAudio: bool | None = None
    platformPresetId: str | None = Field(default=None, min_length=1, max_length=128)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    placement: PlacementParam | None = None
    expand: ExpandParam | None = None
    upscaleFactor: float | None = Field(default=None, gt=1)
    editAction: Literal["repaint", "erase"] | None = None
    portrait: PortraitParam | None = None
    cues: list[Cue] | None = None
    overlay: OverlayParam | None = None
    outputKind: Literal["white_background", "hero", "detail", "poster", "scene"] | None = None
    endFrameCrop: Literal["fit", "crop"] | None = None


class NodeConfig(OmitNoneModel):
    modelId: str | None = Field(default=None, min_length=1, max_length=128)
    prompt: str | None = Field(default=None, min_length=0, max_length=8000)
    parameters: Parameters | None = None
    templateId: str | None = Field(default=None, min_length=1, max_length=128)


class Node(OmitNoneModel):
    id: str = Field(min_length=1, max_length=128)
    type: Literal["text", "asset", "subject", "generation", "frame", "placeholder"]
    position: Position
    text: str | None = Field(default=None, min_length=0, max_length=8000)
    assetId: str | None = Field(default=None, min_length=1, max_length=128)
    mode: GenerationMode | None = None
    jobId: str | None = Field(default=None, min_length=1, max_length=128)
    parentId: str | None = Field(default=None, min_length=1, max_length=128)
    subjectId: str | None = Field(default=None, min_length=1, max_length=128)
    label: str | None = Field(default=None, min_length=0, max_length=120)
    size: NodeSize | None = None
    config: NodeConfig | None = None
    expectedKind: Literal["text", "image", "video", "audio", "subject", "clip"] | None = None

    @model_validator(mode="after")
    def validate_node_type_requirements(self) -> Node:
        if self.type == "text" and self.text is None:
            raise ValueError("text node requires text field")
        if self.type == "asset" and not self.assetId:
            raise ValueError("asset node requires assetId")
        if self.type == "generation" and not self.mode:
            raise ValueError("generation node requires mode")
        if self.type == "subject" and not self.subjectId:
            raise ValueError("subject node requires subjectId")
        if self.type == "placeholder" and not self.expectedKind:
            raise ValueError("placeholder node requires expectedKind")
        return self


class Edge(OmitNoneModel):
    id: str = Field(min_length=1, max_length=128)
    source: str = Field(min_length=1, max_length=128)
    target: str = Field(min_length=1, max_length=128)
    role: Literal["prompt", "reference", "first_frame", "mask", "result", "last_frame", "clip"]
    ordinal: int | None = Field(default=None, ge=0, le=7)


class GraphSequence(OmitNoneModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=80)
    nodeIds: list[str] = Field(min_length=1)


class Graph(OmitNoneModel):
    schemaVersion: Literal[1]
    nodes: list[Node]
    edges: list[Edge]
    viewport: Viewport
    sequences: list[GraphSequence] | None = None


class CanvasSummary(StrictModel):
    id: str
    projectId: str
    name: str
    revision: int = Field(ge=1)
    nodeCount: int = Field(ge=0)
    coverAssetId: str | None = None
    canEdit: bool
    updatedAt: str
    status: Literal["active", "completed", "archived"]


class CanvasPage(StrictModel):
    items: list[CanvasSummary]
    nextCursor: str | None = None
    total: int = Field(ge=0)


class CanvasOut(StrictModel):
    summary: CanvasSummary
    graph: Graph


class CanvasCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    templateId: str | None = Field(default=None, min_length=1, max_length=128)


class CanvasSave(StrictModel):
    baseRevision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    graph: Graph
    status: Literal["active", "completed", "archived"] | None = None


class CloneCanvas(StrictModel):
    targetProjectId: str = Field(min_length=1, max_length=128)
    name: str | None = Field(default=None, min_length=1, max_length=120)


class ResumeCanvas(StrictModel):
    canvas: CanvasSummary | None = None


class GenerationInput(StrictModel):
    mode: GenerationMode
    modelId: str = Field(min_length=1, max_length=128)
    prompt: str = Field(min_length=1, max_length=8000)
    inputAssetIds: list[str] = Field(max_length=8)
    parameters: Parameters
    canvasId: str | None = Field(default=None, min_length=1, max_length=128)
    nodeId: str | None = Field(default=None, min_length=1, max_length=128)
    templateId: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_generation_rules(self) -> GenerationInput:
        if len(set(self.inputAssetIds)) != len(self.inputAssetIds):
            raise ValueError("inputAssetIds must contain unique items")
        if self.mode in ("text_to_image", "text_to_video"):
            if len(self.inputAssetIds) > 0:
                raise ValueError(f"{self.mode} requires empty inputAssetIds")
        else:
            if len(self.inputAssetIds) < 1:
                raise ValueError(f"{self.mode} requires at least 1 inputAssetId")

        if self.mode in ("image_to_video", "text_to_video"):
            if self.parameters.durationSeconds is None:
                raise ValueError(f"{self.mode} requires parameters.durationSeconds")
        else:
            if self.parameters.durationSeconds is not None:
                raise ValueError(f"{self.mode} does not allow parameters.durationSeconds")

        if self.nodeId is not None and self.canvasId is None:
            raise ValueError("nodeId requires canvasId")

        if self.mode == "image_edit" and not self.parameters.maskAssetId:
            raise ValueError("image_edit requires parameters.maskAssetId")

        if self.mode == "outpaint" and self.parameters.expand is None:
            raise ValueError("outpaint requires parameters.expand")

        if self.mode == "upscale" and self.parameters.upscaleFactor is None:
            raise ValueError("upscale requires parameters.upscaleFactor")

        if (
            self.mode == "product_scene"
            and self.parameters.product is not None
            and self.parameters.product.preserveSubject is True
        ):
            if not self.parameters.maskAssetId and not self.parameters.subjectId:
                raise ValueError("preserveSubject requires maskAssetId or subjectId")

        if self.mode in ("try_on", "hand_held", "worn") and self.parameters.portrait is None:
            raise ValueError(f"{self.mode} requires parameters.portrait")

        return self


class PriceBreakdownItem(StrictModel):
    reason: str
    credits: int = Field(ge=0)


class QuoteOut(StrictModel):
    id: str
    projectId: str
    credits: int = Field(ge=0)
    pricingVersion: str
    expiresAt: str
    mode: GenerationMode
    modelId: str
    priceBreakdown: list[PriceBreakdownItem] | None = None


class JobCreate(StrictModel):
    quoteId: str = Field(min_length=1, max_length=128)


class CancelJob(StrictModel):
    confirmRunning: bool


class JobOut(StrictModel):
    id: str
    projectId: str
    canvasId: str | None = None
    nodeId: str | None = None
    status: JobStatus
    input: dict[str, Any]
    retryOfJobId: str | None = None
    outputAssetIds: list[str]
    progress: int | None = None
    reservedCredits: int = Field(ge=0)
    chargedCredits: int = Field(ge=0)
    errorCode: str | None = None
    retryable: bool
    createdAt: str
    updatedAt: str
    batchId: str | None = None
    cancelRequested: bool
    revision: int = Field(ge=1)
    charging: Literal["held", "captured", "released"]
    expectedCredits: int = Field(ge=0)


class JobPage(StrictModel):
    items: list[JobOut]
    nextCursor: str | None = None


class JobEventOut(StrictModel):
    eventId: str
    jobId: str
    revision: int = Field(ge=1)
    status: JobStatus
    at: str


class BatchVariant(StrictModel):
    aspectRatio: str = Field(min_length=1, max_length=16)
    quantity: int = Field(ge=1, le=16)
    presetId: str | None = Field(default=None, min_length=1, max_length=128)
    outputKind: Literal["white_background", "hero", "detail", "poster", "scene"] | None = None
    overlay: OverlayParam | None = None


class BatchQuoteInput(StrictModel):
    input: GenerationInput
    variants: list[BatchVariant] = Field(min_length=1, max_length=24)


class BatchQuoteItemOut(StrictModel):
    itemId: str
    aspectRatio: str
    credits: int = Field(ge=0)


class BatchQuoteOut(StrictModel):
    id: str
    items: list[BatchQuoteItemOut]
    totalCredits: int = Field(ge=0)
    expiresAt: str


class BatchOut(StrictModel):
    id: str
    projectId: str
    status: Literal["running", "succeeded", "partial", "failed", "cancelled"]
    jobIds: list[str]
    chargedCredits: int = Field(ge=0)


class RunQuoteInput(StrictModel):
    baseRevision: int = Field(ge=1)
    nodeIds: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_unique_nodes(self) -> RunQuoteInput:
        if len(set(self.nodeIds)) != len(self.nodeIds):
            raise ValueError("nodeIds must be unique")
        return self


class RunQuoteStepOut(StrictModel):
    nodeId: str
    dependsOn: list[str]
    credits: int = Field(ge=0)


class RunQuoteOut(StrictModel):
    id: str
    canvasId: str
    baseRevision: int = Field(ge=1)
    steps: list[RunQuoteStepOut]
    totalCredits: int = Field(ge=0)
    expiresAt: str


class RunStepOut(StrictModel):
    nodeId: str
    state: Literal["waiting", "queued", "running", "succeeded", "failed", "cancelled", "skipped"]
    jobId: str | None = None
    outputAssetIds: list[str]


class RunOut(StrictModel):
    id: str
    canvasId: str
    baseRevision: int = Field(ge=1)
    status: Literal["running", "succeeded", "partial", "failed", "cancelled"]
    steps: list[RunStepOut]
    chargedCredits: int = Field(ge=0)


class SubjectCreate(StrictModel):
    name: str = Field(min_length=1, max_length=128)
    sku: str | None = Field(default=None, min_length=1, max_length=128)
    primaryAssetId: str = Field(min_length=1, max_length=128)
    referenceAssetIds: list[str]
    maskAssetId: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_unique_refs(self) -> SubjectCreate:
        if len(set(self.referenceAssetIds)) != len(self.referenceAssetIds):
            raise ValueError("referenceAssetIds must be unique")
        return self


class SubjectUpdate(StrictModel):
    baseVersion: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=128)
    referenceAssetIds: list[str] | None = None
    maskAssetId: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_update(self) -> SubjectUpdate:
        if self.name is None and self.referenceAssetIds is None and self.maskAssetId is None:
            raise ValueError("At least one field must be updated along with baseVersion")
        if self.referenceAssetIds is not None and len(set(self.referenceAssetIds)) != len(self.referenceAssetIds):
            raise ValueError("referenceAssetIds must be unique")
        return self


class SubjectOut(StrictModel):
    id: str
    projectId: str
    name: str
    sku: str | None = None
    primaryAssetId: str
    referenceAssetIds: list[str]
    maskAssetId: str | None = None
    version: int = Field(ge=1)


class AssetPatch(StrictModel):
    status: Literal["ready", "archived"] | None = None
    name: str | None = Field(default=None, min_length=1, max_length=256)
    tags: list[str] | None = None
    acknowledgeReferences: bool | None = None

    @model_validator(mode="after")
    def validate_patch(self) -> AssetPatch:
        if self.status is None and self.name is None and self.tags is None and self.acknowledgeReferences is None:
            raise ValueError("At least one property must be provided")
        return self


class AssetOut(StrictModel):
    id: str
    projectId: str
    kind: MediaKind
    name: str
    mimeType: str
    origin: Literal["upload", "generated"]
    status: Literal["ready", "archived"]
    sourceJobId: str | None = None
    inputAssetIds: list[str]
    byteSize: int = Field(ge=1)
    width: int | None = None
    height: int | None = None
    durationSeconds: float | None = None
    createdAt: str
    thumbnailUrl: str | None = None
    assetRole: Literal["reference", "mask", "product", "scene", "poster", "clip", "other"]
    archivedAt: str | None = None
    purgeAfter: str | None = None
    metadata: dict[str, Any] | None = None
    tags: list[str]
    referenceCount: int | None = None


class AssetPage(StrictModel):
    items: list[AssetOut]
    nextCursor: str | None = None


class AssetImpact(StrictModel):
    referencingCanvasCount: int = Field(ge=0)
    activeJobs: int = Field(ge=0)
    purgeAfter: str | None = None


class ExportLicense(StrictModel):
    label: str
    termsVersion: str
    issuedAt: str
    assetIds: list[str]
    downloadUrl: str
    expiresAt: str


class TemplateCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    industry: str = Field(min_length=1, max_length=64)
    tags: list[str]
    visibility: Literal["personal", "team"]
    baseRevision: int = Field(ge=1)


class TemplateOut(StrictModel):
    id: str
    version: int = Field(ge=1)
    name: str
    industry: str
    prompt: str
    suggestedModes: list[GenerationMode]
    aspectRatio: str
    tags: list[str] | None = None
    visibility: Literal["official", "personal", "team"]


class ModelOut(StrictModel):
    id: str
    label: str
    modes: list[GenerationMode]
    aspectRatios: list[str]
    durationSeconds: list[int]
    maxInputImages: int
    availability: Literal["available", "unconfigured"]
    execution: Literal["live", "demo"]
    resolutions: list[str]
    nativeAudio: bool
    supportsLastFrame: bool
    supportsLockedSubject: bool
    submissionRecovery: Literal["idempotent_key", "lookup", "none"]
    maxInputClips: int | None = None


class PresetOut(StrictModel):
    id: str
    platform: str
    name: str
    aspectRatio: str
    width: int
    height: int
    safeArea: dict[str, float]
    version: int


class PortraitOptionsOut(StrictModel):
    poses: list[str]
    scenes: list[str]
    skinTones: list[str]
    ageGroups: list[str]
    bodyTypes: list[str]
    genders: list[str]


class PortraitOut(StrictModel):
    id: str
    label: str
    previewUrl: str
    licenseVersion: str
    usage: list[Literal["try_on", "hand_held", "worn"]]
    options: PortraitOptionsOut


class PlanOut(StrictModel):
    id: str
    name: str
    interval: Literal["month", "quarter", "year"]
    priceMinor: int
    currency: str
    periodCredits: int
    maxConcurrentJobs: int
    modelIds: list[str]
    watermark: bool | None = None
    maxCanvasNodes: int | None = None
    maxStorageBytes: int | None = None
    maxResolution: str | None = None
    commercialTermsUrl: str | None = None
    offerVersion: str


class CreditPackOut(StrictModel):
    id: str
    name: str
    credits: int
    priceMinor: int
    currency: str
    expiresInDays: int | None = None


class SubscriptionOut(StrictModel):
    planId: str | None = None
    state: Literal["none", "trialing", "active", "past_due", "expired", "pending"]
    periodStart: str | None = None
    periodEnd: str | None = None
    cancelAtPeriodEnd: bool


class WalletLotOut(StrictModel):
    id: str
    source: Literal["trial", "subscription", "pack"]
    available: int
    held: int
    expiresAt: str | None = None


class EntitlementsOut(StrictModel):
    availableCredits: int
    heldCredits: int
    spentCredits: int
    maxConcurrentJobs: int
    activeJobs: int
    allowedModelIds: list[str]
    asOf: str
    watermark: bool
    storageLimitBytes: int
    usedStorageBytes: int
    canvasNodeLimit: int
    walletLots: list[WalletLotOut]
    maxCanvasCount: int
    maxSeats: int


class BillingStateOut(StrictModel):
    subscription: SubscriptionOut
    entitlements: EntitlementsOut
    checkoutMode: Literal["live", "sandbox", "unavailable"]


class LedgerEntryOut(StrictModel):
    id: str
    kind: Literal["grant", "hold", "capture", "release", "expire"]
    jobId: str | None = None
    orderId: str | None = None
    availableDelta: int
    heldDelta: int
    spentDelta: int
    at: str
    expiredDelta: int


class LedgerPage(StrictModel):
    items: list[LedgerEntryOut]
    nextCursor: str | None = None


class CheckoutRequest(StrictModel):
    itemType: Literal["subscription", "credit_pack"]
    offerId: str = Field(min_length=1, max_length=128)


class CheckoutOut(StrictModel):
    id: str
    status: Literal["pending", "paid", "cancelled", "expired"]
    mode: Literal["live", "sandbox"]
    redirectUrl: str | None = None
    expiresAt: str
    itemType: Literal["subscription", "credit_pack"]
    offerId: str


class WorkspaceOut(StrictModel):
    id: str
    name: str
    kind: Literal["personal", "team"]
    role: Literal["owner", "editor", "viewer"]
    members: int = Field(ge=1)


class WorkspaceCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)


class WorkspaceSwitch(StrictModel):
    workspaceId: str = Field(min_length=1, max_length=128)


class MemberOut(StrictModel):
    userId: str
    displayName: str
    role: Literal["owner", "editor", "viewer"]


class InviteCreate(StrictModel):
    role: Literal["editor", "viewer"]


class InviteOut(StrictModel):
    id: str
    workspaceId: str
    role: Literal["editor", "viewer"]
    expiresAt: str
    inviteUrl: str


class InviteAccept(StrictModel):
    token: str = Field(min_length=8, max_length=1024)


class Grant(StrictModel):
    role: Literal["owner", "editor", "viewer"]


class ProjectGrant(StrictModel):
    role: Literal["editor", "viewer"]
    allowCopy: bool
    allowDownload: bool


class PortraitConsentCreate(StrictModel):
    assetId: str = Field(min_length=1, max_length=128)
    termsVersion: str = Field(min_length=1, max_length=128)
    confirmed: Literal[True]


class PortraitConsentOut(StrictModel):
    id: str
    assetId: str
    termsVersion: str
    recordedAt: str


class Shot(StrictModel):
    caption: str = Field(min_length=1, max_length=400)
    prompt: str = Field(min_length=1, max_length=2000)
    durationSeconds: int = Field(ge=1)
    cameraMotion: str = Field(min_length=1, max_length=128)


class StoryboardRequest(StrictModel):
    sellingPoints: list[str] = Field(min_length=1, max_length=8)
    inputAssetId: str = Field(min_length=1, max_length=128)
    shotCount: int = Field(ge=1, le=8)
    aspectRatio: str = Field(min_length=1, max_length=16)


class StoryboardOut(StrictModel):
    shots: list[Shot]
    graph: Graph
    cues: list[Cue]


def iso_utc(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
