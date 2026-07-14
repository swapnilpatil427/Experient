// EmergingTopics — DESIGN.md §6. Full-width horizontal scrollable chip row;
// clicking a chip opens TopicDrawer.

import { useState } from 'react';
import { useTranslation } from '../../lib/i18n';
import { TopicChip } from './TopicChip';
import { TopicDrawer } from './TopicDrawer';
import type { OrgTopic } from '../../types/orgDashboard';

export function EmergingTopics({ topics, loading }: { topics: OrgTopic[]; loading: boolean }) {
  const { t } = useTranslation();
  const [activeTopic, setActiveTopic] = useState<OrgTopic | null>(null);

  if (loading) {
    return (
      <div className="bg-gray-50 rounded-xl px-4 py-4 border border-gray-100">
        <div className="flex gap-2">
          {[...Array(5)].map((_, i) => <div key={i} className="h-9 w-28 rounded-full bg-surface-container animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (topics.length === 0) {
    return (
      <div className="bg-gray-50 rounded-xl px-4 py-4 border border-gray-100 text-center">
        <p className="text-sm text-gray-500">{t('orgDashboard.topics.empty')}</p>
      </div>
    );
  }

  return (
    <div className="relative bg-gray-50 rounded-xl px-4 py-4 border border-gray-100">
      <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
        {topics.map((topic) => (
          <TopicChip key={topic.topicLabel} topic={topic} onClick={() => setActiveTopic(topic)} />
        ))}
      </div>
      <TopicDrawer topic={activeTopic} onClose={() => setActiveTopic(null)} />
    </div>
  );
}
