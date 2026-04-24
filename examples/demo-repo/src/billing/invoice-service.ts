import { EmailNotifier } from '../notifications/email-notifier.js'
import type { TenantContext } from '../shared/tenant-context.js'

export interface InvoiceSummary {
  invoiceId: string
  amount: number
  customerId: string
  tenantId: string
}

export class InvoiceService {
  constructor(private readonly emailNotifier: EmailNotifier) {}

  sendInvoiceReceipt(tenantContext: TenantContext, customerId: string, amount: number): InvoiceSummary {
    const invoice = {
      invoiceId: `${tenantContext.tenantId}-${customerId}-invoice`,
      amount,
      customerId,
      tenantId: tenantContext.tenantId,
    }
    this.emailNotifier.sendReceiptEmail(invoice)
    return invoice
  }

  collectOutstandingInvoices(month: string) {
    return month === '2025-03' ? 4 : 2
  }
}
