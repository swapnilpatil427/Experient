import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrganizationList, useUser, CreateOrganization } from '@clerk/react';
import type { OrganizationMembershipResource } from '@clerk/shared/types';
import { Icon } from '../components/Icon';
import { ROUTES } from '../constants/routes';
import { GRADIENTS } from '../constants/colors';
import { useTranslation } from '../lib/i18n';
import { useAppAuth } from '../lib/auth.tsx';
import { SignInPage } from './SignInPage';
import { Button } from '@/components/ui/button';
import { isEnterpriseMode } from '../lib/features';

// Top-level: branch between Clerk-backed and demo mode
export function OnboardingPage() {
  const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (clerkKey) return <ClerkOnboarding />;
  return <DemoOnboarding />;
}

// ─── Clerk-backed onboarding ────────────────────────────────────────────────

function ClerkOnboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isSignedIn, isLoaded, signOut } = useAppAuth();
  const { user } = useUser();
  const { userMemberships, isLoaded: orgsLoaded, setActive } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [showCreate, setShowCreate] = useState(false);

  // Auto-activate when the user belongs to exactly one org, so they never have to
  // manually pick it. setActive scopes the session token (adds org_id/org_role),
  // which is what unblocks write actions gated by requireRole.
  const autoActivatedRef = useRef(false);
  useEffect(() => {
    if (autoActivatedRef.current || !orgsLoaded || !setActive) return;
    const memberships = userMemberships?.data ?? [];
    if (memberships.length === 1) {
      autoActivatedRef.current = true;
      setActive({ organization: memberships[0].organization.id })
        .then(() => navigate(ROUTES.SURVEYS))
        .catch(() => { autoActivatedRef.current = false; });
    }
  }, [orgsLoaded, userMemberships, setActive, navigate]);

  // While Clerk resolves
  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-surface">
        <div className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
      </div>
    );
  }

  // Not signed in — show Clerk sign-in inline
  if (!isSignedIn) {
    return <SignInPage />;
  }

  const orgs = userMemberships?.data ?? [];
  const userEmail = user?.primaryEmailAddress?.emailAddress ?? '';

  const handleSelectOrg = async (membership: OrganizationMembershipResource) => {
    if (setActive) {
      await setActive({ organization: membership.organization.id });
    }
    navigate(ROUTES.SURVEYS);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LANDING);
  };

  return (
    <div className="min-h-screen flex items-center justify-center overflow-hidden relative bg-surface font-body">
      {/* Background blobs */}
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="mesh-grid absolute inset-0 opacity-40" />
        <div className="absolute rounded-full"
          style={{ top: '-10%', left: '-10%', width: '40%', height: '40%',
            background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)', filter: 'blur(120px)' }} />
        <div className="absolute rounded-full"
          style={{ bottom: '-10%', right: '-10%', width: '50%', height: '50%',
            background: 'color-mix(in srgb, var(--color-tertiary) 10%, transparent)', filter: 'blur(150px)' }} />
      </div>

      {/* CreateOrganization modal */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}
        >
          <div className="relative">
            <Button
              onClick={() => setShowCreate(false)}
              variant="ghost"
              size="icon"
              className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full text-white"
              style={{ background: 'rgba(0,0,0,0.6)' }}
            >
              <Icon name="close" size={16} />
            </Button>
            <CreateOrganization afterCreateOrganizationUrl="/" skipInvitationScreen={false} />
          </div>
        </div>
      )}

      <main className="relative z-10 w-full max-w-4xl px-6 py-12">
        <div
          className="glass-card p-8 md:p-12 overflow-hidden relative"
          style={{ borderRadius: '1rem', border: '1px solid rgba(217,221,224,0.3)',
            boxShadow: '0 40px 100px -20px color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
        >
          {/* Brand header */}
          <div className="flex flex-col items-center mb-10 text-center">
            <div
              className="w-16 h-16 flex items-center justify-center shadow-lg mb-6 bg-gradient-primary"
              style={{ borderRadius: '1.25rem', transform: 'rotate(-3deg)' }}
            >
              <Icon name="psychology" fill={1} size={40} className="text-white" />
            </div>
            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tighter mb-2 font-headline text-on-surface">
              {t('brand.name')}
            </h1>
            <p className="font-medium tracking-wide uppercase text-xs opacity-70 text-on-surface-variant">
              {t('brand.tagline')}
            </p>
          </div>

          <div className="space-y-6">
            <h2 className="text-2xl font-bold font-headline text-on-surface">
              {t('onboarding.selectWorkspace')}
            </h2>

            {/* Loading orgs */}
            {!orgsLoaded && (
              <div className="flex justify-center py-8">
                <div className="w-6 h-6 rounded-full border-2 animate-spin"
                  style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
              </div>
            )}

            {/* Organization list */}
            {orgsLoaded && orgs.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {orgs.map((membership) => {
                  const org = membership.organization;
                  const roleLabel = (membership.role ?? '')
                    .replace('org:', '')
                    .replace(/_/g, ' ');
                  return (
                    <button
                      key={org.id}
                      onClick={() => handleSelectOrg(membership)}
                      className="group relative flex flex-col items-start p-6 text-left w-full active:scale-95 transition-all duration-300 bg-white rounded-2xl"
                      style={{ border: '1px solid rgba(171,173,175,0.15)',
                        boxShadow: '0 10px 30px -5px rgba(0,0,0,0.05)' }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-6px)';
                        e.currentTarget.style.boxShadow = '0 25px 50px -12px color-mix(in srgb, var(--color-primary) 15%, transparent)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 10px 30px -5px rgba(0,0,0,0.05)';
                      }}
                    >
                      <div className="flex items-center justify-between w-full mb-4">
                        <div
                          className="w-12 h-12 rounded-full flex items-center justify-center overflow-hidden bg-gradient-primary"
                        >
                          {org.imageUrl ? (
                            <img src={org.imageUrl} alt={org.name} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-lg font-black text-white font-headline">
                              {org.name.charAt(0).toUpperCase()}
                            </span>
                          )}
                        </div>
                        <Icon
                          name="arrow_forward"
                          size={20}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-primary"
                        />
                      </div>
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-lg font-bold font-headline text-on-surface">
                          {org.name}
                        </h3>
                        {isEnterpriseMode(org.membersCount ?? 0, 'free') && (
                          <span
                            className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full"
                            style={{ background: 'linear-gradient(135deg, #059669, #047857)', color: '#fff' }}
                          >
                            {t('enterprise.modeBadge')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs capitalize text-on-surface-variant">{roleLabel}</p>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Empty state — no orgs yet */}
            {orgsLoaded && orgs.length === 0 && (
              <div
                className="text-center py-10 rounded-2xl"
                style={{ border: '2px dashed color-mix(in srgb, var(--color-primary) 15%, transparent)', background: 'color-mix(in srgb, var(--color-primary) 2%, transparent)' }}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
                  style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)' }}
                >
                  <Icon name="business" size={28} className="text-primary" />
                </div>
                <p className="text-sm font-semibold mb-1 text-on-surface">No workspaces yet</p>
                <p className="text-xs text-on-surface-variant">
                  Create your first organization to get started
                </p>
              </div>
            )}

            {/* Create org CTA */}
            <div className="pt-6 flex flex-col items-center gap-4 border-t border-[rgba(171,173,175,0.1)]">
              <Button
                onClick={() => setShowCreate(true)}
                size="lg"
                className="w-full md:w-auto px-10 font-bold flex items-center justify-center gap-3 active:scale-95 font-headline text-white rounded-xl"
                style={{
                  background: GRADIENTS.primaryDim,
                  boxShadow: '0 20px 40px -10px color-mix(in srgb, var(--color-primary) 20%, transparent)',
                }}
              >
                <Icon name="add_circle" size={22} />
                {t('onboarding.createNewBrand')}
              </Button>
              {userEmail && (
                <p className="text-sm text-on-surface-variant">
                  {t('onboarding.loggedInAs')}{' '}
                  <span className="font-bold text-on-surface">{userEmail}</span>
                  {' • '}
                  <Button
                    variant="link"
                    onClick={handleSignOut}
                    className="text-primary font-semibold p-0 h-auto text-sm"
                  >
                    {t('onboarding.logout')}
                  </Button>
                </p>
              )}
            </div>
          </div>

          {/* Background decoration */}
          <div
            className="absolute -right-20 -bottom-20 w-64 h-64 opacity-10 pointer-events-none text-primary"
            style={{ transform: 'rotate(12deg)' }}
          >
            <Icon name="layers" size={200} />
          </div>
        </div>

        <div className="mt-12 text-center text-xs font-medium tracking-widest uppercase text-[rgba(89,92,94,0.5)]">
          {t('brand.footer')}
        </div>
      </main>
    </div>
  );
}

// ─── Demo mode (no Clerk key) ────────────────────────────────────────────────

const DEMO_WORKSPACES = [
  {
    id: 'acme',
    name: 'Acme Corp',
    stats: '12 Active Surveys • 4.2k Responses',
    icon: 'business',
    iconBg: 'color-mix(in srgb, var(--color-secondary-container) 20%, transparent)',
    iconColor: 'var(--color-secondary)',
    hoverGlow: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
    members: [
      { bg: 'var(--color-primary-container)', text: 'A' },
      { bg: 'var(--color-tertiary-container)', text: 'B' },
    ],
    extra: '+5',
  },
  {
    id: 'techflow',
    name: 'TechFlow',
    stats: '3 Active Surveys • 850 Responses',
    icon: 'account_tree',
    iconBg: 'color-mix(in srgb, var(--color-tertiary-container) 20%, transparent)',
    iconColor: 'var(--color-tertiary)',
    hoverGlow: 'color-mix(in srgb, var(--color-tertiary) 15%, transparent)',
    members: [{ bg: 'var(--color-primary-container)', text: 'T' }],
    extra: '+2',
  },
];

function DemoOnboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { userId, signOut } = useAppAuth();

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LANDING);
  };

  return (
    <div className="min-h-screen flex items-center justify-center overflow-hidden relative bg-surface font-body">
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="mesh-grid absolute inset-0 opacity-40" />
        <div className="absolute rounded-full"
          style={{ top: '-10%', left: '-10%', width: '40%', height: '40%',
            background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)', filter: 'blur(120px)' }} />
        <div className="absolute rounded-full"
          style={{ bottom: '-10%', right: '-10%', width: '50%', height: '50%',
            background: 'color-mix(in srgb, var(--color-tertiary) 10%, transparent)', filter: 'blur(150px)' }} />
      </div>

      <main className="relative z-10 w-full max-w-4xl px-6 py-12">
        <div
          className="glass-card p-8 md:p-12 overflow-hidden relative"
          style={{ borderRadius: '1rem', border: '1px solid rgba(217,221,224,0.3)',
            boxShadow: '0 40px 100px -20px color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
        >
          <div className="flex flex-col items-center mb-12 text-center">
            <div
              className="w-16 h-16 flex items-center justify-center shadow-lg mb-6 bg-gradient-primary-light"
              style={{ borderRadius: '1.25rem', transform: 'rotate(-3deg)' }}
            >
              <Icon name="psychology" fill={1} size={40} className="text-white" />
            </div>
            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tighter mb-2 font-headline text-on-surface">
              {t('brand.name')}
            </h1>
            <p className="font-medium tracking-wide uppercase text-xs opacity-70 text-on-surface-variant">
              {t('brand.tagline')}
            </p>
          </div>

          <div className="space-y-8">
            <div className="flex justify-between items-end">
              <h2 className="text-2xl font-bold font-headline text-on-surface">
                {t('onboarding.selectWorkspace')}
              </h2>
              <Button variant="link" className="font-semibold text-sm text-primary p-0 h-auto">
                {t('onboarding.support')}
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {DEMO_WORKSPACES.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => navigate(ROUTES.INSIGHTS)}
                  className="group relative flex flex-col items-start p-8 text-left w-full active:scale-95 transition-all duration-300 bg-white rounded-2xl"
                  style={{ border: '1px solid rgba(171,173,175,0.1)',
                    boxShadow: '0 10px 30px -5px rgba(0,0,0,0.05)' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-8px)';
                    e.currentTarget.style.boxShadow = `0 25px 50px -12px ${ws.hoverGlow}`;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 10px 30px -5px rgba(0,0,0,0.05)';
                  }}
                >
                  <div className="flex items-center justify-between w-full mb-6">
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center"
                      style={{ background: ws.iconBg, color: ws.iconColor }}
                    >
                      <Icon name={ws.icon} size={22} />
                    </div>
                    <Icon
                      name="arrow_forward"
                      size={20}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: ws.iconColor }}
                    />
                  </div>
                  <h3 className="text-xl font-bold mb-1 font-headline text-on-surface">{ws.name}</h3>
                  <p className="text-sm text-on-surface-variant">{ws.stats}</p>
                  <div className="mt-6 flex -space-x-2">
                    {ws.members.map((m, i) => (
                      <div
                        key={i}
                        className="w-6 h-6 rounded-full border-2 flex items-center justify-center text-[10px] font-bold text-white"
                        style={{ background: m.bg, borderColor: '#f5f7f9' }}
                      >
                        {m.text}
                      </div>
                    ))}
                    <div
                      className="w-6 h-6 rounded-full border-2 flex items-center justify-center text-[10px] font-bold text-on-surface-variant"
                      style={{ background: '#d9dde0', borderColor: '#f5f7f9' }}
                    >
                      {ws.extra}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            <div className="pt-8 flex flex-col items-center border-t border-[rgba(171,173,175,0.1)]">
              <Button
                size="lg"
                className="cta-glow group w-full md:w-auto px-10 text-lg font-bold flex items-center justify-center gap-3 active:scale-95 font-headline text-white rounded-xl"
                style={{
                  background: GRADIENTS.primaryDim,
                  boxShadow: '0 20px 40px -10px color-mix(in srgb, var(--color-primary) 20%, transparent)',
                }}
              >
                <Icon name="add_circle" size={22} />
                {t('onboarding.createNewBrand')}
              </Button>
              <p className="mt-6 text-sm font-medium text-on-surface-variant">
                {t('onboarding.loggedInAs')}{' '}
                <span className="font-bold text-on-surface">{userId}</span>
                {' • '}
                <Button
                  variant="link"
                  onClick={handleSignOut}
                  className="text-primary p-0 h-auto text-sm"
                >
                  {t('onboarding.logout')}
                </Button>
              </p>
            </div>
          </div>

          <div
            className="absolute -right-20 -bottom-20 w-64 h-64 opacity-10 pointer-events-none text-primary"
            style={{ transform: 'rotate(12deg)' }}
          >
            <Icon name="layers" size={200} />
          </div>
        </div>

        <div className="mt-12 text-center text-xs font-medium tracking-widest uppercase text-[rgba(89,92,94,0.5)]">
          {t('brand.footer')}
        </div>
      </main>
    </div>
  );
}
