export interface IdempotencyStorageRegisterOptions {
  /**
   * Replace a source that is already registered, instead of failing. For tests
   * (`registerSource(fake, { replace: true })` before `app.init()`) and for
   * wrappers that decorate the app's store.
   */
  replace?: boolean;
}
