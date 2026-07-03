import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TagReportsIndexSkeleton } from '../../components/LoadingStates';

afterEach(cleanup);

describe('TagReportsIndexSkeleton', () => {
  it('renders a 3-col responsive grid of skeleton cards, defaulting to 6', () => {
    const { container } = render(<TagReportsIndexSkeleton />);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toMatch(/grid-cols-1/);
    expect(grid.className).toMatch(/md:grid-cols-2/);
    expect(grid.className).toMatch(/lg:grid-cols-3/);
    expect(grid.children).toHaveLength(6);
  });

  it('respects a custom count', () => {
    const { container } = render(<TagReportsIndexSkeleton count={3} />);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.children).toHaveLength(3);
  });
});
