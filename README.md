# iLayer SDK

A TypeScript library for interacting with the iLayer smart contracts and RFQ network.

## Installation

Install the package using npm, yarn or pnpm:

```bash
npm install @ilayer/sdk
```

## RFQ quick start

Create an RFQ helper pointed at your Soketi instance. You **must** provide an
`authEndpoint` that proxies to the solver bot's `/soketi/auth` route so that the
client can join the private RFQ channels.

```ts
import { iLayerRfqHelper } from "@ilayer/sdk";

const rfq = new iLayerRfqHelper({
  key: process.env.NEXT_PUBLIC_SOKETI_KEY!,
  host: "localhost",
  port: 6001,
  authEndpoint: "/api/soketi/auth", // your backend proxy
});
```

Request a quote by publishing an RFQ message. The helper handles channel
subscription, status updates and error propagation automatically.

```ts
const { bucket, quote } = await rfq.requestQuote(
  {
    from: {
      network: "arbitrum",
      tokens: [{ address: ARBITRUM_USDC, amount: 1_000_000n }],
    },
    to: {
      network: "base",
      tokens: [{ address: BASE_WETH, amount: 0 }],
    },
  },
  {
    onStatus: (status) => console.log("RFQ status", status),
    onError: (error) => console.error("RFQ rejected", error),
  },
);

console.log("solver quote", quote);
```

If you need to observe an RFQ from another context (for example a UI listening to
updates produced by an existing bucket), use `onBucket`:

```ts
const stop = rfq.onBucket(bucket, {
  status: (s) => console.log("status", s),
  quote: (q) => console.log("quote", q),
});

// later
stop();
```

When the helper is no longer needed, disconnect to release sockets and handlers:

```ts
rfq.disconnect();
```


### Command-line demo

The repository ships with a small CLI helper that exercises the RFQ flow end-to-end. Provide the Soketi credentials and the networks you want to test via environment variables, then run the script:

```
SOKETI_APP_KEY=app-key
SOKETI_HOST=127.0.0.1
SOKETI_PORT=6001
SOKETI_TLS=false
SOKETI_AUTH_ENDPOINT=https://your-backend.example.com/api/soketi/auth
# optional overrides
RFQ_SOURCE_CHAIN=arbitrum
RFQ_DEST_CHAIN=base
RFQ_FROM_TOKEN=0xaf88d065e77c8CC2239327C5EDb3A432268e5831
RFQ_TO_TOKEN=0x4200000000000000000000000000000000000006
RFQ_AMOUNT=1000000
```

Then run:

```bash
npm run demo:rfq
```

The script connects to Soketi, publishes an RFQ, and prints the status / quote / error events returned by the solver so you can smoke-test a deployment from the terminal.

## Contract helper (EVM)

The contract helper exposes utilities that encode call data for the iLayer smart
contracts on EVM-compatible blockchains.

```ts
import { iLayerContractHelper } from "@ilayer/sdk";

const helper = new iLayerContractHelper();

const data = helper.createOrder(orderRequest, permits, signature);
const withdrawData = helper.withdrawOrder(order, orderNonce);
```

The helper also exposes address formatting helpers when dealing with bytes32
contract fields:

```ts
const address = "0x1234567890abcdef1234567890abcdef12345678";
const bytes32address = helper.formatAddressToBytes32(address);
const formattedAddress = helper.formatBytes32ToAddress(bytes32address);
```
