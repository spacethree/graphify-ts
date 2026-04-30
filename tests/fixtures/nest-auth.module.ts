import { Module } from '@nestjs/common'

import { AuditInterceptor, AuthController, AuthGuard, TrimBodyPipe } from './nest-auth.controller.js'
import { AuthService } from './nest-auth.service.js'

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, TrimBodyPipe, AuditInterceptor],
})
export class AuthModule {}
