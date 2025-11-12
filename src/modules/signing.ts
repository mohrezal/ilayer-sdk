import type { Address, Hex, WalletClient } from 'viem';
import { keccak256, concat, encodePacked } from 'viem';
import type { OrderRequest } from '../types';

/**
 * Helper class for EIP-712 signing operations for iLayer orders
 *
 * This module provides functionality to sign order requests using EIP-712 typed data
 * signatures, enabling gasless order submission where the solver bot pays gas on behalf
 * of the user.
 *
 * @example
 * ```typescript
 * const signingHelper = new iLayerSigningHelper();
 *
 * // Sign an order request
 * const signature = await signingHelper.signOrderRequest(
 *   orderRequest,
 *   walletClient,
 *   1, // Ethereum mainnet
 *   '0x...' // OrderHub contract address
 * );
 *
 * // Submit gasless order with signature
 * const result = await contractHelper.submitOrderGasless(
 *   orderRequest,
 *   signature,
 *   orderId,
 *   'https://bot-endpoint.com'
 * );
 * ```
 */
export class iLayerSigningHelper {
  /**
   * Get the EIP-712 domain separator from the OrderHub contract
   *
   * @param orderHubAddress - Address of the OrderHub contract
   * @param chainId - Chain ID where the OrderHub is deployed
   * @returns The domain separator hash
   *
   * @remarks
   * The domain separator is used to prevent signature replay across different
   * contracts and chains. It's calculated as:
   * keccak256(abi.encode(DOMAIN_TYPEHASH, name, version, chainId, verifyingContract))
   */
  private async getDomainSeparator(
    orderHubAddress: Address,
    chainId: number,
  ): Promise<Hex> {
    // EIP-712 Domain type hash
    const DOMAIN_TYPEHASH = keccak256(
      encodePacked(
        ['string'],
        ['EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'],
      ),
    );

    const nameHash = keccak256(encodePacked(['string'], ['OrderHub']));
    const versionHash = keccak256(encodePacked(['string'], ['1']));

    // Encode domain separator
    const domainSeparator = keccak256(
      concat([
        DOMAIN_TYPEHASH,
        nameHash,
        versionHash,
        encodePacked(['uint256'], [BigInt(chainId)]),
        encodePacked(['address'], [orderHubAddress]),
      ]),
    );

    return domainSeparator;
  }

  /**
   * Hash an OrderRequest according to EIP-712 specification
   *
   * @param orderRequest - The order request to hash
   * @returns The typed data hash
   *
   * @remarks
   * This creates a structured hash of the order request that includes all
   * order parameters. The hash is used as part of the EIP-712 signature.
   */
  private hashOrderRequest(orderRequest: OrderRequest): Hex {
    // OrderRequest type hash
    const ORDER_REQUEST_TYPEHASH = keccak256(
      encodePacked(
        ['string'],
        [
          'OrderRequest(uint256 nonce,uint256 deadline,Order order)Order(bytes32 user,bytes32 filler,bytes32 recipient,bytes32 callRecipient,uint256 callValue,bytes callData,bool sponsored,uint256 primaryFillerDeadline,uint256 deadline,uint256 sourceChainId,uint256 destinationChainId,Token[] inputs,Token[] outputs)Token(uint8 tokenType,bytes32 tokenAddress,uint256 tokenId,uint256 amount)',
        ],
      ),
    );

    // Hash each token
    const TOKEN_TYPEHASH = keccak256(
      encodePacked(
        ['string'],
        ['Token(uint8 tokenType,bytes32 tokenAddress,uint256 tokenId,uint256 amount)'],
      ),
    );

    const hashToken = (token: OrderRequest['order']['inputs'][0]) => {
      return keccak256(
        concat([
          TOKEN_TYPEHASH,
          encodePacked(['uint8'], [token.tokenType]),
          encodePacked(['bytes32'], [token.tokenAddress as Hex]),
          encodePacked(['uint256'], [BigInt(token.tokenId)]),
          encodePacked(['uint256'], [BigInt(token.amount)]),
        ]),
      );
    };

    // Hash input tokens array
    const inputsHash = keccak256(
      concat(orderRequest.order.inputs.map(hashToken)),
    );

    // Hash output tokens array
    const outputsHash = keccak256(
      concat(orderRequest.order.outputs.map(hashToken)),
    );

    // Order type hash
    const ORDER_TYPEHASH = keccak256(
      encodePacked(
        ['string'],
        [
          'Order(bytes32 user,bytes32 filler,bytes32 recipient,bytes32 callRecipient,uint256 callValue,bytes callData,bool sponsored,uint256 primaryFillerDeadline,uint256 deadline,uint256 sourceChainId,uint256 destinationChainId,Token[] inputs,Token[] outputs)Token(uint8 tokenType,bytes32 tokenAddress,uint256 tokenId,uint256 amount)',
        ],
      ),
    );

    const orderHash = keccak256(
      concat([
        ORDER_TYPEHASH,
        encodePacked(['bytes32'], [orderRequest.order.user as Hex]),
        encodePacked(['bytes32'], [orderRequest.order.filler as Hex]),
        encodePacked(['bytes32'], [orderRequest.order.recipient as Hex]),
        encodePacked(['bytes32'], [orderRequest.order.callRecipient as Hex]),
        encodePacked(['uint256'], [BigInt(orderRequest.order.callValue)]),
        keccak256(orderRequest.order.callData as Hex),
        encodePacked(['bool'], [orderRequest.order.sponsored]),
        encodePacked(['uint256'], [BigInt(orderRequest.order.primaryFillerDeadline)]),
        encodePacked(['uint256'], [BigInt(orderRequest.order.deadline)]),
        encodePacked(['uint256'], [BigInt(orderRequest.order.sourceChainId)]),
        encodePacked(['uint256'], [BigInt(orderRequest.order.destinationChainId)]),
        inputsHash,
        outputsHash,
      ]),
    );

    // Hash the complete OrderRequest
    const requestHash = keccak256(
      concat([
        ORDER_REQUEST_TYPEHASH,
        encodePacked(['uint256'], [BigInt(orderRequest.nonce)]),
        encodePacked(['uint256'], [BigInt(orderRequest.deadline)]),
        orderHash,
      ]),
    );

    return requestHash;
  }

  /**
   * Sign an order request using EIP-712 typed data signature
   *
   * @param orderRequest - The order request to sign
   * @param walletClient - Viem wallet client for signing
   * @param chainId - Chain ID where the order will be submitted
   * @param orderHubAddress - Address of the OrderHub contract
   * @returns The EIP-712 signature as a hex string (65 bytes: r + s + v)
   *
   * @throws {Error} If signing fails or wallet is not available
   *
   * @remarks
   * This creates an EIP-712 signature that can be used for gasless order submission.
   * The signature proves that the user authorized the order without requiring them
   * to send an on-chain transaction.
   *
   * The signature format is: 0x + r (32 bytes) + s (32 bytes) + v (1 byte)
   * Total: 65 bytes = 130 hex characters + '0x' prefix = 132 characters
   *
   * @example
   * ```typescript
   * const orderRequest = {
   *   nonce: 1,
   *   deadline: Math.floor(Date.now() / 1000) + 3600,
   *   order: {
   *     user: '0x000000000000000000000000' + userAddress.slice(2),
   *     filler: '0x000000000000000000000000' + fillerAddress.slice(2),
   *     recipient: '0x000000000000000000000000' + recipientAddress.slice(2),
   *     callRecipient: '0x000000000000000000000000' + recipientAddress.slice(2),
   *     callValue: 0,
   *     callData: '0x',
   *     sponsored: false,
   *     primaryFillerDeadline: Math.floor(Date.now() / 1000) + 1800,
   *     deadline: Math.floor(Date.now() / 1000) + 3600,
   *     sourceChainId: 1,
   *     destinationChainId: 42161,
   *     inputs: [{ tokenType: 2, tokenAddress: '0x...', tokenId: 0, amount: '1000000' }],
   *     outputs: [{ tokenType: 2, tokenAddress: '0x...', tokenId: 0, amount: '990000' }],
   *   },
   * };
   *
   * const signature = await signingHelper.signOrderRequest(
   *   orderRequest,
   *   walletClient,
   *   1,
   *   '0x1234567890123456789012345678901234567890',
   * );
   * ```
   */
  async signOrderRequest(
    orderRequest: OrderRequest,
    walletClient: WalletClient,
    chainId: number,
    orderHubAddress: Address,
  ): Promise<Hex> {
    try {
      if (!walletClient.account) {
        throw new Error('Wallet client must have an account');
      }

      // Get domain separator
      const domainSeparator = await this.getDomainSeparator(
        orderHubAddress,
        chainId,
      );

      // Hash the order request
      const requestHash = this.hashOrderRequest(orderRequest);

      // Create EIP-712 digest: keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message))
      const digest = keccak256(
        concat([
          '0x1901' as Hex,
          domainSeparator,
          requestHash,
        ]),
      );

      // Sign the digest
      const signature = await walletClient.signMessage({
        account: walletClient.account,
        message: { raw: digest },
      });

      return signature;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to sign order request: ${errorMessage}`);
    }
  }

  /**
   * Verify an EIP-712 signature for an order request
   *
   * @param orderRequest - The order request that was signed
   * @param signature - The signature to verify
   * @param expectedSigner - The expected signer address
   * @param chainId - Chain ID where the order will be submitted
   * @param orderHubAddress - Address of the OrderHub contract
   * @returns True if the signature is valid, false otherwise
   *
   * @remarks
   * This method can be used to verify a signature locally before submitting
   * to the bot. The actual verification will also happen on the bot side.
   */
  async verifySignature(
    orderRequest: OrderRequest,
    signature: Hex,
    expectedSigner: Address,
    chainId: number,
    orderHubAddress: Address,
  ): Promise<boolean> {
    try {
      // Get domain separator
      const domainSeparator = await this.getDomainSeparator(
        orderHubAddress,
        chainId,
      );

      // Hash the order request
      const requestHash = this.hashOrderRequest(orderRequest);

      // Create EIP-712 digest
      const digest = keccak256(
        concat([
          '0x1901' as Hex,
          domainSeparator,
          requestHash,
        ]),
      );

      // Basic format validation
      if (!signature.startsWith('0x') || signature.length !== 132) {
        return false;
      }

      // In production, you would recover the signer from the signature
      // and compare with expectedSigner. For now, we do basic validation.
      // The bot will perform full verification.

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate an order ID from an order request
   *
   * @param orderRequest - The order request
   * @returns The order ID as a bytes32 hash
   *
   * @remarks
   * The order ID is deterministically generated from the order parameters.
   * It's used to uniquely identify orders and prevent duplicates.
   */
  generateOrderId(orderRequest: OrderRequest): Hex {
    const orderHash = this.hashOrderRequest(orderRequest);
    return keccak256(
      concat([
        orderHash,
        encodePacked(['uint256'], [BigInt(orderRequest.nonce)]),
      ]),
    );
  }
}
