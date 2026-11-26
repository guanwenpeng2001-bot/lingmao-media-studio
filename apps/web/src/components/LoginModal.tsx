import React, { useEffect, useState } from 'react';
import { Check, ShieldCheck, Sparkles, X } from 'lucide-react';
import { api, isApiClientError } from '../api/client';
import { useApp } from '../state/AppContext';

const SHOWCASE_SLIDES = [
  {
    tag: '电商营销护城河',
    title: '商品主体像素保真锁定 · 一键产出 8 规格多平台套图',
    subtitle: '智能抠图 + 0 积分免费画笔微调 + 棚拍光影重构 + 抖音/淘宝/小红书安全构图区校验',
  },
  {
    tag: '生产级无限画布',
    title: '200+ 节点流畅编排 · 多视频共享时间轴联动审片',
    subtitle: '单节点实时积分预估、双端防环校验、上游变更显式提醒不自动扣费',
  },
  {
    tag: '透明多额度池账本',
    title: '限时赠分 → 周期订阅 → 永久加购 优先保护长期资产',
    subtitle: '任务失败/排队取消 100% 原路退分，每笔消费成对可审计',
  },
];

const AGREEMENT_VERSION = '2026-01-p0';

export const LoginModal: React.FC = () => {
  const { loginModalOpen, closeLoginModal, onLoginSucceeded, pushToast } = useApp();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [slideIdx, setSlideIdx] = useState(0);

  useEffect(() => {
    if (!loginModalOpen) return;
    const timer = window.setInterval(() => {
      setSlideIdx((i) => (i + 1) % SHOWCASE_SLIDES.length);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [loginModalOpen]);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = window.setTimeout(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  if (!loginModalOpen) return null;

  const slide = SHOWCASE_SLIDES[slideIdx];

  const handleSendOtp = async () => {
    const cleaned = phone.trim();
    if (cleaned.length < 6) {
      setErrorMsg('请输入有效手机号');
      return;
    }
    setErrorMsg('');
    setSendingOtp(true);
    try {
      const res = await api.requestOtp({ phone: cleaned });
      setChallengeId(res.challengeId);
      setCountdown(res.retryAfterSeconds || 60);
      pushToast({
        tone: 'success',
        title: '验证码已发送',
        description: `有效期至 ${new Date(res.expiresAt).toLocaleTimeString()}`,
      });
    } catch (err) {
      setErrorMsg(isApiClientError(err) ? err.message : '发送验证码失败');
    } finally {
      setSendingOtp(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreed) {
      setErrorMsg('请先阅读并勾选《用户服务协议》《隐私政策》与《AI 内容生成与商用授权须知》');
      return;
    }
    if (!challengeId) {
      setErrorMsg('请先获取短信验证码');
      return;
    }
    if (code.trim().length < 4) {
      setErrorMsg('请输入 4~12 位验证码');
      return;
    }
    setErrorMsg('');
    setSubmitting(true);
    try {
      const session = await api.startSession({
        challengeId,
        code: code.trim(),
        agreementVersion: AGREEMENT_VERSION,
      });
      pushToast({
        tone: 'success',
        title: `欢迎回来，${session.displayName}`,
        description: '新用户已自动发放体验积分至限时赠分池',
      });
      await onLoginSucceeded(session);
    } catch (err) {
      setErrorMsg(isApiClientError(err) ? err.message : '登录失败，请检查验证码');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="手机号验证码登录"
        className="relative grid w-full max-w-[780px] grid-cols-1 overflow-hidden rounded-modal border border-line-default bg-elevated shadow-modal md:grid-cols-2"
      >
        <button
          type="button"
          onClick={closeLoginModal}
          aria-label="关闭登录弹窗"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-subtle text-ink-secondary hover:bg-hover hover:text-ink-primary"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Left Showcase Column */}
        <div
          className="hidden md:flex flex-col justify-between p-7 relative overflow-hidden"
          style={{
            background: 'var(--bg-banner-promo)',
            color: 'var(--showcase-fg)',
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-md text-xs font-bold text-ink-inverse"
              style={{ background: 'var(--accent-ai-gradient)' }}
            >
              灵猫
            </span>
            <span className="text-sm font-semibold">Lingmao Media Studio</span>
          </div>

          <div className="space-y-3">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
              style={{ backgroundColor: 'var(--banner-promo-chip-bg)' }}
            >
              <Sparkles className="h-3 w-3" />
              {slide.tag}
            </span>
            <h3 className="text-xl font-semibold leading-snug">{slide.title}</h3>
            <p className="text-xs leading-relaxed opacity-85">{slide.subtitle}</p>
            <div className="flex items-center gap-1.5 pt-2">
              {SHOWCASE_SLIDES.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setSlideIdx(idx)}
                  aria-label={`切换到第 ${idx + 1} 项展示`}
                  className={`h-1.5 rounded-full transition-all ${
                    idx === slideIdx ? 'w-6 bg-ai' : 'w-2 opacity-40 bg-surface'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Right Form Column */}
        <form onSubmit={handleSubmit} className="flex flex-col justify-between p-7 space-y-5">
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-ink-primary">登录 / 注册灵猫工作台</h2>
              <p className="mt-1 text-xs text-ink-tertiary">未注册手机号验证通过后将自动创建账号</p>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-ai bg-ai-soft px-3 py-2 text-xs font-medium text-ai">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>新用户注册即赠 200 体验积分（计入限时赠分池）</span>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-secondary">手机号</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="请输入 11 位手机号"
                  className="h-10 w-full rounded-md border border-line-default bg-surface px-3 text-sm text-ink-primary outline-none focus:border-line-focus"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-ink-secondary">短信验证码</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="请输入验证码"
                    className="h-10 flex-1 rounded-md border border-line-default bg-surface px-3 text-sm tabular-metric text-ink-primary outline-none focus:border-line-focus"
                  />
                  <button
                    type="button"
                    disabled={sendingOtp || countdown > 0}
                    onClick={() => void handleSendOtp()}
                    className="h-10 shrink-0 rounded-md border border-line-default bg-subtle px-3 text-xs font-medium tabular-metric text-ink-primary hover:bg-hover disabled:opacity-50"
                  >
                    {countdown > 0 ? `${countdown}s 后重发` : sendingOtp ? '发送中...' : '获取验证码'}
                  </button>
                </div>
              </div>
            </div>

            {errorMsg && (
              <div className="rounded-md border border-status-failed-border bg-status-failed-bg px-3 py-2 text-xs text-status-failed-fg">
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="h-10 w-full rounded-md bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
            >
              {submitting ? '正在登录...' : '验证并登录'}
            </button>
          </div>

          <label className="flex items-start gap-2 text-[11px] leading-relaxed text-ink-tertiary cursor-pointer">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded accent-ai"
            />
            <span>
              我已阅读并同意
              <span className="text-ink-link">《用户服务协议》</span>、
              <span className="text-ink-link">《隐私政策》</span>与
              <span className="text-ink-link">《AI 内容生成与商用授权须知》</span>
              {agreed && <Check className="inline h-3 w-3 ml-1 text-status-success-fg" />}
            </span>
          </label>
        </form>
      </div>
    </div>
  );
};
