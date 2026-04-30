import { Injectable } from '@nestjs/common'

@Injectable()
export class AuthService {
  getProfile() {
    return { id: 'user_1' }
  }

  login() {
    return { token: 'token_1' }
  }
}
