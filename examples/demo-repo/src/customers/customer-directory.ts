export interface CustomerProfile {
  customerId: string
  email: string
  preferredChannel: 'email' | 'sms'
}

export class CustomerDirectory {
  findCustomerByEmail(email: string): CustomerProfile {
    return {
      customerId: 'customer-123',
      email,
      preferredChannel: 'email',
    }
  }

  listPreferredContacts() {
    return ['finance@demo.example', 'ops@demo.example']
  }
}
