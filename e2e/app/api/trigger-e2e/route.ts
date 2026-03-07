import { start } from 'workflow/api'
import { NextResponse } from 'next/server'
import {
  addTenWorkflow,
  promiseAllWorkflow,
  promiseRaceWorkflow,
  sleepingWorkflow,
  parallelSleepWorkflow,
  nullByteWorkflow,
  fetchWorkflow,
  errorRetrySuccessWorkflow,
  errorFatalWorkflow,
  hookWorkflow,
  webhookWorkflow,
  spawnWorkflowFromStepWorkflow,
  promiseAnyWorkflow,
  promiseRaceStressTestWorkflow,
  workflowAndStepMetadataWorkflow,
  errorWorkflowNested,
  errorStepBasic,
  errorRetryCustomDelay,
  errorRetryDisabled,
  errorFatalCatchable,
  stepFunctionPassingWorkflow,
  stepFunctionWithClosureWorkflow,
  closureVariableWorkflow,
  thisSerializationWorkflow,
  customSerializationWorkflow,
  instanceMethodStepWorkflow,
  hookCleanupTestWorkflow,
  hookDisposeTestWorkflow,
} from '@/workflows/e2e'

const workflows: Record<string, (...args: any[]) => any> = {
  addTenWorkflow,
  promiseAllWorkflow,
  promiseRaceWorkflow,
  sleepingWorkflow,
  parallelSleepWorkflow,
  nullByteWorkflow,
  fetchWorkflow,
  errorRetrySuccessWorkflow,
  errorFatalWorkflow,
  hookWorkflow,
  webhookWorkflow,
  spawnWorkflowFromStepWorkflow,
  promiseAnyWorkflow,
  promiseRaceStressTestWorkflow,
  workflowAndStepMetadataWorkflow,
  errorWorkflowNested,
  errorStepBasic,
  errorRetryCustomDelay,
  errorRetryDisabled,
  errorFatalCatchable,
  stepFunctionPassingWorkflow,
  stepFunctionWithClosureWorkflow,
  closureVariableWorkflow,
  thisSerializationWorkflow,
  customSerializationWorkflow,
  instanceMethodStepWorkflow,
  hookCleanupTestWorkflow,
  hookDisposeTestWorkflow,
}

export async function POST (request: Request) {
  const { workflow, args = [], waitForResult } = await request.json() as {
    workflow: string
    args?: any[]
    waitForResult?: boolean
  }

  const fn = workflows[workflow]
  if (!fn) {
    return NextResponse.json({ error: `Unknown workflow: ${workflow}` }, { status: 400 })
  }

  const run = await start(fn, args)

  if (waitForResult) {
    const result = await run.returnValue
    return NextResponse.json({ runId: run.runId, result })
  }

  return NextResponse.json({ runId: run.runId })
}
