export class PasswordPolicy {
  allows(password: string) {
    return password.length >= 12 && /[A-Z]/.test(password) && /\d/.test(password)
  }
}
