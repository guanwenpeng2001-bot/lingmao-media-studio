import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Download,
  Film,
  Grid,
  Layers,
  Lock,
  RefreshCw,
  Scissors,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Upload,
  Wand2,
} from 'lucide-react';
import { api, generateIdempotencyKey, isApiClientError } from '../../api/client';
import type {
  Asset,
  Batch,
  BatchQuote,
  BatchVariantInput,
  Job,
  Preset,
  Quote,
  Storyboard,
  Subject,
  Template,
} from '../../api/types';
import { FidelityComparator } from '../../components/FidelityComparator';
import { MaskBrushEditor } from '../../components/MaskBrushEditor';
import { SafeZoneOverlay } from '../../components/SafeZoneOverlay';
import { useApp } from '../../state/AppContext';

type EcomTab = 'subject' | 'scene' | 'batch' | 'video' | 'templates';

interface BatchSpecItem {
  key: string;
  label: string;
  aspectRatio: string;
  outputKind: 'white_background' | 'hero' | 'detail' | 'poster' | 'scene';
  quantity: number;
  checked: boolean;
  presetPlatform?: string;
}

const DEFAULT_BATCH_SPECS: BatchSpecItem[] = [
  { key: 'white', label: '合规白底图 (1:1)', aspectRatio: '1:1', outputKind: 'white_background', quantity: 1, checked: true, presetPlatform: 'taobao' },
  { key: 'taobao', label: '淘宝/京东主图 (1:1)', aspectRatio: '1:1', outputKind: 'hero', quantity: 2, checked: true, presetPlatform: 'taobao' },
  { key: 'xhs', label: '小红书/淘宝竖图 (3:4)', aspectRatio: '3:4', outputKind: 'scene', quantity: 2, checked: true, presetPlatform: 'xiaohongshu' },
  { key: 'douyin', label: '抖音商品卡/信息流 (9:16)', aspectRatio: '9:16', outputKind: 'scene', quantity: 2, checked: true, presetPlatform: 'douyin' },
  { key: 'poster', label: '活动促销海报 (3:4)', aspectRatio: '3:4', outputKind: 'poster', quantity: 1, checked: true, presetPlatform: 'xiaohongshu' },
];

const SCENE_PRESETS = [
  { id: 'studio-soft', label: '棚拍柔光纯色高级感', prompt: '极简高级棚拍柔光箱，自然接触阴影与柔和反射，商业产品精修质感' },
  { id: 'nordic-desk', label: '北欧原木家居桌面', prompt: '温暖自然光洒在北欧原木桌面，背景虚化绿植与柔和室内氛围，真实环境光反射' },
  { id: 'beauty-marble', label: '美妆大理石水光台面', prompt: '高级白玉大理石台面搭配晶莹水波光影折射，轻奢美妆商业拍摄' },
  { id: 'tech-cyber', label: '3C 数码极简科技台面', prompt: '哑光深灰金属桌面搭配冷暖对比轮廓光，3C 数码旗舰发布会质感' },
  { id: 'promo-fest', label: '大促礼盒氛围场景', prompt: '暖金庆典光斑与质感丝带陈列台，突出节日大促高级礼赠氛围' },
];

const CAMERA_MOTIONS = [
  { id: 'orbit_slow', label: '360° 缓慢环绕展示' },
  { id: 'push_in', label: '推近聚焦核心卖点' },
  { id: 'light_sweep', label: '柔和阳光光影流转' },
  { id: 'ambient_motion', label: '场景微动氛围感' },
];

export const EcommercePage: React.FC = () => {
  const {
    session,
    features,
    models,
    projects,
    activeProjectId,
    jobs,
    openLoginModal,
    refreshProjects,
    refreshBillingState,
    upsertJob,
    pushToast,
    handleApiError,
  } = useApp();
  const navigate = useNavigate();

  const [tab, setTab] = useState<EcomTab>('subject');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  // Step 1: Upload, Cutout, 0-Credit Mask Brush, Subject Archive & Placement
  const [uploadedAsset, setUploadedAsset] = useState<Asset | null>(null);
  const [lowResWarning, setLowResWarning] = useState<string | null>(null);
  const [contentBlockedMsg, setContentBlockedMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [maskAssetId, setMaskAssetId] = useState<string | null>(null);
  const [savingMask, setSavingMask] = useState(false);
  const [showBrushEditor, setShowBrushEditor] = useState(false);
  const [subjectName, setSubjectName] = useState('');
  const [subjectSku, setSubjectSku] = useState('');
  const [activeSubject, setActiveSubject] = useState<Subject | null>(null);
  const [preserveSubject, setPreserveSubject] = useState(true);
  const [placement, setPlacement] = useState({ x: 0.5, y: 0.5, scale: 0.72 });

  // Step 2: Studio Lighting & Scene Replacement
  const [scenePresetId, setScenePresetId] = useState(SCENE_PRESETS[1].id);
  const [scenePrompt, setScenePrompt] = useState(SCENE_PRESETS[1].prompt);
  const [sceneRatio, setSceneRatio] = useState('1:1');
  const [sceneQuote, setSceneQuote] = useState<Quote | null>(null);
  const [sceneJob, setSceneJob] = useState<Job | null>(null);

  // Step 3: Multi-platform 8-item Batch Generation
  const [batchSpecs, setBatchSpecs] = useState<BatchSpecItem[]>(DEFAULT_BATCH_SPECS);
  const [posterHeadline, setPosterHeadline] = useState('限时直降 · 旗舰爆款');
  const [posterPrice, setPosterPrice] = useState('¥199');
  const [posterSellingPoints, setPosterSellingPoints] = useState('高保真声学结构\n12 小时持久续航\n原装礼盒质保');
  const [showSafeZones, setShowSafeZones] = useState(true);
  const [batchQuote, setBatchQuote] = useState<BatchQuote | null>(null);
  const [activeBatch, setActiveBatch] = useState<Batch | null>(null);
  const [batchJobs, setBatchJobs] = useState<Job[]>([]);

  // Step 4: Short Video & Storyboard
  const [videoSourceAssetId, setVideoSourceAssetId] = useState<string>('');
  const [lastFrameAssetId, setLastFrameAssetId] = useState<string>('');
  const [endFrameCrop, setEndFrameCrop] = useState<'fit' | 'crop'>('fit');
  const [frameMismatchMsg, setFrameMismatchMsg] = useState<string | null>(null);
  const [cameraMotion, setCameraMotion] = useState('orbit_slow');
  const [videoDuration, setVideoDuration] = useState(5);
  const [videoRatio, setVideoRatio] = useState('9:16');
  const [videoNativeAudio, setVideoNativeAudio] = useState(false);
  const [videoQuote, setVideoQuote] = useState<Quote | null>(null);
  const [videoJob, setVideoJob] = useState<Job | null>(null);

  const [storyboardPoints, setStoryboardPoints] = useState(
    '痛点引入：桌面杂乱音质单薄\n商品特写：金属工艺与品牌 Logo 细节\n场景使用：暖光书桌沉浸聆听\n促单号召：双11限时立省下单'
  );
  const [shotCount, setShotCount] = useState(3);
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [loadingStoryboard, setLoadingStoryboard] = useState(false);

  const projectId = activeProjectId || projects[0]?.id || '';

  useEffect(() => {
    void api.getPlatformPresets().then(setPresets).catch(() => {});
    void api.listTemplates({ industry: 'ecommerce' }).then(setTemplates).catch(() => {});
  }, []);

  useEffect(() => {
    if (!projectId) return;
    void api.listSubjects(projectId).then(setSubjects).catch(() => {});
  }, [projectId]);

  // Sync live SSE job status into sceneJob / videoJob / batchJobs
  useEffect(() => {
    if (sceneJob) {
      const latest = jobs.find((j) => j.id === sceneJob.id);
      if (latest && latest.revision >= sceneJob.revision) {
        setSceneJob(latest);
        if (latest.status === 'succeeded' && latest.outputAssetIds[0] && !videoSourceAssetId) {
          setVideoSourceAssetId(latest.outputAssetIds[0]);
        }
      }
    }
    if (videoJob) {
      const latest = jobs.find((j) => j.id === videoJob.id);
      if (latest && latest.revision >= videoJob.revision) setVideoJob(latest);
    }
    if (activeBatch) {
      const matched = activeBatch.jobIds
        .map((id) => jobs.find((j) => j.id === id))
        .filter((j): j is Job => Boolean(j));
      if (matched.length > 0) setBatchJobs(matched);
    }
  }, [jobs, sceneJob, videoJob, activeBatch, videoSourceAssetId]);

  const ensureEcommerceProject = async (): Promise<string | null> => {
    if (!session) {
      openLoginModal();
      return null;
    }
    if (projectId) return projectId;
    try {
      const created = await api.createProject({ name: '电商营销默认项目', industry: 'ecommerce' });
      await refreshProjects();
      return created.id;
    } catch (err) {
      handleApiError(err);
      return null;
    }
  };

  const imageModelId = useMemo(
    () =>
      models.find((m) => m.modes.includes('product_scene') && m.availability === 'available')?.id ||
      'studio-image',
    [models]
  );

  const videoModel = useMemo(
    () =>
      models.find((m) => m.modes.includes('image_to_video') && m.availability === 'available') ||
      null,
    [models]
  );

  // Check natural dimensions client-side before/during upload for short edge < 512px warning
  const inspectImageDimensions = (file: File): Promise<{ w: number; h: number } | null> => {
    return new Promise((resolve) => {
      if (typeof Image === 'undefined' || typeof URL.createObjectURL !== 'function') {
        resolve(null);
        return;
      }
      const img = new Image();
      const objUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        resolve({ w: img.naturalWidth, h: img.naturalHeight });
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        resolve(null);
      };
      img.src = objUrl;
    });
  };

  const handleUploadProduct = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const pid = await ensureEcommerceProject();
    if (!pid) return;

    setContentBlockedMsg(null);
    setLowResWarning(null);
    const dims = await inspectImageDimensions(file);
    if (dims && Math.min(dims.w, dims.h) < 512) {
      setLowResWarning(
        `原图分辨率 ${dims.w}×${dims.h}（短边 < 512px）清晰度偏低，可能影响商标与纹理还原，建议更换高清原图或先执行一键高清修复。`
      );
    }

    setUploading(true);
    try {
      const asset = await api.uploadAsset(pid, file, {
        assetRole: 'product',
        idempotencyKey: generateIdempotencyKey('ecom-upload'),
      });
      setUploadedAsset(asset);
      setSubjectName(file.name.replace(/\.[^.]+$/, ''));
      if (
        asset.width &&
        asset.height &&
        Math.min(asset.width, asset.height) < 512 &&
        !lowResWarning
      ) {
        setLowResWarning(
          `原图分辨率 ${asset.width}×${asset.height}（短边 < 512px）清晰度偏低，建议先执行一键高清修复或更换高清原图。`
        );
      }
      pushToast({ tone: 'success', title: '商品原图上传并通过安全检查' });
    } catch (err) {
      if (isApiClientError(err) && err.status === 422 && err.code === 'CONTENT_BLOCKED') {
        setContentBlockedMsg(
          `前置内容合规拦截（未扣除任何积分）：${err.message || '检测到违禁商品或敏感信息，请更换合规商品图。'}`
        );
      } else {
        handleApiError(err);
      }
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleAutoCutout = async () => {
    const pid = await ensureEcommerceProject();
    if (!pid || !uploadedAsset) return;
    try {
      const quote = await api.quoteGeneration(pid, {
        mode: 'subject_cutout',
        modelId: imageModelId,
        prompt: '精准提取商品主体透明蒙版，保留玻璃、金属与毛绒边缘细节',
        inputAssetIds: [uploadedAsset.id],
        parameters: { aspectRatio: '1:1' },
      });
      const job = await api.submitJob(pid, { quoteId: quote.id });
      upsertJob(job);
      void refreshBillingState();
      pushToast({
        tone: 'success',
        title: '智能抠图任务已入队',
        description: `预估 ${quote.credits} 积分，完成后可用免费画笔 0 积分微调边缘`,
      });
      setShowBrushEditor(true);
    } catch (err) {
      handleApiError(err, { contextLabel: '商品智能抠图', onResume: () => void handleAutoCutout() });
    }
  };

  // Free 0-credit mask brush save: ONLY uploads mask Asset, NEVER creates a billed Job
  const handleSaveFreeMask = async (blob: Blob) => {
    const pid = await ensureEcommerceProject();
    if (!pid) return;
    setSavingMask(true);
    try {
      const maskAsset = await api.uploadAsset(pid, blob, {
        fileName: `mask-${Date.now()}.png`,
        assetRole: 'mask',
        idempotencyKey: generateIdempotencyKey('ecom-mask'),
      });
      setMaskAssetId(maskAsset.id);
      if (activeSubject) {
        const updated = await api.updateSubject(activeSubject.id, {
          maskAssetId: maskAsset.id,
          baseVersion: activeSubject.version,
        });
        setActiveSubject(updated);
      }
      pushToast({
        tone: 'success',
        title: '蒙版微调已保存（0 积分，未发起收费任务）',
      });
    } catch (err) {
      handleApiError(err);
    } finally {
      setSavingMask(false);
    }
  };

  const handleSaveSubjectArchive = async () => {
    const pid = await ensureEcommerceProject();
    if (!pid || !uploadedAsset) return;
    try {
      const sub = await api.createSubject(pid, {
        name: subjectName.trim() || '未命名商品主体',
        sku: subjectSku.trim() || undefined,
        primaryAssetId: uploadedAsset.id,
        referenceAssetIds: [uploadedAsset.id],
        maskAssetId: maskAssetId || undefined,
      });
      setActiveSubject(sub);
      setSubjects((prev) => [sub, ...prev]);
      pushToast({
        tone: 'success',
        title: `商品主体「${sub.name}」已建档`,
        description: '像素保真锁定已默认开启，可直接进入换景或 8 规格套图生成',
      });
      setTab('scene');
    } catch (err) {
      handleApiError(err);
    }
  };

  const currentPrimaryAssetId = activeSubject?.primaryAssetId || uploadedAsset?.id || '';

  // Step 2: Quote & Submit product_scene
  const handleQuoteScene = async () => {
    const pid = await ensureEcommerceProject();
    if (!pid || !currentPrimaryAssetId) {
      pushToast({ tone: 'warning', title: '请先上传商品原图或选择商品主体' });
      return;
    }
    try {
      const q = await api.quoteGeneration(pid, {
        mode: 'product_scene',
        modelId: imageModelId,
        prompt: scenePrompt,
        inputAssetIds: [currentPrimaryAssetId],
        parameters: {
          aspectRatio: sceneRatio,
          resolution: '1k',
          subjectId: activeSubject?.id,
          maskAssetId: maskAssetId || activeSubject?.maskAssetId || undefined,
          placement,
          product: {
            sku: activeSubject?.sku || subjectSku || undefined,
            productName: activeSubject?.name || subjectName || undefined,
            preserveSubject,
          },
        },
      });
      setSceneQuote(q);
    } catch (err) {
      handleApiError(err, { contextLabel: '棚拍光影与场景替换报价' });
    }
  };

  const handleSubmitScene = async () => {
    const pid = await ensureEcommerceProject();
    if (!pid || !sceneQuote) return;
    try {
      const job = await api.submitJob(pid, { quoteId: sceneQuote.id });
      setSceneJob(job);
      upsertJob(job);
      void refreshBillingState();
      pushToast({
        tone: 'success',
        title: '商品换景任务已提交',
        description: `预占 ${sceneQuote.credits} 积分，生成完成后可叠加对比原图 Logo 保真度`,
      });
    } catch (err) {
      handleApiError(err, {
        contextLabel: '提交商品换景任务',
        onResume: () => void handleSubmitScene(),
      });
    }
  };

  // Step 3: Multi-platform 8-item Batch Quotes & Submit
  const totalSelectedImages = useMemo(
    () => batchSpecs.filter((s) => s.checked).reduce((acc, s) => acc + s.quantity, 0),
    [batchSpecs]
  );

  const handleQuoteBatch = async () => {
    const pid = await ensureEcommerceProject();
    if (!pid || !currentPrimaryAssetId) {
      pushToast({ tone: 'warning', title: '请先上传商品原图或选择已建档商品主体' });
      return;
    }
    const selected = batchSpecs.filter((s) => s.checked && s.quantity > 0);
    if (selected.length === 0) {
      pushToast({ tone: 'warning', title: '请至少勾选一项套图规格' });
      return;
    }
    const variants: BatchVariantInput[] = selected.map((s) => {
      const preset = presets.find((p) => p.aspectRatio === s.aspectRatio);
      return {
        aspectRatio: s.aspectRatio,
        quantity: s.quantity,
        presetId: preset?.id,
        outputKind: s.outputKind,
        overlay:
          s.outputKind === 'poster'
            ? {
                headline: posterHeadline,
                priceText: posterPrice,
                sellingPoints: posterSellingPoints
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean),
              }
            : undefined,
      };
    });

    try {
      const bq = await api.quoteBatch(pid, {
        input: {
          mode: 'product_scene',
          modelId: imageModelId,
          prompt: scenePrompt,
          inputAssetIds: [currentPrimaryAssetId],
          parameters: {
            aspectRatio: '1:1',
            subjectId: activeSubject?.id,
            maskAssetId: maskAssetId || activeSubject?.maskAssetId || undefined,
            placement,
            product: {
              sku: activeSubject?.sku || subjectSku || undefined,
              productName: activeSubject?.name || subjectName || undefined,
              preserveSubject,
            },
          },
        },
        variants,
      });
      setBatchQuote(bq);
    } catch (err) {
      handleApiError(err, { contextLabel: '多平台套图批量报价' });
    }
  };

  const handleSubmitBatch = async () => {
    const pid = await ensureEcommerceProject();
    if (!pid || !batchQuote) return;
    try {
      const batch = await api.submitBatch(pid, { quoteId: batchQuote.id });
      setActiveBatch(batch);
      void refreshBillingState();
      pushToast({
        tone: 'success',
        title: `批量套图已提交（共 ${batch.jobIds.length} 子项）`,
        description: `已一次预占 ${batchQuote.totalCredits} 积分，失败子项将自动按单价退分`,
      });
      // Fetch initial job states
      const fetched = await Promise.all(
        batch.jobIds.map((id) => api.getJob(id).catch(() => null))
      );
      const validJobs = fetched.filter((j): j is Job => Boolean(j));
      validJobs.forEach(upsertJob);
      setBatchJobs(validJobs);
    } catch (err) {
      handleApiError(err, {
        contextLabel: '提交多平台套图批量任务',
        onResume: () => void handleSubmitBatch(),
      });
    }
  };

  const handleRetryFailedBatchItems = async () => {
    const failedJobs = batchJobs.filter((j) => j.status === 'failed' && j.retryable);
    if (failedJobs.length === 0) return;
    for (const fj of failedJobs) {
      try {
        const q = await api.quoteGeneration(fj.projectId, fj.input);
        const retried = await api.retryJob(fj.id, { quoteId: q.id });
        upsertJob(retried);
      } catch (err) {
        handleApiError(err);
        break;
      }
    }
    pushToast({ tone: 'success', title: `已重新提交 ${failedJobs.length} 个失败子项` });
  };

  // Step 4: Single Product Video & Storyboard
  const handleQuoteVideo = async () => {
    const pid = await ensureEcommerceProject();
    const srcId = videoSourceAssetId || sceneJob?.outputAssetIds?.[0] || currentPrimaryAssetId;
    if (!pid || !srcId) {
      pushToast({ tone: 'warning', title: '请先选择一张商品场景图作为视频首帧' });
      return;
    }
    setFrameMismatchMsg(null);
    try {
      const q = await api.quoteGeneration(pid, {
        mode: 'image_to_video',
        modelId: videoModel?.id || 'studio-video',
        prompt: `${CAMERA_MOTIONS.find((m) => m.id === cameraMotion)?.label || '缓慢环绕'}，保持商品主体稳定与品牌细节清晰`,
        inputAssetIds: [srcId],
        parameters: {
          aspectRatio: videoRatio,
          durationSeconds: videoDuration,
          cameraMotion,
          nativeAudio: videoNativeAudio,
          lastFrameAssetId: lastFrameAssetId || undefined,
          endFrameCrop: lastFrameAssetId ? endFrameCrop : undefined,
        },
      });
      setVideoQuote(q);
    } catch (err) {
      if (isApiClientError(err) && err.status === 422 && err.code === 'INVALID_INPUT') {
        setFrameMismatchMsg(
          err.message || '首尾帧尺寸比例不兼容，请选择居中适配（fit）或智能裁切（crop）对齐后重新报价。'
        );
      } else {
        handleApiError(err, { contextLabel: '商品短视频报价' });
      }
    }
  };

  const handleSubmitVideo = async () => {
    const pid = await ensureEcommerceProject();
    if (!pid || !videoQuote) return;
    try {
      const job = await api.submitJob(pid, { quoteId: videoQuote.id });
      setVideoJob(job);
      upsertJob(job);
      void refreshBillingState();
      pushToast({ tone: 'success', title: '商品短视频已入队生成' });
    } catch (err) {
      handleApiError(err, {
        contextLabel: '提交商品短视频任务',
        onResume: () => void handleSubmitVideo(),
      });
    }
  };

  const handleGenerateStoryboard = async () => {
    const pid = await ensureEcommerceProject();
    const srcId = videoSourceAssetId || sceneJob?.outputAssetIds?.[0] || currentPrimaryAssetId;
    if (!pid || !srcId) {
      pushToast({ tone: 'warning', title: '请先准备商品图或场景图后再拆解分镜' });
      return;
    }
    const points = storyboardPoints
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (points.length === 0) return;

    setLoadingStoryboard(true);
    try {
      const sb = await api.draftStoryboard(pid, {
        sellingPoints: points,
        inputAssetId: srcId,
        shotCount,
        aspectRatio: videoRatio,
      });
      setStoryboard(sb);
      pushToast({ tone: 'success', title: `已生成 ${sb.shots.length} 镜黄金带货分镜与字幕草稿` });
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoadingStoryboard(false);
    }
  };

  // Send single output asset or full storyboard directly into Infinite Canvas
  const handleSendToCanvas = async (options: {
    assetId?: string;
    label: string;
    storyboardData?: Storyboard;
  }) => {
    const pid = await ensureEcommerceProject();
    if (!pid) return;
    try {
      const created = await api.createCanvas(pid, { name: options.label });
      const graph = options.storyboardData
        ? options.storyboardData.graph
        : {
            schemaVersion: 1 as const,
            viewport: { x: 0, y: 0, zoom: 1 },
            nodes: [
              {
                id: 'n-ecom-input',
                type: activeSubject ? ('subject' as const) : ('asset' as const),
                label: activeSubject?.name || '电商产出素材',
                assetId: options.assetId || currentPrimaryAssetId,
                subjectId: activeSubject?.id,
                position: { x: 100, y: 140 },
              },
              {
                id: 'n-ecom-video',
                type: 'generation' as const,
                mode: 'image_to_video' as const,
                label: '深加工商品视频',
                position: { x: 460, y: 140 },
                config: {
                  modelId: videoModel?.id || 'studio-video',
                  prompt: scenePrompt,
                  parameters: { aspectRatio: '9:16', durationSeconds: 5, nativeAudio: false },
                },
              },
            ],
            edges: [
              {
                id: 'e-ecom-1',
                source: 'n-ecom-input',
                target: 'n-ecom-video',
                role: 'first_frame' as const,
              },
            ],
          };

      await api.saveCanvas(created.summary.id, {
        baseRevision: created.summary.revision,
        name: created.summary.name,
        graph,
      });
      pushToast({ tone: 'success', title: '已送入无限画布继续深加工' });
      navigate(`/canvases/${created.summary.id}`);
    } catch (err) {
      handleApiError(err);
    }
  };

  // Graceful P1 try-on fallback tester (for virtual_tryon=false)
  const handleTryOnPlaceholderClick = async () => {
    if (!features.virtual_tryon) {
      pushToast({
        tone: 'info',
        title: 'AI 模特试穿 / 手持展示（P1）即将上线',
        description: '当前 P0 版本默认关闭 virtual_tryon 开关，可先使用商品保真换景与多平台套图，未扣除任何积分。',
      });
      return;
    }
    try {
      await api.getPortraitCatalog();
    } catch (err) {
      handleApiError(err);
    }
  };

  const stepIndex = tab === 'subject' ? 1 : tab === 'scene' || tab === 'batch' ? 2 : 3;

  return (
    <div className="p-6 space-y-5 max-w-[1440px] mx-auto">
      {/* 3-Step Guided Wizard Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line-subtle bg-surface p-4 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-ai-soft text-ai">
            <ShoppingBag className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-ink-primary">电商营销工作室</h1>
            <p className="text-xs text-ink-tertiary">
              商品像素保真锁定 · 棚拍换景 · 8 规格多平台套图 · 带货分镜短视频（任意产出可一键送入无限画布）
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs">
          {[
            { num: 1, label: '01 商品建档与抠图' },
            { num: 2, label: '02 换景 / 套图配置' },
            { num: 3, label: '03 短视频与质检导出' },
          ].map((s) => (
            <div key={s.num} className="flex items-center gap-1.5">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold tabular-metric ${
                  stepIndex > s.num
                    ? 'bg-status-success-bg text-status-success-fg'
                    : stepIndex === s.num
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-subtle text-ink-muted'
                }`}
              >
                {stepIndex > s.num ? <Check className="h-3.5 w-3.5" /> : s.num}
              </span>
              <span
                className={
                  stepIndex === s.num ? 'font-semibold text-ink-primary' : 'text-ink-tertiary'
                }
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Mode Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle pb-3">
        {(
          [
            { id: 'subject', label: '① 商品抠图与主体建档', icon: Scissors },
            { id: 'scene', label: '② 棚拍光影与场景替换', icon: Wand2 },
            { id: 'batch', label: '③ 多平台 8 子项套图批量', icon: Grid },
            { id: 'video', label: '④ 商品短视频与带货分镜', icon: Film },
            { id: 'templates', label: '⑤ 电商爆款模板直达', icon: Sparkles },
          ] as const
        ).map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-xs font-medium transition-colors ${
                tab === t.id
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'bg-surface border border-line-subtle text-ink-secondary hover:bg-hover hover:text-ink-primary'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{t.label}</span>
            </button>
          );
        })}

        {/* P1 Virtual Try-On Gated Placeholder */}
        <button
          type="button"
          data-testid="ecom-tryon-placeholder"
          onClick={() => void handleTryOnPlaceholderClick()}
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs ${
            features.virtual_tryon
              ? 'border-line-subtle bg-surface text-ink-primary hover:bg-hover'
              : 'border-dashed border-line-default bg-subtle text-ink-muted opacity-70'
          }`}
        >
          <span>AI 模特试穿 / 手持展示</span>
          {!features.virtual_tryon && (
            <span className="rounded-xs bg-surface px-1.5 py-0.5 text-[10px] font-semibold">
              P1 即将上线
            </span>
          )}
        </button>
      </div>

      {/* TAB 1: Product Upload, Cutout, Free Mask Brush, Subject Archive */}
      {tab === 'subject' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[400px_1fr]">
          <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <h2 className="text-sm font-semibold text-ink-primary">Step 1 · 商品原图上传与主体建档</h2>

            <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-default bg-muted p-6 text-center cursor-pointer hover:border-ai transition-colors">
              <Upload className="h-6 w-6 text-ai" />
              <span className="text-xs font-semibold text-ink-primary">
                {uploading ? '正在上传与前置安全风控...' : '点击或拖入商品实拍图 / 白底图'}
              </span>
              <span className="text-[11px] text-ink-muted">支持 PNG / JPG / WebP，建议短边 ≥ 512px</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => void handleUploadProduct(e)}
                className="hidden"
              />
            </label>

            {contentBlockedMsg && (
              <div
                data-testid="ecom-content-blocked"
                className="flex items-start gap-2 rounded-lg border border-status-compliance-border bg-status-compliance-bg p-3 text-xs text-status-compliance-fg"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{contentBlockedMsg}</span>
              </div>
            )}

            {lowResWarning && (
              <div
                data-testid="ecom-low-res-warning"
                className="flex items-start gap-2 rounded-lg border border-status-stale-border bg-status-stale-bg p-3 text-xs text-status-stale-fg"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{lowResWarning}</span>
              </div>
            )}

            {/* Existing Project Subjects Picker */}
            {subjects.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-ink-secondary">或选用已有商品主体档案</div>
                <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                  {subjects.map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => {
                        setActiveSubject(sub);
                        setMaskAssetId(sub.maskAssetId);
                        setSubjectName(sub.name);
                        setSubjectSku(sub.sku || '');
                      }}
                      className={`flex items-center gap-2 rounded-lg border p-2 text-left text-xs ${
                        activeSubject?.id === sub.id
                          ? 'border-node-subject bg-status-success-bg/40'
                          : 'border-line-subtle bg-muted hover:border-line-strong'
                      }`}
                    >
                      <img
                        src={api.getAssetContentUrl(sub.primaryAssetId, 'preview')}
                        alt={sub.name}
                        className="h-9 w-9 rounded object-cover"
                      />
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-ink-primary">{sub.name}</div>
                        <div className="truncate text-[10px] text-ink-muted">{sub.sku || `v${sub.version}`}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Subject Metadata + Pixel Fidelity Lock + Placement */}
            <div className="space-y-3 border-t border-line-subtle pt-4">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-ink-secondary">商品主体名称</label>
                  <input
                    type="text"
                    value={subjectName}
                    onChange={(e) => setSubjectName(e.target.value)}
                    placeholder="如：旗舰蓝牙音箱"
                    className="h-8 w-full rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary outline-none focus:border-line-focus"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-ink-secondary">SKU 编号</label>
                  <input
                    type="text"
                    value={subjectSku}
                    onChange={(e) => setSubjectSku(e.target.value)}
                    placeholder="如：SPK-01"
                    className="h-8 w-full rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary outline-none focus:border-line-focus"
                  />
                </div>
              </div>

              {/* Preserve Subject Lock */}
              <div className="rounded-lg border border-line-subtle bg-muted p-3 space-y-2">
                <label className="flex items-center justify-between text-xs cursor-pointer">
                  <span className="flex items-center gap-1.5 font-semibold text-ink-primary">
                    <Lock className="h-3.5 w-3.5 text-node-subject" />
                    商品主体像素保真锁定（默认开启）
                  </span>
                  <input
                    type="checkbox"
                    checked={preserveSubject}
                    onChange={(e) => setPreserveSubject(e.target.checked)}
                    className="h-4 w-4 accent-ai"
                  />
                </label>
                {!preserveSubject && (
                  <div className="text-[11px] text-status-stale-fg">
                    关闭像素保真锁定可能导致商品商标文字或包装轮廓被 AI 重绘改变，商业上架前请务必核对实物。
                  </div>
                )}
              </div>

              {/* Framing Placement */}
              <div className="space-y-2 text-xs">
                <div className="font-medium text-ink-secondary">画框内商品摆位与等比缩放</div>
                <div className="grid grid-cols-3 gap-2 tabular-metric text-[11px]">
                  <label className="space-y-1">
                    <span className="text-ink-tertiary">水平 X ({Math.round(placement.x * 100)}%)</span>
                    <input
                      type="range"
                      min={0.15}
                      max={0.85}
                      step={0.01}
                      value={placement.x}
                      onChange={(e) => setPlacement((p) => ({ ...p, x: Number(e.target.value) }))}
                      className="w-full accent-ai"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-ink-tertiary">垂直 Y ({Math.round(placement.y * 100)}%)</span>
                    <input
                      type="range"
                      min={0.15}
                      max={0.85}
                      step={0.01}
                      value={placement.y}
                      onChange={(e) => setPlacement((p) => ({ ...p, y: Number(e.target.value) }))}
                      className="w-full accent-ai"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-ink-tertiary">占比 ({Math.round(placement.scale * 100)}%)</span>
                    <input
                      type="range"
                      min={0.3}
                      max={0.95}
                      step={0.01}
                      value={placement.scale}
                      onChange={(e) => setPlacement((p) => ({ ...p, scale: Number(e.target.value) }))}
                      className="w-full accent-ai"
                    />
                  </label>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={!uploadedAsset}
                  onClick={() => void handleAutoCutout()}
                  className="flex-1 rounded-md border border-line-default bg-surface py-2 text-xs font-semibold text-ink-primary hover:bg-hover disabled:opacity-40"
                >
                  智能去背抠图
                </button>
                <button
                  type="button"
                  disabled={!uploadedAsset}
                  onClick={() => void handleSaveSubjectArchive()}
                  className="flex-1 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
                >
                  保存商品主体档案
                </button>
              </div>
            </div>
          </div>

          {/* Right Stage: Preview + Free 0-Credit Mask Brush */}
          <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-primary">
                {showBrushEditor ? '免费保留/擦除微调画笔（Canvas 2D）' : '商品主体摆位与抠图预览'}
              </div>
              {currentPrimaryAssetId && (
                <button
                  type="button"
                  onClick={() => setShowBrushEditor((v) => !v)}
                  className="rounded-md border border-line-default bg-subtle px-3 py-1.5 text-xs font-medium text-ink-primary hover:bg-hover"
                >
                  {showBrushEditor ? '返回摆位预览' : '打开 0 积分免费微调画笔'}
                </button>
              )}
            </div>

            {!currentPrimaryAssetId ? (
              <div className="flex h-[380px] flex-col items-center justify-center gap-3 rounded-xl border border-line-subtle bg-muted text-center p-6">
                <ShieldCheck className="h-10 w-10 text-ink-muted" />
                <div className="text-sm font-semibold text-ink-primary">全品类电商 3 步出片流程</div>
                <p className="max-w-md text-xs text-ink-tertiary">
                  ① 上传商品原图并智能抠图建档（锁定 Logo 像素）→ ② 一键生成棚拍光影与 8 规格多平台套图 → ③ 精选场景图一键转 5s/10s 带货短视频。
                </p>
              </div>
            ) : showBrushEditor ? (
              <MaskBrushEditor
                imageUrl={api.getAssetContentUrl(currentPrimaryAssetId, 'preview')}
                saving={savingMask}
                onSaveMask={handleSaveFreeMask}
              />
            ) : (
              <div className="relative mx-auto aspect-square w-full max-w-[420px] overflow-hidden rounded-xl border border-line-default checkerboard-bg">
                <img
                  src={api.getAssetContentUrl(currentPrimaryAssetId, 'preview')}
                  alt="商品主体预览"
                  className="absolute select-none object-contain transition-all duration-100"
                  style={{
                    width: `${placement.scale * 100}%`,
                    height: `${placement.scale * 100}%`,
                    left: `${placement.x * 100}%`,
                    top: `${placement.y * 100}%`,
                    transform: 'translate(-50%, -50%)',
                  }}
                />
                {maskAssetId && (
                  <span className="absolute bottom-3 left-3 inline-flex items-center gap-1 rounded-full bg-status-success-bg px-2.5 py-1 text-[11px] font-semibold text-status-success-fg">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    已绑定确认蒙版 ({maskAssetId.slice(0, 8)})
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Studio Lighting & Scene Replacement + Fidelity Comparator */}
      {tab === 'scene' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[400px_1fr]">
          <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <h2 className="text-sm font-semibold text-ink-primary">Step 2 · 棚拍光影重构与场景替换</h2>

            <div className="space-y-2">
              <div className="text-xs font-medium text-ink-secondary">商业与生活场景预设</div>
              <div className="grid grid-cols-1 gap-1.5">
                {SCENE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setScenePresetId(p.id);
                      setScenePrompt(p.prompt);
                      setSceneQuote(null);
                    }}
                    className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      scenePresetId === p.id
                        ? 'border-ai bg-ai-soft font-semibold text-ink-primary'
                        : 'border-line-subtle bg-muted text-ink-secondary hover:bg-hover'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-secondary">场景光影描述</label>
              <textarea
                rows={3}
                value={scenePrompt}
                onChange={(e) => {
                  setScenePrompt(e.target.value);
                  setSceneQuote(null);
                }}
                className="w-full rounded-md border border-line-default bg-surface p-2.5 text-xs text-ink-primary outline-none focus:border-line-focus"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-secondary">输出比例</label>
              <div className="flex gap-2">
                {['1:1', '3:4', '9:16', '16:9'].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setSceneRatio(r);
                      setSceneQuote(null);
                    }}
                    className={`tabular-metric flex-1 rounded-md border py-1.5 text-xs font-medium ${
                      sceneRatio === r
                        ? 'border-ai bg-ai-soft text-ai font-semibold'
                        : 'border-line-subtle bg-surface text-ink-secondary'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {sceneQuote && (
              <div className="rounded-lg border border-ai bg-ai-soft p-3 text-xs space-y-1">
                <div className="flex items-center justify-between font-semibold text-ink-primary">
                  <span>精确报价（product_scene）</span>
                  <span className="tabular-metric text-ai">{sceneQuote.credits} 积分</span>
                </div>
                <div className="text-[11px] text-ink-tertiary">
                  模型：{sceneQuote.modelId} · 保真锁定：{preserveSubject ? '开启' : '关闭'}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleQuoteScene()}
                className="flex-1 rounded-md border border-line-default bg-surface py-2 text-xs font-semibold text-ink-primary hover:bg-hover"
              >
                获取报价
              </button>
              <button
                type="button"
                disabled={!sceneQuote}
                onClick={() => void handleSubmitScene()}
                className="flex-1 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
              >
                确认扣费生成
              </button>
            </div>
          </div>

          {/* Right Comparator Stage */}
          <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-primary">原图 / 换景成品叠加保真质检</div>
              {sceneJob?.outputAssetIds?.[0] && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setVideoSourceAssetId(sceneJob.outputAssetIds[0]);
                      setTab('video');
                    }}
                    className="rounded-md border border-line-default bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary hover:bg-hover"
                  >
                    设为短视频首帧
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleSendToCanvas({
                        assetId: sceneJob.outputAssetIds[0],
                        label: `${subjectName || '电商换景'} · 画布深加工`,
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    <span>一键送入无限画布</span>
                  </button>
                </div>
              )}
            </div>

            {sceneJob?.outputAssetIds?.[0] && currentPrimaryAssetId ? (
              <FidelityComparator
                originalUrl={api.getAssetContentUrl(currentPrimaryAssetId, 'preview')}
                generatedUrl={api.getAssetContentUrl(sceneJob.outputAssetIds[0], 'preview')}
                preserveSubjectLocked={preserveSubject}
              />
            ) : (
              <div className="flex h-[380px] flex-col items-center justify-center gap-2 rounded-xl border border-line-subtle bg-muted text-xs text-ink-muted">
                {sceneJob && (sceneJob.status === 'queued' || sceneJob.status === 'running') ? (
                  <>
                    <RefreshCw className="h-6 w-6 animate-spin text-ai" />
                    <span>正在渲染商品光影与真实接触阴影... ({sceneJob.status})</span>
                  </>
                ) : (
                  <>
                    <Wand2 className="h-8 w-8 opacity-40" />
                    <span>获取报价并提交后，可在此通过左右卷帘与透明度叠加对比原图 Logo 保真度</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Multi-Platform 8-Item Batch Generation */}
      {tab === 'batch' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[440px_1fr]">
          <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-primary">多平台套图批量规格勾选</h2>
              <span className="tabular-metric rounded-full bg-ai-soft px-2.5 py-0.5 text-xs font-semibold text-ai">
                共 {totalSelectedImages} 张
              </span>
            </div>

            <div className="space-y-2">
              {batchSpecs.map((spec, idx) => (
                <div
                  key={spec.key}
                  className="flex items-center justify-between rounded-lg border border-line-subtle bg-muted px-3 py-2 text-xs"
                >
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={spec.checked}
                      onChange={(e) => {
                        setBatchSpecs((prev) =>
                          prev.map((item, i) =>
                            i === idx ? { ...item, checked: e.target.checked } : item
                          )
                        );
                        setBatchQuote(null);
                      }}
                      className="h-4 w-4 accent-ai"
                    />
                    <span className="font-medium text-ink-primary">{spec.label}</span>
                  </label>
                  <div className="flex items-center gap-1.5 tabular-metric">
                    <span className="text-ink-tertiary">张数</span>
                    <input
                      type="number"
                      min={1}
                      max={6}
                      value={spec.quantity}
                      onChange={(e) => {
                        const qty = Math.max(1, Math.min(6, Number(e.target.value) || 1));
                        setBatchSpecs((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, quantity: qty } : item))
                        );
                        setBatchQuote(null);
                      }}
                      className="h-7 w-14 rounded border border-line-default bg-surface px-2 text-center text-xs text-ink-primary"
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Promotional Poster Overlay Copy */}
            <div className="space-y-2 border-t border-line-subtle pt-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-ink-primary">促销海报安全区卖点文案</span>
                <label className="flex items-center gap-1.5 text-[11px] text-ink-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showSafeZones}
                    onChange={(e) => setShowSafeZones(e.target.checked)}
                    className="accent-ai"
                  />
                  显示平台安全构图区遮罩
                </label>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  value={posterHeadline}
                  onChange={(e) => setPosterHeadline(e.target.value)}
                  placeholder="活动主标题"
                  className="col-span-2 h-8 rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary"
                />
                <input
                  type="text"
                  value={posterPrice}
                  onChange={(e) => setPosterPrice(e.target.value)}
                  placeholder="利益价格"
                  className="h-8 rounded-md border border-line-default bg-surface px-2.5 text-xs tabular-metric text-ink-primary"
                />
              </div>
              <textarea
                rows={3}
                value={posterSellingPoints}
                onChange={(e) => setPosterSellingPoints(e.target.value)}
                placeholder="每行一条核心卖点（最多 5 条）"
                className="w-full rounded-md border border-line-default bg-surface p-2 text-xs text-ink-primary"
              />
            </div>

            {/* Batch Quote Itemized Breakdown */}
            {batchQuote && (
              <div className="rounded-lg border border-ai bg-ai-soft p-3 space-y-2 text-xs">
                <div className="flex items-center justify-between font-semibold text-ink-primary">
                  <span>逐子项明细报价（共 {batchQuote.items.length} 项）</span>
                  <span className="tabular-metric text-sm text-ai">{batchQuote.totalCredits} 积分</span>
                </div>
                <div className="max-h-28 overflow-y-auto space-y-1 text-[11px] text-ink-secondary">
                  {batchQuote.items.map((it, i) => (
                    <div key={it.itemId} className="flex justify-between tabular-metric">
                      <span>
                        #{i + 1} · {it.aspectRatio}
                      </span>
                      <span>{it.credits} 分</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleQuoteBatch()}
                className="flex-1 rounded-md border border-line-default bg-surface py-2 text-xs font-semibold text-ink-primary hover:bg-hover"
              >
                核算 {totalSelectedImages} 张套图报价
              </button>
              <button
                type="button"
                disabled={!batchQuote}
                onClick={() => void handleSubmitBatch()}
                className="flex-1 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
              >
                确认批量生成
              </button>
            </div>
          </div>

          {/* Right Batch Stage + SafeZone Overlays + ZIP Export */}
          <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-ink-primary">
                平台安全构图区预览与套图产出 ({batchJobs.length || totalSelectedImages} 项)
              </div>
              {activeBatch && (
                <div className="flex items-center gap-2">
                  {batchJobs.some((j) => j.status === 'failed') && (
                    <button
                      type="button"
                      onClick={() => void handleRetryFailedBatchItems()}
                      className="inline-flex items-center gap-1 rounded-md border border-status-stale-border bg-status-stale-bg px-3 py-1.5 text-xs font-semibold text-status-stale-fg"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>仅重试失败项</span>
                    </button>
                  )}
                  <a
                    href={api.getBatchDownloadUrl(activeBatch.id)}
                    download
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>打包下载 ZIP</span>
                  </a>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {batchJobs.length > 0
                ? batchJobs.map((job, idx) => {
                    const preset = presets.find(
                      (p) => p.aspectRatio === job.input.parameters.aspectRatio
                    );
                    const outAsset = job.outputAssetIds[0];
                    return (
                      <div
                        key={job.id}
                        className="rounded-lg border border-line-subtle bg-muted p-2 space-y-2"
                      >
                        <div className="relative aspect-[3/4] overflow-hidden rounded-md bg-surface checkerboard-bg">
                          {outAsset ? (
                            <img
                              src={api.getAssetContentUrl(outAsset, 'preview')}
                              alt={`子项 ${idx + 1}`}
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[11px] text-ink-muted">
                              {job.status}
                            </div>
                          )}
                          <SafeZoneOverlay
                            preset={preset}
                            aspectRatio={job.input.parameters.aspectRatio}
                            outputKind={job.input.parameters.outputKind}
                            visible={showSafeZones}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="tabular-metric font-medium text-ink-primary">
                            #{idx + 1} · {job.input.parameters.aspectRatio}
                          </span>
                          <span
                            className={
                              job.status === 'succeeded'
                                ? 'text-status-success-fg'
                                : job.status === 'failed'
                                  ? 'text-status-failed-fg'
                                  : 'text-status-running-fg'
                            }
                          >
                            {job.status === 'failed' ? '失败已退分' : job.status}
                          </span>
                        </div>
                      </div>
                    );
                  })
                : batchSpecs
                    .filter((s) => s.checked)
                    .map((spec) => {
                      const preset = presets.find((p) => p.aspectRatio === spec.aspectRatio);
                      return (
                        <div
                          key={spec.key}
                          className="rounded-lg border border-line-subtle bg-muted p-2 space-y-2"
                        >
                          <div className="relative aspect-[3/4] overflow-hidden rounded-md bg-surface checkerboard-bg">
                            {currentPrimaryAssetId && (
                              <img
                                src={api.getAssetContentUrl(currentPrimaryAssetId, 'preview')}
                                alt={spec.label}
                                className="h-full w-full object-contain opacity-65"
                              />
                            )}
                            <SafeZoneOverlay
                              preset={preset}
                              aspectRatio={spec.aspectRatio}
                              outputKind={spec.outputKind}
                              visible={showSafeZones}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="truncate font-medium text-ink-primary">{spec.label}</span>
                            <span className="tabular-metric text-ink-muted">×{spec.quantity}</span>
                          </div>
                        </div>
                      );
                    })}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Product Short Video & Selling-Point Storyboard */}
      {tab === 'video' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Single Product Video */}
          <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <h2 className="text-sm font-semibold text-ink-primary">单镜头商品展示短视频（image_to_video）</h2>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="mb-1 block text-ink-secondary">运镜模板</label>
                <select
                  value={cameraMotion}
                  onChange={(e) => {
                    setCameraMotion(e.target.value);
                    setVideoQuote(null);
                  }}
                  className="h-9 w-full rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary"
                >
                  {CAMERA_MOTIONS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-ink-secondary">画面比例与时长</label>
                <div className="flex gap-1.5">
                  <select
                    value={videoRatio}
                    onChange={(e) => {
                      setVideoRatio(e.target.value);
                      setVideoQuote(null);
                    }}
                    className="h-9 flex-1 rounded-md border border-line-default bg-surface px-2 text-xs text-ink-primary"
                  >
                    <option value="9:16">9:16 竖屏</option>
                    <option value="1:1">1:1 方形</option>
                    <option value="16:9">16:9 横屏</option>
                  </select>
                  <select
                    value={videoDuration}
                    onChange={(e) => {
                      setVideoDuration(Number(e.target.value));
                      setVideoQuote(null);
                    }}
                    className="h-9 w-20 rounded-md border border-line-default bg-surface px-2 text-xs tabular-metric text-ink-primary"
                  >
                    <option value={5}>5s</option>
                    <option value={10}>10s</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="mb-1 block text-ink-secondary">首帧资产 ID（默认取场景图）</label>
                <input
                  type="text"
                  value={videoSourceAssetId || currentPrimaryAssetId}
                  onChange={(e) => setVideoSourceAssetId(e.target.value)}
                  placeholder="asset-..."
                  className="h-8 w-full rounded-md border border-line-default bg-surface px-2.5 text-xs tabular-metric text-ink-primary"
                />
              </div>
              <div>
                <label className="mb-1 block text-ink-secondary">可选尾帧资产 ID（首尾帧控制）</label>
                <input
                  type="text"
                  value={lastFrameAssetId}
                  onChange={(e) => setLastFrameAssetId(e.target.value)}
                  placeholder="留空则单首帧运镜"
                  className="h-8 w-full rounded-md border border-line-default bg-surface px-2.5 text-xs tabular-metric text-ink-primary"
                />
              </div>
            </div>

            {frameMismatchMsg && (
              <div className="rounded-lg border border-status-stale-border bg-status-stale-bg p-3 text-xs text-status-stale-fg space-y-2">
                <div>{frameMismatchMsg}</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEndFrameCrop('fit');
                      void handleQuoteVideo();
                    }}
                    className={`rounded px-2.5 py-1 text-xs font-semibold ${
                      endFrameCrop === 'fit' ? 'bg-primary text-primary-foreground' : 'bg-surface text-ink-primary'
                    }`}
                  >
                    居中留边对齐 (fit) 并重报
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEndFrameCrop('crop');
                      void handleQuoteVideo();
                    }}
                    className={`rounded px-2.5 py-1 text-xs font-semibold ${
                      endFrameCrop === 'crop' ? 'bg-primary text-primary-foreground' : 'bg-surface text-ink-primary'
                    }`}
                  >
                    智能中心裁切 (crop) 并重报
                  </button>
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={videoNativeAudio}
                disabled={videoModel ? !videoModel.nativeAudio : false}
                onChange={(e) => setVideoNativeAudio(e.target.checked)}
                className="accent-ai"
              />
              <span>开启视频模型原生音轨（P0 原生音频能力）</span>
            </label>

            {videoQuote && (
              <div className="flex items-center justify-between rounded-lg border border-ai bg-ai-soft px-3 py-2 text-xs">
                <span>短视频报价 ({videoDuration}s · {videoRatio})</span>
                <span className="tabular-metric font-bold text-ai">{videoQuote.credits} 积分</span>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleQuoteVideo()}
                className="flex-1 rounded-md border border-line-default bg-surface py-2 text-xs font-semibold text-ink-primary hover:bg-hover"
              >
                获取短视频报价
              </button>
              <button
                type="button"
                disabled={!videoQuote}
                onClick={() => void handleSubmitVideo()}
                className="flex-1 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
              >
                确认生成短视频
              </button>
            </div>

            {videoJob?.outputAssetIds?.[0] && (
              <div className="space-y-2 border-t border-line-subtle pt-3">
                <video
                  src={api.getAssetContentUrl(videoJob.outputAssetIds[0], 'preview')}
                  controls
                  className="max-h-60 w-full rounded-lg border border-line-subtle bg-canvas"
                />
                <button
                  type="button"
                  onClick={() =>
                    void handleSendToCanvas({
                      assetId: videoJob.outputAssetIds[0],
                      label: '商品展示短视频 · 画布深加工',
                    })
                  }
                  className="w-full rounded-md border border-line-default bg-subtle py-1.5 text-xs font-semibold text-ink-primary hover:bg-hover"
                >
                  一键送入无限画布继续剪辑串联
                </button>
              </div>
            )}
          </div>

          {/* 3-5 Shot Selling-Point Storyboard -> Infinite Canvas */}
          <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <h2 className="text-sm font-semibold text-ink-primary">带货卖点分镜工作流（3~5 镜 + 结构化字幕）</h2>

            <div>
              <label className="mb-1 block text-xs text-ink-secondary">商品核心卖点（每行一条）</label>
              <textarea
                rows={4}
                value={storyboardPoints}
                onChange={(e) => setStoryboardPoints(e.target.value)}
                className="w-full rounded-md border border-line-default bg-surface p-2.5 text-xs text-ink-primary outline-none focus:border-line-focus"
              />
            </div>

            <div className="flex items-center justify-between gap-3 text-xs">
              <label className="flex items-center gap-2">
                <span className="text-ink-secondary">黄金分镜数量</span>
                <select
                  value={shotCount}
                  onChange={(e) => setShotCount(Number(e.target.value))}
                  className="h-8 rounded-md border border-line-default bg-surface px-2 text-xs tabular-metric text-ink-primary"
                >
                  <option value={3}>3 镜</option>
                  <option value={4}>4 镜</option>
                  <option value={5}>5 镜</option>
                </select>
              </label>
              <button
                type="button"
                disabled={loadingStoryboard}
                onClick={() => void handleGenerateStoryboard()}
                className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                {loadingStoryboard ? '正在拆解分镜...' : '生成可编辑分镜与字幕草稿'}
              </button>
            </div>

            {storyboard && (
              <div className="space-y-3 border-t border-line-subtle pt-3">
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {storyboard.shots.map((shot, idx) => (
                    <div
                      key={idx}
                      className="rounded-lg border border-line-subtle bg-muted p-2.5 space-y-1 text-xs"
                    >
                      <div className="flex items-center justify-between font-semibold text-ink-primary">
                        <span>
                          镜头 #{idx + 1} · {shot.cameraMotion}
                        </span>
                        <span className="tabular-metric text-ink-muted">{shot.durationSeconds}s</span>
                      </div>
                      <input
                        type="text"
                        value={shot.caption}
                        onChange={(e) =>
                          setStoryboard((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  shots: prev.shots.map((s, i) =>
                                    i === idx ? { ...s, caption: e.target.value } : s
                                  ),
                                }
                              : null
                          )
                        }
                        className="w-full rounded border border-line-subtle bg-surface px-2 py-1 text-xs text-ink-primary"
                      />
                      <div className="text-[11px] text-ink-tertiary">{shot.prompt}</div>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() =>
                    void handleSendToCanvas({
                      label: `${subjectName || '带货分镜'} · ${storyboard.shots.length}镜工作流`,
                      storyboardData: storyboard,
                    })
                  }
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary py-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                >
                  <Layers className="h-4 w-4" />
                  <span>一键落入无限画布串联运行并多视频联动预览</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 5: Ecommerce Templates Direct Entry */}
      {tab === 'templates' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.length === 0 ? (
            <div className="col-span-full rounded-xl border border-line-subtle bg-surface p-10 text-center text-xs text-ink-muted">
              <Archive className="mx-auto mb-2 h-8 w-8 opacity-40" />
              暂无电商官方模板数据
            </div>
          ) : (
            templates.map((tpl) => (
              <div
                key={tpl.id}
                className="flex flex-col justify-between rounded-xl border border-line-subtle bg-surface p-4 space-y-3"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="rounded-xs bg-badge-new-bg px-1.5 py-0.5 text-[10px] font-semibold text-badge-new-fg">
                      电商专属模板
                    </span>
                    <span className="tabular-metric text-[11px] text-ink-muted">{tpl.aspectRatio}</span>
                  </div>
                  <h3 className="text-sm font-semibold text-ink-primary">{tpl.name}</h3>
                  <p className="line-clamp-3 text-xs text-ink-tertiary">{tpl.prompt}</p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const pid = await ensureEcommerceProject();
                    if (!pid) return;
                    try {
                      const created = await api.createCanvas(pid, {
                        name: `${tpl.name} - 副本`,
                        templateId: tpl.id,
                      });
                      navigate(`/canvases/${created.summary.id}`);
                    } catch (err) {
                      handleApiError(err);
                    }
                  }}
                  className="w-full rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                >
                  一键做同款（克隆为我的画布）
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
