import { Suspense, useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { TopBarPublic } from '../components/TopBar';
import { Icon } from '../components/Icon';
import { LogoMark } from '../components/Logo';
import { HeroCanvas } from '../components/three/HeroCanvas';
import { ROUTES } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { useAppAuth } from '../lib/auth.tsx';
import { Button } from '@/components/ui/button';
import en from '../locales/en';

// Animation variants
const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  visible: (i = 0) => ({
    opacity: 1, y: 0,
    transition: { duration: 0.65, delay: i * 0.1, ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number] },
  }),
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1, delayChildren: 0.15 } },
};

const scaleIn = {
  hidden: { opacity: 0, scale: 0.88 },
  visible: (i = 0) => ({
    opacity: 1, scale: 1,
    transition: { duration: 0.55, delay: i * 0.08, ease: [0.34, 1.56, 0.64, 1] as [number, number, number, number] },
  }),
};

export function LandingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isSignedIn, isLoaded } = useAppAuth();
  const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

  // Auto-redirect signed-in users straight to the app
  useLayoutEffect(() => {
    if (clerkKey && isLoaded && isSignedIn) {
      navigate(ROUTES.SURVEYS, { replace: true });
    }
  }, [isLoaded, isSignedIn]);

  const featureCards = [
    { icon: 'analytics',     ...en.landing.cards[0] },
    { icon: 'auto_awesome',  ...en.landing.cards[1] },
    { icon: 'bolt',          ...en.landing.cards[2] },
  ];

  return (
    <div className="min-h-screen font-body">
      <TopBarPublic />

      {/* ── Hero ────────────────────────────────────────────── */}
      <main
        className="relative pt-24 min-h-screen overflow-hidden"
        style={{ background: 'radial-gradient(ellipse 90% 70% at 50% -10%, #d8d4ff 0%, #eae8ff 30%, #f5f7f9 70%)' }}
      >
        {/* Animated aurora blob */}
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/4 rounded-full aurora-bg animate-pulse-slow pointer-events-none"
          style={{ width: 800, height: 500, filter: 'blur(80px)', zIndex: 0 }}
        />

        {/* 3D background canvas */}
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 1 }}>
          <Suspense fallback={null}>
            <HeroCanvas />
          </Suspense>
        </div>

        {/* Hero content */}
        <section className="relative z-10 max-w-screen-2xl mx-auto px-6 py-20 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">

          {/* ── Left Copy ── */}
          <motion.div
            className="lg:col-span-7 space-y-10"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            {/* Badge */}
            <motion.div variants={fadeUp} custom={0}>
              <div
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold tracking-widest uppercase text-primary"
                style={{
                  background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                {t('landing.intelligenceLayer')}
              </div>
            </motion.div>

            {/* Headline */}
            <div className="space-y-4">
              <motion.h1
                className="text-5xl lg:text-[4rem] xl:text-[4.5rem] font-extrabold tracking-tighter leading-[1.05] font-headline text-on-surface"
                variants={fadeUp}
                custom={1}
              >
                {t('landing.heroHeadingStart')}
                <span className="text-gradient"> {t('brand.aiAware')} </span>
                {t('landing.heroHeadingMiddle')}
              </motion.h1>
              <motion.p
                className="text-xl leading-relaxed max-w-xl text-[#47527a]"
                variants={fadeUp}
                custom={2}
              >
                {t('landing.heroDescription')}
              </motion.p>
            </div>

            {/* CTAs */}
            <motion.div className="flex flex-wrap gap-4" variants={fadeUp} custom={3}>
              <Button
                onClick={() => navigate(ROUTES.ONBOARDING)}
                size="lg"
                className="cta-glow relative overflow-hidden text-white font-bold active:scale-95 font-headline rounded-xl"
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary), #6d28d9)',
                  boxShadow: '0 20px 40px -10px color-mix(in srgb, var(--color-primary) 40%, transparent)',
                }}
              >
                {/* Shimmer overlay */}
                <span className="shimmer absolute inset-0 rounded-[0.75rem]" />
                <span className="relative flex items-center gap-2">
                  {t('landing.ctaButton')}
                  <Icon name="arrow_forward" size={18} />
                </span>
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="font-semibold font-headline text-on-surface rounded-xl card-3d"
                style={{
                  background: 'rgba(255,255,255,0.8)',
                  border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
                  backdropFilter: 'blur(8px)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.95)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.8)')}
              >
                {t('landing.secondaryButton')}
              </Button>
            </motion.div>

            {/* Feature list */}
            <motion.div className="pt-2 space-y-3 text-on-surface-variant" variants={stagger}>
              {en.landing.features.map((text, i) => (
                <motion.div
                  key={text}
                  className="flex items-center gap-3"
                  variants={fadeUp}
                  custom={4 + i}
                >
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)' }}
                  >
                    <Icon name="check" size={14} className="text-primary" />
                  </div>
                  <span className="font-medium">{text}</span>
                </motion.div>
              ))}
            </motion.div>

            {/* Social proof */}
            <motion.div className="flex items-center gap-4 pt-2" variants={fadeUp} custom={7}>
              <div className="flex -space-x-2">
                {['var(--color-primary-container)', 'var(--color-tertiary-container)', 'var(--color-secondary-container)', '#f9a8d4'].map((bg, i) => (
                  <div
                    key={i}
                    className="w-8 h-8 rounded-full border-2 border-white flex items-center justify-center text-xs font-bold text-white"
                    style={{ background: bg }}
                  >
                    {['E', 'S', 'M', 'A'][i]}
                  </div>
                ))}
              </div>
              <p className="text-sm text-on-surface-variant">
                <strong className="text-on-surface">2,400+</strong> teams building on Xperiq
              </p>
            </motion.div>
          </motion.div>

          {/* ── Right Visual ── */}
          <div className="lg:col-span-5 relative">
            <div className="relative w-full max-w-md mx-auto" style={{ aspectRatio: '1/1' }}>

              {/* Glow blob behind cards */}
              <div
                className="absolute inset-0 -z-10 animate-pulse-slow"
                style={{
                  background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.25) 0%, transparent 70%)',
                  filter: 'blur(40px)',
                }}
              />

              {/* Sentiment Drift card */}
              <motion.div
                className="absolute top-0 right-0 w-64 p-6 z-20 float-card glass-card-premium"
                style={{
                  borderRadius: '1rem',
                  boxShadow: '0 32px 64px -12px color-mix(in srgb, var(--color-primary) 20%, transparent)',
                  transform: 'translate(16px, -16px)',
                }}
                initial={{ opacity: 0, x: 40, y: -20 }}
                animate={{ opacity: 1, x: 16, y: -16 }}
                transition={{ duration: 0.7, delay: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
              >
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-bold tracking-widest uppercase text-primary">
                    {t('landing.sentimentCard.title')}
                  </span>
                  <div className="w-6 h-6 rounded-full flex items-center justify-center"
                    style={{ background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)' }}>
                    <Icon name="trending_up" size={14} className="text-primary" />
                  </div>
                </div>
                <div className="text-3xl font-black mb-1 text-gradient font-headline">
                  {t('landing.sentimentCard.metric')}
                </div>
                <div className="text-xs mb-4 text-secondary">{t('landing.sentimentCard.description')}</div>
                <div className="h-1.5 w-full rounded-full overflow-hidden bg-surface-container-low">
                  <div
                    className="h-full rounded-full"
                    style={{ width: '75%', background: 'linear-gradient(to right, var(--color-primary), var(--color-primary-container))' }}
                  />
                </div>
              </motion.div>

              {/* AI Observation card */}
              <motion.div
                className="absolute bottom-10 left-0 w-72 p-6 z-30 float-card-slow"
                style={{
                  background: 'rgba(255,255,255,0.95)',
                  borderRadius: '1rem',
                  boxShadow: '0 40px 64px -10px rgba(0,0,0,0.14)',
                  border: '1px solid rgba(165,180,252,0.3)',
                  animationDelay: '2s',
                }}
                initial={{ opacity: 0, x: -40, y: 20 }}
                animate={{ opacity: 1, x: 0, y: 0 }}
                transition={{ duration: 0.7, delay: 0.55, ease: [0.34, 1.56, 0.64, 1] }}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div
                    className="w-8 h-8 rounded-xl flex items-center justify-center"
                    style={{ background: 'linear-gradient(135deg, var(--color-primary-container), var(--color-tertiary))' }}
                  >
                    <Icon name="diamond" fill={1} size={18} className="text-white" />
                  </div>
                  <span className="text-sm font-bold font-headline text-on-surface">
                    Crystal · Xperiq Copilot
                  </span>
                  <span className="ml-auto w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                </div>
                <p className="text-xs leading-relaxed mb-4 italic text-on-surface-variant">
                  &ldquo;{t('landing.aiObservation.quote')}&rdquo;
                </p>
                <div className="flex gap-2">
                  {en.landing.aiObservation.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2.5 py-1 text-[10px] font-bold uppercase rounded-md text-primary"
                      style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)' }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </motion.div>

              {/* Center hero visual */}
              <motion.div
                className="w-full h-full rounded-3xl overflow-hidden relative"
                style={{ border: '1px solid rgba(165,180,252,0.3)' }}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8, delay: 0.25, ease: [0.34, 1.56, 0.64, 1] }}
              >
                {/* Background gradient */}
                <div className="absolute inset-0 aurora-bg" style={{ opacity: 0.7 }} />
                {/* Glass overlay */}
                <div className="absolute inset-0" style={{ backdropFilter: 'blur(2px)' }} />

                {/* Rotating ring decoration */}
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  style={{ zIndex: 1 }}
                >
                  <div
                    className="animate-spin-slow rounded-full"
                    style={{
                      width: 200,
                      height: 200,
                      border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
                      borderTopColor: 'color-mix(in srgb, var(--color-tertiary) 60%, transparent)',
                    }}
                  />
                </div>
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  style={{ zIndex: 1 }}
                >
                  <div
                    style={{
                      width: 140,
                      height: 140,
                      border: '1px solid rgba(87,210,249,0.3)',
                      borderBottomColor: 'color-mix(in srgb, var(--color-primary) 50%, transparent)',
                      borderRadius: '50%',
                      animation: 'spin-slow 8s linear infinite reverse',
                    }}
                  />
                </div>

                {/* Center logo mark */}
                <div className="relative z-10 w-full h-full flex items-center justify-center">
                  <div className="text-center space-y-5">
                    <motion.div
                      className="flex items-center justify-center"
                      animate={{ y: [0, -8, 0], rotateZ: [0, 2, 0] }}
                      transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
                    >
                      <div
                        className="p-5 rounded-3xl glow-blue"
                        style={{
                          background: 'rgba(255,255,255,0.85)',
                          backdropFilter: 'blur(16px)',
                          border: '1px solid rgba(165,180,252,0.4)',
                        }}
                      >
                        <LogoMark size={64} />
                      </div>
                    </motion.div>
                    <div>
                      <p className="text-sm font-black tracking-widest uppercase text-gradient font-headline">
                        {t('landing.intelligenceLayer')}
                      </p>
                      <p className="text-xs mt-1 text-on-surface-variant">
                        {t('landing.layerDescription')}
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* ── Metrics bar ──────────────────────────────────── */}
        <motion.div
          className="relative z-10 max-w-screen-xl mx-auto px-6 pb-12"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.9 }}
        >
          <div
            className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-2xl overflow-hidden"
            style={{ background: 'rgba(171,173,175,0.15)', border: '1px solid rgba(171,173,175,0.15)' }}
          >
            {[
              { value: '12.4M', label: 'Responses analyzed' },
              { value: '99.9%', label: 'Uptime SLA' },
              { value: '< 50ms', label: 'AI response time' },
              { value: 'SOC 2', label: 'Type II certified' },
            ].map((m) => (
              <div
                key={m.label}
                className="px-8 py-6 text-center glass-card-premium"
              >
                <div className="text-2xl font-black text-gradient font-headline">
                  {m.value}
                </div>
                <div className="text-xs mt-1 font-medium text-on-surface-variant">{m.label}</div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* ── Features ─────────────────────────────────────── */}
        <section className="relative z-10 max-w-screen-2xl mx-auto px-6 py-20">
          <motion.div
            className="text-center mb-16"
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <span
              className="inline-flex items-center gap-2 text-xs font-bold tracking-[0.2em] uppercase px-4 py-2 rounded-full text-primary"
              style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
            >
              <LogoMark size={16} />
              {t('landing.sectionTag')}
            </span>
            <h2 className="text-4xl font-bold mt-5 font-headline text-on-surface">
              {t('landing.sectionHeading')}
            </h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {featureCards.map((f, i) => (
              <motion.div
                key={f.title}
                className="group relative p-8 rounded-2xl cursor-pointer overflow-hidden bg-white"
                style={{ border: '1px solid rgba(171,173,175,0.1)' }}
                initial={{ opacity: 0, y: 32 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.55, delay: i * 0.12, ease: [0.25, 0.46, 0.45, 0.94] }}
                whileHover={{ y: -6, boxShadow: '0 32px 64px -12px color-mix(in srgb, var(--color-primary) 18%, transparent)' }}
              >
                {/* Holographic hover overlay */}
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 holographic" />

                <div
                  className="relative z-10 w-12 h-12 flex items-center justify-center mb-6 rounded-xl transition-transform group-hover:scale-110 group-hover:rotate-3"
                  style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 10%, transparent), color-mix(in srgb, var(--color-tertiary) 8%, transparent))' }}
                >
                  <Icon name={f.icon} size={22} className="text-primary" />
                </div>
                <h3 className="relative z-10 text-xl font-bold mb-3 font-headline text-on-surface">
                  {f.title}
                </h3>
                <p className="relative z-10 text-sm leading-relaxed text-[#47527a]">
                  {f.desc}
                </p>
                <div
                  className="relative z-10 mt-6 flex items-center gap-1 text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity text-primary"
                >
                  Learn more <Icon name="arrow_forward" size={14} />
                </div>
              </motion.div>
            ))}
          </div>
        </section>
      </main>

      {/* ── Meet Crystal ─────────────────────────────────────── */}
      <section
        className="relative z-10 overflow-hidden"
        style={{
          background:
            'radial-gradient(ellipse at 30% 50%, color-mix(in srgb, var(--color-primary) 8%, transparent) 0%, transparent 60%),' +
            'radial-gradient(ellipse at 70% 50%, color-mix(in srgb, var(--color-tertiary) 6%, transparent) 0%, transparent 60%),' +
            'linear-gradient(180deg, #f5f7f9 0%, #eae8ff 50%, #f5f7f9 100%)',
        }}
      >
        <div className="max-w-screen-2xl mx-auto px-6 py-28">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">

            {/* ── Left: Crystal visual ── */}
            <motion.div
              className="flex justify-center order-2 lg:order-1"
              initial={{ opacity: 0, scale: 0.85 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: [0.34, 1.56, 0.64, 1] }}
            >
              <div className="relative">
                {/* Glow pedestal */}
                <div
                  className="absolute pointer-events-none"
                  style={{
                    width: 320,
                    height: 80,
                    bottom: -24,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'radial-gradient(ellipse, color-mix(in srgb, var(--color-tertiary) 35%, transparent), transparent 70%)',
                    filter: 'blur(20px)',
                  }}
                />
                {/* Crystal */}
                <div
                  className="relative mx-auto"
                  style={{ width: 280, height: 280, filter: 'drop-shadow(0 32px 64px color-mix(in srgb, var(--color-primary) 25%, transparent))' }}
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        'conic-gradient(from 0deg at 50% 50%, var(--color-primary-container) 0%, var(--color-tertiary-container) 25%, var(--color-secondary-container) 50%, var(--color-tertiary-container) 75%, var(--color-primary-container) 100%)',
                      clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
                      animation: 'spin-slow 20s linear infinite',
                      filter: 'blur(0.5px)',
                    }}
                  />
                  <div
                    className="absolute"
                    style={{
                      inset: '18%',
                      background:
                        'conic-gradient(from 180deg at 50% 50%, #ffffff 0%, var(--color-primary-container) 33%, var(--color-tertiary-container) 66%, #ffffff 100%)',
                      clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
                      animation: 'spin-slow 10s linear infinite reverse',
                      opacity: 0.75,
                    }}
                  />
                  <div
                    className="absolute"
                    style={{
                      inset: '38%',
                      background: 'radial-gradient(circle, #ffffff, var(--color-secondary-container))',
                      borderRadius: '50%',
                      filter: 'blur(5px)',
                      animation: 'pulse-glow 2.5s ease-in-out infinite',
                    }}
                  />
                </div>

                {/* Floating query bubble — top right */}
                <motion.div
                  className="absolute -right-4 top-6 max-w-[200px] p-3.5 rounded-2xl rounded-tl-sm text-sm bg-white"
                  style={{ boxShadow: '0 8px 32px -4px color-mix(in srgb, var(--color-primary) 18%, transparent)', border: '1px solid rgba(165,180,252,0.3)' }}
                  initial={{ opacity: 0, x: 20, y: -10 }}
                  whileInView={{ opacity: 1, x: 0, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
                >
                  <p className="text-xs font-semibold text-[#374151]">"Why did NPS drop last week?"</p>
                  <div className="flex items-center gap-1 mt-1.5">
                    <div
                      className="w-4 h-4 rounded-full flex items-center justify-center"
                      style={{ background: 'linear-gradient(135deg, #4f6ef7, #9b51e0)' }}
                    >
                      <Icon name="diamond" size={10} style={{ color: 'white' }} />
                    </div>
                    <span className="text-[10px] font-bold" style={{ background: 'linear-gradient(135deg, #4f6ef7, #9b51e0)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                      Crystal answers in 2s
                    </span>
                  </div>
                </motion.div>

                {/* Floating answer bubble — bottom left */}
                <motion.div
                  className="absolute -left-6 bottom-10 max-w-[220px] p-3.5 rounded-2xl rounded-br-sm text-sm"
                  style={{
                    background: 'linear-gradient(135deg, rgba(79,110,247,0.1), rgba(155,81,224,0.08))',
                    border: '1px solid rgba(165,180,252,0.4)',
                    backdropFilter: 'blur(12px)',
                  }}
                  initial={{ opacity: 0, x: -20, y: 10 }}
                  whileInView={{ opacity: 1, x: 0, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
                >
                  <p className="text-[11px] font-semibold text-[#374151] leading-snug">
                    Fix email verification loop →{' '}
                    <span className="font-black text-emerald-700">+3.2 NPS</span>
                  </p>
                  <p className="text-[10px] text-[#6b7280] mt-1">Cited by 18 respondents · CONF 89</p>
                </motion.div>

                {/* Floating metric bubble — top left */}
                <motion.div
                  className="absolute -left-2 top-16 p-3 rounded-xl bg-white"
                  style={{ boxShadow: '0 4px 16px rgba(0,0,0,0.08)', border: '1px solid rgba(171,173,175,0.15)' }}
                  initial={{ opacity: 0, x: -16 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: 0.7, ease: [0.34, 1.56, 0.64, 1] }}
                >
                  <div className="text-[10px] font-black uppercase tracking-widest text-[#9ca3af]">NPS</div>
                  <div className="text-2xl font-black font-headline text-gradient">51</div>
                  <div className="text-[10px] text-emerald-600 font-bold">↑ +4 this week</div>
                </motion.div>
              </div>
            </motion.div>

            {/* ── Right: Copy ── */}
            <motion.div
              className="order-1 lg:order-2 space-y-8"
              variants={stagger}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
            >
              <motion.div variants={fadeUp} custom={0}>
                <div
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold tracking-widest uppercase"
                  style={{ background: 'color-mix(in srgb, var(--color-tertiary) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-tertiary) 20%, transparent)', color: 'var(--color-tertiary)' }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                  Xperiq Copilot
                </div>
              </motion.div>

              <div className="space-y-3">
                <motion.h2
                  className="text-5xl lg:text-[3.5rem] font-extrabold tracking-tighter leading-[1.05] font-headline text-on-surface"
                  variants={fadeUp}
                  custom={1}
                >
                  Meet{' '}
                  <span
                    style={{
                      background: 'linear-gradient(135deg, #4f6ef7, #9b51e0)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                    }}
                  >
                    Crystal.
                  </span>
                </motion.h2>
                <motion.p
                  className="text-2xl font-bold text-[#374151] leading-snug"
                  variants={fadeUp}
                  custom={2}
                >
                  The smartest experience<br />management AI in the industry.
                </motion.p>
                <motion.p
                  className="text-lg leading-relaxed text-[#47527a]"
                  variants={fadeUp}
                  custom={3}
                >
                  Crystal is your always-on AI copilot — embedded in every survey, insight, and
                  workflow. Ask questions in plain language. Get cited answers, anomaly alerts, and
                  prescriptive actions in seconds.
                </motion.p>
              </div>

              <motion.div className="space-y-4" variants={stagger}>
                {[
                  {
                    icon: 'forum',
                    title: 'Ask anything, get cited answers',
                    desc: '"Why did NPS drop?" → Crystal cites real respondents and confidence scores.',
                  },
                  {
                    icon: 'auto_awesome',
                    title: 'Build surveys from a description',
                    desc: 'Describe your goal in one sentence. Crystal writes the full survey in seconds.',
                  },
                  {
                    icon: 'warning',
                    title: 'Surface risks before they become crises',
                    desc: 'Crystal detects anomalies and predicts churn risk — automatically, continuously.',
                  },
                  {
                    icon: 'flag',
                    title: 'Act, not just answer',
                    desc: 'Create tickets, share to Slack, trigger workflows — all from Crystal\'s interface.',
                  },
                ].map((item) => (
                  <motion.div
                    key={item.title}
                    className="flex items-start gap-4"
                    variants={fadeUp}
                  >
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: 'linear-gradient(135deg, rgba(79,110,247,0.12), rgba(155,81,224,0.1))' }}
                    >
                      <Icon name={item.icon} size={18} className="text-primary" />
                    </div>
                    <div>
                      <div className="font-bold text-sm text-on-surface">{item.title}</div>
                      <p className="text-sm text-[#47527a] mt-0.5">{item.desc}</p>
                    </div>
                  </motion.div>
                ))}
              </motion.div>

              <motion.div variants={fadeUp} custom={8}>
                <Button
                  onClick={() => navigate(ROUTES.ONBOARDING)}
                  size="lg"
                  className="font-bold text-white rounded-xl"
                  style={{
                    background: 'linear-gradient(135deg, #4f6ef7, #9b51e0)',
                    boxShadow: '0 12px 32px -8px rgba(79,110,247,0.45)',
                  }}
                >
                  <Icon name="diamond" fill={1} size={18} />
                  Meet Crystal — Get Early Access
                </Button>
              </motion.div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="w-full border-t font-body bg-[#f8fafc] border-[#e2e8f0]">
        <div className="flex flex-col md:flex-row justify-between items-center px-8 py-12 gap-6 max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-3">
            <LogoMark size={28} />
            <span className="text-xs tracking-wide text-inverse-on-surface">
              {t('brand.footerAlt')}
            </span>
          </div>
          <div className="flex gap-8">
            {[
              t('landing.footerLinks.privacy'),
              t('landing.footerLinks.terms'),
              t('landing.footerLinks.apiDocs'),
            ].map((l) => (
              <a
                key={l}
                href="#"
                className="text-xs tracking-wide uppercase transition-colors text-inverse-on-surface hover:text-[var(--color-primary)]"
              >
                {l}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
