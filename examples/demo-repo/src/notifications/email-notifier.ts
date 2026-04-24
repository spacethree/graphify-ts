import type { InvoiceSummary } from '../billing/invoice-service.js'

export class EmailNotifier {
  sendReceiptEmail(invoice: InvoiceSummary) {
    return `receipt:${invoice.invoiceId}`
  }
}
