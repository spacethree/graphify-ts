import createSession from '../shared/index.js'

export function loginUser(userId: string) {
  return createSession(userId)
}
