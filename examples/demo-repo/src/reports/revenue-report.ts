export interface MonthlyRevenueSnapshot {
  month: string
  settledInvoices: number
  grossRevenue: number
}

export class RevenueReport {
  buildMonthlyRevenueReport(month: string, settledInvoices: number): MonthlyRevenueSnapshot {
    return {
      month,
      settledInvoices,
      grossRevenue: settledInvoices * 1200,
    }
  }
}
