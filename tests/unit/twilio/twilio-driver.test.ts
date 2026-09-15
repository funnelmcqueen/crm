// createTwilioDriver maps the Voice SDK Device/Call API onto the InAppDriver contract (ARCHITECTURE 6).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallEvents, IncomingCall } from '@/lib/dialer/types';

const fakes = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  class Emitter {
    private handlers = new Map<string, Set<Handler>>();
    on(event: string, handler: Handler): this {
      const set = this.handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      this.handlers.set(event, set);
      return this;
    }
    removeListener(event: string, handler: Handler): this {
      this.handlers.get(event)?.delete(handler);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
    }
    listenerCount(event: string): number {
      return this.handlers.get(event)?.size ?? 0;
    }
  }

  // Mirrors the SDK: accept() and disconnect() do nothing once the call is closed.
  class FakeCall extends Emitter {
    customParameters = new Map<string, string>();
    muted = false;
    state: 'pending' | 'connecting' | 'open' | 'closed' = 'pending';
    status = vi.fn(() => this.state);
    accept = vi.fn(() => {
      if (this.state === 'pending') this.state = 'connecting';
    });
    reject = vi.fn(() => {
      this.state = 'closed';
    });
    disconnect = vi.fn();
    /** What the SDK does when the caller hangs up (or another tab answers) before this client accepts. */
    cancelRemotely(): void {
      this.state = 'closed';
      this.emit('cancel');
    }
    mute = vi.fn((value: boolean) => {
      this.muted = value;
    });
    isMuted = vi.fn(() => this.muted);
    sendDigits = vi.fn();
  }

  type RegisterBehavior = 'registered' | 'error' | 'hang' | 'reject';

  class FakeDevice extends Emitter {
    static instances: FakeDevice[] = [];
    static registerBehavior: RegisterBehavior = 'registered';
    static connectError: unknown = null;
    calls: FakeCall[] = [];
    audio = {
      setInputDevice: vi.fn(async () => undefined),
      speakerDevices: { set: vi.fn(async () => undefined), test: vi.fn(async () => undefined) },
    };
    register = vi.fn(async () => {
      const behavior = FakeDevice.registerBehavior;
      if (behavior === 'reject') throw Object.assign(new Error('socket closed'), { code: 31005 });
      queueMicrotask(() => {
        if (behavior === 'registered') this.emit('registered');
        if (behavior === 'error') this.emit('error', Object.assign(new Error('raw sdk text'), { code: 31401 }));
      });
    });
    unregister = vi.fn(async () => undefined);
    destroy = vi.fn();
    updateToken = vi.fn();
    connect = vi.fn(async () => {
      if (FakeDevice.connectError) throw FakeDevice.connectError;
      const call = new FakeCall();
      this.calls.push(call);
      return call;
    });
    constructor(
      public token: string,
      public options: unknown,
    ) {
      super();
      FakeDevice.instances.push(this);
    }
  }

  return { FakeCall, FakeDevice };
});

vi.mock('@twilio/voice-sdk', () => ({ Device: fakes.FakeDevice, Call: fakes.FakeCall }));

import {
  REGISTER_TIMEOUT_MS,
  TOKEN_REFRESH_MS,
  createTwilioDriver,
  twilioErrorMessage,
  twilioWarningMessage,
} from '@/lib/dialer/drivers/twilio';

function recorder() {
  const log: unknown[][] = [];
  const events: CallEvents = {
    onRinging: () => log.push(['ringing']),
    onConnected: () => log.push(['connected']),
    onDisconnected: (reason) => log.push(['disconnected', reason]),
    onWarning: (message) => log.push(['warning', message]),
    onError: (message) => log.push(['error', message]),
  };
  return { log, events };
}

let tokens: string[];
let fetchToken: ReturnType<typeof vi.fn<() => Promise<{ token: string; ttl: number }>>>;

beforeEach(() => {
  fakes.FakeDevice.instances = [];
  fakes.FakeDevice.registerBehavior = 'registered';
  fakes.FakeDevice.connectError = null;
  tokens = ['token-1', 'token-2', 'token-3'];
  fetchToken = vi.fn(async () => ({ token: tokens.shift() ?? 'token-n', ttl: 3600 }));
});

afterEach(() => {
  vi.useRealTimers();
});

async function registeredDriver() {
  const driver = createTwilioDriver({ fetchToken });
  expect(await driver.register()).toEqual({ ok: true });
  const device = fakes.FakeDevice.instances[0];
  return { driver, device };
}

describe('register', () => {
  it('creates the Device with opus/pcmu and close protection, and resolves ok on "registered"', async () => {
    const { driver, device } = await registeredDriver();
    expect(driver.name).toBe('twilio');
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(fakes.FakeDevice.instances).toHaveLength(1);
    expect(device.token).toBe('token-1');
    expect(device.options).toEqual({ codecPreferences: ['opus', 'pcmu'], closeProtection: true, tokenRefreshMs: TOKEN_REFRESH_MS });
    expect(device.register).toHaveBeenCalledTimes(1);
    expect(await driver.register()).toEqual({ ok: true });
    expect(fakes.FakeDevice.instances).toHaveLength(1);
  });

  it('fails with a plain reason on a Device error, a rejected register() or a token failure', async () => {
    fakes.FakeDevice.registerBehavior = 'error';
    expect(await createTwilioDriver({ fetchToken }).register()).toEqual({ ok: false, reason: 'Microphone blocked' });

    fakes.FakeDevice.registerBehavior = 'reject';
    expect(await createTwilioDriver({ fetchToken }).register()).toEqual({ ok: false, reason: 'Connection lost' });

    const failing = createTwilioDriver({ fetchToken: async () => Promise.reject(new Error('HTTP 503')) });
    const result = await failing.register();
    expect(result.ok).toBe(false);
    expect(result).not.toMatchObject({ reason: expect.stringContaining('503') });
  });

  it('times out after 10 seconds without "registered"', async () => {
    vi.useFakeTimers();
    fakes.FakeDevice.registerBehavior = 'hang';
    const pending = createTwilioDriver({ fetchToken }).register();
    await vi.advanceTimersByTimeAsync(REGISTER_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, reason: expect.stringMatching(/timed out/i) });
  });

  it('refreshes the token on tokenWillExpire', async () => {
    const { device } = await registeredDriver();
    device.emit('tokenWillExpire', device);
    await vi.waitFor(() => expect(device.updateToken).toHaveBeenCalledWith('token-2'));
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('retries a failed token refresh until one succeeds, without reporting the device unavailable', async () => {
    const { driver, device } = await registeredDriver();
    const states: string[] = [];
    driver.onStateChange?.((state) => states.push(state));
    vi.useFakeTimers();
    let failures = 2;
    fetchToken.mockImplementation(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('HTTP 429');
      }
      return { token: 'fresh', ttl: 3600 };
    });
    device.emit('tokenWillExpire', device);
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS - 5_000);
    expect(device.updateToken).toHaveBeenCalledWith('fresh');
    expect(fetchToken).toHaveBeenCalledTimes(1 + 3);
    expect(states).toEqual([]);
  });

  it('reports the device unavailable when the token cannot be refreshed before it expires', async () => {
    const { driver, device } = await registeredDriver();
    const states: string[] = [];
    expect(driver.onStateChange).toBeTypeOf('function');
    driver.onStateChange?.((state) => states.push(state));
    vi.useFakeTimers();
    fetchToken.mockImplementation(async () => Promise.reject(new Error('HTTP 503')));
    device.emit('tokenWillExpire', device);
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS + 1_000);
    expect(device.updateToken).not.toHaveBeenCalled();
    expect(states).toEqual(['unavailable']);
    const calls = fetchToken.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * TOKEN_REFRESH_MS);
    expect(fetchToken.mock.calls.length).toBe(calls);
  });

  it('reports unavailable when the Device unregisters or its token expires, and ready when it registers again', async () => {
    const { driver, device } = await registeredDriver();
    const states: string[] = [];
    const unsubscribe = driver.onStateChange?.((state) => states.push(state));
    device.emit('unregistered');
    device.emit('registered');
    device.emit('error', Object.assign(new Error('AccessTokenExpired'), { code: 20104 }));
    device.emit('error', Object.assign(new Error('unrelated'), { code: 31000 }));
    expect(states).toEqual(['unavailable', 'ready', 'unavailable']);
    unsubscribe?.();
    device.emit('registered');
    expect(states).toEqual(['unavailable', 'ready', 'unavailable']);
  });
});

describe('connect and call events', () => {
  it('sends ONLY the call id and maps ringing/accept/disconnect', async () => {
    const { driver, device } = await registeredDriver();
    const { log, events } = recorder();
    const active = await driver.connect('call-123', events);
    expect(device.connect).toHaveBeenCalledWith({ params: { callId: 'call-123' } });
    const call = device.calls[0];

    call.emit('ringing', true);
    call.emit('accept', call);
    call.emit('disconnect', call);
    call.emit('disconnect', call);
    expect(log).toEqual([['ringing'], ['connected'], ['disconnected', 'completed']]);

    active.setMuted(true);
    expect(call.mute).toHaveBeenCalledWith(true);
    expect(active.isMuted()).toBe(true);
    active.sendDigits('12#');
    expect(call.sendDigits).toHaveBeenCalledWith('12#');
    active.hangup();
    expect(call.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cancel', 'canceled'],
    ['reject', 'busy'],
  ])('maps "%s" to onDisconnected(%s)', async (event, reason) => {
    const { driver, device } = await registeredDriver();
    const { log, events } = recorder();
    await driver.connect('call-1', events);
    device.calls[0].emit(event);
    device.calls[0].emit('disconnect');
    expect(log).toEqual([['disconnected', reason]]);
  });

  it.each([
    [31401, 'Microphone blocked'],
    [31208, 'Microphone blocked'],
    [31201, 'Microphone not found'],
    [31005, 'Connection lost'],
    [31009, 'Connection lost'],
    [53000, 'Connection lost'],
    [53405, 'Connection lost'],
    [31000, 'Call failed'],
  ])('maps error code %i to "%s"', async (code, message) => {
    const { driver, device } = await registeredDriver();
    const { log, events } = recorder();
    await driver.connect('call-1', events);
    device.calls[0].emit('error', Object.assign(new Error('Raw SDK description'), { code }));
    expect(log).toEqual([['error', message]]);
  });

  it('maps quality warnings to plain language and clears them', async () => {
    const { driver, device } = await registeredDriver();
    const { log, events } = recorder();
    await driver.connect('call-1', events);
    const call = device.calls[0];
    for (const name of ['high-rtt', 'high-jitter', 'high-packet-loss', 'low-mos', 'constant-audio-input-level', 'ice-connectivity-lost-unknown']) {
      call.emit('warning', name, {});
    }
    call.emit('warning-cleared', 'high-rtt');
    expect(log).toEqual([
      ['warning', 'Poor connection'],
      ['warning', 'Poor connection'],
      ['warning', 'Poor connection'],
      ['warning', 'Poor connection'],
      ['warning', 'Microphone is not picking up audio'],
      ['warning', ''],
    ]);
  });

  it('rejects connect before register, and maps a connect failure to a plain message', async () => {
    await expect(createTwilioDriver({ fetchToken }).connect('call-1', recorder().events)).rejects.toThrow('In-app calling is not ready');
    const { driver } = await registeredDriver();
    fakes.FakeDevice.connectError = Object.assign(new Error('Permission denied by system'), { name: 'NotAllowedError' });
    await expect(driver.connect('call-1', recorder().events)).rejects.toThrow('Microphone blocked');
  });
});

describe('incoming calls', () => {
  it('exposes the callId parameter, wires events on accept, rejects, and unsubscribes', async () => {
    const { driver, device } = await registeredDriver();
    const received: { callId: string | null; accept: (e: CallEvents) => unknown; reject: () => void }[] = [];
    const unsubscribe = driver.onIncoming((call) => received.push(call));

    const incoming = new fakes.FakeCall();
    incoming.customParameters.set('callId', 'inbound-1');
    device.emit('incoming', incoming);
    expect(received).toHaveLength(1);
    expect(received[0].callId).toBe('inbound-1');

    const { log, events } = recorder();
    received[0].accept(events);
    expect(incoming.accept).toHaveBeenCalledTimes(1);
    incoming.emit('accept', incoming);
    incoming.emit('disconnect', incoming);
    expect(log).toEqual([['connected'], ['disconnected', 'completed']]);

    const declined = new fakes.FakeCall();
    device.emit('incoming', declined);
    expect(received[1].callId).toBeNull();
    received[1].reject();
    expect(declined.reject).toHaveBeenCalledTimes(1);

    unsubscribe();
    device.emit('incoming', new fakes.FakeCall());
    expect(received).toHaveLength(2);
  });

  it('reports a caller hang-up before Accept through onCancel, and refuses to accept that call', async () => {
    const { driver, device } = await registeredDriver();
    const received: IncomingCall[] = [];
    driver.onIncoming((call) => received.push(call));
    const sdkCall = new fakes.FakeCall();
    sdkCall.customParameters.set('callId', 'inbound-2');
    device.emit('incoming', sdkCall);

    const onCancel = vi.fn();
    expect(received[0].onCancel).toBeTypeOf('function');
    received[0].onCancel?.(onCancel);
    sdkCall.cancelRemotely();
    expect(onCancel).toHaveBeenCalledTimes(1);

    const { log, events } = recorder();
    expect(() => received[0].accept(events)).toThrow();
    expect(log).toEqual([]);
  });

  it('refuses to accept a call the SDK already closed even when the cancel event was missed', async () => {
    const { driver, device } = await registeredDriver();
    const received: IncomingCall[] = [];
    driver.onIncoming((call) => received.push(call));
    const sdkCall = new fakes.FakeCall();
    device.emit('incoming', sdkCall);
    sdkCall.state = 'closed';
    expect(() => received[0].accept(recorder().events)).toThrow();
  });

  it('a cancel listener added after the cancel still hears about it', async () => {
    const { driver, device } = await registeredDriver();
    const received: IncomingCall[] = [];
    driver.onIncoming((call) => received.push(call));
    const sdkCall = new fakes.FakeCall();
    device.emit('incoming', sdkCall);
    sdkCall.cancelRemotely();
    const onCancel = vi.fn();
    received[0].onCancel?.(onCancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('hang up on a call the SDK already closed still ends the call locally', async () => {
    const { driver, device } = await registeredDriver();
    const received: IncomingCall[] = [];
    driver.onIncoming((call) => received.push(call));
    const sdkCall = new fakes.FakeCall();
    device.emit('incoming', sdkCall);
    const { log, events } = recorder();
    const active = received[0].accept(events);
    sdkCall.state = 'closed';
    active.hangup();
    expect(log).toEqual([['disconnected', 'completed']]);
    active.hangup();
    expect(log).toEqual([['disconnected', 'completed']]);
  });
});

describe('audio devices and destroy', () => {
  it('routes device selection and the speaker test through device.audio', async () => {
    const unregistered = createTwilioDriver({ fetchToken });
    await expect(unregistered.setInputDevice?.('mic-1')).rejects.toThrow();

    const { driver, device } = await registeredDriver();
    await driver.setInputDevice?.('mic-1');
    await driver.setOutputDevice?.('speaker-2');
    await driver.testSpeaker?.();
    expect(device.audio.setInputDevice).toHaveBeenCalledWith('mic-1');
    expect(device.audio.speakerDevices.set).toHaveBeenCalledWith('speaker-2');
    expect(device.audio.speakerDevices.test).toHaveBeenCalledTimes(1);
  });

  it('destroy() unregisters and destroys the Device, and stops incoming delivery', async () => {
    const { driver, device } = await registeredDriver();
    const cb = vi.fn();
    driver.onIncoming(cb);
    driver.destroy();
    expect(device.unregister).toHaveBeenCalledTimes(1);
    expect(device.destroy).toHaveBeenCalledTimes(1);
    device.emit('incoming', new fakes.FakeCall());
    expect(cb).not.toHaveBeenCalled();
    driver.destroy();
    expect(device.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('message helpers', () => {
  it('never returns raw SDK text', () => {
    expect(twilioErrorMessage(new Error('Something internal'))).toBe('Call failed');
    expect(twilioErrorMessage({ name: 'NotFoundError' })).toBe('Microphone not found');
    expect(twilioErrorMessage(null, 'Fallback')).toBe('Fallback');
    expect(twilioWarningMessage('high-rtt')).toBe('Poor connection');
    expect(twilioWarningMessage('unknown')).toBeNull();
  });
});
