import Pusher from "pusher-js";
import { iLayerRfqHelper } from "../src/modules/rfq";
import { RfqQuoteRequestPayload, RfqQuoteResponsePayload } from "../src/types";

type MockChannel = {
  bind: jest.Mock;
  unbind: jest.Mock;
  trigger: jest.Mock;
  emit: (event: string, payload: unknown) => void;
};

jest.mock("pusher-js");

describe("iLayerRfqHelper", () => {
  const channels = new Map<string, MockChannel>();
  let subscribeMock: jest.Mock;
  let unsubscribeMock: jest.Mock;
  let disconnectMock: jest.Mock;

  const createChannel = (_name: string): MockChannel => {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();

    const addHandler = (event: string, handler: (payload: unknown) => void) => {
      const existing = handlers.get(event) ?? new Set();
      existing.add(handler);
      handlers.set(event, existing);
      if (event === "pusher:subscription_succeeded") {
        handler({});
      }
    };

    return {
      bind: jest.fn((event: string, handler: (payload: unknown) => void) => {
        addHandler(event, handler);
      }),
      unbind: jest.fn((event: string, handler: (payload: unknown) => void) => {
        const existing = handlers.get(event);
        existing?.delete(handler);
      }),
      trigger: jest.fn((event: string, payload: unknown) => {
        handlers.get(event)?.forEach((handler) => handler(payload));
      }),
      emit: (event: string, payload: unknown) => {
        handlers.get(event)?.forEach((handler) => handler(payload));
      },
    };
  };

  beforeEach(() => {
    channels.clear();
    subscribeMock = jest.fn((name: string) => {
      if (!channels.has(name)) {
        channels.set(name, createChannel(name));
      }
      return channels.get(name);
    });
    unsubscribeMock = jest.fn((name: string) => {
      channels.delete(name);
    });
    disconnectMock = jest.fn();

    (Pusher as unknown as jest.Mock).mockImplementation(() => ({
      subscribe: subscribeMock,
      unsubscribe: unsubscribeMock,
      disconnect: disconnectMock,
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const helperOptions = {
    key: "dummy-key",
    host: "localhost",
    port: 6001,
    authEndpoint: "/auth",
  };

  const baseRequest: RfqQuoteRequestPayload = {
    from: {
      network: "arbitrum",
      tokens: [{ address: "0xfrom", amount: "1000" }],
    },
    to: {
      network: "base",
      tokens: [{ address: "0xto", amount: "0" }],
    },
  };

  it("publishes an RFQ request and resolves on quote", async () => {
    const helper = new iLayerRfqHelper(helperOptions);
    const statusSpy = jest.fn();

    const quotePromise = helper.requestQuote(baseRequest, {
      onStatus: statusSpy,
    });

    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(subscribeMock).toHaveBeenCalledWith("private-rfq.broadcast");
    const broadcast = channels.get("private-rfq.broadcast");
    expect(broadcast).toBeDefined();
    expect(broadcast!.trigger).toHaveBeenCalledWith(
      "client-rfq.request",
      expect.objectContaining({ bucket: expect.any(String) }),
    );

    const [, requestPayload] = broadcast!.trigger.mock.calls[0];
    const bucket = (requestPayload as { bucket: string }).bucket;
    const reply = channels.get(`private-rfq.${bucket}`);
    expect(reply).toBeDefined();

    const quotePayload: RfqQuoteResponsePayload = [
      {
        id: `${bucket}:solver-bot`,
        receiveAmount: 123.45,
        usdValue: 123.45,
        priceImpact: 0,
        conversionRate: 2.5,
        gasFeeUsd: 0.5,
        estimatedTime: 1_700_000_000,
        tag: "NONE",
        route: {
          id: "solver-bot",
          name: "Solver Bot",
        },
      },
    ];

    reply!.emit("client-rfq.status", { stage: "quoting" });
    expect(statusSpy).toHaveBeenCalledWith({ stage: "quoting" });

    reply!.emit("client-rfq.quote", quotePayload);

    await expect(quotePromise).resolves.toEqual({
      bucket,
      quotes: quotePayload,
    });
  });

  it("rejects when an RFQ error is emitted", async () => {
    const helper = new iLayerRfqHelper(helperOptions);

    const quotePromise = helper.requestQuote(baseRequest, { timeoutMs: 1000 });

    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    const broadcast = channels.get("private-rfq.broadcast")!;
    const [, requestPayload] = broadcast.trigger.mock.calls[0];
    const bucket = (requestPayload as { bucket: string }).bucket;
    const reply = channels.get(`private-rfq.${bucket}`)!;

    reply.emit("client-rfq.error", { code: "FAIL", message: "boom" });

    await expect(quotePromise).rejects.toThrow("boom");
  });

  it("disconnect forwards to the underlying pusher instance", () => {
    const helper = new iLayerRfqHelper(helperOptions);
    helper.disconnect();
    expect(disconnectMock).toHaveBeenCalled();
  });
});
