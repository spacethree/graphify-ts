import createSession from '../shared/index.js'

export class ApiHandler {
  login(userId: string) {
    return createSession(userId)
  }
}
