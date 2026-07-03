import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { OrganizationProfile } from '@clerk/react';
import { Icon } from '../components/Icon';
import { useSetPageTitle } from '../contexts/pageTitle';
import { ROUTES } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { useAppAuth } from '../lib/auth.tsx';
import { useApi } from '../hooks/useApi';
import type { OrgProfile } from '../types';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { applyBrandTheme, saveBrandTheme, DEFAULT_BRAND_THEME } from '../lib/brandTheme';
import { useBrand } from '../contexts/brandContext';
import { PageHeader } from '../components/PageHeader';
import { usePermissions } from '../lib/permissions';
import { PermissionDeniedBanner } from '../components/PermissionGate';
import { TeamPanel } from '../components/settings/TeamPanel';
import { RolesPanel } from '../components/settings/RolesPanel';

const DEMO_TEAM_MEMBERS = [
  {
    initials: 'EM',
    name: 'Elena Marquet',
    email: 'elena@insightsense.ai',
    role: 'Administrator',
    statusActive: true,
    bg: '#d299ff',
    color: '#4c007d',
  },
  {
    initials: 'JS',
    name: 'Julian Schmidt',
    email: 'julian.s@insightsense.ai',
    role: 'Data Scientist',
    statusActive: true,
    bg: '#879aff',
    color: '#00176b',
  },
  {
    initials: 'MB',
    name: 'Marcus Bell',
    email: 'm.bell@brand.com',
    role: 'Viewer',
    statusActive: false,
    bg: '#d9dde0',
    color: '#595c5e',
  },
];

const INDUSTRY_OPTIONS = [
  'SaaS / Software', 'E-commerce / Retail', 'Financial Services', 'Healthcare',
  'Education', 'Hospitality / Travel', 'Media & Entertainment', 'Manufacturing',
  'Professional Services', 'Non-profit', 'Government', 'Other',
];

// Sub-verticals per industry — specialist agents use these for deeper benchmarking
const SUB_VERTICAL_MAP: Record<string, string[]> = {
  'Healthcare': ['Ambulatory Care', 'Acute / Hospital', 'Dental', 'Mental Health', 'Telehealth', 'Pharma', 'Medical Devices'],
  'SaaS / Software': ['B2B SaaS', 'Developer Tools', 'Security', 'Data & Analytics', 'HR Tech', 'FinTech SaaS', 'EdTech'],
  'E-commerce / Retail': ['Apparel', 'Electronics', 'Grocery / FMCG', 'Beauty', 'Home & Furniture', 'Marketplace', 'DTC Brand'],
  'Financial Services': ['Retail Banking', 'Wealth Management', 'Insurance', 'Payments / FinTech', 'Lending', 'Capital Markets'],
  'Hospitality / Travel': ['Hotels', 'Airlines', 'Restaurants / QSR', 'Cruise', 'Theme Parks', 'OTA / Travel Tech'],
  'Education': ['K-12', 'Higher Education', 'EdTech', 'Professional Training', 'Corporate L&D'],
  'Media & Entertainment': ['Streaming', 'Publishing', 'Gaming', 'Live Events', 'Podcasts / Audio'],
  'Manufacturing': ['Automotive', 'Industrial Equipment', 'Consumer Goods', 'Aerospace', 'Chemicals'],
  'Professional Services': ['Consulting', 'Legal', 'Accounting', 'Staffing', 'Marketing Agency'],
  'Government': ['Federal', 'State / Province', 'Municipal', 'Public Health', 'Education Authority'],
  'Non-profit': ['NGO', 'Foundation', 'Advocacy', 'Healthcare Non-profit'],
  'Other': [],
};

const SIZE_OPTIONS = ['1–10', '11–50', '51–200', '201–1,000', '1,001–5,000', '5,000+'];
const USE_CASE_OPTIONS = [
  'Customer Experience (CX)', 'Employee Experience (EX)', 'Product Feedback',
  'Market Research', 'Brand Tracking', 'Event Feedback', 'Academic Research', 'Other',
];
const AUDIENCE_OPTIONS = ['B2B Customers', 'B2C Consumers', 'Internal Employees', 'Mixed (B2B + B2C)', 'Partners / Vendors'];
const REGION_OPTIONS = ['Global', 'North America', 'Europe / EMEA', 'Asia-Pacific (APAC)', 'Latin America (LATAM)', 'Middle East & Africa'];

export function BrandSettingsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('settings.pageTitle'));
  const { orgId } = useAppAuth();
  const navigate = useNavigate();
  const api = useApi();
  const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  const [activeTab, setActiveTab] = useState('General');
  const [brandName, setBrandName] = useState('');
  const [brandSaved, setBrandSaved] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [primaryColor, setPrimaryColor] = useState(DEFAULT_BRAND_THEME.primary);
  const [accentColor, setAccentColor] = useState(DEFAULT_BRAND_THEME.accent);
  const [secondaryColor, setSecondaryColor] = useState(DEFAULT_BRAND_THEME.secondary);
  const [fontHeading, setFontHeading] = useState(DEFAULT_BRAND_THEME.fontHeading);
  const [fontBody, setFontBody] = useState(DEFAULT_BRAND_THEME.fontBody);

  // Org profile state
  const [orgProfile, setOrgProfile] = useState<Partial<OrgProfile>>({
    industry: '', sub_vertical: '', company_size: '', use_case: '', primary_use_case: '',
    target_audience: '', website: '', brand_description: '', product_name: '', region: '',
  });
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);

  useEffect(() => {
    api.getOrg().then((data) => {
      if (data?.org?.name) setBrandName(data.org.name);
      if (data?.org?.logoUrl) setLogoUrl(data.org.logoUrl);
    }).catch(() => {});

    api.getOrgProfile().then((data) => {
      if (data?.profile) {
        const p = data.profile;
        setOrgProfile({
          industry:          p.industry || '',
          sub_vertical:      p.sub_vertical || '',
          company_size:      p.company_size || '',
          use_case:          p.use_case || '',
          primary_use_case:  p.primary_use_case || '',
          target_audience:   p.target_audience || '',
          website:           p.website || '',
          brand_description: p.brand_description || '',
          product_name:      p.product_name || '',
          region:            p.region || '',
        });
        if (p.brand_name && !brandName) setBrandName(p.brand_name);
        if (p.logo_url) setLogoUrl(p.logo_url);
        if (p.brand_colors?.primary) setPrimaryColor(p.brand_colors.primary);
        if (p.brand_colors?.accent) setAccentColor(p.brand_colors.accent);
        if (p.brand_colors?.secondary) setSecondaryColor(p.brand_colors.secondary);
        if (p.brand_fonts?.heading) setFontHeading(p.brand_fonts.heading);
        if (p.brand_fonts?.body) setFontBody(p.brand_fonts.body);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSaveBrand() {
    const theme = {
      ...DEFAULT_BRAND_THEME,
      primary: primaryColor,
      accent: accentColor,
      secondary: secondaryColor,
      fontHeading,
      fontBody,
    };
    applyBrandTheme(theme);
    saveBrandTheme(theme);
    // Persist to backend
    await api.updateOrgProfile({
      brand_name: brandName,
      brand_colors: { primary: primaryColor, accent: accentColor, secondary: secondaryColor },
      brand_fonts: { heading: fontHeading, body: fontBody },
    }).catch(() => {});
    api.updateOrg({ name: brandName }).catch(() => {});
    await reloadBrand();
    setBrandSaved(true);
    setTimeout(() => setBrandSaved(false), 2000);
  }

  async function handleSaveOrgProfile() {
    setOrgSaving(true);
    try {
      await api.updateOrgProfile(orgProfile);
      setOrgSaved(true);
      setTimeout(() => setOrgSaved(false), 2000);
    } catch { /* ignore */ }
    finally { setOrgSaving(false); }
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert(t('settings.general.logoTypeError'));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      alert(t('settings.general.logoSizeError'));
      return;
    }
    setLogoUploading(true);
    try {
      const { logoUrl: url } = await api.uploadLogo(file);
      setLogoUrl(url);
      await api.updateOrg({ logoUrl: url });
    } catch { /* non-fatal */ }
    finally { setLogoUploading(false); }
  }

  const { reloadBrand } = useBrand();
  const { isAdmin } = usePermissions();

  const tabs = [
    { key: 'General',       label: t('settings.tabs.general') },
    { key: 'Organization',  label: 'Organization' },
    { key: 'Team',          label: t('settings.tabs.team') },
    { key: 'Notifications', label: t('settings.tabs.notifications') },
    ...(isAdmin ? [
      { key: 'Admin',       label: t('settings.tabs.admin') },
      { key: 'Roles',    label: t('settings.tabs.roles') },
      { key: 'API Keys', label: t('settings.tabs.apiKeys') },
    ] : []),
  ];

  const quickActions = [
    { label: t('settings.quickActions.downloadKit'), icon: 'download' },
    { label: t('settings.quickActions.viewProfile'), icon: 'open_in_new' },
  ];

  return (
        <div className="max-w-7xl mx-auto w-full space-y-8">

          <PageHeader
            crumbs={[{ label: t('nav.settings'), icon: 'settings', path: ROUTES.SETTINGS }]}
            title={t('settings.pageTitle')}
          />

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="border-b border-muted/15">
              <TabsList className="h-auto bg-transparent rounded-none p-0 gap-8">
                {tabs.map((tab) => (
                  <TabsTrigger
                    key={tab.key}
                    value={tab.key}
                    className="font-bold pb-3 text-sm uppercase tracking-widest transition-colors font-headline rounded-none data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=inactive]:text-muted-foreground border-b-2 border-transparent -mb-px bg-transparent shadow-none"
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {/* ── General Tab ── */}
            {activeTab === 'General' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mt-8">

                {/* Brand Identity */}
                <Card
                  className="lg:col-span-8 p-8 relative overflow-hidden bg-white rounded-2xl border-0"
                  style={{ boxShadow: '0 40px 60px -10px rgba(44,47,49,0.06)' }}
                >
                  <div className="relative z-10 space-y-10">
                    <div>
                      <h3 className="text-xl font-bold mb-2 font-headline text-on-surface">
                        {t('settings.general.heading')}
                      </h3>
                      <p className="text-sm text-on-surface-variant">
                        {t('settings.general.description')}
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                      <div className="space-y-6">
                        <div>
                          <Label className="block text-xs font-bold uppercase tracking-widest mb-2 px-1 text-on-surface-variant">
                            {t('settings.general.brandNameLabel')}
                          </Label>
                          <Input
                            className="w-full px-4 py-4 font-medium bg-surface-container text-on-surface rounded-[10px] border-0 focus-visible:ring-2 focus-visible:ring-primary"
                            type="text"
                            value={brandName}
                            onChange={(e) => setBrandName(e.target.value)}
                          />
                        </div>

                        {/* Brand Colors */}
                        <div>
                          <Label className="block text-xs font-bold uppercase tracking-widest mb-3 px-1 text-on-surface-variant">
                            Brand Colors
                          </Label>
                          <div className="space-y-3">
                            {(
                              [
                                { label: 'Primary', value: primaryColor, onChange: setPrimaryColor },
                                { label: 'Accent', value: accentColor, onChange: setAccentColor },
                                { label: 'Secondary', value: secondaryColor, onChange: setSecondaryColor },
                              ] as { label: string; value: string; onChange: (v: string) => void }[]
                            ).map(({ label, value, onChange }) => (
                              <div key={label} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-container">
                                <label className="flex items-center gap-2 cursor-pointer flex-1">
                                  <div className="relative w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 border border-muted/20"
                                    style={{ background: value }}>
                                    <input
                                      type="color"
                                      value={value}
                                      onChange={(e) => onChange(e.target.value)}
                                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                    />
                                  </div>
                                  <span className="text-sm font-semibold text-on-surface">{label}</span>
                                </label>
                                <span className="text-xs font-mono text-muted-foreground uppercase">{value}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Brand Fonts */}
                        <div>
                          <Label className="block text-xs font-bold uppercase tracking-widest mb-3 px-1 text-on-surface-variant">
                            Typography
                          </Label>
                          <div className="space-y-3">
                            {(
                              [
                                { label: 'Heading font', value: fontHeading, onChange: setFontHeading, options: ['"Manrope", sans-serif', '"Inter", sans-serif', '"DM Sans", sans-serif', '"Plus Jakarta Sans", sans-serif', '"Outfit", sans-serif'] },
                                { label: 'Body font',    value: fontBody,    onChange: setFontBody,    options: ['"Inter", sans-serif', '"DM Sans", sans-serif', '"Manrope", sans-serif', '"Plus Jakarta Sans", sans-serif', '"Source Sans 3", sans-serif'] },
                              ] as { label: string; value: string; onChange: (v: string) => void; options: string[] }[]
                            ).map(({ label, value, onChange, options }) => (
                              <div key={label} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-container">
                                <span className="text-sm font-semibold text-on-surface flex-shrink-0 w-28">{label}</span>
                                <select
                                  value={value}
                                  onChange={(e) => onChange(e.target.value)}
                                  className="flex-1 text-xs bg-transparent text-muted-foreground outline-none cursor-pointer"
                                  style={{ fontFamily: value }}
                                >
                                  {options.map((o) => (
                                    <option key={o} value={o} style={{ fontFamily: o }}>
                                      {o.replace(/['"]/g, '').split(',')[0]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Save brand settings */}
                        <Button
                          onClick={handleSaveBrand}
                          className="w-full font-bold font-headline text-sm text-white rounded-xl transition-all hover:scale-[1.02] active:scale-[0.98]"
                          style={{
                            background: 'linear-gradient(135deg, var(--brand-primary), var(--brand-accent))',
                            boxShadow: 'var(--shadow-primary)',
                          }}
                        >
                          {brandSaved ? (
                            <span className="flex items-center gap-2">
                              <Icon name="check_circle" size={16} />
                              Saved
                            </span>
                          ) : (
                            <span className="flex items-center gap-2">
                              <Icon name="save" size={16} />
                              Save Brand Settings
                            </span>
                          )}
                        </Button>
                      </div>

                      {/* Logo Preview */}
                      <div
                        className="relative flex flex-col items-center justify-center p-8 rounded-xl border bg-surface-container-low border-muted/15"
                        style={{ perspective: '1000px' }}
                      >
                        <Label className="absolute top-4 left-4 text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                          {t('settings.general.logoLabel')}
                        </Label>
                        <div
                          className="relative w-32 h-32 bg-white rounded-2xl flex items-center justify-center cursor-pointer transition-transform duration-500 hover:[transform:rotateX(0deg)] overflow-hidden"
                          style={{ boxShadow: '0 40px 60px -10px rgba(0,0,0,0.2)', transform: 'rotateX(5deg)' }}
                        >
                          {logoUrl ? (
                            <img src={logoUrl} alt="org logo" className="w-full h-full object-contain p-2" />
                          ) : (
                            <Icon name="token" fill={1} size={48} className="text-primary" />
                          )}
                          <div
                            className="absolute -bottom-6 rounded-full"
                            style={{ width: 96, height: 16, background: 'rgba(44,47,49,0.05)', filter: 'blur(16px)' }}
                          />
                        </div>
                        <input
                          ref={logoInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleLogoUpload}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={logoUploading}
                          onClick={() => logoInputRef.current?.click()}
                          className="mt-10 text-xs font-bold flex items-center gap-2 transition-opacity hover:opacity-80 text-primary font-headline"
                        >
                          {logoUploading ? (
                            <>
                              <div className="w-3 h-3 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
                              {t('settings.general.uploadingLogo')}
                            </>
                          ) : (
                            <>
                              <Icon name="upload" size={16} />
                              {t('settings.general.uploadLogo').toUpperCase()}
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="absolute -top-24 -right-24 w-64 h-64 rounded-full pointer-events-none"
                    style={{ background: 'color-mix(in srgb, var(--color-primary) 5%, transparent)', filter: 'blur(48px)' }} />
                </Card>

                {/* Side Stats */}
                <div className="lg:col-span-4 space-y-8">
                  <Card
                    className="p-8 text-white rounded-2xl border-0"
                    style={{ background: 'linear-gradient(135deg, var(--color-secondary), #00576c)',
                      boxShadow: '0 20px 40px -10px color-mix(in srgb, var(--color-secondary) 30%, transparent)' }}
                  >
                    <h4 className="font-bold text-lg mb-4 font-headline">
                      {t('settings.brandHealth.heading')}
                    </h4>
                    <div className="space-y-4">
                      <div className="flex justify-between items-end">
                        <span className="text-sm opacity-80">{t('settings.brandHealth.consistencyScore')}</span>
                        <span className="text-2xl font-bold font-headline">94%</span>
                      </div>
                      <Progress value={94} className="h-2 bg-white/20 [&>div]:bg-white" />
                      <p className="text-xs opacity-70 leading-relaxed mt-4">
                        {t('settings.brandHealth.description', { count: 12 })}
                      </p>
                    </div>
                  </Card>

                  <Card className="p-6 space-y-4 rounded-xl bg-surface-container border-0">
                    <h4 className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                      {t('settings.quickActions.heading')}
                    </h4>
                    <div className="space-y-2">
                      {quickActions.map((action) => (
                        <Button
                          key={action.label}
                          variant="ghost"
                          className="w-full flex items-center justify-between p-3 rounded-xl transition-all hover:translate-x-1 bg-white text-on-surface font-semibold text-sm"
                        >
                          <span>{action.label}</span>
                          <Icon name={action.icon} size={16} className="text-primary" />
                        </Button>
                      ))}
                    </div>
                  </Card>
                </div>
              </div>
            )}

            {/* ── Organization Tab ── */}
            {activeTab === 'Organization' && (
              <div className="space-y-8 mt-8">

                {/* Org Profile Form */}
                <Card className="p-8 bg-white rounded-2xl border-0" style={{ boxShadow: '0 40px 60px -10px rgba(44,47,49,0.06)' }}>
                  <div className="flex items-start gap-4 mb-6">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)' }}>
                      <Icon name="business" size={20} className="text-primary" />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold font-headline text-on-surface">{t('settings.orgProfile.heading')}</h3>
                      <p className="text-sm text-on-surface-variant mt-0.5">{t('settings.orgProfile.description')}</p>
                    </div>
                  </div>

                  {/* Crystal AI Context callout */}
                  <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl"
                    style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 5%, transparent), color-mix(in srgb, var(--color-secondary) 5%, transparent))', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                      <Icon name="psychology" size={16} style={{ color: 'white' }} />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-on-surface">{t('settings.orgProfile.crystalContextTitle')}</p>
                      <p className="text-xs text-on-surface-variant mt-0.5 leading-relaxed">{t('settings.orgProfile.crystalContextDesc')}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Industry + Sub-vertical */}
                    <div>
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.industryLabel')}
                      </Label>
                      <Select value={orgProfile.industry || '__none__'} onValueChange={(v) => setOrgProfile((p) => ({ ...p, industry: v === '__none__' ? '' : v, sub_vertical: '' }))}>
                        <SelectTrigger className="w-full h-11 rounded-[10px] bg-surface-container text-on-surface border-0 focus:ring-2 focus:ring-primary">
                          <SelectValue placeholder={t('settings.orgProfile.industryPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t('settings.orgProfile.industryPlaceholder')}</SelectItem>
                          {INDUSTRY_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.subVerticalLabel')}
                        {orgProfile.industry && (SUB_VERTICAL_MAP[orgProfile.industry]?.length ?? 0) > 0 && (
                          <span className="ml-2 text-[10px] text-primary normal-case font-normal tracking-normal">
                            ({t('settings.orgProfile.subVerticalHint', { industry: orgProfile.industry })})
                          </span>
                        )}
                      </Label>
                      {orgProfile.industry && (SUB_VERTICAL_MAP[orgProfile.industry]?.length ?? 0) > 0 ? (
                        <Select value={orgProfile.sub_vertical || '__none__'} onValueChange={(v) => setOrgProfile((p) => ({ ...p, sub_vertical: v === '__none__' ? '' : v }))}>
                          <SelectTrigger className="w-full h-11 rounded-[10px] bg-surface-container text-on-surface border-0 focus:ring-2 focus:ring-primary">
                            <SelectValue placeholder={t('settings.orgProfile.subVerticalPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">{t('settings.orgProfile.subVerticalPlaceholder')}</SelectItem>
                            {(SUB_VERTICAL_MAP[orgProfile.industry] ?? []).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={orgProfile.sub_vertical ?? ''}
                          onChange={(e) => setOrgProfile((p) => ({ ...p, sub_vertical: e.target.value }))}
                          placeholder={t('settings.orgProfile.subVerticalFreeText')}
                          className="w-full px-4 py-2.5 font-medium bg-surface-container text-on-surface rounded-[10px] border-0 focus-visible:ring-2 focus-visible:ring-primary h-11"
                        />
                      )}
                    </div>

                    <div>
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.companySizeLabel')}
                      </Label>
                      <Select value={orgProfile.company_size || '__none__'} onValueChange={(v) => setOrgProfile((p) => ({ ...p, company_size: v === '__none__' ? '' : v }))}>
                        <SelectTrigger className="w-full h-11 rounded-[10px] bg-surface-container text-on-surface border-0 focus:ring-2 focus:ring-primary">
                          <SelectValue placeholder={t('settings.orgProfile.companySizePlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t('settings.orgProfile.companySizePlaceholder')}</SelectItem>
                          {SIZE_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.regionLabel')}
                      </Label>
                      <Select value={orgProfile.region || '__none__'} onValueChange={(v) => setOrgProfile((p) => ({ ...p, region: v === '__none__' ? '' : v }))}>
                        <SelectTrigger className="w-full h-11 rounded-[10px] bg-surface-container text-on-surface border-0 focus:ring-2 focus:ring-primary">
                          <SelectValue placeholder={t('settings.orgProfile.regionPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t('settings.orgProfile.regionPlaceholder')}</SelectItem>
                          {REGION_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.useCaseLabel')}
                      </Label>
                      <Select value={orgProfile.use_case || '__none__'} onValueChange={(v) => setOrgProfile((p) => ({ ...p, use_case: v === '__none__' ? '' : v }))}>
                        <SelectTrigger className="w-full h-11 rounded-[10px] bg-surface-container text-on-surface border-0 focus:ring-2 focus:ring-primary">
                          <SelectValue placeholder={t('settings.orgProfile.useCasePlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t('settings.orgProfile.useCasePlaceholder')}</SelectItem>
                          {USE_CASE_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.targetAudienceLabel')}
                      </Label>
                      <Select value={orgProfile.target_audience || '__none__'} onValueChange={(v) => setOrgProfile((p) => ({ ...p, target_audience: v === '__none__' ? '' : v }))}>
                        <SelectTrigger className="w-full h-11 rounded-[10px] bg-surface-container text-on-surface border-0 focus:ring-2 focus:ring-primary">
                          <SelectValue placeholder={t('settings.orgProfile.targetAudiencePlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t('settings.orgProfile.targetAudiencePlaceholder')}</SelectItem>
                          {AUDIENCE_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.productNameLabel')}
                      </Label>
                      <Input
                        value={orgProfile.product_name ?? ''}
                        onChange={(e) => setOrgProfile((p) => ({ ...p, product_name: e.target.value }))}
                        placeholder={t('settings.orgProfile.productNamePlaceholder')}
                        className="w-full px-4 py-2.5 font-medium bg-surface-container text-on-surface rounded-[10px] border-0 focus-visible:ring-2 focus-visible:ring-primary h-11"
                      />
                    </div>

                    <div>
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.websiteLabel')}
                      </Label>
                      <Input
                        value={orgProfile.website ?? ''}
                        onChange={(e) => setOrgProfile((p) => ({ ...p, website: e.target.value }))}
                        placeholder={t('settings.orgProfile.websitePlaceholder')}
                        className="w-full px-4 py-2.5 font-medium bg-surface-container text-on-surface rounded-[10px] border-0 focus-visible:ring-2 focus-visible:ring-primary h-11"
                      />
                    </div>

                    <div className="md:col-span-2">
                      <Label className="block text-xs font-bold uppercase tracking-widest mb-2 text-on-surface-variant">
                        {t('settings.orgProfile.brandDescriptionLabel')}
                      </Label>
                      <Textarea
                        value={orgProfile.brand_description ?? ''}
                        onChange={(e) => setOrgProfile((p) => ({ ...p, brand_description: e.target.value }))}
                        placeholder={t('settings.orgProfile.brandDescriptionPlaceholder')}
                        rows={3}
                        className="w-full resize-none px-4 py-3 font-medium bg-surface-container text-on-surface rounded-[10px] border-0 focus-visible:ring-2 focus-visible:ring-primary"
                      />
                    </div>
                  </div>

                  <Button
                    onClick={handleSaveOrgProfile}
                    disabled={orgSaving}
                    className="mt-6 font-bold font-headline text-sm text-white rounded-xl transition-all hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                      background: orgSaved ? '#059669' : 'linear-gradient(135deg, var(--brand-primary), var(--brand-accent))',
                      boxShadow: orgSaved ? '0 8px 20px rgba(5,150,105,0.25)' : 'var(--shadow-primary)',
                    }}
                  >
                    {orgSaving ? (
                      <span className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                        Saving…
                      </span>
                    ) : orgSaved ? (
                      <span className="flex items-center gap-2"><Icon name="check_circle" size={16} />{t('settings.orgProfile.savedButton')}</span>
                    ) : (
                      <span className="flex items-center gap-2"><Icon name="save" size={16} />{t('settings.orgProfile.saveButton')}</span>
                    )}
                  </Button>
                </Card>

                {/* Crystal AI Context banner — shown when industry is not set */}
                {!orgProfile.industry && (
                  <div className="flex items-start gap-4 px-5 py-4 rounded-xl border-2 border-dashed"
                    style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 4%, transparent), color-mix(in srgb, var(--color-secondary) 4%, transparent))', borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)' }}>
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                      <Icon name="psychology" size={20} style={{ color: 'white' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-on-surface">{t('settings.orgProfile.crystalNudgeTitle')}</p>
                      <p className="text-xs text-on-surface-variant mt-0.5 leading-relaxed">{t('settings.orgProfile.crystalNudgeDesc')}</p>
                    </div>
                  </div>
                )}

                {/* Clerk org management OR team table */}
                {clerkKey && orgId ? (
                  <div className="flex justify-center">
                    <OrganizationProfile
                      appearance={{ elements: { rootBox: 'w-full max-w-4xl', card: 'shadow-none border rounded-2xl' } }}
                    />
                  </div>
                ) : clerkKey && !orgId ? (
                  <div className="text-center py-16 rounded-2xl border-2 border-dashed border-primary/15 bg-primary/2">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 bg-primary/8">
                      <Icon name="business" size={28} className="text-primary" />
                    </div>
                    <p className="text-base font-bold mb-2 text-on-surface">No organization selected</p>
                    <p className="text-sm mb-6 text-on-surface-variant">Select a workspace from the onboarding screen to manage your organization.</p>
                    <Button onClick={() => navigate(ROUTES.ONBOARDING)} variant="gradient"
                      className="px-6 py-3 text-white font-bold text-sm font-headline rounded-xl"
                      style={{ boxShadow: '0 10px 25px -5px color-mix(in srgb, var(--color-primary) 35%, transparent)' }}>
                      Select Workspace
                    </Button>
                  </div>
                ) : (
                  <Card className="overflow-hidden bg-white rounded-2xl border-0" style={{ boxShadow: '0 40px 60px -10px rgba(44,47,49,0.06)' }}>
                    <div className="p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
                      <div>
                        <h3 className="text-xl font-bold font-headline text-on-surface">{t('settings.team.heading')}</h3>
                        <p className="text-sm text-on-surface-variant">{t('settings.team.description')}</p>
                      </div>
                      <Button variant="default" className="px-8 py-4 font-bold flex items-center justify-center gap-2 text-white font-headline rounded-xl bg-primary"
                        style={{ boxShadow: '0 20px 40px -10px color-mix(in srgb, var(--color-primary) 20%, transparent)' }}>
                        <Icon name="person_add" size={20} />{t('settings.team.inviteButton')}
                      </Button>
                    </div>
                    <div className="px-8 pb-8 overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-border">
                            {[t('settings.team.tableHeaders.user'), t('settings.team.tableHeaders.role'), t('settings.team.tableHeaders.status'), t('settings.team.tableHeaders.actions')].map((h, i) => (
                              <th key={h} className="py-4 text-xs font-bold uppercase tracking-widest text-on-surface-variant" style={{ textAlign: i === 3 ? 'right' : 'left' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {DEMO_TEAM_MEMBERS.map((member) => (
                            <tr key={member.email} className="transition-colors border-b border-muted/20 hover:bg-muted/5">
                              <td className="py-5">
                                <div className="flex items-center gap-3">
                                  <div className="h-10 w-10 rounded-full flex items-center justify-center font-bold text-sm" style={{ background: member.bg, color: member.color }}>{member.initials}</div>
                                  <div>
                                    <div className="font-bold text-sm text-on-surface">{member.name}</div>
                                    <div className="text-xs text-on-surface-variant">{member.email}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="py-5"><span className="text-sm font-medium text-on-surface">{member.role}</span></td>
                              <td className="py-5">
                                <Badge variant={member.statusActive ? 'success' : 'secondary'}
                                  className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full w-fit"
                                  style={{ color: member.statusActive ? 'var(--color-secondary)' : '#595c5e', background: member.statusActive ? 'color-mix(in srgb, var(--color-secondary) 10%, transparent)' : '#e5e9eb' }}>
                                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: member.statusActive ? 'var(--color-secondary)' : 'rgba(89,92,94,0.4)' }} />
                                  {member.statusActive ? t('settings.team.statusActive') : t('settings.team.statusPending')}
                                </Badge>
                              </td>
                              <td className="py-5 text-right">
                                <Button variant="ghost" size="icon" className="p-2 text-on-surface-variant hover:text-primary">
                                  <Icon name="more_vert" size={20} />
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </div>
            )}

            {/* ── Notifications Tab ── */}
            {activeTab === 'Team' && (
              <div className="py-6">
                <TeamPanel />
              </div>
            )}

            {activeTab === 'Roles' && isAdmin && (
              <div className="py-6">
                <RolesPanel />
              </div>
            )}

            {activeTab === 'Notifications' && (
              <div className="mt-8 space-y-6">
                <Card
                  className="p-8 bg-white rounded-2xl border-0"
                  style={{ boxShadow: '0 40px 60px -10px rgba(44,47,49,0.06)' }}
                >
                  <h3 className="text-xl font-bold mb-1 font-headline text-on-surface">
                    {t('settings.notifications.heading')}
                  </h3>
                  <p className="text-sm text-on-surface-variant mb-8">
                    {t('settings.notifications.description')}
                  </p>

                  <div className="space-y-8">
                    {([
                      { key: 'inApp', icon: 'notifications',  comingSoon: false },
                      { key: 'email', icon: 'mail',            comingSoon: true  },
                      { key: 'push',  icon: 'mobile_friendly', comingSoon: true  },
                    ] as const).map(({ key, icon, comingSoon }) => {
                      const channelCfg = (t('settings.notifications.channels') as unknown as Record<string, { label: string; desc: string }>)[key];
                      const events = t('settings.notifications.events') as unknown as Record<string, string>;
                      return (
                        <div key={key} className="rounded-2xl border border-muted/15 p-6 space-y-4">
                          {/* Channel header */}
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                              <Icon name={icon} size={18} className="text-primary" />
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-bold text-sm text-on-surface">{channelCfg?.label}</p>
                                {comingSoon && (
                                  <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full"
                                    style={{ background: '#eef2ff', color: '#4f46e5' }}>
                                    {t('settings.notifications.comingSoonBadge')}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">{channelCfg?.desc}</p>
                            </div>
                          </div>

                          {/* Event toggles (all disabled/coming-soon) */}
                          <div className="space-y-2 pl-12">
                            {Object.entries(events).map(([eventKey, label]) => (
                              <div key={eventKey}
                                className="flex items-center justify-between py-2 border-b border-muted/10 last:border-0">
                                <span className="text-sm text-on-surface-variant">{label}</span>
                                <div
                                  className="w-9 h-5 rounded-full flex items-center px-0.5 cursor-not-allowed opacity-40"
                                  style={{ background: '#e2e8f0' }}
                                  title={t('settings.notifications.comingSoonBadge')}
                                >
                                  <div className="w-4 h-4 rounded-full bg-white shadow-sm" />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              </div>
            )}

            {/* ── Admin Tab ── */}
            {activeTab === 'Admin' && !isAdmin && (
              <div className="mt-8"><PermissionDeniedBanner /></div>
            )}
            {activeTab === 'Admin' && isAdmin && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
                <Card
                  className="p-6 bg-white rounded-2xl border-0 flex flex-col"
                  style={{ boxShadow: '0 40px 60px -10px rgba(44,47,49,0.06)' }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm"
                      style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                      ◆
                    </div>
                    <h3 className="text-lg font-bold font-headline text-on-surface">{t('settings.admin.crystalTitle')}</h3>
                  </div>
                  <p className="text-sm text-on-surface-variant flex-1 mb-6">{t('settings.admin.crystalDescription')}</p>
                  <Button onClick={() => navigate(ROUTES.ADMIN_CRYSTAL_SKILLS)}>
                    <Icon name="arrow_forward" size={16} className="mr-1.5" />
                    {t('settings.admin.openCrystal')}
                  </Button>
                </Card>
                <Card
                  className="p-6 bg-white rounded-2xl border-0 flex flex-col"
                  style={{ boxShadow: '0 40px 60px -10px rgba(44,47,49,0.06)' }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Icon name="queue" size={22} className="text-primary" />
                    </div>
                    <h3 className="text-lg font-bold font-headline text-on-surface">{t('settings.admin.pipelineTitle')}</h3>
                  </div>
                  <p className="text-sm text-on-surface-variant flex-1 mb-6">{t('settings.admin.pipelineDescription')}</p>
                  <Button onClick={() => navigate(ROUTES.ADMIN_SUPPORT_PIPELINE)}>
                    <Icon name="arrow_forward" size={16} className="mr-1.5" />
                    {t('settings.admin.openPipeline')}
                  </Button>
                </Card>
              </div>
            )}

            {/* ── API Keys Tab ── */}
            {activeTab === 'API Keys' && !isAdmin && (
              <div className="mt-8"><PermissionDeniedBanner /></div>
            )}
            {activeTab === 'API Keys' && isAdmin && (
              <Card
                className="p-8 bg-white rounded-2xl border-0 mt-8"
                style={{ boxShadow: '0 40px 60px -10px rgba(44,47,49,0.06)' }}
              >
                <h3 className="text-xl font-bold mb-2 font-headline text-on-surface">API Keys</h3>
                <p className="text-sm mb-8 text-on-surface-variant">
                  Use these keys to authenticate requests to the Experient API.
                </p>
                <div
                  className="flex items-center justify-between p-4 rounded-xl bg-primary/4 border border-primary/12"
                >
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest mb-1 text-on-surface-variant">
                      Secret Key
                    </p>
                    <p className="font-mono text-sm text-on-surface">sk_live_••••••••••••••••••••••••••••••</p>
                  </div>
                  <Button variant="ghost" size="sm" className="flex items-center gap-1.5 text-xs font-bold text-primary">
                    <Icon name="visibility" size={14} />
                    Reveal
                  </Button>
                </div>
              </Card>
            )}
          </Tabs>
        </div>
  );
}
