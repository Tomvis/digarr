// Per-user home theme (HW-64, Tomvis fork only).
import * as z from 'zod'
import { isValidChoiceColor } from '@/core/home-theme'

export const updateHomeThemeSchema = z.union([
  z.object({ follow: z.literal(true) }).strict(),
  z
    .object({
      color: z.string().refine(isValidChoiceColor, 'invalid theme id'),
      mode: z.enum(['dark', 'light', 'system']),
    })
    .strict(),
])
