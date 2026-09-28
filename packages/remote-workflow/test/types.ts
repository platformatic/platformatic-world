import { defineRemote, remote, type RemoteEndpoint } from '@platformatic/remote-workflow'

declare module '@platformatic/remote-workflow' {
  interface RemoteEndpoints {
    'inventory.reserve': RemoteEndpoint<
      { sku: string, quantity: number },
      { reservationId: string }
    >
  }
}

const inferred: Promise<{ reservationId: string }> = remote(
  'inventory.reserve',
  { sku: 'SKU-1', quantity: 1 }
)

// Explicit type parameters remain available for unregistered endpoints.
const explicit: Promise<{ accepted: boolean }> = remote<
  { value: number },
  { accepted: boolean }
>('partner.experimental', { value: 42 })

// @ts-expect-error quantity is required by the merged endpoint declaration.
remote('inventory.reserve', { sku: 'SKU-1' })

// @ts-expect-error inferred output is not a string.
const wrongOutput: Promise<string> = remote('inventory.reserve', { sku: 'SKU-1', quantity: 1 })

export { explicit, inferred, wrongOutput }

async function typedHandler (input: { value: number }): Promise<{ accepted: boolean }> {
  return { accepted: input.value > 0 }
}

const handlers = defineRemote({
  'partner.typed': {
    workflow: typedHandler,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  },
})

// @ts-expect-error workflow must be callable.
defineRemote({ invalid: { workflow: 'not-a-function', inputSchema: true, outputSchema: true } })

defineRemote({
  duplicate: { workflow: typedHandler, inputSchema: true, outputSchema: true },
  // @ts-expect-error duplicate endpoint names are invalid object literals.
  duplicate: { workflow: typedHandler, inputSchema: true, outputSchema: true }
})

export { handlers }
