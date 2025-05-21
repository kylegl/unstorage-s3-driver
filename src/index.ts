import type { GetObjectCommandOutput } from '@aws-sdk/client-s3'
import { Buffer } from 'node:buffer'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { defineDriver, joinKeys, normalizeKey } from 'unstorage'
import { createError, createRequiredError } from 'unstorage/drivers/utils/index'

// Helper to convert stream to string (UTF-8 assumed)
async function streamToString(stream: GetObjectCommandOutput['Body']): Promise<string> {
  if (!stream)
    return ''
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    // Asserting stream type if needed, depends on SDK version details
    const body = stream as import('stream').Readable // Node.js streams
    // Or if web stream: const reader = stream.getReader(); // ... read logic ...
    body.on('data', chunk => chunks.push(chunk))
    body.on('error', reject)
    body.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
}

// Helper to convert stream to Buffer
async function streamToBuffer(stream: GetObjectCommandOutput['Body']): Promise<Buffer> {
  if (!stream)
    return Buffer.alloc(0)
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    const body = stream as import('stream').Readable
    body.on('data', chunk => chunks.push(chunk))
    body.on('error', reject)
    body.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

export interface S3DriverOptions {
  /**
   * AWS S3 Bucket Name
   * @required
   */
  bucket: string

  /**
   * If not provided, relies on AWS_REGION env var or AWS SDK default resolution.
   */
  region?: string

  /**
   * Optional prefix to namespace keys within the bucket
   * (e.g., 'nitro-cache/')
   * Should usually end with a '/'.
   */
  prefix?: string

  /**
   * Optional AWS S3 endpoint URL (primarily for S3 compatible services like MinIO/Localstack)
   */
  endpoint?: string

  /**
   * AWS SDK S3 Client instance.
   * If not provided, a new client will be created.
   */
  s3Client?: S3Client
}

const DRIVER_NAME = 'iam-s3'

export default defineDriver((opts: S3DriverOptions) => {
  // Initialize S3 client - relies on default credential chain (IAM role)
  const s3 = opts.s3Client || new S3Client({
    region: opts.region,
    endpoint: opts.endpoint,
  })

  const resolvedPrefix = opts.prefix ? normalizeKey(opts.prefix) : ''

  // Helper to prepend prefix to keys
  const r = (key: string): string => {
    return resolvedPrefix ? joinKeys(resolvedPrefix, normalizeKey(key)) : normalizeKey(key)
  }

  // Helper to remove prefix from listed keys
  const rPrefix = (key: string | undefined): string => {
    if (!key)
      return ''

    if (!resolvedPrefix)
      return key

    return key.startsWith(resolvedPrefix) ? key.substring(resolvedPrefix.length) : key
  }

  // eslint-disable-next-line ts/explicit-function-return-type
  function requireBucket() {
    if (!opts.bucket)
      throw createRequiredError(DRIVER_NAME, 'bucket')
  }

  return {
    name: DRIVER_NAME,
    options: opts,

    async hasItem(key) {
      requireBucket()

      try {
        const command = new HeadObjectCommand({
          Bucket: opts.bucket,
          Key: r(key),
        })
        await s3.send(command)
        return true
      }
      catch (error: any) {
        // HeadObject throws 'NotFound' in SDK v3 for non-existent keys
        if (error.name === 'NotFound')
          return false

        console.error(`[Unstorage][${DRIVER_NAME}] Error checking key ${r(key)}:`, error)
        throw createError(DRIVER_NAME, `Error checking key ${r(key)}`)
      }
    },

    async getItem(key) {
      requireBucket()

      try {
        const command = new GetObjectCommand({
          Bucket: opts.bucket,
          Key: r(key),
        })
        const data = await s3.send(command)
        const value = await streamToString(data.Body)

        // Attempt to parse if content type suggests JSON, otherwise return string
        // Note: This is basic, might need refinement based on actual content types
        if (data.ContentType?.includes('application/json')) {
          try {
            return JSON.parse(value)
          }
          catch {
            // If parsing fails, return the raw string (could log a warning)
            console.warn(`[Unstorage] [${DRIVER_NAME}] Failed to parse JSON for key ${r(key)}, returning raw string.`)
            return value
          }
        }
        return value
      }
      catch (error: any) {
        if (error.name === 'NoSuchKey')
          return null

        console.error(`[Unstorage] [${DRIVER_NAME}] Error getting key ${r(key)}:`, error)
        throw createError(DRIVER_NAME, `Error getting key ${r(key)}`)
      }
    },

    async getItemRaw(key) {
      requireBucket()
      try {
        const command = new GetObjectCommand({
          Bucket: opts.bucket,
          Key: r(key),
        })
        const data = await s3.send(command)
        return await streamToBuffer(data.Body)
      }
      catch (error: any) {
        if (error.name === 'NoSuchKey')
          return null

        console.error(`[Unstorage] [${DRIVER_NAME}] Error getting raw key ${r(key)}:`, error)
        throw createError(DRIVER_NAME, `Error getting raw key ${r(key)}`)
      }
    },

    async setItem(key, value: string) {
      requireBucket()

      const command = new PutObjectCommand({
        Bucket: opts.bucket,
        Key: r(key),
        Body: value,
        ContentType: 'text/plain',
      })

      try {
        await s3.send(command)
      }
      catch (error) {
        console.error(`[Unstorage] [${DRIVER_NAME}] Error setting key ${r(key)}:`, error)
        throw createError(DRIVER_NAME, `Error setting key ${r(key)}`)
      }
    },

    async setItemRaw(key, value: Buffer) {
      const command = new PutObjectCommand({
        Bucket: opts.bucket,
        Key: r(key),
        Body: value,
        ContentType: 'application/octet-stream', // Default for raw
      })

      try {
        await s3.send(command)
      }
      catch (error) {
        console.error(`[Unstorage] [${DRIVER_NAME}] Error setting raw key ${r(key)}:`, error)
        throw createError(DRIVER_NAME, `Error setting raw key ${r(key)}`)
      }
    },

    async removeItem(key) {
      const command = new DeleteObjectCommand({
        Bucket: opts.bucket,
        Key: r(key),
      })

      try {
        await s3.send(command)
      }
      catch (error) {
        console.error(`[Unstorage] [${DRIVER_NAME}] Error removing key ${r(key)}:`, error)
        throw createError(DRIVER_NAME, `Error removing key ${r(key)}`)
      }
    },

    async getKeys(base) {
      const resolvedBase = r(base || '')
      const command = new ListObjectsV2Command({
        Bucket: opts.bucket,
        Prefix: resolvedBase,
      })
      const keys: string[] = []
      let continuationToken: string | undefined

      try {
        do {
          // Set the continuation token for subsequent requests
          command.input.ContinuationToken = continuationToken

          const response = await s3.send(command)

          if (response.Contents) {
            keys.push(...response.Contents.map(item => rPrefix(item.Key)).filter(Boolean))
          }

          // Check if there are more pages and get the token for the next page
          continuationToken = response.NextContinuationToken
        } while (continuationToken) // Continue as long as there's a next token

        return keys
      }
      catch (error) {
        console.error(`[Unstorage] [${DRIVER_NAME}] Error listing keys with base ${resolvedBase}:`, error)
        throw createError(DRIVER_NAME, `Error listing keys with base ${resolvedBase}`)
      }
    },

    async clear(base) {
      const keys = await this.getKeys(base || '', {})

      if (keys.length === 0) {
        return
      }

      // eslint-disable-next-line no-console
      console.log(`[Unstorage] [${DRIVER_NAME}] Clearing ${keys.length} keys with base '${base}'...`)

      // Batch delete (max 1000 keys per request)
      const MAX_DELETE_KEYS = 1000
      for (let i = 0; i < keys.length; i += MAX_DELETE_KEYS) {
        const keysToDelete = keys.slice(i, i + MAX_DELETE_KEYS)
        if (keysToDelete.length === 0)
          continue // Should not happen, but safe guard

        const command = new DeleteObjectsCommand({
          Bucket: opts.bucket,
          Delete: {
            Objects: keysToDelete.map(key => ({ Key: r(key) })), // Add prefix back for deletion key
            Quiet: false, // Get results back
          },
        })

        try {
          const output = await s3.send(command)
          if (output.Errors && output.Errors.length > 0) {
            console.error(`[Unstorage] [${DRIVER_NAME}] Errors during batch delete (batch starting index ${i}):`, output.Errors)
          }
        }
        catch (error) {
          console.error(`[Unstorage] [${DRIVER_NAME}] Error clearing keys with base '${base}' (batch starting index ${i}):`, error)
          throw createError(DRIVER_NAME, `Error clearing keys with base '${base}' (batch starting index ${i})`)
        }
      }
    },

    async dispose() {
      // Optional: Close the S3 client if it was created internally
      // and if you need fine-grained resource management.
      // Often not strictly needed in serverless environments.
      // if (!opts.s3Client && s3) {
      //     s3.destroy();
      // }
    },
    async watch(_callback) {
      // Watching S3 buckets for real-time changes is complex and
      // typically requires external infrastructure (S3 Events, SQS/Lambda).
      // This driver does not support active watching.

      // Return the required 'unwatch' function (which does nothing).
      const unwatch = (): void => { }
      return unwatch
    },
  }
})
