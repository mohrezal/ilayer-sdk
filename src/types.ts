export enum Type {
  NULL = 0,
  NATIVE = 1,
  FUNGIBLE_TOKEN = 2,
  NON_FUNGIBLE_TOKEN = 3,
  SEMI_FUNGIBLE_TOKEN = 4,
}

export type Token = {
  tokenType: Type;
  tokenAddress: `0x${string}`; // hex‐encoded bytes32
  tokenId: bigint; // uint256
  amount: bigint; // uint256
};

export type Order = {
  user: `0x${string}`; // bytes32
  recipient: `0x${string}`; // bytes32
  filler: `0x${string}`; // bytes32
  inputs: Token[];
  outputs: Token[];
  sourceChainId: number; // uint32
  destinationChainId: number; // uint32
  sponsored: boolean;
  primaryFillerDeadline: bigint; // uint64
  deadline: bigint; // uint64
  callRecipient: `0x${string}`; // bytes32
  callData: `0x${string}`; // hex‐encoded bytes
  callValue: bigint; // uint256
};

export type OrderRequest = {
  deadline: bigint;
  nonce: bigint;
  order: Order;
};

export type RfqRequest = {
  /**
   * @deprecated Legacy RFQ request structure. Prefer {@link RfqQuoteRequestPayload}.
   */
  id: string;
  user: `0x${string}`;
  recipient: `0x${string}`;
  inputs: Token[];
  sourceChainId: number;
  destinationChainId: number;
  sponsored: boolean;
  primaryFillerDeadline: bigint;
  deadline: bigint;
  callRecipient: `0x${string}`;
  callData: `0x${string}`;
  callValue: bigint;
};

export type RfqResponse = Order & {
  /**
   * @deprecated Legacy RFQ response structure. Prefer {@link RfqQuoteResponsePayload}.
   */
  id: string;
};

export type RfqTokenAmountInput = {
  address: string;
  amount: string | number | bigint;
};

export type RfqLegRequest = {
  network: string;
  tokens: RfqTokenAmountInput[];
};

export type RfqTokenAmountQuote = {
  address: string;
  amount: number;
};

export type RfqLegQuote = {
  network: string;
  tokens: RfqTokenAmountQuote[];
};

export type RfqQuoteRequestPayload = {
  bucket?: string;
  from: RfqLegRequest;
  to: RfqLegRequest;
};

export type QuoteTag = "FASTEST" | "BEST RETURN" | "NONE";

export type QuoteRoute = {
  id: string;
  name: string;
};

export type Quote = {
  id: string;
  receiveAmount: number;
  usdValue: number;
  priceImpact: number;
  conversionRate: number;
  gasFeeUsd: number;
  estimatedTime: number;
  tag: QuoteTag;
  route: QuoteRoute;
  source: string;
  destination: string;
  usdtDestinationAmount: number;
};

export type RfqQuoteResponsePayload = Quote[];

export type RfqStatusPayload = {
  stage: string;
  note?: string;
};

export type RfqErrorPayload = {
  code: string;
  message: string;
  solverId?: string;
};
