import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { usePermissions } from '../../lib/permissions';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { TagBadge } from '../../components/TagBadge';
import { ROUTES, toPath } from '../../constants/routes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { SurveyTag } from '../../lib/api';
import { cn } from '@/lib/utils';

const PRESET_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };
const rise = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] } },
};

export function TagsSettingsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('groups.settingsTitle'), t('groups.settingsSubtitle'));
  const { isAdmin } = usePermissions();
  const api = useApi();
  const navigate = useNavigate();

  const [tags,         setTags]         = useState<SurveyTag[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [createOpen,   setCreateOpen]   = useState(false);
  const [deleting,     setDeleting]     = useState(false);

  const loadTags = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listTags();
      setTags(res.tags);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { loadTags(); }, [loadTags]);

  async function handleDelete(tag: SurveyTag) {
    if (!window.confirm(t('groups.deleteTagConfirm', { name: tag.name }))) return;
    setDeleting(true);
    try {
      await api.deleteTag(tag.id);
      setTags(prev => prev.filter(tg => tg.id !== tag.id));
    } catch { /* ignore */ }
    finally { setDeleting(false); }
  }

  if (!isAdmin) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <PageHeader title={t('groups.settingsTitle')} />
        <div className="rounded-xl border border-border p-8 text-center text-on-surface-variant">
          <Icon name="lock" size={32} className="mx-auto mb-3 opacity-50" />
          {t('settings.userDirectory.accessDenied')}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('nav.settings'), path: ROUTES.SETTINGS }, { label: t('groups.settingsTitle') }]}
        title={t('groups.settingsTitle')}
        subtitle={t('groups.settingsSubtitle')}
        actions={
          <Button onClick={() => setCreateOpen(true)} style={{ background: 'var(--color-primary)' }}
            className="rounded-xl font-headline gap-1.5">
            <Icon name="add" size={16} />
            {t('groups.addTag')}
          </Button>
        }
      />

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 text-destructive text-sm p-3 mb-4">{error}</div>
      )}

      {loading ? (
        <p className="text-on-surface-variant py-10 text-center">{t('common.loading')}</p>
      ) : tags.length === 0 ? (
        <div className="rounded-xl border border-border p-12 text-center text-on-surface-variant">
          <Icon name="label" size={40} className="mx-auto mb-4 opacity-40" />
          <p>{t('groups.noTagsYet')}</p>
        </div>
      ) : (
        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          variants={stagger} initial="hidden" animate="visible"
        >
          {tags.map((tag) => (
            <motion.div key={tag.id} variants={rise}>
              <Card
                className="p-4 cursor-pointer hover:shadow-md transition-shadow group"
                onClick={() => navigate(toPath(ROUTES.TAG_REPORT_LATEST, { tagId: tag.id }))}
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <TagBadge tag={tag} size="md" />
                  <Button
                    variant="ghost" size="icon"
                    className="rounded-lg text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7"
                    onClick={(e) => { e.stopPropagation(); handleDelete(tag); }}
                    disabled={deleting}
                  >
                    <Icon name="delete" size={15} />
                  </Button>
                </div>

                {tag.description && (
                  <p className="text-xs text-on-surface-variant mb-2 line-clamp-2">{tag.description}</p>
                )}

                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-on-surface-variant">
                    {t('groups.surveyCount', { count: Number(tag.survey_count ?? 0) })}
                  </span>
                  <span className="text-xs text-on-surface-variant">
                    {new Date(tag.created_at).toLocaleDateString()}
                  </span>
                </div>

                <div className="mt-2 flex items-center gap-1 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                  <Icon name="analytics" size={12} />
                  {t('groups.generateReport')}
                </div>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}

      <CreateTagDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (data) => {
          await api.createTag(data);
          await loadTags();
        }}
      />
    </div>
  );
}

function CreateTagDialog({ open, onOpenChange, onCreate }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (data: { name: string; color: string; description?: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name,        setName]        = useState('');
  const [description, setDescription] = useState('');
  const [color,       setColor]       = useState(PRESET_COLORS[0]);
  const [submitting,  setSubmitting]  = useState(false);
  const [err,         setErr]         = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setErr(null);
    try {
      await onCreate({ name, color, description: description || undefined });
      setName(''); setDescription(''); setColor(PRESET_COLORS[0]);
      onOpenChange(false);
    } catch (er) {
      setErr(er instanceof Error ? er.message : String(er));
    } finally { setSubmitting(false); }
  }

  // Preview tag
  const previewTag: SurveyTag = { id: 'preview', name: name || t('groups.createTagPlaceholder'), slug: 'preview', color, created_at: new Date().toISOString() };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('groups.addTag')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">{t('groups.tag')}</Label>
            <Input
              id="tag-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('groups.createTagPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('groups.tags')} color</Label>
            <div className="flex items-center gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={cn(
                    'w-7 h-7 rounded-full transition-transform border-2',
                    color === c ? 'scale-110 border-on-surface/30' : 'border-transparent',
                  )}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tag-description">{t('groups.tagDescriptionPlaceholder')}</Label>
            <Input
              id="tag-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('groups.tagDescriptionPlaceholder')}
            />
          </div>

          {/* Preview */}
          <div className="space-y-1.5">
            <Label>Preview</Label>
            <TagBadge tag={previewTag} size="md" />
          </div>

          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={submitting || !name}
              style={{ background: 'var(--color-primary)' }}>
              {submitting ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
