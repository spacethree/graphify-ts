import { InvoiceService } from '../billing/invoice-service.js'
import { RevenueReport, type MonthlyRevenueSnapshot } from '../reports/revenue-report.js'

export function runMonthlyCloseJob(
  month: string,
  invoiceService: InvoiceService,
  revenueReport: RevenueReport,
): MonthlyRevenueSnapshot {
  const settledInvoices = invoiceService.collectOutstandingInvoices(month)
  return revenueReport.buildMonthlyRevenueReport(month, settledInvoices)
}
