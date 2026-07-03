import { useTranslation } from '../../../lib/i18n';
import { useCrystalPanel } from '../../../contexts/crystalPanel';
import { Icon } from '../../Icon';
import { Button } from '@/components/ui/button';
import type { DashboardSummary } from '../../../lib/api';

interface CrystalNarrativeWidgetProps {
  summary: DashboardSummary | null;
}

const SENTIMENT_ACCENT: Record<string, string> = {
  positive: '#10b981',
  negative: '#ef4444',
  neutral:  'var(--color-primary)',
};

export function CrystalNarrativeWidget({ summary }: CrystalNarrativeWidgetProps) {
  const { t } = useTranslation();
  const { openCrystal } = useCrystalPanel();

  if (!summary) {
    return <div className="skeleton h-28 rounded-xl" />;
  }

  const accent = SENTIMENT_ACCENT[summary.narrative.sentiment] || SENTIMENT_ACCENT.neutral;

  return (
    <div className="relative rounded-xl overflow-hidden">
      {/* Subtle aurora background wash */}
      <div
        className="absolute inset-0 opacity-[0.05] pointer-events-none"
        style={{
          background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary), var(--color-secondary))',
          animation: 'aurora 8s ease-in-out infinite',
        }}
      />

      <div className="relative flex items-start gap-4">
        {/* Crystal icon orb */}
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center text-white text-base flex-shrink-0"
          style={{
            background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
            boxShadow: '0 4px 16px color-mix(in srgb, var(--color-primary) 35%, transparent)',
          }}
        >
          ◆
        </div>

        <div className="min-w-0 flex-1">
          {/* Label + live dot */}
          <div className="flex items-center gap-2 mb-2">
            <span
              className="text-[10px] font-black uppercase tracking-[0.14em] px-2 py-0.5 rounded-full"
              style={{ background: `${accent}18`, color: accent }}
            >
              {t('dashboard.crystalBrief')}
            </span>
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: accent, animation: 'pulse-glow 2.5s ease-in-out infinite' }}
            />
          </div>

          <h2 className="font-headline font-bold text-xl text-on-surface leading-tight mb-2">
            {summary.narrative.headline}
          </h2>

          {summary.narrative.paragraphs.map((p, i) => (
            <p key={i} className="text-sm text-on-surface-variant/80 mt-1.5 leading-relaxed">{p}</p>
          ))}

          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => openCrystal(t('dashboard.askCrystalSeed'))}
          >
            <Icon name="auto_awesome" size={14} className="mr-1.5" />
            {t('dashboard.askCrystal')}
          </Button>
        </div>
      </div>
    </div>
  );
}
