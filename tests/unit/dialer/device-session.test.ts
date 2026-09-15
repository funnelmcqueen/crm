// startDeviceSession owns the in-app device lifecycle for DialerProvider: registration, the 15s fallback,
// late registrations, a device that stops working mid-session, and server refusals (403/503).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDeviceSession, type DeviceStatus } from '@/lib/dialer/device-session';
import type { DriverState, InAppDriver, IncomingCall, RegisterResult } from '@/lib/dialer/types';

interface FakeDriver extends InAppDriver {
  registerCalls: number;
  destroyed: boolean;
  resolveRegister(result: RegisterResult): void;
  emitState(state: DriverState): void;
  ring(call: IncomingCall): void;
  incomingListenerCount(): number;
}

function fakeDriver(): FakeDriver {
  const incoming = new Set<(call: IncomingCall) => void>();
  const states = new Set<(state: DriverState) => void>();
  let pending: ((result: RegisterResult) => void) | null = null;
  const driver: FakeDriver = {
    name: 'mock',
    registerCalls: 0,
    destroyed: false,
    register() {
      driver.registerCalls += 1;
      return new Promise<RegisterResult>((resolve) => {
        pending = resolve;
      });
    },
    onStateChange(cb) {
      states.add(cb);
      return () => states.delete(cb);
    },
    async connect() {
      throw new Error('not used');
    },
    onIncoming(cb) {
      incoming.add(cb);
      return () => incoming.delete(cb);
    },
    destroy() {
      driver.destroyed = true;
      incoming.clear();
      states.clear();
    },
    resolveRegister(result) {
      const resolve = pending;
      pending = null;
      resolve?.(result);
    },
    emitState(state) {
      for (const cb of [...states]) cb(state);
    },
    ring(call) {
      for (const cb of [...incoming]) cb(call);
    },
    incomingListenerCount: () => incoming.size,
  };
  return driver;
}

const TIMEOUT = 15_000;
const RETRY = 60_000;

function setup(driver: FakeDriver = fakeDriver()) {
  const statuses: Array<[DeviceStatus, boolean]> = [];
  const calls: IncomingCall[] = [];
  const session = startDeviceSession({
    load: async () => driver,
    onIncoming: (call) => calls.push(call),
    onStatus: (status, notify) => statuses.push([status, notify]),
    registerTimeoutMs: TIMEOUT,
    retryMs: RETRY,
  });
  return { driver, session, statuses, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startDeviceSession', () => {
  it('reports ready after registration and delivers incoming calls', async () => {
    const { driver, session, statuses, calls } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.registerCalls).toBe(1);
    expect(session.status()).toBe('registering');
    driver.resolveRegister({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual([['ready', false]]);
    expect(session.readyDriver()).toBe(driver);
    const call: IncomingCall = { callId: null, accept: () => ({ hangup() {}, setMuted() {}, isMuted: () => false, sendDigits() {} }), reject() {} };
    driver.ring(call);
    expect(calls).toEqual([call]);
    await vi.advanceTimersByTimeAsync(TIMEOUT * 2);
    expect(statuses).toEqual([['ready', false]]);
  });

  it('falls back after 15s, and a registration that succeeds later still makes the device ready and answerable', async () => {
    const { driver, session, statuses } = setup();
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(statuses).toEqual([['failed', true]]);
    expect(session.readyDriver()).toBeNull();
    // Incoming calls can already reach the late device, so the loaded driver stays available for Accept.
    expect(session.loadedDriver()).toBe(driver);

    await vi.advanceTimersByTimeAsync(5_000);
    driver.resolveRegister({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual([
      ['failed', true],
      ['ready', false],
    ]);
    expect(session.readyDriver()).toBe(driver);
    expect(driver.destroyed).toBe(false);
  });

  it('a device that stops working reports failed once, retries registration, and becomes ready again', async () => {
    const { driver, session, statuses } = setup();
    await vi.advanceTimersByTimeAsync(0);
    driver.resolveRegister({ ok: true });
    await vi.advanceTimersByTimeAsync(0);

    driver.emitState('unavailable');
    expect(session.status()).toBe('failed');
    expect(session.readyDriver()).toBeNull();
    expect(statuses.at(-1)).toEqual(['failed', true]);

    await vi.advanceTimersByTimeAsync(RETRY);
    expect(driver.registerCalls).toBe(2);
    driver.resolveRegister({ ok: false, reason: 'still down' });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.filter(([status]) => status === 'failed')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RETRY);
    expect(driver.registerCalls).toBe(3);
    driver.resolveRegister({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.status()).toBe('ready');
    expect(statuses).toEqual([
      ['ready', false],
      ['failed', true],
      ['ready', false],
    ]);
  });

  it('the driver reporting ready again (re-registered on its own) restores the device', async () => {
    const { driver, session } = setup();
    await vi.advanceTimersByTimeAsync(0);
    driver.resolveRegister({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    driver.emitState('unavailable');
    driver.emitState('ready');
    expect(session.status()).toBe('ready');
  });

  it('turnOff (403: in-app calling disabled) destroys the driver, reports off and never retries', async () => {
    const { driver, session, statuses } = setup();
    await vi.advanceTimersByTimeAsync(0);
    driver.resolveRegister({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    session.turnOff();
    expect(statuses.at(-1)).toEqual(['off', false]);
    expect(driver.destroyed).toBe(true);
    expect(session.readyDriver()).toBeNull();
    expect(session.loadedDriver()).toBeNull();
    await vi.advanceTimersByTimeAsync(RETRY * 3);
    expect(driver.registerCalls).toBe(1);
    driver.emitState('ready');
    expect(session.status()).toBe('off');
  });

  it('markUnavailable (503) reports failed without a second notification and retries later', async () => {
    const { driver, session, statuses } = setup();
    await vi.advanceTimersByTimeAsync(0);
    driver.resolveRegister({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    session.markUnavailable();
    expect(statuses.at(-1)).toEqual(['failed', false]);
    await vi.advanceTimersByTimeAsync(RETRY);
    expect(driver.registerCalls).toBe(2);
  });

  it('dispose destroys the driver, removes listeners and ignores a registration that finishes afterwards', async () => {
    const { driver, session, statuses } = setup();
    await vi.advanceTimersByTimeAsync(0);
    session.dispose();
    expect(driver.destroyed).toBe(true);
    expect(driver.incomingListenerCount()).toBe(0);
    driver.resolveRegister({ ok: true });
    await vi.advanceTimersByTimeAsync(TIMEOUT + RETRY);
    expect(statuses).toEqual([]);
    expect(session.readyDriver()).toBeNull();
  });

  it('a driver that fails to load reports failed', async () => {
    const statuses: Array<[DeviceStatus, boolean]> = [];
    startDeviceSession({
      load: async () => Promise.reject(new Error('chunk failed')),
      onIncoming: () => undefined,
      onStatus: (status, notify) => statuses.push([status, notify]),
      registerTimeoutMs: TIMEOUT,
      retryMs: RETRY,
    });
    await vi.advanceTimersByTimeAsync(TIMEOUT * 2);
    expect(statuses).toEqual([['failed', true]]);
  });
});
