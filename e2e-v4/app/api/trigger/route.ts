import { start } from 'workflow/api'
import { addTenWorkflow } from '@/workflows/simple'
import { NextResponse } from 'next/server'

export async function POST (request: Request) {
  const { input = 5 } = await request.json() as { input?: number }
  const run = await start(addTenWorkflow, [input])
  const result = await run.returnValue
  return NextResponse.json({ runId: run.runId, result })
}
