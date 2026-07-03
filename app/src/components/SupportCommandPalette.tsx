// SupportCommandPalette — Cmd+K command palette for the Experient Support System.
// Opens with Cmd+K, shows doc search with Crystal integration.
// Glass card design, keyboard navigation, debounced search.

import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from './Icon';
import { useTranslation } from '../lib/i18n';
import { useApi } from '../hooks/useApi';
import { supportGuideUrl, supportUrl } from '../lib/supportUrl';
import type { SupportDoc } from '../lib/api';

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSupportCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return { open, setOpen };
}

// ── Quick actions ─────────────────────────────────────────────────────────────

interface QuickAction {
  id:    string;
  label: string;
  icon:  string;
  href?: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export interface SupportCommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function SupportCommandPalette({ open, onClose }: SupportCommandPaletteProps) {
  const { t } = useTranslation();
  const api = useApi();

  const [query, setQuery] = useState('');
  const [docs, setDocs] = useState<SupportDoc[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedDoc, setSelectedDoc] = useState<SupportDoc | null>(null);
  const [crystalActive, setCrystalActive] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const quickActions: QuickAction[] = [
    { id: 'browse',   label: t('support.browseAll'),   icon: 'library_books',    href: supportUrl('/guides') },
    { id: 'status',   label: t('support.checkStatus'), icon: 'monitor_heart',    href: supportUrl('/status') },
    { id: 'new',      label: t('support.whatsNew'),    icon: 'new_releases',     href: supportUrl('/changelog') },
    { id: 'roadmap',  label: t('support.viewRoadmap'), icon: 'map',              href: supportUrl('/roadmap') },
  ];

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setDocs([]);
      setSelectedIndex(0);
      setSelectedDoc(null);
      setCrystalActive(false);
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 3) {
      setDocs([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await api.getSupportDocs({ q: query, limit: 8 });
        setDocs(result.docs ?? []);
      } catch {
        setDocs([]);
      } finally {
        setIsLoading(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, api]);

  // All selectable items: quick actions (when no query) or docs
  const hasQuery = query.length >= 3;
  const items = hasQuery
    ? docs
    : quickActions;

  // Keep selectedIndex in bounds
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = useCallback((item: QuickAction | SupportDoc) => {
    if ('href' in item && item.href) {
      window.open(item.href, '_blank', 'noopener,noreferrer');
      onClose();
    } else if ('key' in item) {
      window.open(supportGuideUrl((item as SupportDoc).key), '_blank', 'noopener,noreferrer');
      onClose();
    }
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (selectedDoc) {
        setSelectedDoc(null);
      } else {
        onClose();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[selectedIndex]) {
        handleSelect(items[selectedIndex] as QuickAction | SupportDoc);
      }
    }
  }, [items, selectedIndex, handleSelect, onClose, selectedDoc]);

  // Backdrop click to close
  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const showCrystalPane = hasQuery && crystalActive;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="support-palette-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/40"
          style={{ backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
          onClick={handleBackdropClick}
        >
          <motion.div
            key="support-palette"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-3xl mx-4 mt-20 rounded-2xl overflow-hidden flex"
            style={{
              background: 'rgba(255,255,255,0.92)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              border: '1px solid rgba(255,255,255,0.5)',
              boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 12px color-mix(in srgb, var(--color-primary) 8%, transparent)',
              maxHeight: '75vh',
            }}
            onKeyDown={handleKeyDown}
          >
            {/* ── Left pane: search + results ──────────────────────────── */}
            <div className={`flex flex-col ${showCrystalPane ? 'w-1/2 border-r border-outline-variant/20' : 'w-full'}`}
              style={{ maxHeight: '75vh' }}>

              {/* Search input */}
              <div className="flex items-center gap-3 px-4 py-3.5 border-b border-outline-variant/20">
                <Icon name="search" size={18} className="text-on-surface-variant flex-shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('support.cmdkPlaceholder')}
                  className="flex-1 bg-transparent text-lg focus:outline-none text-on-surface placeholder:text-on-surface-variant/50"
                  style={{ fontFamily: 'inherit' }}
                />
                {query && (
                  <button
                    className="text-on-surface-variant hover:text-on-surface transition-colors flex-shrink-0"
                    onClick={() => setQuery('')}
                  >
                    <Icon name="close" size={16} />
                  </button>
                )}
                <kbd className="flex-shrink-0 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border border-outline-variant/40 text-on-surface-variant">
                  esc
                </kbd>
              </div>

              {/* Results / Quick actions */}
              <div className="flex-1 overflow-y-auto">
                {/* Loading skeletons */}
                {isLoading && (
                  <div className="px-4 py-3 space-y-2">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="skeleton h-12 rounded-xl" />
                    ))}
                  </div>
                )}

                {/* Empty state — no results but query entered */}
                {!isLoading && hasQuery && docs.length === 0 && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm text-on-surface-variant mb-3">
                      {t('support.noResults')} <span className="font-semibold">&ldquo;{query}&rdquo;</span>
                    </p>
                    <button
                      onClick={() => setCrystalActive(true)}
                      className="text-sm font-bold text-primary hover:underline"
                    >
                      {t('support.askCrystal')}
                    </button>
                  </div>
                )}

                {/* Quick actions (no query) */}
                {!hasQuery && (
                  <div className="px-2 py-2">
                    <div className="px-3 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/60">
                      Quick actions
                    </div>
                    {quickActions.map((action, i) => (
                      <motion.button
                        key={action.id}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.04, duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        onClick={() => handleSelect(action)}
                        className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors group"
                        style={selectedIndex === i ? { background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)' } : undefined}
                        onMouseEnter={() => setSelectedIndex(i)}
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)' }}
                        >
                          <Icon name={action.icon} size={16} style={{ color: 'var(--color-primary)' }} />
                        </div>
                        <span className="text-sm font-medium text-on-surface">{action.label}</span>
                        <Icon name="arrow_forward" size={14} className="ml-auto text-on-surface-variant/40 group-hover:text-primary transition-colors" />
                      </motion.button>
                    ))}
                  </div>
                )}

                {/* Doc results */}
                {!isLoading && hasQuery && docs.length > 0 && (
                  <div className="px-2 py-2">
                    <div className="px-3 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/60">
                      {docs.length} result{docs.length !== 1 ? 's' : ''}
                    </div>
                    {docs.map((doc, i) => (
                      <button
                        key={doc.key}
                        onClick={() => handleSelect(doc)}
                        className="w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-xl transition-colors group"
                        style={selectedIndex === i ? { background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)' } : undefined}
                        onMouseEnter={() => setSelectedIndex(i)}
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                          style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)' }}
                        >
                          <Icon name="article" size={16} style={{ color: 'var(--color-primary)' }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-on-surface truncate">{doc.title}</p>
                          {doc.excerpt && (
                            <p className="text-xs text-on-surface-variant line-clamp-1 mt-0.5">{doc.excerpt}</p>
                          )}
                          <div className="flex items-center gap-2 mt-1">
                            <span
                              className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                              style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}
                            >
                              {doc.category}
                            </span>
                            <span className="text-[10px] text-on-surface-variant/60">
                              {t('support.lastUpdated')} {new Date(doc.updated_at).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}

                    {/* Ask Crystal CTA at bottom of results */}
                    <div className="border-t border-outline-variant/20 mt-2 pt-2 px-3">
                      <button
                        onClick={() => setCrystalActive(true)}
                        className="text-sm font-bold text-primary hover:underline"
                      >
                        {t('support.askCrystal')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Keyboard nav hint */}
              {items.length > 0 && (
                <div className="flex items-center justify-end gap-2 px-4 py-2 border-t border-outline-variant/20">
                  <span className="text-[10px] text-on-surface-variant/50">
                    <kbd className="font-mono font-bold">↑↓</kbd> navigate
                    {' · '}
                    <kbd className="font-mono font-bold">↵</kbd> select
                  </span>
                </div>
              )}
            </div>

            {/* ── Right pane: doc detail or Crystal pane ──────────────── */}
            {selectedDoc && (
              <DocDetailPane
                doc={selectedDoc}
                onClose={() => setSelectedDoc(null)}
                api={api}
                query={query}
              />
            )}

            {showCrystalPane && !selectedDoc && (
              <CrystalSupportPane
                query={query}
                api={api}
                onClose={() => setCrystalActive(false)}
              />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Doc detail pane ───────────────────────────────────────────────────────────

function DocDetailPane({
  doc,
  onClose,
  api,
  query,
}: {
  doc: SupportDoc;
  onClose: () => void;
  api: ReturnType<typeof useApi>;
  query: string;
}) {
  const { t } = useTranslation();
  const [feedbackSent, setFeedbackSent] = useState(false);

  function handleFeedback(helpful: boolean) {
    setFeedbackSent(true);
    api.submitDocFeedback({ doc_key: doc.key, helpful, query }).catch(() => {});
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex-1 flex flex-col overflow-hidden"
      style={{ maxHeight: '75vh' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-outline-variant/20">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-on-surface-variant/60 uppercase tracking-wider">{doc.category}</p>
          <p className="text-sm font-semibold text-on-surface truncate">{doc.title}</p>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-muted transition-colors flex-shrink-0"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <p className="text-sm text-on-surface leading-relaxed whitespace-pre-wrap">{doc.content}</p>
        {doc.updated_at && (
          <p className="text-xs text-on-surface-variant/60 mt-4">
            {t('support.lastUpdated')} {new Date(doc.updated_at).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Feedback */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-outline-variant/20">
        {feedbackSent ? (
          <p className="text-xs text-center text-on-surface-variant">{t('support.feedbackThanks')}</p>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-xs text-on-surface-variant">{t('support.feedbackHelpful')}</span>
            <div className="flex gap-2">
              <button
                onClick={() => handleFeedback(true)}
                className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-emerald-600 transition-colors px-2 py-1 rounded-lg hover:bg-emerald-50"
              >
                <Icon name="thumb_up" size={13} />
                {t('support.feedbackThumbsUp')}
              </button>
              <button
                onClick={() => handleFeedback(false)}
                className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-red-500 transition-colors px-2 py-1 rounded-lg hover:bg-red-50"
              >
                <Icon name="thumb_down" size={13} />
                {t('support.feedbackThumbsDown')}
              </button>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Crystal support pane ──────────────────────────────────────────────────────

function CrystalSupportPane({
  query,
  api,
  onClose,
}: {
  query: string;
  api: ReturnType<typeof useApi>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(false);
  const lastQuery = useRef('');

  useEffect(() => {
    if (!query || query === lastQuery.current) return;
    lastQuery.current = query;
    setIsLoading(true);
    setError(false);
    setAnswer(null);

    api.crystalSupport(query).then((resp) => {
      setAnswer(resp.answer);
    }).catch(() => {
      setError(true);
    }).finally(() => {
      setIsLoading(false);
    });
  }, [query, api]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex-1 flex flex-col overflow-hidden"
      style={{ maxHeight: '75vh' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-outline-variant/20">
        <div
          className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}
        >
          <Icon name="diamond" size={12} style={{ color: 'white' }} />
        </div>
        <span className="text-sm font-semibold text-on-surface flex-1">Crystal · Support</span>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-muted transition-colors flex-shrink-0"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {isLoading && (
          <div className="space-y-2">
            <div className="skeleton h-4 rounded w-3/4" />
            <div className="skeleton h-4 rounded w-full" />
            <div className="skeleton h-4 rounded w-2/3" />
          </div>
        )}
        {error && (
          <p className="text-sm text-on-surface-variant">Crystal support is unavailable. Try a doc search instead.</p>
        )}
        {answer && (
          <p className="text-sm text-on-surface leading-relaxed">{answer}</p>
        )}
      </div>

      <div className="flex-shrink-0 px-4 py-2.5 border-t border-outline-variant/20">
        <p className="text-[10px] text-on-surface-variant/60 text-center">
          {t('support.askCrystal').replace(' →', '')} · {t('support.cmdkPlaceholder')}
        </p>
      </div>
    </motion.div>
  );
}
