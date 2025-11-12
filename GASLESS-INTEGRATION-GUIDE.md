# Gasless Order Integration Guide

This guide shows how to use the new SDK features to submit gasless orders via the iLayer solver bot.

## Overview

The SDK now supports gasless order submission, where the solver bot pays gas on behalf of users. This enables a seamless UX where users can perform cross-chain swaps without needing native tokens on the source chain.

## New Modules

### 1. `iLayerSigningHelper`
Handles EIP-712 signature generation for order requests.

### 2. `QuoteTracker`
Client-side quote tracking and validation.

### 3. `submitOrderGasless()` method
Submits signed orders to the bot for gasless execution.

## Complete Flow Example

```typescript
import {
  iLayerRfqHelper,
  iLayerContractHelper,
  iLayerSigningHelper,
  QuoteTracker,
} from '@ilayer/sdk';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

// Initialize helpers
const rfqHelper = new iLayerRfqHelper();
const contractHelper = new iLayerContractHelper();
const signingHelper = new iLayerSigningHelper();
const quoteTracker = new QuoteTracker();

// Setup wallet client
const account = privateKeyToAccount('0x...');
const walletClient = createWalletClient({
  account,
  chain: mainnet,
  transport: http(),
});

async function submitGaslessOrder() {
  // Step 1: Request quote via RFQ
  const quote = await rfqHelper.requestQuote(
    {
      sourceChain: 'ethereum',
      destinationChain: 'arbitrum',
      sourceToken: 'USDC',
      destinationToken: 'USDC',
      amount: '1000000', // 1 USDC (6 decimals)
      user: account.address,
    },
    {
      soketiHost: 'soketi.ilayer.io',
      soketiPort: 443,
      soketiKey: 'your-soketi-key',
      soketiSecret: 'your-soketi-secret',
      bucket: 'my-app-bucket',
    },
  );

  if (!quote.success) {
    throw new Error('Failed to get quote');
  }

  console.log('Received quote:', {
    quoteId: quote.quoteId,
    receiveAmount: quote.destTokens[0].amount,
    solver: quote.solver,
  });

  // Step 2: Store quote for tracking
  quoteTracker.storeQuote({
    quoteId: quote.quoteId,
    bucket: 'my-app-bucket',
    solver: quote.solver,
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    sourceToken: quote.sourceToken,
    destTokens: quote.destTokens,
    inputAmount: quote.inputAmount,
    conversionRate: quote.conversionRate,
    gasFeeUsd: quote.gasFeeUsd || 0,
    timestamp: Date.now(),
    expiresAt: Date.now() + 600000, // 10 minutes
    status: 'pending',
    rawQuote: quote,
  });

  // Step 3: Build order request from quote
  const now = Math.floor(Date.now() / 1000);
  const orderRequest = {
    nonce: 1, // Get from contract: await orderHub.nonce()
    deadline: now + 3600, // 1 hour
    order: {
      user: contractHelper.formatAddressToBytes32(account.address),
      filler: contractHelper.formatAddressToBytes32(quote.solver),
      recipient: contractHelper.formatAddressToBytes32(account.address),
      callRecipient: contractHelper.formatAddressToBytes32(account.address),
      callValue: 0,
      callData: '0x',
      sponsored: false,
      primaryFillerDeadline: now + 1800, // 30 minutes (must be < deadline)
      deadline: now + 3600,
      sourceChainId: 1, // Ethereum mainnet
      destinationChainId: 42161, // Arbitrum
      inputs: [
        {
          tokenType: 2, // ERC20
          tokenAddress: contractHelper.formatAddressToBytes32('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), // USDC
          tokenId: 0,
          amount: '1000000',
        },
      ],
      outputs: [
        {
          tokenType: 2, // ERC20
          tokenAddress: contractHelper.formatAddressToBytes32('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'), // USDC on Arbitrum
          tokenId: 0,
          amount: quote.destTokens[0].amount.toString(),
        },
      ],
    },
  };

  // Step 4: Validate order matches quote
  const isValid = quoteTracker.validateOrderMatchesQuote(
    orderRequest,
    quote.quoteId,
    0.001, // 0.1% tolerance
  );

  if (!isValid) {
    throw new Error('Order does not match quote or quote expired');
  }

  // Step 5: Sign order with EIP-712
  const signature = await signingHelper.signOrderRequest(
    orderRequest,
    walletClient,
    1, // Ethereum mainnet chain ID
    '0x1234567890123456789012345678901234567890', // OrderHub contract address
  );

  console.log('Order signed:', signature);

  // Step 6: Generate order ID
  const orderId = signingHelper.generateOrderId(orderRequest);

  console.log('Order ID:', orderId);

  // Step 7: Mark quote as accepted
  quoteTracker.acceptQuote(quote.quoteId);

  // Step 8: Submit gasless order to bot
  const result = await contractHelper.submitOrderGasless(
    orderRequest,
    signature,
    orderId,
    'https://bot.ilayer.io', // Bot API endpoint
  );

  console.log('Order submitted successfully!', {
    txHash: result.txHash,
    orderId: result.orderId,
  });

  // Step 9: Mark quote as filled (after confirmation)
  quoteTracker.fillQuote(quote.quoteId);

  return result;
}

// Run the flow
submitGaslessOrder()
  .then((result) => {
    console.log('Success:', result);
    quoteTracker.destroy(); // Cleanup
  })
  .catch((error) => {
    console.error('Error:', error);
    quoteTracker.destroy(); // Cleanup
  });
```

## Quote Tracking Features

### Store and Validate Quotes

```typescript
const tracker = new QuoteTracker();

// Store quote after receiving
tracker.storeQuote({
  quoteId: 'quote-123',
  bucket: 'my-bucket',
  solver: '0x...',
  sourceChain: 'ethereum',
  destChain: 'arbitrum',
  sourceToken: '0x...',
  destTokens: [{ token: '0x...', amount: 990000 }],
  inputAmount: '1000000',
  conversionRate: 0.99,
  gasFeeUsd: 2.5,
  timestamp: Date.now(),
  expiresAt: Date.now() + 600000,
  status: 'pending',
});

// Validate order matches quote
const isValid = tracker.validateOrderMatchesQuote(orderRequest, 'quote-123');

// Check expiration
const isExpired = tracker.isQuoteExpired('quote-123');

// Find quotes by criteria
const pendingQuotes = tracker.findQuotes({
  sourceChain: 'ethereum',
  destChain: 'arbitrum',
  status: 'pending',
});

// Get statistics
const stats = tracker.getStats();
console.log('Quotes:', stats);
```

### Quote Status Lifecycle

```typescript
// 1. Initial state after receiving quote
tracker.storeQuote({ ...quote, status: 'pending' });

// 2. After user signs order
tracker.acceptQuote(quoteId);

// 3. After order is filled on-chain
tracker.fillQuote(quoteId);

// OR if bot rejects
tracker.rejectQuote(quoteId);
```

## EIP-712 Signing

### Basic Signing

```typescript
const signingHelper = new iLayerSigningHelper();

const signature = await signingHelper.signOrderRequest(
  orderRequest,
  walletClient,
  chainId,
  orderHubAddress,
);
```

### Signature Verification

```typescript
const isValid = await signingHelper.verifySignature(
  orderRequest,
  signature,
  expectedSignerAddress,
  chainId,
  orderHubAddress,
);
```

### Generate Order ID

```typescript
const orderId = signingHelper.generateOrderId(orderRequest);
```

## Error Handling

```typescript
try {
  const result = await contractHelper.submitOrderGasless(
    orderRequest,
    signature,
    orderId,
    botEndpoint,
  );
} catch (error) {
  if (error.message.includes('Invalid signature')) {
    console.error('Signature validation failed');
  } else if (error.message.includes('quote')) {
    console.error('Quote expired or not found');
  } else if (error.message.includes('Bot rejected')) {
    console.error('Bot rejected the order:', error.message);
  } else {
    console.error('Unknown error:', error);
  }
}
```

## Integration Checklist

- [ ] Install/update SDK: `npm install @ilayer/sdk@latest`
- [ ] Setup Soketi connection for RFQ
- [ ] Initialize QuoteTracker for quote management
- [ ] Request quotes via `iLayerRfqHelper`
- [ ] Store quotes in QuoteTracker
- [ ] Build order request from quote
- [ ] Validate order matches quote
- [ ] Sign order with `iLayerSigningHelper`
- [ ] Submit gasless order via `submitOrderGasless()`
- [ ] Track order status and update quote tracker
- [ ] Cleanup tracker on unmount: `tracker.destroy()`

## Advanced: React Hook Example

```typescript
import { useEffect, useState } from 'react';
import {
  iLayerRfqHelper,
  iLayerContractHelper,
  iLayerSigningHelper,
  QuoteTracker,
} from '@ilayer/sdk';

export function useGaslessOrder() {
  const [quoteTracker] = useState(() => new QuoteTracker());
  const [rfqHelper] = useState(() => new iLayerRfqHelper());
  const [contractHelper] = useState(() => new iLayerContractHelper());
  const [signingHelper] = useState(() => new iLayerSigningHelper());

  useEffect(() => {
    return () => {
      quoteTracker.destroy();
    };
  }, [quoteTracker]);

  const requestQuoteAndSubmit = async (params) => {
    // 1. Request quote
    const quote = await rfqHelper.requestQuote(params.rfqPayload, params.rfqOptions);

    // 2. Store quote
    quoteTracker.storeQuote({
      quoteId: quote.quoteId,
      // ... other fields
    });

    // 3. Build order
    const orderRequest = buildOrderRequest(quote, params.user);

    // 4. Validate
    if (!quoteTracker.validateOrderMatchesQuote(orderRequest, quote.quoteId)) {
      throw new Error('Invalid quote');
    }

    // 5. Sign
    const signature = await signingHelper.signOrderRequest(
      orderRequest,
      params.walletClient,
      params.chainId,
      params.orderHubAddress,
    );

    // 6. Submit
    const orderId = signingHelper.generateOrderId(orderRequest);
    quoteTracker.acceptQuote(quote.quoteId);

    const result = await contractHelper.submitOrderGasless(
      orderRequest,
      signature,
      orderId,
      params.botEndpoint,
    );

    quoteTracker.fillQuote(quote.quoteId);

    return result;
  };

  return {
    requestQuoteAndSubmit,
    quoteTracker,
    rfqHelper,
    contractHelper,
    signingHelper,
  };
}
```

## Configuration

### Bot Endpoint

The bot endpoint should be configured based on environment:

```typescript
const BOT_ENDPOINTS = {
  mainnet: 'https://bot.ilayer.io',
  testnet: 'https://bot-testnet.ilayer.io',
  local: 'http://localhost:5050',
};

const botEndpoint = BOT_ENDPOINTS[process.env.NETWORK || 'mainnet'];
```

### Soketi Configuration

```typescript
const SOKETI_CONFIG = {
  mainnet: {
    host: 'soketi.ilayer.io',
    port: 443,
    key: 'your-production-key',
    secret: 'your-production-secret',
  },
  testnet: {
    host: 'soketi-testnet.ilayer.io',
    port: 443,
    key: 'your-testnet-key',
    secret: 'your-testnet-secret',
  },
};
```

## Troubleshooting

### "Invalid signature format"
- Ensure signature is 132 characters (0x + 130 hex chars)
- Check that walletClient has an account attached

### "Quote not found"
- Verify quote was stored in QuoteTracker before validation
- Check that quoteId matches exactly

### "Quote expired"
- Quotes typically expire in 10 minutes
- Request a fresh quote if expired

### "Bot rejected order"
- Check that order amounts match the quote
- Verify quote hasn't expired on bot side
- Ensure nonce is correct (get from contract)

### "Order does not match quote"
- Verify input/output amounts match exactly
- Check chain IDs are correct
- Ensure token addresses are bytes32 padded

## Summary

The SDK now provides complete support for gasless order submission:

1. **EIP-712 Signing**: Generate and verify typed data signatures
2. **Quote Tracking**: Store, validate, and manage quotes client-side
3. **Gasless Submission**: Submit signed orders to bot via HTTP API

All features are backward compatible - existing code continues to work without changes.
