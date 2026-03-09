// Workflow definitions adapted from Vercel's workflow SDK e2e suite.
// Original: https://github.com/vercel/workflow (Apache-2.0 license)

import { sleep, FatalError, RetryableError, createHook, createWebhook, type RequestWithResponse, fetch, getStepMetadata, getWorkflowMetadata, getWritable } from 'workflow'
import { start } from 'workflow/api'
import { callThrower, stepThatThrowsFromHelper } from './helpers'
import { importedStepOnly } from './_imported_step_only.js'
import { addVectors, createVector, scaleVector, sumVectors } from './serde-steps.js'
import { pathsAliasHelper } from '@repo/lib/steps/paths-alias-test'

// ---- addTen: multi-step chaining ----

export async function add (a: number, b: number) {
  'use step'
  return a + b
}

export async function addTenWorkflow (input: number) {
  'use workflow'
  const a = await add(input, 2)
  const b = await add(a, 3)
  const c = await add(b, 5)
  return c
}

// ---- promiseAll: parallel steps ----

async function randomDelay (v: string) {
  'use step'
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 500))
  return v.toUpperCase()
}

export async function promiseAllWorkflow () {
  'use workflow'
  const [a, b, c] = await Promise.all([
    randomDelay('a'),
    randomDelay('b'),
    randomDelay('c'),
  ])
  return a + b + c
}

// ---- promiseRace: first step wins ----

async function specificDelay (delay: number, v: string) {
  'use step'
  await new Promise((resolve) => setTimeout(resolve, delay))
  return v.toUpperCase()
}

export async function promiseRaceWorkflow () {
  'use workflow'
  const winner = await Promise.race([
    specificDelay(10000, 'a'),
    specificDelay(100, 'b'),
    specificDelay(20000, 'c'),
  ])
  return winner
}

// ---- sleeping: deferred delivery ----

export async function sleepingWorkflow (durationMs = 10_000) {
  'use workflow'
  const startTime = Date.now()
  await sleep(durationMs)
  const endTime = Date.now()
  return { startTime, endTime }
}

// ---- parallel sleep ----

export async function parallelSleepWorkflow () {
  'use workflow'
  const startTime = Date.now()
  await Promise.all(Array.from({ length: 10 }, () => sleep('1s')))
  const endTime = Date.now()
  return { startTime, endTime }
}

// ---- null byte: data integrity ----

async function returnNullByte () {
  'use step'
  return 'null byte \0'
}

export async function nullByteWorkflow () {
  'use workflow'
  return await returnNullByte()
}

// ---- fetch: network inside step ----

async function fetchTodo () {
  'use step'
  const res = await fetch('https://jsonplaceholder.typicode.com/todos/1')
  return res.json()
}

export async function fetchWorkflow () {
  'use workflow'
  return await fetchTodo()
}

// ---- error retry: step retries until success ----

let retryAttempt = 0

async function retryUntilAttempt3 () {
  'use step'
  retryAttempt++
  if (retryAttempt < 3) {
    throw new Error('not yet')
  }
  return { finalAttempt: retryAttempt }
}

export async function errorRetrySuccessWorkflow () {
  'use workflow'
  retryAttempt = 0
  return await retryUntilAttempt3()
}

// ---- fatal error: no retries ----

async function throwFatalError () {
  'use step'
  throw new FatalError('Fatal step error')
}

export async function errorFatalWorkflow () {
  'use workflow'
  try {
    await throwFatalError()
    return { caught: false }
  } catch (e: any) {
    return { caught: true, message: e.message }
  }
}

// ---- hook workflow: pause and resume ----

export async function hookWorkflow (token: string, customData: string) {
  'use workflow'
  const results: any[] = []

  const hook = createHook({ token, metadata: { customData } })

  for await (const payload of hook) {
    results.push(payload)
    if (payload.done) break
  }

  return results
}

// ---- webhook workflow: HTTP-triggered resume ----

async function sendWebhookResponse (req: RequestWithResponse) {
  'use step'
  const body = await req.text()
  await req.respondWith(new Response('Hello from webhook!'))
  return body
}

export async function webhookWorkflow () {
  'use workflow'

  type Payload = { url: string, method: string, body: string }
  const payloads: Payload[] = []

  const webhookWithDefaultResponse = createWebhook()
  const webhookWithStaticResponse = createWebhook({
    respondWith: new Response('Hello from static response!', { status: 402 }),
  })
  const webhookWithManualResponse = createWebhook({
    respondWith: 'manual',
  })

  {
    const req = await webhookWithDefaultResponse
    const body = await req.text()
    payloads.push({ url: req.url, method: req.method, body })
  }

  {
    const req = await webhookWithStaticResponse
    const body = await req.text()
    payloads.push({ url: req.url, method: req.method, body })
  }

  {
    const req = await webhookWithManualResponse
    const body = await sendWebhookResponse(req)
    payloads.push({ url: req.url, method: req.method, body })
  }

  return payloads
}

// ---- spawn child workflow from step ----

async function doubleValue (input: number) {
  'use step'
  return input * 2
}

async function childWorkflow (input: number) {
  'use workflow'
  const result = await doubleValue(input)
  return { childResult: result, originalValue: input }
}

async function spawnChild (input: number) {
  'use step'
  const run = await start(childWorkflow, [input])
  const result = await run.returnValue
  return { childRunId: run.runId, childResult: result }
}

export async function spawnWorkflowFromStepWorkflow (input: number) {
  'use workflow'
  const { childRunId, childResult } = await spawnChild(input)
  return { parentInput: input, childRunId, childResult }
}

// ---- promiseAny: one step fails, others succeed ----

async function stepThatFails () {
  'use step'
  throw new FatalError('step failed')
}

export async function promiseAnyWorkflow () {
  'use workflow'
  const winner = await Promise.any([
    stepThatFails(),
    specificDelay(1000, 'b'),
    specificDelay(3000, 'c'),
  ])
  return winner
}

// ---- promiseRace stress test ----

async function promiseRaceStressTestDelayStep (dur: number, resp: number): Promise<number> {
  'use step'
  await new Promise((resolve) => setTimeout(resolve, dur))
  return resp
}

export async function promiseRaceStressTestWorkflow () {
  'use workflow'
  const promises = new Map<number, Promise<number>>()
  const done: number[] = []
  for (let i = 0; i < 5; i++) {
    const dur = 1000 * 5 * i
    promises.set(i, promiseRaceStressTestDelayStep(dur, i))
  }
  while (promises.size > 0) {
    const res = await Promise.race(promises.values())
    done.push(res)
    promises.delete(res)
  }
  return done
}

// ---- workflow and step metadata ----

async function stepWithMetadata () {
  'use step'
  const stepMeta = getStepMetadata()
  const workflowMeta = getWorkflowMetadata()
  return { stepMetadata: stepMeta, workflowMetadata: workflowMeta }
}

export async function workflowAndStepMetadataWorkflow () {
  'use workflow'
  const workflowMeta = getWorkflowMetadata()
  const { stepMetadata, workflowMetadata: innerWorkflowMetadata } = await stepWithMetadata()
  return {
    workflowMetadata: {
      workflowRunId: workflowMeta.workflowRunId,
      workflowStartedAt: workflowMeta.workflowStartedAt,
      url: workflowMeta.url,
    },
    stepMetadata,
    innerWorkflowMetadata,
  }
}

// ---- error: nested workflow error (workflow fails) ----

function errorNested3 () {
  throw new Error('Nested workflow error')
}

function errorNested2 () {
  errorNested3()
}

function errorNested1 () {
  errorNested2()
}

export async function errorWorkflowNested () {
  'use workflow'
  errorNested1()
  return 'never reached'
}

// ---- error: step error basic (caught in workflow) ----

async function errorStepFn () {
  'use step'
  throw new Error('Step error message')
}
errorStepFn.maxRetries = 0

export async function errorStepBasic () {
  'use workflow'
  try {
    await errorStepFn()
    return { caught: false, message: null }
  } catch (e: any) {
    return { caught: true, message: e.message }
  }
}

// ---- error: RetryableError with custom delay ----

async function throwRetryableError () {
  'use step'
  const { attempt, stepStartedAt } = getStepMetadata()
  if (attempt === 1) {
    throw new RetryableError('Retryable error', { retryAfter: '10s' })
  }
  return {
    attempt,
    duration: Date.now() - stepStartedAt.getTime(),
  }
}

export async function errorRetryCustomDelay () {
  'use workflow'
  return await throwRetryableError()
}

// ---- error: maxRetries=0 disables retries ----

async function throwWithNoRetries () {
  'use step'
  const { attempt } = getStepMetadata()
  throw new Error(`Failed on attempt ${attempt}`)
}
throwWithNoRetries.maxRetries = 0

export async function errorRetryDisabled () {
  'use workflow'
  try {
    await throwWithNoRetries()
    return { failed: false, attempt: null }
  } catch (e: any) {
    const match = e.message?.match(/attempt (\d+)/)
    return { failed: true, attempt: match ? parseInt(match[1]) : null }
  }
}

// ---- error: FatalError caught with FatalError.is() ----

export async function errorFatalCatchable () {
  'use workflow'
  try {
    await throwFatalError()
    return { caught: false, isFatal: false }
  } catch (e: any) {
    return { caught: true, isFatal: FatalError.is(e) }
  }
}

// ---- step function passing (no closure vars) ----

async function doubleNumber (x: number) {
  'use step'
  return x * 2
}

async function stepWithStepFunctionArg (stepFn: (x: number) => Promise<number>) {
  'use step'
  const result = await stepFn(10)
  return result * 2
}

export async function stepFunctionPassingWorkflow () {
  'use workflow'
  const result = await stepWithStepFunctionArg(doubleNumber)
  return result
}

// ---- step function with closure variables ----

async function stepThatCallsStepFn (stepFn: (x: number) => Promise<string>, value: number) {
  'use step'
  const result = await stepFn(value)
  return `Wrapped: ${result}`
}

export async function stepFunctionWithClosureWorkflow () {
  'use workflow'
  const multiplier = 3
  const prefix = 'Result: '

  const calculate = async (x: number) => {
    'use step'
    return `${prefix}${x * multiplier}`
  }

  const result = await stepThatCallsStepFn(calculate, 7)
  return result
}

// ---- closure variable workflow ----

export async function closureVariableWorkflow (baseValue: number) {
  'use workflow'
  const multiplier = 3
  const prefix = 'Result: '

  const calculate = async () => {
    'use step'
    const result = baseValue * multiplier
    return `${prefix}${result}`
  }

  const output = await calculate()
  return output
}

// ---- this serialization: .call() and .apply() ----

async function multiplyByFactor (this: { factor: number }, value: number) {
  'use step'
  return value * this.factor
}

export async function thisSerializationWorkflow (baseValue: number) {
  'use workflow'
  const result1 = await multiplyByFactor.call({ factor: 2 }, baseValue)
  const result2 = await multiplyByFactor.apply({ factor: 3 }, [result1])
  const result3 = await multiplyByFactor.call({ factor: 5 }, result2)
  return result3
}

// ---- custom serialization ----

export class Point {
  constructor (public x: number, public y: number) {}

  static [Symbol.for('workflow-serialize')] (instance: Point) {
    return { x: instance.x, y: instance.y }
  }

  static [Symbol.for('workflow-deserialize')] (data: { x: number, y: number }) {
    return new Point(data.x, data.y)
  }

  distanceFromOrigin (): number {
    return Math.sqrt(this.x * this.x + this.y * this.y)
  }
}

async function transformPoint (point: Point, scale: number) {
  'use step'
  return new Point(point.x * scale, point.y * scale)
}

async function sumPoints (points: Point[]) {
  'use step'
  let totalX = 0
  let totalY = 0
  for (const p of points) {
    totalX += p.x
    totalY += p.y
  }
  return new Point(totalX, totalY)
}

export async function customSerializationWorkflow (x: number, y: number) {
  'use workflow'
  const point = new Point(x, y)
  const scaled = await transformPoint(point, 2)
  const scaledAgain = await transformPoint(scaled, 3)
  const points = [new Point(1, 2), new Point(3, 4), new Point(5, 6)]
  const sum = await sumPoints(points)
  return {
    original: { x: point.x, y: point.y },
    scaled: { x: scaled.x, y: scaled.y },
    scaledAgain: { x: scaledAgain.x, y: scaledAgain.y },
    sum: { x: sum.x, y: sum.y },
  }
}

// ---- instance method steps ----

export class Counter {
  constructor (public value: number) {}

  static [Symbol.for('workflow-serialize')] (instance: Counter) {
    return { value: instance.value }
  }

  static [Symbol.for('workflow-deserialize')] (data: { value: number }) {
    return new Counter(data.value)
  }

  async add (amount: number): Promise<number> {
    'use step'
    return this.value + amount
  }

  async multiply (factor: number): Promise<number> {
    'use step'
    return this.value * factor
  }

  async describe (label: string): Promise<{ label: string, value: number }> {
    'use step'
    return { label, value: this.value }
  }
}

export async function instanceMethodStepWorkflow (initialValue: number) {
  'use workflow'
  const counter = new Counter(initialValue)
  const added = await counter.add(10)
  const multiplied = await counter.multiply(3)
  const description = await counter.describe('test counter')
  const counter2 = new Counter(100)
  const added2 = await counter2.add(50)
  return { initialValue, added, multiplied, description, added2 }
}

// ---- hook cleanup: token reuse after workflow completion ----

export async function hookCleanupTestWorkflow (token: string, customData: string) {
  'use workflow'

  type Payload = { message: string, customData: string }

  const hook = createHook<Payload>({ token, metadata: { customData } })

  const payload = await hook

  return {
    message: payload.message,
    customData: payload.customData,
    hookCleanupTestData: 'workflow_completed',
  }
}

// ---- hook dispose: token reuse after explicit disposal ----

export async function hookDisposeTestWorkflow (token: string, customData: string) {
  'use workflow'

  type Payload = { message: string, customData: string }

  let message: string
  let customDataResult: string

  {
    const hook = createHook<Payload>({ token, metadata: { customData } })

    const payload = await hook
    message = payload.message
    customDataResult = payload.customData
  }

  await sleep('5s')

  return {
    message,
    customData: customDataResult,
    disposed: true,
    hookDisposeTestData: 'workflow_completed',
  }
}

// ---- errorRetryFatal: FatalError fails immediately (no retries, attempt=1) ----

export async function errorRetryFatal () {
  'use workflow'
  await throwFatalError()
  return 'never reached'
}

// ---- hook with sleep: concurrent hook payloads + sleep ----

async function processPayload (payload: { type: string, id?: number }) {
  'use step'
  return { processed: true, type: payload.type, id: payload.id }
}

export async function hookWithSleepWorkflow (token: string) {
  'use workflow'

  type Payload = { type: string, id?: number, done?: boolean }

  const hook = createHook<Payload>({ token })

  // Concurrent sleep that won't complete during the test
  /* eslint-disable-next-line no-void */
  void sleep('1d')

  const results: any[] = []

  for await (const payload of hook) {
    const result = await processPayload(payload)
    results.push(result)

    if (payload.done) {
      break
    }
  }

  return results
}

// ---- sleep with sequential steps (control test) ----

async function addNumbers (a: number, b: number) {
  'use step'
  return a + b
}

export async function sleepWithSequentialStepsWorkflow () {
  'use workflow'

  let shouldCancel = false
  /* eslint-disable-next-line no-void */
  void sleep('1d').then(() => {
    shouldCancel = true
  })

  const a = await addNumbers(1, 2)
  const b = await addNumbers(a, 3)
  const c = await addNumbers(b, 4)
  return { a, b, c, shouldCancel }
}

// ---- error: retry with counter (using getStepMetadata for attempt tracking) ----

async function retryUntilAttempt3WithMeta () {
  'use step'
  const { attempt } = getStepMetadata()
  if (attempt < 3) {
    throw new Error(`not yet (attempt ${attempt})`)
  }
  return { finalAttempt: attempt }
}

export async function errorRetrySuccess () {
  'use workflow'
  return await retryUntilAttempt3WithMeta()
}

// ---- cross-file error: workflow error from imported module ----

export async function errorWorkflowCrossFile () {
  'use workflow'
  callThrower()
  return 'never reached'
}

// ---- cross-file error: step error from imported module ----

export async function errorStepCrossFile () {
  'use workflow'
  try {
    await stepThatThrowsFromHelper()
    return { caught: false, message: null }
  } catch (e: any) {
    return { caught: true, message: e.message }
  }
}

// ---- static method workflows: Calculator ----

export class MathService {
  static async add (a: number, b: number) {
    'use step'
    return a + b
  }

  static async multiply (a: number, b: number) {
    'use step'
    return a * b
  }
}

export class Calculator {
  static async calculate (x: number, y: number): Promise<number> {
    'use workflow'
    const sum = await MathService.add(x, y)
    const result = await MathService.multiply(sum, 2)
    return result
  }
}

// ---- static method workflows: AllInOneService ----

export class AllInOneService {
  static async double (n: number): Promise<number> {
    'use step'
    return n * 2
  }

  static async triple (n: number): Promise<number> {
    'use step'
    return n * 3
  }

  static async processNumber (n: number): Promise<number> {
    'use workflow'
    const doubled = await AllInOneService.double(n)
    const tripled = await AllInOneService.triple(n)
    return doubled + tripled
  }
}

// ---- static method workflows: ChainableService ----

export class ChainableService {
  static multiplier = 10

  static async multiplyByClassValue (this: typeof ChainableService, n: number): Promise<number> {
    'use step'
    return n * this.multiplier
  }

  static async doubleAndMultiply (this: typeof ChainableService, n: number): Promise<number> {
    'use step'
    return n * 2 * this.multiplier
  }

  static async processWithThis (n: number): Promise<{ multiplied: number, doubledAndMultiplied: number, sum: number }> {
    'use workflow'
    const multiplied = await ChainableService.multiplyByClassValue(n)
    const doubledAndMultiplied = await ChainableService.doubleAndMultiply(n)
    return { multiplied, doubledAndMultiplied, sum: multiplied + doubledAndMultiplied }
  }
}

// ---- imported step only: step from separate file ----

export async function importedStepOnlyWorkflow () {
  'use workflow'
  return await importedStepOnly()
}

// ---- paths alias: import via tsconfig paths ----

async function callPathsAliasHelper () {
  'use step'
  return pathsAliasHelper()
}

export async function pathsAliasWorkflow () {
  'use workflow'
  const result = await callPathsAliasHelper()
  return result
}

// ---- cross-context serialization (serde) ----

export async function crossContextSerdeWorkflow () {
  'use workflow'
  const v1 = await createVector(1, 2, 3)
  const v2 = await createVector(10, 20, 30)
  const sum = await addVectors(v1, v2)
  const scaled = await scaleVector(v1, 5)
  const vectors = [v1, v2, scaled]
  const arraySum = await sumVectors(vectors)
  return {
    v1: { x: v1.x, y: v1.y, z: v1.z },
    v2: { x: v2.x, y: v2.y, z: v2.z },
    sum: { x: sum.x, y: sum.y, z: sum.z },
    scaled: { x: scaled.x, y: scaled.y, z: scaled.z },
    arraySum: { x: arraySum.x, y: arraySum.y, z: arraySum.z },
  }
}

// ---- fault injection: serverError5xxRetryWorkflow ----

type FaultState = {
  installStepId: string
  targetStepId?: string
  remaining: number
  triggered: number
}

const FAULT_MAP_SYMBOL = Symbol.for('__test_5xx_fault_map')
const FAULT_WRAPPER_INSTALLED_SYMBOL = Symbol.for('__test_5xx_fault_wrapper_installed')

function shouldInjectStepCompletedFault (state: FaultState, data: any): boolean {
  if (data?.eventType !== 'step_completed') return false
  const correlationId = typeof data?.correlationId === 'string' ? data.correlationId : null
  if (!correlationId) return false
  if (correlationId === state.installStepId) return false
  state.targetStepId ??= correlationId
  if (correlationId !== state.targetStepId) return false
  if (state.remaining <= 0) return false
  state.remaining--
  state.triggered++
  return true
}

async function installServerErrorFaultInjection (failCount: number) {
  'use step'
  const { workflowRunId } = getWorkflowMetadata()
  const { stepId: installStepId } = getStepMetadata()
  const world = (globalThis as any)[Symbol.for('@workflow/world//cache')]

  ;(globalThis as any)[FAULT_MAP_SYMBOL] ??= new Map<string, FaultState>()
  const faultMap = (globalThis as any)[FAULT_MAP_SYMBOL] as Map<string, FaultState>

  faultMap.set(workflowRunId, { installStepId, remaining: failCount, triggered: 0 })

  if (!(world.events.create as any)[FAULT_WRAPPER_INSTALLED_SYMBOL]) {
    const original = world.events.create.bind(world.events)
    const wrappedCreate = async (rid: string, data: any, ...rest: any[]): Promise<any> => {
      const state = faultMap.get(rid)
      if (state && shouldInjectStepCompletedFault(state, data)) {
        const err: any = new Error('Injected 5xx')
        err.name = 'WorkflowAPIError'
        err.status = 500
        throw err
      }
      return original(rid, data, ...rest)
    }
    ;(wrappedCreate as any)[FAULT_WRAPPER_INSTALLED_SYMBOL] = true
    world.events.create = wrappedCreate
  }
}

async function doWork (input: number) {
  'use step'
  return input * 2
}

async function cleanupFaultInjection () {
  'use step'
  const { workflowRunId } = getWorkflowMetadata()
  const faultMap = (globalThis as any)[FAULT_MAP_SYMBOL] as Map<string, FaultState> | undefined
  const state = faultMap?.get(workflowRunId)
  const triggered = state?.triggered ?? 0
  faultMap?.delete(workflowRunId)
  return triggered
}

export async function serverError5xxRetryWorkflow (input: number) {
  'use workflow'
  await installServerErrorFaultInjection(2)
  const result = await doWork(input)
  const retryCount = await cleanupFaultInjection()
  return { result, retryCount }
}

// ---- readable stream: step returns a ReadableStream ----

async function genReadableStream () {
  'use step'
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start (controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(encoder.encode(`${i}\n`))
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      controller.close()
    },
  })
}

export async function readableStreamWorkflow () {
  'use workflow'
  const stream = await genReadableStream()
  return stream
}

// ---- output stream: getWritable() in workflow, passed to steps ----

async function stepWithOutputStreamBinary (writable: WritableStream, text: string) {
  'use step'
  const writer = writable.getWriter()
  await writer.write(new TextEncoder().encode(text))
  writer.releaseLock()
}

async function stepWithOutputStreamObject (writable: WritableStream, obj: any) {
  'use step'
  const writer = writable.getWriter()
  await writer.write(obj)
  writer.releaseLock()
}

async function stepCloseOutputStream (writable: WritableStream) {
  'use step'
  await writable.close()
}

export async function outputStreamWorkflow () {
  'use workflow'
  const writable = getWritable()
  const namedWritable = getWritable({ namespace: 'test' })
  await sleep('1s')
  await stepWithOutputStreamBinary(writable, 'Hello, world!')
  await sleep('1s')
  await stepWithOutputStreamBinary(namedWritable, 'Hello, named stream!')
  await sleep('1s')
  await stepWithOutputStreamObject(writable, { foo: 'test' })
  await sleep('1s')
  await stepWithOutputStreamObject(namedWritable, { foo: 'bar' })
  await sleep('1s')
  await stepCloseOutputStream(writable)
  await stepCloseOutputStream(namedWritable)
  return 'done'
}

// ---- output stream inside step: getWritable() called directly in steps ----

async function stepWithOutputStreamInsideStep (text: string) {
  'use step'
  const writable = getWritable()
  const writer = writable.getWriter()
  await writer.write(new TextEncoder().encode(text))
  writer.releaseLock()
}

async function stepWithNamedOutputStreamInsideStep (namespace: string, obj: any) {
  'use step'
  const writable = getWritable({ namespace })
  const writer = writable.getWriter()
  await writer.write(obj)
  writer.releaseLock()
}

async function stepCloseOutputStreamInsideStep (namespace?: string) {
  'use step'
  const writable = getWritable({ namespace })
  await writable.close()
}

export async function outputStreamInsideStepWorkflow () {
  'use workflow'
  await sleep('1s')
  await stepWithOutputStreamInsideStep('Hello from step!')
  await sleep('1s')
  await stepWithNamedOutputStreamInsideStep('step-ns', { message: 'Hello from named stream in step!' })
  await sleep('1s')
  await stepWithOutputStreamInsideStep('Second message')
  await sleep('1s')
  await stepWithNamedOutputStreamInsideStep('step-ns', { counter: 42 })
  await sleep('1s')
  await stepCloseOutputStreamInsideStep()
  await stepCloseOutputStreamInsideStep('step-ns')
  return 'done'
}

// ---- stepFunctionAsStartArg: step fn ref passed as start() argument ----

async function invokeStepFn (stepFn: (a: number, b: number) => Promise<number>, a: number, b: number) {
  'use step'
  return await stepFn(a, b)
}

export async function stepFunctionAsStartArgWorkflow (
  stepFn: (a: number, b: number) => Promise<number>,
  x: number,
  y: number
): Promise<{ directResult: number, viaStepResult: number, doubled: number }> {
  'use workflow'
  const directResult = await stepFn(x, y)
  const viaStepResult = await invokeStepFn(stepFn, x, y)
  const doubled = await stepFn(directResult, directResult)
  return { directResult, viaStepResult, doubled }
}
