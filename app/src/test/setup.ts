import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers as Parameters<typeof expect.extend>[0]);

// jsdom has no ResizeObserver implementation — several components (the
// Unified Builder's card-stack canvas, any future layout-measuring component)
// use it to recompute connector/overlay geometry. A no-op stub is sufficient
// for tests, which don't need real layout measurement.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
