// TopicDrawer — DESIGN.md §6's chip-click expand drawer. Bottom sheet,
// closes via X, Escape (handled by the underlying Radix Dialog primitive
// Sheet already wraps), or clicking outside.

import { useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useTranslation } from '../../lib/i18n';
import { useTopicBreakdown } from '../../hooks/useOrgTopics';
import type { OrgTopic } from '../../types/orgDashboard';

export function TopicDrawer({ topic, onClose }: { topic: OrgTopic | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { breakdown, loading, load, clear } = useTopicBreakdown();

  useEffect(() => {
    if (topic) load(topic.topicLabel);
    else clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);

  return (
    <Sheet open={!!topic} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>{topic?.topicLabel}</SheetTitle>
        </SheetHeader>

        {topic && (
          <div className="mt-3 space-y-4">
            <p className="text-xs text-on-surface-variant">
              {t('orgDashboard.topics.drawerFrequency', { n: String(topic.frequency) })}
            </p>

            {loading && <div className="h-40 rounded-lg bg-surface-container animate-pulse" />}

            {!loading && breakdown && breakdown.bySurvey.length > 0 && (
              <div style={{ width: '100%', height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={breakdown.bySurvey} layout="vertical" margin={{ left: 8, right: 8 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="surveyTitle" width={120} tick={{ fontSize: 11 }} />
                    <RechartsTooltip />
                    <Bar dataKey="count" fill="#6366F1" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {!loading && breakdown && breakdown.sampleQuotes.length > 0 && (
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">
                  {t('orgDashboard.topics.sampleQuotes')}
                </p>
                <ul className="space-y-2">
                  {breakdown.sampleQuotes.slice(0, 3).map((q, i) => (
                    <li key={i} className="text-sm text-on-surface-variant italic border-l-2 border-outline-variant/30 pl-3">
                      "{q}"
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
