// Workflow definitions adapted from Vercel's workflow SDK e2e suite.
// Original: https://github.com/vercel/workflow (Apache-2.0 license)

import { sleep, FatalError, RetryableError, createHook, createWebhook, type RequestWithResponse, fetch, getStepMetadata, getWorkflowMetadata } from 'workflow'
import { start } from 'workflow/api'

// ---- addTen: multi-step chaining ----

async function add (a: number, b: number) {
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

export async function sleepingWorkflow () {
  'use workflow'
  const startTime = Date.now()
  await sleep('10s')
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

export async function webhookWorkflow () {
  'use workflow'
  const results: any[] = []

  const webhook1 = createWebhook()
  const webhook2 = createWebhook({
    respondWith: new Response('Hello from static response!', { status: 402 }),
  })
  const webhook3 = createWebhook({
    respondWith: 'manual',
  })

  const payload1 = await webhook1
  results.push({ url: webhook1.url, method: payload1.method })

  const payload2 = await webhook2
  results.push({ url: webhook2.url, method: payload2.method })

  const payload3 = await webhook3 as unknown as RequestWithResponse
  await payload3.respondWith(new Response('Hello from webhook!', { status: 200 }))
  results.push({ url: webhook3.url, method: payload3.method })

  return results
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
