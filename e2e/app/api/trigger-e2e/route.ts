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
  errorRetryFatal,
  hookWithSleepWorkflow,
  sleepWithSequentialStepsWorkflow,
  errorRetrySuccess,
  errorWorkflowCrossFile,
  errorStepCrossFile,
  Calculator,
  AllInOneService,
  ChainableService,
  importedStepOnlyWorkflow,
  pathsAliasWorkflow,
  crossContextSerdeWorkflow,
  serverError5xxRetryWorkflow,
  readableStreamWorkflow,
  outputStreamWorkflow,
  outputStreamInsideStepWorkflow,
  stepFunctionAsStartArgWorkflow,
} from '@/workflows/e2e'
import { addTenWorkflow as addTenWorkflowDuplicate } from '@/workflows/98_duplicate_case'

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
  errorRetryFatal,
  hookWithSleepWorkflow,
  sleepWithSequentialStepsWorkflow,
  errorRetrySuccess,
  errorWorkflowCrossFile,
  errorStepCrossFile,
  'Calculator.calculate': Calculator.calculate,
  'AllInOneService.processNumber': AllInOneService.processNumber,
  'ChainableService.processWithThis': ChainableService.processWithThis,
  addTenWorkflowDuplicate,
  importedStepOnlyWorkflow,
  pathsAliasWorkflow,
  crossContextSerdeWorkflow,
  serverError5xxRetryWorkflow,
  readableStreamWorkflow,
  outputStreamWorkflow,
  outputStreamInsideStepWorkflow,
  stepFunctionAsStartArgWorkflow,
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
