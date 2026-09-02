/**
 * Single place where Zod is augmented with the `.openapi()` metadata method.
 *
 * Every schema module MUST import `z` from here rather than from 'zod' directly.
 * `extendZodWithOpenApi` patches the Zod prototype as a side effect, so importing
 * this module first is what guarantees `.openapi()` exists by the time a schema
 * file is evaluated.
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export { z };
