/**
 * The small part of Electron's App API needed to protect the desktop profile.
 * Keeping this structural makes the startup contract testable without loading
 * Electron in a Node test process.
 */
export interface SingleInstanceApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

/** The BrowserWindow operations needed when another launch is redirected. */
export interface PrimaryWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

function revealPrimaryWindow(window: PrimaryWindow | null): void {
  if (window === null || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * Claim ownership of Electron's user-data profile before initializing any
 * main-process services. A later launch is reduced to a focus signal and exits
 * without registering IPC, opening storage, or creating another window.
 */
export function startSingleInstanceApplication(
  application: SingleInstanceApplication,
  primaryWindow: () => PrimaryWindow | null,
  initializePrimary: () => void,
): boolean {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }

  application.on('second-instance', () => {
    revealPrimaryWindow(primaryWindow());
  });
  initializePrimary();
  return true;
}
