// Shared primitives for the four Insights variants.
// Each variant uses these to render trust signals consistently:
// - CitationChip       — clickable [rXXX] inline reference
// - ConfidenceChip     — color-coded confidence label
// - CIBar              — visual confidence interval
// - LayerBadge         — descriptive | diagnostic | predictive | prescriptive
// - GlassCard / GlassCardDark — surface wrappers

import React from 'react';
import { Icon } from '../../components/Icon';
import { useTranslation } from '../../lib/i18n';

// ── Layer config — single source of truth for all four insight layers ────────
export type InsightLayer = 'descriptive' | 'diagnostic' | 'predictive' | 'prescriptive';

// Visual-only config — labels/tooltips live in locales/en.ts under surveyInsights.layers
export const LAYER_CONFIG: Record<InsightLayer, {
  color: string; bg: string; ringColor: string; textColor: string;
}> = {
  descriptive:  { color: '#0369a1', bg: '#e0f2fe', ringColor: '#2a4bd9', textColor: 'text-blue-700'   },
  diagnostic:   { color: '#7c3aed', bg: '#ede9fe', ringColor: '#8329c8', textColor: 'text-purple-700' },
  predictive:   { color: '#d97706', bg: '#fef3c7', ringColor: '#d97706', textColor: 'text-amber-700'  },
  prescriptive: { color: '#059669', bg: '#d1fae5', ringColor: '#059669', textColor: 'text-green-700'  },
};

// ── Citation chip ────────────────────────────────────────────────────────────

const SENTIMENT_BORDER: Record<string, string> = {
  positive: '#16a34a',
  negative: '#dc2626',
  neutral:  'var(--color-outline-variant, #ccc)',
};

// `onClick` is additive (org-dashboard's Crystal Brief needs click-to-reveal
// citations, per DESIGN.md's Trust/Citation progressive-disclosure spec —
// "stay click-to-reveal, exactly as the existing CitationChip already
// behaves"). Optional and defaults to undefined so every existing caller
// keeps its current no-op behavior unchanged.
export function CitationChip({
  id, dark = false, title, onClick,
}: {
  id: string; dark?: boolean; title?: string; onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center px-1.5 mx-0.5 rounded-full text-[10px] font-bold transition-colors cursor-pointer ' +
        (dark
          ? 'bg-white/15 text-[#d299ff] hover:bg-white/25'
          : 'bg-primary/10 text-primary hover:bg-primary/20')
      }
      title={title ?? `Open quote ${id}`}
    >
      [{id}]
    </button>
  );
}

export { SENTIMENT_BORDER };

// ── Confidence chip ──────────────────────────────────────────────────────────
export function ConfidenceChip({ value, dark = false }: { value: number; dark?: boolean }) {
  const { t } = useTranslation();
  const tier =
    value >= 80 ? 'high' : value >= 60 ? 'mid' : 'low';
  const cls =
    tier === 'high'
      ? dark
        ? 'bg-green-400/20 text-green-300'
        : 'bg-green-100 text-green-700'
      : tier === 'mid'
        ? dark
          ? 'bg-amber-400/20 text-amber-300'
          : 'bg-amber-100 text-amber-700'
        : dark
          ? 'bg-white/15 text-white/70'
          : 'bg-muted text-muted-foreground';
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-black tracking-wide ${cls}`}>
      {t('surveyInsights.confidence.label', { value })}
    </span>
  );
}

// ── CI Bar (visual confidence interval) ──────────────────────────────────────
export function CIBar({ position, width = 100, dark = false }: { position: number; width?: number; dark?: boolean }) {
  return (
    <div
      className="relative rounded-full"
      style={{
        width,
        height: 6,
        background: dark
          ? 'linear-gradient(90deg, rgba(135,154,255,0.15), rgba(135,154,255,0.4), rgba(135,154,255,0.15))'
          : 'linear-gradient(90deg, rgba(42,75,217,0.15), rgba(42,75,217,0.4), rgba(42,75,217,0.15))',
      }}
    >
      <div
        className="absolute"
        style={{
          left: `${position}%`,
          top: -3,
          width: 2,
          height: 12,
          background: dark ? '#d299ff' : '#2a4bd9',
        }}
      />
    </div>
  );
}

// ── Layer badge ──────────────────────────────────────────────────────────────
export function LayerBadge({ layer, icon, dark = false }: { layer: InsightLayer; icon?: string; dark?: boolean }) {
  const { t } = useTranslation();
  const m = LAYER_CONFIG[layer];
  return (
    <div className="flex items-center gap-2">
      {icon && (
        <Icon
          name={icon}
          size={16}
          style={{ color: dark ? '#d299ff' : m.ringColor }}
        />
      )}
      <span
        className={'text-[10px] font-black uppercase tracking-[0.18em] ' + (dark ? 'text-white/80' : m.textColor)}
        style={dark ? undefined : { color: m.ringColor }}
      >
        {t(`surveyInsights.layers.${layer}.label`)}
      </span>
    </div>
  );
}

// ── Glass card wrappers ─────────────────────────────────────────────────────
export function GlassCard({
  className = '',
  style,
  children,
  ariaLabel,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div
      className={`glass-card-premium rounded-2xl ${className}`}
      style={{
        boxShadow: '0 4px 24px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8)',
        border: '1px solid rgba(255,255,255,0.6)',
        ...style,
      }}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

export function GlassCardDark({
  className = '',
  style,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl ${className}`}
      style={{
        background: 'rgba(255,255,255,0.07)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        border: '1px solid rgba(255,255,255,0.15)',
        color: '#f2f1ff',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Live pulse dot ──────────────────────────────────────────────────────────
export function LiveDot({ color = '#059669', size = 6 }: { color?: string; size?: number }) {
  return (
    <span
      className="inline-block rounded-full"
      style={{
        width: size,
        height: size,
        background: color,
        animation: 'pulse-glow 2.5s ease-in-out infinite',
      }}
    />
  );
}
