// Focused set of workflows to exercise the v4 SDK paths not covered by
// addTenWorkflow: sleeps (deferred queue), hooks, streams (via getWritable),
// and step retry / fatal error flows.

import { sleep, FatalError, createHook, getWritable } from 'workflow'

// --- Sleep: deferred queue delivery ------------------------------------------

export async function sleepingWorkflow (durationMs: number = 500) {
  'use workflow'
  const startTime = Date.now()
  await sleep(durationMs)
  const endTime = Date.now()
  return { startTime, endTime, elapsedMs: endTime - startTime }
}

// --- Step retry until success ------------------------------------------------

let retryAttempt = 0
async function retryUntilAttempt3 () {
  'use step'
  retryAttempt++
  if (retryAttempt < 3) {
    throw new Error(`attempt ${retryAttempt} failing on purpose`)
  }
  return { finalAttempt: retryAttempt }
}

export async function errorRetrySuccessWorkflow () {
  'use workflow'
  retryAttempt = 0
  return await retryUntilAttempt3()
}

// --- FatalError bubbles out of step, caught in workflow ----------------------

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

// --- Hook: createHook + resume via hook_received event ----------------------

export async function hookWorkflow (token: string) {
  'use workflow'
  const hook = createHook({ token })
  const payloads: any[] = []
  for await (const payload of hook) {
    payloads.push(payload)
    if (payload.done) break
  }
  return payloads
}

// --- Streams: getWritable() exercises world.writeToStream v4 alias ----------

async function writeTextToStream (writable: WritableStream, text: string) {
  'use step'
  const writer = writable.getWriter()
  await writer.write(new TextEncoder().encode(text))
  writer.releaseLock()
}

async function closeOutputStream (writable: WritableStream) {
  'use step'
  await writable.close()
}

export async function outputStreamWorkflow () {
  'use workflow'
  const writable = getWritable()
  await writeTextToStream(writable, 'hello from v4')
  await closeOutputStream(writable)
  return 'done'
}
