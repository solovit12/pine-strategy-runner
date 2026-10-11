// SPDX-License-Identifier: AGPL-3.0-only
// This file is auto-generated. Do not edit manually.
// Run: npm run generate:request-index

import { param } from './methods/param';
import { security } from './methods/security';
import { security_lower_tf } from './methods/security_lower_tf';

const methods = {
  param,
  security,
  security_lower_tf
};

export class PineRequest {
  private _cache = {};
  param: ReturnType<typeof methods.param>;
  security: ReturnType<typeof methods.security>;
  security_lower_tf: ReturnType<typeof methods.security_lower_tf>;

  constructor(private context: any) {
    // Install methods
    Object.entries(methods).forEach(([name, factory]) => {
      this[name] = factory(context);
    });
  }
}

export default PineRequest;
