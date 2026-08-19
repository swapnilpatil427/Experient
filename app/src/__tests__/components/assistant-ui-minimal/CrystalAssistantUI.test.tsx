import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock useApi before importing anything that transitively uses it.
vi.mock('../../../hooks/useApi', () => ({
  useApi: vi.fn(),
  default: vi.fn(),
}));

import { useApi } from '../../../hooks/useApi';
import { CrystalAssistantUI } from '../../../components/assistant-ui-minimal/CrystalAssistantUI';

const mockCrystalChat2 = vi.fn();
const mockApi = { crystalChat2: mockCrystalChat2 };

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(useApi).mockReturnValue(mockApi as unknown as ReturnType<typeof useApi>);
  mockCrystalChat2.mockResolvedValue({ answer: 'Hello from Crystal', suggestions: [], insight_refs: [], citations: [] });
});

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('CrystalAssistantUI — renders the assistant-ui primitives without crashing', () => {
  it('renders the composer input and the "New thread" button', () => {
    render(<CrystalAssistantUI surveyId="survey-1" />);
    expect(screen.getByPlaceholderText('Message Crystal…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New thread/i })).toBeInTheDocument();
  });

  it('shows the empty-thread state when the current thread has no messages', () => {
    render(<CrystalAssistantUI surveyId="survey-1" />);
    expect(screen.getByText('Ask Crystal anything')).toBeInTheDocument();
  });

  it('typing and sending a message calls crystalChat2 with the composer text', async () => {
    const user = userEvent.setup();
    render(<CrystalAssistantUI surveyId="survey-1" focusedTopic="Wait Time" />);

    const input = screen.getByPlaceholderText('Message Crystal…');
    await user.type(input, 'What is our NPS?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(mockCrystalChat2).toHaveBeenCalledWith('What is our NPS?', {
      surveyId: 'survey-1',
      focusedTopic: 'Wait Time',
      conversationHistory: [],
    });
  });

  it('renders the sent user message and the assistant reply in the thread', async () => {
    const user = userEvent.setup();
    render(<CrystalAssistantUI surveyId="survey-1" />);

    const input = screen.getByPlaceholderText('Message Crystal…');
    await user.type(input, 'Hi Crystal');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Hi Crystal')).toBeInTheDocument();
    expect(await screen.findByText('Hello from Crystal')).toBeInTheDocument();
  });

  it('creating a new thread clears the composer back to the empty state', async () => {
    const user = userEvent.setup();
    render(<CrystalAssistantUI surveyId="survey-1" />);

    const input = screen.getByPlaceholderText('Message Crystal…');
    await user.type(input, 'First thread message');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('First thread message');

    await user.click(screen.getByRole('button', { name: /New thread/i }));

    expect(screen.getByText('Ask Crystal anything')).toBeInTheDocument();
    expect(screen.queryByText('First thread message')).not.toBeInTheDocument();
  });
});
