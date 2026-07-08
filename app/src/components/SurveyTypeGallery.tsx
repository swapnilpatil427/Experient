import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { SURVEY_CATEGORIES } from '../constants/surveyTypes';
import { ROUTES } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { Template } from '../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TypeCardProps {
  type: Template;
  selected: string | null | undefined;
  onSelect: (id: string | null) => void;
}

export interface SurveyTypeGalleryProps {
  templates?: Template[];
  isLoading?: boolean;
  selectedTypeId?: string | null;
  onSelect: (id: string | null) => void;
  onContinue: () => void;
  onSkip: () => void;
  continueLabel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// TypeCard sub-component
// ─────────────────────────────────────────────────────────────────────────────

function TypeCard({ type, selected, onSelect }: TypeCardProps) {
  const isSelected = selected === type.id;
  return (
    <button
      onClick={() => onSelect(isSelected ? null : type.id)}
      className="relative flex flex-col items-start text-left rounded-2xl p-5 transition-all duration-200 active:scale-95"
      style={{
        background: isSelected ? type.bg : '#ffffff',
        border: isSelected ? `2px solid ${type.color}` : '1.5px solid #eef1f3',
        boxShadow: isSelected
          ? `0 12px 32px -8px ${type.color}33`
          : '0 2px 12px rgba(0,0,0,0.04)',
        cursor: 'pointer',
        outline: 'none',
        minHeight: '200px',
      }}
    >
      {/* Checkmark overlay */}
      {isSelected && (
        <div className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center"
          style={{ background: type.color }}>
          <Icon name="check" size={14} className="text-white" />
        </div>
      )}

      {/* Popular badge */}
      {type.recommended && !isSelected && (
        <Badge
          variant="outline"
          className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest border-0"
          style={{ background: (type.color ?? '') + '18', color: type.color }}
        >
          Popular
        </Badge>
      )}

      {/* Icon */}
      <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-3 flex-shrink-0"
        style={{ background: isSelected ? type.color : type.bg, color: isSelected ? '#ffffff' : type.color }}>
        <Icon name={type.icon ?? 'poll'} fill={1} size={22} />
      </div>

      {/* Name + short label */}
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="text-sm font-extrabold font-headline leading-tight text-on-surface">
          {type.label}
        </span>
        <span className="text-[10px] font-black px-2 py-0.5 rounded-full flex-shrink-0"
          style={{ background: (type.color ?? '') + '1a', color: type.color }}>
          {type.shortLabel}
        </span>
      </div>

      {/* Description — 2-line clamp */}
      <p className="text-xs leading-relaxed mb-3 flex-1 text-on-surface-variant"
        style={{
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
          overflow: 'hidden',
        }}>
        {type.description}
      </p>

      {/* Footer row */}
      <div className="flex items-center justify-between w-full mt-auto">
        <div className="flex items-center gap-1.5 flex-wrap">
          {(type.metrics ?? []).slice(0, 2).map((m) => (
            <span key={m} className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {m}
            </span>
          ))}
        </div>
        <span className="text-[10px] font-semibold flex items-center gap-1 flex-shrink-0 text-muted-foreground">
          <Icon name="schedule" size={12} />
          {type.estimatedMinutes}m
        </span>
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function SurveyTypeGallery({ templates = [], isLoading = false, selectedTypeId, onSelect, onContinue, onSkip, continueLabel }: SurveyTypeGalleryProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [catSearch, setCatSearch] = useState('');

  const templateMap = useMemo(
    () => Object.fromEntries(templates.map((tmpl) => [tmpl.id, tmpl])),
    [templates],
  );

  // Templates matching the text search only (used for category hit-counts)
  const searchFiltered = useMemo(() => {
    if (!search.trim()) return templates;
    const q = search.toLowerCase();
    return templates.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        (s.shortLabel || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q) ||
        (s.tags || []).some((tag) => tag.includes(q)),
    );
  }, [templates, search]);

  const filtered = useMemo(() => {
    const list = activeCategory === 'all' ? searchFiltered : searchFiltered.filter((s) => s.category === activeCategory);
    return list;
  }, [searchFiltered, activeCategory]);

  // Visible categories after the category-search filter
  const visibleCategories = useMemo(() => {
    if (!catSearch.trim()) return SURVEY_CATEGORIES;
    const q = catSearch.toLowerCase();
    return SURVEY_CATEGORIES.filter(
      (c) => c.id === 'all' || c.label.toLowerCase().includes(q) || c.shortLabel.toLowerCase().includes(q),
    );
  }, [catSearch]);

  const selectedType = selectedTypeId ? (templateMap[selectedTypeId] ?? null) : null;

  return (
    <div className="w-full max-w-5xl pb-32">
      {/* Heading */}
      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg bg-gradient-primary"
          style={{ transform: 'rotate(-3deg)' }}>
          <Icon name="category" fill={1} size={28} className="text-white" />
        </div>
        <h1 className="text-3xl font-extrabold tracking-tighter mb-2 font-headline text-on-surface">
          {t('create.typeGallery.heading')}
        </h1>
        <p className="text-sm text-on-surface-variant max-w-md mx-auto mb-3">
          {t('create.typeGallery.description')}
        </p>
        <button
          onClick={() => navigate(ROUTES.TEMPLATES)}
          className="text-xs font-bold text-primary hover:underline flex items-center gap-1 mx-auto"
        >
          <Icon name="library_books" size={13} />
          {t('create.typeGallery.manageTemplates')}
        </button>
      </div>

      {/* Search + category filters */}
      <div className="flex flex-col gap-4 mb-6">
        {/* Search input */}
        <div className="relative">
          <Icon name="search" size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
          <Input
            type="text"
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            placeholder={t('create.typeGallery.searchPlaceholder')}
            className="w-full pl-11 pr-10 py-3 text-sm rounded-xl bg-white text-on-surface font-body"
            style={{ border: '1.5px solid #eef1f3', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          />
          {search && (
            <Button
              onClick={() => setSearch('')}
              variant="ghost"
              size="icon"
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-full w-auto h-auto text-muted-foreground"
            >
              <Icon name="close" size={16} />
            </Button>
          )}
        </div>

        {/* Category filter input */}
        <div className="relative">
          <Icon name="filter_list" size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
          <input
            type="text"
            value={catSearch}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCatSearch(e.target.value)}
            placeholder={t('templates.categoryFilterPlaceholder')}
            className="w-full pl-8 pr-8 py-2 text-xs rounded-xl text-on-surface font-body outline-none"
            style={{ background: '#f5f6f7', border: '1px solid #eef1f3' }}
          />
          {catSearch && (
            <button
              onClick={() => setCatSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"
            >
              <Icon name="close" size={13} />
            </button>
          )}
        </div>

        {/* Category pill tabs */}
        <div className="flex gap-2 overflow-x-auto pb-1"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {visibleCategories.map((cat) => {
            const isActive = activeCategory === cat.id;
            const matchCount = cat.id === 'all'
              ? searchFiltered.length
              : searchFiltered.filter((s) => s.category === cat.id).length;
            const isZero = cat.id !== 'all' && !!search.trim() && matchCount === 0;
            return (
              <button
                key={cat.id}
                onClick={() => !isZero && setActiveCategory(cat.id)}
                disabled={isZero}
                className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold transition-all flex-shrink-0"
                style={{
                  background: isActive ? cat.color : '#ffffff',
                  color: isActive ? '#ffffff' : '#595c5e',
                  border: isActive ? `1.5px solid ${cat.color}` : '1.5px solid #eef1f3',
                  boxShadow: isActive ? `0 4px 12px ${cat.color}33` : 'none',
                  opacity: isZero ? 0.3 : 1,
                  cursor: isZero ? 'not-allowed' : 'pointer',
                }}
              >
                <span style={{ color: isActive ? '#ffffff' : cat.color, display: 'flex' }}>
                  <Icon name={cat.icon} size={14} />
                </span>
                {cat.shortLabel}
                <span className="text-[10px] opacity-70 ml-0.5">({matchCount})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Card grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20 gap-3 text-on-surface-variant">
          <div className="w-5 h-5 rounded-full border-2 animate-spin"
            style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
          <span className="text-sm font-semibold">{t('common.loading')}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-surface-container">
            <Icon name="search_off" size={28} className="text-on-surface-variant" />
          </div>
          <p className="text-sm font-semibold text-on-surface-variant">
            {t('create.typeGallery.noResults')}
          </p>
          <Button
            onClick={() => setSearch('')}
            variant="secondary"
            size="sm"
            className="text-xs font-bold px-4 py-2 rounded-full"
            style={{ background: '#e0e7ff', color: 'var(--color-primary)' }}
          >
            {t('create.typeGallery.clearSearch')}
          </Button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
          {/* Blank / custom survey — always first */}
          <button
            onClick={onSkip}
            className="relative flex flex-col items-start text-left rounded-2xl p-5 transition-all duration-200 active:scale-95"
            style={{
              background: '#ffffff',
              border: '1.5px solid #eef1f3',
              boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
              cursor: 'pointer',
              outline: 'none',
              minHeight: '200px',
            }}
          >
            <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-3 flex-shrink-0"
              style={{ background: '#f0f2f4', color: '#747779' }}>
              <Icon name="grid_view" fill={1} size={22} />
            </div>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-sm font-extrabold font-headline leading-tight text-on-surface">
                {t('create.typeGallery.blankCard.title')}
              </span>
              <span className="text-[10px] font-black px-2 py-0.5 rounded-full flex-shrink-0"
                style={{ background: '#e5e9eb', color: '#747779' }}>
                {t('create.typeGallery.blankCard.badge')}
              </span>
            </div>
            <p className="text-xs leading-relaxed mb-3 flex-1 text-on-surface-variant"
              style={{
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
                overflow: 'hidden',
              }}>
              {t('create.typeGallery.blankCard.description')}
            </p>
            <div className="flex items-center justify-between w-full mt-auto">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {t('create.typeGallery.blankCard.fullyCustom')}
                </span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {t('create.typeGallery.blankCard.anyMetrics')}
                </span>
              </div>
              <span className="text-[10px] font-semibold flex items-center gap-1 flex-shrink-0 text-muted-foreground">
                <Icon name="schedule" size={12} />
                0m
              </span>
            </div>
          </button>

          {filtered.map((type) => (
            <TypeCard
              key={type.id}
              type={type}
              selected={selectedTypeId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {/* Sticky action bar — slides up when a type is selected */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 transition-all duration-300"
        style={{
          transform: selectedType ? 'translateY(0)' : 'translateY(100%)',
          pointerEvents: selectedType ? 'auto' : 'none',
        }}
      >
        <div className="glass-nav border-t"
          style={{ borderColor: '#eef1f3', boxShadow: '0 -8px 32px rgba(31,38,135,0.10)' }}>
          <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
            {selectedType && (
              <>
                {/* Type summary */}
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: selectedType.bg, color: selectedType.color }}>
                    <Icon name={selectedType.icon ?? 'poll'} fill={1} size={20} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-extrabold font-headline text-on-surface truncate">
                        {selectedType.label}
                      </span>
                      <span className="text-[10px] font-black px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: (selectedType.color ?? '') + '1a', color: selectedType.color }}>
                        {selectedType.shortLabel}
                      </span>
                    </div>
                    <p className="text-xs text-on-surface-variant truncate">
                      {selectedType.estimatedMinutes} min · {selectedType.questionCount} questions
                    </p>
                  </div>
                </div>

                {/* Metric chips — hidden on mobile */}
                <div className="hidden md:flex gap-2 flex-shrink-0">
                  {(selectedType.metrics ?? []).slice(0, 3).map((m) => (
                    <span key={m} className="text-xs font-bold px-3 py-1.5 rounded-full"
                      style={{ background: (selectedType.color ?? '') + '18', color: selectedType.color }}>
                      {m}
                    </span>
                  ))}
                </div>

                {/* CTA */}
                <Button
                  onClick={onContinue}
                  className="flex items-center gap-2 px-6 py-3 text-white font-bold text-sm active:scale-95 rounded-xl flex-shrink-0 cta-glow"
                  style={{ background: selectedType.color, boxShadow: `0 12px 28px -6px ${selectedType.color}55` }}
                >
                  <Icon name="arrow_forward" size={18} />
                  {continueLabel ?? t('create.typeGallery.continueButton')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
