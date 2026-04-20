import { NextResponse } from 'next/server'
import { add } from '@/workflows/e2e'

export async function POST (request: Request) {
  const { x, y } = await request.json() as { x: number, y: number }
  const result = await add(x, y)
  return NextResponse.json({ result })
}
