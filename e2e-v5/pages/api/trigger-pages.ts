import type { NextApiRequest, NextApiResponse } from 'next'
import { start } from 'workflow/api'
import {
  addTenWorkflow,
  promiseAllWorkflow,
  sleepingWorkflow,
} from '@/workflows/e2e'

const workflows: Record<string, (...args: any[]) => any> = {
  addTenWorkflow,
  promiseAllWorkflow,
  sleepingWorkflow,
}

export default async function handler (
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).end(`Method ${req.method} Not Allowed`)
  }

  const workflowFn = req.query.workflowFn as string
  if (!workflowFn) {
    return res.status(400).send('No workflowFn query parameter provided')
  }

  const workflow = workflows[workflowFn]
  if (!workflow) {
    return res.status(400).send(`Workflow "${workflowFn}" not found`)
  }

  let args: any[] = []
  const argsParam = req.query.args as string | undefined
  if (argsParam) {
    args = argsParam.split(',').map((arg) => {
      const num = parseFloat(arg)
      return Number.isNaN(num) ? arg.trim() : num
    })
  } else if (req.body && Array.isArray(req.body)) {
    args = req.body
  }

  const run = await start(workflow, args)
  return res.status(200).json({ runId: run.runId })
}
