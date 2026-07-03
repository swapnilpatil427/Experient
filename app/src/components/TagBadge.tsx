import { cn } from '@/lib/utils';
import { Icon } from './Icon';
import { useTranslation } from '../lib/i18n';
import type { SurveyTag } from '../lib/api';

interface TagBadgeProps {
  tag: SurveyTag;
  removable?: boolean;
  onRemove?: (tagId: string) => void;
  /**
   * Tag Report entry point (TRACKER.md §3 Part D). When present, the chip
   * becomes a live link to that tag's report: hover lift + fade-in chevron,
   * click navigates via the caller-provided callback. `stopPropagation`'d so
   * it never also triggers a parent row/card's own click-through — same
   * precedent as `removable`'s ✕ handler below.
   */
  onNavigate?: (tagId: string) => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function TagBadge({ tag, removable = false, onRemove, onNavigate, size = 'md', className }: TagBadgeProps) {
  const { t } = useTranslation();
  const sizeClass = size === 'sm'
    ? 'text-xs px-2 py-0.5 gap-1'
    : 'text-sm px-2.5 py-1 gap-1.5';

  const dotSize = size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2';
  const navigable = Boolean(onNavigate);
  const navigateLabel = t('tagReport.tagBadge.viewReport', { name: tag.name });

  const handleClick = (e: React.MouseEvent) => {
    if (!onNavigate) return;
    e.stopPropagation();
    onNavigate(tag.id);
  };

  return (
    <span
      role={navigable ? 'button' : undefined}
      tabIndex={navigable ? 0 : undefined}
      title={navigable ? navigateLabel : undefined}
      aria-label={navigable ? navigateLabel : undefined}
      onClick={navigable ? handleClick : undefined}
      onKeyDown={navigable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(e as unknown as React.MouseEvent); } } : undefined}
      className={cn(
        'inline-flex items-center rounded-full font-medium whitespace-nowrap transition-all',
        sizeClass,
        navigable && 'group cursor-pointer hover:brightness-95 hover:scale-[1.03]',
        className,
      )}
      style={{
        background: `${tag.color}1a`,
        color: tag.color,
        border: `1px solid ${tag.color}40`,
      }}
    >
      <span
        className={cn('rounded-full shrink-0', dotSize)}
        style={{ background: tag.color }}
      />
      <span className="truncate max-w-[160px]">{tag.name}</span>
      {navigable && (
        <Icon
          name="chevron_right"
          size={size === 'sm' ? 10 : 12}
          className="shrink-0 opacity-0 -ml-0.5 group-hover:opacity-100 transition-opacity"
        />
      )}
      {removable && onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(tag.id); }}
          className="shrink-0 ml-0.5 rounded-full opacity-60 hover:opacity-100 transition-opacity leading-none"
          aria-label={`Remove ${tag.name}`}
        >
          <Icon name="close" size={size === 'sm' ? 10 : 12} />
        </button>
      )}
    </span>
  );
}
