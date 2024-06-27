import PgBoss, { Job, JobWithMetadata } from 'pg-boss'
import { getConfig } from '../../config'
import { BaseEvent, BasePayload } from '../../storage/events'
import { QueueJobRetryFailed, QueueJobCompleted, QueueJobError } from '../monitoring/metrics'
import { logger, logSchema } from '../monitoring'
import { ERRORS } from '@internal/errors'

//eslint-disable-next-line @typescript-eslint/no-explicit-any
type SubclassOfBaseClass = (new (payload: any) => BaseEvent<any>) & {
  [K in keyof typeof BaseEvent]: (typeof BaseEvent)[K]
}

export abstract class Queue {
  protected static events: SubclassOfBaseClass[] = []
  private static pgBoss?: PgBoss

  static async start(opts: {
    signal?: AbortSignal
    onMessage?: (job: Job) => void
    registerWorkers?: () => void
  }) {
    if (Queue.pgBoss) {
      return Queue.pgBoss
    }

    if (opts.signal?.aborted) {
      throw ERRORS.Aborted('Cannot start queue with aborted signal')
    }

    const {
      isMultitenant,
      databaseURL,
      multitenantDatabaseUrl,
      pgQueueConnectionURL,
      pgQueueDeleteAfterDays,
      pgQueueArchiveCompletedAfterSeconds,
      pgQueueRetentionDays,
      pgQueueEnableWorkers,
    } = getConfig()

    let url = pgQueueConnectionURL ?? databaseURL

    if (isMultitenant && !pgQueueConnectionURL) {
      if (!multitenantDatabaseUrl) {
        throw new Error(
          'running storage in multi-tenant but DB_MULTITENANT_DATABASE_URL is not set'
        )
      }
      url = multitenantDatabaseUrl
    }

    Queue.pgBoss = new PgBoss({
      connectionString: url,
      max: 4,
      application_name: 'storage-pgboss',
      deleteAfterDays: pgQueueDeleteAfterDays,
      archiveCompletedAfterSeconds: pgQueueArchiveCompletedAfterSeconds,
      retentionDays: pgQueueRetentionDays,
      retryBackoff: true,
      retryLimit: 20,
      expireInHours: 48,
    })

    Queue.pgBoss.on('error', (error) => {
      logSchema.error(logger, '[Queue] error', {
        type: 'queue',
        error,
      })
    })

    await Queue.pgBoss.start()

    if (opts.registerWorkers && pgQueueEnableWorkers) {
      opts.registerWorkers()
    }

    await Queue.startWorkers(opts.onMessage)

    if (opts.signal) {
      opts.signal.addEventListener(
        'abort',
        async () => {
          logSchema.info(logger, '[Queue] Stopping', {
            type: 'queue',
          })
          return Queue.stop()
            .then(() => {
              logSchema.info(logger, '[Queue] Exited', {
                type: 'queue',
              })
            })
            .catch((e) => {
              logSchema.error(logger, '[Queue] Error while stopping queue', {
                error: e,
                type: 'queue',
              })
            })
        },
        { once: true }
      )
    }

    return Queue.pgBoss
  }

  static getInstance() {
    if (!this.pgBoss) {
      throw new Error('pg boss not initialised')
    }

    return this.pgBoss
  }

  static register<T extends SubclassOfBaseClass>(event: T) {
    Queue.events.push(event)
  }

  static async stop() {
    if (!this.pgBoss) {
      return
    }

    const boss = this.pgBoss

    await boss.stop({
      timeout: 20 * 1000,
      graceful: true,
      destroy: true,
    })

    await new Promise((resolve) => {
      boss.once('stopped', () => {
        resolve(null)
      })
    })

    Queue.pgBoss = undefined
  }

  protected static startWorkers(onMessage?: (job: Job) => void) {
    const workers: Promise<string>[] = []

    Queue.events.forEach((event) => {
      workers.push(Queue.registerTask(event.getQueueName(), event, true, onMessage))

      const slowRetryQueue = event.withSlowRetryQueue()

      if (slowRetryQueue) {
        workers.push(Queue.registerTask(event.getSlowRetryQueueName(), event, false, onMessage))
      }
    })

    return Promise.all(workers)
  }

  protected static registerTask(
    queueName: string,
    event: SubclassOfBaseClass,
    slowRetryQueueOnFail?: boolean,
    onMessage?: (job: Job) => void
  ) {
    const hasSlowRetryQueue = event.withSlowRetryQueue()
    return Queue.getInstance().work(
      queueName,
      event.getWorkerOptions(),
      async (job: Job<BasePayload>) => {
        try {
          if (onMessage) {
            onMessage(job)
          }
          const res = await event.handle(job)

          QueueJobCompleted.inc({
            name: event.getQueueName(),
          })

          return res
        } catch (e) {
          QueueJobRetryFailed.inc({
            name: event.getQueueName(),
          })

          try {
            const dbJob: JobWithMetadata | null =
              (job as JobWithMetadata).priority !== undefined
                ? (job as JobWithMetadata)
                : await Queue.getInstance().getJobById(job.id)

            if (!dbJob) {
              return
            }
            if (dbJob.retrycount >= dbJob.retrylimit) {
              QueueJobError.inc({
                name: event.getQueueName(),
              })

              if (hasSlowRetryQueue && slowRetryQueueOnFail) {
                event.sendSlowRetryQueue(job.data).catch(() => {
                  logSchema.error(
                    logger,
                    `[Queue Handler] Error while sending job to slow retry queue`,
                    {
                      type: 'queue-task',
                      error: e,
                      metadata: JSON.stringify(job),
                    }
                  )
                })
              }
            }
          } catch (e) {
            logSchema.error(logger, `[Queue Handler] fetching job ${event.name}`, {
              type: 'queue-task',
              error: e,
              metadata: JSON.stringify(job),
            })
          }

          logSchema.error(logger, `[Queue Handler] Error while processing job ${event.name}`, {
            type: 'queue-task',
            error: e,
            metadata: JSON.stringify(job),
          })

          throw e
        }
      }
    )
  }
}
