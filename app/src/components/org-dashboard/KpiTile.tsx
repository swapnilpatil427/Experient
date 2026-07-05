// KpiTile — extracted verbatim from ExperienceHubPage.tsx (was defined
// inline, lines ~614-655, not exported). Pure extraction: same props, same
// rendering, zero behavior change. ExperienceHubPage.tsx now imports this
// instead of defining it locally.
//
// Reused across the Org Dashboard design system per IMPLEMENTATION_SPEC.md
// (5th KPI tile on the Hub, full KPI row on the Command Center page).

import { Icon } from '../Icon';
import { GlassCard } from '../../pages/insights/shared';

export interface KpiTileProps {
  label: string;
  value: string;
  valueColor?: string;
  unit?: string;
  ci?: string;
  ciPosition?: number;
  sample?: string;
  icon: string;
  iconColor: string;
  sparkBars?: number[];
  sparkColor?: string;
  loading?: boolean;
}

export function KpiTile({
  label, value, valueColor, unit, ci, ciPosition, sample,
  icon, iconColor, sparkBars, sparkColor, loading,
}: KpiTileProps) {
  if (loading) return <div className="h-[112px] rounded-2xl bg-surface-container animate-pulse" />;
  return (
    <GlassCard className="p-5" style={{ boxShadow: '0 10px 30px -10px rgba(0,0,0,0.08), inset 0 2px 4px rgba(255,255,255,0.80)' }}>
      <div className="flex items-start justify-between mb-2.5">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `${iconColor}18` }}>
          <Icon name={icon} size={17} style={{ color: iconColor }} />
        </div>
      </div>
      <div className="flex items-baseline gap-1.5 mb-0.5">
        <span className="font-headline text-[28px] font-black leading-none" style={{ color: valueColor }}>{value}</span>
        {unit && <span className="text-xs text-on-surface-variant font-medium">{unit}</span>}
        {ci   && <span className="text-[10px] text-on-surface-variant font-mono">{ci}</span>}
      </div>
      <div className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-1.5">{label}</div>
      {ciPosition != null && (
        <div className="relative h-1 rounded-full mb-1.5"
          style={{ background: 'linear-gradient(90deg, color-mix(in srgb, var(--color-primary) 10%, transparent), color-mix(in srgb, var(--color-primary) 35%, transparent), color-mix(in srgb, var(--color-primary) 10%, transparent))' }}>
          <div className="absolute top-[-3px] w-[2px] h-[7px] rounded-full"
            style={{ left: `${ciPosition}%`, background: 'var(--color-primary)' }} />
        </div>
      )}
      {sparkBars && sparkBars.length > 0 && (
        <div className="flex items-end gap-[2px] h-5 mt-1">
          {sparkBars.map((h, i) => (
            <span key={i} className="flex-1 rounded-sm"
              style={{ height: h, background: sparkColor ?? 'var(--color-primary)', opacity: 0.50 + (i / sparkBars.length) * 0.45 }} />
          ))}
        </div>
      )}
      {sample && <div className="text-[9px] text-on-surface-variant/60 font-mono mt-0.5">{sample}</div>}
    </GlassCard>
  );
}
