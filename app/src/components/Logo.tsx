interface LogoMarkProps {
  size?: number;
  className?: string;
}

export function LogoMark({ size = 40, className = '' }: LogoMarkProps) {
  const id = `logo-${size}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Xperiq logo mark"
    >
      <defs>
        <linearGradient id={`${id}-tr`} x1="50%" y1="8%" x2="92%" y2="50%">
          <stop offset="0%" stopColor="#a5b4fc" />
          <stop offset="100%" stopColor="var(--color-primary)" />
        </linearGradient>
        <linearGradient id={`${id}-br`} x1="92%" y1="50%" x2="50%" y2="92%">
          <stop offset="0%" stopColor="var(--color-primary)" />
          <stop offset="100%" stopColor="var(--color-primary-dim)" />
        </linearGradient>
        <linearGradient id={`${id}-bl`} x1="50%" y1="92%" x2="8%" y2="50%">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="var(--color-tertiary)" />
        </linearGradient>
        <linearGradient id={`${id}-tl`} x1="8%" y1="50%" x2="50%" y2="8%">
          <stop offset="0%" stopColor="#57d2f9" />
          <stop offset="100%" stopColor="var(--color-primary-container)" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* 4 triangular crystal faces */}
      <polygon points="50,8 92,50 50,50" fill={`url(#${id}-tr)`} />
      <polygon points="92,50 50,92 50,50" fill={`url(#${id}-br)`} />
      <polygon points="50,92 8,50 50,50" fill={`url(#${id}-bl)`} />
      <polygon points="8,50 50,8 50,50" fill={`url(#${id}-tl)`} />

      {/* Edge lines for faceted crystal look */}
      <line x1="50" y1="8" x2="92" y2="50" stroke="rgba(255,255,255,0.25)" strokeWidth="0.8" />
      <line x1="92" y1="50" x2="50" y2="92" stroke="rgba(255,255,255,0.1)" strokeWidth="0.8" />
      <line x1="50" y1="92" x2="8" y2="50" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8" />
      <line x1="8" y1="50" x2="50" y2="8" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
      <line x1="50" y1="8" x2="50" y2="92" stroke="rgba(255,255,255,0.12)" strokeWidth="0.6" />
      <line x1="8" y1="50" x2="92" y2="50" stroke="rgba(255,255,255,0.12)" strokeWidth="0.6" />

      {/* Top highlight sparkle */}
      <circle cx="50" cy="8" r="2.5" fill="rgba(255,255,255,0.9)" filter={`url(#${id}-glow)`} />
    </svg>
  );
}

interface LogoFullProps {
  height?: number;
  showTagline?: boolean;
  className?: string;
}

export function LogoFull({ height = 32, className = '', showTagline = false }: LogoFullProps) {
  const fontSize = height * 0.72;
  const taglineFontSize = height * 0.3;

  return (
    <div className={`flex items-center gap-2.5 ${className}`} style={{ lineHeight: 1 }}>
      <LogoMark size={height} />
      <div className="flex flex-col justify-center">
        <span
          style={{
            fontFamily: 'Manrope, sans-serif',
            fontWeight: 800,
            fontSize,
            lineHeight: 1,
            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-tertiary) 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            letterSpacing: '-0.03em',
          }}
        >
          Xperiq
        </span>
        {showTagline && (
          <span
            style={{
              fontFamily: 'Inter, sans-serif',
              fontWeight: 600,
              fontSize: taglineFontSize,
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              color: '#595c5e',
              marginTop: 2,
            }}
          >
            Intelligence for Every Experience
          </span>
        )}
      </div>
    </div>
  );
}
