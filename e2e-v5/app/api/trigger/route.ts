import { start } from 'workflow/api'
import { greet } from '@/workflows/greet'
import { NextResponse } from 'next/server'

export async function POST (request: Request) {
  const { name } = await request.json() as { name: string }
  const run = await start(greet, [name], {
    attributes: { initial: 'present', remove: 'old' }
  })
  return NextResponse.json({ runId: run.runId })
}
