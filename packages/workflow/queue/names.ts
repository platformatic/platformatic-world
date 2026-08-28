// Queue-name grammar, mirroring @workflow/world's queue.ts.
//
// Restated rather than imported because this service does not depend on
// @workflow/world (the same call made for slot identity in plugins/events.ts).
// The patterns are copied from the spec so a namespaced deployment routes here
// exactly as it does in the SDK.
//
// The spec supports an optional namespace between the sentinel and the kind:
//
//   __wkf_workflow_<id>              (default)
//   __{namespace}_wkf_workflow_<id>  (WORKFLOW_QUEUE_NAMESPACE)
//
// Matching on the bare `__wkf_workflow_` literal silently misses the namespaced
// form, which is how a namespaced workflow message ends up dispatched to the
// webhook handler.

// Spec: /^__(?:[a-z][a-z0-9]*_)?wkf_workflow_.+$/
const WORKFLOW_QUEUE_RE = /^__(?:[a-z][a-z0-9]*_)?wkf_workflow_(.+)$/
// v4 dispatched background steps on their own prefix; v5 folded them into the
// workflow queue and dropped it. Still recognised so a v4 runtime keeps routing.
const STEP_QUEUE_RE = /^__(?:[a-z][a-z0-9]*_)?wkf_step_(.+)$/
// Everything up to and including the kind, e.g. `__acme_wkf_workflow_`.
const QUEUE_PREFIX_RE = /^(__(?:[a-z][a-z0-9]*_)?wkf_(?:workflow|step)_)/

export function isWorkflowQueue (queueName: string): boolean {
  return WORKFLOW_QUEUE_RE.test(queueName)
}

export function isStepQueue (queueName: string): boolean {
  return STEP_QUEUE_RE.test(queueName)
}

// The workflow id carried in the queue name, namespace or not.
export function workflowNameFromQueue (queueName: string): string | undefined {
  return WORKFLOW_QUEUE_RE.exec(queueName)?.[1]
}

export function resolveQueueNamespace (namespace?: string): string | undefined {
  return namespace ?? process.env.WORKFLOW_QUEUE_NAMESPACE ?? undefined
}

export function workflowQueueName (workflowName: string, namespace?: string): string {
  const ns = resolveQueueNamespace(namespace)
  return ns ? `__${ns}_wkf_workflow_${workflowName}` : `__wkf_workflow_${workflowName}`
}

// A workflow queue name in the same namespace as `sourceQueueName`. Used when a
// delivery spawns a follow-up message: the continuation belongs on the queue the
// original arrived on, not on whatever this process's env happens to say.
export function workflowQueueNameLike (sourceQueueName: string, workflowName: string): string {
  const prefix = QUEUE_PREFIX_RE.exec(sourceQueueName)?.[1]
  if (!prefix) return workflowQueueName(workflowName)
  return `${prefix.replace(/wkf_step_$/, 'wkf_workflow_')}${workflowName}`
}
