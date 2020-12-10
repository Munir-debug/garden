/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import { Events, EventName, EventBus, eventNames } from "../events"
import { LogEntryMetadata, LogEntry } from "../logger/log-entry"
import { chainMessages } from "../logger/renderers"
import { got } from "../util/http"

import { LogLevel } from "../logger/log-node"
import { Garden } from "../garden"
import { EnterpriseApi, makeAuthHeader } from "./api"

export type StreamEvent = {
  name: EventName
  payload: Events[EventName]
  timestamp: Date
}

export interface LogEntryEvent {
  key: string
  parentKey: string | null
  revision: number
  msg: string | string[]
  timestamp: Date
  level: LogLevel
  data?: any
  section?: string
  metadata?: LogEntryMetadata
}

export function formatLogEntryForEventStream(entry: LogEntry): LogEntryEvent {
  const { section, data } = entry.getMessageState()
  const { key, revision, level } = entry
  const parentKey = entry.parent ? entry.parent.key : null
  const metadata = entry.getMetadata()
  const msg = chainMessages(entry.getMessageStates() || [])
  const timestamp = new Date()
  return { key, parentKey, revision, msg, data, metadata, section, timestamp, level }
}

interface StreamTarget {
  host?: string
  enterprise: boolean
  clientAuthToken?: string
}

export interface ConnectBufferedEventStreamParams {
  targets?: StreamTarget[]
  garden: Garden
}

interface ApiBatchBase {
  workflowRunUid?: string
  sessionId: string | null
  projectUid?: string
}

export interface ApiEventBatch extends ApiBatchBase {
  events: StreamEvent[]
  environment: string
  namespace: string
}

export interface ApiLogBatch extends ApiBatchBase {
  logEntries: LogEntryEvent[]
}

export const controlEventNames: Set<EventName> = new Set(["_workflowRunRegistered"])

/**
 * Buffers events and log entries and periodically POSTs them to Garden Enterprise or another Garden service.
 *
 * Subscribes to logger events once, in the constructor.
 *
 * Subscribes to Garden events via the connect method, since we need to subscribe to the event bus of
 * new Garden instances (and unsubscribe from events from the previously connected Garden instance, if
 * any) e.g. when config changes during a watch-mode command.
 */
export class BufferedEventStream {
  protected log: LogEntry
  protected enterpriseApi?: EnterpriseApi
  public sessionId: string

  protected targets: StreamTarget[]

  protected garden: Garden
  private workflowRunUid: string | undefined

  /**
   * We maintain this map to facilitate unsubscribing from a previously connected event bus
   * when a new event bus is connected.
   */
  private gardenEventListeners: { [eventName: string]: (payload: any) => void }

  private intervalId: NodeJS.Timer | null
  private bufferedEvents: StreamEvent[]
  private bufferedLogEntries: LogEntryEvent[]
  protected intervalMsec = 1000

  /**
   * We use 600 kilobytes as the maximum combined size of the events / log entries in a given batch. This number
   * was chosen to fit comfortably below e.g. nginx' default max request size, while still being able to carry a decent
   * number of records.
   */
  private maxBatchBytes = 600 * 1024 // 600 kilobytes

  constructor({ log, enterpriseApi, sessionId }: { log: LogEntry; enterpriseApi?: EnterpriseApi; sessionId: string }) {
    this.sessionId = sessionId
    this.log = log
    this.enterpriseApi = enterpriseApi
    this.log.root.events.onAny((_name: string, payload: LogEntryEvent) => {
      this.streamLogEntry(payload)
    })
    this.bufferedEvents = []
    this.bufferedLogEntries = []
    this.targets = []
  }

  connect({ garden, targets }: ConnectBufferedEventStreamParams) {
    if (this.intervalId) {
      clearInterval(this.intervalId)
    }

    if (targets) {
      this.targets = targets
    }

    if (this.garden) {
      // We unsubscribe from the old event bus' events.
      this.unsubscribeFromGardenEvents(this.garden.events)
    }

    this.garden = garden
    this.subscribeToGardenEvents(this.garden.events)

    this.log.silly("BufferedEventStream: Connected")

    this.startInterval()
  }

  subscribeToGardenEvents(eventBus: EventBus) {
    // We maintain this map to facilitate unsubscribing from events when the Garden instance is closed.
    const gardenEventListeners = {}
    for (const gardenEventName of eventNames) {
      const listener = (payload: LogEntryEvent) => this.streamEvent(gardenEventName, payload)
      gardenEventListeners[gardenEventName] = listener
      eventBus.on(gardenEventName, listener)
    }
    this.gardenEventListeners = gardenEventListeners
  }

  unsubscribeFromGardenEvents(eventBus: EventBus) {
    for (const [gardenEventName, listener] of Object.entries(this.gardenEventListeners)) {
      eventBus.removeListener(gardenEventName, listener)
    }
  }

  startInterval() {
    this.intervalId = setInterval(() => {
      this.flushBuffered().catch((err) => {
        this.log.error(err)
      })
    }, this.intervalMsec)
  }

  async close() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    try {
      await this.flushAll()
    } catch (err) {
      /**
       * We don't throw an exception here, since a failure to stream events and log entries doesn't mean that the
       * command failed.
       */
      this.log.error(`Error while flushing events and log entries: ${err.message}`)
    }
  }

  streamEvent<T extends EventName>(name: T, payload: Events[T]) {
    if (controlEventNames.has(name)) {
      this.handleControlEvent(name, payload)
      return
    }

    this.bufferedEvents.push({
      name,
      payload,
      timestamp: new Date(),
    })
  }

  streamLogEntry(logEntry: LogEntryEvent) {
    this.bufferedLogEntries.push(logEntry)
  }

  async flushEvents(events: StreamEvent[]) {
    if (events.length === 0) {
      return
    }

    const data: ApiEventBatch = {
      events,
      workflowRunUid: this.workflowRunUid,
      sessionId: this.sessionId,
      projectUid: this.garden.projectId || undefined,
      environment: this.garden.environmentName,
      namespace: this.garden.namespace,
    }

    await this.postToTargets(`${events.length} events`, "events", data)
  }

  async flushLogEntries(logEntries: LogEntryEvent[]) {
    if (logEntries.length === 0 || !this.garden) {
      return
    }

    const data: ApiLogBatch = {
      logEntries,
      workflowRunUid: this.workflowRunUid,
      sessionId: this.sessionId,
      projectUid: this.garden.projectId || undefined,
    }

    await this.postToTargets(`${logEntries.length} log entries`, "log-entries", data)
  }

  private async postToTargets(description: string, path: string, data: ApiEventBatch | ApiLogBatch) {
    if (this.targets.length === 0) {
      this.log.silly("No targets to send events to. Dropping them.")
    }

    const targetUrls = this.targets.map((target) => `${target.host}/${path}`)
    this.log.silly(`Flushing ${description} to ${targetUrls.join(", ")}`)
    this.log.silly(`--------`)
    this.log.silly(`data: ${JSON.stringify(data)}`)
    this.log.silly(`--------`)

    try {
      await Bluebird.map(this.targets, (target) => {
        if (target.enterprise && this.enterpriseApi?.getDomain()) {
          return this.enterpriseApi.post(this.log, `${path}`, { body: data })
        }
        const headers = makeAuthHeader(target.clientAuthToken || "")
        return got.post(`${target.host}/${path}`, { json: data, headers })
      })
    } catch (err) {
      /**
       * We don't throw an exception here, since a failure to stream events and log entries doesn't mean that the
       * command failed.
       */
      this.log.debug(`Error while flushing events and log entries: ${err.message}`)
    }
  }

  /**
   * Flushes all events and log entries until none remain, and returns a promise that resolves when all of them
   * have been posted to their targets.
   */
  async flushAll() {
    if (!this.garden || this.targets.length === 0) {
      return
    }

    this.log.silly(`Flushing all remaining events and log entries`)
    const flushPromises: Promise<any>[] = []
    try {
      while (this.bufferedEvents.length > 0 || this.bufferedLogEntries.length > 0) {
        this.log.silly(`remaining: ${this.bufferedEvents.length} events, ${this.bufferedLogEntries.length} log entries`)
        // while (this.bufferedEvents.length > 0 || this.bufferedLogEntries.length > 0) {
        flushPromises.push(this.flushBuffered())
      }
    } catch (err) {
      throw err
    }
    return Bluebird.all(flushPromises)
  }

  async flushBuffered() {
    if (!this.garden || this.targets.length === 0) {
      return
    }

    const eventsToFlush = this.makeBatch(this.bufferedEvents)
    const logEntriesToFlush = this.makeBatch(this.bufferedLogEntries)

    return Bluebird.all([this.flushEvents(eventsToFlush), this.flushLogEntries(logEntriesToFlush)])
  }

  /**
   * Adds buffered records (events or log entries) to a batch until none remain or until their combined size
   * exceeds `MAX_MATCH_BYTES`, and returns the batch.
   */
  makeBatch<B>(buffered: B[]): B[] {
    const batch: B[] = []
    let batchBytes = 0
    while (batchBytes < this.maxBatchBytes && buffered.length > 0) {
      let nextRecordBytes = Buffer.from(JSON.stringify(buffered[0])).length
      if (nextRecordBytes > this.maxBatchBytes) {
        this.log.error(`Event or log entry too large to flush, dropping it.`)
        this.log.debug(JSON.stringify(buffered[0]))
        buffered.shift() // Drop first record.
        nextRecordBytes = Buffer.from(JSON.stringify(buffered[0])).length
      }
      if (batchBytes + nextRecordBytes > this.maxBatchBytes) {
        break
      }
      batch.push(buffered.shift() as B)
      batchBytes += nextRecordBytes
    }
    return batch
  }

  handleControlEvent<T extends EventName>(name: T, payload: Events[T]) {
    if (name === "_workflowRunRegistered") {
      this.workflowRunUid = payload.workflowRunUid
    }
  }
}
