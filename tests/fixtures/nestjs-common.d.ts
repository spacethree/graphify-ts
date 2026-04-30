declare module '@nestjs/common' {
  type NestDecorator = (...args: any[]) => any

  export function Injectable(): NestDecorator
  export function Controller(path?: string): NestDecorator
  export function Module(metadata: {
    controllers?: unknown[]
    providers?: unknown[]
    imports?: unknown[]
    exports?: unknown[]
  }): NestDecorator
  export function Get(path?: string): NestDecorator
  export function Post(path?: string): NestDecorator
  export function Put(path?: string): NestDecorator
  export function Patch(path?: string): NestDecorator
  export function Delete(path?: string): NestDecorator
  export function Options(path?: string): NestDecorator
  export function Head(path?: string): NestDecorator
  export function All(path?: string): NestDecorator
  export function UseGuards(...guards: unknown[]): NestDecorator
  export function UseInterceptors(...interceptors: unknown[]): NestDecorator
  export function UsePipes(...pipes: unknown[]): NestDecorator
}
