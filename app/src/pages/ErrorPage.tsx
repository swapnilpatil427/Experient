import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '../lib/i18n';
import { ROUTES } from '../constants/routes';

type ErrorType = 'not-found' | 'unauthorized' | 'server-error';

interface ErrorPageProps {
  type?: ErrorType;
  onRetry?: () => void;
}

const ERROR_CONFIG: Record<ErrorType, { icon: string; color: string; bg: string }> = {
  'not-found':    { icon: 'search_off',    color: '#2a4bd9', bg: '#e0e7ff' },
  unauthorized:   { icon: 'lock',          color: '#7c3aed', bg: '#ede9fe' },
  'server-error': { icon: 'error_outline', color: '#dc2626', bg: '#fee2e2' },
};

export function ErrorPage({ type = 'not-found', onRetry }: ErrorPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const cfg = ERROR_CONFIG[type] || ERROR_CONFIG['not-found'];
  const key = type === 'not-found' ? 'notFound' : type === 'unauthorized' ? 'unauthorized' : 'serverError';
  const isServerError = type === 'server-error';

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: `radial-gradient(circle at 50% 30%, ${cfg.bg} 0%, #f5f7f9 70%)` }}
    >
      <div className="text-center max-w-md">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg"
          style={{ background: `${cfg.color}18`, border: `1px solid ${cfg.color}28` }}
        >
          <Icon name={cfg.icon} size={40} style={{ color: cfg.color }} />
        </div>
        <h1 className="text-3xl font-extrabold tracking-tighter mb-3 font-headline text-on-surface">
          {t(`errors.${key}.heading`)}
        </h1>
        <p className="text-base leading-relaxed mb-8 text-on-surface-variant">
          {t(`errors.${key}.description`)}
        </p>
        <div className="flex gap-3 justify-center">
          {isServerError && onRetry && (
            <Button
              onClick={onRetry}
              className="rounded-xl font-bold px-6"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: '#fff', border: 'none' }}
            >
              {t('errors.serverError.action')}
            </Button>
          )}
          <Button
            variant={isServerError && onRetry ? 'outline' : 'default'}
            onClick={() => navigate(type === 'unauthorized' ? ROUTES.SIGNIN : ROUTES.LANDING)}
            className="rounded-xl font-bold px-6"
            style={!(isServerError && onRetry) ? { background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: '#fff', border: 'none' } : {}}
          >
            {isServerError ? t('errors.serverError.actionAlt') : t(`errors.${key}.action`)}
          </Button>
        </div>
      </div>
    </div>
  );
}
