declare module 'express' {
  export interface ExpressRouterLike {
    use(...args: unknown[]): void
    get(...args: unknown[]): void
    post(...args: unknown[]): void
    put(...args: unknown[]): void
    patch(...args: unknown[]): void
    delete(...args: unknown[]): void
    all(...args: unknown[]): void
  }

  export interface ExpressFactory extends ExpressRouterLike {
    (): ExpressRouterLike
    Router(): ExpressRouterLike
  }

  const express: ExpressFactory
  export default express
}
