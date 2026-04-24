import { AuthService } from './auth/auth-service.js'
import { PasswordPolicy } from './auth/password-policy.js'
import { SessionStore } from './auth/session-store.js'
import { InvoiceService } from './billing/invoice-service.js'
import { runMonthlyCloseJob } from './jobs/monthly-close-job.js'
import { EmailNotifier } from './notifications/email-notifier.js'
import { RevenueReport } from './reports/revenue-report.js'
import type { TenantContext } from './shared/tenant-context.js'

const tenantContext: TenantContext = {
  tenantId: 'demo-co',
  region: 'us-east-1',
  billingEmail: 'finance@demo.example',
}

const authService = new AuthService(new PasswordPolicy(), new SessionStore())
const emailNotifier = new EmailNotifier()
const revenueReport = new RevenueReport()
const invoiceService = new InvoiceService(emailNotifier)

export function runDemoScenario(userId: string, password: string) {
  const session = authService.loginWithPassword(userId, tenantContext, password)
  const invoice = invoiceService.sendInvoiceReceipt(tenantContext, userId, 1200)
  const monthlySnapshot = runMonthlyCloseJob('2025-03', invoiceService, revenueReport)
  return { session, invoice, monthlySnapshot }
}
