import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDriver } from "@/lib/dialer/drivers/mock";
import type { CallEvents, IncomingCall } from "@/lib/dialer/types";

function recorder() {
  const log: string[] = [];
  const events: CallEvents = {
    onRinging: () => log.push("ringing"),
    onConnected: () => log.push("connected"),
    onDisconnected: (reason) => log.push(`disconnected:${reason}`),
    onWarning: (message) => log.push(`warning:${message}`),
    onError: (message) => log.push(`error:${message}`),
  };
  return { log, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createMockDriver", () => {
  it("registers", async () => {
    await expect(createMockDriver().register()).resolves.toEqual({ ok: true });
  });

  it("rings, connects after ringMs, and stays connected until hangup", async () => {
    const driver = createMockDriver();
    const { log, events } = recorder();
    const call = await driver.connect("call-1", events);
    expect(log).toEqual(["ringing"]);

    vi.advanceTimersByTime(1_199);
    expect(log).toEqual(["ringing"]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(["ringing", "connected"]);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(log).toEqual(["ringing", "connected"]);

    call.hangup();
    call.hangup();
    expect(log).toEqual(["ringing", "connected", "disconnected:completed"]);
  });

  it("honors a custom ringMs", async () => {
    const driver = createMockDriver({ ringMs: 50 });
    const { log, events } = recorder();
    await driver.connect("call-1", events);
    vi.advanceTimersByTime(50);
    expect(log).toEqual(["ringing", "connected"]);
  });

  it("hanging up while ringing cancels and never connects", async () => {
    const driver = createMockDriver();
    const { log, events } = recorder();
    const call = await driver.connect("call-1", events);
    call.hangup();
    vi.advanceTimersByTime(5_000);
    expect(log).toEqual(["ringing", "disconnected:canceled"]);
  });

  it("allows one call at a time, and a new call after the first ends", async () => {
    const driver = createMockDriver();
    const first = recorder();
    const call = await driver.connect("call-1", first.events);
    await expect(driver.connect("call-2", recorder().events)).rejects.toThrow(/already active/);
    call.hangup();
    await expect(driver.connect("call-2", recorder().events)).resolves.toBeDefined();
  });

  it("tracks mute and digits", async () => {
    const driver = createMockDriver({ ringMs: 10, exposeTestHooks: true });
    vi.stubGlobal("window", {});
    const withHooks = createMockDriver({ ringMs: 10, exposeTestHooks: true });
    const call = await withHooks.connect("call-1", recorder().events);
    call.sendDigits("1");
    vi.advanceTimersByTime(10);
    call.setMuted(true);
    call.sendDigits("2#");
    expect(call.isMuted()).toBe(true);
    expect(window.__fmqMockDialer?.snapshot()).toEqual({
      inCall: true,
      connected: true,
      muted: true,
      digits: "2#",
      incomingPending: false,
    });
    driver.destroy();
    withHooks.destroy();
  });

  it("does not install test hooks unless asked", () => {
    vi.stubGlobal("window", {});
    const driver = createMockDriver();
    expect(window.__fmqMockDialer).toBeUndefined();
    driver.destroy();
  });

  it("does not touch window when it does not exist", () => {
    expect(typeof window).toBe("undefined");
    expect(() => createMockDriver({ exposeTestHooks: true }).destroy()).not.toThrow();
  });

  describe("test hooks", () => {
    beforeEach(() => {
      vi.stubGlobal("window", {});
    });

    it("remoteHangup ends the active call with the given reason", async () => {
      const driver = createMockDriver({ exposeTestHooks: true });
      const { log, events } = recorder();
      await driver.connect("call-1", events);
      window.__fmqMockDialer?.remoteHangup("busy");
      vi.advanceTimersByTime(5_000);
      expect(log).toEqual(["ringing", "disconnected:busy"]);
      expect(window.__fmqMockDialer?.snapshot().inCall).toBe(false);
      driver.destroy();
    });

    it("remoteHangup defaults to completed", async () => {
      const driver = createMockDriver({ exposeTestHooks: true, ringMs: 1 });
      const { log, events } = recorder();
      await driver.connect("call-1", events);
      vi.advanceTimersByTime(1);
      window.__fmqMockDialer?.remoteHangup();
      expect(log).toEqual(["ringing", "connected", "disconnected:completed"]);
      driver.destroy();
    });

    it("simulateIncoming delivers a call that can be accepted and hung up", () => {
      const driver = createMockDriver({ exposeTestHooks: true });
      const received: IncomingCall[] = [];
      const unsubscribe = driver.onIncoming((call) => received.push(call));
      window.__fmqMockDialer?.simulateIncoming("call-9");
      expect(received.map((call) => call.callId)).toEqual(["call-9"]);
      expect(window.__fmqMockDialer?.snapshot().incomingPending).toBe(true);

      const { log, events } = recorder();
      const active = received[0].accept(events);
      expect(log).toEqual(["connected"]);
      expect(() => received[0].accept(recorder().events)).toThrow();
      active.hangup();
      expect(log).toEqual(["connected", "disconnected:completed"]);

      unsubscribe();
      window.__fmqMockDialer?.simulateIncoming(null);
      expect(received).toHaveLength(1);
      driver.destroy();
    });

    it("an unknown caller has a null call id, and reject settles the call", () => {
      const driver = createMockDriver({ exposeTestHooks: true });
      const received: IncomingCall[] = [];
      driver.onIncoming((call) => received.push(call));
      window.__fmqMockDialer?.simulateIncoming(null);
      expect(received[0].callId).toBeNull();
      received[0].reject();
      expect(window.__fmqMockDialer?.snapshot().incomingPending).toBe(false);
      expect(() => received[0].accept(recorder().events)).toThrow();
      driver.destroy();
    });

    it("remoteHangup cancels an unanswered incoming call", () => {
      const driver = createMockDriver({ exposeTestHooks: true });
      const canceled = vi.fn();
      driver.onIncoming((call) => call.onCancel?.(canceled));
      window.__fmqMockDialer?.simulateIncoming("call-9");
      window.__fmqMockDialer?.remoteHangup("canceled");
      expect(canceled).toHaveBeenCalledTimes(1);
      driver.destroy();
    });

    it("accepting while another call is active throws", async () => {
      const driver = createMockDriver({ exposeTestHooks: true });
      await driver.connect("call-1", recorder().events);
      const received: IncomingCall[] = [];
      driver.onIncoming((call) => received.push(call));
      window.__fmqMockDialer?.simulateIncoming("call-2");
      expect(() => received[0].accept(recorder().events)).toThrow(/already active/);
      driver.destroy();
    });

    it("destroy removes the hooks, stops timers, and refuses new calls", async () => {
      const driver = createMockDriver({ exposeTestHooks: true });
      const { log, events } = recorder();
      await driver.connect("call-1", events);
      driver.destroy();
      expect(window.__fmqMockDialer).toBeUndefined();
      vi.advanceTimersByTime(5_000);
      expect(log).toEqual(["ringing"]);
      await expect(driver.connect("call-2", recorder().events)).rejects.toThrow();
      await expect(driver.register()).resolves.toMatchObject({ ok: false });
    });
  });
});
