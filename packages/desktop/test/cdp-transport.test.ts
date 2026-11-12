import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { ElectronCdpTransport } from '../src/cdp-transport.js';

it('releases evaluations lost during document teardown so subsequent captures can run', async () => {
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn(), detach: vi.fn(),
    sendCommand: vi.fn(() => new Promise<unknown>(() => {})),
  });
  const transport = new ElectronCdpTransport({ debugger: debuggerApi } as unknown as WebContents);
  transport.attach();
  const pending = transport.send('Runtime.evaluate', { expression: 'new Promise(() => {})' });
  const failed = expect(pending).rejects.toThrow('document changed');
  debuggerApi.emit('message', {}, 'Runtime.executionContextsCleared', {}, '');
  await failed;
  debuggerApi.sendCommand.mockResolvedValueOnce({ result: { value: 'new document' } });
  expect(await transport.send('Runtime.evaluate')).toEqual({ result: { value: 'new document' } });
  transport.detach();
});

it('bounds a nonresponsive protocol request instead of blocking the capture queue forever', async () => {
  vi.useFakeTimers();
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(() => new Promise(() => {})),
  });
  const transport = new ElectronCdpTransport({ debugger: debuggerApi } as unknown as WebContents);
  try {
    transport.attach();
    const failed = expect(transport.send('DOM.getDocument')).rejects.toThrow('Page inspection timed out: DOM.getDocument');
    await vi.advanceTimersByTimeAsync(12000);
    await failed;
  } finally { transport.detach(); vi.useRealTimers(); }
});
