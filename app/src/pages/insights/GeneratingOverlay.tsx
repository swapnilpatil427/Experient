import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '../../components/Icon';
import { GlassCard } from './shared';
import { useTranslation } from '../../lib/i18n';
import type { Survey } from '../../types';

interface PipelineNode {
  id: string;
  label: string;
  icon: string;
}

interface GeneratingOverlayProps {
  generating: boolean;
  nodesDone: string[];
  genError?: string | null;
  nodes: readonly PipelineNode[];
  focusSurvey?: Survey;
  onRetry?: () => void;
}

export function GeneratingOverlay({
  generating,
  nodesDone,
  genError,
  nodes,
  focusSurvey,
  onRetry,
}: GeneratingOverlayProps) {
  const { t } = useTranslation();
  const activeNodeIdx = nodesDone.length < nodes.length ? nodesDone.length : -1;

  return (
    <AnimatePresence>
      {(generating || genError) && (
        <motion.div
          key="gen-overlay"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <GlassCard className="p-8 text-center border-2 border-primary/20">
            <div className="flex justify-center mb-6">
              <div className="relative w-20 h-20">
                <div
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: genError
                      ? 'linear-gradient(135deg, #dc2626, #b91c1c)'
                      : 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
                    animation: genError ? undefined : 'pulse-glow 2s ease-in-out infinite',
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Icon name={genError ? 'error' : 'psychology'} size={32} style={{ color: 'white' }} />
                </div>
              </div>
            </div>

            {genError ? (
              <div className="space-y-3">
                <h3 className="text-lg font-black font-headline text-red-600">{t('insights.generate.errorHeading')}</h3>
                <p className="text-sm text-muted-foreground">{genError}</p>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="text-xs font-bold px-4 py-2 rounded-full bg-primary text-white hover:opacity-90 transition-opacity"
                  >
                    {t('common.retry')}
                  </button>
                )}
              </div>
            ) : (
              <>
                <h3 className="text-xl font-black font-headline mb-1">
                  Generating insights
                  {focusSurvey && <span className="text-primary"> · {focusSurvey.title}</span>}
                </h3>
                <p className="text-sm text-on-surface-variant mb-8">
                  Crystal is analyzing {(focusSurvey?.response_count ?? 0).toLocaleString()} responses
                  through the full intelligence pipeline.
                </p>

                <div className="flex flex-wrap justify-center gap-2 max-w-2xl mx-auto mb-4">
                  {nodes.map((node, idx) => {
                    const done = nodesDone.includes(node.id);
                    const active = idx === activeNodeIdx;
                    return (
                      <motion.div
                        key={node.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.04 }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-300"
                        style={
                          done
                            ? { background: '#d1fae5', borderColor: '#059669', color: '#047857' }
                            : active
                            ? { background: '#eff2ff', borderColor: 'var(--color-primary)', color: 'var(--color-primary)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-primary) 15%, transparent)' }
                            : { background: 'var(--color-surface-container)', borderColor: 'var(--color-outline-variant)', color: 'var(--color-on-surface-variant)' }
                        }
                      >
                        <Icon
                          name={done ? 'check_circle' : node.icon}
                          size={13}
                          style={active ? { animation: 'spin 1.5s linear infinite' } : undefined}
                        />
                        {node.label}
                      </motion.div>
                    );
                  })}
                </div>

                <p className="text-xs text-on-surface-variant">
                  {nodesDone.length} of {nodes.length} stages complete · Usually takes 30–90s
                </p>
              </>
            )}
          </GlassCard>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
