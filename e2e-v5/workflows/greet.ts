export async function greet (name: string) {
  'use workflow'
  const message = await buildGreeting(name)
  return { message }
}

async function buildGreeting (name: string) {
  'use step'
  return `Hello, ${name}!`
}
