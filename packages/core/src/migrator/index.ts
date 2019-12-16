import { EventEmitter } from 'events'
import { SynorDatabase } from '../database'
import { SynorError, SynorMigrationError, toSynorError } from '../error'
import { SynorSource } from '../source'
import { getCurrentRecord } from './get-current-record'
import { getHistory } from './get-history'
import { getMigration } from './get-migration'
import { getMigrationsToRun } from './get-migrations-to-run'
import { getRecordsToRepair } from './get-records-to-repair'
import { validateMigration } from './validate-migration'

type DatabaseEngine = import('../database').DatabaseEngine
type MigrationHistory = import('../migration').MigrationHistory
type MigrationRecord = import('../migration').MigrationRecord
type MigrationSource = import('../migration').MigrationSource
type SourceEngine = import('../source').SourceEngine
type SynorConfig = import('..').SynorConfig

type MigratorEventStore = {
  'lock:start': []
  'lock:end': []
  'unlock:start': []
  'unlock:end': []
  'open:start': []
  'open:end': []
  'close:start': []
  'close:end': []
  'drop:start': []
  'drop:end': []
  'current:start': []
  current: [MigrationHistory[number]]
  'current:end': []
  'history:start': []
  history: [MigrationHistory]
  'history:end': []
  'pending:start': []
  pending: [MigrationSource[]]
  'pending:end': []
  'validate:start': []
  'validate:run:start': [MigrationRecord]
  'validate:error': [Error, MigrationRecord]
  'validate:run:end': [MigrationRecord]
  'validate:end': []
  'migrate:start': []
  'migrate:run:start': [MigrationSource]
  'migrate:error': [Error, MigrationSource]
  'migrate:run:end': [MigrationSource]
  'migrate:end': []
  'repair:start': []
  'repair:end': []
  error: [Error]
}

type EventStore = Record<string | symbol, any[]>
type Listener<S extends EventStore, N extends keyof S> = (...data: S[N]) => void
type UpdateListener<S extends EventStore, R extends any> = <N extends keyof S>(
  event: N,
  listener: Listener<S, N>
) => R

export interface SynorMigrator extends EventEmitter {
  addListener: UpdateListener<MigratorEventStore, this>
  on: UpdateListener<MigratorEventStore, this>
  once: UpdateListener<MigratorEventStore, this>
  prependListener: UpdateListener<MigratorEventStore, this>
  prependOnceListener: UpdateListener<MigratorEventStore, this>
  removeListener: UpdateListener<MigratorEventStore, this>
  off: UpdateListener<MigratorEventStore, this>
  removeAllListeners(event?: keyof MigratorEventStore): this
  listeners<N extends keyof MigratorEventStore>(
    event: N
  ): Array<Listener<MigratorEventStore, N>>
  rawListeners<N extends keyof MigratorEventStore>(
    event: N
  ): Array<Listener<MigratorEventStore, N>>
  emit<N extends keyof MigratorEventStore>(
    event: N,
    ...data: MigratorEventStore[N]
  ): boolean
  listenerCount(type: keyof MigratorEventStore): number
}

export class SynorMigrator extends EventEmitter {
  private readonly config: SynorConfig
  private readonly database: DatabaseEngine
  private readonly source: SourceEngine

  private locked: boolean

  constructor(config: SynorConfig) {
    super()

    this.setMaxListeners(1)

    this.config = config
    this.database = SynorDatabase(config)
    this.source = SynorSource(config)

    this.locked = false

    this.lock = this.decorate('lock:start', this.lock, 'lock:end', true)
    this.unlock = this.decorate('unlock:start', this.unlock, 'unlock:end', true)
    this.open = this.decorate('open:start', this.open, 'open:end', true)
    this.close = this.decorate('close:start', this.close, 'close:end', true)

    this.drop = this.decorate('drop:start', this.drop, 'drop:end')
    this.current = this.decorate('current:start', this.current, 'current:end')
    this.history = this.decorate('history:start', this.history, 'history:end')
    this.pending = this.decorate('pending:start', this.pending, 'pending:end')
    this.validate = this.decorate(
      'validate:start',
      this.validate,
      'validate:end'
    )
    this.migrate = this.decorate('migrate:start', this.migrate, 'migrate:end')
    this.repair = this.decorate('repair:start', this.repair, 'repair:end')
  }

  private readonly emitOrThrow = <
    N extends 'error' | 'migrate:error' | 'validate:error'
  >(
    event: N,
    ...data: MigratorEventStore[N]
  ): void => {
    data[0] = toSynorError(data[0])
    const hasListener = this.emit(event, ...data)
    if (!hasListener) {
      throw data[0]
    }
  }

  private readonly decorate = <T extends (...params: any[]) => Promise<void>>(
    startEvent: keyof MigratorEventStore,
    handler: T,
    endEvent: keyof MigratorEventStore,
    withoutLock: boolean = false
  ) => async (...params: Parameters<T>) => {
    try {
      if (!withoutLock) {
        await this.lock()
      }
      this.emit(startEvent)
      await handler(...params)
      this.emit(endEvent)
    } catch (error) {
      this.emitOrThrow('error', error)
    } finally {
      if (!withoutLock) {
        await this.unlock()
      }
    }
  }

  private readonly lock = async (): Promise<void> => {
    if (this.locked) {
      throw new SynorError('Already Locked')
    }
    await this.database.lock()
    this.locked = true
  }

  private readonly unlock = async (): Promise<void> => {
    if (!this.locked) {
      throw new SynorError('Not Yet Locked')
    }
    await this.database.unlock()
    this.locked = false
  }

  open = async (): Promise<void> => {
    await Promise.all([this.database.open(), this.source.open()])
  }

  close = async (): Promise<void> => {
    if (this.locked) {
      await this.unlock()
    }
    await Promise.all([this.database.close(), this.source.close()])
  }

  drop = async (): Promise<void> => {
    await this.database.drop()
  }

  current = async (): Promise<void> => {
    const { baseVersion, recordStartId } = this.config
    const history = await getHistory(this.database, baseVersion, recordStartId)
    const currentRecord = getCurrentRecord(history)
    this.emit('current', currentRecord)
  }

  history = async (
    recordStartId: number = this.config.recordStartId
  ): Promise<void> => {
    const { baseVersion } = this.config
    const history = await getHistory(this.database, baseVersion, recordStartId)
    this.emit('history', history)
  }

  pending = async (): Promise<void> => {
    const { baseVersion, recordStartId } = this.config
    const history = await getHistory(this.database, baseVersion, recordStartId)
    const currentVersion = getCurrentRecord(history).version
    const targetVersion = await this.source.last()
    if (!targetVersion || currentVersion >= targetVersion) {
      this.emit('pending', [])
      return
    }
    const migrations = await getMigrationsToRun(
      this.source,
      baseVersion,
      currentVersion,
      targetVersion
    )
    this.emit('pending', migrations)
  }

  validate = async (): Promise<void> => {
    const { baseVersion, recordStartId } = this.config
    const records = await getHistory(
      this.database,
      baseVersion,
      recordStartId
    ).then(history =>
      history.filter(
        ({ version, type, state }) =>
          version !== baseVersion && type === 'do' && state === 'applied'
      )
    )
    for (const record of records) {
      this.emit('validate:run:start', record)
      const migration = await getMigration(
        this.source,
        record.version,
        record.type
      )
      if (!migration) {
        throw new SynorMigrationError('not_found', record)
      }
      try {
        validateMigration(record, migration)
        this.emit('validate:run:end', record)
      } catch (error) {
        this.emitOrThrow('validate:error', error, record)
      }
    }
  }

  migrate = async (targetVersion: string): Promise<void> => {
    const { baseVersion, recordStartId } = this.config
    const history = await getHistory(this.database, baseVersion, recordStartId)
    const currentVersion = getCurrentRecord(history).version
    const migrations = await getMigrationsToRun(
      this.source,
      baseVersion,
      currentVersion,
      targetVersion
    )
    for (const migration of migrations) {
      this.emit('migrate:run:start', migration)
      try {
        await this.database.run(migration)
        this.emit('migrate:run:end', migration)
      } catch (error) {
        this.emitOrThrow('migrate:error', error, migration)
      }
    }
  }

  repair = async (): Promise<void> => {
    const { baseVersion, recordStartId } = this.config
    const history = await getHistory(this.database, baseVersion, recordStartId)
    const records = await getRecordsToRepair(this.source, baseVersion, history)
    await this.database.repair(records)
  }
}
