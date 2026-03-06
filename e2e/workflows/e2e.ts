import { sleep, FatalError, createHook, createWebhook, type RequestWithResponse, fetch } from 'workflow'
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
