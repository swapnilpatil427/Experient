import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagBadge } from '../../components/TagBadge';
import type { SurveyTag } from '../../lib/api';

afterEach(cleanup);

const baseTag: SurveyTag = {
  id: 'tag-1',
  name: 'Customer',
  slug: 'customer',
  color: '#6366f1',
  created_at: '2026-01-01',
};

describe('TagBadge', () => {
  it('renders the tag name', () => {
    render(<TagBadge tag={baseTag} />);
    expect(screen.getByText('Customer')).toBeInTheDocument();
  });

  it('renders a colored dot with background matching tag.color', () => {
    const { container } = render(<TagBadge tag={baseTag} />);
    // spans[0] = outer badge, spans[1] = colored dot, spans[2] = name truncate span
    const dot = container.querySelectorAll('span')[1];
    // jsdom normalises #6366f1 → rgb(99, 102, 241) in computed styles
    expect(dot.getAttribute('style')).toContain('99, 102, 241');
  });

  it('applies background, color, and border styles based on tag.color', () => {
    const { container } = render(<TagBadge tag={baseTag} />);
    const badge = container.querySelector('span')!;
    const rawStyle = badge.getAttribute('style') ?? '';
    // jsdom normalises #6366f1 → rgb(99, 102, 241); all color variants share this base
    expect(rawStyle).toContain('99, 102, 241');
    expect(rawStyle).toContain('border');
  });

  it('size="sm" applies text-xs and smaller padding classes', () => {
    const { container } = render(<TagBadge tag={baseTag} size="sm" />);
    const badge = container.querySelector('span')!;
    expect(badge.className).toMatch(/text-xs/);
    expect(badge.className).toMatch(/px-2\b/);
    expect(badge.className).toMatch(/py-0\.5/);
  });

  it('size="md" (default) applies text-sm and larger padding classes', () => {
    const { container } = render(<TagBadge tag={baseTag} size="md" />);
    const badge = container.querySelector('span')!;
    expect(badge.className).toMatch(/text-sm/);
    expect(badge.className).toMatch(/px-2\.5/);
    expect(badge.className).toMatch(/py-1\b/);
  });

  it('size="sm" uses a smaller dot (w-1.5 h-1.5) than size="md" (w-2 h-2)', () => {
    const { container: smContainer } = render(<TagBadge tag={baseTag} size="sm" />);
    const { container: mdContainer } = render(<TagBadge tag={baseTag} size="md" />);
    const smDot = smContainer.querySelectorAll('span')[1];
    const mdDot = mdContainer.querySelectorAll('span')[1];
    expect(smDot.className).toMatch(/w-1\.5/);
    expect(smDot.className).toMatch(/h-1\.5/);
    expect(mdDot.className).toMatch(/\bw-2\b/);
    expect(mdDot.className).toMatch(/\bh-2\b/);
  });

  it('does not render a remove button when removable is false (default)', () => {
    render(<TagBadge tag={baseTag} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not render a remove button when removable=true but onRemove is absent', () => {
    render(<TagBadge tag={baseTag} removable={true} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a remove button when removable=true and onRemove is provided', () => {
    const onRemove = vi.fn();
    render(<TagBadge tag={baseTag} removable={true} onRemove={onRemove} />);
    expect(screen.getByRole('button', { name: 'Remove Customer' })).toBeInTheDocument();
  });

  it('calls onRemove with tag.id when remove button is clicked', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<TagBadge tag={baseTag} removable={true} onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'Remove Customer' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith('tag-1');
  });

  it('clicking the remove button stops event propagation', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <TagBadge tag={baseTag} removable={true} onRemove={onRemove} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Remove Customer' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('remove button has accessible aria-label including the tag name', () => {
    const onRemove = vi.fn();
    render(<TagBadge tag={baseTag} removable={true} onRemove={onRemove} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Remove Customer');
  });

  it('applies the className prop to the outer badge span', () => {
    const { container } = render(<TagBadge tag={baseTag} className="my-custom-class" />);
    const badge = container.querySelector('span')!;
    expect(badge.className).toMatch(/my-custom-class/);
  });

  it('name span has truncate and max-w-[160px] classes for overflow control', () => {
    const { container } = render(<TagBadge tag={baseTag} />);
    const nameSpan = container.querySelectorAll('span')[2];
    expect(nameSpan.className).toMatch(/truncate/);
    expect(nameSpan.className).toMatch(/max-w-\[160px\]/);
  });

  it('renders long tag names inside the truncate span', () => {
    const longTag: SurveyTag = { ...baseTag, id: 'tag-2', name: 'A Very Long Tag Name That Should Be Truncated By CSS' };
    const { container } = render(<TagBadge tag={longTag} />);
    const nameSpan = container.querySelectorAll('span')[2];
    expect(nameSpan).toHaveTextContent('A Very Long Tag Name That Should Be Truncated By CSS');
    expect(nameSpan.className).toMatch(/truncate/);
  });

  it('aria-label on remove button reflects the actual tag name', () => {
    const onRemove = vi.fn();
    const customTag: SurveyTag = { ...baseTag, id: 'tag-99', slug: 'enterprise-feedback', name: 'Enterprise Feedback' };
    render(<TagBadge tag={customTag} removable={true} onRemove={onRemove} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Remove Enterprise Feedback');
  });

  // ── onNavigate (Tag Report entry point, TRACKER.md §3 Part D) ────────────────

  it('does not render as navigable when onNavigate is absent', () => {
    render(<TagBadge tag={baseTag} />);
    expect(screen.queryByRole('button', { name: /View Tag Report/i })).not.toBeInTheDocument();
  });

  it('renders as a navigable button when onNavigate is provided', () => {
    const onNavigate = vi.fn();
    render(<TagBadge tag={baseTag} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'View Tag Report for Customer' })).toBeInTheDocument();
  });

  it('calls onNavigate with tag.id when clicked', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<TagBadge tag={baseTag} onNavigate={onNavigate} />);
    await user.click(screen.getByRole('button', { name: 'View Tag Report for Customer' }));
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith('tag-1');
  });

  it('clicking onNavigate stops event propagation (does not trigger a parent row click)', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <TagBadge tag={baseTag} onNavigate={onNavigate} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'View Tag Report for Customer' }));
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('supports keyboard activation (Enter) for onNavigate', () => {
    const onNavigate = vi.fn();
    render(<TagBadge tag={baseTag} onNavigate={onNavigate} />);
    const badge = screen.getByRole('button', { name: 'View Tag Report for Customer' });
    badge.focus();
    fireEvent.keyDown(badge, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('tag-1');
  });

  it('is both removable and navigable at once without one handler firing the other', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const onNavigate = vi.fn();
    render(<TagBadge tag={baseTag} removable onRemove={onRemove} onNavigate={onNavigate} />);
    await user.click(screen.getByRole('button', { name: 'Remove Customer' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
