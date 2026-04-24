import type { TenantContext } from '../shared/tenant-context.js'

export interface SessionRecord {
  sessionId: string
  tenantId: string
  userId: string
}

export class SessionStore {
  createSession(userId: string, tenantContext: TenantContext): SessionRecord {
    return {
      sessionId: `${tenantContext.tenantId}:${userId}:session`,
      tenantId: tenantContext.tenantId,
      userId,
    }
  }
}
