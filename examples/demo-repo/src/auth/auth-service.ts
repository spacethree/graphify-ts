import type { TenantContext } from '../shared/tenant-context.js'
import { PasswordPolicy } from './password-policy.js'
import { SessionStore } from './session-store.js'

export class AuthService {
  constructor(
    private readonly passwordPolicy: PasswordPolicy,
    private readonly sessionStore: SessionStore,
  ) {}

  loginWithPassword(userId: string, tenantContext: TenantContext, password: string) {
    if (!this.passwordPolicy.allows(password)) {
      throw new Error('Weak password')
    }

    return this.sessionStore.createSession(userId, tenantContext)
  }
}
