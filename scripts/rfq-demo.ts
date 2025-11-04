import 'dotenv/config';
import { iLayerRfqHelper } from '../src/index';

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable ${key}`);
  return value;
};

const main = async () => {
  const helper = new iLayerRfqHelper({
    key: required('SOKETI_APP_KEY'),
    host: process.env.SOKETI_HOST ?? '127.0.0.1',
    port: Number(process.env.SOKETI_PORT ?? '6001'),
    useTLS: (process.env.SOKETI_TLS ?? 'false').toLowerCase() === 'true',
    authEndpoint: required('SOKETI_AUTH_ENDPOINT'),
    authHeaders: process.env.SOKETI_AUTH_HEADERS
      ? JSON.parse(process.env.SOKETI_AUTH_HEADERS)
      : undefined,
    timeoutMs: Number(process.env.RFQ_TIMEOUT_MS ?? '20000'),
  });

  const request = {
    from: {
      network: process.env.RFQ_SOURCE_CHAIN ?? 'arbitrum',
      tokens: [
        {
          address:
            process.env.RFQ_FROM_TOKEN ??
            '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
          amount: process.env.RFQ_AMOUNT ?? (10n ** 6n).toString(),
        },
      ],
    },
    to: {
      network: process.env.RFQ_DEST_CHAIN ?? 'base',
      tokens: [
        {
          address:
            process.env.RFQ_TO_TOKEN ??
            '0x4200000000000000000000000000000000000006',
          amount: process.env.RFQ_TO_AMOUNT ?? '0',
        },
      ],
    },
  };

  console.log('Publishing RFQ request:', JSON.stringify(request, null, 2));

  try {
    const { bucket, quotes } = await helper.requestQuote(request, {
      onStatus: (status) =>
        console.log('[status]', JSON.stringify(status, null, 2)),
      onError: (error) =>
        console.error('[error]', JSON.stringify(error, null, 2)),
    });

    console.log('Bucket ID:', bucket);
    console.log('Quotes:', JSON.stringify(quotes, null, 2));
  } catch (error) {
    console.error(
      'RFQ failed:',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    helper.disconnect();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
