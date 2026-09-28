import { describe, expect, it, vi } from 'vitest';

import {
  startSingleInstanceApplication,
  type PrimaryWindow,
  type SingleInstanceApplication,
} from '../src/single-instance.js';

function application(lockGranted: boolean): {
  app: SingleInstanceApplication;
  requestLock: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  secondInstance: () => void;
} {
  let secondInstance = (): void => {
    throw new Error('second-instance handler was not registered');
  };
  const requestLock = vi.fn(() => lockGranted);
  const quit = vi.fn();
  return {
    app: {
      requestSingleInstanceLock: requestLock,
      quit,
      on: (event, listener) => {
        expect(event).toBe('second-instance');
        secondInstance = listener;
      },
    },
    requestLock,
    quit,
    secondInstance: () => secondInstance(),
  };
}

function primaryWindow(options: {
  destroyed?: boolean;
  minimized?: boolean;
} = {}): PrimaryWindow & {
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
} {
  return {
    isDestroyed: () => options.destroyed ?? false,
    isMinimized: () => options.minimized ?? false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe('desktop single-instance lifecycle', () => {
  it('quits a second process before primary-process initialization', () => {
    const fake = application(false);
    const initialize = vi.fn();

    expect(startSingleInstanceApplication(fake.app, () => null, initialize)).toBe(false);

    expect(fake.requestLock).toHaveBeenCalledOnce();
    expect(fake.quit).toHaveBeenCalledOnce();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('initializes the lock owner and focuses its existing window on another launch', () => {
    const fake = application(true);
    const existingWindow = primaryWindow({ minimized: true });
    const initialize = vi.fn();

    expect(startSingleInstanceApplication(
      fake.app,
      () => existingWindow,
      initialize,
    )).toBe(true);
    fake.secondInstance();

    expect(fake.quit).not.toHaveBeenCalled();
    expect(initialize).toHaveBeenCalledOnce();
    expect(existingWindow.restore).toHaveBeenCalledOnce();
    expect(existingWindow.show).toHaveBeenCalledOnce();
    expect(existingWindow.focus).toHaveBeenCalledOnce();
  });

  it('ignores a focus signal until a usable primary window exists', () => {
    const fake = application(true);
    const destroyedWindow = primaryWindow({ destroyed: true });
    startSingleInstanceApplication(fake.app, () => destroyedWindow, vi.fn());

    fake.secondInstance();

    expect(destroyedWindow.restore).not.toHaveBeenCalled();
    expect(destroyedWindow.show).not.toHaveBeenCalled();
    expect(destroyedWindow.focus).not.toHaveBeenCalled();
  });
});
