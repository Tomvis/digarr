import * as z from 'zod'
import { API_KEY_SCOPES } from '@/core/auth/api-keys'
import { stripControlChars } from '@/core/text/strip-control-chars'
import { idParamSchema } from './validator'

export const apiKeyIdParamSchema = idParamSchema

export const createApiKeySchema = z.object({
  name: z
    .string()
    .transform((s) => stripControlChars(s).trim())
    .pipe(z.string().min(1).max(100)),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
  expiresAt: z.iso.datetime().nullish(),
})
