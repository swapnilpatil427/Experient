import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { InsightSettings } from '../../../types';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k}:${JSON.stringify(opts)}` : k),
  }),
}));

vi.mock('../../../components/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock('../../../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock('../../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../../hooks/useApi', () => ({ useApi: vi.fn() }));
vi.mock('../../../lib/auth', () => ({ useAppAuth: () => ({ orgId: 'org1', getToken: vi.fn() }) }));
vi.mock('../../../lib/permissions', () => ({ usePermissions: vi.fn() }));

import { useApi } from '../../../hooks/useApi';
import { usePermissions } from '../../../lib/permissions';
import { InsightSettingsPage } from '../../../pages/insights/InsightSettingsPage';

const baseEffective: Record<string, unknown> = {
  automated_insights_enabled: true,
  automated_report_generation_enabled: true,
  stream_response_threshold: 10,
  response_tagging_batch_size: 1,
  topic_discovery_candidate_threshold: 10,
  topic_discovery_min_cluster_size: 5,
  report_regen_threshold: 25,
  prior_checkpoint_lookback: 5,
  prior_checkpoint_max_age_days: 90,
  full_checkpoint_response_threshold: 200,
  meaningful_delta_nps_points: 2,
  meaningful_delta_topic_pct: 10,
  refresh_lookback_days: 30,
  refresh_min_response_count: 25,
  refresh_daily_limit: 5,
  manual_daily_run_limit: 10,
  manual_expert_full_corpus_cap: 500,
  manual_expert_max_corpus: 2000,
  manual_expert_snapshot_count: 5,
  manual_expert_checkpoint_lookback: 3,
  manual_quick_sample_cap: 150,
  manual_quick_default_window_days: 14,
  custom_analysis_enabled: true,
  custom_analysis_daily_limit: 3,
  custom_analysis_max_corpus: 5000,
  custom_analysis_min_n_for_nps: 30,
  credit_cost_automated: 5,
  credit_cost_report: 15,
  credit_cost_refresh: 8,
  credit_cost_quick: 15,
  credit_cost_expert: 40,
  credit_cost_custom: 25,
  automated_checkpoint_retention_days: 365,
  collapse_similar_checkpoints: true,
  manual_report_retention_days: 730,
};

function settings(overrides: Partial<InsightSettings> = {}): InsightSettings {
  return {
    survey_id: 's1',
    effective: baseEffective,
    survey_overrides: { stream_response_threshold: 10 }, // one survey-level override
    org_defaults: { prior_checkpoint_lookback: 5 },
    config_hash: 'abc',
    config_version: 1,
    editable: true,
    ...overrides,
  };
}

function buildApi(overrides: Record<string, unknown> = {}) {
  return {
    getInsightSettings: vi.fn().mockResolvedValue(settings()),
    updateInsightSettings: vi.fn().mockResolvedValue({ survey_overrides: {}, config_version: 2, config_hash: 'def' }),
    getOrgInsightDefaults: vi.fn().mockResolvedValue({ org_id: 'org1', defaults: {}, updated_at: null, updated_by: null }),
    updateOrgInsightDefaults: vi.fn().mockResolvedValue({ org_id: 'org1', defaults: {}, updated_at: null, updated_by: null }),
    ...overrides,
  } as unknown as ReturnType<typeof useApi>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/surveys/s1/intelligence/settings']}>
      <Routes>
        <Route path="/app/surveys/:surveyId/intelligence/settings" element={<InsightSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useApi).mockReturnValue(buildApi());
  vi.mocked(usePermissions).mockReturnValue({
    role: 'org:admin', isAdmin: true, isAnalyst: true, isViewer: true, can: () => true,
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('InsightSettingsPage', () => {
  it('renders all six section titles after loading', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('surveyInsights.settings.sectionAutomated')).toBeInTheDocument();
    });
    for (const s of ['sectionRefresh', 'sectionManual', 'sectionCustom', 'sectionCredits', 'sectionRetention']) {
      expect(screen.getByText(`surveyInsights.settings.${s}`)).toBeInTheDocument();
    }
  });

  it('admin sees enabled inputs and can save only the changed keys', async () => {
    const api = buildApi();
    vi.mocked(useApi).mockReturnValue(api);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.streamResponseThreshold');
    expect(input).not.toBeDisabled();
    await user.clear(input);
    await user.type(input, '15');

    const save = screen.getByRole('button', { name: 'surveyInsights.settings.save' });
    await waitFor(() => expect(save).not.toBeDisabled());
    await user.click(save);

    await waitFor(() => expect(vi.mocked(api.updateInsightSettings)).toHaveBeenCalled());
    const [sid, patch] = vi.mocked(api.updateInsightSettings).mock.calls[0];
    expect(sid).toBe('s1');
    // Only the changed key is sent — not the entire settings object.
    expect(patch).toEqual({ stream_response_threshold: 15 });
  });

  it('admin can edit response_tagging_batch_size independently of stream_response_threshold', async () => {
    const api = buildApi();
    vi.mocked(useApi).mockReturnValue(api);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.responseTaggingBatchSize');
    expect(input).not.toBeDisabled();
    await user.clear(input);
    await user.type(input, '5');

    const save = screen.getByRole('button', { name: 'surveyInsights.settings.save' });
    await waitFor(() => expect(save).not.toBeDisabled());
    await user.click(save);

    await waitFor(() => expect(vi.mocked(api.updateInsightSettings)).toHaveBeenCalled());
    const [, patch] = vi.mocked(api.updateInsightSettings).mock.calls[0];
    // Only the changed key is sent — stream_response_threshold (the full-report
    // trigger) is untouched even though both fields live in the same section.
    expect(patch).toEqual({ response_tagging_batch_size: 5 });
  });

  it('rejects response_tagging_batch_size above 10', async () => {
    const api = buildApi();
    vi.mocked(useApi).mockReturnValue(api);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.responseTaggingBatchSize');
    await user.clear(input);
    await user.type(input, '11');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const save = screen.getByRole('button', { name: 'surveyInsights.settings.save' });
    expect(save).toBeDisabled();
    expect(vi.mocked(api.updateInsightSettings)).not.toHaveBeenCalled();
  });

  it('admin can edit topic_discovery_candidate_threshold', async () => {
    const api = buildApi();
    vi.mocked(useApi).mockReturnValue(api);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.topicDiscoveryCandidateThreshold');
    expect(input).not.toBeDisabled();
    await user.clear(input);
    await user.type(input, '30');

    const save = screen.getByRole('button', { name: 'surveyInsights.settings.save' });
    await waitFor(() => expect(save).not.toBeDisabled());
    await user.click(save);

    await waitFor(() => expect(vi.mocked(api.updateInsightSettings)).toHaveBeenCalled());
    const [, patch] = vi.mocked(api.updateInsightSettings).mock.calls[0];
    expect(patch).toEqual({ topic_discovery_candidate_threshold: 30 });
  });

  it('rejects topic_discovery_candidate_threshold below 5', async () => {
    const api = buildApi();
    vi.mocked(useApi).mockReturnValue(api);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.topicDiscoveryCandidateThreshold');
    await user.clear(input);
    await user.type(input, '4');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const save = screen.getByRole('button', { name: 'surveyInsights.settings.save' });
    expect(save).toBeDisabled();
    expect(vi.mocked(api.updateInsightSettings)).not.toHaveBeenCalled();
  });

  it('admin can edit topic_discovery_min_cluster_size independently', async () => {
    const api = buildApi();
    vi.mocked(useApi).mockReturnValue(api);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.topicDiscoveryMinClusterSize');
    expect(input).not.toBeDisabled();
    await user.clear(input);
    await user.type(input, '8');

    const save = screen.getByRole('button', { name: 'surveyInsights.settings.save' });
    await waitFor(() => expect(save).not.toBeDisabled());
    await user.click(save);

    await waitFor(() => expect(vi.mocked(api.updateInsightSettings)).toHaveBeenCalled());
    const [, patch] = vi.mocked(api.updateInsightSettings).mock.calls[0];
    expect(patch).toEqual({ topic_discovery_min_cluster_size: 8 });
  });

  it('rejects topic_discovery_min_cluster_size above 20', async () => {
    const api = buildApi();
    vi.mocked(useApi).mockReturnValue(api);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.topicDiscoveryMinClusterSize');
    await user.clear(input);
    await user.type(input, '21');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const save = screen.getByRole('button', { name: 'surveyInsights.settings.save' });
    expect(save).toBeDisabled();
    expect(vi.mocked(api.updateInsightSettings)).not.toHaveBeenCalled();
  });

  it('shows a validation error and blocks save when a value is out of range', async () => {
    const api = buildApi();
    vi.mocked(useApi).mockReturnValue(api);
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.priorCheckpointLookback'); // range 1–20
    await user.clear(input);
    await user.type(input, '99');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const save = screen.getByRole('button', { name: 'surveyInsights.settings.save' });
    expect(save).toBeDisabled();
    expect(vi.mocked(api.updateInsightSettings)).not.toHaveBeenCalled();
  });

  it('viewer / non-editor sees a lock hint and disabled inputs (no save bar)', async () => {
    vi.mocked(usePermissions).mockReturnValue({
      role: 'org:viewer', isAdmin: false, isAnalyst: false, isViewer: true, can: () => false,
    });
    vi.mocked(useApi).mockReturnValue(buildApi({
      getInsightSettings: vi.fn().mockResolvedValue(settings({ editable: false })),
    }));
    renderPage();

    const input = await screen.findByLabelText('surveyInsights.settings.streamResponseThreshold');
    expect(input).toBeDisabled();
    expect(screen.getByText(/surveyInsights\.settings\.lockHint/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'surveyInsights.settings.save' })).toBeNull();
  });
});
