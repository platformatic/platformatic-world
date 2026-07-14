import { experimental_setAttributes as setAttributes } from 'workflow'

export async function greet (name: string) {
  'use workflow'
  const message = await buildGreeting(name)
  await setAttributes({ updated: 'yes', remove: undefined })
  return { message }
}

async function buildGreeting (name: string) {
  'use step'
  return `Hello, ${name}!`
}
