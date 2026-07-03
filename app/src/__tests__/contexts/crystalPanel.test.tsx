import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach } from 'vitest';
import { CrystalPanelProvider, useCrystalPanel } from '../../contexts/crystalPanel';

afterEach(cleanup);

// A tiny probe component that surfaces context state as text/attributes so
// tests can assert on it without needing the real CrystalPanel component.
function Probe() {
  const {
    scope, builderContext, builderDraft, builderDraftHydrator,
    setScope, setBuilderContext, setBuilderDraft, setBuilderDraftHydrator,
  } = useCrystalPanel();

  return (
    <div>
      <span data-testid="scope">{typeof scope === 'string' ? scope : JSON.stringify(scope)}</span>
      <span data-testid="builder-context">{builderContext ? builderContext.kind : 'null'}</span>
      <span data-testid="builder-draft">{builderDraft ? builderDraft.mode : 'null'}</span>
      <span data-testid="hydrator-type">{typeof builderDraftHydrator}</span>
      <span data-testid="hydrator-result">
        {builderDraftHydrator ? String(builderDraftHydrator({ id: 'p', type: 'create_workflow', priority: 'medium', title: 't', description: 'd', params: {}, requires_confirmation: true })) : 'none'}
      </span>
      <button onClick={() => setScope('survey-1')}>set scope</button>
      <button onClick={() => setBuilderContext({ kind: 'workflow_builder' })}>set builder context</button>
      <button onClick={() => setBuilderContext(null)}>clear builder context</button>
      <button onClick={() => setBuilderDraft({
        mode: 'sentence', scopeSelection: { scopeType: 'org' }, conditionClauses: [], actions: [], workflowName: 'wf', isEditMode: false,
      })}>
        set builder draft
      </button>
      <button onClick={() => setBuilderDraftHydrator(() => true)}>register hydrator (returns true)</button>
      <button onClick={() => setBuilderDraftHydrator(() => false)}>register hydrator (returns false)</button>
      <button onClick={() => setBuilderDraftHydrator(null)}>clear hydrator</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <CrystalPanelProvider>
      <Probe />
    </CrystalPanelProvider>,
  );
}

describe('CrystalPanelContext — Wave 14 additive fields', () => {
  it('defaults builderContext/builderDraft/builderDraftHydrator to null, leaving the existing scope contract untouched', () => {
    renderProbe();
    expect(screen.getByTestId('scope')).toHaveTextContent('all');
    expect(screen.getByTestId('builder-context')).toHaveTextContent('null');
    expect(screen.getByTestId('builder-draft')).toHaveTextContent('null');
    expect(screen.getByTestId('hydrator-type')).toHaveTextContent('object'); // null is typeof 'object'
  });

  it('setScope continues to work exactly as before (existing survey-scoped callers unaffected)', async () => {
    renderProbe();
    const user = userEvent.setup();
    await user.click(screen.getByText('set scope'));
    expect(screen.getByTestId('scope')).toHaveTextContent('survey-1');
  });

  it('setBuilderContext/setBuilderDraft set and clear independently of scope', async () => {
    renderProbe();
    const user = userEvent.setup();

    await user.click(screen.getByText('set builder context'));
    expect(screen.getByTestId('builder-context')).toHaveTextContent('workflow_builder');
    // scope is untouched by builder-context changes — orthogonal flag.
    expect(screen.getByTestId('scope')).toHaveTextContent('all');

    await user.click(screen.getByText('set builder draft'));
    expect(screen.getByTestId('builder-draft')).toHaveTextContent('sentence');

    await user.click(screen.getByText('clear builder context'));
    expect(screen.getByTestId('builder-context')).toHaveTextContent('null');
  });

  it('setBuilderDraftHydrator stores the passed function itself, not the result of invoking it as a state updater', async () => {
    // Regression guard: React's useState setter treats a bare function
    // argument as `(prev) => next`. A naive `setBuilderDraftHydrator(fn)`
    // implementation would invoke `fn` immediately (with the previous
    // hydrator as its argument) instead of storing `fn` — this test fails
    // loudly if that regresses.
    renderProbe();
    const user = userEvent.setup();

    await user.click(screen.getByText('register hydrator (returns true)'));
    expect(screen.getByTestId('hydrator-type')).toHaveTextContent('function');
    expect(screen.getByTestId('hydrator-result')).toHaveTextContent('true');

    await user.click(screen.getByText('register hydrator (returns false)'));
    expect(screen.getByTestId('hydrator-result')).toHaveTextContent('false');

    await user.click(screen.getByText('clear hydrator'));
    expect(screen.getByTestId('hydrator-result')).toHaveTextContent('none');
  });
});
