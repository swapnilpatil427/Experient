import { useState, useEffect, useRef, useCallback } from 'react';
import { Icon } from '../components/Icon';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useSurveys } from '../hooks/useSurveys';
import { useApi } from '../hooks/useApi';
import { useBrand } from '../contexts/brandContext';
import { ROUTES } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { PageHeader } from '../components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Survey } from '../types';

// ── QR code generation ────────────────────────────────────────────────────────
// Uses the `qrcode` npm package (add: npm install qrcode @types/qrcode in app/)
async function generateQRDataUrl(
  url: string,
  options: { dark?: string; light?: string; width?: number } = {},
): Promise<string | null> {
  try {
    const QRCode = await import('qrcode');
    return await QRCode.toDataURL(url, {
      width:  options.width ?? 320,
      margin: 2,
      color:  { dark: options.dark ?? '#1a1a2e', light: options.light ?? '#ffffff' },
    });
  } catch {
    return null;
  }
}

async function generateQRWithLogo(
  url: string,
  logoUrl: string | null,
  dark: string,
): Promise<string | null> {
  const dataUrl = await generateQRDataUrl(url, { dark, width: 400 });
  if (!dataUrl) return null;
  if (!logoUrl) return dataUrl;

  return new Promise<string>((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width  = 400;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');
    if (!ctx) { resolve(dataUrl); return; }

    const qrImg = new Image();
    qrImg.onload = () => {
      ctx.drawImage(qrImg, 0, 0, 400, 400);

      const logoImg = new Image();
      logoImg.crossOrigin = 'anonymous';
      logoImg.onload = () => {
        const size  = 72;
        const pad   = 10;
        const x     = (400 - size) / 2;
        const y     = (400 - size) / 2;

        // white rounded bg
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(x - pad / 2, y - pad / 2, size + pad, size + pad, 10);
        ctx.fill();

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, size, size, 8);
        ctx.clip();
        ctx.drawImage(logoImg, x, y, size, size);
        ctx.restore();

        resolve(canvas.toDataURL('image/png'));
      };
      logoImg.onerror = () => resolve(dataUrl);
      logoImg.src     = logoUrl;
    };
    qrImg.src = dataUrl;
  });
}

// ── Channel card types ────────────────────────────────────────────────────────
type ChannelId = 'link' | 'qr' | 'email' | 'embed' | 'social' | 'api' | 'kiosk';

interface ChannelDef {
  id:         ChannelId;
  icon:       string;
  iconColor:  string;
  iconBg:     string;
  badge?:     string;
  badgeColor: string;
}

const CHANNELS: ChannelDef[] = [
  { id: 'link',   icon: 'link',             iconColor: '#2a4bd9', iconBg: 'rgba(42,75,217,0.1)',   badge: 'Instant',    badgeColor: '#2a4bd9' },
  { id: 'qr',     icon: 'qr_code_2',        iconColor: '#059669', iconBg: 'rgba(5,150,105,0.1)',   badge: 'Print-ready',badgeColor: '#059669' },
  { id: 'email',  icon: 'mark_email_read',   iconColor: '#d97706', iconBg: 'rgba(217,119,6,0.1)',   badge: 'Targeted',   badgeColor: '#d97706' },
  { id: 'embed',  icon: 'code',              iconColor: '#7c3aed', iconBg: 'rgba(124,58,237,0.1)',  badge: 'Low friction',badgeColor: '#7c3aed' },
  { id: 'social', icon: 'share',             iconColor: '#0891b2', iconBg: 'rgba(8,145,178,0.1)',   badge: 'Wide reach', badgeColor: '#0891b2' },
  { id: 'api',    icon: 'api',               iconColor: '#dc2626', iconBg: 'rgba(220,38,38,0.1)',   badge: 'Developer',  badgeColor: '#dc2626' },
  { id: 'kiosk',  icon: 'spatial_tracking',  iconColor: '#8329c8', iconBg: 'rgba(131,41,200,0.1)',  badge: 'In-person',  badgeColor: '#8329c8' },
];

// ── Stat pill ─────────────────────────────────────────────────────────────────
function StatPill({ icon, label, value }: { icon: string; label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 rounded-2xl bg-white border border-border/40"
      style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
      <Icon name={icon} fill={1} size={22} className="text-primary" />
      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{label}</p>
        <p className="text-xl font-black font-headline text-on-surface">{value}</p>
      </div>
    </div>
  );
}

// ── QR Display component ──────────────────────────────────────────────────────
function QRDisplay({
  surveyUrl,
  logoUrl,
  dark = '#1a1a2e',
}: {
  surveyUrl: string;
  logoUrl:   string | null;
  dark?:     string;
}) {
  const { t } = useTranslation();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    if (!surveyUrl) return;
    setLoading(true);
    generateQRWithLogo(surveyUrl, logoUrl, dark).then((url) => {
      setQrDataUrl(url);
      setLoading(false);
    });
  }, [surveyUrl, logoUrl, dark]);

  const handleDownload = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href     = qrDataUrl;
    a.download = 'survey-qr.png';
    a.click();
  };

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <div
        className="w-full max-w-[280px] aspect-square rounded-2xl overflow-hidden flex items-center justify-center"
        style={{ border: '2px solid rgba(0,0,0,0.06)', background: '#f8f9fb' }}
      >
        {loading ? (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Icon name="qr_code_2" size={40} />
            <p className="text-xs">{t('collection.generatingQR')}</p>
          </div>
        ) : qrDataUrl ? (
          <img src={qrDataUrl} alt="QR Code" className="w-full h-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground text-center p-6">
            <Icon name="error_outline" size={32} />
            <p className="text-xs">Run <code>npm install</code> in the app folder to enable QR generation.</p>
          </div>
        )}
      </div>
      {logoUrl && qrDataUrl && (
        <div className="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant">
          <Icon name="verified" size={13} className="text-primary" />
          {t('collection.qrBrandLogo')}
        </div>
      )}
      <Button
        onClick={handleDownload}
        disabled={!qrDataUrl}
        variant="outline"
        className="w-full flex items-center justify-center gap-2 font-bold rounded-xl border-2 border-primary text-primary hover:bg-primary/5"
      >
        <Icon name="download" size={18} />
        {t('collection.downloadQR')}
      </Button>
    </div>
  );
}

// ── Launch Settings panel ─────────────────────────────────────────────────────
interface LaunchSettingsState {
  maxResponses: string;
  autoCloseAt:  string;
  allowMultiple: boolean;
  passwordProtected: boolean;
  password: string;
}

function LaunchSettingsPanel({ survey }: { survey: Survey | null }) {
  const { t }  = useTranslation();
  const api    = useApi();
  const [form,    setForm]    = useState<LaunchSettingsState>({
    maxResponses:      survey?.max_responses?.toString() ?? '',
    autoCloseAt:       survey?.auto_close_at ? new Date(survey.auto_close_at).toISOString().slice(0, 16) : '',
    allowMultiple:     survey?.allow_multiple_responses ?? true,
    passwordProtected: survey?.password_protected ?? false,
    password:          '',
  });
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [showPass,setShowPass]= useState(false);

  useEffect(() => {
    setForm({
      maxResponses:      survey?.max_responses?.toString() ?? '',
      autoCloseAt:       survey?.auto_close_at ? new Date(survey.auto_close_at).toISOString().slice(0, 16) : '',
      allowMultiple:     survey?.allow_multiple_responses ?? true,
      passwordProtected: survey?.password_protected ?? false,
      password:          '',
    });
  }, [survey?.id]);

  const ls = t('collection.launchSettings') as unknown as Record<string, string>;

  const handleSave = async () => {
    if (!survey) return;
    setSaving(true);
    try {
      await api.updateLaunchSettings(survey.id, {
        maxResponses:          form.maxResponses ? parseInt(form.maxResponses, 10) : null,
        autoCloseAt:           form.autoCloseAt ? new Date(form.autoCloseAt).toISOString() : null,
        allowMultipleResponses:form.allowMultiple,
        passwordProtected:     form.passwordProtected,
        password:              form.password || undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch { /* noop */ }
    finally { setSaving(false); }
  };

  return (
    <Card className="p-6 rounded-2xl bg-surface-container-low border-white/40"
      style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="font-bold text-base font-headline text-on-surface flex items-center gap-2">
            <Icon name="tune" size={18} className="text-primary" />
            {ls.title}
          </h3>
          <p className="text-xs text-on-surface-variant mt-0.5">{ls.subtitle}</p>
        </div>
        {survey?.password_protected && (
          <Badge className="text-[10px] font-bold px-2 bg-amber-100 text-amber-700 border-amber-200">
            <Icon name="lock" size={11} className="inline mr-1" />
            {ls.passwordProtectedBadge}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-5">
        {/* Response limit */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {ls.maxResponsesLabel}
            </Label>
            <Input
              type="number"
              min={1}
              placeholder={ls.maxResponsesPlaceholder}
              value={form.maxResponses}
              disabled={!survey}
              onChange={(e) => setForm((s) => ({ ...s, maxResponses: e.target.value }))}
              className="rounded-xl"
            />
            <p className="text-[11px] text-muted-foreground">{ls.maxResponsesHint}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {ls.autoCloseLabel}
            </Label>
            <Input
              type="datetime-local"
              value={form.autoCloseAt}
              disabled={!survey}
              onChange={(e) => setForm((s) => ({ ...s, autoCloseAt: e.target.value }))}
              className="rounded-xl"
            />
            <p className="text-[11px] text-muted-foreground">{ls.autoCloseHint}</p>
          </div>
        </div>

        {/* Allow multiple */}
        <div className="flex items-center justify-between gap-4 p-3 rounded-xl"
          style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
          <div>
            <p className="text-sm font-semibold text-on-surface">{ls.allowMultipleLabel}</p>
            <p className="text-[11px] text-muted-foreground">{ls.allowMultipleHint}</p>
          </div>
          <Switch
            checked={form.allowMultiple}
            disabled={!survey}
            onCheckedChange={(v) => setForm((s) => ({ ...s, allowMultiple: v }))}
          />
        </div>

        {/* Password protection */}
        <div className="flex flex-col gap-3 p-3 rounded-xl"
          style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-on-surface">{ls.passwordLabel}</p>
              <p className="text-[11px] text-muted-foreground">{ls.passwordHint}</p>
            </div>
            <Switch
              checked={form.passwordProtected}
              disabled={!survey}
              onCheckedChange={(v) => setForm((s) => ({ ...s, passwordProtected: v, password: v ? s.password : '' }))}
            />
          </div>
          {form.passwordProtected && (
            <div className="relative">
              <Input
                type={showPass ? 'text' : 'password'}
                placeholder={ls.passwordPlaceholder}
                value={form.password}
                disabled={!survey}
                onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))}
                className="rounded-xl pr-14"
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-on-surface"
              >
                {showPass ? 'Hide' : 'Show'}
              </button>
              <p className="text-[11px] text-muted-foreground mt-1">{ls.passwordMinLength}</p>
            </div>
          )}
        </div>

        <Button
          onClick={handleSave}
          disabled={saving || !survey}
          className="self-end flex items-center gap-2 font-bold rounded-xl px-6"
          style={{
            background: saved ? '#059669' : 'linear-gradient(135deg, var(--color-primary), var(--color-primary-container))',
            color: '#fff',
          }}
        >
          {saving ? (
            <><Icon name="hourglass_empty" size={16} />{ls.savingSettings}</>
          ) : saved ? (
            <><Icon name="check" size={16} />{ls.settingsSaved}</>
          ) : (
            <><Icon name="save" size={16} />{ls.saveSettings}</>
          )}
        </Button>
      </div>
    </Card>
  );
}

// ── Channel panel: expanded detail ───────────────────────────────────────────
function ChannelPanel({
  channel,
  surveyUrl,
  survey,
  logoUrl,
}: {
  channel:   ChannelId;
  surveyUrl: string;
  survey:    Survey | null;
  logoUrl:   string | null;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const embedCode = `<iframe src="${surveyUrl}" width="100%" height="700px" frameborder="0" allow="clipboard-write" loading="lazy"></iframe>`;
  const apiEndpoint = surveyUrl.replace('/s/', '/api/surveys/').replace(window.location.origin, '');

  const channels = (t('collection.channels') as unknown as Record<string, Record<string, string>>);

  if (channel === 'link') {
    return (
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-2">
          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {t('collection.surveyLinkLabel')}
          </Label>
          <div className="flex gap-2">
            <div className="flex-1 px-4 py-3 rounded-xl text-sm font-mono overflow-hidden text-on-surface-variant bg-surface-container-low border border-border/30 truncate">
              {surveyUrl}
            </div>
            <Button
              onClick={() => copy(surveyUrl, 'link')}
              className="shrink-0 font-bold px-5 rounded-xl"
              style={{
                background: copied === 'link' ? '#059669' : 'linear-gradient(135deg, var(--color-primary), var(--color-primary-container))',
                color: '#fff',
              }}
            >
              <Icon name={copied === 'link' ? 'check' : 'content_copy'} size={16} className="mr-2" />
              {copied === 'link' ? t('collection.copiedButton') : t('collection.copyButton')}
            </Button>
          </div>
        </div>
        <a
          href={surveyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start flex items-center gap-2 text-sm font-bold px-4 py-2.5 rounded-xl bg-primary/10 text-primary hover:bg-primary/15 transition-colors"
        >
          <Icon name="open_in_new" size={15} />
          {t('collection.openSurvey')}
        </a>
      </div>
    );
  }

  if (channel === 'qr') {
    return (
      <div className="flex flex-col md:flex-row gap-8 p-5">
        <div className="flex-shrink-0 w-full md:w-[280px]">
          <QRDisplay surveyUrl={surveyUrl} logoUrl={logoUrl} />
        </div>
        <div className="flex flex-col gap-3 justify-center">
          <p className="text-sm font-semibold text-on-surface">{channels.qr?.desc}</p>
          <div className="flex flex-col gap-2 text-sm text-on-surface-variant">
            <div className="flex items-center gap-2"><Icon name="check_circle" size={15} className="text-primary" />Scan with any camera app</div>
            <div className="flex items-center gap-2"><Icon name="check_circle" size={15} className="text-primary" />Print at any resolution</div>
            <div className="flex items-center gap-2"><Icon name="check_circle" size={15} className="text-primary" />Brand logo embedded in center</div>
          </div>
        </div>
      </div>
    );
  }

  if (channel === 'embed') {
    return (
      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-on-surface-variant">{t('collection.embedHint')}</p>
        <div
          className="p-4 font-mono text-xs leading-relaxed overflow-x-auto whitespace-nowrap rounded-xl select-all text-on-surface-variant"
          style={{ background: 'var(--color-surface-container-highest)', boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.05)' }}
        >
          {embedCode}
        </div>
        <Button
          onClick={() => copy(embedCode, 'embed')}
          variant="outline"
          className="self-start flex items-center gap-2 font-bold rounded-xl border-2"
        >
          <Icon name={copied === 'embed' ? 'check' : 'content_copy'} size={16} />
          {copied === 'embed' ? t('collection.embedCopied') : channels.embed?.cta}
        </Button>
      </div>
    );
  }

  if (channel === 'social') {
    const msg = encodeURIComponent((channels.social?.messageTemplate ?? '').replace('{url}', surveyUrl));
    const links = [
      { label: channels.social?.linkedin, icon: 'open_in_new', url: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(surveyUrl)}`, color: '#0a66c2' },
      { label: channels.social?.twitter,  icon: 'open_in_new', url: `https://twitter.com/intent/tweet?text=${msg}`,                                          color: '#000000' },
      { label: channels.social?.whatsapp, icon: 'open_in_new', url: `https://api.whatsapp.com/send?text=${msg}`,                                             color: '#25d366' },
    ];
    return (
      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-on-surface-variant">{channels.social?.desc}</p>
        <div className="flex flex-col gap-3">
          {links.map(({ label, icon, url, color }) => (
            <a
              key={label}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-4 p-3.5 rounded-xl font-semibold text-sm transition-all hover:opacity-90 active:scale-95"
              style={{ background: color, color: '#fff' }}
            >
              <span>{label}</span>
              <Icon name={icon} size={16} />
            </a>
          ))}
        </div>
      </div>
    );
  }

  if (channel === 'email') {
    return (
      <div className="flex flex-col gap-4 p-5">
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          {channels.email?.comingSoon}
        </div>
        <p className="text-sm text-on-surface-variant">{channels.email?.desc}</p>
      </div>
    );
  }

  if (channel === 'api') {
    return (
      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-on-surface-variant">{channels.api?.endpointHint}</p>
        <div className="flex flex-col gap-2">
          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {channels.api?.endpoint}
          </Label>
          <div className="flex gap-2">
            <div className="flex-1 px-4 py-3 rounded-xl text-sm font-mono text-on-surface-variant bg-surface-container-low border border-border/30 overflow-hidden truncate">
              POST {surveyUrl.replace('/s/', '/api/surveys/')}/responses
            </div>
            <Button
              onClick={() => copy(`POST ${window.location.origin}/api/surveys/${survey?.id}/responses`, 'api')}
              variant="outline"
              size="icon"
              className="shrink-0 rounded-xl"
              title={channels.api?.copyEndpoint}
            >
              <Icon name={copied === 'api' ? 'check' : 'content_copy'} size={16} />
            </Button>
          </div>
        </div>
        <p className="text-xs font-mono text-muted-foreground p-3 rounded-lg bg-surface-container-low">
          {`GET /api/surveys/${survey?.id || ':id'}/responses   →  { responses, total }`}
        </p>
      </div>
    );
  }

  if (channel === 'kiosk') {
    return (
      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-on-surface-variant">{channels.kiosk?.hint}</p>
        <a
          href={surveyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start flex items-center gap-2 font-bold px-5 py-3 rounded-xl text-white transition-all hover:-translate-y-0.5"
          style={{ background: 'linear-gradient(135deg, var(--color-tertiary), #a855f7)' }}
        >
          <Icon name="open_in_new" size={16} />
          {channels.kiosk?.cta}
        </a>
      </div>
    );
  }

  return null;
}

// ── Main page component ───────────────────────────────────────────────────────
export function ResponseCollectionPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('collection.pageTitle'), t('collection.pageSubtitle'));
  const { surveys } = useSurveys();
  const { logoUrl } = useBrand();
  const [selectedSurveyId, setSelectedSurveyId] = useState<string | null>(null);
  const [activeChannel, setActiveChannel] = useState<ChannelId | null>(null);

  const activeSurveys = surveys.filter((s) => s.status === 'active');
  const survey: Survey | null = selectedSurveyId
    ? (surveys.find((s) => s.id === selectedSurveyId) ?? null)
    : activeSurveys[0] ?? null;

  const token     = survey?.publish_token ?? null;
  const surveyUrl = token ? `${window.location.origin}/s/${token}` : '';

  const channels = t('collection.channels') as unknown as Record<string, Record<string, string>>;

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('nav.respondents'), icon: 'groups', path: ROUTES.RESPONDENTS }]}
        title={t('collection.pageTitle')}
        subtitle={t('collection.shareDescription')}
      />

      {/* Survey selector — always visible */}
      <div className="w-full mb-6">
        <Select
          value={selectedSurveyId ?? (survey?.id ?? '__none__')}
          onValueChange={(val) => setSelectedSurveyId(val === '__none__' ? null : val)}
        >
          <SelectTrigger className="w-full md:w-80 px-4 py-2.5 text-sm font-semibold rounded-[10px] bg-white text-on-surface border-border">
            <SelectValue placeholder={t('collection.selectSurvey')} />
          </SelectTrigger>
          <SelectContent>
            {activeSurveys.length === 0 ? (
              <SelectItem value="__none__" disabled>{t('collection.noSurveys')}</SelectItem>
            ) : (
              activeSurveys.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Stats bar */}
      {survey && (
        <div className="flex flex-wrap gap-3 mb-8">
          <StatPill icon="analytics"   label={t('collection.responsesCollected')} value={(survey.response_count ?? 0).toLocaleString()} />
          <StatPill icon="calendar_today" label={t('collection.completionRate')} value="—" />
          {survey.password_protected && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-700 text-sm font-semibold">
              <Icon name="lock" size={16} />
              Password protected
            </div>
          )}
        </div>
      )}

      {/* No survey state */}
      {!survey && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)' }}>
            <Icon name="share" size={32} className="text-primary" />
          </div>
          <h3 className="text-lg font-bold text-on-surface mb-2">{t('collection.noSurveys')}</h3>
          <p className="text-sm text-on-surface-variant max-w-md">{t('collection.noSurveysHint')}</p>
        </div>
      )}

      {survey && (
        <div className="flex flex-col gap-6">
          {/* Channel grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {CHANNELS.map(({ id, icon, iconColor, iconBg, badge, badgeColor }) => {
              const ch     = channels[id];
              const isOpen = activeChannel === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveChannel(isOpen ? null : id)}
                  className="flex flex-col items-start gap-3 p-5 rounded-2xl text-left transition-all duration-200 group"
                  style={{
                    background: isOpen ? 'white' : 'var(--color-surface-container-low)',
                    border:     `1.5px solid ${isOpen ? iconColor + '40' : 'rgba(0,0,0,0.06)'}`,
                    boxShadow:  isOpen ? `0 8px 24px ${iconColor}20` : '0 1px 4px rgba(0,0,0,0.04)',
                    transform:  isOpen ? 'translateY(-2px)' : 'none',
                  }}
                >
                  <div className="flex items-center justify-between w-full">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110"
                      style={{ background: iconBg, color: iconColor }}
                    >
                      <Icon name={icon} size={22} />
                    </div>
                    {badge && (
                      <span
                        className="text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full"
                        style={{ background: badgeColor + '15', color: badgeColor }}
                      >
                        {badge}
                      </span>
                    )}
                  </div>
                  <div>
                    <p className="font-bold text-sm text-on-surface font-headline">{ch?.title}</p>
                    <p className="text-[11px] text-on-surface-variant mt-0.5 line-clamp-2">{ch?.desc}</p>
                  </div>
                  <div
                    className="text-xs font-bold flex items-center gap-1 transition-colors"
                    style={{ color: isOpen ? iconColor : 'var(--color-on-surface-variant)' }}
                  >
                    {isOpen ? (
                      <><Icon name="expand_less" size={14} />Hide</>
                    ) : (
                      <><Icon name="arrow_forward" size={14} />{ch?.cta}</>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Expanded channel panel */}
          {activeChannel && (
            <Card
              className="rounded-2xl overflow-hidden border-white/40"
              style={{ boxShadow: '0 12px 40px rgba(0,0,0,0.06)' }}
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-border/30"
                style={{ background: 'rgba(0,0,0,0.02)' }}>
                {(() => {
                  const ch = CHANNELS.find((c) => c.id === activeChannel)!;
                  return (
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ background: ch.iconBg, color: ch.iconColor }}
                      >
                        <Icon name={ch.icon} size={18} />
                      </div>
                      <p className="font-bold text-sm text-on-surface">
                        {(channels[activeChannel] as Record<string, string>)?.title}
                      </p>
                    </div>
                  );
                })()}
                <button
                  onClick={() => setActiveChannel(null)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-container"
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
              <ChannelPanel
                channel={activeChannel}
                surveyUrl={surveyUrl}
                survey={survey}
                logoUrl={logoUrl}
              />
            </Card>
          )}

          {/* Launch Settings */}
          <LaunchSettingsPanel survey={survey} />
        </div>
      )}
    </div>
  );
}
