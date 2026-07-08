// TopicHierarchyTree — Accordion-style theme groups containing topic cards.
// Each theme is collapsible; first 2 start expanded. Sort controls at top.

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../../lib/i18n';
import { Icon } from '../../../components/Icon';
import { Button } from '@/components/ui/button';
import type { SurveyTopic } from '../../../types';
import { TopicCard } from './TopicCard';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ThemeGroup {
  name: string;
  volume: number;
  sentiment_avg: number | null;
  topics: Array<SurveyTopic & { subtopics?: SurveyTopic[]; nps_correlation?: number | null }>;
}

interface TopicHierarchyTreeProps {
  themes: ThemeGroup[];
  selectedTopicId?: string;
  onSelectTopic: (topicId: string) => void;
  onAskCrystal: (query: string, ctx: { focused_topic: string }) => void;
  loading: boolean;
  onGenerate?: () => void;
  generating?: boolean;
}

type SortKey = 'volume' | 'nps_impact' | 'urgency' | 'trending';

// ── Helpers ────────────────────────────────────────────────────────────────────

function sentimentColor(avg: number | null): string {
  if (avg == null) return '#9ca3af';
  if (avg > 0.2)  return '#059669';
  if (avg < -0.2) return '#ef4444';
  return '#f59e0b';
}

function sortTopics(
  topics: ThemeGroup['topics'],
  key: SortKey,
): ThemeGroup['topics'] {
  return [...topics].sort((a, b) => {
    switch (key) {
      case 'volume':
        return b.volume - a.volume;
      case 'nps_impact': {
        const av = a.nps_correlation ?? a.nps_avg ?? 0;
        const bv = b.nps_correlation ?? b.nps_avg ?? 0;
        return Math.abs(bv as number) - Math.abs(av as number);
      }
      case 'urgency':
        return (b.urgency_score ?? 0) - (a.urgency_score ?? 0);
      case 'trending': {
        const order: Record<string, number> = { up: 0, new: 1, stable: 2, down: 3 };
        return (order[a.trending ?? 'stable'] ?? 2) - (order[b.trending ?? 'stable'] ?? 2);
      }
      default:
        return 0;
    }
  });
}

// ── Skeleton card ──────────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div
      className="rounded-2xl animate-pulse"
      style={{
        background: 'rgba(0,0,0,0.04)',
        border: '1px solid rgba(255,255,255,0.6)',
        height: 240,
      }}
    />
  );
}

// ── Theme section ──────────────────────────────────────────────────────────────
function ThemeSection({
  theme,
  defaultExpanded,
  selectedTopicId,
  onSelectTopic,
  onAskCrystal,
  sortKey,
}: {
  theme: ThemeGroup;
  defaultExpanded: boolean;
  selectedTopicId?: string;
  onSelectTopic: (id: string) => void;
  onAskCrystal: (q: string, ctx: { focused_topic: string }) => void;
  sortKey: SortKey;
}) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(defaultExpanded);

  const sortedTopics = useMemo(
    () => sortTopics(theme.topics, sortKey),
    [theme.topics, sortKey],
  );

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(0,0,0,0.07)' }}>
      {/* Theme header */}
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-black/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        style={{ background: 'rgba(255,255,255,0.6)' }}
        aria-expanded={isOpen}
      >
        {/* Sentiment color dot */}
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ background: sentimentColor(theme.sentiment_avg) }}
        />
        <span className="font-bold text-on-surface text-sm flex-1 min-w-0 truncate">
          {theme.name}
        </span>
        {/* Volume badge */}
        <span
          className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
          style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}
        >
          {theme.volume.toLocaleString()}
        </span>
        <span
          className="text-[11px] text-muted-foreground flex-shrink-0"
        >
          {t('topicsAnalysis.themeTopicsCount', { count: theme.topics.length })}
        </span>
        <Icon
          name="expand_more"
          size={18}
          className="text-muted-foreground transition-transform duration-200 flex-shrink-0"
          style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>

      {/* Topic grid */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div
              className="grid gap-4 p-4"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                background: 'rgba(0,0,0,0.01)',
              }}
            >
              {sortedTopics.map((topic) => (
                <div
                  key={topic.id}
                  className="transition-transform duration-150 hover:-translate-y-0.5"
                  style={{
                    // Selected topic: gradient left border
                    ...(selectedTopicId === topic.id
                      ? {
                          outline: '2px solid var(--color-primary)',
                          outlineOffset: '2px',
                          borderRadius: '1rem',
                        }
                      : {}),
                  }}
                >
                  <TopicCard
                    topic={topic}
                    onSelect={onSelectTopic}
                    onAskCrystal={onAskCrystal}
                  />
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── TopicHierarchyTree ─────────────────────────────────────────────────────────

export function TopicHierarchyTree({
  themes,
  selectedTopicId,
  onSelectTopic,
  onAskCrystal,
  loading,
  onGenerate,
  generating = false,
}: TopicHierarchyTreeProps) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('volume');

  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: 'volume',     label: t('topicsAnalysis.sortVolume') },
    { key: 'nps_impact', label: t('topicsAnalysis.sortNpsImpact') },
    { key: 'urgency',    label: t('topicsAnalysis.sortUrgency') },
    { key: 'trending',   label: t('topicsAnalysis.sortTrending') },
  ];

  if (loading) {
    return (
      <div className="space-y-4">
        {/* Sort bar skeleton */}
        <div className="h-9 w-72 rounded-full animate-pulse" style={{ background: 'rgba(0,0,0,0.06)' }} />
        {/* 6 skeleton cards */}
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (themes.length === 0) {
    return (
      <div
        className="glass-card-premium rounded-2xl p-12 text-center"
        style={{
          boxShadow: '0 4px 24px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.8)',
          border: '1px solid rgba(255,255,255,0.6)',
        }}
      >
        <Icon
          name="hub"
          size={48}
          style={{ color: 'var(--color-primary)', marginBottom: 16, display: 'block', margin: '0 auto 16px' }}
        />
        <h3 className="text-lg font-bold text-on-surface mb-2">
          {t('topicsAnalysis.noThemesTitle')}
        </h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">
          {t('topicsAnalysis.noThemesDesc')}
        </p>
        {onGenerate && (
          <Button
            onClick={onGenerate}
            disabled={generating}
            className="gap-2"
          >
            <Icon name={generating ? 'hourglass_empty' : 'play_arrow'} size={16} />
            {generating ? t('insights.generating') : t('topicsAnalysis.generateInsights')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Sort controls ──────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium">
          {t('topicsAnalysis.sortBy')}
        </span>
        <div
          className="flex items-center gap-1 p-1 rounded-full"
          style={{ background: 'rgba(0,0,0,0.05)' }}
        >
          {SORT_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setSortKey(key)}
              className="px-3 py-1 rounded-full text-xs font-semibold transition-all duration-150"
              style={
                sortKey === key
                  ? {
                      background: 'var(--color-primary)',
                      color: '#fff',
                      boxShadow: '0 1px 6px color-mix(in srgb, var(--color-primary) 30%, transparent)',
                    }
                  : { color: 'var(--color-on-surface-variant, #6b7280)' }
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Theme accordion sections ────────────────────────────────── */}
      <div className="space-y-3">
        {themes.map((theme, idx) => (
          <ThemeSection
            key={theme.name}
            theme={theme}
            defaultExpanded={idx < 2}
            selectedTopicId={selectedTopicId}
            onSelectTopic={onSelectTopic}
            onAskCrystal={onAskCrystal}
            sortKey={sortKey}
          />
        ))}
      </div>
    </div>
  );
}
