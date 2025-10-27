import Pusher, { type Channel } from "pusher-js";
import {
  RfqErrorPayload,
  RfqLegRequest,
  RfqQuoteRequestPayload,
  RfqQuoteResponsePayload,
  RfqStatusPayload,
} from "../types";

export type RfqRequestOptions = {
  bucket?: string;
  timeoutMs?: number;
  onStatus?: (status: RfqStatusPayload) => void;
  onError?: (error: RfqErrorPayload) => void;
};

export type RfqQuoteResult = {
  bucket: string;
  quote: RfqQuoteResponsePayload;
};

export type iLayerRfqHelperOptions = {
  key: string;
  host?: string;
  port?: number;
  useTLS?: boolean;
  cluster?: string;
  authEndpoint: string;
  authHeaders?: Record<string, string>;
  authParams?: Record<string, string>;
  timeoutMs?: number;
  transports?: Array<"ws" | "wss">;
};

const defaultBucket = () => {
  const globalObj = globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: (values: Uint8Array) => Uint8Array;
    };
  };

  const uuid = globalObj.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, "");

  if (globalObj.crypto?.getRandomValues) {
    const buffer = globalObj.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(buffer, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }

  return `bucket_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const normaliseLeg = (leg: RfqLegRequest) => ({
  network: leg.network,
  tokens: leg.tokens.map((token) => ({
    address: token.address,
    amount: token.amount.toString(),
  })),
});

const ensureRuntime = () => {
  if (typeof window !== "undefined") return;
  const runtime = (Pusher as unknown as { Runtime?: { createWebSocket?: unknown } })
    .Runtime;
  if (!runtime || runtime.createWebSocket) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const WS = require("ws");
    runtime.createWebSocket = (url: string) => new WS(url);
  } catch {
    /* ignore – ws is optional in browser builds */
  }
};

export class iLayerRfqHelper {
  private readonly options: iLayerRfqHelperOptions;

  private readonly pusher: Pusher;

  private readonly channels = new Map<string, Channel>();

  private readonly pendingChannels = new Map<string, Promise<Channel>>();

  constructor(options: iLayerRfqHelperOptions) {
    this.options = options;
    ensureRuntime();

    const {
      key,
      host,
      port,
      useTLS = false,
      cluster = "mt1",
      authEndpoint,
      authHeaders,
      authParams,
      transports,
    } = options;

    this.pusher = new Pusher(key, {
      cluster,
      wsHost: host,
      wsPort: port,
      wssPort: port,
      forceTLS: useTLS,
      enabledTransports: transports ?? (useTLS ? ["wss"] : ["ws"]),
      disableStats: true,
      authEndpoint,
      auth: {
        headers: authHeaders,
        params: authParams,
      },
    });
  }

  async requestQuote(
    payload: RfqQuoteRequestPayload,
    options: RfqRequestOptions = {},
  ): Promise<RfqQuoteResult> {
    const bucket = options.bucket ?? payload.bucket ?? defaultBucket();
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30000;

    const replyChannelName = `private-rfq.${bucket}`;
    const replyChannel = await this.getChannel(replyChannelName);
    const broadcastChannel = await this.getChannel("private-rfq.broadcast");

    const normalisedRequest = {
      bucket,
      from: normaliseLeg(payload.from),
      to: normaliseLeg(payload.to),
    };

    return new Promise<RfqQuoteResult>((resolve, reject) => {
      const cleanup = () => {
        replyChannel.unbind("client-rfq.status", statusHandler as any);
        replyChannel.unbind("client-rfq.error", errorHandler as any);
        replyChannel.unbind("client-rfq.quote", quoteHandler as any);
        clearTimeout(timer);
      };

      const rejectWithError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const statusHandler = (status: RfqStatusPayload) => {
        options.onStatus?.(status);
        if (status.stage.toLowerCase() === "failed") {
          rejectWithError(
            new Error(status.note ?? "RFQ failed with unknown error"),
          );
        }
      };

      const errorHandler = (error: RfqErrorPayload) => {
        options.onError?.(error);
        rejectWithError(new Error(error.message));
      };

      const quoteHandler = (quote: RfqQuoteResponsePayload) => {
        cleanup();
        resolve({ bucket, quote });
      };

      const timer = setTimeout(() => {
        rejectWithError(new Error("RFQ timeout"));
      }, timeoutMs);

      replyChannel.bind("client-rfq.status", statusHandler as any);
      replyChannel.bind("client-rfq.error", errorHandler as any);
      replyChannel.bind("client-rfq.quote", quoteHandler as any);

      (broadcastChannel as unknown as { trigger: Function }).trigger(
        "client-rfq.request",
        normalisedRequest,
      );
    });
  }

  onBucket(
    bucket: string,
    handlers: {
      status?: (status: RfqStatusPayload) => void;
      quote?: (quote: RfqQuoteResponsePayload) => void;
      error?: (error: RfqErrorPayload) => void;
    },
  ): () => void {
    const channelName = `private-rfq.${bucket}`;
    const removeHandlers = () => {
      const existing = this.channels.get(channelName);
      if (!existing) return;
      if (handlers.status)
        existing.unbind("client-rfq.status", handlers.status as any);
      if (handlers.quote)
        existing.unbind("client-rfq.quote", handlers.quote as any);
      if (handlers.error)
        existing.unbind("client-rfq.error", handlers.error as any);
    };

    void this.getChannel(channelName).then((channel) => {
      if (handlers.status)
        channel.bind("client-rfq.status", handlers.status as any);
      if (handlers.quote)
        channel.bind("client-rfq.quote", handlers.quote as any);
      if (handlers.error)
        channel.bind("client-rfq.error", handlers.error as any);
    });

    return removeHandlers;
  }

  disconnect(): void {
    for (const name of this.channels.keys()) {
      this.pusher.unsubscribe(name);
    }
    this.channels.clear();
    this.pendingChannels.clear();
    this.pusher.disconnect();
  }

  private async getChannel(name: string): Promise<Channel> {
    const cached = this.channels.get(name);
    if (cached) return cached;

    const pending = this.pendingChannels.get(name);
    if (pending) return pending;

    const channel = this.pusher.subscribe(name);
    const subscription = this.waitForSubscription(channel)
      .then(() => {
        this.channels.set(name, channel);
        this.pendingChannels.delete(name);
        return channel;
      })
      .catch((error) => {
        this.pendingChannels.delete(name);
        this.pusher.unsubscribe(name);
        throw error;
      });

    this.pendingChannels.set(name, subscription);
    return subscription;
  }

  private waitForSubscription(channel: Channel, ms = 5000) {
    return new Promise<void>((resolve, reject) => {
      const onSuccess = () => {
        cleanup();
        resolve();
      };
      const onError = (status: unknown) => {
        cleanup();
        reject(new Error(`subscription error: ${status}`));
      };
      const cleanup = () => {
        channel.unbind("pusher:subscription_succeeded", onSuccess as any);
        channel.unbind("pusher:subscription_error", onError as any);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("subscription timeout"));
      }, ms);

      channel.bind("pusher:subscription_succeeded", onSuccess as any);
      channel.bind("pusher:subscription_error", onError as any);
    });
  }
}
