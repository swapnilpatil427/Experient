import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import type { PipelineEvent } from '../../lib/api';

interface PipelineEventFeedProps {
  events: PipelineEvent[];
  newSinceLastVisit: number;
}

const PAGE_SIZE = 20;

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays} days ago`;
}

function formatEventLabel(eventType: string, actor: string | null): string {
  const labels: Record<string, string> = {
    queued: 'Queued for processing',
    draft_ready: 'Draft ready',
    auto_approved: 'Auto-approved',
    admin_approved: 'Approved',
    admin_rejected: 'Rejected',
    published: 'Published to support site',
    stale_detected: 'Marked as stale',
    quality_check_passed: 'Quality check passed',
    quality_check_failed: 'Quality check failed',
    annotation_requested: 'Annotation requested',
  };

  const base = labels[eventType] ?? eventType.replace(/_/g, ' ');

  if ((eventType === 'admin_approved' || eventType === 'admin_rejected') && actor) {
    return `${base} by ${actor}`;
  }
  return base;
}

function formatGroupDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function PipelineEventFeed({ events, newSinceLastVisit }: PipelineEventFeedProps) {
  const { t } = useTranslation();
  const [pages, setPages] = useState(1);

  const visibleEvents = events.slice(0, pages * PAGE_SIZE);
  const hasMore = visibleEvents.length < events.length;

  // Group visible events by date
  const groups: Array<{ date: string; items: Array<{ event: PipelineEvent; index: number }> }> = [];
  const dateMap = new Map<string, Array<{ event: PipelineEvent; index: number }>>();

  visibleEvents.forEach((event, index) => {
    const date = formatGroupDate(event.occurredAt);
    if (!dateMap.has(date)) {
      dateMap.set(date, []);
      groups.push({ date, items: dateMap.get(date)! });
    }
    dateMap.get(date)!.push({ event, index });
  });

  if (events.length === 0) {
    return (
      <div
        style={{ padding: '3rem 1rem', textAlign: 'center', color: '#9ca3af' }}
      >
        {t('admin.docPipeline.noActivity')}
      </div>
    );
  }

  return (
    <div>
      {/* New since last visit badge */}
      <AnimatePresence>
        {newSinceLastVisit > 0 && (
          <motion.div
            key="new-badge"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
              background: 'rgba(245, 158, 11, 0.12)',
              border: '1px solid rgba(245, 158, 11, 0.35)',
              borderRadius: '999px',
              padding: '0.25rem 0.75rem',
              marginBottom: '1rem',
              fontSize: '0.813rem',
              color: '#92400e',
              fontWeight: 600,
            }}
          >
            <Icon name="new_releases" size={14} style={{ color: '#d97706' }} />
            <span>{newSinceLastVisit} {t('admin.docPipeline.newSinceLastVisit')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Grouped event list */}
      {groups.map(({ date, items }) => (
        <div key={date}>
          {/* Date separator */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              margin: '1rem 0 0.5rem',
            }}
          >
            <div style={{ flex: 1, height: '1px', background: 'rgba(0,0,0,0.08)' }} />
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: '#9ca3af',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                whiteSpace: 'nowrap',
              }}
            >
              {date}
            </span>
            <div style={{ flex: 1, height: '1px', background: 'rgba(0,0,0,0.08)' }} />
          </div>

          {/* Events */}
          {items.map(({ event, index }) => (
            <motion.div
              key={event.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: index * 0.04 }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
                padding: '0.625rem 0',
                borderBottom: '1px solid rgba(0,0,0,0.05)',
              }}
            >
              {/* Actor icon */}
              <div
                style={{
                  width: '2rem',
                  height: '2rem',
                  borderRadius: '50%',
                  background:
                    event.actorType === 'crystal' || event.actorType === 'system'
                      ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)'
                      : 'rgba(107,114,128,0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {event.actorType === 'crystal' || event.actorType === 'system' ? (
                  <Icon
                    name="smart_toy"
                    size={14}
                    style={{ color: 'var(--color-primary)' }}
                  />
                ) : (
                  <Icon name="person" size={14} style={{ color: '#6b7280' }} />
                )}
              </div>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '0.5rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: '0.875rem',
                      color: 'var(--color-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '16rem',
                    }}
                  >
                    {event.docTitle}
                  </span>
                  <span
                    style={{
                      fontSize: '0.813rem',
                      color: '#374151',
                    }}
                  >
                    {formatEventLabel(event.eventType, event.actor ?? null)}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '0.75rem',
                    color: '#9ca3af',
                    marginTop: '0.125rem',
                    display: 'block',
                  }}
                >
                  {relativeTime(event.occurredAt)}
                </span>
              </div>
            </motion.div>
          ))}
        </div>
      ))}

      {/* Load more */}
      {hasMore && (
        <div style={{ marginTop: '1rem', textAlign: 'center' }}>
          <button
            onClick={() => setPages((p) => p + 1)}
            style={{
              background: 'none',
              border: '1px solid rgba(0,0,0,0.12)',
              borderRadius: '0.5rem',
              padding: '0.375rem 1rem',
              fontSize: '0.813rem',
              color: '#6b7280',
              cursor: 'pointer',
            }}
          >
            {t('admin.docPipeline.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
