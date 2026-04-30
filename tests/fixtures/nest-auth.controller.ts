import { Controller, Get, Injectable, Post, UseGuards, UseInterceptors, UsePipes } from '@nestjs/common'

import { AuthService } from './nest-auth.service.js'

@Injectable()
export class AuthGuard {
  canActivate() {
    return true
  }
}

@Injectable()
export class TrimBodyPipe {
  transform<T>(value: T): T {
    return value
  }
}

@Injectable()
export class AuditInterceptor {
  intercept() {
    return null
  }
}

@Controller('auth')
@UseGuards(AuthGuard)
@UseInterceptors(AuditInterceptor)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('profile')
  @UsePipes(TrimBodyPipe)
  getProfile() {
    return this.authService.getProfile()
  }

  @Post('login')
  login() {
    return this.authService.login()
  }
}
