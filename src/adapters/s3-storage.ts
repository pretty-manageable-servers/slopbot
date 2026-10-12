import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_STORED_FILE_BYTES, type ObjectStorageProvider } from '../object-storage.js';
import { ToolError, UncertainActionError } from '../errors.js';
export interface S3StorageOptions { bucket: string; endpoint: string; publicEndpoint: string; region: string; accessKeyId: string; secretAccessKey: string }
export class S3StorageProvider implements ObjectStorageProvider {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  constructor(private readonly options: S3StorageOptions) {
    const config = { region: options.region, credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }, forcePathStyle: true, responseChecksumValidation: 'WHEN_REQUIRED' as const, requestChecksumCalculation: 'WHEN_REQUIRED' as const, maxAttempts: 3 };
    this.client = new S3Client({ ...config, endpoint: options.endpoint });
    this.publicClient = new S3Client({ ...config, endpoint: options.publicEndpoint });
  }
  private async read<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ToolError) throw error;
      const name = error instanceof Error ? error.name : '';
      throw new ToolError(name === 'NoSuchKey' ? 'Stored object is missing. It may have been removed outside the bot.' : 'Object storage request failed. Check the bucket, access key, quota and service availability.', 'failed', { cause: error });
    }
  }
  private mutationFailure(error: unknown, action: string): never {
    const status = error && typeof error === 'object' && '$metadata' in error ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined;
    if (status !== undefined && [400, 401, 403, 404, 405, 409, 413, 422, 429].includes(status)) throw new ToolError(`Object storage ${action} was rejected (HTTP ${status}). Check bucket access, credentials, size and quota before retrying.`, 'failed', { cause: error });
    throw new UncertainActionError(`Object ${action} could not be confirmed. Inspect storage before retrying.`, { cause: error });
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    try { await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: bytes, ContentType: contentType }), { abortSignal: AbortSignal.timeout(30000) }); }
    catch (error) { this.mutationFailure(error, 'upload'); }
  }
  async get(key: string): Promise<Uint8Array> {
    return this.read(async () => {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), { abortSignal: AbortSignal.timeout(30000) });
      if (!result.Body) throw new ToolError('Stored object has no readable body.', 'failed');
      const stream = result.Body as AsyncIterable<Uint8Array> & { destroy(): void };
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        if ((result.ContentLength ?? 0) > MAX_STORED_FILE_BYTES) throw new ToolError('Stored files are limited to 10 MiB.');
        for await (const chunk of stream) { size += chunk.length; if (size > MAX_STORED_FILE_BYTES) throw new ToolError('Stored files are limited to 10 MiB.'); chunks.push(chunk); }
        return Buffer.concat(chunks);
      } finally { stream.destroy(); }
    });
  }
  async delete(key: string): Promise<void> {
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }), { abortSignal: AbortSignal.timeout(30000) }); }
    catch (error) { this.mutationFailure(error, 'deletion'); }
  }
  async link(key: string, name: string, seconds: number): Promise<string> {
    return this.read(() => getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.options.bucket, Key: key, ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}` }), { expiresIn: seconds }));
  }
  close(): void { this.client.destroy(); this.publicClient.destroy(); }
}
