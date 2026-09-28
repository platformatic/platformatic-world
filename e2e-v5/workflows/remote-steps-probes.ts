import { createHook, sleep } from 'workflow'

async function recordRemoteStepInvocation (label: string): Promise<string> {
  'use step'

  return label
}

export async function runIdProbeWorkflow (): Promise<'ok'> {
  'use workflow'

  return 'ok'
}

export async function repeatedRemoteStepWorkflow (): Promise<string[]> {
  'use workflow'

  const results: string[] = []
  results.push(await recordRemoteStepInvocation('before'))
  for (let i = 0; i < 2; i++) {
    results.push(await recordRemoteStepInvocation(`loop-${i}`))
  }
  results.push(...await Promise.all([
    recordRemoteStepInvocation('parallel-0'),
    recordRemoteStepInvocation('parallel-1'),
  ]))
  return results
}

export async function hookSleepRaceProbeWorkflow (token: string): Promise<string[]> {
  'use workflow'

  const hook = createHook<{ iteration: number }>({ token })
  const results: string[] = []

  for (let i = 0; i < 3; i++) {
    const winner = await Promise.race([
      hook.then(() => `hook-${i}`),
      sleep(1000).then(() => `sleep-${i}`),
    ])
    results.push(winner)
  }

  return results
}
