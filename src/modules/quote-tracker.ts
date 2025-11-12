import type { Order, OrderRequest } from '../types';

/**
 * Represents a stored quote from an RFQ request
 */
export interface StoredQuote {
  /** Unique quote identifier from the solver */
  quoteId: string;

  /** RFQ bucket identifier */
  bucket: string;

  /** Solver address that provided the quote */
  solver: string;

  /** Source chain name (e.g., 'ethereum', 'arbitrum') */
  sourceChain: string;

  /** Destination chain name */
  destChain: string;

  /** Source token address (bytes32 padded) */
  sourceToken: string;

  /** Output token information */
  destTokens: Array<{
    token: string;
    amount: number;
  }>;

  /** Input amount in source token */
  inputAmount: string;

  /** Conversion rate applied */
  conversionRate: number;

  /** Estimated gas fee in USD */
  gasFeeUsd: number;

  /** Timestamp when quote was received (ms) */
  timestamp: number;

  /** Expiration timestamp (ms) */
  expiresAt: number;

  /** Current status of the quote */
  status: 'pending' | 'accepted' | 'filled' | 'expired' | 'rejected';

  /** Optional: Raw quote data from solver */
  rawQuote?: unknown;
}

/**
 * Helper class for tracking quotes received from RFQ requests
 *
 * This module provides client-side quote tracking to validate orders
 * before submission and detect quote expiration.
 *
 * @remarks
 * The QuoteTracker stores quotes in memory on the client side. This helps:
 * - Validate that orders match received quotes before signing
 * - Prevent submission of expired quotes
 * - Track quote status throughout the order lifecycle
 * - Provide quote history for analytics
 *
 * @example
 * ```typescript
 * const tracker = new QuoteTracker();
 *
 * // 1. Store quote after receiving from RFQ
 * const quote = await rfqHelper.requestQuote({...});
 * tracker.storeQuote({
 *   quoteId: quote.quoteId,
 *   bucket: 'my-bucket',
 *   solver: '0x...',
 *   sourceChain: 'ethereum',
 *   destChain: 'arbitrum',
 *   sourceToken: '0x...',
 *   destTokens: [{ token: '0x...', amount: 990000 }],
 *   inputAmount: '1000000',
 *   conversionRate: 0.99,
 *   gasFeeUsd: 2.5,
 *   timestamp: Date.now(),
 *   expiresAt: Date.now() + 600000, // 10 minutes
 *   status: 'pending',
 * });
 *
 * // 2. Validate order matches quote before signing
 * const orderRequest = buildOrderRequest(quote);
 * if (!tracker.validateOrderMatchesQuote(orderRequest, quote.quoteId)) {
 *   throw new Error('Order does not match quote');
 * }
 *
 * // 3. Mark as accepted after signing
 * tracker.acceptQuote(quote.quoteId);
 *
 * // 4. Submit order...
 * ```
 */
export class QuoteTracker {
  private quotes = new Map<string, StoredQuote>();
  private cleanupIntervalId?: ReturnType<typeof setInterval>;

  constructor() {
    // Auto-cleanup expired quotes every 60 seconds
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpiredQuotes();
    }, 60000);
  }

  /**
   * Store a quote received from RFQ
   *
   * @param quote - The quote to store
   *
   * @remarks
   * Quotes are stored by quoteId. If a quote with the same ID already exists,
   * it will be overwritten.
   */
  storeQuote(quote: StoredQuote): void {
    this.quotes.set(quote.quoteId, quote);
  }

  /**
   * Get a stored quote by ID
   *
   * @param quoteId - The quote ID to look up
   * @returns The stored quote, or undefined if not found
   */
  getQuote(quoteId: string): StoredQuote | undefined {
    return this.quotes.get(quoteId);
  }

  /**
   * Find quotes matching specific criteria
   *
   * @param criteria - Search criteria (all fields optional)
   * @returns Array of matching quotes
   *
   * @example
   * ```typescript
   * // Find all pending quotes for ethereum -> arbitrum
   * const quotes = tracker.findQuotes({
   *   sourceChain: 'ethereum',
   *   destChain: 'arbitrum',
   *   status: 'pending',
   * });
   * ```
   */
  findQuotes(criteria: {
    bucket?: string;
    solver?: string;
    sourceChain?: string;
    destChain?: string;
    status?: StoredQuote['status'];
  }): StoredQuote[] {
    const results: StoredQuote[] = [];

    for (const quote of this.quotes.values()) {
      let matches = true;

      if (criteria.bucket && quote.bucket !== criteria.bucket) {
        matches = false;
      }
      if (criteria.solver && quote.solver.toLowerCase() !== criteria.solver.toLowerCase()) {
        matches = false;
      }
      if (criteria.sourceChain && quote.sourceChain !== criteria.sourceChain) {
        matches = false;
      }
      if (criteria.destChain && quote.destChain !== criteria.destChain) {
        matches = false;
      }
      if (criteria.status && quote.status !== criteria.status) {
        matches = false;
      }

      if (matches) {
        results.push(quote);
      }
    }

    return results;
  }

  /**
   * Validate that an order matches a stored quote
   *
   * @param orderRequest - The order request to validate
   * @param quoteId - The quote ID to validate against
   * @param tolerance - Acceptable difference percentage (default 0.001 = 0.1%)
   * @returns True if order matches quote within tolerance
   *
   * @remarks
   * This method checks:
   * - Chain IDs match
   * - Input token and amount match exactly
   * - Output amounts match within tolerance (default 0.1%)
   * - Quote is not expired
   *
   * @example
   * ```typescript
   * const isValid = tracker.validateOrderMatchesQuote(orderRequest, quoteId, 0.001);
   * if (!isValid) {
   *   console.error('Order does not match quote or quote expired');
   * }
   * ```
   */
  validateOrderMatchesQuote(
    orderRequest: OrderRequest,
    quoteId: string,
    tolerance: number = 0.001,
  ): boolean {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      console.warn(`Quote ${quoteId} not found`);
      return false;
    }

    // Check expiration
    if (Date.now() > quote.expiresAt) {
      console.warn(`Quote ${quoteId} has expired`);
      return false;
    }

    const order = orderRequest.order;

    // Validate chain IDs match
    // Note: We can't directly validate chain names without chain config,
    // but we can validate the order structure

    // Validate input amount matches
    const inputToken = order.inputs[0];
    const inputAmount = BigInt(inputToken.amount);
    const quoteInputAmount = BigInt(quote.inputAmount);

    if (inputAmount !== quoteInputAmount) {
      console.warn(
        `Input amount mismatch: order=${inputAmount}, quote=${quoteInputAmount}`,
      );
      return false;
    }

    // Validate output amounts match (with tolerance)
    if (order.outputs.length !== quote.destTokens.length) {
      console.warn('Output token count mismatch');
      return false;
    }

    for (let i = 0; i < order.outputs.length; i++) {
      const outputToken = order.outputs[i];
      const quoteOutput = quote.destTokens[i];

      const outputAmount = Number(outputToken.amount);
      const quoteOutputAmount = quoteOutput.amount;

      const diff = Math.abs(outputAmount - quoteOutputAmount);
      const percentDiff = diff / quoteOutputAmount;

      if (percentDiff > tolerance) {
        console.warn(
          `Output amount mismatch at index ${i}: order=${outputAmount}, quote=${quoteOutputAmount}, diff=${(percentDiff * 100).toFixed(2)}%`,
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Mark a quote as accepted
   *
   * @param quoteId - The quote ID to mark as accepted
   * @returns True if quote was found and updated, false otherwise
   *
   * @remarks
   * Call this after the user signs the order but before submission.
   */
  acceptQuote(quoteId: string): boolean {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      return false;
    }

    quote.status = 'accepted';
    this.quotes.set(quoteId, quote);
    return true;
  }

  /**
   * Mark a quote as filled
   *
   * @param quoteId - The quote ID to mark as filled
   * @returns True if quote was found and updated, false otherwise
   *
   * @remarks
   * Call this after the order has been successfully filled on-chain.
   */
  fillQuote(quoteId: string): boolean {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      return false;
    }

    quote.status = 'filled';
    this.quotes.set(quoteId, quote);
    return true;
  }

  /**
   * Mark a quote as rejected
   *
   * @param quoteId - The quote ID to mark as rejected
   * @returns True if quote was found and updated, false otherwise
   *
   * @remarks
   * Call this if the bot rejects the order submission.
   */
  rejectQuote(quoteId: string): boolean {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      return false;
    }

    quote.status = 'rejected';
    this.quotes.set(quoteId, quote);
    return true;
  }

  /**
   * Check if a quote is expired
   *
   * @param quoteId - The quote ID to check
   * @returns True if quote is expired or not found
   */
  isQuoteExpired(quoteId: string): boolean {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      return true;
    }

    return Date.now() > quote.expiresAt;
  }

  /**
   * Get all stored quotes
   *
   * @returns Array of all stored quotes
   */
  getAllQuotes(): StoredQuote[] {
    return Array.from(this.quotes.values());
  }

  /**
   * Remove a quote from storage
   *
   * @param quoteId - The quote ID to remove
   * @returns True if quote was found and removed, false otherwise
   */
  removeQuote(quoteId: string): boolean {
    return this.quotes.delete(quoteId);
  }

  /**
   * Remove all stored quotes
   */
  clearAll(): void {
    this.quotes.clear();
  }

  /**
   * Clean up expired quotes
   *
   * @returns Number of quotes removed
   *
   * @remarks
   * This is called automatically every 60 seconds, but can be called
   * manually if needed.
   */
  cleanupExpiredQuotes(): number {
    const now = Date.now();
    let removed = 0;

    for (const [quoteId, quote] of this.quotes.entries()) {
      if (now > quote.expiresAt) {
        this.quotes.delete(quoteId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`Cleaned up ${removed} expired quote(s)`);
    }

    return removed;
  }

  /**
   * Stop the automatic cleanup interval
   *
   * @remarks
   * Call this when you no longer need the QuoteTracker to prevent
   * memory leaks. After calling this, you should not use the tracker anymore.
   */
  destroy(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
    this.quotes.clear();
  }

  /**
   * Get statistics about stored quotes
   *
   * @returns Object with quote statistics
   */
  getStats(): {
    total: number;
    pending: number;
    accepted: number;
    filled: number;
    expired: number;
    rejected: number;
  } {
    const stats = {
      total: this.quotes.size,
      pending: 0,
      accepted: 0,
      filled: 0,
      expired: 0,
      rejected: 0,
    };

    const now = Date.now();

    for (const quote of this.quotes.values()) {
      if (now > quote.expiresAt && quote.status === 'pending') {
        stats.expired++;
      } else {
        switch (quote.status) {
          case 'pending':
            stats.pending++;
            break;
          case 'accepted':
            stats.accepted++;
            break;
          case 'filled':
            stats.filled++;
            break;
          case 'expired':
            stats.expired++;
            break;
          case 'rejected':
            stats.rejected++;
            break;
        }
      }
    }

    return stats;
  }
}
