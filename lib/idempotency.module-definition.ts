import { ConfigurableModuleBuilder } from '@nestjs/common';
import type {
  IdempotencyModuleExtras,
  IdempotencyModuleOptions,
} from './interfaces/idempotency-module-options.interface.js';

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: IDEMPOTENCY_MODULE_OPTIONS,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<IdempotencyModuleOptions>({ moduleName: 'Idempotency' })
  .setClassMethodName('forRoot')
  // forRootAsync({ useClass }) calls createIdempotencyOptions(), like
  // JwtModule's createJwtOptions(): see IdempotencyOptionsFactory.
  .setFactoryMethodName('createIdempotencyOptions')
  // `isGlobal` is structural: Nest must know it when the module is defined,
  // so it sits next to `useFactory`, never in what it returns. The store isn't
  // an option at all: the app registers it with IdempotencyStorage.
  .setExtras<IdempotencyModuleExtras>({ isGlobal: true }, (definition, { isGlobal }) => ({
    ...definition,
    global: isGlobal,
  }))
  .build();
