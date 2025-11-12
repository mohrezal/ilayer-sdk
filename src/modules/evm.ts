import {
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  parseAbiParameters,
  type Hex,
} from "viem";
import { Order, OrderRequest, Type } from "../types";
import { HUB_ABI } from "../abi/hub";
import { NULL_STRING } from "../constants";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import { LZ_ROUTER_ABI } from "../abi/lzRouter";

export class iLayerContractHelper {
  createOrder(
    orderRequest: OrderRequest,
    permits: `0x${string}`[],
    signature: `0x${string}`,
    bridgeSelector: number,
    extra?: `0x${string}`,
  ) {
    const {
      user,
      recipient,
      filler,
      inputs,
      outputs,
      primaryFillerDeadline,
      deadline,
    } = orderRequest.order;

    [
      ["user", user],
      ["recipient", recipient],
      ["filler", filler] as const,
    ].forEach(([name, addr]) => {
      if (!this.checkAddress(addr)) {
        throw new Error(`${name} address is not a valid bytes32-padded string`);
      }
    });

    [...inputs, ...outputs].forEach((token, idx) => {
      if (!this.checkAddress(token.tokenAddress)) {
        throw new Error(
          `tokenAddress at ${inputs.includes(token) ? "inputs" : "outputs"}[${idx}] is not a valid bytes32-padded string`,
        );
      }
    });

    const now = Math.floor(Date.now() / 1000);
    if (primaryFillerDeadline <= now) {
      throw new Error("primaryFillerDeadline must be in the future");
    }
    if (deadline <= now) {
      throw new Error("deadline must be in the future");
    }
    if (primaryFillerDeadline >= deadline) {
      throw new Error(
        "primaryFillerDeadline must be strictly less than the overall order deadline",
      );
    }

    return encodeFunctionData({
      abi: HUB_ABI,
      functionName: "createOrder",
      args: [
        orderRequest,
        permits,
        signature,
        bridgeSelector,
        extra || NULL_STRING,
      ] as const,
    });
  }

  withdrawOrder(order: Order, orderNonce: bigint) {
    const now = Math.floor(Date.now() / 1000);
    if (order.deadline > now) {
      throw new Error("Order not withdrawable yet");
    }

    return encodeFunctionData({
      abi: HUB_ABI,
      functionName: "withdrawOrder",
      args: [order, orderNonce] as const,
    });
  }

  computeOrderNativeValue(order: Order, bridgingFee?: bigint): bigint {
    if (bridgingFee && order.sourceChainId == order.destinationChainId) {
      throw new Error("Invalid order, chain IDs are the same");
    }
    if (!bridgingFee && order.sourceChainId != order.destinationChainId) {
      throw new Error(
        "Must specify the bridging fee parameter for crosschain orders",
      );
    }

    let nativeValue = order.inputs
      .filter((input) => input.tokenType === Type.NATIVE)
      .reduce((total, input) => total + input.amount, 0n);

    if (bridgingFee) return nativeValue + bridgingFee;
    else return nativeValue;
  }

  formatAddressToBytes32(addr: string): `0x${string}` {
    return pad(addr as `0x${string}`, { size: 32 });
  }

  formatBytes32ToAddress(paddedAddr: string): `0x${string}` {
    return paddedAddr.slice(26) as `0x${string}`;
  }

  estimateLzBridgingFee(destinationId: number) {
    const lzData = this.getLzEstimationData();

    return encodeFunctionData({
      abi: LZ_ROUTER_ABI,
      functionName: "estimateLzBridgingFee",
      args: [destinationId, lzData.payload, lzData.options],
    });
  }

  private checkAddress(addr: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(addr);
  }

  private getLzEstimationData(): {
    payload: `0x${string}`;
    options: `0x${string}`;
  } {
    const options = Options.newOptions()
      .addExecutorLzReceiveOption(2000000, 0)
      .toHex() as `0x${string}`;

    // Encode payload: abi.encode(bytes32(0)) then abi.encode(address(1), payload)
    const randomBytes32 =
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    const innerPayload = encodeAbiParameters(parseAbiParameters("bytes32"), [
      randomBytes32,
    ]);
    const payload = encodeAbiParameters(parseAbiParameters("address, bytes"), [
      "0x0000000000000000000000000000000000000001",
      innerPayload,
    ]);

    return { payload, options };
  }

  /**
   * Submit a gasless order to the solver bot
   *
   * @param orderRequest - The order request with all order details
   * @param signature - EIP-712 signature from the user
   * @param orderId - Unique order ID (bytes32 hash)
   * @param botEndpoint - Bot API endpoint URL (e.g., 'https://bot.example.com')
   * @returns Promise with transaction hash and order ID
   *
   * @throws {Error} If the bot rejects the order or network request fails
   *
   * @remarks
   * This method submits an order to the solver bot for gasless execution.
   * The bot will validate the signature, check the quote, and submit the
   * order on-chain paying gas on behalf of the user.
   *
   * The user must have previously received a quote from the bot via RFQ,
   * and the order amounts must match the quote within tolerance.
   *
   * @example
   * ```typescript
   * const contractHelper = new iLayerContractHelper();
   * const signingHelper = new iLayerSigningHelper();
   *
   * // 1. Get quote via RFQ
   * const quote = await rfqHelper.requestQuote({...});
   *
   * // 2. Build order request from quote
   * const orderRequest = {
   *   nonce: 1,
   *   deadline: Math.floor(Date.now() / 1000) + 3600,
   *   order: {
   *     // ... order fields from quote
   *   },
   * };
   *
   * // 3. Sign order
   * const signature = await signingHelper.signOrderRequest(
   *   orderRequest,
   *   walletClient,
   *   1,
   *   orderHubAddress,
   * );
   *
   * // 4. Generate order ID
   * const orderId = signingHelper.generateOrderId(orderRequest);
   *
   * // 5. Submit gasless
   * const result = await contractHelper.submitOrderGasless(
   *   orderRequest,
   *   signature,
   *   orderId,
   *   'https://bot.example.com',
   * );
   *
   * console.log('Order submitted:', result.txHash);
   * ```
   */
  async submitOrderGasless(
    orderRequest: OrderRequest,
    signature: Hex,
    orderId: Hex,
    botEndpoint: string,
  ): Promise<{
    success: boolean;
    txHash: string;
    orderId: string;
  }> {
    try {
      // Validate inputs
      if (!signature.startsWith("0x") || signature.length !== 132) {
        throw new Error("Invalid signature format (expected 65 bytes hex)");
      }

      if (!orderId.startsWith("0x") || orderId.length !== 66) {
        throw new Error("Invalid orderId format (expected 32 bytes hex)");
      }

      // Normalize bot endpoint URL
      const endpoint = botEndpoint.endsWith("/")
        ? botEndpoint.slice(0, -1)
        : botEndpoint;

      // Submit to bot API
      const response = await fetch(`${endpoint}/order-creation/createOrderGasless`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order: orderRequest.order,
          signature,
          orderId,
          nonce: orderRequest.nonce,
          requestDeadline: orderRequest.deadline,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Bot rejected order (${response.status}): ${errorText}`,
        );
      }

      const result = await response.json();

      if (!result.success) {
        throw new Error(
          `Order submission failed: ${result.error || "Unknown error"}`,
        );
      }

      return {
        success: true,
        txHash: result.txHash,
        orderId: result.orderId,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to submit gasless order: ${errorMessage}`);
    }
  }
}
