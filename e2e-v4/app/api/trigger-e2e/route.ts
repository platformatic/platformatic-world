import { start } from 'workflow/api'
import { NextResponse } from 'next/server'
import {
  sleepingWorkflow,
  errorRetrySuccessWorkflow,
  errorFatalWorkflow,
  hookWorkflow,
  outputStreamWorkflow,
} from '@/workflows/compat'

const workflows: Record<string, (...args: any[]) => any> = {
  sleepingWorkflow,
  errorRetrySuccessWorkflow,
  errorFatalWorkflow,
  hookWorkflow,
  outputStreamWorkflow,
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
