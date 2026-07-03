import React from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import type { PipelineStats as PipelineStatsType } from '../../lib/api';

interface PipelineStatsProps {
  stats: PipelineStatsType;
}

const GLASS_CARD_STYLE: React.CSSProperties = {
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  background: 'rgba(255,255,255,0.72)',
  border: '1px solid rgba(255,255,255,0.5)',
  borderRadius: '1rem',
  padding: '1.5rem',
};

// Colors keyed by pipeline status
const STATUS_COLORS: Record<string, string> = {
  pending_review: '#f59e0b',
  auto_approved: '#10b981',
  requires_annotation: '#ef4444',
  live: '#059669',
  rejected: '#dc2626',
  queued: '#94a3b8',
  extracting: '#818cf8',
  drafting: '#6366f1',
  quality_check: '#8b5cf6',
  publishing: '#0ea5e9',
  stale: '#d97706',
};

const STATUS_LABELS: Record<string, string> = {
  pending_review: 'Pending review',
  auto_approved: 'Auto-approved',
  requires_annotation: 'Needs annotation',
  live: 'Live',
  rejected: 'Rejected',
  queued: 'Queued',
  extracting: 'Extracting',
  drafting: 'Drafting',
  quality_check: 'Quality check',
  publishing: 'Publishing',
  stale: 'Stale',
};

const QUALITY_BUCKET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e'];
const QUALITY_BUCKET_LABELS = ['<0.65', '0.65–0.75', '0.75–0.90', '0.90–1.0'];

function TrendBadge({ delta, suffix }: { delta: number; suffix?: string }) {
  const positive = delta >= 0;
  return (
    <span
      style={{
        fontSize: '0.75rem',
        fontWeight: 600,
        color: positive ? '#166534' : '#991b1b',
      }}
    >
      {positive ? '▲' : '▼'} {Math.abs(delta)}{suffix ?? ''}
    </span>
  );
}

export function PipelineStats({ stats }: PipelineStatsProps) {
  const { t } = useTranslation();

  // Build quality histogram data from the 4-bucket format
  const qualityBuckets = stats.qualityHistogram ?? [];
  const bucketCounts = [
    qualityBuckets.find((b) => b.bucket === 'below_0.65')?.count ?? 0,
    qualityBuckets.find((b) => b.bucket === '0.65_0.75')?.count ?? 0,
    qualityBuckets.find((b) => b.bucket === '0.75_0.90')?.count ?? 0,
    qualityBuckets.find((b) => b.bucket === 'above_0.90')?.count ?? 0,
  ];
  const maxBucketCount = Math.max(...bucketCounts, 1);

  // Build status distribution data
  const statusEntries = Object.entries(stats.statusDistribution ?? {}).filter(
    ([, count]) => count > 0,
  );
  const totalDocs = statusEntries.reduce((sum, [, count]) => sum + count, 0);

  // KPI cards definition
  const kpis = [
    {
      key: 'docsLive',
      label: t('admin.docPipeline.docsLive'),
      value: stats.docsLive,
      delta: stats.docsLiveDelta,
      icon: 'article',
      suffix: ' vs yesterday',
    },
    {
      key: 'publishedToday',
      label: t('admin.docPipeline.publishedToday'),
      value: stats.publishedToday,
      delta: stats.publishedTodayDelta,
      icon: 'publish',
      suffix: ' vs yesterday',
    },
    {
      key: 'gapsOpen',
      label: t('admin.docPipeline.docGaps'),
      value: stats.gapsOpen,
      delta: null,
      icon: 'help_outline',
      suffix: '',
    },
    {
      key: 'avgQualityScore',
      label: t('admin.docPipeline.avgQualityScore'),
      value: `${Math.round(stats.avgQualityScore * 100)}%`,
      delta: null,
      icon: 'verified',
      suffix: '',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* KPI cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '1rem',
        }}
        className="md:grid-cols-4"
      >
        {kpis.map((kpi, idx) => (
          <motion.div
            key={kpi.key}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: idx * 0.08, ease: [0.22, 1, 0.36, 1] }}
            style={GLASS_CARD_STYLE}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '0.75rem',
              }}
            >
              <span
                style={{
                  fontSize: '0.688rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: '#6b7280',
                }}
              >
                {kpi.label}
              </span>
              <div
                style={{
                  width: '2rem',
                  height: '2rem',
                  borderRadius: '0.5rem',
                  background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name={kpi.icon} size={16} style={{ color: 'var(--color-primary)' }} />
              </div>
            </div>
            <div
              style={{
                fontSize: '2rem',
                fontWeight: 800,
                color: '#111827',
                lineHeight: 1,
                marginBottom: '0.375rem',
              }}
            >
              {kpi.value}
            </div>
            {kpi.delta !== null && (
              <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                <TrendBadge delta={kpi.delta} />
                <span style={{ marginLeft: '0.25rem' }}>{kpi.suffix}</span>
              </div>
            )}
          </motion.div>
        ))}
      </div>

      {/* Status distribution bar chart */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.36, ease: [0.22, 1, 0.36, 1] }}
        style={GLASS_CARD_STYLE}
      >
        <h3
          style={{
            fontSize: '0.875rem',
            fontWeight: 700,
            color: '#374151',
            marginBottom: '1rem',
          }}
        >
          {t('admin.docPipeline.statusDistribution')}
        </h3>

        {/* Stacked bar */}
        <div
          style={{
            display: 'flex',
            height: '1.25rem',
            borderRadius: '999px',
            overflow: 'hidden',
            background: totalDocs === 0 ? '#e5e7eb' : 'transparent',
            marginBottom: '0.875rem',
          }}
        >
          {totalDocs === 0 ? null : statusEntries.map(([status, count]) => {
            const pct = (count / totalDocs) * 100;
            return (
              <div
                key={status}
                title={`${STATUS_LABELS[status] ?? status}: ${count}`}
                style={{
                  width: `${pct}%`,
                  background: STATUS_COLORS[status] ?? '#94a3b8',
                  flexShrink: 0,
                }}
              />
            );
          })}
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem' }}>
          {statusEntries.map(([status, count]) => (
            <div
              key={status}
              style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}
            >
              <div
                style={{
                  width: '0.5rem',
                  height: '0.5rem',
                  borderRadius: '50%',
                  background: STATUS_COLORS[status] ?? '#94a3b8',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                {STATUS_LABELS[status] ?? status}
              </span>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#374151' }}>
                {count}
              </span>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Quality score histogram */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.44, ease: [0.22, 1, 0.36, 1] }}
        style={GLASS_CARD_STYLE}
      >
        <h3
          style={{
            fontSize: '0.875rem',
            fontWeight: 700,
            color: '#374151',
            marginBottom: '1.25rem',
          }}
        >
          {t('admin.docPipeline.qualityDistribution')}
        </h3>

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: '0.75rem',
            height: '8rem',
          }}
        >
          {bucketCounts.map((count, idx) => {
            const heightPct = (count / maxBucketCount) * 100;
            return (
              <div
                key={idx}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  height: '100%',
                  justifyContent: 'flex-end',
                }}
              >
                {/* Count label above bar */}
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    color: '#374151',
                    marginBottom: '0.25rem',
                  }}
                >
                  {count}
                </span>
                {/* Bar */}
                <div
                  style={{
                    width: '100%',
                    height: `${heightPct}%`,
                    minHeight: count > 0 ? '4px' : '0',
                    background: QUALITY_BUCKET_COLORS[idx],
                    borderRadius: '0.375rem 0.375rem 0 0',
                    transition: 'height 0.4s ease',
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* X-axis labels */}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
          {QUALITY_BUCKET_LABELS.map((label, idx) => (
            <div
              key={idx}
              style={{
                flex: 1,
                textAlign: 'center',
                fontSize: '0.688rem',
                color: '#9ca3af',
                fontWeight: 600,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
