import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CompleteMultipartUploadCommandOutput,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectCommandInput,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  S3ClientConfig,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { AbortController } from '@smithy/abort-controller'
import {
  ObjectMetadata,
  ObjectResponse,
  withOptionalVersion,
  UploadPart,
  ReadParams,
  SaveParams,
  DeleteParams,
  CopyParams,
  DeleteManyParams,
  MetadataParams,
  SignUrlParams,
  CreateMultiPartUploadParams,
  UploadPartParams,
  CompleteMultipartUploadParams,
  AbortMultipartUploadParams,
  UploadPartCopyParams,
  StorageDisk,
} from './disk'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ERRORS, StorageBackendError } from '@internal/errors'
import { getConfig } from '../../config'
import Agent, { HttpsAgent } from 'agentkeepalive'
import { Readable } from 'stream'

const { storageS3MaxSockets } = getConfig()

/**
 * Creates an agent for the given protocol
 * @param options
 */
export function createAgent(options?: { maxSockets?: number }) {
  const agentOptions = {
    maxSockets: options?.maxSockets || storageS3MaxSockets,
    keepAlive: true,
  }

  return { httpAgent: new Agent(agentOptions), httpsAgent: new HttpsAgent(agentOptions) }
}

export interface S3DiskOptions {
  bucket: string
  endpoint?: string
  region?: string
  prefix?: string
  forcePathStyle?: boolean
  accessKey?: string
  secretKey?: string
  role?: string
  httpAgent?: { httpAgent: Agent } | { httpsAgent: HttpsAgent }
}

/**
 * S3Connector
 * Interacts with an s3-compatible file system with this S3Adapter
 */
export class S3Disk implements StorageDisk {
  client: S3Client
  masterBucket: string
  prefix?: string

  constructor(options: S3DiskOptions) {
    const agent = options.httpAgent ? options.httpAgent : createAgent()

    const params: S3ClientConfig = {
      region: options.region,
      runtime: 'node',
      requestHandler: new NodeHttpHandler({
        ...agent,
      }),
    }
    if (options.endpoint) {
      params.endpoint = options.endpoint
    }
    if (options.forcePathStyle) {
      params.forcePathStyle = true
    }

    if (options.accessKey && options.secretKey) {
      params.credentials = {
        accessKeyId: options.accessKey,
        secretAccessKey: options.secretKey,
      }
    }

    if (options.region) {
      params.region = options.region
    }

    this.client = new S3Client(params)
    this.prefix = options.prefix
    this.masterBucket = options.bucket
  }

  async read(params: ReadParams): Promise<ObjectResponse> {
    const { bucket, key, version, headers } = params
    const input: GetObjectCommandInput = {
      Bucket: this.masterBucket,
      IfNoneMatch: headers?.ifNoneMatch,
      Key: this.keyPath(bucket, key, version),
      Range: headers?.range,
    }
    if (headers?.ifModifiedSince) {
      input.IfModifiedSince = new Date(headers.ifModifiedSince)
    }
    const command = new GetObjectCommand(input)
    const data = await this.client.send(command, { abortSignal: params.signal })

    return {
      metadata: {
        cacheControl: data.CacheControl || 'no-cache',
        mimetype: data.ContentType || 'application/octet-stream',
        eTag: data.ETag || '',
        lastModified: data.LastModified,
        contentRange: data.ContentRange,
        contentLength: data.ContentLength || 0,
        size: data.ContentLength || 0,
      },
      body: data.Body as Readable,
      httpStatusCode: data.$metadata.httpStatusCode || 200,
    }
  }

  async save(params: SaveParams): Promise<ObjectMetadata> {
    const { bucket, key, version, body, contentType, cacheControl } = params
    const abortController = new AbortController()

    params.signal?.addEventListener(
      'abort',
      () => {
        abortController.abort()
      },
      { once: true }
    )

    try {
      const parallelUploadS3 = new Upload({
        client: this.client,
        abortController,
        params: {
          Bucket: this.masterBucket,
          Key: this.keyPath(bucket, key, version),
          Body: body as Readable,
          ContentType: contentType,
          CacheControl: cacheControl,
        },
      })

      const data = (await parallelUploadS3.done()) as CompleteMultipartUploadCommandOutput

      const metadata = await this.metadata({ bucket: bucket, key, version, signal: params.signal })

      return {
        httpStatusCode: data.$metadata.httpStatusCode || metadata.httpStatusCode,
        cacheControl: cacheControl,
        eTag: metadata.eTag,
        mimetype: metadata.mimetype,
        contentLength: metadata.contentLength,
        lastModified: metadata.lastModified,
        size: metadata.size,
        contentRange: metadata.contentRange,
      }
    } catch (err: any) {
      throw StorageBackendError.fromError(err)
    }
  }

  async delete(params: DeleteParams): Promise<void> {
    const { bucket, key, version } = params
    const command = new DeleteObjectCommand({
      Bucket: this.masterBucket,
      Key: this.keyPath(bucket, key, version),
    })
    await this.client.send(command, { abortSignal: params.signal })
  }

  async copy(
    params: CopyParams
  ): Promise<Pick<ObjectMetadata, 'httpStatusCode' | 'eTag' | 'lastModified'>> {
    const { to, from, conditions } = params
    try {
      const command = new CopyObjectCommand({
        Bucket: this.masterBucket,
        CopySource: `${this.masterBucket}/${this.keyPath(from.bucket, from.source, from.version)}`,
        Key: this.keyPath(to.bucket, to.source, to.version),
        CopySourceIfMatch: conditions?.ifMatch,
        CopySourceIfNoneMatch: conditions?.ifNoneMatch,
        CopySourceIfModifiedSince: conditions?.ifModifiedSince,
        CopySourceIfUnmodifiedSince: conditions?.ifUnmodifiedSince,
      })
      const data = await this.client.send(command, { abortSignal: params.signal })
      return {
        httpStatusCode: data.$metadata.httpStatusCode || 200,
        eTag: data.CopyObjectResult?.ETag || '',
        lastModified: data.CopyObjectResult?.LastModified,
      }
    } catch (e: any) {
      throw StorageBackendError.fromError(e)
    }
  }

  async deleteMany(params: DeleteManyParams): Promise<void> {
    const { bucket, prefixes } = params
    try {
      const s3Prefixes = prefixes.map((ele) => {
        return { Key: this.keyPath(bucket, ele) }
      })

      const command = new DeleteObjectsCommand({
        Bucket: this.masterBucket,
        Delete: {
          Objects: s3Prefixes,
        },
      })
      await this.client.send(command, { abortSignal: params.signal })
    } catch (e) {
      throw StorageBackendError.fromError(e)
    }
  }

  async metadata(params: MetadataParams): Promise<ObjectMetadata> {
    const { bucket, key, version } = params
    try {
      const command = new HeadObjectCommand({
        Bucket: this.masterBucket,
        Key: this.keyPath(bucket, key, version),
      })
      const data = await this.client.send(command, { abortSignal: params.signal })
      return {
        cacheControl: data.CacheControl || 'no-cache',
        mimetype: data.ContentType || 'application/octet-stream',
        eTag: data.ETag || '',
        lastModified: data.LastModified,
        contentLength: data.ContentLength || 0,
        httpStatusCode: data.$metadata.httpStatusCode || 200,
        size: data.ContentLength || 0,
      }
    } catch (e: any) {
      throw StorageBackendError.fromError(e)
    }
  }

  async signUrl(params: SignUrlParams): Promise<string> {
    const { bucket, key, version } = params
    const input: GetObjectCommandInput = {
      Bucket: this.masterBucket,
      Key: this.keyPath(bucket, key, version),
    }

    const command = new GetObjectCommand(input)
    return getSignedUrl(this.client, command, { expiresIn: 600 })
  }

  async createMultiPartUpload(params: CreateMultiPartUploadParams): Promise<string | undefined> {
    const { bucket, key, version, contentType, cacheControl } = params
    const createMultiPart = new CreateMultipartUploadCommand({
      Bucket: this.masterBucket,
      Key: this.keyPath(bucket, key, version),
      CacheControl: cacheControl,
      ContentType: contentType,
      Metadata: {
        Version: version || '',
      },
    })

    const resp = await this.client.send(createMultiPart, { abortSignal: params.signal })

    if (!resp.UploadId) {
      throw ERRORS.InvalidUploadId()
    }

    return resp.UploadId
  }

  async uploadPart(params: UploadPartParams): Promise<{ ETag?: string }> {
    const { bucket, key, version, uploadId, partNumber, body, length } = params

    const parallelUploadS3 = new UploadPartCommand({
      Bucket: this.masterBucket,
      Key: this.keyPath(bucket, key, version),
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: length,
    })

    const resp = await this.client.send(parallelUploadS3, { abortSignal: params.signal })

    return { ETag: resp.ETag }
  }

  async completeMultipartUpload(params: CompleteMultipartUploadParams): Promise<
    Omit<UploadPart, 'PartNumber'> & {
      location?: string
      bucket?: string
      version: string
    }
  > {
    const { bucket, key, uploadId, version, parts } = params

    const listPartsInput = new ListPartsCommand({
      Bucket: this.masterBucket,
      Key: this.keyPath(bucket, key, version),
      UploadId: uploadId,
    })

    const partsResponse = await this.client.send(listPartsInput, { abortSignal: params.signal })
    const uploadParts = parts || partsResponse.Parts || []

    const completeUpload = new CompleteMultipartUploadCommand({
      Bucket: this.masterBucket,
      Key: this.keyPath(bucket, key, version),
      UploadId: uploadId,
      MultipartUpload: {
        Parts: uploadParts,
      },
    })

    const response = await this.client.send(completeUpload, { abortSignal: params.signal })

    return {
      version,
      location: key,
      bucket,
      ...response,
    }
  }

  async abortMultipartUpload(params: AbortMultipartUploadParams): Promise<void> {
    const { bucket, key, uploadId } = params
    const abortUpload = new AbortMultipartUploadCommand({
      Bucket: this.masterBucket,
      Key: this.keyPath(bucket, key),
      UploadId: uploadId,
    })
    await this.client.send(abortUpload, { abortSignal: params.signal })
  }

  async uploadPartCopy(
    params: UploadPartCopyParams
  ): Promise<{ eTag?: string; lastModified?: Date }> {
    const { uploadId, partNumber, to, from, bytes } = params
    const uploadPartCopy = new UploadPartCopyCommand({
      Bucket: this.masterBucket,
      Key: this.keyPath(to.bucket, to.source, to.version),
      UploadId: uploadId,
      PartNumber: partNumber,
      CopySource: this.keyPath(from.bucket, from.source, from.version),
      CopySourceRange: bytes ? `bytes=${bytes.fromByte}-${bytes.toByte}` : undefined,
    })

    const part = await this.client.send(uploadPartCopy, { abortSignal: params.signal })

    return {
      eTag: part.CopyPartResult?.ETag,
      lastModified: part.CopyPartResult?.LastModified,
    }
  }

  protected keyPath(bucket: string, key: string, version?: string) {
    const objectPath = `${bucket}/${withOptionalVersion(key, version)}`

    if (this.prefix) {
      return `${this.prefix}/${objectPath}`
    }
    return objectPath
  }
}
