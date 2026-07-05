// TopicChip — per DESIGN.md §6 (Emerging Topics).
// Colored-dot sentiment indicator (not emoji, per Marcus's enterprise-UI
// note) + "new this week" blue-dot variant + "rising" green-arrow variant.

import { Icon } from '../Icon';
import type { OrgTopic } from '../../types/orgDashboard';

function sentimentDotColor(avgSentiment: number): string {
  if (avgSentiment > 0.3) return '#22c55e';
  if (avgSentiment < -0.3) return '#ef4444';
  return '#94a3b8';
}

export function TopicChip({ topic, onClick }: { topic: OrgTopic; onClick?: () => void }) {
  const isRising = (topic.frequencyChangePct ?? 0) > 50;
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-center gap-2 px-3 py-2 rounded-full border cursor-pointer whitespace-nowrap flex-shrink-0 transition-colors ' +
        'bg-white border-gray-200 text-gray-700 hover:border-gray-300' +
        (topic.isNewThisWeek ? ' border-l-2 border-l-blue-400' : '')
      }
    >
      {topic.isNewThisWeek && (
        <span className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" aria-hidden="true" />
      )}
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: sentimentDotColor(topic.avgSentiment) }}
        aria-hidden="true"
      />
      {isRising && <Icon name="trending_up" size={13} style={{ color: '#16a34a' }} />}
      <span className="text-sm font-medium">{topic.topicLabel}</span>
      <span className={'text-xs ml-1 ' + (isRising ? 'text-green-600 font-semibold' : 'text-gray-400')}>
        {topic.frequency}
      </span>
    </button>
  );
}
