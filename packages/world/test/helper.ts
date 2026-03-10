export const SERVICE_URL = process.env.WF_SERVICE_URL || 'http://localhost:3042'

export async function provisionApp (): Promise<{ appId: string }> {
  // In single-tenant mode, the default app is auto-provisioned.
  // The service runs without auth.
  return { appId: 'default' }
}
