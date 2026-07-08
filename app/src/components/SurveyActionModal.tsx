import React, { useState } from 'react';
import { Icon } from './Icon';
import { useTranslation } from '../lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

// ─────────────────────────────────────────────────────────────────────────────
// Internal component prop interfaces
// ─────────────────────────────────────────────────────────────────────────────

interface ModalIconProps {
  gradient: string;
  icon: string;
  shadow: string;
}

interface CheckRowProps {
  icon: string;
  color: string;
  bg: string;
  text: string;
  sub?: string;
}

interface StatBarExtra {
  icon: string;
  label: string;
}

interface StatBarProps {
  responseCount: number;
  extra?: StatBarExtra | null;
}

interface WhatHappensBoxProps {
  heading: string;
  children: React.ReactNode;
}

interface FooterNoteProps {
  icon: string;
  iconColor: string;
  iconBg: string;
  children: React.ReactNode;
}

interface CancelButtonProps {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}

interface ActionButtonProps {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  icon: string;
  label: string;
  gradient: string;
  shadow?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public modal prop interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface LaunchSettings {
  maxResponses: string;
  autoCloseAt: string;
  allowMultiple: boolean;
  passwordProtected: boolean;
  password: string;
}

export interface PublishModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (settings: LaunchSettings) => Promise<void> | void;
  busy?: boolean;
  surveyTitle?: string;
  questionCount?: number;
}

export interface PublishSuccessModalProps {
  open: boolean;
  onClose?: () => void;
  shareUrl: string;
  onViewSurvey: () => void;
  onGoToList: () => void;
}

export interface PauseModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  busy?: boolean;
  surveyTitle?: string;
  responseCount?: number;
}

export interface ResumeModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  busy?: boolean;
  surveyTitle?: string;
  responseCount?: number;
}

export interface CloseModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  busy?: boolean;
  surveyTitle?: string;
  responseCount?: number;
}

export interface ReopenModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  busy?: boolean;
  surveyTitle?: string;
  responseCount?: number;
}

export interface DeleteSurveyModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  busy?: boolean;
  surveyTitle?: string;
  responseCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives — every modal uses these so the structure is identical
// ─────────────────────────────────────────────────────────────────────────────

function ModalIcon({ gradient, icon, shadow }: ModalIconProps) {
  return (
    <div
      className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0"
      style={{ background: gradient, boxShadow: shadow }}
    >
      <Icon name={icon} size={22} style={{ color: 'white' }} />
    </div>
  );
}

function CheckRow({ icon, color, bg, text, sub }: CheckRowProps) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ background: bg }}>
        <Icon name={icon} size={16} style={{ color }} />
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">{text}</div>
        {sub && <div className="text-xs mt-0.5 text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

function StatBar({ responseCount, extra }: StatBarProps) {
  const { t } = useTranslation();
  if (!responseCount && !extra) return null;
  return (
    <div className="flex items-center gap-4 px-4 py-3 rounded-2xl mb-4"
      style={{ background: 'color-mix(in srgb, var(--color-primary) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)' }}>
      {responseCount > 0 && (
        <div className="flex items-center gap-2">
          <Icon name="bar_chart" size={16} style={{ color: 'var(--color-primary)' }} />
          <span className="text-sm font-semibold text-foreground">
            <strong style={{ color: 'var(--color-primary)' }}>{responseCount.toLocaleString()}</strong>
            {' '}{responseCount !== 1 ? t('common.responses') : t('common.response')}
          </span>
        </div>
      )}
      {extra && (
        <div className="flex items-center gap-2 ml-auto">
          <Icon name={extra.icon} size={15} style={{ color: 'var(--color-tertiary)' }} />
          <span className="text-xs font-semibold text-muted-foreground">{extra.label}</span>
        </div>
      )}
    </div>
  );
}

function WhatHappensBox({ heading, children }: WhatHappensBoxProps) {
  return (
    <div className="rounded-2xl p-4 mb-4 space-y-3"
      style={{ background: '#f8f9fb', border: '1px solid rgba(171,173,175,0.2)' }}>
      <p className="text-[10px] font-black uppercase tracking-widest mb-3 text-muted-foreground">
        {heading}
      </p>
      {children}
    </div>
  );
}

function FooterNote({ icon, iconColor, iconBg, children }: FooterNoteProps) {
  // Wave 19b (WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §5 item 1): `${iconColor}22`
  // hex-alpha-suffix only works when `iconColor` is a literal hex string — some
  // callers now pass `var(--color-primary)`/`var(--color-tertiary)`, which would
  // silently produce invalid CSS (`var(--color-primary)22`). `color-mix()` works
  // identically for both hex strings and CSS var references (13% ≈ the old
  // 0x22/0xff alpha).
  return (
    <div className="flex items-center gap-2.5 px-4 py-3 rounded-2xl"
      style={{ background: iconBg, border: `1px solid color-mix(in srgb, ${iconColor} 13%, transparent)` }}>
      <Icon name={icon} size={16} style={{ color: iconColor }} />
      <p className="text-xs text-muted-foreground leading-relaxed">{children}</p>
    </div>
  );
}

// The ONE canonical cancel button — always looks the same
function CancelButton({ onClick, disabled, label }: CancelButtonProps) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      className="flex-1 py-3 h-auto rounded-xl text-sm font-bold active:scale-95 bg-white border border-[#e2e5e8] text-[#595c5e] hover:bg-[#f5f7f9] hover:border-[#d0d4d8] shadow-none"
    >
      {label}
    </Button>
  );
}

// The action button (colored) — accepts gradient + shadow props
function ActionButton({ onClick, disabled, busy, busyLabel, icon, label, gradient, shadow }: ActionButtonProps) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled || busy}
      className="flex-[2] py-3 h-auto rounded-xl text-sm font-bold text-white active:scale-95 flex items-center justify-center gap-2"
      style={{ background: gradient, boxShadow: shadow, opacity: busy ? 0.8 : 1 }}
    >
      {busy ? (
        <>
          <div className="w-4 h-4 rounded-full border-2 animate-spin border-white border-t-transparent" />
          {busyLabel}
        </>
      ) : (
        <>
          <Icon name={icon} size={16} />
          {label}
        </>
      )}
    </Button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLISH MODAL
// ─────────────────────────────────────────────────────────────────────────────
export function PublishModal({ open, onClose, onConfirm, busy, surveyTitle, questionCount }: PublishModalProps) {
  const { t } = useTranslation();
  const m = 'surveys.modals.publish';
  const [tab, setTab] = useState<'preview' | 'settings'>('preview');
  const [settings, setSettings] = useState<LaunchSettings>({
    maxResponses: '',
    autoCloseAt: '',
    allowMultiple: true,
    passwordProtected: false,
    password: '',
  });
  const [showPass, setShowPass] = useState(false);

  const questionLabel = questionCount && questionCount > 0
    ? t(questionCount !== 1 ? `${m}.questionStatPlural` : `${m}.questionStat`, { n: questionCount })
    : null;

  const handleClose = () => {
    setTab('preview');
    setSettings({ maxResponses: '', autoCloseAt: '', allowMultiple: true, passwordProtected: false, password: '' });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) handleClose(); }}>
      <DialogContent className="max-w-lg rounded-3xl p-0 overflow-hidden gap-0">
        {/* Header */}
        <div className="px-7 pt-7 pb-4">
          <DialogHeader className="mb-4">
            <div className="flex items-start gap-4">
              <ModalIcon
                gradient="linear-gradient(135deg, #059669, #047857)"
                icon="rocket_launch"
                shadow="0 8px 24px rgba(5,150,105,0.3)"
              />
              <div>
                <DialogTitle className="text-xl font-extrabold font-headline text-foreground">
                  {t(`${m}.title`)}
                </DialogTitle>
                <p className="text-sm mt-0.5 text-muted-foreground">
                  {t(`${m}.subtitle`, { title: surveyTitle || t('common.thisSurvey') })}
                </p>
              </div>
            </div>
          </DialogHeader>

          {/* Tab switcher */}
          <div className="flex gap-1 p-1 rounded-xl mb-4"
            style={{ background: 'rgba(0,0,0,0.04)' }}>
            {(['preview', 'settings'] as const).map((id) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className="flex-1 py-2 px-3 text-xs font-bold rounded-lg transition-all"
                style={{
                  background: tab === id ? '#fff' : 'transparent',
                  color: tab === id ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)',
                  boxShadow: tab === id ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                }}
              >
                <Icon name={id === 'preview' ? 'info' : 'tune'} size={13} className="inline mr-1.5" />
                {id === 'preview' ? t(`${m}.previewTab`) : t(`${m}.settingsTab`)}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="px-7 pb-5 overflow-y-auto" style={{ maxHeight: '340px' }}>
          {tab === 'preview' ? (
            <>
              {questionLabel && (
                <StatBar responseCount={0} extra={{ icon: 'help_outline', label: questionLabel }} />
              )}
              <WhatHappensBox heading={t(`${m}.bodyHeading`)}>
                <CheckRow icon="public" color="#059669" bg="rgba(5,150,105,0.1)"
                  text={t(`${m}.row1text`)} sub={t(`${m}.row1sub`)} />
                <CheckRow icon="bar_chart" color="var(--color-primary)" bg="color-mix(in srgb, var(--color-primary) 10%, transparent)"
                  text={t(`${m}.row2text`)} sub={t(`${m}.row2sub`)} />
                <CheckRow icon="auto_awesome" color="var(--color-tertiary)" bg="color-mix(in srgb, var(--color-tertiary) 10%, transparent)"
                  text={t(`${m}.row3text`)} sub={t(`${m}.row3sub`)} />
                <CheckRow icon="pause_circle" color="#d97706" bg="rgba(217,119,6,0.1)"
                  text={t(`${m}.row4text`)} sub={t(`${m}.row4sub`)} />
              </WhatHappensBox>
              <div className="rounded-2xl p-4"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}>
                <p className="text-[10px] font-black uppercase tracking-widest mb-3" style={{ color: 'var(--color-primary)' }}>
                  {t(`${m}.channelsHeading`)}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { icon: 'link',      label: t(`${m}.channel1Label`), sub: t(`${m}.channel1Sub`) },
                    { icon: 'qr_code_2', label: t(`${m}.channel2Label`), sub: t(`${m}.channel2Sub`) },
                    { icon: 'mail',      label: t(`${m}.channel3Label`), sub: t(`${m}.channel3Sub`) },
                  ].map(({ icon, label, sub }) => (
                    <div key={label} className="flex flex-col items-center text-center gap-1.5 p-2.5 rounded-xl"
                      style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)' }}>
                      <Icon name={icon} size={18} style={{ color: 'var(--color-primary)' }} />
                      <span className="text-xs font-bold text-foreground">{label}</span>
                      <span className="text-[10px] text-muted-foreground">{sub}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-5">
              {/* Response limit */}
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {t(`${m}.maxResponsesLabel`)}
                </Label>
                <Input
                  type="number"
                  min={1}
                  placeholder={t(`${m}.maxResponsesPlaceholder`)}
                  value={settings.maxResponses}
                  onChange={(e) => setSettings((s) => ({ ...s, maxResponses: e.target.value }))}
                  className="rounded-xl"
                />
                <p className="text-[11px] text-muted-foreground">{t(`${m}.maxResponsesHint`)}</p>
              </div>

              {/* Auto-close */}
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {t(`${m}.autoCloseLabel`)}
                </Label>
                <Input
                  type="datetime-local"
                  value={settings.autoCloseAt}
                  onChange={(e) => setSettings((s) => ({ ...s, autoCloseAt: e.target.value }))}
                  className="rounded-xl"
                />
                <p className="text-[11px] text-muted-foreground">{t(`${m}.autoCloseHint`)}</p>
              </div>

              {/* Allow multiple */}
              <div className="flex items-center justify-between gap-4 p-3 rounded-xl"
                style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
                <div>
                  <p className="text-sm font-semibold text-on-surface">{t(`${m}.allowMultipleLabel`)}</p>
                </div>
                <Switch
                  checked={settings.allowMultiple}
                  onCheckedChange={(v) => setSettings((s) => ({ ...s, allowMultiple: v }))}
                />
              </div>

              {/* Password protection */}
              <div className="flex flex-col gap-3 p-3 rounded-xl"
                style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-on-surface">{t(`${m}.passwordProtectedLabel`)}</p>
                    <p className="text-[11px] text-muted-foreground">{t(`${m}.passwordProtectedHint`)}</p>
                  </div>
                  <Switch
                    checked={settings.passwordProtected}
                    onCheckedChange={(v) => setSettings((s) => ({ ...s, passwordProtected: v, password: v ? s.password : '' }))}
                  />
                </div>
                {settings.passwordProtected && (
                  <div className="relative">
                    <Input
                      type={showPass ? 'text' : 'password'}
                      placeholder={t(`${m}.passwordPlaceholder`)}
                      value={settings.password}
                      onChange={(e) => setSettings((s) => ({ ...s, password: e.target.value }))}
                      className="rounded-xl pr-14"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-on-surface"
                    >
                      {showPass ? 'Hide' : 'Show'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {tab === 'preview' && (
          <div className="px-7 pb-5">
            <FooterNote icon="auto_awesome" iconColor="var(--color-tertiary)" iconBg="color-mix(in srgb, var(--color-tertiary) 5%, transparent)">
              <strong style={{ color: 'var(--color-tertiary)' }}>{t(`${m}.footerBold`)}</strong>{' '}{t(`${m}.footerNote`)}
            </FooterNote>
          </div>
        )}

        <DialogFooter className="flex items-center gap-3 px-7 py-5 border-t border-border sm:justify-start">
          <CancelButton onClick={handleClose} disabled={busy} label={t(`${m}.cancelButton`)} />
          {tab === 'preview' ? (
            <Button
              onClick={() => setTab('settings')}
              variant="outline"
              className="flex items-center gap-2 rounded-xl font-bold px-5"
            >
              <Icon name="tune" size={16} />
              {t(`${m}.settingsTab`)}
            </Button>
          ) : null}
          <ActionButton
            onClick={() => onConfirm(settings)}
            busy={busy}
            busyLabel={t(`${m}.confirmingButton`)}
            icon="rocket_launch"
            label={t(`${m}.confirmButton`)}
            gradient="linear-gradient(135deg, #059669, #047857)"
            shadow="0 8px 24px rgba(5,150,105,0.3)"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLISH SUCCESS MODAL
// ─────────────────────────────────────────────────────────────────────────────
export function PublishSuccessModal({ open, onClose, shareUrl, onViewSurvey, onGoToList }: PublishSuccessModalProps) {
  const { t } = useTranslation();
  const m = 'surveys.modals.publishSuccess';
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      const el = document.createElement('textarea');
      el.value = shareUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val && onClose) onClose(); }}>
      <DialogContent className="max-w-lg rounded-3xl p-0 overflow-hidden gap-0" onPointerDownOutside={(e) => e.preventDefault()}>
        <div className="px-7 pt-7 pb-5">
          <DialogHeader className="mb-6">
            <div className="flex items-start gap-4">
              <ModalIcon
                gradient="linear-gradient(135deg, #059669, #047857)"
                icon="check_circle"
                shadow="0 12px 32px rgba(5,150,105,0.35)"
              />
              <div>
                <DialogTitle className="text-2xl font-extrabold font-headline text-foreground">
                  {t(`${m}.title`)}
                </DialogTitle>
                <p className="text-sm mt-1 text-muted-foreground">
                  {t(`${m}.subtitle`)}
                </p>
              </div>
            </div>
          </DialogHeader>

          <div className="rounded-2xl p-4 mb-4"
            style={{ background: 'rgba(5,150,105,0.05)', border: '1px solid rgba(5,150,105,0.15)' }}>
            <p className="text-[10px] font-black uppercase tracking-widest mb-2" style={{ color: '#059669' }}>
              {t(`${m}.shareLinkLabel`)}
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareUrl}
                className="flex-1 text-xs font-mono bg-white border-[#dfe3e6] text-foreground rounded-xl h-9 focus-visible:ring-0"
              />
              <Button
                onClick={handleCopy}
                size="sm"
                className="h-9 px-4 rounded-xl text-xs font-bold flex items-center gap-1.5 flex-shrink-0"
                style={{
                  background: copied ? '#059669' : 'var(--color-primary)',
                  color: 'white',
                  boxShadow: copied ? '0 4px 16px rgba(5,150,105,0.3)' : '0 4px 16px color-mix(in srgb, var(--color-primary) 30%, transparent)',
                }}
              >
                <Icon name={copied ? 'check' : 'content_copy'} size={14} />
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { icon: 'mail',      label: t(`${m}.channel1Label`), hint: t(`${m}.channel1Hint`) },
              { icon: 'qr_code_2', label: t(`${m}.channel2Label`), hint: t(`${m}.channel2Hint`) },
              { icon: 'share',     label: t(`${m}.channel3Label`), hint: t(`${m}.channel3Hint`) },
            ].map(({ icon, label, hint }) => (
              <div key={label} className="flex flex-col items-center text-center gap-1.5 p-3 rounded-xl"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)' }}>
                <Icon name={icon} size={18} style={{ color: 'var(--color-primary)' }} />
                <span className="text-xs font-bold text-foreground">{label}</span>
                <span className="text-[10px] text-muted-foreground">{hint}</span>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="flex items-center gap-3 px-7 py-5 border-t border-border sm:justify-start">
          <Button
            onClick={onViewSurvey}
            className="flex-1 py-3 h-auto rounded-xl text-sm font-bold bg-white border border-[#e2e5e8] text-[#595c5e] hover:bg-[#f5f7f9] active:scale-95 flex items-center justify-center gap-2"
          >
            <Icon name="open_in_new" size={15} />
            {t(`${m}.viewButton`)}
          </Button>
          <ActionButton
            onClick={onGoToList}
            icon="list"
            label={t(`${m}.goToListButton`)}
            gradient="linear-gradient(135deg, #059669, #047857)"
            shadow="0 8px 24px rgba(5,150,105,0.3)"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAUSE MODAL
// ─────────────────────────────────────────────────────────────────────────────
export function PauseModal({ open, onClose, onConfirm, busy, surveyTitle, responseCount = 0 }: PauseModalProps) {
  const { t } = useTranslation();
  const m = 'surveys.modals.pause';

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className="max-w-lg rounded-3xl p-0 overflow-hidden gap-0">
        <div className="px-7 pt-7 pb-5">
          <DialogHeader className="mb-5">
            <div className="flex items-start gap-4">
              <ModalIcon
                gradient="linear-gradient(135deg, #d97706, #b45309)"
                icon="pause_circle"
                shadow="0 8px 24px rgba(217,119,6,0.3)"
              />
              <div>
                <DialogTitle className="text-xl font-extrabold font-headline text-foreground">
                  {t(`${m}.title`)}
                </DialogTitle>
                <p className="text-sm mt-0.5 text-muted-foreground">
                  {t(`${m}.subtitle`, { title: surveyTitle || t('common.thisSurvey') })}
                </p>
              </div>
            </div>
          </DialogHeader>

          <StatBar responseCount={responseCount} extra={{ icon: 'history_toggle_off', label: t(`${m}.statExtra`) }} />

          <WhatHappensBox heading={t(`${m}.bodyHeading`)}>
            <CheckRow icon="block" color="#d97706" bg="rgba(217,119,6,0.1)"
              text={t(`${m}.row1text`)} sub={t(`${m}.row1sub`)} />
            <CheckRow icon="shield" color="#059669" bg="rgba(5,150,105,0.1)"
              text={t(`${m}.row2text`)} sub={t(`${m}.row2sub`)} />
            <CheckRow icon="insights" color="var(--color-tertiary)" bg="color-mix(in srgb, var(--color-tertiary) 10%, transparent)"
              text={t(`${m}.row3text`)} sub={t(`${m}.row3sub`)} />
            <CheckRow icon="play_circle" color="var(--color-primary)" bg="color-mix(in srgb, var(--color-primary) 10%, transparent)"
              text={t(`${m}.row4text`)} sub={t(`${m}.row4sub`)} />
          </WhatHappensBox>

          <FooterNote icon="verified_user" iconColor="#059669" iconBg="rgba(5,150,105,0.05)">
            <strong style={{ color: '#059669' }}>{t(`${m}.footerBold`)}</strong>{' '}{t(`${m}.footerNote`)}
          </FooterNote>
        </div>

        <DialogFooter className="flex items-center gap-3 px-7 py-5 border-t border-border sm:justify-start">
          <CancelButton onClick={onClose} disabled={busy} label={t(`${m}.cancelButton`)} />
          <ActionButton
            onClick={onConfirm}
            busy={busy}
            busyLabel={t(`${m}.confirmingButton`)}
            icon="pause"
            label={t(`${m}.confirmButton`)}
            gradient="linear-gradient(135deg, #d97706, #b45309)"
            shadow="0 8px 24px rgba(217,119,6,0.25)"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUME MODAL
// ─────────────────────────────────────────────────────────────────────────────
export function ResumeModal({ open, onClose, onConfirm, busy, surveyTitle, responseCount = 0 }: ResumeModalProps) {
  const { t } = useTranslation();
  const m = 'surveys.modals.resume';

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className="max-w-lg rounded-3xl p-0 overflow-hidden gap-0">
        <div className="px-7 pt-7 pb-5">
          <DialogHeader className="mb-5">
            <div className="flex items-start gap-4">
              <ModalIcon
                gradient="linear-gradient(135deg, var(--color-primary), var(--color-tertiary))"
                icon="play_circle"
                shadow="0 8px 24px color-mix(in srgb, var(--color-primary) 30%, transparent)"
              />
              <div>
                <DialogTitle className="text-xl font-extrabold font-headline text-foreground">
                  {t(`${m}.title`)}
                </DialogTitle>
                <p className="text-sm mt-0.5 text-muted-foreground">
                  {t(`${m}.subtitle`, { title: surveyTitle || t('common.thisSurvey') })}
                </p>
              </div>
            </div>
          </DialogHeader>

          <StatBar responseCount={responseCount} extra={{ icon: 'add_circle', label: t(`${m}.statExtra`) }} />

          <WhatHappensBox heading={t(`${m}.bodyHeading`)}>
            <CheckRow icon="public" color="#059669" bg="rgba(5,150,105,0.1)"
              text={t(`${m}.row1text`)} sub={t(`${m}.row1sub`)} />
            <CheckRow icon="add_circle" color="var(--color-primary)" bg="color-mix(in srgb, var(--color-primary) 10%, transparent)"
              text={t(`${m}.row2text`)} sub={t(`${m}.row2sub`)} />
            <CheckRow icon="auto_awesome" color="var(--color-tertiary)" bg="color-mix(in srgb, var(--color-tertiary) 10%, transparent)"
              text={t(`${m}.row3text`)} sub={t(`${m}.row3sub`)} />
            <CheckRow icon="notifications" color="#d97706" bg="rgba(217,119,6,0.1)"
              text={t(`${m}.row4text`)} sub={t(`${m}.row4sub`)} />
          </WhatHappensBox>

          <FooterNote icon="bolt" iconColor="var(--color-primary)" iconBg="color-mix(in srgb, var(--color-primary) 5%, transparent)">
            <strong style={{ color: 'var(--color-primary)' }}>{t(`${m}.footerBold`)}</strong>{' '}{t(`${m}.footerNote`)}
          </FooterNote>
        </div>

        <DialogFooter className="flex items-center gap-3 px-7 py-5 border-t border-border sm:justify-start">
          <CancelButton onClick={onClose} disabled={busy} label={t(`${m}.cancelButton`)} />
          <ActionButton
            onClick={onConfirm}
            busy={busy}
            busyLabel={t(`${m}.confirmingButton`)}
            icon="play_arrow"
            label={t(`${m}.confirmButton`)}
            gradient="linear-gradient(135deg, var(--color-primary), var(--color-tertiary))"
            shadow="0 8px 24px color-mix(in srgb, var(--color-primary) 30%, transparent)"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOSE MODAL
// ─────────────────────────────────────────────────────────────────────────────
export function CloseModal({ open, onClose, onConfirm, busy, surveyTitle, responseCount = 0 }: CloseModalProps) {
  const { t } = useTranslation();
  const m = 'surveys.modals.close';

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className="max-w-lg rounded-3xl p-0 overflow-hidden gap-0">
        <div className="px-7 pt-7 pb-5">
          <DialogHeader className="mb-5">
            <div className="flex items-start gap-4">
              <ModalIcon
                gradient="linear-gradient(135deg, #4b5563, #374151)"
                icon="lock"
                shadow="0 8px 24px rgba(75,85,99,0.3)"
              />
              <div>
                <DialogTitle className="text-xl font-extrabold font-headline text-foreground">
                  {t(`${m}.title`)}
                </DialogTitle>
                <p className="text-sm mt-0.5 text-muted-foreground">
                  {t(`${m}.subtitle`, { title: surveyTitle || t('common.thisSurvey') })}
                </p>
              </div>
            </div>
          </DialogHeader>

          <StatBar
            responseCount={responseCount}
            extra={{ icon: 'lock_open', label: t(`${m}.statExtra`) }}
          />

          <WhatHappensBox heading={t(`${m}.bodyHeading`)}>
            <CheckRow icon="block" color="#6b7280" bg="rgba(107,114,128,0.1)"
              text={t(`${m}.row1text`)} sub={t(`${m}.row1sub`)} />
            <CheckRow icon="shield" color="#059669" bg="rgba(5,150,105,0.1)"
              text={t(`${m}.row2text`)} sub={t(`${m}.row2sub`)} />
            <CheckRow icon="lock_open" color="var(--color-primary)" bg="color-mix(in srgb, var(--color-primary) 10%, transparent)"
              text={t(`${m}.row3text`)} sub={t(`${m}.row3sub`)} />
            <CheckRow icon="compare_arrows" color="var(--color-tertiary)" bg="color-mix(in srgb, var(--color-tertiary) 10%, transparent)"
              text={t(`${m}.row4text`)} sub={t(`${m}.row4sub`)} />
          </WhatHappensBox>

          <div className="rounded-2xl p-4 mb-4"
            style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)' }}>
            <p className="text-[10px] font-black uppercase tracking-widest mb-3" style={{ color: 'var(--color-primary)' }}>
              {t(`${m}.afterHeading`)}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {[
                { icon: 'insights',  label: t(`${m}.after1Label`), sub: t(`${m}.after1Sub`) },
                { icon: 'download',  label: t(`${m}.after2Label`), sub: t(`${m}.after2Sub`) },
                { icon: 'lock_open', label: t(`${m}.after3Label`), sub: t(`${m}.after3Sub`) },
              ].map(({ icon, label, sub }) => (
                <div key={label} className="flex flex-col items-center text-center gap-1 p-2.5 rounded-xl"
                  style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)' }}>
                  <Icon name={icon} size={16} style={{ color: 'var(--color-primary)' }} />
                  <span className="text-xs font-bold text-foreground">{label}</span>
                  <span className="text-[10px] text-muted-foreground">{sub}</span>
                </div>
              ))}
            </div>
          </div>

          <FooterNote icon="verified_user" iconColor="#059669" iconBg="rgba(5,150,105,0.05)">
            <strong style={{ color: '#059669' }}>{t(`${m}.footerBold`)}</strong>{' '}{t(`${m}.footerNote`)}
          </FooterNote>
        </div>

        <DialogFooter className="flex items-center gap-3 px-7 py-5 border-t border-border sm:justify-start">
          <CancelButton onClick={onClose} disabled={busy} label={t(`${m}.cancelButton`)} />
          <ActionButton
            onClick={onConfirm}
            busy={busy}
            busyLabel={t(`${m}.confirmingButton`)}
            icon="lock"
            label={t(`${m}.confirmButton`)}
            gradient="linear-gradient(135deg, #4b5563, #374151)"
            shadow="0 8px 24px rgba(75,85,99,0.25)"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REOPEN MODAL
// ─────────────────────────────────────────────────────────────────────────────
export function ReopenModal({ open, onClose, onConfirm, busy, surveyTitle, responseCount = 0 }: ReopenModalProps) {
  const { t } = useTranslation();
  const m = 'surveys.modals.reopen';

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className="max-w-lg rounded-3xl p-0 overflow-hidden gap-0">
        <div className="px-7 pt-7 pb-5">
          <DialogHeader className="mb-5">
            <div className="flex items-start gap-4">
              <ModalIcon
                gradient="linear-gradient(135deg, var(--color-primary), var(--color-tertiary))"
                icon="lock_open"
                shadow="0 8px 24px color-mix(in srgb, var(--color-primary) 30%, transparent)"
              />
              <div>
                <DialogTitle className="text-xl font-extrabold font-headline text-foreground">
                  {t(`${m}.title`)}
                </DialogTitle>
                <p className="text-sm mt-0.5 text-muted-foreground">
                  {t(`${m}.subtitle`, { title: surveyTitle || t('common.thisSurvey') })}
                </p>
              </div>
            </div>
          </DialogHeader>

          <StatBar
            responseCount={responseCount}
            extra={{ icon: 'add_circle', label: t(`${m}.statExtra`) }}
          />

          <WhatHappensBox heading={t(`${m}.bodyHeading`)}>
            <CheckRow icon="public" color="#059669" bg="rgba(5,150,105,0.1)"
              text={t(`${m}.row1text`)} sub={t(`${m}.row1sub`)} />
            <CheckRow icon="add_circle" color="var(--color-primary)" bg="color-mix(in srgb, var(--color-primary) 10%, transparent)"
              text={t(`${m}.row2text`)} sub={t(`${m}.row2sub`)} />
            <CheckRow icon="auto_awesome" color="var(--color-tertiary)" bg="color-mix(in srgb, var(--color-tertiary) 10%, transparent)"
              text={t(`${m}.row3text`)} sub={t(`${m}.row3sub`)} />
            <CheckRow icon="pause_circle" color="#d97706" bg="rgba(217,119,6,0.1)"
              text={t(`${m}.row4text`)} sub={t(`${m}.row4sub`)} />
          </WhatHappensBox>

          <FooterNote icon="bolt" iconColor="var(--color-primary)" iconBg="color-mix(in srgb, var(--color-primary) 5%, transparent)">
            <strong style={{ color: 'var(--color-primary)' }}>{t(`${m}.footerBold`)}</strong>{' '}{t(`${m}.footerNote`)}
          </FooterNote>
        </div>

        <DialogFooter className="flex items-center gap-3 px-7 py-5 border-t border-border sm:justify-start">
          <CancelButton onClick={onClose} disabled={busy} label={t(`${m}.cancelButton`)} />
          <ActionButton
            onClick={onConfirm}
            busy={busy}
            busyLabel={t(`${m}.confirmingButton`)}
            icon="lock_open"
            label={t(`${m}.confirmButton`)}
            gradient="linear-gradient(135deg, var(--color-primary), var(--color-tertiary))"
            shadow="0 8px 24px color-mix(in srgb, var(--color-primary) 30%, transparent)"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE MODAL
// ─────────────────────────────────────────────────────────────────────────────
export function DeleteSurveyModal({ open, onClose, onConfirm, busy, surveyTitle, responseCount = 0 }: DeleteSurveyModalProps) {
  const { t } = useTranslation();
  const m = 'surveys.modals.delete';

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className="max-w-lg rounded-3xl p-0 overflow-hidden gap-0">
        <div className="px-7 pt-7 pb-5">
          <DialogHeader className="mb-5">
            <div className="flex items-start gap-4">
              <ModalIcon
                gradient="linear-gradient(135deg, #b41340, #7f0f2e)"
                icon="delete_forever"
                shadow="0 8px 24px rgba(180,19,64,0.3)"
              />
              <div>
                <DialogTitle className="text-xl font-extrabold font-headline text-foreground">
                  {t(`${m}.title`)}
                </DialogTitle>
                <p className="text-sm mt-0.5 text-muted-foreground">
                  {t(`${m}.subtitle`, { title: surveyTitle || t('common.thisSurvey') })}
                </p>
              </div>
            </div>
          </DialogHeader>

          {responseCount > 0 && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-2xl mb-4"
              style={{ background: 'rgba(180,19,64,0.05)', border: '1px solid rgba(180,19,64,0.15)' }}>
              <Icon name="warning" size={16} style={{ color: '#b41340' }} />
              <span className="text-sm font-semibold text-foreground">
                <strong style={{ color: '#b41340' }}>
                  {t(responseCount !== 1 ? `${m}.responseWarningPlural` : `${m}.responseWarning`, { n: responseCount.toLocaleString() })}
                </strong>
                <span className="text-xs font-normal text-muted-foreground ml-1.5">
                  {t(`${m}.responseRecoverable`)}
                </span>
              </span>
            </div>
          )}

          <WhatHappensBox heading={t(`${m}.bodyHeading`)}>
            <CheckRow icon="visibility_off" color="#b41340" bg="rgba(180,19,64,0.1)"
              text={t(`${m}.row1text`)} sub={t(`${m}.row1sub`)} />
            <CheckRow icon="link_off" color="#d97706" bg="rgba(217,119,6,0.1)"
              text={t(`${m}.row2text`)} sub={t(`${m}.row2sub`)} />
            <CheckRow icon="inventory_2" color="#059669" bg="rgba(5,150,105,0.1)"
              text={t(`${m}.row3text`)} sub={t(`${m}.row3sub`)} />
          </WhatHappensBox>

          <div className="rounded-2xl p-4 mb-4"
            style={{ background: 'rgba(180,19,64,0.04)', border: '1px solid rgba(180,19,64,0.12)' }}>
            <p className="text-[10px] font-black uppercase tracking-widest mb-2" style={{ color: '#b41340' }}>
              {t(`${m}.alternativesHeading`)}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { icon: 'pause_circle', label: t(`${m}.alt1Label`), sub: t(`${m}.alt1Sub`) },
                { icon: 'lock',         label: t(`${m}.alt2Label`), sub: t(`${m}.alt2Sub`) },
              ].map(({ icon, label, sub }) => (
                <div key={label} className="flex items-center gap-3 p-2.5 rounded-xl"
                  style={{ background: 'rgba(180,19,64,0.06)' }}>
                  <Icon name={icon} size={18} style={{ color: '#b41340' }} />
                  <div>
                    <div className="text-xs font-bold text-foreground">{label}</div>
                    <div className="text-[10px] text-muted-foreground">{sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <FooterNote icon="verified_user" iconColor="#059669" iconBg="rgba(5,150,105,0.05)">
            <strong style={{ color: '#059669' }}>{t(`${m}.footerBold`)}</strong>{' '}{t(`${m}.footerNote`)}
          </FooterNote>
        </div>

        <DialogFooter className="flex items-center gap-3 px-7 py-5 border-t border-border sm:justify-start">
          <CancelButton onClick={onClose} disabled={busy} label={t(`${m}.cancelButton`)} />
          <ActionButton
            onClick={onConfirm}
            busy={busy}
            busyLabel={t(`${m}.confirmingButton`)}
            icon="delete_forever"
            label={t(`${m}.confirmButton`)}
            gradient="linear-gradient(135deg, #b41340, #7f0f2e)"
            shadow="0 8px 24px rgba(180,19,64,0.3)"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
